/**
 * Minimal but faithful XML parser / serializer.
 *
 * Why hand-rolled: ISAPI writes are "GET full XML -> change one field -> PUT it all back".
 * A lossy parser would drop unknown device fields, so we keep a node tree that preserves
 * attributes, text, CDATA, comments and processing instructions and can round-trip them.
 *
 * Zero dependencies (Node built-ins only).
 */

const TEXT = 'text';
const CDATA = 'cdata';
const COMMENT = 'comment';
const PI = 'pi';
const ELEMENT = 'element';

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, g) ? ENTITIES[g] : m;
  });
}

function encodeText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function encodeAttr(s) {
  return encodeText(s).replace(/"/g, '&quot;');
}

/** Parse an XML document into a root node. Never throws on malformed input. */
export function parseXml(input) {
  const src = String(input == null ? '' : input);
  const root = { type: 'root', children: [] };
  const stack = [root];
  let i = 0;

  const top = () => stack[stack.length - 1];
  const push = (node) => { top().children.push(node); };
  const decode = (s) => decodeEntities(s);

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      const tail = src.slice(i);
      if (tail) push({ type: TEXT, value: decode(tail) });
      break;
    }
    if (lt > i) push({ type: TEXT, value: decode(src.slice(i, lt)) });

    // <!-- comment -->
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      const stop = end === -1 ? src.length : end + 3;
      push({ type: COMMENT, value: src.slice(lt + 4, end === -1 ? src.length : end) });
      i = stop;
      continue;
    }
    // <![CDATA[ ... ]]>
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const stop = end === -1 ? src.length : end + 3;
      push({ type: CDATA, value: src.slice(lt + 9, end === -1 ? src.length : end) });
      i = stop;
      continue;
    }
    // <!DOCTYPE ...>
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    // <?xml ... ?> or other PI
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      const stop = end === -1 ? src.length : end + 2;
      push({ type: PI, value: src.slice(lt + 2, end === -1 ? src.length : end) });
      i = stop;
      continue;
    }
    // closing tag
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      if (stack.length > 1) stack.pop();
      continue;
    }

    // opening tag
    const end = findTagEnd(src, lt + 1);
    if (end === -1) { // unterminated: treat rest as text
      push({ type: TEXT, value: decode(src.slice(lt)) });
      break;
    }
    const raw = src.slice(lt + 1, end);
    i = end + 1;

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const node = { type: ELEMENT, name, attrs: [], children: [] };

    const attrRe = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(body.slice(nameMatch[1].length)))) {
      node.attrs.push({ name: m[1], value: decode(m[3] !== undefined ? m[3] : m[4] || '') });
    }

    push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function findTagEnd(src, from) {
  let quote = 0;
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (quote) { if (c === quote) quote = 0; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return j;
  }
  return -1;
}

export function serializeXml(node) {
  const out = [];
  writeNode(node, out, 0);
  return out.join('');
}

function writeNode(node, out, depth) {
  switch (node.type) {
    case 'root':
      for (const c of node.children) writeNode(c, out, depth);
      return;
    case TEXT:
      out.push(encodeText(node.value));
      return;
    case CDATA:
      out.push('<![CDATA[' + node.value + ']]>');
      return;
    case COMMENT:
      out.push('<!--' + node.value + '-->');
      return;
    case PI:
      out.push('<?' + node.value + '?>');
      return;
    default: {
      out.push('<', node.name);
      for (const a of node.attrs || []) out.push(' ', a.name, '="', encodeAttr(a.value), '"');
      if (!node.children || node.children.length === 0) { out.push('/>'); return; }
      out.push('>');
      for (const c of node.children) writeNode(c, out, depth + 1);
      out.push('</', node.name, '>');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Query helpers                                                       */
/* ------------------------------------------------------------------ */

export function elementsOf(node, name) {
  const res = [];
  collect(node, name, res);
  return res;
}

function collect(node, name, res) {
  if (!node || !node.children) return;
  for (const c of node.children) {
    if (c.type !== ELEMENT) continue;
    if (!name || c.name === name) res.push(c);
    collect(c, name, res);
  }
}

/** First descendant element with `name`, or null. */
export function first(node, name) {
  const r = elementsOf(node, name);
  return r.length ? r[0] : null;
}

/** Direct text of the first descendant element named `name`. */
export function textOf(node, name, dflt = '') {
  const el = first(node, name);
  if (!el) return dflt;
  return directText(el);
}

export function directText(el) {
  if (!el || !el.children) return '';
  let s = '';
  for (const c of el.children) {
    if (c.type === TEXT || c.type === CDATA) s += c.value;
  }
  return s;
}

/** Set (or create) the text of a named child, preserving everything else. */
export function setText(node, name, value) {
  let el = first(node, name);
  if (!el) {
    el = { type: ELEMENT, name, attrs: [], children: [] };
    node.children.push(el);
  }
  el.children = [{ type: TEXT, value: String(value) }];
  return el;
}

export function setAttr(el, name, value) {
  const found = el.attrs.find((a) => a.name === name);
  if (found) found.value = String(value);
  else el.attrs.push({ name, value: String(value) });
  return el;
}

export function attrOf(el, name, dflt = '') {
  if (!el || !el.attrs) return dflt;
  const found = el.attrs.find((a) => a.name === name);
  return found ? found.value : dflt;
}

/** Build an element from a plain object tree: {a:1, b:{c:2}, list:[{...},{...}]} */
export function build(name, value) {
  const el = { type: ELEMENT, name, attrs: [], children: [] };
  appendValue(el, value);
  return el;
}

function appendValue(el, value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // array of objects: each object's own keys become children under `el`'s name
        appendValue(el, v);
      } else {
        el.children.push({ type: TEXT, value: String(v) });
      }
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const child = { type: ELEMENT, name: k, attrs: [], children: [] };
      appendValue(child, v);
      el.children.push(child);
    }
    return;
  }
  el.children.push({ type: TEXT, value: String(value) });
}

/** Wrap a serialized string *or* a node tree in an XML declaration. */
export function document(body) {
  const inner = typeof body === 'string' ? body : serializeXml(body);
  return '<?xml version="1.0" encoding="UTF-8"?>\r\n' + inner;
}

/**
 * Serialize a tree parsed from a device response back into a request body.
 *
 * The device responses already carry their own `<?xml …?>` declaration, and our
 * parser preserves it — prepending another one produces two declarations, which
 * firmware rejects with `badXmlFormat`. Adds one only when it is missing.
 */
export function xmlBody(node) {
  if (typeof node === 'string') return document(node);
  const hasDecl = (node.children || []).some(
    (c) => c.type === PI && /^\s*xml\b/i.test(String(c.value || '')),
  );
  return hasDecl ? serializeXml(node) : document(node);
}

export const XML = { TEXT, CDATA, COMMENT, PI, ELEMENT };