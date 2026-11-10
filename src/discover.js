/**
 * LAN discovery helpers: SADP is in sadp.js; this module adds an active
 * IP-range scan that talks ISAPI directly.
 */
import net from 'node:net';

import { IsapiClient } from './client.js';
import { probe } from './ops.js';
import { getActivateStatus } from './activate.js';
import { expandRange, parseCidr, mapLimit, isIPv4 } from './util.js';

/** Cheap TCP reachability check. */
export function tcpPing(ip, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host: ip, port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ open, ms: Date.now() - started });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * Scan an IP range for cameras.
 * Strategy: TCP probe 80 (and 443 when enabled) first — cheap and parallel —
 * then run a full ISAPI probe only on hosts that answered.
 *
 * @param {object} opts
 * @param {string} [opts.from] start IP
 * @param {string} [opts.to] end IP
 * @param {string} [opts.cidr] alternative to from/to
 * @param {string} [opts.username]
 * @param {string} [opts.password]
 * @param {number} [opts.concurrency=64]
 * @param {number} [opts.timeoutMs=800]
 * @param {boolean} [opts.https=false] also probe 443
 * @param {(r:object)=>void} [opts.onResult]
 * @param {()=>boolean} [opts.isCancelled]
 */
export async function scanRange(opts) {
  const {
    username = 'admin', password = '', concurrency = 64,
    timeoutMs = 800, https = false, onResult, isCancelled,
  } = opts;

  // Which TCP ports to try. Cameras are frequently moved off :80 (8080/8000/8443...),
  // so the caller may pass an explicit list.
  const ports = (Array.isArray(opts.ports) && opts.ports.length
    ? opts.ports.map(Number).filter((p) => p > 0 && p < 65536)
    : (https ? [80, 443] : [80]));

  let from = opts.from;
  let to = opts.to;
  if (opts.cidr) {
    const r = parseCidr(opts.cidr);
    from = from || r.from;
    to = to || r.to;
  }
  if (!isIPv4(from) || !isIPv4(to)) throw new Error('扫描范围不合法');

  const ips = expandRange(from, to, 65536);
  const started = Date.now();
  let scanned = 0;
  let found = 0;

  const concurrencyUsed = Math.max(1, Math.min(256, Number(concurrency) || 64));

  await mapLimit(ips, concurrencyUsed, async (ip) => {
    if (isCancelled && isCancelled()) return;
    let hit = null;
    for (const p of ports) {
      const r = await tcpPing(ip, p, timeoutMs);
      if (r.open) { hit = { port: p, https: p === 443, ms: r.ms }; break; }
    }
    scanned++;

    if (!hit) {
      if (onResult && scanned % 25 === 0) {
        onResult({ ip, found: false, progress: { scanned, total: ips.length, found, elapsedMs: Date.now() - started } });
      }
      return;
    }

    const client = new IsapiClient({
      ip, port: hit.port, https: hit.https, username, password,
      timeoutMs: Math.max(3000, timeoutMs * 3),
    });
    try {
      // An UNACTIVATED device rejects every ISAPI call (403 notActivated) but still
      // answers /SDK/activateStatus without authentication. Check that first,
      // otherwise a brand-new camera is completely invisible to the IP scan.
      let act = null;
      try {
        act = await getActivateStatus(ip, { port: hit.port, https: hit.https, timeoutMs: 3000 });
      } catch { /* fall through to the normal probe */ }

      if (act && act.reachable && act.inactive) {
        found++;
        if (onResult) {
          onResult({
            ip,
            port: hit.port,
            https: hit.https,
            found: true,
            activated: false,
            needsActivation: true,
            supportVersion: act.supportVersion,
            tcpMs: hit.ms,
            model: '', serialNumber: '', deviceName: '', firmwareVersion: '',
            deviceType: '', macAddress: '', latencyMs: 0, authMode: '',
            error: null,
            progress: { scanned, total: ips.length, found, elapsedMs: Date.now() - started },
          });
        }
        return;
      }

      const status = await probe(client, { deep: false });
      if (status.online) found++;
      if (onResult) {
        onResult({
          ip,
          port: hit.port,
          https: hit.https,
          found: status.online,
          activated: status.online ? true : null,
          needsActivation: false,
          tcpMs: hit.ms,
          model: status.model,
          serialNumber: status.serialNumber,
          deviceName: status.deviceName,
          firmwareVersion: status.firmwareVersion,
          deviceType: status.deviceType,
          macAddress: status.macAddress,
          latencyMs: status.latencyMs,
          error: status.error,
          authMode: status.authMode,
          progress: { scanned, total: ips.length, found, elapsedMs: Date.now() - started },
        });
      }
    } finally {
      client.close();
    }
  });

  return {
    scanned,
    total: ips.length,
    found,
    elapsedMs: Date.now() - started,
  };
}