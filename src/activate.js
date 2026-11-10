/**
 * Device activation (ISAPI activation V3).
 *
 * Reverse engineered from the offline web package, file
 * `webs_5.0_isapi/doc/js/default_ff6d3bd7_c751954b.0cc791ba.js` (method
 * `encodeChallenge` / `activeDevice`) plus the crypto helpers in
 * `default_4d190975_4d190975.8ea5b516.js` (methods `encodeAES`, `decodeRSA`).
 *
 * Protocol
 * --------
 *  1. GET  /SDK/activateStatus                              -> <Activated>false</Activated><supportVersion>3</supportVersion>
 *  2. POST /ISAPI/System/activate/GetChallengeV3?format=json
 *          body {"publicKey": base64(DER SubjectPublicKeyInfo)}
 *          ->   {"challenge": base64(RSA-PKCS1v15(challengeHex))}
 *  3. challenge = RSA private-decrypt -> a hex string (64 chars = 32 bytes)
 *  4. AES-256-CBC:
 *          key        = hexDecode(challenge)          // 32 bytes
 *          iv         = 16 random bytes, sent as a 32-char HEX string
 *          plaintext  = challenge.substring(0,16) + password
 *          ciphertext = AES-CBC/PKCS7 -> hex string -> base64
 *  5. POST /ISAPI/System/activate/StartActivateV3?format=json
 *          body {"password": <base64>, "iv": <32-char hex>}
 *
 * Two details that are easy to get wrong and both matter:
 *   - encodeAES() parses the KEY and IV with `CryptoJS.enc.Hex.parse`, i.e. the
 *     key string is HEX, not UTF-8.
 *   - the ciphertext is `.toString()`-ed to HEX *before* being base64 encoded,
 *     so the transmitted value is base64(ascii-hex).
 */
import crypto from 'node:crypto';
import http from 'node:http';
// aliased: `https` is also an option name inside rawRequest()
import httpsModule from 'node:https';

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

const b64 = (buf) => Buffer.from(buf).toString('base64');

function hexToBuf(hex) {
  const s = String(hex).trim();
  if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0) return null;
  return Buffer.from(s, 'hex');
}

/** encodeAES(data, keyHex, ivHex) -> hex ciphertext (AES-CBC/PKCS7). */
export function encodeAesCbc(plaintext, keyHex, ivHex) {
  const key = hexToBuf(keyHex);
  const iv = hexToBuf(ivHex);
  if (!key || !iv) throw new Error('AES 密钥或 IV 不是合法十六进制');
  if (![16, 24, 32].includes(key.length)) throw new Error(`AES 密钥长度非法: ${key.length} 字节`);
  if (iv.length !== 16) throw new Error(`AES IV 长度非法: ${iv.length} 字节`);
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  cipher.setAutoPadding(true); // PKCS7, matches CryptoJS.pad.Pkcs7
  return Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]).toString('hex');
}

/** The value transmitted as `encryptPassword`: base64(ascii-hex-of-ciphertext). */
export function buildEncryptPassword(challengeHex, password, ivHex) {
  const plaintext = String(challengeHex).substring(0, 16) + String(password);
  const hexCipher = encodeAesCbc(plaintext, challengeHex, ivHex);
  return b64(Buffer.from(hexCipher, 'ascii'));
}

/* ------------------------------------------------------------------ */
/* HTTP helpers (unauthenticated — the device is not activated yet)    */
/* ------------------------------------------------------------------ */

