// ui.js — 自制模态框 / 轻提示 / 下拉菜单 / 表单部件。不使用 alert() 与 confirm()。
import { el, $, $$, append, clear, uid, errText, copyText } from './util.js';

/* ============================ Toast ============================ */
let toastBox = null;
const ICONS = { ok: '✔', err: '✖', warn: '⚠', info: 'ℹ' };

/** toast('消息', {kind:'ok'|'err'|'warn'|'info', title, timeout}) → 返回 {close} */
export function toast(message, opts = {}) {
  if (!toastBox) toastBox = $('#toasts');
  if (!toastBox) return { close() {} };
  const kind = opts.kind || 'info';
  const body = el('div.tbody', null, [
    opts.title ? el('div.tt', { text: opts.title }) : null,
    message ? el('div.tm', { text: message }) : null,
  ]);
  const node = el('div.toast', { class: `toast-${kind}`, role: kind === 'err' ? 'alert' : 'status' }, [
    el('span.tico', { text: ICONS[kind] || ICONS.info, 'aria-hidden': 'true' }),
    body,
    el('button.tx', { type: 'button', 'aria-label': '关闭提示', text: '✕', onclick: () => close() }),
  ]);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    node.classList.add('out');
    setTimeout(() => node.remove(), 150);
  }
  toastBox.append(node);
  while (toastBox.children.length > 5) toastBox.firstElementChild.remove();
  const ms = opts.timeout === undefined ? (kind === 'err' ? 7000 : 3600) : opts.timeout;
  if (ms > 0) setTimeout(close, ms);
  return { close };
}
export const toastOk = (m, o) => toast(m, { kind: 'ok', ...o });
export const toastErr = (m, o) => toast(m, { kind: 'err', ...o });
export const toastWarn = (m, o) => toast(m, { kind: 'warn', ...o });
export const toastInfo = (m, o) => toast(m, { kind: 'info', ...o });

/* ============================ Modal ============================ */
const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
let activeModal = null;

/**
 * openModal({title, body, footer, wide, onClose}) → {close, root, body}
 * body/footer 可以是 Node 或 Node 数组（footer 为按钮数组，右对齐）。
 */
export function openModal(opts = {}) {
  const root = $('#modalRoot');
  const modal = $('#modal');
  const bodyBox = $('#modalBody');
  const footBox = $('#modalFoot');
  clear(bodyBox); clear(footBox);
  $('#modalTitle').textContent = opts.title || '';
  modal.classList.toggle('wide', !!opts.wide);
  append(bodyBox, opts.body || null);
  if (opts.footer) append(footBox, opts.footer);
  else footBox.append(el('button.btn', { type: 'button', text: '关闭', onclick: () => close() }));

  root.hidden = false;
  const prevFocus = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = $$(FOCUSABLE, modal).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  const firstField = $('input:not([type=hidden]),textarea,select', bodyBox) || $('button', footBox);
  if (firstField) setTimeout(() => firstField.focus(), 20);

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    activeModal = null;
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (opts.onClose) opts.onClose();
  }
  const handle = { close, root, body: bodyBox, foot: footBox, get open() { return !root.hidden; } };
  activeModal = handle;
  return handle;
}
export function anyModalOpen() { return !!activeModal && activeModal.open; }

/* ==================== 危险操作二次确认 ==================== */
/**
 * confirmDanger({title, note, typeText, requireCheck, checkLabel, confirmLabel})
 * 必须逐字输入 typeText 才能启用确认按钮；requireCheck 时还需勾选。
 * → Promise<{ok:boolean, password:string}>
 */
export function confirmDanger(o = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, password = '') => { if (!settled) { settled = true; resolve({ ok, password }); } };

    const typeInp = el('input.inp.mono-inp', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: o.typeText || '', 'aria-label': '确认输入' });
    const err = el('div.note.note-danger', { hidden: true, text: '输入不一致' });
    const chk = o.requireCheck
      ? el('input', { type: 'checkbox', id: uid('chk') })
      : null;
    const pwdInp = o.requirePassword
      ? el('input.inp', { type: 'password', autocomplete: 'off', placeholder: '当前登录密码', 'aria-label': '当前登录密码' })
      : null;

    const confirmBtn = el('button.btn.btn-danger', { type: 'button', text: o.confirmLabel || '确认执行', disabled: true });
    const cancelBtn = el('button.btn', { type: 'button', text: '取消' });

    const body = el('div', null, [
      o.note ? el('div.note.note-danger', null, o.note) : null,
      o.extraNote ? el('div.note.note-warn', null, o.extraNote) : null,
      o.typeText
        ? el('div.field', null, [
            el('span', null, ['请输入设备 IP ', el('code.type-confirm', { text: o.typeText }), ' 以确认：']),
            typeInp,
          ])
        : null,
      chk ? el('label.checkline', { for: chk.id, style: { marginTop: '10px' } }, [chk, el('span', { text: o.checkLabel || '' })]) : null,
      pwdInp ? el('div.field', { style: { marginTop: '10px' } }, [el('span', { text: '设备当前登录密码（用于二次校验）' }), pwdInp]) : null,
      err,
    ]);

    const validate = () => {
      const typedOk = !o.typeText || typeInp.value.trim() === o.typeText;
      const chkOk = !chk || chk.checked;
      const pwdOk = !o.requirePassword || pwdInp.value.length > 0;
      err.hidden = typedOk || !typeInp.value;
      confirmBtn.disabled = !(typedOk && chkOk && pwdOk);
    };
    typeInp.addEventListener('input', validate);
    if (chk) chk.addEventListener('change', validate);
    if (pwdInp) pwdInp.addEventListener('input', validate);
    typeInp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click(); });
    if (pwdInp) pwdInp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click(); });
    // Run once up-front: when the caller passes no typeText/requireCheck/requirePassword
    // there is nothing to type, and without this the confirm button stays disabled forever.
    validate();

    const m = openModal({
      title: o.title || '危险操作确认',
      body,
      footer: [cancelBtn, confirmBtn],
      onClose: () => done(false),
    });
    cancelBtn.addEventListener('click', () => { done(false); m.close(); });
    confirmBtn.addEventListener('click', () => { done(true, pwdInp ? pwdInp.value : ''); m.close(); });
  });
}

