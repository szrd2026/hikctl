// Why does this firmware accept sessionLogin but then not serve requests under it?
import http from 'node:http';
import { encodePwd, makeLoginRandom, buildSessionLoginXml, parseDigestChallenge, buildDigestAuth, md5 } from '../src/auth.js';

const ip = process.argv[2] || '192.168.1.64';
const port = Number(process.argv[3]) || 80;
const user = process.argv[4] || 'admin';
const pass = process.argv[5] || '1q2w3e4r';

function req(method, path, { body, headers = {}, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(body, 'utf8') : null;
    const h = { Accept: '*/*', ...headers };
    if (payload) { h['Content-Length'] = payload.length; h['Content-Type'] = h['Content-Type'] || 'application/xml'; }
    const r = http.request({ host: ip, port, method, path, headers: h }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8'), ms: Date.now() - t0 }));
    });
    const t0 = Date.now();
    r.setTimeout(timeoutMs, () => r.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    r.on('error', (e) => resolve({ status: 0, headers: {}, text: `ERR ${e.message}`, ms: Date.now() - t0 }));
    if (payload) r.write(payload);
    r.end();
  });
}

const random = makeLoginRandom();
const capRes = await req('GET', `/ISAPI/Security/sessionLogin/capabilities?username=${user}&random=${random}`);
const g = (n) => { const m = new RegExp(`<${n}[^>]*>([^<]*)</${n}>`).exec(capRes.text); return m ? m[1] : ''; };
const cap = {
  sessionID: g('sessionID'), challenge: g('challenge'), salt: g('salt'),
  iterations: Number(g('iterations') || 1), isIrreversible: /^true$/i.test(g('isIrreversible')),
  sessionIDVersion: Number(g('sessionIDVersion') || 1),
};
const digest = encodePwd(pass, { userName: user, salt: cap.salt, challenge: cap.challenge, iIterate: cap.iterations }, cap.isIrreversible);
const xml = buildSessionLoginXml({ userName: user, passwordDigest: digest, sessionID: cap.sessionID, sessionIDVersion: cap.sessionIDVersion, needSessionTag: true });
const login = await req('POST', `/ISAPI/Security/sessionLogin?timeStamp=${Date.now()}`, { body: xml });
console.log(`sessionLogin  HTTP ${login.status}  ${login.ms}ms`);
console.log('  响应头:', JSON.stringify(login.headers));
console.log('  响应体:', login.text.replace(/\s+/g, ' ').slice(0, 300));
console.log(`  capabilities 里的 sessionID = ${cap.sessionID}`);

const D = '/ISAPI/System/deviceInfo';
const trials = [
  ['无鉴权', {}],
  ['Cookie: WebSession=cap.sessionID', { Cookie: `WebSession=${cap.sessionID}` }],
  ['Cookie + SessionTag=""', { Cookie: `WebSession=${cap.sessionID}`, SessionTag: '' }],
  ['SessionTag=cap.sessionID', { Cookie: `WebSession=${cap.sessionID}`, SessionTag: cap.sessionID }],
  ['Cookie + Connection:close', { Cookie: `WebSession=${cap.sessionID}`, Connection: 'close' }],
];

for (const [name, headers] of trials) {
  const r = await req('GET', D, { headers, timeoutMs: 6000 });
  console.log(`\n${name}\n  HTTP ${r.status}  ${r.ms}ms  ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`);
}

// digest for comparison
const chal = await req('GET', D);
if (chal.status === 401) {
  const c = parseDigestChallenge(chal.headers['www-authenticate']);
  const h = buildDigestAuth({ username: user, password: pass, method: 'GET', uri: D, challenge: c, nc: 1 });
  const dr = await req('GET', D, { headers: { Authorization: h } });
  console.log(`\nHTTP Digest\n  HTTP ${dr.status}  ${dr.ms}ms  ${dr.text.replace(/\s+/g, ' ').slice(0, 120)}`);
} else {
  console.log(`\n首次无鉴权返回 HTTP ${chal.status}（未提供 Digest 挑战）`);
}