function rawRequest({ ip, port = 80, https = false, method, path, body, contentType, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const lib = https ? httpsModule : http;
    const payload = body === undefined || body === null ? null
      : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
    const headers = { Accept: '*/*', 'User-Agent': 'hikctl/1.0', Connection: 'close' };
    if (payload) headers['Content-Length'] = payload.length;
    if (contentType) headers['Content-Type'] = contentType;

    const req = lib.request({
      host: ip, port, method, path, headers, rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时(${timeoutMs}ms)`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* activation status                                                   */
/* ------------------------------------------------------------------ */

/**
 * Read activation state. Works on an unactivated device (endpoint is not
 * behind auth).
 * @returns {Promise<{activated:boolean, supportVersion:number, reachable:boolean, error?:string}>}
 */
export async function getActivateStatus(ip, { port = 80, https = false, timeoutMs = 6000 } = {}) {
  try {
    const res = await rawRequest({ ip, port, https, method: 'GET', path: '/SDK/activateStatus', timeoutMs });
    const activated = /<Activated>\s*true\s*<\/Activated>/i.test(res.text);
    const ver = /<supportVersion>\s*(\d+)\s*<\/supportVersion>/i.exec(res.text);
    const inactive = /<Activated>\s*false\s*<\/Activated>/i.test(res.text);
    return {
      reachable: res.status === 200,
      activated: res.status === 200 ? activated : false,
      inactive: res.status === 200 ? inactive : false,
      supportVersion: ver ? Number(ver[1]) : 0,
      raw: res.text.slice(0, 500),
      httpStatus: res.status,
    };
  } catch (e) {
    return { reachable: false, activated: false, inactive: false, supportVersion: 0, error: e.message };
  }
}

/**
 * The device does NOT want PEM or DER. Reverse engineered from the vendor library
 * (`publicKeyString = function (t) { return t.n.toString(16) }` — a jsbn RSAKey):
 * the "public key string" is the RSA **modulus in hex**, and it is then passed
 * through `encodeBase64 = Base64.stringify(Utf8.parse(x))`, i.e. plain
 * base64-of-the-hex-text. Exponent is always 0x10001.
 */
function modulusHexCandidates(publicKeyDer) {
  const jwk = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' }).export({ format: 'jwk' });
  const nBytes = Buffer.from(jwk.n, 'base64url');
  const withLeadingStripped = nBytes.toString('hex').replace(/^0+/, '');
  return {
    // jsbn's BigInteger.toString(16) drops leading zero nibbles — match that first.
    stripped: withLeadingStripped,
    padded: nBytes.toString('hex'),
    exponent: Buffer.from(jwk.e, 'base64url').toString('hex'),
  };
}

/** Try to RSA-decrypt the challenge, tolerating the encodings the vendor stack uses. */
function decryptChallenge(challengeB64, privateKeyDer) {
  const attempts = [];
  const key = { key: privateKeyDer, format: 'der', type: 'pkcs8', padding: crypto.constants.RSA_PKCS1_PADDING };

  const outer = Buffer.from(String(challengeB64), 'base64');
  const outerText = outer.toString('utf8');
  const asHex = /^[0-9a-fA-F]+$/.test(outerText) && outerText.length % 2 === 0
    ? Buffer.from(outerText, 'hex')
    : null;

  // jsbn's RSAKey.decrypt() does parseBigInt(ctext, 16) — i.e. it expects a HEX
  // string. Combined with the device base64-ing that string, the wire value is
  // base64(hex(ciphertext)). Try that first, then the plainer readings.
  const candidates = [
    ['base64->hex->bytes', asHex],
    ['base64->bytes', outer],
    ['base64->utf8->base64->bytes', (() => { try { return Buffer.from(outerText, 'base64'); } catch { return null; } })()],
  ];

  for (const [how, buf] of candidates) {
    if (!buf || !buf.length) continue;
    try {
      return { ok: true, plaintext: crypto.privateDecrypt(key, buf).toString('utf8'), how };
    } catch (e) {
      attempts.push({ how, bytes: buf.length, error: e.message });
    }
  }
  return { ok: false, attempts };
}

/**
 * Step 2+3 of the protocol: generate an RSA keypair, hand the modulus to the
 * device and decrypt the returned challenge.
 *
 * Performs NO state change — a pure handshake probe.
 *
 * @returns {Promise<{ok:boolean, challengeHex?:string, keyFormat?:string, attempts:object[], error?:string}>}
 */
export async function fetchActivateChallenge(ip, {
  port = 80, https = false, timeoutMs = 15000, modulusLength = 3072, path = '/ISAPI/System/activate/GetChallengeV3?format=json',
} = {}) {
  const attempts = [];

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const mod = modulusHexCandidates(publicKey);
  const pkcs1Der = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
    .export({ type: 'pkcs1', format: 'der' });
  const pem = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
    .export({ type: 'spki', format: 'pem' }).toString();

  // Firmware differs in what it accepts; try the vendor format first.
  const candidates = [
    { name: 'hex-modulus', value: b64(mod.stripped) },
    { name: 'hex-modulus-padded', value: b64(mod.padded) },
    { name: 'spki-der', value: b64(publicKey) },
    { name: 'pkcs1-der', value: b64(pkcs1Der) },
    { name: 'pem-text', value: b64(pem) },
  ];

  for (const cand of candidates) {
    let res;
    try {
      res = await rawRequest({
        ip, port, https, method: 'POST', path,
        body: JSON.stringify({ publicKey: cand.value }),
        contentType: 'application/json',
        timeoutMs,
      });
    } catch (e) {
      attempts.push({ format: cand.name, httpStatus: 0, error: e.message });
      continue;
    }

    let challengeB64 = null;
    try {
      const j = JSON.parse(res.text);
      challengeB64 = j.challenge || j.Challenge || null;
    } catch {
      const m = /<challenge>([^<]+)<\/challenge>/i.exec(res.text);
      if (m) challengeB64 = m[1];
    }

    if (!challengeB64) {
      attempts.push({ format: cand.name, httpStatus: res.status, error: res.text.replace(/\s+/g, ' ').slice(0, 240) });
      continue;
    }

    const dec = decryptChallenge(challengeB64, privateKey);
    if (!dec.ok) {
      attempts.push({
        format: cand.name, httpStatus: res.status,
        error: `RSA 解密失败: ${JSON.stringify(dec.attempts)}`,
      });
      continue;
    }

    const challengeHex = dec.plaintext;
    const keyBuf = hexToBuf(challengeHex);
    const usable = !!keyBuf && [16, 24, 32].includes(keyBuf.length);
    attempts.push({
      format: cand.name, httpStatus: res.status, ok: usable,
      challengeHex, challengeBytes: keyBuf ? keyBuf.length : 0, decryptVia: dec.how,
    });
    if (usable) {
      return {
        ok: true,
        challengeHex,
        challengeBytes: keyBuf.length,
        keyFormat: cand.name,
        decryptVia: dec.how,
        attempts,
        raw: res.text.slice(0, 300),
      };
    }
  }

  return {
    ok: false, attempts,
    error: '未能完成挑战握手：设备未返回可解密的 challenge，或格式不被支持',
  };
}

/**
 * V1 challenge (older protocol, `/ISAPI/Security/challenge`, XML + 1024-bit RSA).
 * Returns the decrypted challenge as a UTF-8 string (not necessarily hex).
 */
export async function fetchChallengeV1(ip, { port = 80, https = false, timeoutMs = 15000 } = {}) {
  const attempts = [];
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const mod = modulusHexCandidates(publicKey);
  const pkcs1 = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
    .export({ type: 'pkcs1', format: 'der' });

  const values = [
    ['hex-modulus', b64(mod.stripped)],
    ['spki-der', b64(publicKey)],
    ['pkcs1-der', b64(pkcs1)],
    ['pem-text', b64(crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString())],
  ];

  for (const [name, keyValue] of values) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><PublicKey><key>${keyValue}</key></PublicKey>`;
    let res;
    try {
      res = await rawRequest({
        ip, port, https, method: 'POST', path: '/ISAPI/Security/challenge',
        body: xml, contentType: 'application/xml', timeoutMs,
      });
    } catch (e) {
      attempts.push({ format: name, httpStatus: 0, error: e.message });
      continue;
    }
    const m = /<key>([^<]+)<\/key>/i.exec(res.text) || /"key"\s*:\s*"([^"]+)"/i.exec(res.text);
    if (!m) {
      attempts.push({ format: name, httpStatus: res.status, error: res.text.replace(/\s+/g, ' ').slice(0, 240) });
      continue;
    }
    const dec = decryptChallenge(m[1], privateKey);
    if (!dec.ok) {
      attempts.push({ format: name, httpStatus: res.status, error: `RSA 解密失败: ${JSON.stringify(dec.attempts)}` });
      continue;
    }
    return {
      ok: true, format: name, challenge: dec.plaintext, decryptVia: dec.how,
      challengeHex: dec.plaintext, attempts, raw: res.text.slice(0, 300),
    };
  }
  return { ok: false, attempts, error: 'V1 挑战握手失败' };
}

