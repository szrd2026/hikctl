/**
 * Device web console host — the "built-in browser" feature.
 *
 * HiToolsDelivery solves "camera has no web UI" by running nginx locally: it serves
 * a copy of Hikvision's *device web front-end* (the 离线配置包 / offline package) from
 * disk and reverse-proxies every device-relative URL (`/ISAPI/*`, `/DISPATCH_ip_*`)
 * back to the real camera, selected by a `ProxyHostInfo` cookie.
 *
 * This module reimplements that in-process — no nginx, no Redis, no SDK:
 *
 *   GET /open?device=<ip:port>   bootstrap page -> sets cookies -> ConfigKit.Init()
 *   GET /console                 landing page listing every available package
 *   GET /WebConfigCtrl/*         static files from the offline package root
 *   GET /DISPATCH_ip_<host>/<p>  reverse proxy -> http://<host>/<p>
 *   GET /ISAPI|/SDK|/FDLib|...   reverse proxy using the ProxyHostInfo cookie
 *
 * The proxy authenticates with OUR IsapiClient (session or digest), so a device that
 * only accepts digest/session auth works without the browser showing an auth prompt,
 * and HTTPS-only devices are terminated locally.
 *
 * Node built-ins only.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Paths that always belong to the device, never to the local package. */
const DEVICE_PREFIXES = [
  '/ISAPI/', '/SDK/', '/FDLib', '/LOCALS/', '/help/',
  '/SoftwareLicense.txt', '/iot/',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.asp': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Find the offline package root shipped by HiToolsDelivery (or a local copy).
 * @returns {string|null}
 */
export function detectPackageRoot(candidates = []) {
  const list = [
    ...candidates,
    'C:\\Program Files\\HiToolsDelivery\\userData\\plugins\\base\\nginx\\html\\WebConfigCtrl',
    'C:\\Program Files\\HiToolsDelivery\\client\\nginx\\html\\WebConfigCtrl',
  ];
  for (const c of list) {
    try {
      if (c && fs.existsSync(path.join(c, 'ConfigKitSDK.js'))) return c;
    } catch { /* keep looking */ }
  }
  return null;
}

/** List `Packages/<sign>/<variant>` entries that look usable. */
export function listPackages(root) {
  const out = [];
  if (!root) return out;
  const pkgDir = path.join(root, 'Packages');
  let signs = [];
  try { signs = fs.readdirSync(pkgDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const sign of signs) {
    let variants = [];
    try {
      variants = fs.readdirSync(path.join(pkgDir, sign), { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^webs_/.test(e.name)).map((e) => e.name);
    } catch { /* skip */ }
    for (const variant of variants) {
      const dir = path.join(pkgDir, sign, variant);
      const hasIndex = fs.existsSync(path.join(dir, 'doc', 'index.html')) || fs.existsSync(path.join(dir, 'index.asp'));
      if (hasIndex) out.push({ sign, variant, dir });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Console host                                                        */
/* ------------------------------------------------------------------ */

export function createConsole({
  store, packageRoot, host = '127.0.0.1', port = 9099, onLog = () => {},
}) {
  const root = packageRoot;
  /** device id -> { sign, variant } remembered from the package's own requests */
  const activePackage = new Map();
  let server = null;
  let boundPort = 0;
  let listenPromise = null;

  const log = (msg) => onLog(`[console] ${msg}`);

  /* ----------------------------- helpers ---------------------------- */

  const cookieValue = (req, name) => {
    const raw = String(req.headers.cookie || '');
    const re = new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`);
    const m = re.exec(raw);
    return m ? decodeURIComponent(m[1]) : '';
  };

  /** Which device does this request belong to? */
  const resolveDeviceId = (req, url) => {
    // 1) /DISPATCH_ip_<host>/... carries the device inline
    const m = /^\/DISPATCH_([a-z]+)_(.+?)\//.exec(url.pathname);
    if (m && m[1] === 'ip') {
      const hostPart = decodeURIComponent(m[2]);
      return /:\d+$/.test(hostPart) ? hostPart : `${hostPart}:80`;
    }
    // 2) the cookie ConfigKit sets
    const c = cookieValue(req, 'ProxyHostInfo');
    if (c) return /:\d+$/.test(c) ? c : `${c}:80`;
    // 3) explicit query/header
    const q = url.searchParams.get('device');
    if (q) return q;
    return '';
  };

  /** Strip the DISPATCH prefix to get the real device path. */
  const devicePath = (pathname) => {
    const m = /^\/DISPATCH_([a-z]+)_(.+?)(\/.*)?$/.exec(pathname);
    if (m) {
      let p = m[3] || '/';
      // `/DISPATCH_ezviz_<ip>/OfflineService/ISAPI/...` → strip the SDK proxy segment
      p = p.replace(/^\/OfflineService\//, '/');
      return p;
    }
    return pathname;
  };

  const isDevicePath = (pathname) => {
    if (pathname.startsWith('/DISPATCH_')) return true;
    return DEVICE_PREFIXES.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p));
  };

  /* --------------------------- device proxy ------------------------- */

  /**
   * Proxy one request to a device, streaming the response through.
   * Auth is supplied by our IsapiClient, so digest/session devices just work.
   */
  async function proxyToDevice(req, res, deviceId, targetPath, body) {
    const dev = store.get(deviceId);
    if (!dev) return sendError(res, 404, `设备不在库中：${deviceId}`);

    const client = store.client(deviceId, { timeoutMs: 30_000 });
    if (!client) return sendError(res, 500, '无法创建设备客户端');

    const method = req.method.toUpperCase();
    const doOnce = async () => {
      await client.login();
      const headers = {
        Accept: req.headers.accept || '*/*',
        'Accept-Encoding': 'identity',
        Connection: 'keep-alive',
        'User-Agent': 'hikctl-console/1.0',
        ...client._authHeaders(method, targetPath),
      };
      const ct = req.headers['content-type'];
      if (ct) headers['Content-Type'] = ct;
      if (body && body.length) headers['Content-Length'] = body.length;
      else if (method === 'POST' || method === 'PUT') headers['Content-Length'] = 0;

      const lib = client.https ? https : http;
      return new Promise((resolve, reject) => {
        const up = lib.request({
          host: client.ip,
          port: client.port,
          method,
          path: targetPath,
          headers,
          agent: client.agent,
          rejectUnauthorized: false,
        }, (upRes) => resolve({ up, upRes }));
        up.setTimeout(30_000, () => up.destroy(new Error('上游设备响应超时')));
        up.on('error', reject);
        if (body && body.length) up.write(body);
        up.end();
      });
    };

    let upstream;
    try {
      upstream = await doOnce();
      // One transparent re-login on auth failure
      if (upstream.upRes.statusCode === 401) {
        upstream.upRes.resume();
        try { upstream.up.destroy(); } catch { /* ignore */ }
        client.session = null;
        await client.login({ force: true });
        upstream = await doOnce();
      }
    } catch (e) {
      return sendError(res, 502, `无法连接设备：${e.message}`);
    }

    const { up, upRes } = upstream;
    const outHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      const key = k.toLowerCase();
      // drop hop-by-hop and anything that would make the browser talk to the device directly
      if (['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'set-cookie',
    'www-authenticate', 'content-encoding', 'location'].includes(key)) continue;
      outHeaders[k] = v;
    }
    // Preserve device-side relative redirects but keep the browser on our origin.
    if (upRes.headers.location) outHeaders.location = String(upRes.headers.location);
    outHeaders['Cache-Control'] = 'no-store';

    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
    res.on('close', () => { try { up.destroy(); } catch { /* ignore */ } });
    return undefined;
  }

  /* ---------------------------- static ------------------------------ */

  async function serveStatic(res, urlPath, deviceId) {
    if (!root) return sendError(res, 503, '未找到离线配置包目录，请用 --packages 指定');

    let rel = decodeURIComponent(urlPath);
    // Remember which package the page is using so we can resolve absolute asset paths.
    const pm = /^\/WebConfigCtrl\/Packages\/([^/]+)\/([^/]+)\//.exec(rel);
    if (pm && deviceId) activePackage.set(deviceId, { sign: pm[1], variant: pm[2] });

    const candidates = [];
    if (rel.startsWith('/WebConfigCtrl/')) candidates.push(path.join(root, rel.slice('/WebConfigCtrl/'.length)));
    candidates.push(path.join(root, rel.replace(/^\/+/, '')));

    // Absolute asset paths (e.g. /doc/js/x.js) fall back to the active package dir.
    const act = deviceId ? activePackage.get(deviceId) : null;
    if (act && !rel.startsWith('/WebConfigCtrl/')) {
      candidates.push(path.join(root, 'Packages', act.sign, act.variant, rel.replace(/^\/+/, '')));
    }

    for (const raw of candidates) {
      const target = path.normalize(raw);
      if (root && !target.startsWith(path.normalize(root))) continue;
      try {
        const st = await fsp.stat(target);
        if (!st.isFile()) continue;
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': st.size,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(target).pipe(res);
        return undefined;
      } catch { /* try next candidate */ }
    }
    return sendError(res, 404, `未找到资源：${urlPath}`);
  }

  /* --------------------------- bootstrap ---------------------------- */

  function landingPage() {
    const pkgs = listPackages(root);
    const devices = store.list().map((d) => ({ id: d.id, label: d.label || '', model: (d.status && d.status.model) || '' }));
    const row = (d) => `<li><a href="/open?device=${encodeURIComponent(d.id)}">${d.label || d.id}</a>
      <span class="muted">${d.id}${d.model ? ' · ' + d.model : ''}</span></li>`;
    const pkgRow = (p) => `<li><code>${p.sign}/${p.variant}</code></li>`;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>设备后台 · hikctl</title>
<style>
 body{font:13px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;background:#12151c;color:#d7dbe4;margin:0;padding:28px}
 h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:22px 0 8px;color:#8fa3c8}
 a{color:#6ea8fe;text-decoration:none} a:hover{text-decoration:underline}
 ul{margin:0;padding-left:18px} li{margin:4px 0}
 .muted{color:#6b7686;margin-left:8px} code{background:#1b2030;padding:1px 6px;border-radius:4px}
 .warn{background:#2a2113;border:1px solid #6b5a2a;color:#e8c97a;padding:10px 12px;border-radius:6px;margin:14px 0}
</style></head><body>
<h1>设备后台（本地离线配置包）</h1>
<div class="muted">由 hikctl 自带，无需设备内置网页；数据请求由本机反向代理回设备。</div>
${devices.length ? `<h2>打开设备后台</h2><ul>${devices.map(row).join('')}</ul>`
    : '<div class="warn">设备库为空。请先在 hikctl 主界面添加或发现设备。</div>'}
<h2>可用的离线配置包（${pkgs.length}）</h2>
<ul>${pkgs.slice(0, 40).map(pkgRow).join('')}${pkgs.length > 40 ? '<li>…</li>' : ''}</ul>
${root ? '' : '<div class="warn">未找到离线配置包目录。用 <code>--packages &lt;dir&gt;</code> 指定，或保证 HiToolsDelivery 仍安装在本机。</div>'}
</body></html>`;
  }

  function bootstrapPage(deviceId, device, { deviceType = 'IPCamera', language = 'zh_CN' } = {}) {
    const cfg = {
      language,
      webLocation: 'local',
      userInfo: { username: device.username || 'admin', password: device.password || '' },
      cfgInfo: {
        deviceType,
        protocolType: 'ip',
        needProxy: true,
        deviceId,
        videoMode: 'image', // snapshots — avoids needing the native video plugin
      },
      needWindow: false,
      deviceProtocolType: 'isapi',
    };
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>正在打开设备后台…</title>
<style>body{font:13px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;background:#12151c;color:#d7dbe4;margin:0;
 display:flex;align-items:center;justify-content:center;height:100vh}
 .b{text-align:center}.s{color:#8fa3c8;margin-top:8px;font-size:12px}
 .e{color:#e8a0a0;white-space:pre-wrap;text-align:left;max-width:720px;margin-top:12px;font-family:ui-monospace,monospace;font-size:12px}</style>
</head><body><div class="b">
<div>正在装载离线配置包…</div><div class="s" id="st">${deviceId}</div>
<div class="e" id="err"></div>
</div>
<script src="/WebConfigCtrl/ConfigKitSDK.js"></script>
<script>
(function () {
  var cfg = ${JSON.stringify(cfg)};
  function fail(msg) {
    document.getElementById('st').textContent = '装载失败';
    document.getElementById('err').textContent = String(msg && msg.stack ? msg.stack : msg);
  }
  window.addEventListener('error', function (e) { fail(e.message); });
  try {
    if (typeof ConfigKit === 'undefined') { fail('ConfigKitSDK.js 未加载：请确认离线配置包目录存在'); return; }
    ConfigKit.Init(cfg).then(function (x) {
      if (x && x.Code && x.Code !== '1') fail((x.Code || '') + ' ' + (x.Msg || ''));
      else document.getElementById('st').textContent = '已就绪';
    }).catch(fail);
  } catch (e) { fail(e); }
})();
</script></body></html>`;
  }

  /* ----------------------------- routing ---------------------------- */

  function sendError(res, code, msg) {
    if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return undefined; }
    const body = Buffer.from(`<!doctype html><meta charset="utf-8"><body style="font:13px sans-serif;background:#12151c;color:#d7dbe4;padding:24px">`
      + `<h3 style="margin:0 0 8px">${code}</h3><pre style="white-space:pre-wrap">${String(msg).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre></body>`, 'utf8');
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
    return undefined;
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const p = url.pathname;

    if (p === '/__state') {
      const devices = store.list().map((d) => d.id);
      const body = Buffer.from(JSON.stringify({
        ok: true, packageRoot: root, packages: listPackages(root).length, devices, port: boundPort,
      }), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      res.end(body);
      return;
    }

    if (p === '/' || p === '/console') {
      const body = Buffer.from(landingPage(), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    if (p === '/open') {
      const deviceId = url.searchParams.get('device') || resolveDeviceId(req, url);
      const dev = deviceId ? store.get(deviceId) : null;
      if (!dev) return sendError(res, 404, `设备不在库中：${deviceId || '(未指定)'}\n请先在主界面添加设备，再用 /open?device=<ip:port> 打开。`);
      const secret = store.secret(dev);
      const deviceType = url.searchParams.get('deviceType')
        || (dev.status && dev.status.deviceType) || 'IPCamera';
      const body = Buffer.from(bootstrapPage(deviceId, secret, {
        deviceType, language: url.searchParams.get('lang') || 'zh_CN',
      }), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        // ConfigKit reads these on every request (same trick nginx used).
        'Set-Cookie': [
          `ProxyHostInfo=${encodeURIComponent(deviceId)}; Path=/; SameSite=Lax`,
          `SDKMode=ip; Path=/`,
          `deviceId=${encodeURIComponent(deviceId)}; Path=/`,
          `deviceProtocolType=isapi; Path=/`,
        ],
      });
      res.end(body);
      return;
    }

    // ---- device-bound traffic ----
    if (isDevicePath(p)) {
      const deviceId = resolveDeviceId(req, url);
      if (!deviceId) return sendError(res, 400, '无法确定目标设备：缺少 ProxyHostInfo Cookie 或 DISPATCH 前缀');
      const target = devicePath(p) + (url.search || '');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return proxyToDevice(req, res, deviceId, target, Buffer.concat(chunks));
    }

    // ---- static assets ----
    return serveStatic(res, p, resolveDeviceId(req, url));
  }

  /* ------------------------------ lifecycle ------------------------- */

  async function listen(preferred = port) {
    // 幂等：主服务的 listen 回调在某些重试路径下会触发两次，
    // 并发对同一个 server 再次 listen 会抛 ERR_SERVER_ALREADY_LISTEN，
    // 表现为「设备后台：启动失败」但其实已经起来了。共用同一个 Promise。
    if (listenPromise) return listenPromise;
    listenPromise = (async () => {
      server = http.createServer((req, res) => {
        handle(req, res).catch((e) => sendError(res, 500, e && e.stack ? e.stack : String(e)));
      });
      server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ } });

      let p = Number(preferred) || 9099;
      for (let i = 0; i < 20; i++) {
        const outcome = await new Promise((resolve) => {
          const onErr = (e) => {
            server.removeListener('error', onErr);
            if (e.code === 'EADDRINUSE' || e.code === 'EACCES') { resolve('busy'); return; }
            log(`监听失败: ${e.message}`);
            resolve('fatal');
          };
          server.once('error', onErr);
          try {
            server.listen(p, host, () => { server.removeListener('error', onErr); resolve('ok'); });
          } catch (e) {
            server.removeListener('error', onErr);
            log(`监听异常: ${e.message}`);
            resolve('fatal');
          }
        });
        if (outcome === 'ok') break;
        if (outcome === 'fatal') break;
        p += 1;
      }
      if (!server.listening) throw new Error('离线配置包服务无法监听端口');
      boundPort = server.address().port;
      log(`离线配置包服务已启动 http://${host}:${boundPort}/  (包目录: ${root || '未找到'})`);
      return boundPort;
    })();
    return listenPromise;
  }

  function close() {
    return new Promise((resolve) => { if (server) server.close(() => resolve()); else resolve(); });
  }

  return {
    listen, close,
    get port() { return boundPort; },
    get packageRoot() { return root; },
    urlFor: (deviceId) => `http://${host}:${boundPort}/open?device=${encodeURIComponent(deviceId)}`,
    landingUrl: () => `http://${host}:${boundPort}/`,
  };
}