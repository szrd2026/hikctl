// app.js — hikctl 控制台入口：视图、SSE 路由、设备详情抽屉、模态流程。
import {
  el, append, clear, $, $$, fmtTime, fmtDur, truncMid, ipOf, isIPv4, ipToInt,
  copyText, getPref, setPref, debounce, errText, toLocalInput, downloadUrl, clamp,
} from './util.js';
import { api, ApiError, absUrl } from './api.js';
import {
  toast, toastOk, toastErr, toastWarn, toastInfo, openModal, confirmDanger, dropdown,
  emptyState, meter, statusDot, statusBadge, copyable, field, anyModalOpen,
} from './ui.js';

// 状态
const S = {
  devices: new Map(),        // id -> device
  selected: new Set(),       // 选中的设备 id
  tasks: new Map(),          // taskId -> 任务记录
  scan: null,                // 当前 IP 段扫描
  scanForm: { from: '192.168.1.1', to: '192.168.1.254', username: 'admin', password: '', timeout: 800, concurrency: getPref('scanConcurrency', 64) },
  sadp: { rows: [], elapsedMs: 0, searched: false, sel: new Set() },  // sel: 勾选的 "ip:port"
  scanSel: new Set(),        // IP 段扫描结果中被勾选的 "ip:port"
  activateCfg: null,         // GET /api/activate/config 的缓存 { cfg, at }
  health: null,
  report: null,              // 最近一次报表结果
  console: null,             // GET /api/console/state 的缓存
  consoleDevice: getPref('consoleDevice', ''),   // 「WEB 后台」视图选中的设备
  filter: '',
  view: getPref('view', 'devices'),
  sortKey: getPref('sortKey', 'ip'),
  sortDir: getPref('sortDir', 'asc'),
  drawerId: null,
  tab: getPref('tab', 'overview'),
  snapshotTimer: 0,
  previewing: false,
  render: 0,
};

const VIEWS = [
  { key: 'devices', label: '设备列表' },
  { key: 'console', label: 'WEB 后台' },
  { key: 'discover', label: '发现设备' },
  { key: 'tasks', label: '批量任务' },
  { key: 'report', label: '报表' },
];
/* 紧凑 DOM 助手：与 el(...) 完全等价，仅用于压缩样板字节 */
const hbtn = (text, onclick, cls, extra) => el('button', { type: 'button', class: cls || 'btn', text, onclick, ...(extra || {}) });
const hnote = (kind, text) => el('div.note.note-' + kind, { text });
const hnotes = (kind, kids) => el('div.note.note-' + kind, null, kids);
const htd = (kids, cls) => el('td', cls ? { class: cls } : null, kids);
const hth = (text) => el('th.nosort', { text });
const hopt = (value, text, selected) => el('option', { value, text, selected });
const hbdg = (text, cls) => el('span.badge', { class: cls, text });
const hcard = (kids) => el('div.card', null, kids);
const hbody = (kids) => el('div.card-body', null, kids);
const hbodyT = (kids, attrs) => el('div.card-body.tight', attrs || null, kids);
const hgrid = (kids) => el('div.form-grid', null, kids);
const hkv = (kids) => el('dl.kv', null, kids);
const hlog = (kids, attrs) => el('div.log', attrs || null, kids);
const hsub = (text) => el('span.sub', { text });
const hsec = (text) => el('div.section-title', { text });
const hrow = (kids) => el('div.btn-row', null, kids);
const htx = (spec, text) => el(spec, { text });
const hdiv = (kids) => el('div', null, kids);
const hinp = (attrs) => el('input.inp', attrs);
const hinpm = (attrs) => el('input.inp.mono-inp', attrs);
const hspin = () => el('span.spin');
const htext = (s) => document.createTextNode(s);
const MT = { marginTop: '10px' };
const STIF = { style: { display: 'contents' } };

/* ==================== 发现页结果的勾选与激活状态（API.md §3 / §3.5） ==================== */
const dkey = (ip, port) => `${ip}:${Number(port) || 80}`;
const yn = (v) => (v === true ? '是' : v === false ? '否' : '未知');

/** 「激活状态」徽标：未激活用醒目琥珀色，已激活用绿色 */
function actBadge(a) {
  if (a === true) return hbdg('已激活', 'badge-ok');
  if (a === false) return hbdg('未激活', 'badge-warn badge-na');
  return htx('span.muted', '未知');
}

/** 未激活设备：能被发现，但登录 ISAPI 会失败 */
function notActivated(st) {
  if (!st) return false;
  if (st.activated === false) return true;
  return /未激活|notActivated|not[_ ]?activated/i.test(String(st.error || ''));
}

/** 发现页的「萤石云」列（无需登录，SADP 应答里就有，API.md §3 注） */
function bindCell(r) {
  const s = String(r.ezvizBindStatus ?? '');
  const extra = [];
  if (r.supportEzvizUnbind !== undefined) extra.push(`支持解绑=${yn(r.supportEzvizUnbind)}`);
  if (r.hcPlatformEnable !== undefined) extra.push(`海康云平台=${yn(r.hcPlatformEnable)}`);
  const title = `萤石云绑定：${s === '1' ? '已绑定' : s === '0' ? '未绑定' : '设备未上报'}${extra.length ? ` ｜ ${extra.join(' ')}` : ''}`;
  const i = s === '1' ? { text: '已绑定', dot: 'dot-warn' } : s === '0' ? { text: '未绑定', dot: 'dot-idle', muted: 1 } : { text: '未知', dot: 'dot-idle', muted: 1 };
  return el('span.ez-cell', { title }, [el('span.dot', { class: `dot ${i.dot}` }), el('span', { class: i.muted ? 'muted' : '', text: i.text })]);
}

/* ---------- 萤石云状态（API.md §3.4，随设备探测一起返回） ---------- */
const EZ_FIELDS = [['supported', '支持'], ['enabled', '服务开启'], ['bound', '绑定'], ['streamEncrypteEnabled', '视频加密'], ['supportUnbind', '支持解绑']];
/** 绑定状态：布尔优先，其次原始 bindStatus（"1"=已绑定，"0"=未绑定） */
function ezBindText(ez) {
  if (!ez) return '未知';
  if (ez.bound === true) return '已绑定';
  if (ez.bound === false) return '未绑定';
  const s = String(ez.bindStatus ?? '');
  return s === '1' ? '已绑定' : s === '0' ? '未绑定' : '未知';
}
function ezvizTitle(ez) {
  if (!ez || typeof ez !== 'object') return '设备未返回萤石云状态（status.ezviz 为空）';
  const parts = EZ_FIELDS.map(([k, label]) => `${label}=${k === 'bound' ? ezBindText(ez) : yn(ez[k])}`);
  return `萤石云：${parts.join(' ')}${ez.verificationCode ? ` ｜ 验证码=${ez.verificationCode}` : ''}${ez.error ? ` ｜ error=${ez.error}` : ''}`;
}
/** 设备列表「萤石云」列的紧凑呈现：彩色圆点 + 短文本，细节进 title */
function ezvizInfo(st) {
  const ez = st && st.ezviz;
  const title = ezvizTitle(ez);
  if (!ez || typeof ez !== 'object') return { text: '—', dot: 'dot-idle', muted: 1, title };
  if (st.online === false) return { text: '—', dot: 'dot-idle', muted: 1, title: `${title}（设备离线）` };
  if (ez.supported === false) return { text: '不支持', dot: 'dot-idle', muted: 1, title };
  if (ez.enabled === true && ez.bound === true) return { text: '已开启 · 已绑定', dot: 'dot-warn', title };
  if (ez.enabled === true) return { text: '已开启 · 未绑定', dot: 'dot-busy', title };
  if (ez.enabled === false) return { text: '未开启', dot: 'dot-idle', muted: 1, title };
  if (String(ez.bindStatus || '') === '1') return { text: '已开启 · 已绑定', dot: 'dot-warn', title };
  return { text: '—', dot: 'dot-idle', muted: 1, title };
}
/** 排序等级：未知 < 不支持 < 未开启 < 已开启未绑定 < 已开启已绑定 */
function ezvizRank(st) {
  const ez = st && st.ezviz;
  if (!ez || typeof ez !== 'object') return -1;
  if (ez.support === false || ez.supported === false) return 0;
  if (ez.enabled === false) return 1;
  if (ez.enabled === true) return ez.bound === true ? 3 : 2;
  return String(ez.bindStatus || '') === '1' ? 3 : -1;
}
const ezvizCell = (d) => {
  const st = (d && d.status) || {};
  const i = ezvizInfo(st);
  return el('span.ez-cell', { title: i.title }, [el('span.dot', { class: `dot ${i.dot}` }), el('span', { class: i.muted ? 'muted' : '', text: i.text })]);
};

/* ==================== 设备激活（API.md §3.5） ==================== */
let actDlg = null;   // 当前激活对话框 + 它正在跟踪的任务：{ taskId, modal, panel, total }
const ACT_FALLBACK = { minLength: 8, maxLength: 16, minClasses: 2, defaultConcurrency: 8 };
const ACT_CFG_TTL = 120000;

const ruleText = (c) => `密码需 ${c.minLength}–${c.maxLength} 位，至少 ${c.minClasses} 类字符（大写 / 小写 / 数字 / 符号）。`;

/** 本地预校验：不合法就不发请求，避免把设备改到一半 */
function pwError(pw, cfg) {
  const min = Number(cfg.minLength) || 8, max = Number(cfg.maxLength) || 16, need = Number(cfg.minClasses) || 2;
  if (!pw) return '请输入密码';
  if (pw.length < min) return `密码长度至少 ${min} 位（当前 ${pw.length} 位）`;
  if (pw.length > max) return `密码长度最多 ${max} 位（当前 ${pw.length} 位）`;
  const n = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (n < need) return `至少需要 ${need} 类字符（大写 / 小写 / 数字 / 符号），当前只有 ${n} 类`;
  return '';
}

/** 激活成功后把发现页里对应行标记为已激活，并把它从勾选集合里摘掉 */
function markActivated(ip, port) {
  const key = dkey(ip, port);
  const hit = (r) => r.ip === ip && (Number(r.httpPort ?? r.port ?? 80) === (Number(port) || 80));
  if (S.sadp.rows.some(hit)) for (const r of S.sadp.rows) if (hit(r)) r.activated = true;
  if (S.scan && S.scan.rows.get(ip)) S.scan.rows.get(ip).activated = true;
  S.sadp.sel.delete(key);
  S.scanSel.delete(key);
  if (S.view === 'discover') { try { renderSadpTable(); renderScanResults(); } catch { /* 渲染失败不影响激活结果 */ } }
}

/** 按钮忙碌态：禁用 + 转圈 + 文案，结束后自动恢复 */
async function busy(btn, label, fn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '';
  btn.append(hspin(), htext(' ' + label));
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = orig; }
}

const TAB_KEYS = ['overview', 'network', 'time', 'password', 'maintain', 'upgrade'];

const devList = () => Array.from(S.devices.values());
const dev = (id) => S.devices.get(id);
const selList = () => Array.from(S.selected).filter((id) => S.devices.has(id));

// 渲染调度：脏标记 + rAF 合并，避免每次事件都重建整棵 DOM
const dirty = { view: true, taskbar: true, chrome: true, drawerHead: true, drawer: false, cards: false };
let rafId = 0;

/** scheduleRender() → 全部重绘；scheduleRender('view','drawer') → 只重绘指定部分 */
function scheduleRender(...keys) {
  const list = keys.length === 1 && Array.isArray(keys[0]) ? keys[0] : keys;
  for (const k of (list.length ? list : Object.keys(dirty))) dirty[k] = true;
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; reconcile(); });
}

function reconcile() {
  S.render++;
  try {
    if (dirty.view) {
      // 先构建、成功后再替换 —— 渲染抛错时 <main> 不会被清空
      let node = null;
      try {
        node = renderView();
      } catch (e) {
        showFatal('主视图', e);
      }
      if (node) {
        clear($('#main')).append(node);
        try { bindDeviceTable(); } catch (e) { showFatal('表格绑定', e); }
        if (S.view === 'discover') {
          queueMicrotask(() => {
            try { renderScanStatus($('#scanStat'), $('#scanBar')); renderScanResults(); }
            catch (e) { showFatal('扫描面板', e); }
          });
        } else if (S.view === 'tasks') {
          // 任务卡：先用内存里的任务立即渲染，再从服务端同步一次
          try { renderTaskCards(); } catch (e) { showFatal('任务列表', e); }
          loadTasks(false);
        }
      }
      dirty.chrome = true;
      dirty.drawerHead = true;
    } else if (dirty.cards) {
      renderTaskCards();
    }
    if (dirty.taskbar) { renderTaskbar(); dirty.chrome = true; }
    if (dirty.chrome) renderChrome();
    if (dirty.drawerHead) renderDrawerHead();
    if (dirty.drawer) renderDrawerBody();
  } catch (e) {
    showFatal('界面更新', e);
  }
  for (const k of Object.keys(dirty)) dirty[k] = false;
}

/** 任何渲染/启动异常都变成可见横幅，绝不留下空白页面 */
function showFatal(where, e) {
  const detail = (e && (e.stack || e.message)) || String(e);
  try {
    const main = $('#main');
    if (main) {
      clear(main).append(el('section.view', null, [
        el('div.view-head', null, htx('h1', '界面错误')),
        hnotes('danger', [
          htx('b', `渲染失败（${where}）`),
          el('div.mono', { style: { marginTop: '6px', whiteSpace: 'pre-wrap' }, text: String(detail).slice(0, 1200) }),
          el('div', { style: { marginTop: '6px' }, text: '请把这段信息反馈给开发者；服务端接口本身可能仍然正常。' }),
        ]),
        hrow(hbtn('重新加载界面', () => location.reload(), 'button btn')),
      ]));
    }
  } catch { /* 兜底路径自身也不允许再抛 */ }
  try { toastErr(String(detail).slice(0, 220), { title: `渲染失败（${where}）`, timeout: 0 }); } catch { /* ignore */ }
  try { console.error(`[hikctl] render failure in ${where}`, e); } catch { /* ignore */ }
}

function renderChrome() {
  const all = devList();
  const online = all.filter((d) => d.status && d.status.online === true).length;
  $('#statTotal').textContent = String(all.length);
  $('#statOnline').textContent = String(online);
  $('#statOffline').textContent = String(all.filter((d) => d.status && d.status.online === false).length);
  $('#navBadgeDevices').textContent = all.length ? String(all.length) : '';
  const active = Array.from(S.tasks.values()).filter((t) => t.state === 'running').length;
  $('#navBadgeTasks').textContent = active ? String(active) : '';
  for (const btn of $$('.nav-item')) {
    const on = btn.dataset.view === S.view;
    if (on) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  }
  $('#btnRefresh').classList.toggle('btn-ghost', false);
}

function renderView() {
  switch (S.view) {
    case 'console': return viewConsole();
    case 'discover': return viewDiscover();
    case 'tasks': return viewTasks();
    case 'report': return viewReport();
    default: return viewDevices();
  }
}

/* ---------- 视图：WEB 后台（海康原始网页操作界面，内嵌） ---------- */
/**
 * 把海康交付助手那套「原始网页操作界面」直接嵌进本程序：
 * 本机 9099 端口托管离线配置包，iframe 里就是原汁原味的设备配置页，
 * 包内发出的 /DISPATCH_ip_* 请求由 hikctl 反向代理回设备（带鉴权）。
 */
function viewConsole() {
  const st = S.console || {};
  const devices = devList();
  const host = el('div.console-view');
  const frameHost = el('div.console-frame');
  const bar = el('div.console-bar');

  const cur = S.consoleDevice && devices.some((d) => d.id === S.consoleDevice)
    ? S.consoleDevice
    : (devices[0] ? devices[0].id : '');

  const sel = el('select.inp.console-pick', {
    'aria-label': '选择设备',
    onchange: (e) => { S.consoleDevice = e.target.value; setPref('consoleDevice', S.consoleDevice); render(); },
  }, devices.map((d) => el('option', {
    value: d.id,
    selected: d.id === cur,
    text: `${d.label || d.ip}  ·  ${d.id}${d.status && d.status.model ? '  ·  ' + d.status.model : ''}`,
  })));

  const mkUrl = (id) => `${st.base || 'http://127.0.0.1:9099/'}open?device=${encodeURIComponent(id)}`;

  function render() {
    clear(bar);
    bar.append(
      htx('span.lbl', '设备'),
      sel,
      hbtn('↻ 重新载入', () => load(), 'button btn btn-sm'),
      hbtn('↗ 在新标签页打开', () => {
        if (!cur) return;
        const w = window.open(mkUrl(cur), '_blank', 'noopener');
        if (!w) toastWarn(`浏览器拦截了新窗口，请手动打开：${mkUrl(cur)}`, { title: 'WEB 后台' });
      }, 'button btn btn-sm'),
      hbtn('⌂ 后台首页', () => window.open(st.base || 'http://127.0.0.1:9099/', '_blank', 'noopener'), 'button btn btn-sm'),
    );

    clear(frameHost);
    if (!st.running) {
      frameHost.append(hnotes('warn', [
        htx('b', '设备后台服务未启动'),
        el('div.sub', { style: MT, text: st.error || '启动时若带了 --no-console 会关闭它；否则请检查离线配置包目录。' }),
        el('div.sub', { style: MT, text: '启动参数：--console-port <端口>（默认 9099）、--packages <目录> 指定离线配置包。' }),
      ]));
      return;
    }
    if (!devices.length) {
      frameHost.append(emptyState('还没有设备。先在「发现设备」里扫描并激活，或手工添加设备。', '▤'));
      return;
    }
    if (!cur) return;
    const d = dev(cur);
    frameHost.append(hnotes('info', [
      htx('b', `正在打开 ${d ? (d.label || d.ip) : cur} 的设备后台`),
      el('div.sub', { style: { marginTop: '4px' }, text: '离线配置包由本机提供，包内的 ISAPI 请求经 hikctl 代理回设备（自动鉴权）。首次加载需数秒。' }),
    ]));
    const iframe = el('iframe.console-iframe', {
      src: mkUrl(cur),
      title: `${cur} 设备后台`,
      referrerpolicy: 'no-referrer',
    });
    frameHost.append(iframe);
  }

  function load() {
    S.console = null;
    api.consoleState().then((s) => { S.console = s; render(); })
      .catch((e) => { toastErr(errText(e), { title: '获取后台服务状态失败' }); });
  }

  host.append(
    hsec('WEB 后台'),
    hnotes('info', [
      htx('b', '这是海康原始的网页操作界面（离线配置包），由本机托管并反向代理到设备。'),
      el('div.sub', { style: { marginTop: '4px' }, text: '没有内置网页的摄像头也能用；包内的 /ISAPI/* 请求由 hikctl 带凭据转发，不会弹 HTTP 认证框。' }),
    ]),
    bar,
    frameHost,
  );

  if (!S.console) load(); else render();
  return host;
}

