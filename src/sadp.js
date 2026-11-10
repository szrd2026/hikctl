/**
 * SADP discovery — find Hikvision devices on the LAN without any vendor SDK.
 *
 * Protocol: an XML `Probe` datagram sent over UDP to the SADP multicast group
 * 239.255.255.250:37020 (and to the broadcast address for networks where
 * multicast is filtered). Devices answer with a `ProbeResponse` XML to the
 * sender's source port. Unsolicited `Hello` broadcasts are parsed too.
 *
 * Node built-ins only (node:dgram).
 */
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';

import { parseXml, first, textOf, elementsOf } from './xml.js';
import { localIPv4List } from './util.js';
import os from 'node:os';

export const SADP_PORT = 37020;
export const SADP_MULTICAST = '239.255.255.250';

function probePayload(uuid) {
  return '<?xml version="1.0" encoding="utf-8"?>\r\n'
    + `<Probe><Uuid>${uuid}</Uuid><Types>inquiry</Types></Probe>`;
}

/**
 * Tolerant field lookup.
 *
 * Real firmware answers with `<ProbeMatch>` and these element names (verified on
 * HK-Y2S4M-GL/L, DS-K1T342M and DS-3E0510SP-60W-E):
 *   DeviceDescription = model string, DeviceSN = serial, CommandPort = SDK port,
 *   DHCP (not DHCPEnabled), DeviceType = a NUMERIC hardware code.
 */
const FIELD_ALIASES = {
  ip: ['IPv4Address', 'ipAddress', 'IPAddress'],
  mac: ['MAC', 'macAddress', 'MACAddress'],
  serialNumber: ['DeviceSN', 'serialNumber', 'SerialNumber', 'SN'],
  model: ['DeviceDescription', 'Model', 'model', 'DeviceModel'],
  firmwareVersion: ['SoftwareVersion', 'firmwareVersion', 'FirmwareVersion'],
  deviceType: ['DeviceType', 'deviceType'],
  httpPort: ['HttpPort', 'httpPort'],
  sdkPort: ['CommandPort', 'DevicePort', 'sdkPort', 'SDKPort'],
  activated: ['Activated', 'activated'],
  dhcpEnabled: ['DHCP', 'DHCPEnabled', 'dhcpEnabled'],
  gateway: ['IPv4Gateway', 'gateway', 'Gateway'],
  subnetMask: ['IPv4SubnetMask', 'subnetMask', 'SubnetMask'],
  dnsServer: ['PrimaryDNS', 'dnsServer', 'DNS'],
  softwareVersion: ['SoftwareVersion', 'softwareVersion'],
  dspVersion: ['DSPVersion', 'dspVersion'],
  bootTime: ['BootTime', 'bootTime'],
  deviceDescription: ['DeviceDescription', 'deviceDescription'],
  uuid: ['Uuid', 'UUID'],
  analogChannelNum: ['AnalogChannelNum'],
  digitalChannelNum: ['DigitalChannelNum'],
  encrypt: ['Encrypt'],
  resetAbility: ['ResetAbility'],
  passwordResetAbility: ['PasswordResetAbility'],
  oemCode: ['OEMCode'],
  salt: ['Salt'],
  ipv6Address: ['IPv6Address'],
  // EZVIZ / cloud platform state — available without logging in
  ezvizBindStatus: ['EZVIZBindStatus'],
  supportEzvizUnbind: ['supportEzvizUnbind'],
  hcPlatformEnable: ['HCPlatformEnable'],
  supportHcPlatform: ['SupportHCPlatform'],
  supportEzvizUserToken: ['supportEzvizUserToken'],
  specificDeviceType: ['SpecificDeviceType'],
  userName: ['UserName'],
};

function pick(el, keys) {
  for (const k of keys) {
    const v = textOf(el, k, '');
    if (v !== '') return v;
  }
  return '';
}

export function parseProbeResponse(xmlText) {
  const root = parseXml(xmlText);
  const el = first(root, 'ProbeMatch')
    || first(root, 'ProbeResponse')
    || first(root, 'Hello')
    || first(root, 'DeviceInfo')
    || root;
  const out = {};
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) out[key] = pick(el, aliases);
  out.mac = out.mac.replace(/-/g, ':').toLowerCase();
  out.ip = out.ip.trim();
  out.activated = /^true$/i.test(out.activated) || out.activated === '1';
  out.dhcpEnabled = /^true$/i.test(out.dhcpEnabled) || out.dhcpEnabled === '1';
  out.encrypt = /^true$/i.test(out.encrypt);
  out.resetAbility = /^true$/i.test(out.resetAbility);
  out.supportEzvizUnbind = /^true$/i.test(out.supportEzvizUnbind);
  out.hcPlatformEnable = /^true$/i.test(out.hcPlatformEnable);
  out.supportHcPlatform = /^true$/i.test(out.supportHcPlatform);
  // "0" / "" both mean "not bound"; anything else means bound.
  out.ezvizBound = out.ezvizBindStatus !== '' && !/^(0|false|no|unbound)$/i.test(out.ezvizBindStatus.trim());
  out.httpPort = Number(out.httpPort) || 80;
  out.sdkPort = Number(out.sdkPort) || 8000;

  // SADP reports DeviceType as a numeric hardware code; keep it separately and
  // present a human label in `deviceType` so the UI stays readable.
  out.deviceTypeCode = /^\d+$/.test(out.deviceType) ? out.deviceType : '';
  const digital = Number(out.digitalChannelNum) || 0;
  if (out.deviceTypeCode) {
    out.deviceType = digital > 0 ? 'IPCamera' : (out.model ? 'HikvisionDevice' : 'Unknown');
  }
  out.raw = elementsOf(root).length ? xmlText : '';
  return out;
}