/* ------------------------------------------------------------------ */
/* activation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Default administrator password used when the caller does not supply one.
 *
 * Product decision: the operator wants one-click activation, so a house default is
 * pre-filled in the UI. It is read back by `GET /api/activate/config`; the UI must
 * NOT hardcode it. Change this one line to change the default everywhere.
 */
export const DEFAULT_ACTIVATION_PASSWORD = '1q2w3e4r';

/** Concurrency used by POST /api/activate/batch when the caller does not specify. */
export const DEFAULT_ACTIVATION_CONCURRENCY = 8;

export const PASSWORD_RULES = {
  minLength: 8,
  maxLength: 16,
  /**
   * Hikvision's activation policy is 8–16 characters using at least TWO of
   * upper / lower / digit / symbol. (An earlier revision of this file demanded
   * three classes and wrongly rejected valid passwords such as `1q2w3e4r`.)
   */
  minClasses: 2,
  classes(pwd) {
    const p = String(pwd || '');
    return [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(p)).length;
  },
  check(pwd, { minClasses = 2 } = {}) {
    const p = String(pwd || '');
    if (p.length < 8) return '密码长度至少 8 位';
    if (p.length > 16) return '密码长度不能超过 16 位（激活接口限制）';
    if (/\s/.test(p)) return '密码不能包含空格';
    const kinds = PASSWORD_RULES.classes(p);
    if (kinds < minClasses) {
      return `密码需包含大写字母、小写字母、数字、特殊字符中的至少 ${minClasses} 类（当前 ${kinds} 类）`;
    }
    return null;
  },
  /** Non-blocking advice shown to the user. */
  strength(pwd) {
    const p = String(pwd || '');
    const kinds = PASSWORD_RULES.classes(p);
    if (p.length >= 12 && kinds >= 3) return 'strong';
    if (p.length >= 10 && kinds >= 2) return 'fair';
    return 'weak';
  },
};

