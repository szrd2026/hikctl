/**
 * 用 CDP（Chrome DevTools Protocol）驱动无头 Edge 截图。
 *
 * 为什么要自己写：本机没有 npm 依赖（不联网装 puppeteer），而 `msedge --screenshot`
 * 在 headless=new 下会挂住。Node 24 自带 WebSocket，直接说 CDP 就够了。
 *
 * 用法：
 *   node tools/shoot.mjs <url> <输出png> [宽] [高] [缩放] [额外等待ms]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/** 启动一个 headless 浏览器并返回 { proc, wsUrl, close() } */
export async function launch({ port = 0 } = {}) {
  const bin = findBrowser();
  if (!bin) throw new Error('未找到 Edge/Chrome');
  const debugPort = port || 9200 + Math.floor(Math.random() * 500);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'hikctl-cdp-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${udd}`,
    'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: 'ignore', windowsHide: true });

  // 等 DevTools 端口就绪
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* not up yet */ }
  }
  if (!wsUrl) { try { proc.kill(); } catch { /* ignore */ } throw new Error('DevTools 端口未就绪'); }

  return {
    proc, udd, port: debugPort, wsUrl,
    close() {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** 极简 CDP 客户端 */
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
      }, 30000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/**
 * 打开页面截图。
 * @returns {Promise<{png: Buffer, consoleErrors: string[]}>}
 */
export async function screenshot(browser, cdp, url, {
  width = 1600, height = 1000, scale = 2, settleMs = 2500, fullPage = false, evalJs = null, afterMs = 1200,
} = {}) {
  // 新建一个 target（页面）
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const consoleErrors = [];
  const onMsg = (p) => {
    if (p.type === 'error' || p.type === 'assert') {
      consoleErrors.push(String(p.args?.map((a) => a.value ?? a.description ?? '').join(' ') || p.text || ''));
    }
  };
  const onExc = (p) => consoleErrors.push(`EXCEPTION: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || ''}`);
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.sessionId === sessionId) onMsg(p); });
  cdp.on('Runtime.exceptionThrown', (p) => { if (p.sessionId === sessionId) onExc(p); });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId).catch(() => {});
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: scale, mobile: false,
  }, sessionId);

  const loaded = new Promise((res) => {
    const t = setTimeout(res, 20000);
    cdp.on('Page.loadEventFired', (p) => { if (p.sessionId === sessionId) { clearTimeout(t); res(); } });
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  await sleep(settleMs);   // 让 SPA 渲染 / XHR 完成

  if (evalJs) {
    // 先在页面里做点动作（点开抽屉、切标签…），再截图
    const r = await cdp.send('Runtime.evaluate', {
      expression: evalJs, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) {
      consoleErrors.push(`EVAL: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    await sleep(afterMs);
  }

  let clip;
  if (fullPage) {
    const m = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
    const cs = m.cssContentSize || m.contentSize;
    clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.ceil(cs.height), scale: 1 };
  }
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: fullPage, ...(clip ? { clip } : {}),
  }, sessionId);

  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return { png: Buffer.from(shot.data, 'base64'), consoleErrors };
}

/* ------------------------------ CLI ------------------------------ */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // 具名参数：--url --out --w --h --scale --settle --eval --after
  const opt = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
  };
  const url = opt('url');
  const out = opt('out');
  if (!url || !out) {
    console.error('用法: node tools/shoot.mjs --url <url> --out <out.png> [--w 1600] [--h 1000] [--scale 2] [--settle 2500] [--eval "js"] [--after 1200]');
    process.exit(2);
  }
  const browser = await launch();
  try {
    const cdp = await CDP.connect(browser.wsUrl);
    const { png, consoleErrors } = await screenshot(browser, cdp, url, {
      width: Number(opt('w', 1600)),
      height: Number(opt('h', 1000)),
      scale: Number(opt('scale', 2)),
      settleMs: Number(opt('settle', 2500)),
      evalJs: opt('eval', null),
      afterMs: Number(opt('after', 1200)),
    });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, png);
    console.log(`✅ ${path.basename(out)}  ${(png.length / 1024).toFixed(0)} KB`);
    if (consoleErrors.length) {
      console.log(`⚠ 页面错误 ${consoleErrors.length} 条:`);
      for (const e of consoleErrors.slice(0, 8)) console.log('   ' + String(e).slice(0, 260));
    } else {
      console.log('   (无页面 JS 错误)');
    }
    cdp.close();
  } finally {
    browser.close();
  }
}