// 视图：设备列表
function filteredDevices() {
  const q = S.filter.trim().toLowerCase();
  const rows = devList().filter((d) => {
    if (!q) return true;
    const st = d.status || {};
    return [d.label, d.ip, `${d.ip}:${d.port}`, d.id, d.group, st.model, st.serialNumber, st.deviceName, st.firmwareVersion]
      .some((v) => String(v ?? '').toLowerCase().includes(q));
  });
  const dir = S.sortDir === 'asc' ? 1 : -1;
  const key = S.sortKey;
  const val = (d) => {
    const st = d.status || {};
    switch (key) {
      case 'status': return st.online === true ? 1 : st.online === false ? -1 : 0;
      case 'label': return (d.label || '').toLowerCase();
      case 'ip': return ipToInt(d.ip || '0.0.0.0') * 1000 + (Number(d.port) || 0);
      case 'model': return String(st.model || '').toLowerCase();
      case 'serial': return String(st.serialNumber || '').toLowerCase();
      case 'firmware': return String(st.firmwareVersion || '').toLowerCase();
      case 'latency': return st.latencyMs === null || st.latencyMs === undefined ? Number.MAX_SAFE_INTEGER : st.latencyMs;
      case 'ezviz': return ezvizRank(st);
      default: return 0;
    }
  };
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === y) return String(a.id).localeCompare(String(b.id));
    return (x < y ? -1 : 1) * dir;
  });
  return rows;
}

function th(key, label, opts = {}) {
  const sortable = opts.sortable !== false;
  const active = sortable && S.sortKey === key;
  const attrs = {
    class: [opts.num ? 'num' : '', sortable ? '' : 'nosort'].filter(Boolean).join(' '),
    scope: 'col',
    'aria-sort': active ? (S.sortDir === 'asc' ? 'ascending' : 'descending') : (sortable ? 'none' : undefined),
  };
  if (sortable) {
    attrs.tabindex = '0';
    attrs.title = '点击排序';
    const doSort = () => { S.sortKey = key; S.sortDir = active && S.sortDir === 'asc' ? 'desc' : 'asc'; setPref('sortKey', S.sortKey); setPref('sortDir', S.sortDir); scheduleRender('view', 'chrome'); };
    attrs.onclick = doSort;
    attrs.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(); } };
  }
  return el('th', attrs, [label, active ? htx('span.arrow', S.sortDir === 'asc' ? '▲' : '▼') : null]);
}

function deviceTable(rows) {
  const head = el('tr', null, [
    el('th.nosort', { scope: 'col', style: { width: '30px' } },
      el('input', { type: 'checkbox', 'aria-label': '全选', checked: rows.length > 0 && rows.every((d) => S.selected.has(d.id)), onchange: (e) => { for (const d of rows) { if (e.target.checked) S.selected.add(d.id); else S.selected.delete(d.id); } scheduleRender('view', 'chrome'); } })),
    th('status', '状态'), th('label', '标签'), th('ip', '地址'), th('model', '型号'),
    th('serial', '序列号'), th('firmware', '固件'), th('latency', '延迟', { num: true }),
    th('ezviz', '萤石云'),
    el('th.nosort', { scope: 'col', style: { width: '112px' }, text: '操作' }),
  ]);
  const tbody = el('tbody', { id: 'devRows' });
  if (!rows.length) {
    const isFilter = !!S.filter.trim();
    tbody.append(el('tr', null, el('td', { colspan: '10' },
      emptyState(isFilter ? `没有匹配「${S.filter}」的设备，换个关键词试试` : '还没有设备，点“发现设备”扫描局域网，或用“添加设备”手工录入。', isFilter ? '⌕' : '▤'))));
  } else {
    for (const d of rows) tbody.append(deviceRow(d));
  }
  return el('table.grid', { id: 'devTable' }, [el('thead', null, head), tbody]);
}

function deviceRow(d) {
  const st = d.status || {};
  const lat = st.latencyMs === null || st.latencyMs === undefined ? '—' : st.latencyMs;
  const latCls = lat === '—' ? 'muted' : lat > 300 ? 'warn' : '';
  const tr = el('tr', {
    tabindex: '0',
    class: [S.selected.has(d.id) ? 'sel' : '', S.drawerId === d.id ? 'active' : ''].filter(Boolean).join(' '),
    dataset: { id: d.id, action: 'open' },
    'aria-label': `${d.label || d.ip} 详情`,
  }, [
    htd(el('input', { type: 'checkbox', checked: S.selected.has(d.id), 'aria-label': `选择 ${d.ip}`, dataset: { action: 'toggle' } })),
    htd(statusCell(d)),
    htd(el('span.ellipsis', { text: d.label || '—', title: d.label || '', style: { maxWidth: '150px' } })),
    htd([copyable(d.id, { class: 'cell-ip', display: d.id, title: `${d.id}（点击复制）` }), d.https ? el('span.badge', { text: 'https', style: { marginLeft: '5px' } }) : null]),
    htd(el('span.ellipsis', { text: st.model || '—', title: st.model || '', style: { maxWidth: '168px' } })),
    htd(copyable(st.serialNumber, { class: 'cell-trunc sm', display: st.serialNumber ? truncMid(st.serialNumber, 12, 5) : '—', title: st.serialNumber || '无序列号' })),
    htd(el('span.ellipsis muted', { text: st.firmwareVersion || '—', title: st.firmwareVersion || '', style: { maxWidth: '138px' } })),
    htd(String(lat), 'num' + ' ' + latCls),
    htd(ezvizCell(d)),
    htd(el('div.row-actions', null, [
      el('button.icon-btn', { type: 'button', title: '探测', text: '⟳', dataset: { action: 'probe' }, 'aria-label': `探测 ${d.ip}` }),
      el('button.icon-btn', { type: 'button', title: '编辑', text: '✎', dataset: { action: 'edit' }, 'aria-label': `编辑 ${d.ip}` }),
      el('button.icon-btn', { type: 'button', title: '详情', text: 'ⓘ', dataset: { action: 'open' }, 'aria-label': `详情 ${d.ip}` }),
      el('button.icon-btn', { type: 'button', title: '删除', text: '🗑', dataset: { action: 'del' }, 'aria-label': `删除 ${d.ip}` }),
    ])),
  ]);
  return tr;
}

/** 「状态」单元格：在线点 + 文本，未激活时额外挂一个醒目的琥珀色徽标 */
function statusCell(d) {
  const st = d.status || {};
  return [
    statusDot(st.online),
    el('span', { text: st.online === true ? '在线' : st.online === false ? '离线' : '未知', class: st.online === true ? '' : 'muted' }),
    notActivated(st) ? el('span.badge.badge-warn.badge-na', {
      text: '未激活', style: { marginLeft: '5px' },
      title: `未激活的设备无法登录 ISAPI（能被发现，但探测会失败）。${st.error ? `\n${st.error}` : ''}\n请到「发现设备」页勾选它并点「激活」。`,
    }) : null,
  ];
}

function viewDevices() {
  const rows = filteredDevices();
  const sel = selList().length;
  const searchInp = hinp({ id: 'devSearch', type: 'search', placeholder: '搜索 标签 / IP / 型号 / 序列号', value: S.filter, 'aria-label': '搜索设备' });
  searchInp.addEventListener('input', debounce(() => {
    S.filter = searchInp.value;
    scheduleRender('view');
    const n = $('#devSearch');
    if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  }, 160));

  const bulk = dropdown({
    label: `批量操作${sel ? ` (${sel})` : ''}`,
    btnId: 'bulkBtn',
    items: [
      { header: sel ? `已选 ${sel} 台` : '请先勾选设备' },
      { key: 'probe', label: '探测所选', onPick: () => bulkRun('probe') },
      { key: 'setTime', label: '对时（电脑时间）', onPick: () => bulkSetTime() },
      { key: 'reboot', label: '重启所选', danger: true, onPick: () => bulkRun('reboot') },
      { key: 'reset-basic', label: '简单恢复', danger: true, onPick: () => bulkReset('basic') },
      { key: 'reset-full', label: '完全恢复', danger: true, onPick: () => bulkReset('full') },
      { sep: true },
      { key: 'setNetwork', label: '批量改网络…', onPick: () => bulkNetwork() },
      { key: 'setPassword', label: '批量改密码…', onPick: () => bulkPassword() },
      { key: 'upgrade', label: '批量升级…', onPick: () => bulkUpgrade() },
      { sep: true },
      { key: 'report', label: '生成报表', onPick: () => { setView('report'); } },
    ],
  });
  const bulkBtn = $('#bulkBtn', bulk.root);
  if (bulkBtn) bulkBtn.disabled = !sel;

  const toolbar = el('div.toolbar', null, [
    el('div.search-wrap', null, [el('span.search-ico', { text: '⌕', 'aria-hidden': 'true' }), searchInp]),
    el('div.right', null, [
      sel ? hsub(`已选 ${sel} 台`) : null,
      hbtn('＋ 添加设备', openAddDevice, 'button btn btn-primary'),
      hbtn('导入', openImport, 'button btn'),
      hbtn('探测全部', probeAll, 'button btn', { id: 'btnProbeAll' }),
      hbtn('删除所选', deleteSelected, 'button btn btn-danger', { disabled: !sel }),
      bulk.root,
    ]),
  ]);

  return el('section.view', null, [
    el('div.view-head', null, [
      htx('h1', '设备列表'),
      htx('span.hint', `共 ${devList().length} 台 · 显示 ${rows.length} 台`),
    ]),
    hcard([toolbar, hbodyT(el('div.table-wrap', null, deviceTable(rows)))]),
  ]);
}

/* ---------- 设备表格事件（委托） ---------- */
function bindDeviceTable() {
  const table = $('#devTable');
  if (!table) return;
  table.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-action]');
    if (!hit) return;
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    const action = hit.dataset.action;
    if (action === 'toggle') { if (hit.checked) S.selected.add(id); else S.selected.delete(id); scheduleRender('view', 'chrome'); return; }
    if (hit.matches('button,input,a')) e.stopPropagation();
    if (action === 'open') openDrawer(id);
    else if (action === 'probe') probeOne(id, hit);
    else if (action === 'edit') openEditDevice(id);
    else if (action === 'del') deleteOne(id);
  });
  table.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.matches('input,button,a,span[role="button"]')) return;
    const row = e.target.closest('tr[data-id]');
    if (row) { e.preventDefault(); openDrawer(row.dataset.id); }
  });
}

// 视图：发现设备
function viewDiscover() {
  return el('section.view', null, [
    el('div.view-head', null, [htx('h1', '发现设备'), htx('span.hint', 'SADP 广播发现（同网段）与 IP 段并发扫描（跨网段/已知密码）')]),
    el('div.panes', null, [sadpPane(), scanPane()]),
  ]);
}

function sadpPane() {
  const timeoutSel = el('select.sel', { style: { width: '92px' }, 'aria-label': 'SADP 搜索时长' },
    [1000, 3000, 5000, 10000].map((v) => hopt(String(v), `${v / 1000} 秒`, v === 3000)));
  const state = hsub(S.sadp.searched ? `上次搜索到 ${S.sadp.rows.length} 台，用时 ${fmtDur(S.sadp.elapsedMs)}` : '未搜索');
  const btn = el('button.btn.btn-primary', { type: 'button', text: '开始搜索' });
  // 批量激活：仅对勾选结果生效，未勾选时禁用
  const actBtn = el('button.btn', { type: 'button', id: 'sadpActBtn', text: '批量激活', disabled: true, title: '先勾选结果中的未激活设备，再点这里批量激活' });
  actBtn.addEventListener('click', () => activateSelected(S.sadp.rows.filter((r) => S.sadp.sel.has(dkey(r.ip, r.httpPort || 80))).map((r) => ({ ip: r.ip, port: r.httpPort || 80 }))));
  const body = el('div.card-body.tight');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '';
    btn.append(hspin(), document.createTextNode(' 搜索中…'));
    state.textContent = '正在监听 SADP 广播响应…';
    try {
      const res = await api.sadp(Number(timeoutSel.value));
      S.sadp.rows = res.found || [];
      S.sadp.sel.clear();
      S.sadp.elapsedMs = res.elapsedMs || 0;
      S.sadp.searched = true;
      state.textContent = `搜索到 ${S.sadp.rows.length} 台，用时 ${fmtDur(S.sadp.elapsedMs)}`;
      toastOk(`SADP 发现 ${S.sadp.rows.length} 台设备`, { title: '发现完成' });
    } catch (e) {
      state.textContent = '搜索失败';
      toastErr(errText(e), { title: 'SADP 搜索失败' });
    } finally {
      btn.disabled = false;
      btn.textContent = '开始搜索';
      renderSadpTable();
    }
  });

  const pane = hcard([
    el('div.card-head', null, [htx('h2', 'SADP 搜索'), el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [timeoutSel, actBtn, btn])]),
    body,
    el('div.card-head', { style: { borderTop: '1px solid var(--line)', borderBottom: 'none' } }, state),
  ]);
  queueMicrotask(() => { body.append(el('div.table-wrap', { style: { maxHeight: '46vh' } }, el('div', { id: 'sadpHost' }))); renderSadpTable(); });
  return pane;
}

function renderSadpTable() {
  const host = $('#sadpHost');
  if (!host) return;
  clear(host);
  const rows = S.sadp.rows;
  const sel = S.sadp.sel;
  const nsel = rows.filter((r) => sel.has(dkey(r.ip, r.httpPort || 80))).length;
  syncActBar('sadpAll', 'sadpActBtn', nsel, rows.length);
  if (!rows.length) {
    host.append(emptyState(S.sadp.searched ? '没有收到 SADP 响应：确认设备与电脑在同一网段、未被防火墙拦截。' : '点“开始搜索”，通过 SADP 广播发现同网段设备。', '◎'));
    return;
  }
  const allBox = el('input', {
    type: 'checkbox', id: 'sadpAll', 'aria-label': '全选',
    checked: nsel > 0 && nsel === rows.length,
    onchange: (e) => {
      for (const r of rows) { const k = dkey(r.ip, r.httpPort || 80); if (e.target.checked) sel.add(k); else sel.delete(k); }
      for (const cb of $$('input[data-key]', host)) { cb.checked = e.target.checked; cb.closest('tr').classList.toggle('sel', e.target.checked); }
      syncActBar('sadpAll', 'sadpActBtn', e.target.checked ? rows.length : 0, rows.length);
    },
  });
  allBox.indeterminate = nsel > 0 && nsel < rows.length;

  const tbody = el('tbody', null, rows.map((r) => {
    const key = dkey(r.ip, r.httpPort || 80);
    const added = S.devices.has(key);
    const port = r.httpPort || 80;
    return el('tr', { dataset: { ip: r.ip }, class: [added ? 'dim' : '', sel.has(key) ? 'sel' : ''].filter(Boolean).join(' ') }, [
      htd(el('input', {
        type: 'checkbox', checked: sel.has(key), dataset: { key }, 'aria-label': `选择 ${r.ip}`,
        onchange: (e) => {
          if (e.target.checked) sel.add(key); else sel.delete(key);
          e.target.closest('tr').classList.toggle('sel', e.target.checked);
          syncActBar('sadpAll', 'sadpActBtn', rows.filter((x) => sel.has(dkey(x.ip, x.httpPort || 80))).length, rows.length);
        },
      })),
      htd(copyable(r.ip, { class: 'cell-ip', display: r.ip, title: `${r.ip}（点击复制）` })),
      htd(copyable(r.mac, { class: 'cell-trunc sm', display: r.mac || '—', title: r.mac || '' }), 'mono'),
      htd(el('span.ellipsis', { text: r.model || '—', title: r.model || '', style: { maxWidth: '150px' } })),
      htd(copyable(r.serialNumber, { class: 'cell-trunc sm', display: r.serialNumber ? truncMid(r.serialNumber, 10, 4) : '—', title: r.serialNumber || '' })),
      htd(el('span.ellipsis muted', { text: r.firmwareVersion || r.softwareVersion || '—', title: r.firmwareVersion || '', style: { maxWidth: '130px' } })),
      htd(actBadge(r.activated)),
      htd(bindCell(r)),
      htd(String(r.httpPort ?? '—'), 'num'),
      htd(r.gateway || '—', 'mono'),
      htd(el('div.row-act', null, [
        r.activated === true
          ? el('span.muted', { text: '已激活', title: '设备已激活，无需重复激活', style: { fontSize: '11.5px' } })
          : el('button.btn.btn-xs', {
              type: 'button', text: '激活', title: `激活 ${r.ip}：设置管理员密码`,
              onclick: () => activateSelected([{ ip: r.ip, port }]),
            }),
        el('button.btn.btn-xs', {
          type: 'button', text: added ? '已在列表' : '添加', disabled: added,
          onclick: () => openAddDevice({ ip: r.ip, port, label: r.model || '' }),
        }),
      ])),
    ]);
  }));
  host.append(el('table.grid', null, [el('thead', null, el('tr', null, [
    el('th.nosort', { scope: 'col', style: { width: '30px' } }, allBox),
    hth('IP'), hth('MAC'), hth('型号'),
    hth('序列号'), hth('固件'), hth('激活状态'), hth('萤石云'),
    el('th.nosort.num', { text: 'HTTP 端口' }), hth('网关'), hth('操作'),
  ])), tbody]));
}

