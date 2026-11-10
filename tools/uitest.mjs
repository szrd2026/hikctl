/**
 * Minimal DOM shim so `web/app.js` can be EXECUTED in Node.
 *
 * Purpose: catch runtime errors (not syntax errors — `node --check` covers those)
 * that leave the page rendered but dead, i.e. boot() throwing before listeners bind.
 *
 * Usage: node tools/uitest.mjs
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ------------------------------ Element ------------------------------ */

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { for (const x of c) if (x) this.set.add(x); this._sync(); }
  remove(...c) { for (const x of c) this.set.delete(x); this._sync(); }
  toggle(c, f) { const on = f === undefined ? !this.set.has(c) : !!f; on ? this.set.add(c) : this.set.delete(c); this._sync(); return on; }
  contains(c) { return this.set.has(c); }
  _sync() { this.el._class = [...this.set].join(' '); }
  get value() { return this.el._class; }
}

class El {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this._class = '';
    this._text = '';
    this._html = '';
    this._listeners = new Map();
    this.classList = new ClassList(this);
    // Browsers give form controls real defaults; mirror them so code that reads
// `.value.trim()` on a fresh input behaves the same here.
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this.readOnly = false;
    for (const p of ['id', 'type', 'name', 'placeholder']) this[p] = undefined;
    this.hidden = false;
    this.isConnected = true;
  }

  get className() { return this._class; }
  set className(v) { this._class = String(v || ''); this.classList.set = new Set(this._class.split(/\s+/).filter(Boolean)); }

  get children() { return this.childNodes.filter((n) => n instanceof El); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }

  get textContent() {
    if (this.childNodes.length) return this.childNodes.map((c) => c.textContent || '').join('');
    return this._text;
  }
  set textContent(v) { this.childNodes = []; this._text = String(v == null ? '' : v); }

  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v == null ? '' : v); this.childNodes = []; }

  append(...nodes) { for (const n of nodes) this._append(n); }
  appendChild(n) { this._append(n); return n; }
  _append(n) {
    if (n === null || n === undefined || n === false) return;
    if (Array.isArray(n)) { for (const x of n) this._append(x); return; }
    if (typeof n === 'string') { const t = new Text(n); t.parentNode = this; this.childNodes.push(t); return; }
    if (n instanceof El) { n.parentNode = this; this.childNodes.push(n); }
  }
  insertBefore(n, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    if (n instanceof El) n.parentNode = this;
    return n;
  }
  insertAdjacentElement(pos, n) {
    if (this.parentNode) this.parentNode.insertBefore(n, pos === 'afterend' ? this.nextSibling : this);
    return n;
  }
  insertAdjacentHTML(pos, html) { this._html += html; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(n) {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    this.parentNode.childNodes[i] = n;
    n.parentNode = this.parentNode;
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'class') this.className = v;
    if (k === 'id') { this.id = String(v); registerId(this); }
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._listeners.get(type) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  dispatchEvent(ev) {
    for (const fn of this._listeners.get(ev.type) || []) fn.call(this, ev);
    return true;
  }
  click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20, right: 100, bottom: 20 }; }
  closest() { return null; }
  matches() { return false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setSelectionRange() {}
  select() {}
}

class Text {
  constructor(t) { this._t = String(t); this.parentNode = null; }
  get textContent() { return this._t; }
}

/** Register id-bearing elements so getElementById() works during boot. */
function registerId(el) {
  if (el.id) globalThis.document._byId.set(String(el.id), el);
}

/* ------------------------------ Document ----------------------------- */

