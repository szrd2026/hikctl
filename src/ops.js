/**
 * High level ISAPI operations.
 *
 * Every write follows the Hikvision pattern: GET the full resource, patch the field,
 * PUT the whole document back. That preserves unknown fields the device expects.
 */
import fs from 'node:fs';
import httpModule from 'node:http';
import httpsModule from 'node:https';
import { randomBytes } from 'node:crypto';

import { IsapiClient, IsapiError, statusMessage } from './client.js';
import { extractResponseStatus, isRebootRequired, isAuthFailure } from './auth.js';
import { parseXml, serializeXml, first, textOf, setText, elementsOf, directText, attrOf, build, document, xmlBody } from './xml.js';
import { sanitizeXmlValue, makeId } from './util.js';

/* ------------------------------------------------------------------ */
/* device info / probe                                                 */
/* ------------------------------------------------------------------ */

const DEVICE_INFO_FIELDS = [
  'deviceName', 'deviceID', 'deviceDescription', 'deviceLocation', 'systemContact',
  'model', 'serialNumber', 'macAddress', 'firmwareVersion', 'firmwareReleasedDate',
  'encoderVersion', 'encoderReleasedDate', 'bootVersion', 'deviceType', 'telecontrolID',
  'alarmInPortNum', 'alarmOutPortNum', 'RS485Num', 'powerSupplyType', 'supportBeep',
];

export function normalizeDeviceInfo(xmlText) {
  const root = parseXml(xmlText);
  const el = first(root, 'DeviceInfo') || root;
  const out = {};
  for (const f of DEVICE_INFO_FIELDS) out[f] = textOf(el, f, '');
  return out;
}

/**
 * Probe a device: login if needed, read identity, measure latency.
 * Never throws for "offline" — returns { online:false, error }.
 *
 * `activated` is deliberately tri-state:
 *   true  -> we logged in and read the device
 *   false -> the device positively answered `notActivated` (fresh, unactivated unit)
 *   null  -> unknown (network error, wrong password, …)
 * Reporting `false` for a plain network failure made the device list show a
 * permanently wrong 「未激活」 badge after a transient outage or a reboot.
 */
export async function probe(client, { deep = false } = {}) {
  const t0 = Date.now();
  try {
    await client.login();
    const res = await client.getText('/ISAPI/System/deviceInfo');
    const info = normalizeDeviceInfo(res.text);
    const status = {
      online: true,
      checkedAt: Date.now(),
      latencyMs: Date.now() - t0,
      authMode: client.authMode,
      ...info,
      channelCount: 0,
      activated: true,
      needsActivation: false,
      error: null,
    };

    if (deep) {
      try {
        const ch = await client.getText('/ISAPI/System/Video/inputs/channels');
        status.channelCount = elementsOf(parseXml(ch.text), 'VideoInputChannel').length || 0;
      } catch { /* optional */ }
      try {
        const cap = await client.getText('/ISAPI/System/capabilities');
        const root = parseXml(cap.text);
        const dc = first(root, 'DeviceCap');
        if (dc) {
          status.webLocation = textOf(dc, 'WEBLocation', '');
          status.deviceCapRaw = cap.text;
        }
      } catch { /* optional */ }
      try {
        status.ezviz = await getEzviStatus(client);
      } catch (e) {
        status.ezviz = { supported: false, error: e.message };
      }
    }
    return status;
  } catch (e) {
    const code = e instanceof IsapiError ? e.code : 'ERROR';
    const evidence = [
      e && e.body,
      e && e.message,
      e && e.isapi && e.isapi.subStatusCode,
      e && e.isapi && e.isapi.statusString,
    ].filter(Boolean).join(' ');
    const isUnactivated = /notActivated|not[_ ]?activated|未激活/i.test(String(evidence));

    return {
      online: false,
      checkedAt: Date.now(),
      // 设备不可达时 Date.now()-t0 只是超时等待时长，不是 RTT，
      // 显示成「延迟 12000 ms」会让人误以为设备很慢。置空由 UI 显示「—」。
      latencyMs: null,
      authMode: client.authMode,
      deviceName: '', model: '', serialNumber: '', firmwareVersion: '', firmwareReleasedDate: '',
      macAddress: '', deviceType: '', channelCount: 0,
      activated: isUnactivated ? false : null,
      needsActivation: isUnactivated,
      error: e.message || String(e),
      errorCode: code,
    };
  }
}

/* ------------------------------------------------------------------ */
/* network                                                             */
/* ------------------------------------------------------------------ */