/** 同步「全选」框与「批量激活 (N)」按钮的可用状态 */
function syncActBar(allId, btnId, n, total) {
  const all = document.getElementById(allId);
  if (all) { all.checked = total > 0 && n === total; all.indeterminate = n > 0 && n < total; }
  const btn = document.getElementById(btnId);
  if (btn) { btn.textContent = n ? `批量激活 (${n})` : '批量激活'; btn.disabled = !n; }
}

/** 行内「激活」/批量「激活」共用同一个对话框与同一条下发路径 */
function activateSelected(targets) {
  if (!targets || !targets.length) { toastWarn('请先勾选要激活的设备', { title: '未选择设备' }); return; }
  openActivateDialog(targets);
}

function scanPane() {
  const sf = S.scanForm;
  const from = hinpm({ value: sf.from, placeholder: '192.168.1.1', 'aria-label': '起始 IP' });
  const to = hinpm({ value: sf.to, placeholder: '192.168.1.254', 'aria-label': '结束 IP' });
  const user = hinp({ value: sf.username, 'aria-label': '用户名' });
  const pass = hinp({ type: 'password', value: sf.password, placeholder: '设备密码', 'aria-label': '密码' });
  // 表单值保存在内存中：后台刷新重建视图时不会丢失用户已经填好的参数（密码不入 localStorage）
  from.addEventListener('input', () => { sf.from = from.value; });
  to.addEventListener('input', () => { sf.to = to.value; });
  user.addEventListener('input', () => { sf.username = user.value; });
  pass.addEventListener('input', () => { sf.password = pass.value; });
  const conc = el('input', { type: 'range', min: '8', max: '128', step: '8', value: String(sf.concurrency), 'aria-label': '并发数' });
  const concOut = el('output', { text: String(conc.value) });
  conc.addEventListener('input', () => { concOut.textContent = conc.value; sf.concurrency = Number(conc.value); setPref('scanConcurrency', Number(conc.value)); });
  const toSel = el('select.sel', null, [400, 800, 1500, 3000].map((v) => hopt(String(v), `${v} ms`, v === sf.timeout)));
  toSel.addEventListener('change', () => { sf.timeout = Number(toSel.value); });

  const stat = el('div.stat-row', { id: 'scanStat' });
  const barHost = el('div', { id: 'scanBar', style: { flex: '1', minWidth: '160px' } });
  const btn = el('button.btn.btn-primary', { type: 'button', id: 'scanPaneBtn', text: '开始扫描' });
  const actBtn = el('button.btn', { type: 'button', id: 'scanActBtn', text: '批量激活', disabled: true, title: '先勾选扫描结果中的未激活设备，再点这里批量激活' });
  actBtn.addEventListener('click', () => activateSelected(scanFound().filter((r) => S.scanSel.has(dkey(r.ip, r.port || 80))).map((r) => ({ ip: r.ip, port: r.port || 80 }))));

  btn.addEventListener('click', async () => {
    if (S.scan && S.scan.state === 'running') { toastWarn('已有扫描在进行中'); return; }
    if (!isIPv4(from.value) || !isIPv4(to.value)) { toastErr('请输入合法的起止 IPv4 地址', { title: '参数错误' }); return; }
    if (ipToInt(from.value) > ipToInt(to.value)) { toastErr('起始 IP 不能大于结束 IP', { title: '参数错误' }); return; }
    const total = ipToInt(to.value) - ipToInt(from.value) + 1;
    if (total > 4096 && !(await confirmBigScan(total))) return;
    S.scan = { state: 'running', scanned: 0, found: 0, total, startedAt: Date.now(), rows: new Map(), taskId: '' };
    S.scanSel.clear();
    renderScanStatus($('#scanStat'), $('#scanBar'));
    renderScanResults();
    btn.disabled = true;
    btn.textContent = '扫描中…';
    try {
      const res = await api.scan({ from: from.value, to: to.value, username: user.value, password: pass.value, concurrency: Number(conc.value), timeoutMs: Number(toSel.value) });
      S.scan.taskId = res.taskId;
      registerTask(res.taskId, { action: 'scan', total, startedAt: S.scan.startedAt });
      toastInfo(`已下发扫描任务，共 ${total} 个地址`, { title: '扫描已启动' });
    } catch (e) {
      S.scan.state = 'failed';
      toastErr(errText(e), { title: '扫描启动失败' });
      btn.disabled = false;
      btn.textContent = '开始扫描';
      renderScanStatus($('#scanStat'), $('#scanBar'));
      renderScanResults();
    }
  });

  const pane = hcard([
    el('div.card-head', null, [htx('h2', 'IP 段扫描'), hsub('逐个地址请求 /ISAPI/System/deviceInfo 判定存活')]),
    hbody([
      el('div.scan-form', null, [
        field('起始 IP', from), field('结束 IP', to), field('用户名', user), field('密码', pass),
        field('超时', toSel),
        field(`并发数（8–128）`, el('div.slider-wrap', null, [conc, concOut])),
      ]),
      hrow([btn, actBtn]),
      el('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' } }, [barHost, stat]),
    ]),
    hbodyT(el('div', { id: 'scanHost' }), { style: { borderTop: '1px solid var(--line)' } }),
  ]);
  return pane;
}

function confirmBigScan(total) {
  return new Promise((resolve) => {
    let ok = false;
    const m = openModal({
      title: '扫描范围较大',
      body: hnotes('warn', [`本次将扫描 `, htx('b', String(total)), ` 个地址，可能耗时较久并产生大量请求。确认继续？`]),
      footer: [
        hbtn('取消', () => m.close(), 'button btn'),
        hbtn('继续扫描', () => { ok = true; m.close(); }, 'button btn btn-primary'),
      ],
      onClose: () => resolve(ok),
    });
  });
}

function renderScanStatus(stat, barHost) {
  if (!stat || !barHost) return;
  clear(stat); clear(barHost);
  const sc = S.scan;
  if (!sc) { barHost.append(htx('div.sub', '尚未开始扫描')); return; }
  const elapsed = sc.elapsedMs !== undefined ? sc.elapsedMs : Date.now() - sc.startedAt;
  const pct = sc.total ? (sc.scanned / sc.total) * 100 : 0;
  barHost.append(meter(pct, sc.state === 'running' ? '' : sc.state === 'done' ? 'ok' : 'warn'));
  append(stat, [
    htx('span', `已扫描 ${sc.scanned}/${sc.total}`),
    htx('span', `发现 ${sc.found}`),
    htx('span', `用时 ${fmtDur(elapsed)}`),
    el('span', { class: sc.state === 'running' ? '' : 'muted', text: sc.state === 'running' ? '扫描中…' : sc.state === 'done' ? '已完成' : sc.state === 'failed' ? '已中断' : '' }),
  ]);
}

const scanFound = () => (S.scan ? Array.from(S.scan.rows.values()).filter((r) => r.found) : []);

function renderScanResults() {
  const host = $('#scanHost');
  if (!host) return;
  clear(host);
  const sc = S.scan;
  const rows = scanFound();
  const sel = S.scanSel;
  const nsel = rows.filter((r) => sel.has(dkey(r.ip, r.port || 80))).length;
  syncActBar('scanAll', 'scanActBtn', nsel, rows.length);
  if (!rows.length) {
    host.append(hbody(emptyState(sc && sc.state === 'running' ? '正在扫描，发现的设备会实时出现在这里…' : '填好网段与密码后点“开始扫描”，结果会实时流式显示。', '⌁')));
    return;
  }
  const btn = $('#scanPaneBtn');
  const allBox = el('input', {
    type: 'checkbox', id: 'scanAll', 'aria-label': '全选',
    checked: nsel > 0 && nsel === rows.length,
    onchange: (e) => {
      for (const r of rows) { const k = dkey(r.ip, r.port || 80); if (e.target.checked) sel.add(k); else sel.delete(k); }
      for (const cb of $$('input[data-key]', host)) { cb.checked = e.target.checked; cb.closest('tr').classList.toggle('sel', e.target.checked); }
      syncActBar('scanAll', 'scanActBtn', e.target.checked ? rows.length : 0, rows.length);
    },
  });
  allBox.indeterminate = nsel > 0 && nsel < rows.length;
  host.append(el('div.table-wrap', { style: { maxHeight: '34vh' } }, el('table.grid', null, [
    el('thead', null, el('tr', null, [
      el('th.nosort', { scope: 'col', style: { width: '30px' } }, allBox),
      hth('IP'), hth('型号'), hth('序列号'), hth('激活状态'), hth('萤石云'),
      el('th.nosort.num', { text: '延迟' }), hth('操作'),
    ])),
    el('tbody', null, rows.map((r) => {
      const key = dkey(r.ip, r.port || 80);
      const added = S.devices.has(key);
      const port = r.port || 80;
      return el('tr', { class: [added ? 'dim' : '', sel.has(key) ? 'sel' : ''].filter(Boolean).join(' ') }, [
        htd(el('input', {
          type: 'checkbox', checked: sel.has(key), dataset: { key }, 'aria-label': `选择 ${r.ip}`,
          onchange: (e) => {
            if (e.target.checked) sel.add(key); else sel.delete(key);
            e.target.closest('tr').classList.toggle('sel', e.target.checked);
            syncActBar('scanAll', 'scanActBtn', scanFound().filter((x) => sel.has(dkey(x.ip, x.port || 80))).length, rows.length);
          },
        })),
        htd(copyable(r.ip, { class: 'cell-ip', display: r.ip, title: `${r.ip}（点击复制）` })),
        htd(el('span.ellipsis', { text: r.model || '—', title: r.model || '', style: { maxWidth: '160px' } })),
        htd(copyable(r.serialNumber, { class: 'cell-trunc sm', display: r.serialNumber ? truncMid(r.serialNumber, 10, 4) : '—', title: r.serialNumber || '' })),
        htd(actBadge(r.activated)),
        htd(bindCell(r)),
        htd(r.latencyMs === undefined ? '—' : String(r.latencyMs), 'num'),
        htd(el('div.row-act', null, [
          r.activated === true
            ? el('span.muted', { text: '已激活', title: '设备已激活，无需重复激活', style: { fontSize: '11.5px' } })
            : el('button.btn.btn-xs', { type: 'button', text: '激活', title: `激活 ${r.ip}：设置管理员密码`, onclick: () => activateSelected([{ ip: r.ip, port }]) }),
          el('button.btn.btn-xs', {
            type: 'button', text: added ? '已在列表' : '添加', disabled: added,
            onclick: () => openAddDevice({ ip: r.ip, port, label: r.model || '' }),
          }),
        ])),
      ]);
    })),
  ])));
  if (btn) btn.disabled = !!(sc && sc.state === 'running');
}

// 视图：批量任务
function viewTasks() {
  const list = el('div', { id: 'taskCards' });
  const body = hbody(list);
  const card = hcard([
    el('div.card-head', null, [
      htx('h2', '任务列表'),
      el('div', { style: { display: 'flex', gap: '7px' } }, [
        hbtn('刷新', () => loadTasks(true), 'button btn btn-sm'),
        hbtn('清理已完成', () => { for (const [id, t] of S.tasks) if (t.state !== 'running') S.tasks.delete(id); setPref('taskbarHidden', false); scheduleRender('cards', 'taskbar'); }, 'button btn btn-sm'),
      ]),
    ]),
    body,
  ]);
  return el('section.view', null, [
    el('div.view-head', null, [htx('h1', '批量任务'), htx('span.hint', '所有异步任务的进度与逐台结果（实时）')]),
    card,
  ]);
}

function taskPercent(t) {
  if (t.total) return clamp((t.done / t.total) * 100, 0, 100);
  return t.state === 'done' ? 100 : 0;
}

function renderTaskCards() {
  const host = $('#taskCards');
  if (!host) return;
  clear(host);
  const tasks = Array.from(S.tasks.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  if (!tasks.length) {
    host.append(emptyState('还没有任务。可在“设备列表”里点“探测全部”，或用批量操作下发重启 / 对时 / 恢复。', '≡'));
    return;
  }
  for (const t of tasks) host.append(taskCard(t));
}

const ACTION_LABEL = {
  probe: '探测', reboot: '重启', reset: '恢复出厂', setTime: '对时', setNetwork: '修改网络',
  setPassword: '修改密码', upgrade: '固件升级', scan: 'IP 段扫描', import: '批量导入',
  'probe-all': '探测全部', 'reset-basic': '简单恢复', 'reset-full': '完全恢复',
  activate: '激活',
};
const actionLabel = (a) => ACTION_LABEL[a] || a || '任务';
const stateLabel = (s) => ({ running: '进行中', done: '已完成', failed: '失败', pending: '待执行' }[s] || s || '未知');

function taskCard(t) {
  const open = !!t.expanded;
  const head = el('div.task-head', {
    role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false',
    onclick: () => { t.expanded = !t.expanded; if (t.expanded) loadTaskDetail(t.taskId); scheduleRender('cards'); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.expanded = !t.expanded; if (t.expanded) loadTaskDetail(t.taskId); scheduleRender('cards'); } },
  }, [
    statusDot(t.state === 'done' ? true : t.state === 'failed' ? false : undefined),
    el('div.grow', null, [
      htx('div.tname', `${actionLabel(t.action)} · ${stateLabel(t.state)}`),
      htx('div.tmeta', `${t.taskId} ｜ ${t.done}/${t.total || '?'} ｜ 开始 ${fmtTime(t.startedAt, false)}${t.elapsedMs ? ` ｜ 用时 ${fmtDur(t.elapsedMs)}` : ''}`),
    ]),
    hbdg(`${Math.round(taskPercent(t))}%`, t.state === 'running' ? 'badge-busy' : t.state === 'done' ? 'badge-ok' : 'badge-bad'),
    htx('span.muted', open ? '▲' : '▼'),
  ]);
  const nodes = [head, meter(taskPercent(t), t.state === 'running' ? '' : t.state === 'done' ? 'ok' : 'warn')];
  if (open) nodes.push(taskBody(t));
  return el('div.task-card', null, nodes);
}

function taskBody(t) {
  const results = Array.from(t.results.values());
  const counts = { ok: 0, failed: 0, skipped: 0, pending: 0, running: 0 };
  for (const r of results) counts[r.state] = (counts[r.state] || 0) + 1;
  const body = el('div.task-body', null, [
    el('div.stat-row', null, [
      htx('span', `成功 ${counts.ok}`), htx('span', `失败 ${counts.failed}`),
      htx('span', `跳过 ${counts.skipped}`), htx('span', `待执行 ${counts.pending + counts.running}`),
      t.summary ? htx('span', `汇总 ${JSON.stringify(t.summary)}`) : null,
    ]),
    el('div.tl'),
  ]);
  const log = el('div.log');
  if (!results.length) log.append(hdiv([htx('span.lt', '—'), htx('span.lm.muted', t.detailLoading ? '加载中…' : '暂无逐台结果')]));
  for (const r of results) {
    log.append(hdiv([
      htx('span.lt', fmtTime(r.at, false)),
      el('span.li', { text: r.id || '—', title: r.id || '' }),
      el('span.lm', { class: r.state, text: `${stateLabel(r.state)}${r.ms ? ` · ${fmtDur(r.ms)}` : ''}${r.message ? ` · ${r.message}` : ''}` }),
    ]));
  }
  body.append(log);
  return body;
}

async function loadTasks(manual) {
  try {
    const list = await api.tasks();
    if (Array.isArray(list)) {
      for (const t of list) {
        if (!S.tasks.has(t.taskId)) registerTask(t.taskId, { action: t.action, total: t.total, startedAt: t.startedAt });
        const rec = S.tasks.get(t.taskId);
        rec.action = t.action || rec.action;
        rec.state = t.state || rec.state;
        rec.total = t.total || rec.total;
        rec.done = Math.max(rec.done || 0, t.done || 0);
      }
    }
    if (manual) toastOk(`已同步 ${Array.isArray(list) ? list.length : 0} 个任务`);
  } catch (e) {
    if (manual) toastErr(errText(e), { title: '任务列表获取失败' });
  }
  // 不整体重绘：只刷新任务卡与任务栏，避免打断正在进行的表单输入
  if ($('#taskCards')) scheduleRender('cards');
  scheduleRender('taskbar', 'chrome');
}