const docListeners = new Map();
const doc = {
  createElement: (t) => new El(t, doc),
  createTextNode: (t) => new Text(t),
  createDocumentFragment: () => new El('fragment', doc),
  querySelector: (sel) => {
    const s = String(sel || '').trim();
    if (s.startsWith('#')) return doc._byId.get(s.slice(1)) || null;
    if (s.startsWith('.')) {
      // enough for `.app`, `.modal-root` style lookups during boot
      for (const el of doc._byId.values()) if (el.classList.contains(s.slice(1))) return el;
      return null;
    }
    return null;
  },
  querySelectorAll: () => [],
  getElementById: (id) => doc._byId.get(String(id)) || null,
  addEventListener: (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  removeEventListener: (type, fn) => {
    const a = docListeners.get(type) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  },
  dispatchEvent: (ev) => { for (const fn of docListeners.get(ev.type) || []) fn(ev); return true; },
  readyState: 'loading',
  hidden: false,
  visibilityState: 'visible',
  title: 'hikctl',
  cookie: '',
  execCommand: () => true,
  _byId: new Map(),
};
// assigned after the literal so the closures above do not hit the TDZ
doc.documentElement = new El('html', doc);
doc.head = new El('head', doc);
doc.body = new El('body', doc);

/* ------------------------------ Globals ------------------------------ */

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i],
  get length() { return store.size; },
};

class EventSourceStub {
  constructor(url) { this.url = url; this.readyState = 1; EventSourceStub.instances.push(this); }
  addEventListener() {} removeEventListener() {} close() { this.readyState = 2; }
}
EventSourceStub.instances = [];
EventSourceStub.CONNECTING = 0;
EventSourceStub.OPEN = 1;
EventSourceStub.CLOSED = 2;

const errors = [];

globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.document = doc;
globalThis.Node = El;
globalThis.Element = El;
globalThis.HTMLElement = El;
globalThis.localStorage = localStorage;
globalThis.sessionStorage = localStorage;
globalThis.EventSource = EventSourceStub;
globalThis.location = {
  href: 'http://127.0.0.1:8787/',
  origin: 'http://127.0.0.1:8787',
  pathname: '/',
  search: '',
  hash: `#/${process.argv[2] || 'devices'}`,   // boot() honours the hash → drives view selection
  reload() {}, assign() {},
};
// Node 24 exposes a read-only `navigator`; override it via defineProperty.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'node-uitest', clipboard: { writeText: async () => {} }, language: 'zh-CN' },
});
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.open = () => ({ closed: false, focus() {} });
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.scrollTo = () => {};
globalThis.DOMParser = class { parseFromString() { return doc; } };
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) };
globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));

// fetch: answer everything with a valid empty payload so boot can proceed
globalThis.fetch = async (url) => {
  const u = String(url);
  let body = {};
  if (u.includes('/api/devices')) body = [];
  else if (u.includes('/api/tasks')) body = [];
  else if (u.includes('/api/health')) body = { ok: true, version: 'uitest', devices: 0, sseClients: 0 };
  else if (u.includes('/api/console/state')) body = { running: true, port: 9099, base: 'http://127.0.0.1:9099/' };
  else if (u.includes('/api/activate/config')) body = { defaultPassword: '1q2w3e4r', minLength: 8, maxLength: 16, minClasses: 2 };
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
};

process.on('unhandledRejection', (e) => errors.push({ kind: 'unhandledRejection', error: e }));
process.on('uncaughtException', (e) => errors.push({ kind: 'uncaughtException', error: e }));

/* ------------------------------- Run --------------------------------- */

const target = pathToFileURL(path.join(ROOT, 'web', 'app.js')).href;

// Pre-register every id declared in index.html, otherwise bindShell() would see
// null for the statically-rendered shell and the test would report a false failure.
{
  const html = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'web', 'index.html'), 'utf8');
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const attrs = m[2] || '';
    const id = /id="([^"]+)"/.exec(attrs);
    if (!id) continue;
    const el = new El(m[1], doc);
    el.id = id[1];
    registerId(el);
    const cls = /class="([^"]+)"/.exec(attrs);
    if (cls) el.className = cls[1];      // needed for `document.querySelector('.app')`
    doc.body.append(el);
  }
}

let bootError = null;
try {
  await import(target);
} catch (e) {
  bootError = e;
}

// The app boots on DOMContentLoaded — fire it like a browser would.
if (!bootError) {
  try {
    doc.readyState = 'interactive';
    doc.dispatchEvent({ type: 'DOMContentLoaded', target: doc });
    doc.readyState = 'complete';
  } catch (e) {
    bootError = e;
  }
}

// let queued microtasks / timers run a little
await new Promise((r) => setTimeout(r, 600));

/* --------------------------- report ---------------------------------- */