/* ============================ 下拉菜单 ============================ */
/** dropdown({label, items:[{key,label,danger,disabled,sep,onPick}]}) → {root, close} */
export function dropdown(o = {}) {
  const menu = el('div.dd-menu', { hidden: true, role: 'menu' });
  const btn = el('button.btn', { type: 'button', id: o.btnId || null, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, [
    el('span', { text: o.label || '菜单' }),
    el('span', { text: '▾', 'aria-hidden': 'true', style: { opacity: '.7' } }),
  ]);
  const root = el('div.dd', null, [btn, menu]);
  let open = false;

  for (const it of o.items || []) {
    if (it.sep) { menu.append(el('div.dd-sep')); continue; }
    if (it.header) { menu.append(el('div.dd-label', { text: it.header })); continue; }
    menu.append(el('button', {
      type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '',
      disabled: !!it.disabled, text: it.label,
      onclick: () => { setOpen(false); if (it.onPick) it.onPick(it.key); },
    }));
  }

  function setOpen(v) {
    open = v;
    menu.hidden = !v;
    btn.setAttribute('aria-expanded', v ? 'true' : 'false');
    root.classList.toggle('dd-open', v);
  }
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!open); if (open) { const f = $('button:not([disabled])', menu); if (f) f.focus(); } });
  menu.addEventListener('keydown', (e) => {
    const items = $$('button', menu);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(i - 1, 0)]?.focus(); }
  });
  const onDoc = (e) => { if (open && !root.contains(e.target)) setOpen(false); };
  document.addEventListener('click', onDoc);
  document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') { setOpen(false); btn.focus(); } });
  return { root, close: () => setOpen(false) };
}

/* ============================ 表单部件 ============================ */
export function field(label, control, extra) {
  return el('label.field', null, [el('span', { text: label }), control, extra || null]);
}

/* ============================ 通用小部件 ============================ */
export function emptyState(hint, big = '○') {
  return el('div.empty', null, [el('span.big', { text: big, 'aria-hidden': 'true' }), el('div', { text: hint })]);
}

export function meter(percent, cls = '') {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  return el('div.meter', { class: cls }, el('i', { style: { width: `${p}%` } }));
}

export function statusDot(online) {
  const known = online === true || online === false;
  return el('span.dot', { class: !known ? 'dot-idle' : online ? 'dot-on' : 'dot-off', title: known ? (online ? '在线' : '离线') : '状态未知' });
}

export function statusBadge(state) {
  const map = {
    pending: ['待执行', 'badge'], running: ['进行中', 'badge-busy'], ok: ['成功', 'badge-ok'],
    failed: ['失败', 'badge-bad'], skipped: ['跳过', 'badge'], upgrading: ['升级中', 'badge-busy'],
    done: ['已完成', 'badge-ok'], cancelled: ['已取消', 'badge-warn'],
  };
  const [text, cls] = map[state] || [state || '未知', 'badge'];
  return el('span.badge', { class: cls, text });
}

export function copyable(text, opts = {}) {
  const cls = opts.class || 'cell-trunc';
  const node = el('span', { class: cls, text: opts.display ?? String(text ?? '—'), title: opts.title || `${text ?? ''}（点击复制）`, role: 'button', tabindex: '0' });
  const doCopy = async () => {
    if (!text) { toastWarn('这一项为空'); return; }
    // 不阻断事件冒泡：在设备表格里点击 IP 既复制、也照常打开详情抽屉
    try { await copyText(text); toastOk(`已复制：${text}`, { timeout: 1800 }); }
    catch (err) { toastErr(errText(err)); }
  };
  node.addEventListener('click', doCopy);
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doCopy(); } });
  return node;
}

export { el, $, $$, append, clear };