async function loadTaskDetail(taskId) {
  const t = S.tasks.get(taskId);
  if (!t) return;
  t.detailLoading = true;
  try {
    const d = await api.task(taskId);
    if (!d) return;
    t.action = d.action || t.action;
    t.state = d.state || t.state;
    t.total = d.total || t.total;
    t.done = d.done ?? t.done;
    t.startedAt = d.startedAt || t.startedAt;
    t.summary = d.summary || t.summary;
    for (const r of d.results || []) upsertResult(t, r);
  } catch (e) {
    toastErr(errText(e), { title: `任务 ${taskId} 详情获取失败` });
  } finally {
    t.detailLoading = false;
    scheduleRender('cards');
  }
}

// 视图：报表
function viewReport() {
  const format = getPref('reportFormat', 'csv');
  const includePref = getPref('reportInclude', ['probe', 'network', 'time', 'users', 'storage']);
  const INCLUDE = [['probe', '探测状态'], ['network', '网络配置'], ['time', '时间配置'], ['users', '用户列表'], ['storage', '存储信息']];
  const includeState = new Set(includePref);

  const pickHost = el('div.pick-list');
  const searchInp = hinp({ type: 'search', placeholder: '过滤设备…', 'aria-label': '过滤设备' });
  const renderPick = () => {
    clear(pickHost);
    const q = searchInp.value.trim().toLowerCase();
    const rows = devList().filter((d) => !q || `${d.label} ${d.id} ${d.status?.model || ''}`.toLowerCase().includes(q));
    if (!rows.length) { pickHost.append(emptyState('没有设备', '▤')); return; }
    for (const d of rows) {
      pickHost.append(el('label', null, [
        el('input', { type: 'checkbox', checked: S.selected.has(d.id), onchange: (e) => { if (e.target.checked) S.selected.add(d.id); else S.selected.delete(d.id); renderPickCount(); } }),
        htx('span.mono', d.id),
        htx('span.muted', d.label || ''),
        el('span.badge', { class: (d.status?.online) ? 'badge-ok' : 'badge-bad', text: d.status?.online === true ? '在线' : d.status?.online === false ? '离线' : '未知', style: { marginLeft: 'auto' } }),
      ]));
    }
    renderPickCount();
  };
  const countEl = el('span.sub');
  const renderPickCount = () => { countEl.textContent = `已选 ${selList().length} / ${devList().length} 台`; };
  searchInp.addEventListener('input', debounce(renderPick, 120));

  const radios = el('div.radio-row', null, ['csv', 'xlsx'].map((f) => {
    const inp = el('input', { type: 'radio', name: 'fmt', value: f, checked: format === f, id: `fmt-${f}` });
    inp.addEventListener('change', () => setPref('reportFormat', f));
    return el('label', { for: `fmt-${f}` }, [inp, htx('span', f.toUpperCase())]);
  }));

  const incBoxes = el('div.radio-row', null, INCLUDE.map(([k, label]) => {
    const inp = el('input', { type: 'checkbox', checked: includeState.has(k), id: `inc-${k}` });
    inp.addEventListener('change', () => {
      if (inp.checked) includeState.add(k); else includeState.delete(k);
      setPref('reportInclude', Array.from(includeState));
    });
    return el('label', { for: `inc-${k}` }, [inp, htx('span', label)]);
  }));

  const outHost = el('div', { style: { marginTop: '11px' } });
  const renderOut = () => {
    clear(outHost);
    if (!S.report) return;
    const r = S.report;
    outHost.append(el('div.dl', null, [
      el('span', { text: '✔', style: { color: 'var(--on)' } }),
      el('div', { style: { flex: '1', minWidth: '0' } }, [
        htx('div', `已生成 ${r.rows ?? '?'} 行 · ${r.file || ''}`),
        el('a', { href: absUrl(r.url), download: '', text: absUrl(r.url) }),
      ]),
      hbtn('下载', () => downloadUrl(absUrl(r.url)), 'button btn btn-sm'),
      copyable(absUrl(r.url), { class: 'btn btn-sm', display: '复制链接', title: '复制下载链接' }),
    ]));
  };

  const btn = el('button.btn.btn-primary', { type: 'button', text: '生成报表' });
  btn.addEventListener('click', async () => {
    const ids = selList();
    if (!ids.length) { toastWarn('请先勾选要巡检的设备', { title: '未选择设备' }); return; }
    const fmt = ($$('input[name=fmt]').find((n) => n.checked) || { value: format }).value;
    btn.disabled = true;
    btn.textContent = '';
    btn.append(hspin(), document.createTextNode(' 生成中…'));
    try {
      const res = await api.report(ids, fmt, Array.from(includeState));
      S.report = res;
      toastOk(`已生成 ${res.rows ?? '?'} 行报表`, { title: '报表完成' });
      renderOut();
    } catch (e) {
      toastErr(errText(e), { title: '报表生成失败' });
    } finally {
      btn.disabled = false;
      btn.textContent = '生成报表';
    }
  });

  queueMicrotask(renderPick);

  return el('section.view', null, [
    el('div.view-head', null, [htx('h1', '报表'), htx('span.hint', '对所选设备做一次现状巡检，导出 CSV / XLSX')]),
    hcard([
      el('div.card-head', null, [htx('h2', '选择设备'), countEl]),
      hbody([
        el('div', { style: { marginBottom: '9px', display: 'flex', gap: '7px', alignItems: 'center' } }, [
          el('div.search-wrap', { style: { flex: '1' } }, searchInp),
          hbtn('全选', () => { for (const d of devList()) S.selected.add(d.id); renderPick(); }, 'button btn btn-sm'),
          hbtn('清空', () => { S.selected.clear(); renderPick(); }, 'button btn btn-sm'),
        ]),
        pickHost,
        hsec('格式'), radios,
        hsec('巡检内容 include'), incBoxes,
        hnote('info', '巡检报表已包含萤石云列：萤石云支持 / 萤石云开启 / 萤石云绑定 / 绑定验证码（随设备探测一并返回，见 API.md §3.4）。'),
        hrow(btn),
        outHost,
      ]),
    ]),
  ]);
}

// 设备详情抽屉
function openDrawer(id) {
  if (!S.devices.has(id)) return;
  S.drawerId = id;
  S.previewing = false;
  $('#drawer').hidden = false;
  $('.app').classList.add('drawer-open');
  scheduleRender('drawer', 'drawerHead');
  const body = $('#dwBody');
  body.focus();
}
function closeDrawer() {
  S.drawerId = null;
  S.previewing = false;
  stopSnapshotTimer();
  $('#drawer').hidden = true;
  $('.app').classList.remove('drawer-open');
  scheduleRender('drawerHead');
}

function renderDrawerHead() {
  const d = dev(S.drawerId);
  const head = $('#drawer-head');
  $('#dwTabs').hidden = !d;
  if (!d) return;
  const st = d.status || {};
  $('#dwDot').className = `dot ${st.online === true ? 'dot-on' : st.online === false ? 'dot-off' : 'dot-idle'}`;
  $('#dwName').textContent = d.label || st.deviceName || st.model || d.ip;
  $('#dwId').textContent = d.id;
  for (const tab of $$('#dwTabs .tab')) tab.setAttribute('aria-selected', tab.dataset.tab === S.tab ? 'true' : 'false');
}

function renderDrawerBody() {
  const host = $('#dwBody');
  if (!host) return;
  stopSnapshotTimer();
  clear(host);
  const d = dev(S.drawerId);
  if (!d) return;
  const map = {
    overview: tabOverview, network: tabNetwork, time: tabTime,
    password: tabPassword, maintain: tabMaintain, upgrade: tabUpgrade,
  };
  const fn = map[S.tab] || tabOverview;
  host.append(fn(d));
  if (S.tab === 'overview') startSnapshotTimer(d);
}

/* ---------- 概览 ---------- */
let snapshotBust = 0;
function startSnapshotTimer(d) {
  stopSnapshotTimer();
  if (S.previewing) return;
  // 先立刻取一张，否则打开抽屉后要干等 3 秒才发第一个请求
  //（界面上表现为「正在抓图…」+ 空框 + 转圈）。
  refreshSnapshot(d.id);
  S.snapshotTimer = setInterval(() => { refreshSnapshot(d.id); }, 3000);
}
function stopSnapshotTimer() { if (S.snapshotTimer) { clearInterval(S.snapshotTimer); S.snapshotTimer = 0; } }

function refreshSnapshot(id) {
  const img = $('#dwSnap');
  if (!img || S.previewing || S.drawerId !== id || S.tab !== 'overview') return;
  snapshotBust++;
  img.dataset.pending = '1';
  img.src = api.snapshotUrl(id, 101, snapshotBust);
}

function snapshotBlock(d) {
  const img = el('img', { id: 'dwSnap', alt: `${d.ip} 抓图`, decoding: 'async' });
  const ph = el('div.ph', null, '正在抓图…');
  const loading = el('div.loading', null, hspin());
  const mode = el('span', { id: 'dwSnapMode', text: '' });
  const timeEl = el('span', { id: 'dwSnapTime', text: '' });
  const box = el('div.snapshot', null, [ph, img, loading, el('div.ov', null, [mode, timeEl])]);
  img.addEventListener('load', () => { img.dataset.pending = ''; loading.hidden = true; ph.hidden = true; timeEl.textContent = fmtTime(Date.now(), false); });
  img.addEventListener('error', () => {
    loading.hidden = true; img.hidden = true; ph.hidden = false;
    ph.textContent = '抓图失败：设备离线或未开放 HTTP 预览';
  });
  return box;
}

function refreshSnapshotNow(d) {
  const img = $('#dwSnap');
  if (!img) return;
  img.hidden = false;
  const loading = img.parentElement.querySelector('.loading');
  const ph = img.parentElement.querySelector('.ph');
  if (loading) loading.hidden = false;
  if (ph) ph.hidden = true;
  const mode = $('#dwSnapMode');
  if (mode) mode.textContent = '抓图模式';
  refreshSnapshot(d.id);
}

function startPreview(d) {
  const img = $('#dwSnap');
  if (!img) return;
  S.previewing = true;
  stopSnapshotTimer();
  const loading = img.parentElement.querySelector('.loading');
  const ph = img.parentElement.querySelector('.ph');
  if (loading) loading.hidden = false;
  if (ph) ph.hidden = true;
  img.hidden = false;
  img.src = api.previewUrl(d.id, 101, 5);
  const mode = $('#dwSnapMode');
  if (mode) mode.textContent = '实时预览 (MJPEG)';
  const t = setTimeout(() => { if (loading) loading.hidden = true; }, 8000);
  img.addEventListener('load', () => { clearTimeout(t); if (loading) loading.hidden = true; }, { once: true });
}

/** 详情抽屉里的键值行（值可点击复制） */
function kvRow(k, v, mono, copyVal) {
  return el('div', STIF, [
    el('dt', { text: k }),
    el('dd', { class: mono ? 'mono' : '', text: v ?? '—', title: mono ? '点击复制' : '', role: mono ? 'button' : null, tabindex: mono ? '0' : null, onclick: mono ? () => doCopy(copyVal ?? v) : null, onkeydown: mono ? (e) => { if (e.key === 'Enter') doCopy(copyVal ?? v); } : null }),
  ]);
}

/** 概览里的告警区：未激活（能被发现但登录不了）与探测错误 */
function overviewAlerts(box, st) {
  clear(box);
  const na = notActivated(st);
  if (na) {
    box.append(hnotes('warn', [
      htx('b', '⚠ 设备未激活：'),
      '未激活的设备无法登录 ISAPI（可以被发现，但探测与所有配置操作都会失败）。请到「发现设备」页勾选它并点「激活」。',
      st.error ? el('div.mono', { style: { marginTop: '5px', whiteSpace: 'pre-wrap' }, text: String(st.error) }) : null,
    ]));
  }
  if (st.error && !na) box.append(hnotes('warn', ['探测返回错误：', htx('b', String(st.error))]));
}

/** 概览的「萤石云」块（API.md §3.4） */
function ezvizBlock(st) {
  const ez = st.ezviz;
  const v = (x) => (x === true ? '是' : x === false ? '否' : '—');
  if (!ez || typeof ez !== 'object') return hnote('info', '设备未返回萤石云状态（status.ezviz 为空），可能是设备不支持或该次探测未取到。');
  const code = ez.verificationCode
    ? copyable(ez.verificationCode, { class: 'mono', display: ez.verificationCode, title: `${ez.verificationCode}（点击复制绑定验证码）` })
    : '—';
  return hdiv([
    hkv([
      kvRow('支持', v(ez.supported)),
      kvRow('服务开启', v(ez.enabled)),
      kvRow('绑定状态', ezBindText(ez)),
      el('div', STIF, [el('dt', { text: '绑定验证码' }), el('dd', null, code)]),
      kvRow('视频加密', v(ez.streamEncrypteEnabled)),
      kvRow('支持解绑', v(ez.supportUnbind)),
    ]),
    ez.error ? el('div.sub', { style: { marginTop: '6px' }, text: `萤石云读取失败：${ez.error}` }) : null,
  ]);
}

function tabOverview(d) {
  const st = d.status || {};
  const kv = kvRow;
  const kvLive = (k, id, v) => el('div', STIF, [el('dt', { text: k }), el('dd', { id, text: v })]);

  const rtspHost = el('div', { hidden: true });
  const consoleHost = el('div', { hidden: true, id: 'dwConsoleHost' });
  const body = hdiv([
    hsec('实时画面'),
    snapshotBlock(d),
    hrow([
      hbtn('↻ 立即刷新', () => refreshSnapshotNow(d), 'button btn btn-sm', { id: 'btnSnapNow' }),
      hbtn('▶ 实时预览', () => startPreview(d), 'button btn btn-sm', { id: 'btnPreview' }),
      hbtn('🖥 设备后台', () => openDeviceConsole(d), 'button btn btn-sm', { id: 'btnConsole' }),
      hbtn('⧉ 打开 RTSP', () => showRtsp(d, rtspHost), 'button btn btn-sm', { id: 'btnRtsp' }),
      hbtn('↻ 重新探测', () => probeOne(d.id), 'button btn btn-sm'),
    ]),
    rtspHost,
    consoleHost,
    hsec('设备信息'),
    hkv([
      kv('设备名', st.deviceName), kv('型号', st.model),
      kv('序列号', st.serialNumber, true), kv('固件版本', st.firmwareVersion),
      kv('固件日期', st.firmwareReleasedDate), kv('MAC', st.macAddress, true),
      kv('设备类型', st.deviceType), kv('通道数', st.channelCount),
      kv('激活状态', st.activated === true ? '已激活' : st.activated === false ? '未激活' : '—'),
      kvLive('在线状态', 'dwOnline', st.online === true ? '在线' : st.online === false ? '离线' : '未知'),
      kvLive('延迟', 'dwLatency', st.latencyMs === null || st.latencyMs === undefined ? '—' : `${st.latencyMs} ms`),
      kvLive('最后探测', 'dwChecked', st.checkedAt ? fmtTime(st.checkedAt) : '—'),
      kv('地址', d.id, true), kv('HTTPS', d.https ? '是' : '否'),
      kv('用户名', d.username, true), kv('分组', d.group),
      kv('加入时间', d.addedAt ? fmtTime(d.addedAt) : '—'),
    ]),
    hsec('萤石云'),
    ezvizBlock(st),
    (() => { const b = el('div', { id: 'dwErr' }); overviewAlerts(b, st); return b; })(),
    el('details', { style: { marginTop: '12px' } }, [
      el('summary', { class: 'sub', text: '原始状态 JSON', style: { cursor: 'pointer' } }),
      el('pre', { class: 'log', style: { padding: '8px', maxHeight: '200px' }, text: JSON.stringify(d, null, 2) }),
    ]),
  ]);
  return body;
}

async function doCopy(text) {
  try { await copyText(text); toastOk(`已复制：${truncMid(String(text), 34, 8)}`, { timeout: 1800 }); }
  catch (e) { toastErr(errText(e)); }
}

/* ---------- 设备后台（离线配置包） ---------- */
/**
 * 打开设备的"WEB 后台"。
 *
 * 等价于 HiToolsDelivery 的内置浏览器：本机托管海康的离线 Web 配置包，
 * 并把包内发出的 /ISAPI/*、/DISPATCH_ip_* 请求反向代理回真实设备，
 * 因此**没有内置网页的摄像头也能打开后台**。
 */
async function openDeviceConsole(d) {
  const btn = $('#btnConsole');
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '正在打开…'; }
  try {
    let st = S.console;
    if (!st || !st.running) {
      st = await api.consoleState();
      S.console = st;
    }
    if (!st || !st.running) {
      throw new Error((st && st.error) || '设备后台服务未启动（启动时加 --no-console 会关闭它）');
    }
    const r = await api.consoleUrl(d.id);
    const w = window.open(r.url, '_blank', 'noopener');
    if (!w) {
      // 弹窗被拦截时给出可点击的链接，避免"点了没反应"
      toastWarn(`浏览器拦截了新窗口，请手动打开：${r.url}`, { title: '打开设备后台' });
      showConsoleLink(d, r.url);
    } else {
      toastOk('已在新标签页打开设备后台', { title: '设备后台' });
    }
  } catch (e) {
    toastErr(errText(e), { title: '打开设备后台失败' });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old || '🖥 设备后台'; }
  }
}