// Look for anything the app rendered as a fatal error (showFatal writes into the DOM)
function collectText(node, out = []) {
  if (!node) return out;
  if (node.textContent) out.push(node.textContent);
  for (const c of node.childNodes || []) collectText(c, out);
  return out;
}
const allText = [...collectText(doc.body), ...collectText(doc._byId.get('app') || null)].join(' ');
const fatal = /启动失败|未捕获异常|未处理的 Promise 拒绝|发生错误|出错了/.test(allText);

// The shim registers every index.html element as a sibling under <body>, so count
// the whole document and check the view container explicitly.
function countNodes(n) { let c = 1; for (const k of n.childNodes || []) c += countNodes(k); return c; }
const nodeCount = countNodes(doc.body);
const mainEl = doc._byId.get('main');
const mainNodes = mainEl ? countNodes(mainEl) - 1 : -1;
const renderedText = mainEl ? mainEl.textContent.replace(/\s+/g, ' ').trim() : '';

/* ---- regression: confirmDanger must enable its confirm button immediately ---- */
// Bug history: with typeText/requireCheck/requirePassword removed there was nothing
// to type, and because validate() was never called up-front the 「执行完全恢复」
// button stayed disabled forever.
let confirmCheck = { ran: false, ok: false, detail: '' };
try {
  const ui = await import(pathToFileURL(path.join(ROOT, 'web', 'ui.js')).href);
  const pending = ui.confirmDanger({ title: '自检', confirmLabel: '执行完全恢复', note: '自检用' });
  await new Promise((r) => setTimeout(r, 30));
  const foot = doc._byId.get('modalFoot');
  const btns = foot ? foot.childNodes.filter((n) => n instanceof El && n.tagName === 'BUTTON') : [];
  const confirmBtn = btns[btns.length - 1];
  const cancelBtn = btns[0];
  confirmCheck.ran = !!confirmBtn;
  confirmCheck.ok = !!confirmBtn && confirmBtn.disabled === false;
  confirmCheck.detail = confirmBtn
    ? `按钮「${confirmBtn.textContent}」disabled=${confirmBtn.disabled}`
    : '未找到确认按钮';
  if (cancelBtn) cancelBtn.click();
  await pending.catch(() => {});
} catch (e) {
  confirmCheck = { ran: false, ok: false, detail: `自检异常: ${e.message}` };
}

console.log('════════ UI 运行时自检 ════════');
console.log(`目标视图: ${process.argv[2] || 'devices'}`);
if (bootError) {
  console.log('\n❌ 模块求值/boot 抛错（这会让整页失去交互）:');
  console.log(`   ${bootError.name}: ${bootError.message}`);
  console.log((bootError.stack || '').split('\n').slice(1, 6).join('\n'));
} else {
  console.log('\n✅ 模块求值成功');
}
if (errors.length) {
  console.log(`\n❌ 运行时未捕获错误 ${errors.length} 个:`);
  for (const e of errors.slice(0, 5)) {
    console.log(`   [${e.kind}] ${e.error && e.error.name}: ${e.error && e.error.message}`);
    console.log('   ' + String((e.error && e.error.stack) || '').split('\n').slice(1, 4).join('\n   '));
  }
} else {
  console.log('✅ 无未捕获的运行时错误');
}
console.log(`\nDOM 节点总数    : ${nodeCount}`);
console.log(`#main 子节点    : ${mainNodes}${mainNodes > 5 ? '  ✅ 视图已渲染' : '  ❌ 视图为空'}`);
console.log(`#main 文本内容  : ${renderedText ? renderedText.slice(0, 160) : '(空)'}`);
console.log(`EventSource     : ${EventSourceStub.instances.length} 个${EventSourceStub.instances.length >= 1 ? '  ✅ 事件流已建立' : '  ❌ 未建立'}`);
console.log(`确认框可点击    : ${confirmCheck.ok ? '✅' : '❌'}  ${confirmCheck.detail}`);
if (fatal) {
  console.log('\n❌ 界面渲染了致命错误提示（这就是你看到的现象）:');
  console.log('   ' + allText.replace(/\s+/g, ' ').slice(0, 600));
}
process.exit(bootError || errors.length || fatal || mainNodes <= 5 || !confirmCheck.ok ? 1 : 0);