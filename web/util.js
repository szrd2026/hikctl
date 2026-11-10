// util.js — 无依赖工具：DOM、格式化、剪贴板、偏好持久化

/** 创建元素：el('div.card', {id:'x'}, [children|string]) */
export function el(spec, attrs, children) {
  const [tagPart, ...classes] = String(spec).split('.');
  const node = document.createElement(tagPart || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = node.className ? node.className + ' ' + v : String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') node[k] = !!v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  if (children === null || children === undefined || children === false) return node;
  if (Array.isArray(children)) { for (const c of children) append(node, c); return node; }
  node.append(children instanceof Node ? children : document.createTextNode(String(children)));
  return node;
}

export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

// ---------- 时间/文本 ----------
export function fmtTime(ts, withDate = true) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withDate ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}` : t;
}

export function fmtDur(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** 本地时间 → datetime-local 值 */
export function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function truncMid(s, head = 10, tail = 6) {
  const str = String(s ?? '');
  if (str.length <= head + tail + 1) return str;
  return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

export function errText(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message || err.code || '未知错误';
}

/** 从 device id "ip:port" 解析 */
export function splitId(id) {
  const s = String(id ?? '');
  const i = s.lastIndexOf(':');
  if (i < 0) return { ip: s, port: 80 };
  const port = Number(s.slice(i + 1));
  return { ip: s.slice(0, i), port: Number.isFinite(port) && port > 0 ? port : 80 };
}
export const ipOf = (id) => splitId(id).ip;

/** 粗校验 IPv4 */
export function isIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s ?? '').trim());
  if (!m) return false;
  return m.slice(1).every((x) => Number(x) >= 0 && Number(x) <= 255);
}
export function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

// ---------- 剪贴板（http 本地源需要 execCommand 兜底） ----------
let fallbackTA = null;
export async function copyText(text) {
  const s = String(text ?? '');
  if (!s) throw new Error('没有可复制的内容');
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(s); return true; } catch { /* 落到兜底 */ }
  }
  try {
    if (!fallbackTA) {
      fallbackTA = el('textarea', { readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
      fallbackTA.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;height:1px;width:1px';
      document.body.append(fallbackTA);
    }
    fallbackTA.value = s;
    fallbackTA.select();
    fallbackTA.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('复制被浏览器拒绝');
    return true;
  } catch (e) {
    throw new Error(`复制失败：${errText(e)}`);
  }
}

// ---------- localStorage 偏好 ----------
const PREF_KEY = 'hikctl.prefs.v1';
let prefs = { sortKey: 'ip', sortDir: 'asc', sidebarCollapsed: false, tab: 'overview', taskbarHidden: false };
try {
  const raw = localStorage.getItem(PREF_KEY);
  if (raw) prefs = Object.assign(prefs, JSON.parse(raw));
} catch { /* 忽略损坏的偏好 */ }

export function getPref(k, dflt) { return prefs[k] === undefined ? dflt : prefs[k]; }
export function setPref(k, v) {
  prefs[k] = v;
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 隐私模式 */ }
}

// ---------- 其它 ----------
export function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
export function debounce(fn, ms = 160) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function uid(p = 'x') { return `${p}${Math.random().toString(36).slice(2, 9)}`; }

/** 触发浏览器下载（报表用） */
export function downloadUrl(url) {
  const a = el('a', { href: url, download: '' });
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  setTimeout(() => a.remove(), 0);
}