/** 兜底：把地址显示在抽屉里，用户可复制或点击 */
function showConsoleLink(d, url) {
  const host = $('#dwConsoleHost');
  if (!host) return;
  clear(host); host.hidden = false;
  const inp = hinp({ readonly: true, value: url });
  host.append(hnotes('info', [
    htx('div', '设备后台地址（本机离线配置包 + 反向代理到设备）：'),
    el('div.copy-line', null, [inp, hbtn('复制', () => doCopy(url), 'button btn btn-sm'),
      hbtn('打开', () => window.open(url, '_blank'), 'button btn btn-sm btn-primary')]),
    el('div.sub', { style: { marginTop: '6px' }, text: '没有内置网页的设备会使用本机离线配置包；数据请求由 hikctl 代理回设备。' }),
  ]));
}

async function showRtsp(d, host) {
  clear(host); host.hidden = false;
  host.append(hnotes('info', [hspin(), ' 正在获取取流地址…']));
  try {
    const s = await api.stream(d.id);
    clear(host);
    const inp = hinp({ readonly: true, value: s.rtsp || '（服务未返回 rtsp）' });
    host.append(
      hnotes('info', [
        htx('div', 'RTSP 地址（含凭据，请勿外传）：'),
        el('div.copy-line', null, [inp, hbtn('复制', () => doCopy(s.rtsp), 'button btn btn-sm')]),
        el('div.sub', { style: { marginTop: '6px' }, text: `可用模式：${(s.modes || []).join(' / ') || '—'} ｜ MJPEG：${s.mjpeg || '—'} ｜ H.264 WS：${s.wsH264 || '—'}` }),
      ]),
    );
  } catch (e) {
    clear(host);
    host.append(hnote('danger', `获取取流地址失败：${errText(e)}`));
  }
}

/* ---------- 网络 ---------- */
/** 通过 API.md §4 的 ISAPI 透传读取网口配置（契约未提供专用 GET 网络接口） */
async function fetchNetworkConfig(id) {
  const res = await api.isapiGet(id, '/ISAPI/System/Network/interfaces/1/ipAddress');
  const body = res && res.body ? String(res.body) : '';
  const pick = (tag) => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(body); return m ? m[1] : ''; };
  if (!body.includes('<')) throw new Error('设备未返回可解析的 XML');
  return {
    ip: pick('ipAddress'), mask: pick('subnetMask'), gateway: pick('DefaultGateway') || pick('gateway'),
    dns: pick('PrimaryDNS') || pick('dnsServer'), dhcp: /<addressingType>\s*dhcp/i.test(body),
    raw: body,
  };
}

function tabNetwork(d) {
  const ip = hinpm({ placeholder: '192.168.1.64', value: ipOf(d.id) });
  const mask = hinpm({ placeholder: '255.255.255.0', value: '255.255.255.0' });
  const gw = hinpm({ placeholder: '192.168.1.1' });
  const dns = hinpm({ placeholder: '8.8.8.8' });
  const dhcp = el('input', { type: 'checkbox' });
  const iface = hinpm({ value: '1' });
  const state = htx('div.sub', '当前值未知，可点“读取当前配置”（走 ISAPI 透传）。');
  const out = el('div');
  const btn = el('button.btn.btn-primary', { type: 'button', text: '应用网络配置' });

  const syncDisabled = () => { for (const n of [ip, mask, gw, dns]) n.disabled = dhcp.checked; };
  dhcp.addEventListener('change', syncDisabled);

  btn.addEventListener('click', async () => {
    for (const [n, v] of [[ip, 'IP'], [mask, '子网掩码']]) if (!isIPv4(n.value)) { toastErr(`${v} 不是合法 IPv4`, { title: '参数错误' }); return; }
    if (gw.value && !isIPv4(gw.value)) { toastErr('网关不是合法 IPv4', { title: '参数错误' }); return; }
    if (dns.value && !isIPv4(dns.value)) { toastErr('DNS 不是合法 IPv4', { title: '参数错误' }); return; }
    const ok = await confirmDialog({
      title: '确认修改网络配置',
      note: ['修改后设备可能立即断开连接（部分型号需重启生效）。', el('br'), `新地址：`, htx('code.type-confirm', `${ip.value}:${d.port}`), `，设备 ID 将由 `, htx('code.type-confirm', d.id), ` 变为 `, htx('code.type-confirm', `${ip.value}:${d.port}`), '。'],
      noteKind: 'warn', confirmLabel: '确认下发',
    });
    if (!ok) return;
    btn.disabled = true; btn.textContent = '';
    btn.append(hspin(), document.createTextNode(' 下发中…'));
    clear(out);
    try {
      const r = await api.setNetwork(d.id, { interfaceId: Number(iface.value) || 1, ip: ip.value, mask: mask.value, gateway: gw.value, dns: dns.value, dhcp: dhcp.checked });
      out.append(hnotes('ok', [
        htx('div', r.message || '网络配置已下发'),
        el('div', { style: { marginTop: '5px' } }, ['新设备 ID：', htx('code.type-confirm', r.newId || '—'), '（设备离线后请刷新列表）']),
        r.rebootRequired ? el('div', { style: { marginTop: '5px' }, text: '⚠ rebootRequired：需要重启设备后生效，可在“维护”页执行重启。' }) : null,
      ]));
      toastOk(`已下发到 ${d.ip}，新 ID ${r.newId || '未知'}`, { title: '网络配置已应用' });
      setTimeout(refreshDevices, 1500);
    } catch (e) {
      out.append(hnote('danger', `下发失败：${errText(e)}`));
      toastErr(errText(e), { title: `${d.ip} 网络配置失败` });
    } finally {
      btn.disabled = false; btn.textContent = '应用网络配置';
    }
  });

  return hdiv([
    hnotes('warn', [
      htx('b', '⚠ 修改 IP 会改变设备 ID（ID = ip:port），设备可能掉线并从当前列表“消失”。'),
      el('div', { style: { marginTop: '4px' }, text: '下发成功后服务会返回 newId；若设备离线，请用“发现设备”重新找到它。部分型号需要重启才生效。' }),
    ]),
    hgrid([
      field('接口 ID', iface), field('IP 地址', ip),
      field('子网掩码', mask), field('默认网关', gw),
      field('DNS', dns),
      el('label.checkline', { style: { alignSelf: 'end', height: '27px' } }, [dhcp, htx('span', '启用 DHCP（自动获取）')]),
    ]),
    hrow([
      btn,
      el('button.btn', {
        type: 'button', text: '读取当前配置', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; state.textContent = '读取中…';
          try {
            const c = await fetchNetworkConfig(d.id);
            if (c.ip) ip.value = c.ip;
            if (c.mask) mask.value = c.mask;
            if (c.gateway) gw.value = c.gateway;
            if (c.dns) dns.value = c.dns;
            dhcp.checked = !!c.dhcp; syncDisabled();
            state.textContent = `已从设备读取（ISAPI 透传）：${c.ip || '?'}`;
          } catch (err) { state.textContent = `读取失败：${errText(err)}（可手工填写）`; }
          finally { b.disabled = false; }
        },
      }),
    ]),
    state, out,
  ]);
}

/* ---------- 时间 ---------- */
function tabTime(d) {
  const mode = getPref('timeMode', 'pc');
  const manual = hinp({ type: 'datetime-local', value: toLocalInput(new Date()) });
  const ntpServer = hinpm({ value: getPref('ntpServer', 'pool.ntp.org') });
  const ntpPort = hinpm({ value: '123' });
  const ntpInterval = hinpm({ value: '60' });
  const out = el('div');
  const btns = [];

  const card = (key, title, desc, controls) => {
    const radio = el('input', { type: 'radio', name: 'timemode', value: key, checked: mode === key, id: `tm-${key}` });
    radio.addEventListener('change', () => { setPref('timeMode', key); sync(); });
    btns.push({ key, radio });
    return el('label.pick-row', { for: `tm-${key}`, style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '9px', border: '1px solid var(--line)', borderRadius: '5px', marginBottom: '7px', cursor: 'pointer' } }, [
      radio,
      el('div', { style: { flex: '1' } }, [
        el('div', { style: { fontWeight: '600' }, text: title }),
        htx('div.sub', desc),
        el('div', { style: { marginTop: '7px', display: 'flex', gap: '8px', flexWrap: 'wrap' } }, controls),
      ]),
    ]);
  };

  const apply = el('button.btn.btn-primary', { type: 'button', text: '应用时间设置' });
  const sync = () => { for (const b of btns) b.radio.checked = b.key === getPref('timeMode', 'pc'); };
  apply.addEventListener('click', async () => {
    const m = getPref('timeMode', 'pc');
    let body;
    if (m === 'pc') body = { mode: 'pc' };
    else if (m === 'manual') {
      if (!manual.value) { toastErr('请选择日期时间', { title: '参数错误' }); return; }
      body = { mode: 'manual', dateTime: manual.value };
    } else {
      if (!ntpServer.value.trim()) { toastErr('请填写 NTP 服务器', { title: '参数错误' }); return; }
      body = { mode: 'ntp', server: ntpServer.value.trim(), port: Number(ntpPort.value) || 123, intervalMinutes: Number(ntpInterval.value) || 60 };
      setPref('ntpServer', ntpServer.value.trim());
    }
    await busy(apply, '下发中…', async () => {
      clear(out);
      try {
        const r = await api.setTime(d.id, body);
        out.append(hnote('ok', `已应用：${r.applied ?? JSON.stringify(body)}`));
        toastOk(`对时成功 · ${d.ip}`, { title: '时间已更新' });
      } catch (e) {
        out.append(hnote('danger', `对时失败：${errText(e)}`));
        toastErr(errText(e), { title: `${d.ip} 对时失败` });
      }
    });
  });

  return hdiv([
    hsec('选择对时方式'),
    card('pc', '用电脑时间', '以运行本工具的服务端当前时间对时（mode: pc）', []),
    card('manual', '手动指定', '手动填写日期与时间（mode: manual）', [manual]),
    card('ntp', 'NTP 服务器', '设备定期向 NTP 服务器同步（mode: ntp）', [ntpServer, ntpPort, ntpInterval]),
    hrow(apply),
    out,
  ]);
}

/* ---------- 密码 ---------- */
function tabPassword(d) {
  const user = hinpm({ value: d.username || 'admin' });
  const oldP = hinp({ type: 'password', autocomplete: 'off', placeholder: '当前密码' });
  const newP = hinp({ type: 'password', autocomplete: 'new-password', placeholder: '新密码' });
  const newP2 = hinp({ type: 'password', autocomplete: 'new-password', placeholder: '再次输入新密码' });
  const out = el('div');
  const btn = el('button.btn.btn-primary', { type: 'button', text: '修改密码' });
  btn.addEventListener('click', async () => {
    if (!oldP.value) { toastErr('请填写当前密码', { title: '参数错误' }); return; }
    if (!newP.value) { toastErr('请填写新密码', { title: '参数错误' }); return; }
    if (newP.value !== newP2.value) { toastErr('两次输入的新密码不一致', { title: '参数错误' }); return; }
    const ok = await confirmDialog({ title: '确认修改密码', noteKind: 'warn', confirmLabel: '确认修改', note: [`将修改 `, htx('code.type-confirm', `${d.ip} / ${user.value}`), ` 的登录密码。修改后请同步更新本工具中保存的凭据，否则探测会失败。`] });
    if (!ok) return;
    await busy(btn, '提交中…', async () => {
      clear(out);
      try {
        await api.setPassword(d.id, { userName: user.value, oldPassword: oldP.value, newPassword: newP.value });
        out.append(hnote('ok', '密码已修改成功。'));
        toastOk(`密码已更新 · ${d.ip}`, { title: '成功' });
        oldP.value = newP.value = newP2.value = '';
      } catch (e) {
        out.append(hnote('danger', `修改失败：${errText(e)}`));
        toastErr(errText(e), { title: `${d.ip} 修改密码失败` });
      }
    });
  });

  return hdiv([
    hgrid([field('用户名', user), field('当前密码', oldP), field('新密码', newP), field('确认新密码', newP2)]),
    hnote('info', '请求：PUT /api/devices/:id/password，body { userName, oldPassword, newPassword }。新密码需满足设备自身的复杂度策略（通常 8–16 位，含字母与数字）。'),
    hrow(btn),
    out,
  ]);
}

/* ---------- 维护 ---------- */
function tabMaintain(d) {
  const out = el('div');
  const btnReboot = el('button.btn.btn-danger', { type: 'button', text: '重启设备' });
  const btnBasic = el('button.btn.btn-warn', { type: 'button', text: '简单恢复' });
  const btnFull = el('button.btn.btn-danger', { type: 'button', text: '完全恢复' });

  btnReboot.addEventListener('click', async () => {
    const r = await confirmDanger({
      title: '重启设备 · 确认',
      confirmLabel: '确认重启',
      note: [htx('b', '设备重启后约 30–60 秒不可访问。'), el('br'), 'ISAPI：PUT /ISAPI/System/reboot。'],
    });
    if (!r.ok) return;
    await runMaintain(d, out, '重启', () => api.reboot(d.id));
  });

  btnBasic.addEventListener('click', async () => {
    const r = await confirmDanger({
      title: '简单恢复 · 确认',
      confirmLabel: '执行简单恢复',
      note: [htx('b', '简单恢复：恢复参数，但不包括 IP 地址；设备除用户名、密码、激活状态、网络参数外，恢复至出厂默认。')],
      extraNote: '恢复期间设备会断连并重启，进度只能靠重新探测判断。',
    });
    if (!r.ok) return;
    await runMaintain(d, out, '简单恢复', () => api.reset(d.id, 'basic', r.password));
  });

  btnFull.addEventListener('click', async () => {
    const r = await confirmDanger({
      title: '完全恢复 · 确认',
      confirmLabel: '执行完全恢复',
      note: [htx('b', '完全恢复：恢复默认参数，包括 IP 地址等，设备所有参数恢复至出厂默认。'), el('br'), '恢复后 IP 会变回出厂默认（典型 192.168.1.64），当前连接会立即断开，密码与激活状态也会被清除。'],
      extraNote: '执行前请确保设备与电脑处于同一网段，否则恢复后将无法访问，需要重新激活并重新配置。',
    });
    if (!r.ok) return;
    await runMaintain(d, out, '完全恢复', () => api.reset(d.id, 'full', r.password));
  });

  return hdiv([
    hnotes('danger', [
      htx('b', '危险区域：以下操作会中断业务，且可能让设备“消失”。'),
      el('div', { style: { marginTop: '4px' }, text: '每个操作都会弹出一个确认对话框，确认后立即执行。' }),
    ]),
    el('div.danger-zone', null, [
      el('div.danger-item', null, [
        el('div.grow', null, [htx('strong', '重启'), htx('div.sub', 'PUT /ISAPI/System/reboot · 返回后约 30–60s 不可用')]),
        btnReboot,
      ]),
      el('div.danger-item', null, [
        el('div.grow', null, [htx('strong', '简单恢复（basic）'), htx('div.sub', '保留 IP / 用户名 / 密码 / 激活状态 / 网络参数')]),
        btnBasic,
      ]),
      el('div.danger-item', null, [
        el('div.grow', null, [htx('strong', '完全恢复（full）'), htx('div.sub', '含 IP，恢复后默认 192.168.1.64，需重新激活')]),
        btnFull,
      ]),
    ]),
    out,
  ]);
}

async function runMaintain(d, out, label, fn) {
  clear(out);
  const box = hnotes('info', [hspin(), ` 正在执行${label}…`]);
  out.append(box);
  try {
    const r = await fn();
    clear(out);
    out.append(hnotes('ok', [
      htx('div', `${label}指令已下发${r && r.message ? `：${r.message}` : '。'}`),
      el('div', { style: { marginTop: '5px' }, text: '设备可能立即断连并重启（约 30–60 秒）。工具会在几秒后自动重新探测；若设备因此掉出列表，请用“发现设备”找回。' }),
    ]));
    toastOk(`${label}已下发 · ${d.ip}`, { title: '成功' });
    if (label !== '重启') S.selected.delete(d.id);
    setTimeout(refreshDevices, 4000);
  } catch (e) {
    clear(out);
    out.append(hnote('danger', `${label}失败：${errText(e)}`));
    toastErr(errText(e), { title: `${d.ip} ${label}失败` });
  }
}

