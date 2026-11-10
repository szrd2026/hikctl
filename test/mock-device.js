/**
 * A fake Hikvision device that speaks enough ISAPI to exercise hikctl end to end.
 * Used by test/run.js. Two auth modes: 'session' (new firmware) and 'digest' (old).
 *
 * The password digest check here is written independently of src/auth.js on purpose —
 * if the two ever disagree, the integration test fails.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, publicEncrypt, createDecipheriv, createPublicKey, constants as cryptoConst } from 'node:crypto';

const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const md5 = (s) => createHash('md5').update(String(s), 'utf8').digest('hex');

/** Independent transcription of the device-side digest. */
function deviceEncodePwd(password, { userName, salt, challenge, iterations }, irreversible) {
  let acc;
  if (irreversible) {
    acc = sha(userName + salt + password);
    acc = sha(acc + challenge);
    let r = 2;
    while (r < iterations) { acc = sha(acc); r += 1; }
  } else {
    acc = sha(password) + challenge;
    let o = 1;
    while (o < iterations) { acc = sha(acc); o += 1; }
  }
  return acc;
}

// 1×1 兜底 JPEG（保证魔数正确）
const JPEG_MIN = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/**
 * 若存在 test/fixtures/demo-snapshot.jpg 就用它当抓图返回。
 * 这样跑演示/截图时预览区是一张正常画面，而不是 1×1 像素（浏览器会显示成裂图）。
 * 该图由 tools/make-fixture.mjs 用 canvas 合成，只含 DEMO 字样。
 */
function loadFixtureJpeg() {
  try {
    const f = path.join(import.meta.dirname, 'fixtures', 'demo-snapshot.jpg');
    const buf = fs.readFileSync(f);
    if (buf.length > 1000 && buf[0] === 0xff && buf[1] === 0xd8) return buf;
  } catch { /* 没装就退回首字节 */ }
  return null;
}
const JPEG = loadFixtureJpeg() || JPEG_MIN;

export class MockDevice {
  constructor(opts = {}) {
    this.username = opts.username || 'admin';
    this.password = opts.password || 'Test@12345';
    this.authMode = opts.authMode || 'session'; // 'session' | 'digest' | 'anonymous'
    this.model = opts.model || 'DS-2CD2347G2-LU';
    this.serial = opts.serial || 'DS-2CD2347G2-LU20230101AAWR123456789';
    this.firmware = opts.firmware || 'V5.7.5 build 230612';
    this.iterations = opts.iterations === undefined ? 100 : opts.iterations;
    this.isIrreversible = opts.isIrreversible !== false;

    this.sessions = new Map();
    this.digestNonce = randomBytes(8).toString('hex');
    this.rebootCalled = false;
    this.resetCalled = null;
    this.resetCalls = [];
    this.upgradeBytes = 0;

    /** Activation state — mirrors a brand new device out of the box. */
    this.activated = opts.activated !== false;
    this.supportVersion = opts.supportVersion === undefined ? 3 : opts.supportVersion;
    this.challengeBytes = opts.challengeBytes === undefined ? 16 : opts.challengeBytes;

    /* --- quirks observed on real firmware (HK-Y2S4M-GL/L V5.8.110) --- */
    // login answers OK without echoing sessionID and names the cookie WebSession_<hex>
    this.suffixCookieName = !!opts.suffixCookieName;
    this.hideSessionIdEcho = !!opts.hideSessionIdEcho;
    // login answers OK but the session is never actually usable -> client must fall back
    this.breakSession = !!opts.breakSession;
    // snapshot on these channels answers 503 Device Busy
    this.busySnapshotChannels = opts.busySnapshotChannels || [];
    // channels that actually produce a picture
    this.pictureChannels = opts.pictureChannels || [101, 102];
    // EZVIZ / 萤石云 state (field names copied from a real HK-Y2S4M-GL/L)
    this.ezviz = {
      enabled: false,
      registerStatus: 'false',
      verificationCode: '',
      unsupported: false,
      ...(opts.ezviz || {}),
    };
    this.activationCalls = [];
    this.pendingChallenge = null;

    this.state = {
      ip: opts.ip || '192.168.1.64',
      mask: '255.255.255.0',
      gateway: '192.168.1.1',
      dns: '192.168.1.1',
      addressingType: 'static',
      time: '2025-01-01T00:00:00',
      timeMode: 'manual',
      ntpServer: '',
      users: [{ id: '1', userName: this.username, userLevel: 'Administrator', password: this.password }],
    };

    this.requests = [];
    this.server = http.createServer((req, res) => this._handle(req, res));
  }