/**
 * Run one SADP discovery round.
 * @param {object} opts
 * @param {number} [opts.timeoutMs=3000]
 * @param {(device:object)=>void} [opts.onResult] called as devices answer
 * @returns {Promise<{found:object[], elapsedMs:number, diagnostics:object}>}
 */
export function sadpDiscover({ timeoutMs = 3000, onResult } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const found = new Map();
    const diagnostics = { sockets: [], errors: [] };
    const uuid = randomUUID();
    const payload = Buffer.from(probePayload(uuid), 'utf8');

    const sockets = [];

    const collect = (msg, rinfo, via) => {
      const text = msg.toString('utf8');
      // Real firmware replies with <ProbeMatch>. Our own probe is echoed back to us
      // on broadcast, so a bare "<Probe" must NOT count as a device.
      const isMatch = /<(ProbeMatch|ProbeResponse|Hello)[\s/>]/i.test(text);
      if (!isMatch) return;
      let parsed;
      try { parsed = parseProbeResponse(text); } catch (e) {
        diagnostics.errors.push(`parse: ${e.message}`);
        return;
      }
      if (!parsed.ip && rinfo && rinfo.address) parsed.ip = rinfo.address;
      if (!parsed.ip) return;
      parsed.via = via;
      parsed.replyFrom = rinfo ? `${rinfo.address}:${rinfo.port}` : '';
      const prev = found.get(parsed.ip);
      if (prev && prev.serialNumber && !parsed.serialNumber) return; // keep the richer record
      found.set(parsed.ip, parsed);
      if (onResult) { try { onResult(parsed); } catch { /* ignore */ } }
    };

    const makeSocket = (port, label) => new Promise((res) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const done = (ok) => {
        diagnostics.sockets.push({ label, port, ok: !!ok });
        res(ok ? sock : null);
      };
      sock.on('error', (e) => {
        diagnostics.errors.push(`${label}: ${e.message}`);
        try { sock.close(); } catch { /* ignore */ }
        done(false);
      });
      sock.on('message', (msg, rinfo) => collect(msg, rinfo, label));
      sock.bind(port, () => {
        try {
          sock.setBroadcast(true);
          sock.setMulticastTTL(4);
          try { sock.addMembership(SADP_MULTICAST); } catch (e) { diagnostics.errors.push(`join: ${e.message}`); }
        } catch { /* ignore */ }
        done(true);
      });
    });

    (async () => {
      // Preferred: bind the well-known SADP port so devices that insist on it can answer.
      let main = await makeSocket(SADP_PORT, 'sadp:37020');
      if (!main) main = await makeSocket(0, 'sadp:ephemeral');
      if (main) sockets.push(main);

      const targets = [];
      targets.push({ port: SADP_PORT, address: SADP_MULTICAST, label: 'multicast' });
      targets.push({ port: SADP_PORT, address: '255.255.255.255', label: 'broadcast' });
      // Directed broadcast per local subnet, computed from the real netmask
      // (a /22 is NOT x.y.z.255 — getting this wrong silently loses devices).
      for (const ni of localIPv4List(os)) {
        try {
          const a = String(ni.address).split('.').map(Number);
          const m = String(ni.netmask || '255.255.255.0').split('.').map(Number);
          if (a.length !== 4 || m.length !== 4) continue;
          const bcast = a.map((x, i) => ((x & m[i]) | (~m[i] & 255)) & 255).join('.');
          targets.push({ port: SADP_PORT, address: bcast, label: 'subnet-broadcast' });
        } catch { /* skip */ }
      }

      const sendAll = () => {
        for (const s of sockets) {
          for (const t of targets) {
            s.send(payload, t.port, t.address, (err) => {
              if (err && diagnostics.errors.length < 20) diagnostics.errors.push(`send ${t.label}: ${err.message}`);
            });
          }
        }
      };

      sendAll();
      const timer = setInterval(sendAll, 700);
      setTimeout(() => {
        clearInterval(timer);
        for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
        resolve({
          found: [...found.values()].sort((a, b) => a.ip.localeCompare(b.ip)),
          elapsedMs: Date.now() - started,
          diagnostics,
        });
      }, Math.max(500, Number(timeoutMs) || 3000));
    })();
  });
}