/* ---------- 升级 ---------- */
function tabUpgrade(d) {
  const path = hinpm({ placeholder: 'D:\\fw\\IPC_R0.dav', value: getPref('lastFwPath', '') });
  const list = el('div', { id: 'upHost' });
  const btn = el('button.btn.btn-primary', { type: 'button', text: '开始升级' });

  const btnBatch = el('button.btn', {
    type: 'button', text: '批量升级所选', disabled: !selList().length,
    onclick: async () => {
      const ids = selList();
      if (!path.value.trim()) { toastErr('请填写服务器上的固件路径', { title: '参数错误' }); return; }
      const ok = await confirmDialog({ title: '确认批量升级', noteKind: 'warn', confirmLabel: '开始批量升级', note: [`将对 `, htx('b', String(ids.length)), ` 台设备下发固件 `, htx('code.type-confirm', path.value.trim()), '。升级过程中设备会重启并中断业务。'] });
      if (!ok) return;
      try {
        setPref('lastFwPath', path.value.trim());
        const r = await api.batchUpgrade(ids, path.value.trim(), 4);
        registerTask(r.taskId, { action: 'upgrade', total: ids.length, startedAt: Date.now() });
        toastInfo(`批量升级任务已下发：${r.taskId}`, { title: '已开始' });
        renderUpgradeList(list);
      } catch (e) { toastErr(errText(e), { title: '批量升级失败' }); }
    },
  });

  btn.addEventListener('click', async () => {
    const fp = path.value.trim();
    if (!fp) { toastErr('请填写服务器本地固件路径（v1 不做文件上传）', { title: '参数错误' }); return; }
    if (!/\.(dav|zip|bin)$/i.test(fp)) {
      const ok = await confirmDialog({ title: '固件扩展名不常见', noteKind: 'warn', confirmLabel: '仍然继续', note: [`路径 `, htx('code.type-confirm', fp), ` 不是常见的 .dav/.zip/.bin。确认继续？`] });
      if (!ok) return;
    }
    const ok = await confirmDialog({ title: '确认升级', noteKind: 'warn', confirmLabel: '开始升级', note: ['将向 ', htx('code.type-confirm', d.ip), ` 下发固件 `, htx('code.type-confirm', fp), '。升级期间设备会中断服务，请勿断电。'] });
    if (!ok) return;
    btn.disabled = true; btn.textContent = ''; btn.append(hspin(), document.createTextNode(' 下发中…'));
    try {
      setPref('lastFwPath', fp);
      const r = await api.upgrade(d.id, fp);
      registerTask(r.taskId, { action: 'upgrade', total: 1, startedAt: Date.now() });
      toastInfo(`升级任务已下发：${r.taskId}`, { title: '已开始' });
      renderUpgradeList(list);
    } catch (e) { toastErr(errText(e), { title: `${d.ip} 升级下发失败` }); }
    finally { btn.disabled = false; btn.textContent = '开始升级'; }
  });

  queueMicrotask(() => renderUpgradeList(list));
  return hdiv([
    hnote('info', 'v1 使用服务器本地固件路径（契约 §8，不做 multipart 上传）。进度通过 SSE 的 upgrade.progress 事件推送。'),
    hgrid([field('固件路径（服务器本地）', path)]),
    hrow([btn, btnBatch]),
    hsec('升级进度'),
    list,
  ]);
}

function renderUpgradeList(host) {
  if (!host) return;
  clear(host);
  const ups = Array.from(S.tasks.values()).filter((t) => t.action === 'upgrade').sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 8);
  if (!ups.length) { host.append(htx('div.sub', '暂无升级任务。')); return; }
  for (const t of ups) {
    const rows = Array.from(t.results.values());
    const overall = t.total ? (t.done / t.total) * 100 : 0;
    host.append(el('div', { style: { marginBottom: '9px' } }, [
      el('div.progress-line', null, [
        htx('span.mono', t.taskId),
        meter(overall, t.state === 'done' ? 'ok' : ''),
        htx('span', `${Math.round(overall)}%`),
        statusBadge(t.state === 'running' ? 'upgrading' : t.state),
      ]),
      rows.length ? hlog(rows.map((r) => hdiv([
        htx('span.li', r.id),
        el('span.lm', { class: r.state, text: `${r.message || r.state}${r.percent !== undefined ? ` · ${r.percent}%` : ''}` }),
        htx('span.lt', fmtTime(r.at, false)),
      ])), { style: { maxHeight: '140px' } }) : null,
    ]));
  }
}

/* ---------- 通用确认框（替代 confirm()） ---------- */
function confirmDialog(o = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const m = openModal({
      title: o.title || '确认操作',
      body: hdiv([
        el('div.note', { class: o.noteKind === 'danger' ? 'note-danger' : 'note-warn' }, o.note || '确认执行该操作？'),
      ]),
      footer: [
        hbtn(o.cancelLabel || '取消', () => m.close(), 'button btn'),
        el('button.btn', { type: o.noteKind === 'danger' ? 'btn-danger' : 'btn-primary', class: o.noteKind === 'danger' ? 'btn-danger' : 'btn-primary', text: o.confirmLabel || '确认', onclick: () => { ok = true; m.close(); } }),
      ],
      onClose: () => resolve(ok),
    });
  });
}

// 设备操作
async function refreshDevices() {
  try {
    const list = await api.listDevices();
    S.devices = new Map((list || []).map((d) => [d.id, d]));
    for (const id of Array.from(S.selected)) if (!S.devices.has(id)) S.selected.delete(id);
    if (S.drawerId && !S.devices.has(S.drawerId)) closeDrawer();
    scheduleDataRefresh();
    autoProbeStale();
    return true;
  } catch (e) {
    toastErr(errText(e), { title: '设备列表获取失败' });
    return false;
  }
}

/**
 * 状态自愈：设备状态是"上次探测的快照"，可能因为重启/断网/激活瞬时失败而过期，
 * 于是列表会一直显示旧状态（例如明明已激活却显示"未激活"）。
 * 这里对「从未探测过」或「超过 90 秒未探测」的设备做一次节流后的后台复探。
 */
const STALE_MS = 90_000;
const AUTO_PROBE_MIN_GAP = 30_000;
S.autoProbed = S.autoProbed || new Map();
let autoProbeRunning = false;

async function autoProbeStale(forceIds) {
  if (autoProbeRunning) return;
  const now = Date.now();
  const targets = [];
  for (const d of S.devices.values()) {
    const last = S.autoProbed.get(d.id) || 0;
    if (now - last < AUTO_PROBE_MIN_GAP) continue;
    const force = forceIds && forceIds.includes(d.id);
    const stale = !d.status || !d.status.checkedAt || now - d.status.checkedAt > STALE_MS;
    if (force || stale) targets.push(d.id);
    if (targets.length >= 8) break;
  }
  if (!targets.length) return;
  autoProbeRunning = true;
  for (const id of targets) S.autoProbed.set(id, now);
  try {
    await Promise.all(targets.map(async (id) => {
      try {
        const r = await api.probe(id);
        const d = S.devices.get(id);
        if (d && r && r.status) d.status = r.status;
      } catch { /* 单台失败不影响其它 */ }
    }));
    scheduleDataRefresh();
  } finally {
    autoProbeRunning = false;
  }
}

/** 激活成功后立刻复探这几台，让设备列表马上显示正确状态（而不是等下一轮） */
async function reprobeActivated(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  await autoProbeStale(list);
  for (const id of list) S.autoProbed.set(id, Date.now());
}

/** 数据刷新：不重建正在播放 MJPEG 的抽屉，也不重建带表单的标签页（保护用户已输入内容） */
function scheduleDataRefresh() {
  scheduleRender('view', 'chrome', 'taskbar', 'drawerHead');
  const d = dev(S.drawerId);
  if (!d) return;
  if (S.tab === 'overview' && !S.previewing) scheduleRender('drawer');
  else updateOverviewValues(d);   // 只就地更新状态字段，不动表单
}

async function probeOne(id, btn) {
  const d = dev(id);
  const row = $(`tr[data-id="${CSS.escape(id)}"]`);
  const spinner = btn ? null : hspin();
  if (spinner && row) row.querySelector('td:first-child').append(spinner);
  if (btn) { btn.disabled = true; btn.classList.add('spin'); }
  try {
    const r = await api.probe(id);
    if (d) d.status = r.status || d.status;
    toastOk(`${d ? d.ip : id} ${r.status?.online ? '在线' : '离线'} · ${r.status?.latencyMs ?? '—'}ms`, { title: '探测完成' });
  } catch (e) {
    toastErr(errText(e), { title: `${d ? d.ip : id} 探测失败` });
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spin'); }
    if (spinner) spinner.remove();
    scheduleDataRefresh();
  }
}

async function probeAll() {
  if (!S.devices.size) { toastWarn('还没有设备可探测', { title: '设备列表为空' }); return; }
  const btn = $('#btnProbeAll');
  if (btn) btn.disabled = true;
  try {
    const r = await api.probeAll();
    registerTask(r.taskId, { action: 'probe', total: S.devices.size, startedAt: Date.now() });
    toastInfo(`已下发探测任务，共 ${S.devices.size} 台`, { title: '探测全部' });
  } catch (e) {
    toastErr(errText(e), { title: '探测全部下发失败' });
  } finally { if (btn) btn.disabled = false; }
}

function deleteOne(id) {
  const d = dev(id);
  return confirmDialog({
    title: '删除设备', noteKind: 'danger', confirmLabel: '删除',
    note: ['从本工具列表中移除 ', htx('code.type-confirm', d ? d.ip : id), '。不会修改设备本身的任何配置。'],
  }).then(async (ok) => {
    if (!ok) return;
    try {
      await api.delDevice(id);
      S.devices.delete(id);
      S.selected.delete(id);
      if (S.drawerId === id) closeDrawer();
      toastOk(`已删除 ${d ? d.ip : id}`, { title: '删除成功' });
      scheduleDataRefresh();
    } catch (e) { toastErr(errText(e), { title: `${d ? d.ip : id} 删除失败` }); }
  });
}

function deleteSelected() {
  const ids = selList();
  if (!ids.length) return;
  confirmDialog({
    title: `删除 ${ids.length} 台设备`, noteKind: 'danger', confirmLabel: '全部删除',
    note: ['将从本工具列表移除以下 ', htx('b', String(ids.length)), ' 台设备（不修改设备配置）：', el('div.mono', { style: { marginTop: '6px', maxHeight: '150px', overflow: 'auto' }, text: ids.join('\n'), }),],
  }).then(async (ok) => {
    if (!ok) return;
    let done = 0;
    for (const id of ids) {
      try { await api.delDevice(id); S.devices.delete(id); S.selected.delete(id); done++; }
      catch (e) { toastErr(`${ipOf(id)}：${errText(e)}`); }
    }
    if (S.drawerId && !S.devices.has(S.drawerId)) closeDrawer();
    toastOk(`已删除 ${done}/${ids.length} 台`, { title: '批量删除完成' });
    scheduleDataRefresh();
  });
}

/* ---------- 添加 / 导入 / 编辑 ---------- */
function openAddDevice(prefill = {}) {
  const ip = hinpm({ placeholder: '192.168.1.64', value: prefill.ip || '' });
  const port = hinpm({ value: String(prefill.port ?? 80) });
  const https = el('input', { type: 'checkbox', checked: !!prefill.https });
  const user = hinpm({ value: prefill.username || 'admin' });
  const pass = hinp({ type: 'password', placeholder: '设备密码' });
  const label = hinp({ placeholder: '例如：东门-球机', value: prefill.label || '' });
  const group = hinp({ placeholder: '例如：默认分组' });
  const err = el('div', { hidden: true });

  const submit = el('button.btn.btn-primary', { type: 'button', text: '探测并添加' });
  const doAdd = async () => {
    if (!isIPv4(ip.value)) { toastErr('请输入合法的 IPv4 地址', { title: '参数错误' }); ip.focus(); return; }
    const p = Number(port.value);
    if (!Number.isInteger(p) || p < 1 || p > 65535) { toastErr('端口需为 1–65535', { title: '参数错误' }); port.focus(); return; }
    submit.disabled = true; submit.textContent = '';
    submit.append(hspin(), document.createTextNode(' 添加中…'));
    err.hidden = true;
    try {
      const r = await api.addDevice({ ip: ip.value.trim(), port: p, https: https.checked, username: user.value.trim() || 'admin', password: pass.value, label: label.value.trim(), group: group.value.trim() });
      const online = r.probe ? r.probe.online : r.device?.status?.online;
      S.devices.set(r.device.id, r.device);
      toastOk(`${r.device.ip} ${online ? '在线' : '已加入但离线'}`, { title: '设备已添加' });
      m.close();
      scheduleDataRefresh();
    } catch (e) {
      // 契约：400 PROBE_FAILED 时设备仍会被写入
      if (e instanceof ApiError && (e.code === 'PROBE_FAILED' || e.status === 400)) {
        const dev2 = e.body && e.body.device;
        if (dev2 && dev2.id) { S.devices.set(dev2.id, dev2); scheduleRender(); }
        err.hidden = false;
        clear(err).append(hnote('warn', `设备已写入列表，但探测失败：${errText(e)}。请检查 IP / 端口 / 密码。`));
        toastWarn(`${ip.value} 已加入（离线）`, { title: '探测失败' });
        if (dev2) m.close();
      } else {
        err.hidden = false;
        clear(err).append(hnote('danger', `添加失败：${errText(e)}`));
        toastErr(errText(e), { title: '添加设备失败' });
      }
    } finally { submit.disabled = false; submit.textContent = '探测并添加'; }
  };
  ip.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

  const m = openModal({
    title: '添加设备',
    body: hdiv([
      hgrid([
        field('IP 地址', ip), field('端口', port),
        field('用户名', user), field('密码', pass),
        field('标签', label),
        el('label.checkline', { style: { alignSelf: 'end', height: '27px' } }, [https, htx('span', '使用 HTTPS')]),
        el('div.span2', null, field('分组', group)),
      ]),
      hnote('info', 'POST /api/devices：服务会立即探测一次设备信息。若探测失败（PROBE_FAILED），设备仍会写入列表但标记为离线。'),
      err,
    ]),
    footer: [hbtn('取消', () => m.close(), 'button btn'), submit],
  });
  submit.addEventListener('click', doAdd);
}

function openImport() {
  const ta = el('textarea.ta', { rows: '9', placeholder: '192.168.1.64,admin,pass123\n192.168.1.65,admin,pass456\n（每行一台：ip,用户名,密码；也可只填 ip）', spellcheck: 'false' });
  ta.value = getPref('lastImport', '');
  const defUser = hinpm({ value: 'admin' });
  const out = el('div');
  const btn = el('button.btn.btn-primary', { type: 'button', text: '开始导入' });
  btn.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) { toastErr('请粘贴至少一行设备信息', { title: '参数错误' }); return; }
    setPref('lastImport', text);
    btn.disabled = true; btn.textContent = ''; btn.append(hspin(), document.createTextNode(' 导入中…'));
    clear(out);
    try {
      const r = await api.importDevices(text, defUser.value.trim() || 'admin');
      if (r.taskId) registerTask(r.taskId, { action: 'import', total: r.added, startedAt: Date.now() });
      clear(out).append(hnotes('ok', [
        `新增 `, htx('b', String(r.added ?? 0)), ` 台，跳过 `, htx('b', String(r.skipped ?? 0)), ` 台。`,
        (r.failed && r.failed.length) ? el('div', { style: { marginTop: '6px' } }, [`失败 ${r.failed.length} 行：`, el('div.mono', { style: { maxHeight: '120px', overflow: 'auto' }, text: r.failed.map((f) => `${f.line} → ${f.reason}`).join('\n') })]) : null,
      ]));
      toastOk(`导入完成：新增 ${r.added ?? 0}，跳过 ${r.skipped ?? 0}`, { title: '批量导入' });
      await refreshDevices();
    } catch (e) {
      clear(out).append(hnote('danger', `导入失败：${errText(e)}`));
      toastErr(errText(e), { title: '导入失败' });
    } finally { btn.disabled = false; btn.textContent = '开始导入'; }
  });

  openModal({
    title: '批量导入设备',
    wide: true,
    body: hdiv([
      field('设备清单（每行 ip,用户名,密码）', ta),
      el('div', { style: { marginTop: '9px', maxWidth: '220px' } }, field('默认用户名（缺列时使用）', defUser)),
      hnote('info', 'POST /api/devices/import：body { text, defaultUsername }。重复设备会被 skipped。'),
      out,
    ]),
    footer: [hbtn('关闭', () => $('#modalRoot').hidden = true, 'button btn'), btn],
  });
}

function openEditDevice(id) {
  const d = dev(id);
  if (!d) return;
  const label = hinp({ value: d.label || '' });
  const group = hinp({ value: d.group || '' });
  const user = hinpm({ value: d.username || 'admin' });
  const pass = hinp({ type: 'password', placeholder: '留空则不修改' });
  const port = hinpm({ value: String(d.port ?? 80) });
  const https = el('input', { type: 'checkbox', checked: !!d.https });
  const btn = el('button.btn.btn-primary', { type: 'button', text: '保存' });
  btn.addEventListener('click', async () => {
    const patch = {};
    if (label.value.trim() !== (d.label || '')) patch.label = label.value.trim();
    if (group.value.trim() !== (d.group || '')) patch.group = group.value.trim();
    if (user.value.trim() !== (d.username || '')) patch.username = user.value.trim();
    if (pass.value) patch.password = pass.value;
    if (Number(port.value) !== d.port) patch.port = Number(port.value);
    if (https.checked !== !!d.https) patch.https = https.checked;
    if (!Object.keys(patch).length) { toastInfo('没有改动'); return; }
    btn.disabled = true; btn.textContent = ''; btn.append(hspin(), document.createTextNode(' 保存中…'));
    try {
      const r = await api.patchDevice(id, patch);
      if (r.device) { S.devices.delete(id); S.devices.set(r.device.id, r.device); if (S.drawerId === id) S.drawerId = r.device.id; }
      toastOk(`已更新 ${d.ip}`, { title: '保存成功' });
      m.close();
      scheduleDataRefresh();
    } catch (e) { toastErr(errText(e), { title: `${d.ip} 保存失败` }); }
    finally { btn.disabled = false; btn.textContent = '保存'; }
  });
  const m = openModal({
    title: `编辑设备 · ${d.ip}`,
    body: hgrid([
      field('标签', label), field('分组', group),
      field('用户名', user), field('密码（留空不改）', pass),
      field('端口', port),
      el('label.checkline', { style: { alignSelf: 'end', height: '27px' } }, [https, htx('span', '使用 HTTPS')]),
      el('div.span2', null, hnote('warn', '修改 IP / 端口 / HTTPS 会改变设备 ID（ip:port）。')),
    ]),
    footer: [hbtn('取消', () => m.close(), 'button btn'), btn],
  });
}

