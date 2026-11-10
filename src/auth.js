/**
 * Device authentication primitives.
 *
 * Two schemes are supported, matching what real Hikvision firmware exposes:
 *
 *  1. Session login (web 5.0 / newer firmware) — reverse engineered from the offline
 *     web package `webs_5.0_isapi` (ConfigKit). See docs/ISAPI-接口清单与关键流程.md §3.
 *  2. HTTP Digest (older firmware / direct ISAPI access).
 *
 * Node built-ins only.
 */
import { createHash, randomBytes } from 'node:crypto';

export const md5 = (s) => createHash('md5').update(String(s), 'utf8').digest('hex');
export const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

/**
 * Device password digest.
 *
 * Byte-for-byte reproduction of `encodePwd()` found in
 * Packages/R0101/webs_5.0_isapi/doc/js/default_4d190975_4d190975.8ea5b516.js:
 *
 *   if (isIrreversible) {
 *       i = sha256(userName + salt + password);
 *       i = sha256(i + challenge);
 *       for (r = 2; r < iIterate; r++) i = sha256(i);
 *   } else {
 *       i = sha256(password) + challenge;
 *       for (o = 1; o < iIterate; o++) i = sha256(i);
 *   }
 *
 * Note the loop *starts at 2* in the irreversible branch — off-by-one here yields 401.
 */
export function encodePwd(password, { userName = '', salt = '', challenge = '', iIterate = 1 } = {}, isIrreversible = false) {
  const iterations = Number(iIterate) || 1;
  let acc;
  if (isIrreversible) {
    acc = sha256(String(userName) + String(salt) + String(password));
    acc = sha256(acc + String(challenge));
    for (let r = 2; r < iterations; r++) acc = sha256(acc);
  } else {
    acc = sha256(String(password)) + String(challenge);
    for (let o = 1; o < iterations; o++) acc = sha256(acc);
  }
  return acc;
}

/**
 * The 8-char decimal `random` the device wants on the capabilities request.
 * Mirrors: md5(Date.now()) -> first 8 hex chars -> parsed as hex -> decimal -> first 8 chars.
 */
export function makeLoginRandom(now = Date.now()) {
  const hex8 = md5(String(now)).slice(0, 8);
  return parseInt(hex8, 16).toString().slice(0, 8);
}

/** Build the <SessionLogin> request body. */
export function buildSessionLoginXml({ userName, passwordDigest, sessionID, sessionIDVersion = 1, needSessionTag = false, tokenAB = '' }) {
  let x = '<SessionLogin>';
  x += `<userName>${escapeXml(userName)}</userName>`;
  x += `<password>${escapeXml(passwordDigest)}</password>`;
  x += `<sessionID>${escapeXml(sessionID)}</sessionID>`;
  x += '<isSessionIDValidLongTerm>false</isSessionIDValidLongTerm>';
  x += `<sessionIDVersion>${Number(sessionIDVersion) || 1}</sessionIDVersion>`;
  if (needSessionTag) x += '<isNeedSessionTag>true</isNeedSessionTag>';
  if (tokenAB) x += `<tokenAB>${escapeXml(tokenAB)}</tokenAB>`;
  x += '</SessionLogin>';
  return '<?xml version="1.0" encoding="UTF-8"?>\r\n' + x;
}

export function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* HTTP Digest                                                         */
/* ------------------------------------------------------------------ */

const DIGEST_KEYS = ['realm', 'nonce', 'opaque', 'qop', 'algorithm', 'stale', 'domain', 'charset'];

/** Parse a WWW-Authenticate challenge header into a plain object. */
export function parseDigestChallenge(header) {
  const raw = String(header || '');
  const at = raw.toLowerCase().indexOf('digest');
  if (at === -1) return null;
  const body = raw.slice(at + 6);
  const out = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(body))) {
    const key = m[1].toLowerCase();
    if (DIGEST_KEYS.includes(key)) out[key] = m[2] !== undefined ? m[2] : m[3];
  }
  if (!out.realm || !out.nonce) return null;
  if (!out.algorithm) out.algorithm = 'MD5';
  return out;
}

/**
 * Build the Authorization header value for a Digest challenge.
 * `uri` must be the request path *including* the query string, exactly as sent.
 */
export function buildDigestAuth({ username, password, method, uri, challenge, nc = 1, cnonce }) {
  const { realm, nonce, opaque, qop } = challenge;
  const algorithm = String(challenge.algorithm || 'MD5').toUpperCase();
  const cn = cnonce || randomBytes(8).toString('hex');

  let ha1 = md5(`${username}:${realm}:${password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${cn}`);
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);

  const ncStr = Number(nc).toString(16).padStart(8, '0');
  const useQop = qop ? String(qop).split(',')[0].trim() : '';
  const response = useQop
    ? md5(`${ha1}:${nonce}:${ncStr}:${cn}:${useQop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  header += `, algorithm=${algorithm}`;
  if (useQop) header += `, qop=${useQop}, nc=${ncStr}, cnonce="${cn}"`;
  if (opaque) header += `, opaque="${opaque}"`;
  return header;
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

/** Extract the ISAPI status block from a response body (XML or JSON). */
export function extractResponseStatus(body) {
  const text = String(body || '');
  const xmlStatus = /<statusCode>\s*([^<]*?)\s*<\/statusCode>/i.exec(text);
  if (xmlStatus) {
    const sub = /<subStatusCode>\s*([^<]*?)\s*<\/subStatusCode>/i.exec(text);
    const str = /<statusString>\s*([^<]*?)\s*<\/statusString>/i.exec(text);
    return {
      statusCode: xmlStatus[1],
      subStatusCode: sub ? sub[1] : '',
      statusString: str ? str[1] : '',
    };
  }
  try {
    const j = JSON.parse(text);
    const st = j && (j.ResponseStatus || (j.statusCode !== undefined ? j : null));
    if (st && st.statusCode !== undefined) {
      return {
        statusCode: String(st.statusCode),
        subStatusCode: st.subStatusCode ? String(st.subStatusCode) : '',
        statusString: st.statusString ? String(st.statusString) : '',
      };
    }
  } catch { /* not JSON */ }
  return null;
}

/** Human message for an ISAPI status code. */
export function statusMessage(status) {
  if (!status) return '';
  const code = String(status.statusCode);
  const map = {
    1: '成功',
    2: '设备忙',
    3: '不支持',
    4: '鉴权失败',
    5: '参数错误',
    6: '无权限',
    7: '需重启生效',
    8: '设备未激活',
    9: '需要激活',
    10: '需要重新登录',
  };
  const base = map[code] || `状态码 ${code}`;
  return status.subStatusCode ? `${base}(${status.subStatusCode})` : base;
}

export function isRebootRequired(status) {
  if (!status) return false;
  return String(status.statusCode) === '7' || /rebootRequired/i.test(status.subStatusCode || '');
}

export function isAuthFailure(status) {
  if (!status) return false;
  const c = String(status.statusCode);
  return c === '4' || c === '10';
}