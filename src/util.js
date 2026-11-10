/** Small shared helpers. Node built-ins only. */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- IPv4 ---------------------------------- */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIPv4(s) {
  const m = IPV4_RE.exec(String(s || '').trim());
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

export function ipToInt(ip) {
  const m = IPV4_RE.exec(ip);
  if (!m) return NaN;
  return ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4];
}

export function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Expand an inclusive range, capped to `limit` addresses. */
export function expandRange(from, to, limit = 65536) {
  const a = ipToInt(from);
  const b = ipToInt(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('IP 地址格式不正确');
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const count = hi - lo + 1;
  if (count > limit) throw new Error(`地址数量 ${count} 超过上限 ${limit}`);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = intToIp(lo + i);
  return out;
}

export function parseCidr(cidr) {
  const [ip, bitsRaw] = String(cidr).split('/');
  if (!isIPv4(ip)) throw new Error('CIDR 中的 IP 不合法');
  const bits = Number(bitsRaw == null ? 24 : bitsRaw);
  if (!(bits >= 0 && bits <= 32)) throw new Error('CIDR 掩码不合法');
  const base = ipToInt(ip);
  const size = 2 ** (32 - bits);
  const start = (base - (base % size)) >>> 0;
  return { from: intToIp(start), to: intToIp(start + size - 1), size };
}

/** Local IPv4 addresses of this machine (for default scan range / SADP hints). */
export function localIPv4List(os) {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        out.push({ iface: name, address: ni.address, netmask: ni.netmask, cidr: ni.cidr });
      }
    }
  }
  return out;
}

/* --------------------------- concurrency ---------------------------- */

/**
 * Run `worker(item, index)` over items with at most `limit` in flight.
 * Never rejects: each result is { ok, value } or { ok:false, error }.
 */
export async function mapLimit(items, limit, worker) {
  const arr = Array.from(items);
  const results = new Array(arr.length);
  let next = 0;
  const n = Math.max(1, Math.min(Number(limit) || 1, arr.length || 1));

  async function runner() {
    for (;;) {
      const i = next++;
      if (i >= arr.length) return;
      try {
        results[i] = { ok: true, value: await worker(arr[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: n }, runner));
  return results;
}

/* ------------------------------ misc -------------------------------- */

export function randomHex(bytes = 8) {
  return crypto.getRandomValues(new Uint8Array(bytes))
    .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

export function nowStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Strip CR/LF/NUL etc. from values that go into XML (device-side injection guard). */
export function sanitizeXmlValue(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Normalise a device id: "ip:port". */
export function makeId(ip, port, https = false) {
  return `${ip}:${port}${https ? 's' : ''}`;
}

export function parseId(id) {
  const m = /^(.+):(\d+)(s?)$/.exec(String(id));
  if (!m) return null;
  return { ip: m[1], port: Number(m[2]), https: m[3] === 's' };
}

/** Human-readable error message from anything. */
export function errMsg(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  return String(e);
}