// 批量操作
async function bulkRun(action, params) {
  const ids = selList();
  if (!ids.length) { toastWarn('请先勾选设备'); return; }
  const ask = {
    probe: { title: '批量探测', note: `将对 ${ids.length} 台设备执行一次设备信息探测。`, kind: 'warn' },
    reboot: { title: '批量重启', note: `将对 ${ids.length} 台设备下发重启，设备会中断 30–60 秒。确认继续？`, kind: 'danger' },
  }[action] || { title: '批量操作', note: `对 ${ids.length} 台设备执行 ${action}。`, kind: 'warn' };
  const ok = await confirmDialog({ title: ask.title, noteKind: ask.kind, confirmLabel: '确认执行', note: [ask.note, el('div.mono', { style: { marginTop: '6px', maxHeight: '130px', overflow: 'auto' }, text: ids.join('\n') })] });
  if (!ok) return;
  try {
    const r = await api.batch(ids, action, params || {}, getPref('batchConcurrency', 16));
    registerTask(r.taskId, { action, total: ids.length, startedAt: Date.now() });
    toastInfo(`任务已下发：${r.taskId}（${ids.length} 台）`, { title: actionLabel(action) });
    if (action !== 'probe') setTimeout(refreshDevices, 3000);
  } catch (e) { toastErr(errText(e), { title: '批量任务下发失败' }); }
}

async function bulkReset(mode) {
  const ids = selList();
  if (!ids.length) { toastWarn('请先勾选设备'); return; }
  const full = mode === 'full';
  const r = await confirmDanger({
    title: full ? '批量完全恢复 · 确认' : '批量简单恢复 · 确认',
    confirmLabel: full ? '执行完全恢复' : '执行简单恢复',
    note: [
      htx('b', full ? '完全恢复：恢复默认参数，包括 IP 地址等，设备所有参数恢复至出厂默认。' : '简单恢复：恢复参数，但不包括 IP 地址；设备除用户名、密码、激活状态、网络参数外，恢复至出厂默认。'),
      el('br'),
      `将对 ${ids.length} 台设备执行该操作（每台设备使用各自已保存的密码）。`,
    ],
    extraNote: full ? '批量完全恢复后所有设备 IP 都会回到出厂默认，需要重新 SADP 发现并激活。' : '恢复期间设备会断连并重启。',
  });
  if (!r.ok) return;
  try {
    const t = await api.batch(ids, 'reset', { mode }, getPref('batchConcurrency', 16));
    registerTask(t.taskId, { action: full ? 'reset-full' : 'reset-basic', total: ids.length, startedAt: Date.now() });
    toastInfo(`恢复任务已下发：${t.taskId}`, { title: full ? '完全恢复' : '简单恢复' });
  } catch (e) { toastErr(errText(e), { title: '恢复任务下发失败' }); }
}

function bulkSetTime() {
  const ids = selList();
  if (!ids.length) { toastWarn('请先勾选设备'); return; }
  const radio = (v, label, checked) => {
    const i = el('input', { type: 'radio', name: 'bmode', value: v, checked, id: `bm-${v}` });
    return el('label', { for: `bm-${v}`, style: { display: 'inline-flex', gap: '6px', alignItems: 'center', cursor: 'pointer', marginRight: '14px' } }, [i, htx('span', label)]);
  };
  const dt = hinp({ type: 'datetime-local', value: toLocalInput(new Date()) });
  const ntp = hinpm({ value: 'pool.ntp.org' });
  const btn = el('button.btn.btn-primary', { type: 'button', text: '下发对时' });
  btn.addEventListener('click', async () => {
    const mode = ($$('input[name=bmode]').find((n) => n.checked) || { value: 'pc' }).value;
    let params;
    if (mode === 'pc') params = { mode: 'pc' };
    else if (mode === 'manual') params = { mode: 'manual', dateTime: dt.value };
    else params = { mode: 'ntp', server: ntp.value.trim(), port: 123, intervalMinutes: 60 };
    m.close();
    await bulkRun('setTime', params);
  });
  const m = openModal({
    title: `批量对时 · ${ids.length} 台`,
    body: hdiv([
      hdiv([radio('pc', '用电脑时间', true), radio('manual', '手动', false), radio('ntp', 'NTP', false)]),
      el('div', { style: MT }, [field('手动时间', dt), el('div', { style: { height: '8px' } }), field('NTP 服务器', ntp)]),
      hnote('info', 'POST /api/batch action=setTime，params 与 PUT /api/devices/:id/time 相同。'),
    ]),
    footer: [hbtn('取消', () => m.close(), 'button btn'), btn],
  });
}

function bulkNetwork() {
  const ids = selList();
  if (!ids.length) { toastWarn('请先勾选设备'); return; }
  const mask = hinpm({ value: '255.255.255.0' });
  const gw = hinpm({ placeholder: '192.168.1.1' });
  const dns = hinpm({ placeholder: '8.8.8.8' });
  const dhcp = el('input', { type: 'checkbox' });
  const btn = el('button.btn.btn-primary', { type: 'button', text: '下发网络配置' });
  btn.addEventListener('click', async () => {
    m.close();
    await bulkRun('setNetwork', { interfaceId: 1, mask: mask.value, gateway: gw.value, dns: dns.value, dhcp: dhcp.checked });
  });
  const m = openModal({
    title: `批量改网络 · ${ids.length} 台`,
    body: hdiv([
      hnote('warn', '⚠ 批量改网络不会改变 IP 本身（API 契约的批量 setNetwork 不接收 ip 字段），只统一下发掩码 / 网关 / DNS / DHCP。单台改 IP 请在设备详情的“网络”页操作。'),
      hgrid([field('子网掩码', mask), field('默认网关', gw), field('DNS', dns), el('label.checkline', { style: { alignSelf: 'end', height: '27px' } }, [dhcp, htx('span', '启用 DHCP')])]),
    ]),
    footer: [hbtn('取消', () => m.close(), 'button btn'), btn],
  });
}

function bulkPassword() {
  const ids = selList();
  if (!ids.length) { toastWarn('请先勾选设备'); return; }
  const user = hinpm({ value: 'admin' });
  const np = hinp({ type: 'password', placeholder: '新密码' });
  const np2 = hinp({ type: 'password', placeholder: '再次输入' });
  const btn = el('button.btn.btn-primary', { type: 'button', text: '下发新密码' });
  btn.addEventListener('click', async () => {
    if (!np.value) { toastErr('请填写新密码', { title: '参数错误' }); return; }
    if (np.value !== np2.value) { toastErr('两次输入不一致', { title: '参数错误' }); return; }
    m.close();
    await bulkRun('setPassword', { userName: user.value.trim() || 'admin', newPassword: np.value });
  });
  const m = openModal({
    title: `批量改密码 · ${ids.length} 台`,
    body: hdiv([
      hnote('warn', '每台设备使用其各自已保存的当前密码登录；新密码对所有选中设备相同。若与设备密码策略不符会逐台失败。'),
      hgrid([field('用户名', user), el('div'), field('新密码', np), field('确认新密码', np2)]),
    ]),
    footer: [hbtn('取消', () => m.close(), 'button btn'), btn],
  });
}

function bulkUpgrade() {
  const ids = selList();
  if (!ids.length) { toastWarn('请先勾选设备'); return; }
  const path = hinpm({ placeholder: 'D:\\fw\\IPC_R0.dav', value: getPref('lastFwPath', '') });
  const conc = hinpm({ value: '4' });
  const btn = el('button.btn.btn-primary', { type: 'button', text: '开始批量升级' });
  btn.addEventListener('click', async () => {
    const fp = path.value.trim();
    if (!fp) { toastErr('请填写服务器本地固件路径', { title: '参数错误' }); return; }
    m.close();
    const ok = await confirmDialog({ title: '确认批量升级', noteKind: 'danger', confirmLabel: '开始升级', note: ['将对 ', htx('b', String(ids.length)), ' 台设备下发固件 ', htx('code.type-confirm', fp), '。升级期间设备会重启并中断业务，请勿断电。'] });
    if (!ok) return;
    try {
      setPref('lastFwPath', fp);
      const r = await api.batchUpgrade(ids, fp, Number(conc.value) || 4);
      registerTask(r.taskId, { action: 'upgrade', total: ids.length, startedAt: Date.now() });
      toastInfo(`批量升级任务已下发：${r.taskId}`, { title: '已开始' });
    } catch (e) { toastErr(errText(e), { title: '批量升级下发失败' }); }
  });
  const m = openModal({
    title: `批量升级 · ${ids.length} 台`,
    body: hgrid([el('div.span2', null, field('固件路径（服务器本地）', path)), field('并发数', conc)]),
    footer: [hbtn('取消', () => m.close(), 'button btn'), btn],
  });
}

/* ==================== 激活设备对话框（行内按钮与批量按钮共用，API.md §3.5） ==================== */
/** 读取（并缓存）GET /api/activate/config —— 密码与规则都来自它，前端不硬编码密码 */
async function loadActivateConfig() {
  if (S.activateCfg && Date.now() - S.activateCfg.at < ACT_CFG_TTL) return S.activateCfg.cfg;
  const cfg = await api.activateConfig();
  S.activateCfg = { cfg: cfg || {}, at: Date.now() };
  return S.activateCfg.cfg;
}

/**
 * openActivateDialog([{ip,port}]) —— 同一个组件服务单台与批量：
 * 单台走 POST /api/activate（同步返回），多台走 POST /api/activate/batch（异步任务 + SSE 进度）。
 */
function openActivateDialog(targets) {
  const multi = targets.length > 1;
  let cfg = Object.assign({}, ACT_FALLBACK);
  let sending = false;

  const pass = hinp({ type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: '设备管理员密码', 'aria-label': '激活密码' });
  const eye = hbtn('显示', () => { const hide = pass.type === 'password'; pass.type = hide ? 'text' : 'password'; eye.textContent = hide ? '隐藏' : '显示'; }, 'button btn btn-sm');
  const hint = htx('div.sub', '正在读取激活规则…');
  const cfgErr = el('div', { hidden: true });
  const errNote = el('div.note.note-danger', { hidden: true });
  const prog = el('div', { hidden: true });
  const confirmBtn = el('button.btn.btn-primary', { type: 'button', text: '激活' });

  const revalidate = () => {
    const msg = pwError(pass.value, cfg);
    errNote.textContent = msg;
    errNote.hidden = !msg;
    confirmBtn.disabled = sending || !!msg;
  };

  const body = hdiv([
    hsec(multi ? `目标设备（${targets.length} 台）` : '目标设备'),
    el('div.act-list', null, targets.map((t) => htx('div', dkey(t.ip, t.port)))),
    el('div', MT, [
      field('密码', pass),
      el('div', { style: { marginTop: '6px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [eye, hint]),
    ]),
    cfgErr, errNote,
    hnote('warn', '激活将把设备管理员密码设置为上面填写的值，之后可用「密码」页修改。'),
    prog,
  ]);

  const m = openModal({
    title: '激活设备',
    body,
    footer: [hbtn('取消', () => m.close(), 'button btn'), confirmBtn],
    onClose: () => { if (actDlg && actDlg.modal === m) actDlg = null; },
  });

  pass.addEventListener('input', revalidate);
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click(); });

  // 预填密码：来自 GET /api/activate/config 的 defaultPassword
  (async () => {
    try {
      const c = await loadActivateConfig();
      cfg = Object.assign({}, ACT_FALLBACK, c || {});
      if (cfg.defaultPassword) pass.value = cfg.defaultPassword;
      hint.textContent = ruleText(cfg);
    } catch (e) {
      clear(cfgErr).append(hnote('warn', `未能读取激活配置（GET /api/activate/config）：${errText(e)}。已改用默认规则，请手动填写密码。`));
      cfgErr.hidden = false;
      hint.textContent = ruleText(cfg);
    }
    revalidate();
  })();

  confirmBtn.addEventListener('click', async () => {
    const msg = pwError(pass.value, cfg);
    if (msg) { errNote.textContent = msg; errNote.hidden = false; return; }
    sending = true;
    confirmBtn.disabled = true;
    eye.disabled = true;
    pass.disabled = true;
    confirmBtn.textContent = '';
    confirmBtn.append(hspin(), htext(' 激活中…'));
    prog.hidden = false;
    clear(prog).append(el('div.sub', null, [hspin(), multi ? ` 正在下发批量激活任务（${targets.length} 台）…` : ' 正在激活…']));
    try {
      if (multi) {
        const r = await api.activateBatch(targets, pass.value, { autoAdd: true, concurrency: Number(cfg.defaultConcurrency) || 8 });
        registerTask(r.taskId, { action: 'activate', total: targets.length, startedAt: Date.now() });
        actDlg = { taskId: r.taskId, modal: m, panel: actPanel(targets), total: targets.length, confirm: confirmBtn };
        clear(prog).append(actDlg.panel.log);
        toastInfo(`批量激活任务已下发：${targets.length} 台`, { title: '设备激活' });
      } else {
        const t = targets[0];
        const r = await api.activate(t, pass.value, { autoAdd: true });
        if (r && r.device && r.device.id) S.devices.set(r.device.id, r.device);
        clear(prog).append(hnotes('ok', [
          htx('b', `✔ ${dkey(t.ip, t.port)} 激活成功`),
          el('div', { style: { marginTop: '5px' }, text: r && r.message ? r.message : '设备已激活并加入设备库，正在刷新列表…' }),
        ]));
        toastOk(`激活成功：${t.ip}`, { title: '设备激活' });
        markActivated(t.ip, t.port);
        await refreshDevices();
        // 刚激活的设备 ISAPI 栈可能还没就绪，复探一次让列表状态立刻正确
        await reprobeActivated([dkey(t.ip, t.port)]).catch(() => {});
        refreshDevices();
        setTimeout(() => m.close(), 900);
      }
    } catch (e) {
      sending = false;
      confirmBtn.disabled = false; eye.disabled = false; pass.disabled = false;
      confirmBtn.textContent = '激活';
      clear(prog).append(hnote('danger', `激活失败：${errText(e)}`));
      toastErr(errText(e), { title: multi ? `批量激活下发失败（${targets.length} 台）` : `${dkey(targets[0].ip, targets[0].port)} 激活失败` });
    }
  });
}

/** 批量激活的进度面板：每台一行，先全部「等待中…」，随后由 SSE 的 task.progress 逐台填充 */
function actPanel(targets) {
  const log = el('div.log', { style: { maxHeight: '180px' } });
  const rows = new Map();
  for (const t of targets) {
    const lm = el('span.lm.pending', { text: '等待中…' });
    log.append(hdiv([htx('span.li', dkey(t.ip, t.port)), lm]));
    rows.set(String(t.ip), { lm, state: '', port: t.port });
  }
  return { log, rows, ok: 0, failed: 0 };
}

/** task.progress → 对话框里的一行（键用 IP：SSE 的 data.id 是 "ip"，detail.deviceId 是 "ip:port"） */
function actOnProgress(data) {
  if (!actDlg || data.taskId !== actDlg.taskId) return;
  actRenderResult({ id: String(data.id || '').split(':')[0], state: data.state, message: data.message, ms: data.ms });
}

const ACT_STATE = { ok: '成功', failed: '失败', skipped: '跳过', running: '进行中', pending: '待执行' };

function actRenderResult(r) {
  const rec = actDlg && actDlg.panel.rows.get(String(r.id || '').split(':')[0]);
  if (!rec) return;
  const st = r.state || 'running';
  if (rec.state !== 'ok' && rec.state !== 'failed' && (st === 'ok' || st === 'failed')) {
    if (st === 'ok') actDlg.panel.ok++; else actDlg.panel.failed++;
  }
  rec.state = st;
  rec.lm.className = `lm ${st}`;
  rec.lm.textContent = `${ACT_STATE[st] || st}${r.ms ? ` · ${fmtDur(r.ms)}` : ''}${r.message ? ` · ${r.message}` : ''}`;
}

/** task.done → 补齐可能错过的逐台结果，展示汇总，然后收起对话框 */
async function actOnDone(taskId, sum) {
  if (!actDlg || actDlg.taskId !== taskId) return;
  const dlg = actDlg;
  const p = dlg.panel;
  try {
    const d = await api.task(taskId);
    if (actDlg === dlg) for (const r of d.results || []) actRenderResult(r);
  } catch { /* 逐台结果只是锦上添花，汇总仍是权威 */ }
  if (actDlg !== dlg) return;
  for (const [ip, rec] of p.rows) {
    if (!rec.state) { rec.lm.className = 'lm skipped'; rec.lm.textContent = '已结束（无逐台结果）'; }
    if (rec.state === 'ok') markActivated(ip, rec.port);
  }
  // 复探刚激活成功的设备，让设备列表状态与发现页保持一致
  const activatedIds = [];
  for (const [ip, rec] of p.rows) if (rec.state === 'ok') activatedIds.push(dkey(ip, rec.port));
  if (activatedIds.length) reprobeActivated(activatedIds).catch(() => {});
  const ok = sum && sum.ok !== undefined ? sum.ok : p.ok;
  const failed = sum && sum.failed !== undefined ? sum.failed : p.failed;
  p.log.insertAdjacentElement('afterend', hnotes(failed ? 'warn' : 'ok', [
    htx('b', `激活完成：成功 ${ok} 台，失败 ${failed} 台`),
    sum && sum.elapsedMs ? el('div.sub', { style: MT, text: `用时 ${fmtDur(sum.elapsedMs)}｜成功的设备已自动加入设备库` }) : null,
  ]));
  const foot = dlg.modal.foot;
  if (foot && dlg.confirm && dlg.confirm.isConnected) {
    dlg.confirm.disabled = true;
    const cancel = foot.querySelector('button');
    if (cancel) cancel.replaceWith(hbtn('关闭', () => dlg.modal.close(), 'button btn btn-primary'));
  }
  setTimeout(() => { if (actDlg === dlg) dlg.modal.close(); }, 2200);
}

// 任务存储 + 任务栏
function registerTask(taskId, init = {}) {
  if (!taskId) return null;
  let t = S.tasks.get(taskId);
  if (!t) {
    t = { taskId, action: init.action || '', state: 'running', total: init.total || 0, done: 0, results: new Map(), startedAt: init.startedAt || Date.now(), finishedAt: 0, expanded: false, detailLoading: false };
    S.tasks.set(taskId, t);
  } else {
    if (init.action) t.action = init.action;
    if (init.total) t.total = init.total;
  }
  if (getPref('taskbarHidden', false)) setPref('taskbarHidden', false);
  return t;
}

function upsertResult(t, r) {
  if (!t || !r) return;
  const key = r.id || `${t.taskId}:${t.results.size}`;
  const prev = t.results.get(key);
  const rec = {
    id: r.id || key, state: r.state || (prev && prev.state) || 'pending',
    message: r.message !== undefined ? r.message : (prev ? prev.message : ''),
    ms: r.ms !== undefined ? r.ms : (prev ? prev.ms : 0),
    percent: r.percent !== undefined ? r.percent : (prev ? prev.percent : undefined),
    at: Date.now(),
  };
  const wasTerminal = prev && ['ok', 'failed', 'skipped'].includes(prev.state);
  t.results.set(key, rec);
  if (!wasTerminal && ['ok', 'failed', 'skipped'].includes(rec.state)) t.done = (t.done || 0) + 1;
  if (S.tab === 'upgrade' && S.drawerId) { /* 由整体渲染刷新 */ }
}

function renderTaskbar() {
  const bar = $('#taskbar');
  const host = $('#taskbarList');
  if (!bar || !host) return;
  const all = Array.from(S.tasks.values()).sort((a, b) => {
    const ar = a.state === 'running' ? 0 : 1, br = b.state === 'running' ? 0 : 1;
    if (ar !== br) return ar - br;
    return (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0);
  });
  const visible = all.filter((t) => t.state === 'running' || (t.finishedAt && Date.now() - t.finishedAt < 20000));
  const hidden = getPref('taskbarHidden', false);
  bar.hidden = hidden || visible.length === 0;
  document.querySelector('.app').classList.toggle('has-taskbar', !bar.hidden);
  if (bar.hidden) return;
  clear(host);
  for (const t of visible.slice(0, 6)) {
    const pct = taskPercent(t);
    host.append(el('div.tb-item', {
      role: 'button', tabindex: '0', title: '查看任务详情',
      onclick: () => { setView('tasks'); t.expanded = true; setPref('taskbarHidden', true); loadTaskDetail(t.taskId); scheduleRender('view', 'cards', 'taskbar'); },
      onkeydown: (e) => { if (e.key === 'Enter') { setView('tasks'); t.expanded = true; setPref('taskbarHidden', true); loadTaskDetail(t.taskId); scheduleRender('view', 'cards', 'taskbar'); } },
    }, [
      el('div.tb-top', null, [
        statusDot(t.state === 'done' ? true : t.state === 'failed' ? false : undefined),
        htx('span.tb-name', `${actionLabel(t.action)} ${t.total ? `(${t.total})` : ''}`),
        el('span', { class: t.state === 'running' ? 'badge-busy badge' : t.state === 'done' ? 'badge-ok badge' : 'badge-bad badge', text: stateLabel(t.state) }),
      ]),
      meter(pct, t.state === 'done' ? 'ok' : t.state === 'failed' ? 'warn' : ''),
      el('div.tb-meta', null, [htx('span', t.taskId), htx('span', `${t.done}/${t.total || '?'}`)]),
    ]));
  }
}

// SSE
let es = null;
let opened = false;
function setSseState(state) {
  const pill = $('#ssePill'), dot = $('#sseDot'), text = $('#sseText');
  if (!pill) return;
  pill.classList.toggle('pill-ok', state === 'open');
  pill.classList.toggle('pill-bad', state === 'error');
  dot.className = `dot ${state === 'open' ? 'dot-on' : state === 'error' ? 'dot-off' : 'dot-busy'}`;
  text.textContent = state === 'open' ? '事件流已连接' : state === 'error' ? '已断开' : '连接中';
  pill.title = state === 'open' ? 'SSE /api/events 已连接' : state === 'error' ? 'SSE 已断开，浏览器会自动重连' : '正在连接 SSE /api/events';
}

function connectSSE() {
  setSseState('connecting');
  try { es = new EventSource('/api/events'); }
  catch (e) { setSseState('error'); return; }
  es.onopen = () => {
    setSseState('open');
    if (!opened) { opened = true; return; }
    // 重连后补偿可能错过的事件
    refreshDevices();
    loadTasks(false);
  };
  es.onerror = () => setSseState('error');
  es.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || !msg.type) return;
    routeEvent(msg.type, msg.data || {});
  };
}