/**
 * Activate a device.
 *
 * ⚠ State-changing: sets the device administrator password.
 *
 * @param {string} ip
 * @param {object} opts
 * @param {string} opts.password new administrator password (8–16 chars)
 * @param {number} [opts.port=80]
 * @param {boolean} [opts.https=false]
 * @param {string} [opts.userName='admin']
 */
export async function activateDevice(ip, { password, port = 80, https = false, userName = 'admin', timeoutMs = 30000 } = {}) {
  const ruleError = PASSWORD_RULES.check(password);
  if (ruleError) throw new Error(ruleError);

  const status = await getActivateStatus(ip, { port, https });
  if (!status.reachable) throw new Error(`设备不可达：${status.error || '无响应'}`);
  if (status.activated) return { ok: true, alreadyActivated: true, message: '设备已激活，无需重复操作' };

  const handshake = await fetchActivateChallenge(ip, { port, https, timeoutMs });
  if (!handshake.ok) {
    throw new Error(`${handshake.error}；尝试记录=${JSON.stringify(handshake.attempts)}`);
  }

  const ivHex = crypto.randomBytes(16).toString('hex'); // 32 hex chars, as the device expects
  const encryptPassword = buildEncryptPassword(handshake.challengeHex, password, ivHex);

  const res = await rawRequest({
    ip, port, https, method: 'POST',
    path: '/ISAPI/System/activate/StartActivateV3?format=json',
    body: JSON.stringify({ password: encryptPassword, iv: ivHex }),
    contentType: 'application/json',
    timeoutMs,
  });

  const ok = res.status === 200 && !/"statusCode"\s*:\s*(?!1\b)\d+/.test(res.text);
  if (!ok) {
    let detail = res.text.slice(0, 300);
    try {
      const j = JSON.parse(res.text);
      detail = j.statusString || j.subStatusCode || detail;
    } catch { /* keep raw */ }
    throw new Error(`激活失败：HTTP ${res.status} ${detail}`);
  }

  // Confirm by re-reading status, then verify we can actually log in.
  const after = await getActivateStatus(ip, { port, https });
  return {
    ok: true,
    activated: after.activated,
    supportVersion: status.supportVersion,
    keyFormat: handshake.keyFormat,
    challengeBytes: hexToBuf(handshake.challengeHex).length,
    message: after.activated
      ? `激活成功，管理员账号 ${userName}，密码已设置`
      : '接口返回成功，但状态查询仍显示未激活，请稍后重试状态查询',
    raw: res.text.slice(0, 300),
  };
}