  listen(port = 0) {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  _xml(res, code, body) {
    const buf = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\r\n${body}`, 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/xml', 'Content-Length': buf.length });
    res.end(buf);
  }

  _status(res, statusCode, sub = '', str = 'OK') {
    return this._xml(res, 200,
      `<ResponseStatus><statusCode>${statusCode}</statusCode>`
      + `<statusString>${str}</statusString>`
      + (sub ? `<subStatusCode>${sub}</subStatusCode>` : '')
      + '</ResponseStatus>');
  }

  _json(res, code, obj) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
    res.end(buf);
  }

  /** @returns {boolean} authorised */
  _authorized(req) {
    if (this.authMode === 'anonymous') return true;
    if (this.authMode === 'digest') return false;
    // Accept any cookie whose name starts with WebSession (real firmware uses
    // `WebSession_<8 hex>`).
    const cookie = String(req.headers.cookie || '');
    const m = /(?:^|;\s*)WebSession[^=;]*=([^;]+)/.exec(cookie);
    if (m && this.sessions.has(m[1])) {
      const s = this.sessions.get(m[1]);
      if (s.requireTag && String(req.headers.sessiontag || '') !== s.sessionTag) return false;
      return true;
    }
    return false;
  }

  _digestChallenge(res) {
    res.writeHead(401, {
      'WWW-Authenticate': `Digest realm="IP Camera(MOCK)", qop="auth", nonce="${this.digestNonce}", opaque="abc123", algorithm=MD5`,
      'Content-Type': 'application/xml',
    });
    res.end('<ResponseStatus><statusCode>4</statusCode><statusString>Unauthorized</statusString></ResponseStatus>');
  }

  _checkDigest(req) {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Digest ')) return false;
    const f = {};
    const re = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^\s,]+))/g;
    let m;
    while ((m = re.exec(auth.slice(7)))) f[m[1]] = m[2] !== undefined ? m[2] : m[3];
    if (f.nonce !== this.digestNonce) return false;
    const ha1 = md5(`${this.username}:IP Camera(MOCK):${this.password}`);
    const ha2 = md5(`${req.method}:${f.uri}`);
    const expect = f.qop
      ? md5(`${ha1}:${f.nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`)
      : md5(`${ha1}:${f.nonce}:${ha2}`);
    return expect === f.response;
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = raw.toString('utf8');
    this.requests.push({ method: req.method, path: req.url });

    /* ---------------- unauthenticated ---------------- */

    if (p === '/SDK/activateStatus') {
      return this._xml(res, 200,
        `<ActivateStatus><Activated>${this.activated}</Activated><supportVersion>${this.supportVersion}</supportVersion></ActivateStatus>`);
    }

    // Before activation the device refuses everything else (real firmware answers
    // HTTP 403 + statusCode 4 "Invalid Operation").
    if (!this.activated && p !== '/ISAPI/System/activate/GetChallengeV3'
        && p !== '/ISAPI/System/activate/StartActivateV3') {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?>\r\n<ResponseStatus version="2.0">'
        + '<requestURL></requestURL><statusCode>4</statusCode>'
        + '<statusString>Invalid Operation</statusString></ResponseStatus>');
      return;
    }

    if (p === '/ISAPI/System/activate/GetChallengeV3') {
      this.activationCalls.push({ step: 'GetChallengeV3', body: body.slice(0, 200) });
      let pub = null;
      try { pub = JSON.parse(body).publicKey; } catch { /* maybe xml */ }
      if (!pub) { this._json(res, 400, { statusCode: 5, statusString: 'publicKey required' }); return; }

      // Real firmware wants base64(modulus-as-hex) — see src/activate.js. Accept that
      // first, then fall back to DER so the mock also covers other encodings.
      const decoded = Buffer.from(pub, 'base64');
      const asText = decoded.toString('utf8');
      let publicKeyObject = null;
      let acceptedFormat = '';
      if (/^[0-9a-fA-F]+$/.test(asText) && asText.length >= 128) {
        try {
          let n = asText;
          if (n.length % 2) n = '0' + n;
          publicKeyObject = createPublicKey({
            key: { kty: 'RSA', n: Buffer.from(n, 'hex').toString('base64url'), e: 'AQAB' },
            format: 'jwk',
          });
          acceptedFormat = 'hex-modulus';
        } catch (e) {
          this.activationCalls.push({ step: 'GetChallengeV3', error: `hex-modulus 解析失败: ${e.message}` });
        }
      }
      if (!publicKeyObject) {
        try {
          publicKeyObject = createPublicKey({ key: decoded, format: 'der', type: 'spki' });
          acceptedFormat = 'spki-der';
        } catch (e) {
          this.activationCalls.push({ step: 'GetChallengeV3', error: `DER 解析失败: ${e.message}` });
        }
      }
      if (!publicKeyObject) {
        this._json(res, 400, { statusCode: 6, statusString: 'Invalid JSON Content', subStatusCode: 'badParameters' });
        return;
      }
      this.activationCalls.push({ step: 'GetChallengeV3', acceptedFormat });
      // The real HK-Y2S4M-GL/L returns a 16-byte challenge (32 hex chars) -> AES-128.
      // `challengeBytes` lets tests exercise the 24/32-byte variants too.
      const challengeHex = randomBytes(this.challengeBytes).toString('hex');
      this.pendingChallenge = challengeHex;
      let enc;
      try {
        enc = publicEncrypt(
          { key: publicKeyObject, padding: cryptoConst.RSA_PKCS1_PADDING },
          Buffer.from(challengeHex, 'utf8'),
        );
      } catch (e) {
        this.activationCalls.push({ step: 'GetChallengeV3', error: `加密失败: ${e.message}` });
        this._json(res, 400, { statusCode: 5, statusString: `bad publicKey: ${e.message}` });
        return;
      }
      // Wire format mirrors the firmware: base64 of the HEX string of the ciphertext.
      return this._json(res, 200, { challenge: Buffer.from(enc.toString('hex'), 'utf8').toString('base64') });
    }

    if (p === '/ISAPI/System/activate/StartActivateV3') {
      let payload = null;
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      this.activationCalls.push({ step: 'StartActivateV3', hasPassword: !!(payload && payload.password), iv: payload && payload.iv });
      if (!payload || !payload.password || !payload.iv || !this.pendingChallenge) {
        this._json(res, 400, { statusCode: 5, statusString: 'password/iv required' });
        return;
      }
      const iv = Buffer.from(String(payload.iv), 'hex');
      const key = Buffer.from(this.pendingChallenge, 'hex');
      if (iv.length !== 16 || ![16, 24, 32].includes(key.length)) {
        this._json(res, 400, { statusCode: 5, statusString: 'bad iv/key length' });
        return;
      }
      let plain;
      try {
        // The transmitted value is base64(ascii-hex-of-ciphertext).
        const hexCipher = Buffer.from(String(payload.password), 'base64').toString('ascii');
        const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
        plain = Buffer.concat([decipher.update(Buffer.from(hexCipher, 'hex')), decipher.final()]).toString('utf8');
      } catch (e) {
        this.activationCalls.push({ step: 'StartActivateV3', error: `AES 解密失败: ${e.message}` });
        this._json(res, 400, { statusCode: 5, statusString: `decrypt failed: ${e.message}` });
        return;
      }
      const prefix = this.pendingChallenge.substring(0, 16);
      if (!plain.startsWith(prefix)) {
        this.activationCalls.push({ step: 'StartActivateV3', error: 'challenge 前缀不匹配' });
        this._json(res, 400, { statusCode: 5, statusString: 'challenge prefix mismatch' });
        return;
      }
      const newPassword = plain.slice(prefix.length);
      this.password = newPassword;
      this.state.users = [{ id: '1', userName: this.username, userLevel: 'Administrator', password: newPassword }];
      this.activated = true;
      this.pendingChallenge = null;
      const oldSerial = this.serial;
      this.serial = oldSerial; // unchanged by activation
      return this._json(res, 200, { statusCode: 1, statusString: 'OK' });
    }

    if (p === '/ISAPI/Security/sessionLogin/capabilities') {
      if (this.authMode === 'digest') { this._digestChallenge(res); return; }
      const challenge = randomBytes(8).toString('hex');
      const salt = randomBytes(4).toString('hex');
      const sessionID = randomBytes(8).toString('hex');
      this.pending = { challenge, salt, sessionID };
      return this._xml(res, 200,
        '<SessionLoginCap>'
        + `<sessionID>${sessionID}</sessionID>`
        + `<challenge>${challenge}</challenge>`
        + `<salt>${salt}</salt>`
        + `<iterations>${this.iterations}</iterations>`
        + `<isIrreversible>${this.isIrreversible}</isIrreversible>`
        + '<sessionIDVersion>2</sessionIDVersion>'
        + '<isSupportSessionTag>true</isSupportSessionTag>'
        + '</SessionLoginCap>');
    }

    if (p === '/ISAPI/Security/sessionLogin') {
      if (this.authMode === 'digest') { this._digestChallenge(res); return; }
      const pending = this.pending;
      if (!pending) { this._status(res, 4); return; }
      const user = /<userName>([^<]*)<\/userName>/.exec(body);
      const pwd = /<password>([^<]*)<\/password>/.exec(body);
      const sid = /<sessionID>([^<]*)<\/sessionID>/.exec(body);
      const userName = user ? user[1] : '';
      const supplied = pwd ? pwd[1] : '';
      if (!sid || sid[1] !== pending.sessionID || userName !== this.username) {
        this._status(res, 4); return;
      }
      const expect = deviceEncodePwd(this.password, {
        userName,
        salt: pending.salt,
        challenge: pending.challenge,
        iterations: this.iterations,
      }, this.isIrreversible);
      if (supplied !== expect) { this._status(res, 4); return; }

      const sessionTag = randomBytes(8).toString('hex');
      if (!this.breakSession) {
        this.sessions.set(pending.sessionID, { sessionTag, at: Date.now(), requireTag: false });
      }

      if (this.suffixCookieName || this.hideSessionIdEcho) {
        // Faithful to HK-Y2S4M-GL/L: cookie named WebSession_<hex>, sessionID not echoed,
        // success signalled by statusValue/statusString, SessionTag returned.
        const cookieName = this.suffixCookieName
          ? `WebSession_${randomBytes(4).toString('hex')}`
          : 'WebSession';
        res.setHeader('Set-Cookie', `${cookieName}=${pending.sessionID}; path=/;HttpOnly`);
        return this._xml(res, 200,
          '<SessionLogin><statusValue>200</statusValue><statusString>OK</statusString>'
          + '<isSupportLoginTiming>true</isSupportLoginTiming>'
          + `<sessionTag>${sessionTag}</sessionTag></SessionLogin>`);
      }

      return this._xml(res, 200,
        '<SessionLogin>'
        + `<sessionID>${pending.sessionID}</sessionID>`
        + `<sessionTag>${sessionTag}</sessionTag>`
        + '<isSessionIDValidLongTerm>false</isSessionIDValidLongTerm>'
        + '</SessionLogin>');
    }

    /* ---------------- authenticated ---------------- */

    if (this.authMode === 'digest') {
      if (!this._checkDigest(req)) { this._digestChallenge(res); return; }
    } else if (this.authMode === 'both') {
      if (!this._authorized(req) && !this._checkDigest(req)) { this._digestChallenge(res); return; }
    } else if (!this._authorized(req)) {
      // Real firmware answers HTTP 401 here (verified on a live HK-Y2S4M-GL/L).
      res.writeHead(401, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?>\r\n'
        + '<ResponseStatus><statusCode>4</statusCode><statusString>Invalid Operation</statusString>'
        + '<subStatusCode>notAuthorized</subStatusCode></ResponseStatus>');
      return;
    }

    if (p === '/ISAPI/Security/sessionHeartbeat') return this._status(res, 1);
    if (p === '/ISAPI/Security/sessionLogout') {
      const m = /WebSession=([^;]+)/.exec(String(req.headers.cookie || ''));
      if (m) this.sessions.delete(m[1]);
      return this._status(res, 1);
    }

    if (p === '/ISAPI/System/deviceInfo') {
      return this._xml(res, 200,
        '<DeviceInfo>'
        + '<deviceName>MOCK-CAM</deviceName>'
        + `<model>${this.model}</model>`
        + `<serialNumber>${this.serial}</serialNumber>`
        + '<macAddress>aa:bb:cc:dd:ee:01</macAddress>'
        + `<firmwareVersion>${this.firmware}</firmwareVersion>`
        + '<firmwareReleasedDate>2023-06-12</firmwareReleasedDate>'
        + '<encoderVersion>V7.3</encoderVersion>'
        + '<deviceType>IPCamera</deviceType>'
        + '<deviceID>1</deviceID>'
        + '</DeviceInfo>');
    }

    if (p === '/ISAPI/System/capabilities') {
      return this._xml(res, 200,
        '<DeviceCap><sysCap><isSupportISAPI>true</isSupportISAPI></sysCap>'
        + '<DeviceCap><WEBLocation>remote</WEBLocation></DeviceCap></DeviceCap>');
    }

    if (p === '/ISAPI/System/Video/inputs/channels') {
      return this._xml(res, 200,
        '<VideoInputChannelList><VideoInputChannel><id>1</id><name>Camera 1</name></VideoInputChannel></VideoInputChannelList>');
    }

    if (p === '/ISAPI/System/Network/interfaces/1/ipAddress') {
      if (req.method === 'GET') {
        return this._xml(res, 200,
          '<IPAddress>'
          + `<ipAddress>${this.state.ip}</ipAddress>`
          + `<subnetMask>${this.state.mask}</subnetMask>`
          + `<addressingType>${this.state.addressingType}</addressingType>`
          + `<DefaultGateway><ipAddress>${this.state.gateway}</ipAddress></DefaultGateway>`
          + `<PrimaryDNS><ipAddress>${this.state.dns}</ipAddress></PrimaryDNS>`
          + '<MACAddress>aa:bb:cc:dd:ee:01</MACAddress>'
          + '</IPAddress>');
      }
      const ip = /<ipAddress>([^<]*)<\/ipAddress>/.exec(body);
      const mask = /<subnetMask>([^<]*)<\/subnetMask>/.exec(body);
      const gw = /<DefaultGateway>\s*<ipAddress>([^<]*)<\/ipAddress>/.exec(body);
      if (ip) this.state.ip = ip[1];
      if (mask) this.state.mask = mask[1];
      if (gw) this.state.gateway = gw[1];
      return this._status(res, 7, 'rebootRequired', 'rebootRequired');
    }

    if (p === '/ISAPI/System/time') {
      if (req.method === 'GET') {
        return this._xml(res, 200,
          `<Time><timeMode>${this.state.timeMode}</timeMode><localTime>${this.state.time}</localTime><timeZone>CST-8:00:00</timeZone></Time>`);
      }
      const t = /<localTime>([^<]*)<\/localTime>/.exec(body);
      const m = /<timeMode>([^<]*)<\/timeMode>/.exec(body);
      if (t) this.state.time = t[1];
      if (m) this.state.timeMode = m[1];
      return this._status(res, 1);
    }

    if (p === '/ISAPI/System/time/ntpServers/1') {
      if (req.method === 'GET') {
        return this._xml(res, 200, `<NTPServer><id>1</id><ipAddress>${this.state.ntpServer}</ipAddress><portNo>123</portNo><synchronizeInterval>60</synchronizeInterval></NTPServer>`);
      }
      const s = /<ipAddress>([^<]*)<\/ipAddress>/.exec(body);
      if (s) this.state.ntpServer = s[1];
      return this._status(res, 1);
    }

    if (p === '/ISAPI/Security/users' && req.method === 'GET') {
      return this._xml(res, 200,
        '<UserList>' + this.state.users.map((u) => `<User><id>${u.id}</id><userName>${u.userName}</userName><userLevel>${u.userLevel}</userLevel></User>`).join('') + '</UserList>');
    }

    if (p.startsWith('/ISAPI/Security/users/')) {
      const uid = decodeURIComponent(p.slice('/ISAPI/Security/users/'.length));
      const u = this.state.users.find((x) => x.id === uid || x.userName === uid);
      if (!u) { this._status(res, 5, 'notSupport'); return; }
      if (req.method === 'GET') {
        return this._xml(res, 200, `<User><id>${u.id}</id><userName>${u.userName}</userName><userLevel>${u.userLevel}</userLevel><password>******</password></User>`);
      }
      const np = /<password>([^<]*)<\/password>/.exec(body);
      if (np) { u.password = np[1]; if (u.userName === this.username) this.password = np[1]; }
      return this._status(res, 1);
    }

    if (p === '/ISAPI/System/Network/EZVIZ/capabilities') {
      // A device without EZVIZ support has no capabilities endpoint either.
      if (this.ezviz.unsupported) return this._status(res, 3, 'notSupport', 'notSupport');
      return this._xml(res, 200,
        '<EZVIZ version="2.0">'
        + `<enabled opt="true,false">${this.ezviz.enabled}</enabled>`
        + `<registerStatus opt="true,false">${this.ezviz.registerStatus}</registerStatus>`
        + '<serverAddress><addressingFormatType>hostname</addressingFormatType><hostName>litedev.ys7.com</hostName></serverAddress>'
        + '<verificationCode min="6" max="12"/>'
        + '<streamEncrypteEnabled opt="true,false">true</streamEncrypteEnabled>'
        + '<isSupportUpISAPI>true</isSupportUpISAPI>'
        + '<isSupportDownISAPI>true</isSupportDownISAPI>'
        + '</EZVIZ>');
    }

    if (p === '/ISAPI/System/Network/EZVIZ') {
      if (this.ezviz.unsupported) return this._status(res, 3, 'notSupport', 'notSupport');
      return this._xml(res, 200,
        '<EZVIZ version="2.0">'
        + `<enabled>${this.ezviz.enabled}</enabled>`
        + `<registerStatus>${this.ezviz.registerStatus}</registerStatus>`
        + '<redirect>true</redirect>'
        + '<serverAddress><addressingFormatType>hostname</addressingFormatType><hostName>litedev.ys7.com</hostName></serverAddress>'
        + `<verificationCode>${this.ezviz.verificationCode || ''}</verificationCode>`
        + '<convergenceCloudEnabled>false</convergenceCloudEnabled>'
        + '<upISAPIStatus>close</upISAPIStatus>'
        + '</EZVIZ>');
    }

    if (p === '/ISAPI/System/reboot') {
      this.rebootCalled = true;
      return this._status(res, 1);
    }

    if (p === '/ISAPI/System/factoryReset') {
      const call = { mode: url.searchParams.get('mode'), loginPassword: url.searchParams.get('loginPassword') };
      if (!call.loginPassword && call.mode === 'full') {
        // demand the second factor once, like some real firmware
        call.demandedPassword = true;
        this.resetCalls.push(call);
        this.resetCalled = call;
        return this._status(res, 10, 'needPassword');
      }
      this.resetCalls.push(call);
      this.resetCalled = call;
      return this._status(res, 1);
    }

    if (p === '/ISAPI/System/upgradeStatus') {
      return this._xml(res, 200, '<UpgradeStatus><status>success</status><percent>100</percent><description>升级完成</description></UpgradeStatus>');
    }

    if (p === '/ISAPI/System/updateFirmware' && req.method === 'PUT') {
      this.upgradeBytes = raw.length;
      return this._status(res, 1);
    }

    if (p === '/ISAPI/Streaming/channels') {
      return this._xml(res, 200,
        '<StreamingChannelList><StreamingChannel><id>101</id><channelName>Camera 1</channelName><enabled>true</enabled></StreamingChannel></StreamingChannelList>');
    }

    if (/^\/ISAPI\/Streaming\/channels\/\d+\/picture$/.test(p)) {
      const m = /channels\/(\d+)\/picture/.exec(p);
      const ch = Number(m[1]);
      if (!this.pictureChannels.includes(ch)) {
        return this._status(res, 3, 'notSupport', 'notSupport');
      }
      if (this.busySnapshotChannels.includes(ch)) {
        return this._status(res, 2, 'deviceBusy', 'Device Busy');
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length });
      res.end(JPEG);
      return;
    }

    if (/^\/ISAPI\/Streaming\/channels\/\d+\/httpPreview$/.test(p)) {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=mockframe' });
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        if (n > 3 || res.writableEnded) { clearInterval(timer); res.end(); return; }
        res.write('--mockframe\r\nContent-Type: image/jpeg\r\nContent-Length: ' + JPEG.length + '\r\n\r\n');
        res.write(JPEG);
        res.write('\r\n');
      }, 60);
      res.on('close', () => clearInterval(timer));
      return;
    }

    this._status(res, 3, 'notSupport', 'notSupport');
  }
}

/* Allow `node test/mock-device.js 9000` for manual poking. */
if (process.argv[1] && process.argv[1].endsWith('mock-device.js')) {
  const port = Number(process.argv[2]) || 9100;
  const d = new MockDevice({});
  d.listen(port).then((p) => {
    console.log(`mock ISAPI device listening on 127.0.0.1:${p}  user=admin pass=Test@12345`);
  });
}