/**
 * IsapiClient — one HTTP/HTTPS client per device, with automatic authentication.
 *
 * Auth strategy (decided once per client, then cached):
 *   1. try `GET /ISAPI/Security/sessionLogin/capabilities` -> session login (new firmware)
 *   2. otherwise fall back to HTTP Digest on every request (old firmware)
 * A 401/statusCode=4/10 on any request triggers one transparent re-login.
 *
 * Node built-ins only (node:http / node:https), connection keep-alive enabled.
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import {
  buildDigestAuth, buildSessionLoginXml, encodePwd, extractResponseStatus,
  makeLoginRandom, parseDigestChallenge, statusMessage, isAuthFailure, isRebootRequired,
} from './auth.js';
import { parseXml, textOf, first, attrOf } from './xml.js';
import { errMsg, makeId } from './util.js';

export class IsapiError extends Error {
  constructor(message, { status = 0, body = '', code = 'ISAPI_ERROR', isapi = null } = {}) {
    super(message);
    this.name = 'IsapiError';
    this.httpStatus = status;
    this.body = body;
    this.code = code;
    this.isapi = isapi;
  }
}

const AGENT_OPTS = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 8, maxFreeSockets: 4 };

export class IsapiClient {
  /**
   * @param {object} opts
   * @param {string} opts.ip
   * @param {number} [opts.port=80]
   * @param {boolean} [opts.https=false]
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {number} [opts.timeoutMs=8000]
   */
  constructor(opts) {
    this.ip = opts.ip;
    this.port = Number(opts.port || (opts.https ? 443 : 80));
    this.https = !!opts.https;
    this.username = opts.username || 'admin';
    this.password = opts.password || '';
    this.timeoutMs = Number(opts.timeoutMs || 8000);

    this.id = makeId(this.ip, this.port, this.https);
    this.base = `${this.https ? 'https' : 'http'}://${this.ip}:${this.port}`;

    this.agent = this.https
      ? new https.Agent({ ...AGENT_OPTS, rejectUnauthorized: false })
      : new http.Agent(AGENT_OPTS);

    /** 'unknown' | 'session' | 'digest' */
    this.authMode = 'unknown';
    this.session = null; // { sessionID, sessionTag, sessionIDVersion, supportSessionTag }
    this.digestChallenge = null;
    this.digestNc = 0;
    this.lastUsedAt = 0;
    /** Diagnostics for the UI/debug endpoint. */
    this.log = [];
  }

  close() {
    try { this.agent.destroy(); } catch { /* ignore */ }
  }

  trace(line) {
    this.log.push(`${new Date().toISOString()} ${line}`);
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  /* ------------------------------ low level ----------------------------- */

  /** Raw HTTP round trip. No auth handling. */
  _raw(method, path, { body = null, contentType = null, headers = {}, timeoutMs, signal } = {}) {
    return new Promise((resolve, reject) => {
      let payload = null;
      if (body !== null && body !== undefined) {
        payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      }
      const h = {
        Accept: '*/*',
        'User-Agent': 'hikctl/1.0',
        Connection: 'keep-alive',
        ...headers,
      };
      if (payload) h['Content-Length'] = payload.length;
      if (contentType) h['Content-Type'] = contentType;

      const lib = this.https ? https : http;
      const req = lib.request(
        {
          protocol: this.https ? 'https:' : 'http:',
          host: this.ip,
          port: this.port,
          method,
          path,
          headers: h,
          agent: this.agent,
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }));
          res.on('error', reject);
        },
      );

      const to = setTimeout(() => {
        req.destroy(new IsapiError(`请求超时(${timeoutMs || this.timeoutMs}ms)`, { code: 'TIMEOUT' }));
      }, timeoutMs || this.timeoutMs);

      if (signal) {
        if (signal.aborted) { clearTimeout(to); req.destroy(new Error('aborted')); return; }
        signal.addEventListener('abort', () => { clearTimeout(to); req.destroy(new Error('aborted')); }, { once: true });
      }

      req.on('error', (e) => { clearTimeout(to); reject(e); });
      req.on('response', () => clearTimeout(to));
      if (payload) req.write(payload);
      req.end();
    });
  }

  _authHeaders(method, path) {
    const headers = {};
    if (this.authMode === 'session' && this.session) {
      if (this.session.cookie) headers.Cookie = this.session.cookie;
      if (this.session.sessionTag) headers.SessionTag = this.session.sessionTag;
    } else if (this.authMode === 'digest' && this.digestChallenge) {
      this.digestNc += 1;
      headers.Authorization = buildDigestAuth({
        username: this.username,
        password: this.password,
        method,
        uri: path,
        challenge: this.digestChallenge,
        nc: this.digestNc,
      });
    }
    return headers;
  }

  /**
   * Cheap authenticated request used to confirm a freshly created session.
   * Uses `Connection: close` and a short timeout: an unusable cookie makes some
   * firmware hold the keep-alive connection open without ever replying.
   */
  async _verifySession() {
    if (!this.session || !this.session.cookie) return false;
    const headers = { Cookie: this.session.cookie, Connection: 'close' };
    if (this.session.sessionTag) headers.SessionTag = this.session.sessionTag;
    try {
      const res = await this._raw('GET', '/ISAPI/System/deviceInfo', { headers, timeoutMs: 6000 });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** Public request with full auth/retry logic. Returns { status, headers, body(Buffer), text, ms }. */
  async request(method, path, opts = {}) {
    const started = Date.now();
    const tries = opts.retries === undefined ? 2 : opts.retries;
    let lastErr = null;
    // A re-login must always buy one more attempt, even when the caller asked for
    // retries:0 — otherwise the very first call on a fresh client (which is what
    // triggers the login) fails with a bogus "cannot connect".
    let reloginUsed = false;

    for (let attempt = 0; ; attempt++) {
      try {
        if (this.authMode !== 'unknown' && this.lastUsedAt && Date.now() - this.lastUsedAt > 45_000) {
          await this._heartbeat();
        }

        const headers = { ...(opts.headers || {}), ...this._authHeaders(method, path) };
        const res = await this._raw(method, path, { ...opts, headers });
        const text = res.body.toString('utf8');
        this.lastUsedAt = Date.now();

        if (res.status === 401) {
          const challengeHeader = res.headers['www-authenticate'];
          const challenge = parseDigestChallenge(challengeHeader);
          if (challenge) {
            // Digest works both as the primary scheme and as a recovery path.
            this.digestChallenge = challenge;
            this.digestNc = 0;
            if (this.authMode === 'unknown') this.authMode = 'digest';
            this.trace(`401 -> digest challenge (attempt ${attempt + 1})`);
            if (attempt < tries) continue;
          }
          // Session expired (or we never had one)? re-login once, then retry.
          if (this.authMode === 'session' || this.authMode === 'unknown') {
            if (!reloginUsed) {
              reloginUsed = true;
              this.trace(`401 -> re-login (attempt ${attempt + 1})`);
              this.session = null;
              const ok = await this.login({ force: true }).catch((e) => { lastErr = e; return false; });
              if (ok) continue;
            }
          }
          throw new IsapiError(`鉴权失败(HTTP 401)：${this.ip} 用户名或密码错误，或设备禁止访问`, {
            status: 401, code: 'AUTH', body: text,
          });
        }

        const isapi = extractResponseStatus(text);
        if (isapi && isAuthFailure(isapi) && !reloginUsed) {
          reloginUsed = true;
          this.trace(`ISAPI ${isapi.statusCode} -> re-login`);
          this.session = null;
          if (await this.login({ force: true }).catch(() => false)) continue;
        }

        const out = {
          status: res.status,
          headers: res.headers,
          body: res.body,
          text,
          isapi,
          ms: Date.now() - started,
        };
        if (res.status >= 400) {
          throw new IsapiError(
            `HTTP ${res.status} ${statusMessage(isapi) || ''}`.trim(),
            { status: res.status, body: text, code: 'HTTP', isapi },
          );
        }
        return out;
      } catch (e) {
        lastErr = e;
        if (e instanceof IsapiError && (e.code === 'AUTH' || e.code === 'HTTP')) throw e;
        if (attempt >= tries) break;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw lastErr instanceof IsapiError
      ? lastErr
      : new IsapiError(`无法连接设备 ${this.ip}:${this.port} —— ${errMsg(lastErr)}`, { code: 'NETWORK' });
  }

  async getText(path, opts) { return this.request('GET', path, opts); }
  async putText(path, body, opts = {}) {
    return this.request('PUT', path, { ...opts, body, contentType: opts.contentType || 'application/xml' });
  }
  async postText(path, body, opts = {}) {
    return this.request('POST', path, { ...opts, body, contentType: opts.contentType || 'application/xml' });
  }

  /* -------------------------------- login ------------------------------- */

  /** Distinguish "device is unactivated" from "wrong password" — they need different actions. */
  _authError(text, isapi, status) {
    const blob = [text, isapi && isapi.subStatusCode, isapi && isapi.statusString].filter(Boolean).join(' ');
    if (/notActivated|not[_ ]?activated|未激活/i.test(blob)) {
      return new IsapiError(
        `设备未激活（${this.ip}）：请先在「发现设备」里扫描并激活，或在设备行点「激活」`,
        { status, code: 'NOT_ACTIVATED', body: text, isapi },
      );
    }
    return new IsapiError(`登录失败：用户名或密码错误（${this.ip}）`, {
      status, code: 'AUTH', body: text, isapi,
    });
  }

  async _heartbeat() {
    if (this.authMode !== 'session' || !this.session) return;
    const headers = { Cookie: this.session.cookie, Connection: 'close' };
    if (this.session.sessionTag) headers.SessionTag = this.session.sessionTag;
    try {
      await this._raw('PUT', '/ISAPI/Security/sessionHeartbeat', { headers, timeoutMs: 4000 });
      this.lastUsedAt = Date.now();
    } catch { /* best effort */ }
  }

  /**
   * Log in. Tries session login first; falls back to Digest.
   * @returns {Promise<boolean>} true when a session was established
   */
  async login({ force = false } = {}) {
    if (this.session && !force) return true;

    // --- attempt 1: session login (newer firmware) ---
    const random = makeLoginRandom();
    const capPath = `/ISAPI/Security/sessionLogin/capabilities?username=${encodeURIComponent(this.username)}&random=${random}`;
    let capRes = null;
    try {
      capRes = await this._raw('GET', capPath, { timeoutMs: Math.min(this.timeoutMs, 6000) });
    } catch (e) {
      this.trace(`sessionLogin/capabilities network error: ${errMsg(e)}`);
    }

    if (capRes && capRes.status === 200) {
      const cap = this._parseLoginCap(capRes.body.toString('utf8'));
      if (cap) {
        const digest = encodePwd(
          this.password,
          {
            userName: this.username,
            salt: cap.salt,
            challenge: cap.challenge,
            iIterate: cap.iterations,
          },
          cap.isIrreversible,
        );
        const xml = buildSessionLoginXml({
          userName: this.username,
          passwordDigest: digest,
          sessionID: cap.sessionID,
          sessionIDVersion: cap.sessionIDVersion,
          needSessionTag: cap.isSupportSessionTag,
        });
        const ts = Date.now();
        const res = await this._raw('POST', `/ISAPI/Security/sessionLogin?timeStamp=${ts}`, {
          body: xml,
          contentType: 'application/xml',
        });
        const text = res.body.toString('utf8');
        const parsed = this._parseSessionLogin(text);

        // Some firmware (observed on HK-Y2S4M-GL/L, V5.8.110) answers with
        //   <SessionLogin><statusValue>200</statusValue><statusString>OK</statusString>…
        // and does NOT echo the sessionID back — the one from the capabilities
        // response is the session to use. Requiring the echo made us silently
        // fall back to Digest.
        const statusOk = /<statusValue>\s*200\s*<\/statusValue>/i.test(text)
          || /<statusString>\s*OK\s*<\/statusString>/i.test(text);

        // The cookie name is NOT always "WebSession": this firmware (HK-Y2S4M-GL/L
        // V5.8.110) issues `WebSession_<8 hex>=<sid>` and expects that exact pair
        // back. Capturing the raw Set-Cookie pair is the only reliable way.
        const setCookies = res.headers['set-cookie'];
        const cookieList = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
        let sessionCookie = '';
        for (const c of cookieList) {
          const m = /^\s*([^=;]+=[^;]+)/.exec(String(c));
          if (m && /websession/i.test(m[1])) { sessionCookie = m[1]; break; }
        }

        const sessionID = parsed.sessionID || cap.sessionID || '';
        const sessionTag = parsed.sessionTag || '';

        if (res.status === 200 && (statusOk || parsed.sessionID)) {
          this.session = {
            sessionID,
            cookie: sessionCookie || (sessionID ? `WebSession=${sessionID}` : ''),
            sessionTag,
            sessionIDVersion: cap.sessionIDVersion,
            supportSessionTag: !!cap.isSupportSessionTag && !!sessionTag,
            cookieName: sessionCookie ? sessionCookie.split('=')[0] : 'WebSession',
          };

          // Verify the session really works before committing to it: a bogus cookie
          // can make this firmware hang, and we must not strand every later request.
          const usable = await this._verifySession();
          if (usable) {
            this.authMode = 'session';
            this.lastUsedAt = Date.now();
            this.trace(`session login ok (sidVersion=${cap.sessionIDVersion}, cookie=${this.session.cookieName}, tag=${!!sessionTag})`);
            return true;
          }
          this.trace('session login answered OK but the session is not usable -> falling back to Digest');
          this.session = null;
        }
        const st = extractResponseStatus(text);
        this.trace(`sessionLogin rejected: http=${res.status} ${statusMessage(st)}`);
        if (res.status === 401 || (st && isAuthFailure(st))) {
          // Either the credentials are wrong, or the unit is simply not activated yet.
          throw this._authError(text, st, res.status);
        }
      }
    }

    // --- attempt 2: HTTP Digest ---
    try {
      const probe = await this._raw('GET', '/ISAPI/System/deviceInfo', { timeoutMs: Math.min(this.timeoutMs, 6000) });
      const probeText = probe.body.toString('utf8');
      const probeIsapi = extractResponseStatus(probeText);
      // Devices signal "not authorised" either with HTTP 401 or with a 200 carrying
      // statusCode 4 — must handle both, otherwise wrong credentials look like success.
      const unauthorized = probe.status === 401 || (probeIsapi && isAuthFailure(probeIsapi));

      if (unauthorized) {
        const challenge = parseDigestChallenge(probe.headers['www-authenticate']);
        if (!challenge) {
          throw this._authError(probeText, probeIsapi, probe.status);
        }
        this.digestChallenge = challenge;
        this.digestNc = 0;
        this.authMode = 'digest';
        const check = await this._raw('GET', '/ISAPI/System/deviceInfo', {
          headers: this._authHeaders('GET', '/ISAPI/System/deviceInfo'),
        });
        const checkIsapi = extractResponseStatus(check.body.toString('utf8'));
        if (check.status === 401 || (checkIsapi && isAuthFailure(checkIsapi))) {
          throw this._authError(check.body.toString('utf8'), checkIsapi, check.status);
        }
        this.trace('digest login ok');
        return true;
      }

      if (probe.status === 200) {
        this.authMode = 'digest';
        this.trace('device allows anonymous access');
        return true;
      }
    } catch (e) {
      if (e instanceof IsapiError && e.code === 'AUTH') throw e;
      throw new IsapiError(`无法连接设备 ${this.ip}:${this.port} —— ${errMsg(e)}`, { code: 'NETWORK' });
    }

    throw new IsapiError(`设备 ${this.ip}:${this.port} 未提供可用的登录方式`, { code: 'NO_AUTH_METHOD' });
  }

  _parseLoginCap(text) {
    const root = parseXml(text);
    const cap = first(root, 'SessionLoginCap') || root;
    const sessionID = textOf(cap, 'sessionID');
    const challenge = textOf(cap, 'challenge');
    if (!challenge) return null;
    return {
      sessionID,
      challenge,
      salt: textOf(cap, 'salt'),
      iterations: Number(textOf(cap, 'iterations', '1')) || 1,
      isIrreversible: /^true$/i.test(textOf(cap, 'isIrreversible', 'false')),
      sessionIDVersion: Number(textOf(cap, 'sessionIDVersion', '1')) || 1,
      isSupportSessionTag: /^true$/i.test(textOf(cap, 'isSupportSessionTag', 'false')),
      raw: text,
    };
  }

  _parseSessionLogin(text) {
    const root = parseXml(text);
    const el = first(root, 'SessionLogin') || root;
    return { sessionID: textOf(el, 'sessionID'), sessionTag: textOf(el, 'sessionTag') };
  }

  async logout() {
    if (this.authMode === 'session' && this.session) {
      const headers = { Cookie: this.session.cookie, Connection: 'close' };
      if (this.session.sessionTag) headers.SessionTag = this.session.sessionTag;
      try {
        await this._raw('PUT', '/ISAPI/Security/sessionLogout', { headers, timeoutMs: 4000 });
      } catch { /* ignore */ }
      this.session = null;
    }
  }
}

export { isRebootRequired, statusMessage, extractResponseStatus };