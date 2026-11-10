// api.js — hikctl REST 客户端。每个方法对应 API.md 中一条已冻结路由。
import { errText } from './util.js';

export class ApiError extends Error {
  constructor(message, code, status, body) {
    super(message);
    this.name = 'ApiError';
    this.code = code || '';
    this.status = status || 0;
    this.body = body;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const enc = (id) => encodeURIComponent(String(id));

async function call(method, path, { body, query, raw, timeoutMs, signal } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const init = { method, headers: {}, signal };
  if (body !== undefined) { init.headers = { ...JSON_HEADERS }; init.body = JSON.stringify(body); }
  let timer = 0;
  if (timeoutMs && !signal) {
    const ac = new AbortController();
    init.signal = ac.signal;
    timer = setTimeout(() => ac.abort(), timeoutMs);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new ApiError('请求超时或已取消', 'TIMEOUT', 0);
    throw new ApiError(`无法连接到服务：${errText(e)}`, 'NETWORK', 0);
  }
  clearTimeout(timer);

  const ct = res.headers.get('Content-Type') || '';
  let payload = null;
  if (ct.includes('application/json')) {
    try { payload = await res.json(); } catch { payload = null; }
  } else if (!raw) {
    try { payload = await res.text(); } catch { payload = null; }
  }

  if (!res.ok) {
    const eo = payload && typeof payload === 'object' ? payload.error : null;
    const msg = (eo && (eo.message || eo.code)) || (typeof payload === 'string' && payload.slice(0, 180)) || `${res.status} ${res.statusText}`;
    throw new ApiError(msg, eo ? eo.code : `HTTP_${res.status}`, res.status, payload);
  }
  return payload;
}

/** 拼接带查询参数的取图/取流地址（用于 <img src>） */
export function mediaUrl(path, query) {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/** 把 API 响应里的相对地址（如 /reports/x.xlsx）补成同源绝对地址 */
export function absUrl(u) {
  try { return new URL(String(u), location.href).href; } catch { return String(u); }
}

export const api = {
  // ---- 1. 服务 ----
  health: () => call('GET', '/api/health', { timeoutMs: 8000 }),                       // GET /api/health

  // ---- 2. 设备 ----
  listDevices: () => call('GET', '/api/devices', { timeoutMs: 20000 }),                // GET /api/devices

  addDevice: (d) => call('POST', '/api/devices', {                                             // POST /api/devices
    body: {
      ip: d.ip,
      port: Number(d.port) || 80,
      https: !!d.https,
      username: d.username || 'admin',
      password: d.password ?? '',
      label: d.label ?? '',
      group: d.group ?? '',
    },
    timeoutMs: 30000,
  }),

  delDevice: (id) => call('DELETE', `/api/devices/${enc(id)}`, { timeoutMs: 15000 }),  // DELETE /api/devices/:id

  patchDevice: (id, patch) => call('PATCH', `/api/devices/${enc(id)}`, { body: patch, timeoutMs: 20000 }), // PATCH /api/devices/:id

  probe: (id) => call('POST', `/api/devices/${enc(id)}/probe`, { timeoutMs: 30000 }),  // POST /api/devices/:id/probe
  probeAll: () => call('POST', '/api/devices/probe-all', { timeoutMs: 20000 }),        // POST /api/devices/probe-all

  importDevices: (text, defaultUsername = 'admin') =>                                  // POST /api/devices/import
    call('POST', '/api/devices/import', { body: { text, defaultUsername }, timeoutMs: 60000 }),

  // ---- 3. 发现 ----
  sadp: (timeoutMs = 3000) => call('POST', '/api/discover/sadp', { body: { timeoutMs }, timeoutMs: timeoutMs + 20000 }), // POST /api/discover/sadp

  scan: (p) => call('POST', '/api/discover/scan', {                                    // POST /api/discover/scan
    body: {
      from: p.from,
      to: p.to,
      username: p.username || 'admin',
      password: p.password ?? '',
      concurrency: Number(p.concurrency) || 64,
      timeoutMs: Number(p.timeoutMs) || 800,
    },
    timeoutMs: 20000,
  }),

  // ---- 3.5 设备激活（未激活的新设备此时还不在设备库里） ----
  activateConfig: () => call('GET', '/api/activate/config', { timeoutMs: 15000 }),      // GET /api/activate/config

  activate: (t, password, o = {}) => call('POST', '/api/activate', {                     // POST /api/activate
    body: {
      ip: t.ip,
      port: Number(t.port) || 80,
      password: password ?? '',
      userName: o.userName || 'admin',
      label: o.label ?? '',
      autoAdd: o.autoAdd !== false,
    },
    timeoutMs: 90000,
  }),

  activateBatch: (targets, password, o = {}) => call('POST', '/api/activate/batch', {    // POST /api/activate/batch
    body: {
      targets: (targets || []).map((t) => ({ ip: t.ip, port: Number(t.port) || 80 })),
      password: password ?? '',
      concurrency: Number(o.concurrency) || 8,
      autoAdd: o.autoAdd !== false,
      label: o.label ?? '',
    },
    timeoutMs: 30000,
  }),

  // ---- 4. 原始 ISAPI 透传 ----
  isapiGet: (id, path) => call('GET', `/api/devices/${enc(id)}/isapi`, { query: { path }, timeoutMs: 20000 }), // GET /api/devices/:id/isapi

  // ---- 5. 单设备操作 ----
  reboot: (id) => call('POST', `/api/devices/${enc(id)}/reboot`, { timeoutMs: 30000 }), // POST /api/devices/:id/reboot
  reset: (id, mode, password) =>                                                        // POST /api/devices/:id/reset
    call('POST', `/api/devices/${enc(id)}/reset`, { body: { mode, password }, timeoutMs: 60000 }),

  setNetwork: (id, cfg) => call('PUT', `/api/devices/${enc(id)}/network`, {             // PUT /api/devices/:id/network
    body: {
      interfaceId: Number(cfg.interfaceId) || 1,
      ip: cfg.ip,
      mask: cfg.mask,
      gateway: cfg.gateway,
      dns: cfg.dns,
      dhcp: !!cfg.dhcp,
    },
    timeoutMs: 30000,
  }),

  setTime: (id, cfg) => call('PUT', `/api/devices/${enc(id)}/time`, { body: cfg, timeoutMs: 30000 }), // PUT /api/devices/:id/time

  setPassword: (id, p) => call('PUT', `/api/devices/${enc(id)}/password`, {             // PUT /api/devices/:id/password
    body: { userName: p.userName || 'admin', oldPassword: p.oldPassword ?? '', newPassword: p.newPassword ?? '' },
    timeoutMs: 30000,
  }),

  // ---- 6. 批量 ----
  batch: (deviceIds, action, params, concurrency = 16) =>                               // POST /api/batch
    call('POST', '/api/batch', { body: { deviceIds, action, params: params || {}, concurrency }, timeoutMs: 20000 }),

  tasks: () => call('GET', '/api/tasks', { timeoutMs: 15000 }),                          // GET /api/tasks
  task: (taskId) => call('GET', `/api/tasks/${enc(taskId)}`, { timeoutMs: 15000 }),      // GET /api/tasks/:id

  // ---- 7. 实时预览（返回地址，供 <img> 使用） ----
  snapshotUrl: (id, channel = 101, bust) =>                                              // GET /api/devices/:id/snapshot
    mediaUrl(`/api/devices/${enc(id)}/snapshot`, { channel, t: bust }),
  previewUrl: (id, channel = 101, fps) =>                                                // GET /api/devices/:id/preview.mjpg
    mediaUrl(`/api/devices/${enc(id)}/preview.mjpg`, { channel, fps }),
  stream: (id) => call('GET', `/api/devices/${enc(id)}/stream`, { timeoutMs: 15000 }),   // GET /api/devices/:id/stream

  // ---- 8. 升级 ----
  upgrade: (id, filePath) => call('POST', `/api/devices/${enc(id)}/upgrade`, { body: { filePath }, timeoutMs: 20000 }), // POST /api/devices/:id/upgrade
  batchUpgrade: (deviceIds, filePath, concurrency = 4) =>                                // POST /api/batch-upgrade
    call('POST', '/api/batch-upgrade', { body: { deviceIds, filePath, concurrency }, timeoutMs: 20000 }),

  // ---- 9. 报表 ----
  report: (deviceIds, format = 'csv', include = ['probe', 'network', 'time', 'users', 'storage']) => // POST /api/report
    call('POST', '/api/report', { body: { deviceIds, format, include }, timeoutMs: 120000 }),

  // ---- 10. 设备后台（离线配置包，HiToolsDelivery「内置浏览器」的等价实现） ----
  consoleState: () => call('GET', '/api/console/state', { timeoutMs: 10000 }),            // GET /api/console/state
  consoleUrl: (id) => call('GET', '/api/console/url', { query: { device: id }, timeoutMs: 10000 }), // GET /api/console/url
};

export default api;