function routeEvent(type, data) {
  switch (type) {
    case 'task.start': {
      const t = registerTask(data.taskId, { action: data.action, total: data.total, startedAt: Date.now() });
      if (t && data.action) t.action = data.action;
      if (data.total) t.total = data.total;
      scheduleRender('taskbar', 'cards', 'chrome');
      break;
    }
    case 'task.progress': {
      const t = registerTask(data.taskId, { action: data.action });
      if (data.total && !t.total) t.total = data.total;
      const devId = data.id || data.deviceId;
      if (devId) upsertResult(t, { id: devId, state: data.state, message: data.message, ms: data.ms, percent: data.percent });
      actOnProgress(data);   // 激活任务：同一份结果同时喂给对话框里的逐台进度
      if (S.view === 'tasks' && !t.expanded) t.expanded = true;
      scheduleRender('taskbar', 'cards', 'chrome');
      break;
    }
    case 'task.done': {
      const sum = data.summary || {};
      const t = registerTask(data.taskId, {});
      t.state = (sum.failed && !sum.ok) ? 'failed' : 'done';
      t.finishedAt = Date.now();
      t.summary = sum;
      if (sum.total) t.total = sum.total;
      if (sum.ok !== undefined || sum.failed !== undefined) t.done = Math.max(t.done || 0, (sum.ok || 0) + (sum.failed || 0) + (sum.skipped || 0));
      if (sum.elapsedMs) t.elapsedMs = sum.elapsedMs;
      if (t.action === 'scan' && S.scan) {
        S.scan.state = 'done';
        S.scan.scanned = sum.scanned ?? S.scan.scanned;
        S.scan.found = sum.found ?? S.scan.found;
        S.scan.elapsedMs = sum.elapsedMs ?? (Date.now() - S.scan.startedAt);
        toastOk(`扫描完成：扫描 ${S.scan.scanned} 个地址，发现 ${S.scan.found} 台`, { title: 'IP 段扫描' });
        if (S.view === 'discover') {
          renderScanStatus($('#scanStat'), $('#scanBar'));
          renderScanResults();
        } else scheduleRender('view');
      } else if (t.action === 'activate') {
        // 激活任务的汇总文案按需求固定为「激活完成：成功 N 台，失败 M 台」
        const msg = `激活完成：成功 ${sum.ok ?? 0} 台，失败 ${sum.failed ?? 0} 台`;
        if (sum.failed) toastWarn(msg, { title: '设备激活' }); else toastOk(msg, { title: '设备激活' });
        actOnDone(data.taskId, sum);
      } else {
        const label = actionLabel(t.action);
        if (t.state === 'failed') toastWarn(`${label} 完成：成功 ${sum.ok ?? 0}，失败 ${sum.failed ?? 0}`, { title: `任务 ${data.taskId}` });
        else toastOk(`${label} 完成：成功 ${sum.ok ?? 0}/${sum.total ?? t.total ?? '?'}${sum.elapsedMs ? ` · ${fmtDur(sum.elapsedMs)}` : ''}`, { title: `任务 ${data.taskId}` });
      }
      setTimeout(refreshDevices, 800);
      scheduleRender('taskbar', 'cards', 'chrome');
      break;
    }
    case 'scan.result': {
      if (!S.scan) S.scan = { state: 'running', scanned: 0, found: 0, total: 0, startedAt: Date.now(), rows: new Map(), taskId: '' };
      S.scan.scanned++;
      S.scan.rows.set(data.ip, {
        ip: data.ip, found: !!data.found, model: data.model, serialNumber: data.serialNumber,
        latencyMs: data.latencyMs, port: data.port || 80,
        // 可选字段：服务端若在扫描结果里带上激活 / 萤石云信息，就地展示（缺失时按“未知”渲染）
        activated: data.activated, ezvizBindStatus: data.ezvizBindStatus,
        supportEzvizUnbind: data.supportEzvizUnbind, hcPlatformEnable: data.hcPlatformEnable,
      });
      if (data.found) S.scan.found++;
      // 仅就地刷新扫描面板，避免打断用户输入
      if (S.view === 'discover' && $('#scanHost')) {
        if (data.found) renderScanResults();
        renderScanStatus($('#scanStat'), $('#scanBar'));
        const scanBtn = $('#scanPaneBtn');
        if (scanBtn) { scanBtn.disabled = true; scanBtn.textContent = '扫描中…'; }
      } else {
        scheduleRender('view');
      }
      break;
    }
    case 'upgrade.progress': {
      const t = registerTask(data.taskId, { action: 'upgrade' });
      upsertResult(t, { id: data.id, state: data.status || (data.percent >= 100 ? 'ok' : 'running'), message: data.status, percent: data.percent });
      if (data.percent !== undefined) t.percent = data.percent;
      if (S.view === 'tasks') scheduleRender('cards');
      if (S.drawerId && S.tab === 'upgrade') renderUpgradeProgressInDrawer();
      scheduleRender('taskbar', 'chrome');
      break;
    }
    case 'device.status': {
      const id = data.id || data.deviceId;
      const d = S.devices.get(id);
      if (!d) return;
      const wasOnline = d.status ? d.status.online : undefined;
      d.status = Object.assign({}, d.status, data.status || data, { checkedAt: Date.now() });
      if (d.status.online !== wasOnline) { scheduleRender('view'); break; }
      // 状态色未变：只就地更新行内元素
      const row = $(`tr[data-id="${CSS.escape(id)}"]`);
      if (row && S.view === 'devices') {
        const cell = row.querySelector('td:nth-child(2)');
        if (cell) clear(cell).append(...statusCell(d));
        const latCell = row.querySelector('td:nth-child(8)');
        if (latCell && d.status.latencyMs !== undefined) latCell.textContent = String(d.status.latencyMs ?? '—');
        const ezCell = row.querySelector('td:nth-child(9)');
        if (ezCell) clear(ezCell).append(ezvizCell(d));
      }
      scheduleRender('chrome');
      if (S.drawerId === id && S.tab === 'overview') updateOverviewValues(d);
      break;
    }
    default:
      break;
  }
}

function renderUpgradeProgressInDrawer() {
  const host = $('#upHost');
  if (host) renderUpgradeList(host);
}

/** device.status 事件：就地更新概览页的状态字段，不重建画面 */
function updateOverviewValues(d) {
  const st = d.status || {};
  const set = (id, v) => { const n = $(`#${id}`); if (n) n.textContent = v; };
  set('dwOnline', st.online === true ? '在线' : st.online === false ? '离线' : '未知');
  set('dwLatency', st.latencyMs === null || st.latencyMs === undefined ? '—' : `${st.latencyMs} ms`);
  set('dwChecked', st.checkedAt ? fmtTime(st.checkedAt) : '—');
  const errBox = $('#dwErr');
  if (errBox) overviewAlerts(errBox, st);
}

// 服务状态轮询
async function pollHealth() {
  try {
    const h = await api.health();
    S.health = h;
    const dot = $('#svcDot'), text = $('#svcText');
    dot.className = `dot ${h && h.ok ? 'dot-on' : 'dot-warn'}`;
    text.textContent = `服务 v${(h && h.version) || '?'} · :${(h && h.port) ?? location.port}`;
    $('#svcPill').title = `GET /api/health → ${JSON.stringify(h)}`;
  } catch (e) {
    const dot = $('#svcDot'), text = $('#svcText');
    dot.className = 'dot dot-off';
    text.textContent = '服务不可用';
    $('#svcPill').title = `服务探测失败：${errText(e)}`;
  }
}

// 启动
function setView(v, opts = {}) {
  if (!VIEWS.some((x) => x.key === v)) v = 'devices';
  S.view = v;
  setPref('view', v);
  if (!opts.keepHash) { try { history.replaceState(null, '', `#/${v}`); } catch { /* ignore */ } }
  scheduleRender('view', 'chrome', 'drawerHead');
}

function setTab(v) {
  if (!TAB_KEYS.includes(v)) v = 'overview';
  S.tab = v;
  setPref('tab', v);
  scheduleRender('drawer', 'drawerHead');
}

function bindShell() {
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) setView(b.dataset.view);
  });
  const app = $('.app');
  if (getPref('sidebarCollapsed', false)) app.classList.add('side-collapsed');
  const toggleSide = () => {
    const c = app.classList.toggle('side-collapsed');
    setPref('sidebarCollapsed', c);
    $('#navToggle').setAttribute('aria-label', c ? '展开侧边栏' : '折叠侧边栏');
  };
  $('#navToggle').addEventListener('click', toggleSide);

  $('#dwTabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) setTab(t.dataset.tab); });
  $('#dwTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TAB_KEYS.indexOf(S.tab);
    const n = e.key === 'ArrowRight' ? (i + 1) % TAB_KEYS.length : (i - 1 + TAB_KEYS.length) % TAB_KEYS.length;
    e.preventDefault();
    setTab(TAB_KEYS[n]);
    $(`#dwTabs .tab[data-tab="${TAB_KEYS[n]}"]`).focus();
  });
  $('#dwClose').addEventListener('click', closeDrawer);
  $('#dwId').addEventListener('click', () => doCopy(S.drawerId));
  $('#dwId').setAttribute('role', 'button');
  $('#dwId').tabIndex = 0;
  $('#dwId').addEventListener('keydown', (e) => { if (e.key === 'Enter') doCopy(S.drawerId); });

  $('#btnRefresh').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    const orig = b.textContent;
    b.textContent = '刷新中…';
    await Promise.all([refreshDevices(), pollHealth(), loadTasks(false)]);
    b.disabled = false;
    b.textContent = orig;
  });
  $('#ssePill').addEventListener('click', () => {
    if (es && es.readyState === EventSource.OPEN) toastInfo('SSE /api/events 已连接');
    else { toastWarn('SSE 已断开，正在重连…'); try { es && es.close(); } catch { /* ignore */ } connectSSE(); }
  });
  $('#svcPill').addEventListener('click', () => {
    pollHealth().then(() => toastInfo(`GET /api/health → ${JSON.stringify(S.health)}`, { title: '服务状态' }));
  });

  $('#taskbarAll').addEventListener('click', () => { setPref('taskbarHidden', false); setView('tasks'); });
  $('#taskbarHide').addEventListener('click', () => { setPref('taskbarHidden', true); scheduleRender('taskbar'); });

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input,textarea,select,[contenteditable]');
    if (e.key === 'Escape') {
      if (!$('#drawer').hidden) { closeDrawer(); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); $('#btnRefresh').click(); }
    else if (e.key === '/') { e.preventDefault(); setView('devices'); setTimeout(() => $('#devSearch')?.focus(), 30); }
    else if (e.key === 'g') { setView('devices'); }
    else if (e.key === 'd') { setView('discover'); }
    else if (e.key === 't') { setView('tasks'); }
    else if (e.key === 'p') { setView('report'); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSide(); }
  });

  $('#modalBackdrop').addEventListener('click', () => { $('#modalRoot').hidden = true; });
  $('#modalClose').addEventListener('click', () => { $('#modalRoot').hidden = true; });

  window.addEventListener('hashchange', () => {
    const v = (location.hash || '').replace(/^#\/?/, '');
    if (VIEWS.some((x) => x.key === v) && v !== S.view) setView(v, { keepHash: true });
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollHealth(); });
  window.addEventListener('focus', debounce(() => { pollHealth(); }, 400));
}

function boot() {
  try {
    bindShell();
    // 先读 hash 再 setView：setView(..., {keepHash:false}) 会把 URL 改写成当前视图，
    // 如果先调用，深链接（如 /#/console、书签、刷新前的地址）会被立刻覆盖成 #/devices。
    const hashView = (location.hash || '').replace(/^#\/?/, '');
    const startView = VIEWS.some((x) => x.key === hashView) ? hashView : S.view;
    setView(startView, { keepHash: false });
    refreshDevices();
    pollHealth();
    loadTasks(false);
    connectSSE();
    setInterval(pollHealth, 30000);
    setInterval(() => { if (document.visibilityState === 'visible' && !anyModalOpen()) refreshDevices(); }, 60000);
    setInterval(() => {
      const running = Array.from(S.tasks.values()).some((t) => t.state === 'running');
      if (running) scheduleRender('taskbar');
    }, 1000);
  } catch (e) {
    showFatal('启动', e);
  }
}

// 未捕获异常也要可见（否则页面可能停在半渲染状态）
window.addEventListener('error', (e) => {
  if (e && e.message) showFatal('未捕获异常', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  if (r instanceof ApiError) return;           // 接口错误已在各调用点提示
  showFatal('未处理的 Promise 拒绝', r);
});

document.addEventListener('DOMContentLoaded', () => {
  try { boot(); } catch (e) { showFatal('启动', e); }
});