export async function getNetwork(client, interfaceId = 1) {
  const res = await client.getText(`/ISAPI/System/Network/interfaces/${interfaceId}/ipAddress`);
  const root = parseXml(res.text);
  const el = first(root, 'IPAddress') || root;
  return {
    interfaceId,
    addressingType: textOf(el, 'addressingType', 'static'),
    ip: textOf(el, 'ipAddress', ''),
    mask: textOf(el, 'subnetMask', ''),
    gateway: textOf(first(el, 'DefaultGateway') || el, 'ipAddress', ''),
    dns: textOf(first(el, 'PrimaryDNS') || el, 'ipAddress', ''),
    mac: textOf(el, 'MACAddress', ''),
    raw: res.text,
  };
}

/**
 * Change the device IP. Returns { rebootRequired, newId }.
 * Mirrors HiToolsDelivery's implementation (GET interfaces -> patch -> PUT -> reboot if required).
 */
export async function setNetwork(client, { interfaceId = 1, ip, mask, gateway, dns, dhcp = false }) {
  const path = `/ISAPI/System/Network/interfaces/${interfaceId}/ipAddress`;
  const got = await client.getText(path);
  const root = parseXml(got.text);
  const el = first(root, 'IPAddress') || root;

  setText(el, 'addressingType', dhcp ? 'dynamic' : 'static');
  if (ip) setText(el, 'ipAddress', sanitizeXmlValue(ip));
  if (mask) setText(el, 'subnetMask', sanitizeXmlValue(mask));
  if (gateway) {
    let gw = first(el, 'DefaultGateway');
    if (!gw) { gw = build('DefaultGateway', { ipAddress: gateway, addressType: 'IPv4' }); el.children.push(gw); }
    setText(gw, 'ipAddress', sanitizeXmlValue(gateway));
  }
  if (dns) {
    let d = first(el, 'PrimaryDNS');
    if (!d) { d = build('PrimaryDNS', { ipAddress: dns, addressType: 'IPv4' }); el.children.push(d); }
    setText(d, 'ipAddress', sanitizeXmlValue(dns));
  }

  const res = await client.putText(path, xmlBody(root));
  const rebootRequired = isRebootRequired(res.isapi);
  return {
    ok: true,
    rebootRequired,
    newId: ip ? makeId(ip, client.port, client.https) : client.id,
    isapiStatus: res.isapi,
    message: rebootRequired ? '网络参数已下发，需要重启设备生效' : '网络参数已下发',
  };
}

/* ------------------------------------------------------------------ */
/* time                                                                */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');
export function formatLocalTime(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function getTime(client) {
  const res = await client.getText('/ISAPI/System/time');
  const root = parseXml(res.text);
  const el = first(root, 'Time') || root;
  return {
    timeMode: textOf(el, 'timeMode', ''),
    localTime: textOf(el, 'localTime', ''),
    timeZone: textOf(el, 'timeZone', ''),
    raw: res.text,
  };
}

/**
 * Set the clock manually.
 *
 * Real firmware rejects a minimal `<Time><timeMode/><localTime/></Time>` with
 * `badXmlContent` — it wants the whole document back. So GET, patch two fields and
 * PUT the original tree (which already carries its own XML declaration).
 */
export async function setTimeManual(client, dateTime) {
  const local = dateTime ? String(dateTime).replace(' ', 'T') : formatLocalTime();
  const got = await client.getText('/ISAPI/System/time');
  const root = parseXml(got.text);
  const el = first(root, 'Time') || root;
  setText(el, 'timeMode', 'manual');
  setText(el, 'localTime', local);
  const res = await client.putText('/ISAPI/System/time', xmlBody(root));
  return { ok: true, applied: local, isapiStatus: res.isapi };
}

export async function setTimeNtp(client, { server, port = 123, intervalMinutes = 60, timeZone }) {
  // time zone first (optional)
  if (timeZone) {
    try {
      const tz = await client.getText('/ISAPI/System/time/timeZone');
      const root = parseXml(tz.text);
      const el = first(root, 'TimeZone') || root;
      setText(el, 'timeZone', sanitizeXmlValue(timeZone));
      await client.putText('/ISAPI/System/time/timeZone', xmlBody(root));
    } catch { /* optional */ }
  }

  const path = '/ISAPI/System/time/ntpServers/1';
  let root;
  try {
    root = parseXml((await client.getText(path)).text);
  } catch {
    root = parseXml('<NTPServer><id>1</id></NTPServer>');
  }
  const el = first(root, 'NTPServer') || root;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(String(server || ''));
  setText(el, 'id', '1');
  setText(el, 'addressingFormatType', isIp ? 'ipaddress' : 'hostname');
  if (isIp) setText(el, 'ipAddress', sanitizeXmlValue(server));
  else setText(el, 'hostName', sanitizeXmlValue(server));
  setText(el, 'portNo', String(port));
  setText(el, 'synchronizeInterval', String(intervalMinutes));

  const res = await client.putText(path, xmlBody(root));
  // switch the device into NTP mode
  try {
    const t = await client.getText('/ISAPI/System/time');
    const troot = parseXml(t.text);
    const tel = first(troot, 'Time') || troot;
    setText(tel, 'timeMode', 'NTP');
    await client.putText('/ISAPI/System/time', xmlBody(troot));
  } catch { /* optional */ }

  return { ok: true, applied: `NTP ${server}:${port} 每 ${intervalMinutes} 分钟`, isapiStatus: res.isapi };
}

/* ------------------------------------------------------------------ */
/* users / password                                                    */
/* ------------------------------------------------------------------ */

export async function listUsers(client) {
  const res = await client.getText('/ISAPI/Security/users');
  const root = parseXml(res.text);
  return elementsOf(root, 'User').map((u) => ({
    id: textOf(u, 'id', ''),
    userName: textOf(u, 'userName', ''),
    userLevel: textOf(u, 'userLevel', ''),
    attribute: first(u, 'userAttribute') ? textOf(first(u, 'userAttribute'), 'attribute', '') : '',
    raw: serializeXml(u),
  }));
}

/** Find a user element + its id. */
async function locateUser(client, userName) {
  try {
    const direct = await client.getText(`/ISAPI/Security/users/${encodeURIComponent(userName)}`);
    const root = parseXml(direct.text);
    const u = first(root, 'User');
    if (u) return { id: textOf(u, 'id', ''), el: u, root, path: `/ISAPI/Security/users/${encodeURIComponent(userName)}` };
  } catch { /* fall through to list */ }

  const list = await listUsers(client);
  const found = list.find((u) => u.userName === userName) || list.find((u) => u.userLevel === 'Administrator');
  if (!found) throw new IsapiError(`设备上找不到用户 ${userName}`, { code: 'NO_USER' });
  const res = await client.getText(`/ISAPI/Security/users/${found.id}`);
  const root = parseXml(res.text);
  return { id: found.id, el: first(root, 'User') || root, root, path: `/ISAPI/Security/users/${found.id}` };
}

export async function changePassword(client, { userName, oldPassword, newPassword }) {
  const { el, root, path } = await locateUser(client, userName);
  setText(el, 'password', sanitizeXmlValue(newPassword));
  if (oldPassword) setText(el, 'oldPassword', sanitizeXmlValue(oldPassword));
  const res = await client.putText(path, xmlBody(root));
  return { ok: true, isapiStatus: res.isapi, message: '密码修改成功' };
}

/* ------------------------------------------------------------------ */
/* maintenance                                                         */
/* ------------------------------------------------------------------ */

export async function reboot(client) {
  const res = await client.putText('/ISAPI/System/reboot', '', { timeoutMs: 15_000 });
  return { ok: true, isapiStatus: res.isapi, message: '设备正在重启，约 30–60 秒后恢复' };
}

/**
 * Factory reset.
 *   mode 'basic' = 简单恢复 : keeps IP / user / password / activation / network
 *   mode 'full'  = 完全恢复 : everything including IP (device returns to 192.168.1.64)
 *
 * Mirrors HiToolsDelivery `deviceResetting()`:
 *   PUT /ISAPI/System/factoryReset?mode=<mode>
 *   retry with &loginPassword=<pwd> when the device asks for a second factor.
 */
export async function factoryReset(client, { mode = 'basic', password = '' } = {}) {
  if (mode !== 'basic' && mode !== 'full') throw new IsapiError('mode 只能是 basic 或 full', { code: 'BAD_MODE' });

  const tryOnce = async (path) => client.request('PUT', path, { body: '', contentType: 'application/xml', timeoutMs: 30_000 });

  let res = await tryOnce(`/ISAPI/System/factoryReset?mode=${mode}`);
  const needSecond = (r) => {
    if (!r) return true;
    if (r.status >= 400) return true;
    const st = r.isapi;
    if (!st) return false;
    return String(st.statusCode) === '10' || isAuthFailure(st) || String(st.statusCode) === '6';
  };

  if (needSecond(res) && password) {
    res = await tryOnce(`/ISAPI/System/factoryReset?mode=${mode}&loginPassword=${encodeURIComponent(password)}`);
  }

  if (res.status >= 400) {
    throw new IsapiError(`恢复出厂失败：HTTP ${res.status} ${statusMessage(res.isapi)}`,
      { status: res.status, code: 'RESET_FAILED', isapi: res.isapi, body: res.text });
  }
  if (res.isapi && String(res.isapi.statusCode) !== '1' && String(res.isapi.statusCode) !== '7') {
    throw new IsapiError(`恢复出厂失败：${statusMessage(res.isapi)}`,
      { code: 'RESET_FAILED', isapi: res.isapi, body: res.text });
  }

  return {
    ok: true,
    mode,
    isapiStatus: res.isapi,
    message: mode === 'full'
      ? '完全恢复已下发：设备所有参数（含 IP）将恢复出厂默认 192.168.1.64，请用 SADP 重新发现'
      : '简单恢复已下发：网络参数与账号信息保留，其余恢复出厂默认',
  };
}

/* ------------------------------------------------------------------ */
/* streaming / snapshot                                                */
/* ------------------------------------------------------------------ */

export async function listStreamingChannels(client) {
  const res = await client.getText('/ISAPI/Streaming/channels');
  const root = parseXml(res.text);
  return elementsOf(root, 'StreamingChannel').map((c) => ({
    id: textOf(c, 'id', ''),
    channelName: textOf(c, 'channelName', ''),
    enabled: textOf(c, 'enabled', ''),
    raw: serializeXml(c),
  }));
}

/**
 * Grab a JPEG snapshot.
 *
 * Real-hardware quirk: the main stream (101) frequently answers 503 "Device Busy"
 * for snapshots while the sub stream works fine (observed on HK-Y2S4M-GL/L).
 * So walk down the channel list and remember whichever one works.
 */
export async function snapshot(client, { channel = 101, timeoutMs = 8000, fallback = [102, 103, 1] } = {}) {
  const candidates = [client.snapshotChannel || channel, channel, ...fallback]
    .filter((c, i, a) => c && a.indexOf(c) === i);

  let lastErr = null;
  for (const ch of candidates) {
    try {
      const res = await client.request('GET', `/ISAPI/Streaming/channels/${ch}/picture`, {
        timeoutMs,
        headers: { Accept: 'image/jpeg' },
        retries: 1,
      });
      const ct = String(res.headers['content-type'] || '');
      if (!/image\//i.test(ct)) {
        lastErr = new IsapiError(`抓图失败：设备返回 ${ct || '未知类型'}`, {
          code: 'SNAPSHOT', body: res.text.slice(0, 200),
        });
        continue;
      }
      client.snapshotChannel = ch;
      return { buffer: res.body, contentType: ct, channel: ch };
    } catch (e) {
      lastErr = e;
      const busy = e instanceof IsapiError
        && (e.httpStatus === 503 || (e.isapi && String(e.isapi.statusCode) === '2'));
      if (!busy) throw e;
    }
  }
  throw lastErr || new IsapiError('抓图失败', { code: 'SNAPSHOT' });
}

/**
 * Device-side MJPEG stream (Hikvision `httpPreview`).
 * Returns the raw IncomingMessage so the caller can pipe it, or null when unsupported.
 */
export async function openDeviceMjpeg(client, channel = 101) {
  const candidates = [
    `/ISAPI/Streaming/channels/${channel}/httpPreview`,
    `/Streaming/channels/${channel}/httpPreview`,
  ];
  for (const path of candidates) {
    try {
      const res = await client.request('GET', path, { timeoutMs: 6000, retries: 0 });
      const ct = String(res.headers['content-type'] || '');
      if (/multipart|x-mixed-replace/i.test(ct) && res.body.length > 0) {
        return { contentType: ct, firstChunk: res.body, path };
      }
    } catch { /* try next */ }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* OSD / image (used by the config UI)                                 */
/* ------------------------------------------------------------------ */

export async function getOsd(client, channel = 1) {
  const path = `/ISAPI/System/Video/inputs/channels/${channel}/overlays`;
  const res = await client.getText(path);
  return { path, raw: res.text };
}

export async function setOsdRaw(client, channel, rawXml) {
  const path = `/ISAPI/System/Video/inputs/channels/${channel}/overlays`;
  const res = await client.putText(path, rawXml);
  return { ok: true, isapiStatus: res.isapi, rebootRequired: isRebootRequired(res.isapi) };
}

export async function getImageParams(client, channel = 1) {
  const path = `/ISAPI/Image/channels/${channel}`;
  const res = await client.getText(path);
  return { path, raw: res.text };
}

export async function setImageRaw(client, channel, rawXml) {
  const path = `/ISAPI/Image/channels/${channel}`;
  const res = await client.putText(path, rawXml);
  return { ok: true, isapiStatus: res.isapi, rebootRequired: isRebootRequired(res.isapi) };
}

/* ------------------------------------------------------------------ */
/* EZVIZ cloud binding status                                          */
/* ------------------------------------------------------------------ */

const truthy = (v) => /^(true|1|yes|on)$/i.test(String(v == null ? '' : v).trim());
const falsy = (v) => /^(false|0|no|off|close|unbound)$/i.test(String(v == null ? '' : v).trim());

/**
 * Read EZVIZ (萤石云) service / binding state.
 *
 * Real device shape (HK-Y2S4M-GL/L V5.8.110), verified live:
 *
 *   GET /ISAPI/System/Network/EZVIZ
 *   <EZVIZ>
 *     <enabled>false</enabled>              <- 萤石云服务开关
 *     <registerStatus>false</registerStatus><- ★ 是否已注册/绑定到萤石云
 *     <redirect>true</redirect>
 *     <serverAddress><hostName>litedev.ys7.com</hostName></serverAddress>
 *     <verificationCode></verificationCode>  <- 绑定验证码
 *     <convergenceCloudEnabled>false</convergenceCloudEnabled>
 *     <upISAPIStatus>close</upISAPIStatus>
 *   </EZVIZ>
 *
 *   GET /ISAPI/System/Network/EZVIZ/capabilities   (declares which fields are settable)
 *   <isSupportUpISAPI> / <isSupportDownISAPI> / <verificationCode min max> / <streamEncrypteEnabled opt>
 *
 * NOTE: this firmware has no `isSupportEZVIZ` flag and uses `registerStatus`
 * (not `bindStatus`) — support is inferred from the endpoint answering at all.
 *
 * Never throws: unusable device yields `supported:false` + `error`.
 */
export async function getEzviStatus(client) {
  const out = {
    supported: false,
    enabled: false,
    bound: false,
    registerStatus: '',
    bindStatus: '',
    verificationCode: '',
    verificationCodeLength: null,
    serverAddress: '',
    convergenceCloudEnabled: false,
    upIsapiStatus: '',
    streamEncrypteEnabled: false,
    supportUpIsapi: false,
    supportDownIsapi: false,
    // null = the firmware does not declare it (UI should render "—", not "否").
    // Several firmwares report this only over SADP (`supportEzvizUnbind`).
    supportUnbind: null,
    error: null,
  };

  // Log in up-front: the EZVIZ endpoints are behind auth, and a caller may hand us
  // a fresh client.
  try {
    await client.login();
  } catch (e) {
    out.error = `login: ${e.message}`;
    return out;
  }

  let capError = null;
  const errors = [];

  // --- capabilities: settable fields / feature flags ---
  try {
    const cap = await client.getText('/ISAPI/System/Network/EZVIZ/capabilities', { timeoutMs: 8000, retries: 1 });
    const el = first(parseXml(cap.text), 'EZVIZ');
    if (el) {
      out.supported = true;
      out.supportUpIsapi = truthy(textOf(el, 'isSupportUpISAPI', ''));
      out.supportDownIsapi = truthy(textOf(el, 'isSupportDownISAPI', ''));
      out.streamEncrypteEnabled = truthy(textOf(el, 'streamEncrypteEnabled', ''));
      const vc = first(el, 'verificationCode');
      if (vc) {
        const min = Number(attrOf(vc, 'min', '0')) || 0;
        const max = Number(attrOf(vc, 'max', '0')) || 0;
        if (min || max) out.verificationCodeLength = { min, max };
      }
      const unbind = textOf(el, 'isSupportEZVIZUnbind', '');
      if (unbind !== '') out.supportUnbind = truthy(unbind);
    }
  } catch (e) {
    capError = `capabilities: ${e.message}`;
    errors.push(capError);
  }

  // --- actual configuration / state ---
  try {
    const res = await client.getText('/ISAPI/System/Network/EZVIZ', { timeoutMs: 8000, retries: 0 });
    const root = parseXml(res.text);
    const el = first(root, 'EZVIZ');
    if (!el) throw new Error('设备未返回 <EZVIZ> 节点');

    out.supported = true;
    out.enabled = truthy(textOf(el, 'enabled', ''));
    out.registerStatus = String(textOf(el, 'registerStatus', ''));
    out.bindStatus = String(textOf(el, 'bindStatus', ''));
    // registerStatus is the authoritative "bound to EZVIZ cloud" flag on this
    // firmware; bindStatus is kept for older/newer variants.
    const boundRaw = out.registerStatus || out.bindStatus;
    out.bound = boundRaw !== '' && !falsy(boundRaw);
    out.verificationCode = textOf(el, 'verificationCode', '');
    out.convergenceCloudEnabled = truthy(textOf(el, 'convergenceCloudEnabled', ''));
    out.upIsapiStatus = textOf(el, 'upISAPIStatus', '');
    const sa = first(el, 'serverAddress');
    out.serverAddress = sa ? (textOf(sa, 'hostName', '') || textOf(sa, 'ipAddress', '')) : '';
    const sec = textOf(el, 'streamEncrypteEnabled', '');
    if (sec !== '') out.streamEncrypteEnabled = truthy(sec);
    const unbindCfg = textOf(el, 'isSupportEZVIZUnbind', '');
    if (out.supportUnbind === null && unbindCfg !== '') out.supportUnbind = truthy(unbindCfg);
    out.raw = res.text.slice(0, 2000);
  } catch (e) {
    errors.push(`EZVIZ: ${e.message}`);
  }

  out.error = errors.length ? errors.join(' | ') : null;
  return out;
}

/* ------------------------------------------------------------------ */
/* firmware upgrade                                                    */
/* ------------------------------------------------------------------ */

/**
 * Upload firmware to one device.
 * @param {IsapiClient} client
 * @param {string} filePath local path of the .dav/.zip package
 * @param {(sent:number,total:number)=>void} [onProgress]
 */
export async function upgradeFirmware(client, filePath, onProgress) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const fileName = filePath.split(/[\\/]/).pop();
  const boundary = '----hikctl' + randomBytes(12).toString('hex');
  const fieldName = 'updateFirmware';

  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const contentLength = head.length + total + tail.length;

  await client.login();

  await new Promise((resolve, reject) => {
    const lib = client.https ? httpsModule : httpModule;
    const req = lib.request({
      host: client.ip,
      port: client.port,
      method: 'PUT',
      path: '/ISAPI/System/updateFirmware',
      agent: client.agent,
      rejectUnauthorized: false,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': contentLength,
        ...client._authHeaders('PUT', '/ISAPI/System/updateFirmware'),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const st = extractResponseStatus(text);
        if (res.statusCode >= 400 || (st && String(st.statusCode) !== '1')) {
          reject(new IsapiError(`升级包上传被拒绝：HTTP ${res.statusCode} ${statusMessage(st)}`,
            { status: res.statusCode, code: 'UPGRADE', isapi: st, body: text }));
        } else resolve();
      });
    });
    req.on('error', reject);
    req.setTimeout(30 * 60_000, () => req.destroy(new Error('升级上传超时(30min)')));

    req.write(head);
    const stream = fs.createReadStream(filePath);
    let sent = 0;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      if (onProgress) onProgress(sent, total);
      if (!req.write(chunk)) stream.pause();
    });
    req.on('drain', () => stream.resume());
    stream.on('error', reject);
    stream.on('end', () => { req.write(tail); req.end(); });
  });

  return { ok: true, bytes: total, message: '升级包已上传，设备正在升级' };
}

/** Poll upgrade status until it finishes or times out. */
export async function waitUpgrade(client, { timeoutMs = 15 * 60_000, intervalMs = 5000, onTick } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await client.getText('/ISAPI/System/upgradeStatus', { timeoutMs: 8000 });
      const root = parseXml(res.text);
      const el = first(root, 'UpgradeStatus') || root;
      last = {
        status: textOf(el, 'status', ''),
        percent: Number(textOf(el, 'percent', '0')) || 0,
        description: textOf(el, 'description', ''),
      };
      if (onTick) onTick(last);
      if (/success|fail|error|complete/i.test(last.status) || last.percent >= 100) return last;
    } catch (e) {
      // Device reboots mid-upgrade; keep polling.
      if (onTick) onTick({ status: 'rebooting', percent: last ? last.percent : 0, description: e.message });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last || { status: 'timeout', percent: 0, description: '升级状态查询超时' };
}

export { IsapiClient, IsapiError };