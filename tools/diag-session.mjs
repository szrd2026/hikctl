// Full sessionLogin exchange against a real device, with every intermediate value printed.
import http from 'node:http';
import { encodePwd, makeLoginRandom, buildSessionLoginXml, md5 } from '../src/auth.js';

const ip = process.argv[2] || '192.168.1.64';
const port = Number(process.argv[3]) || 80;
const user = process.argv[4] || 'admin';
const pass = process.argv[5] || '1q2w3e4r';

function req(method, path, body, ctype) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(body, 'utf8') : null;
    const headers = { Accept: '*/*', Connection: 'close' };
    if (payload) { headers['Content-Length'] = payload.length; headers['Content-Type'] = ctype || 'application/xml'; }
    const r = http.request({ host: ip, port, method, path, headers }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') }));
    });
    r.setTimeout(12000, () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ status: 0, text: `ERR ${e.message}` }));
    if (payload) r.write(payload);
    r.end();
  });
}

const random = makeLoginRandom();
const capPath = `/ISAPI/Security/sessionLogin/capabilities?username=${encodeURIComponent(user)}&random=${random}`;
console.log(`1) GET ${capPath}`);
const capRes = await req('GET', capPath);
console.log(`   HTTP ${capRes.status}`);
console.log('   ' + capRes.text.replace(/\s+/g, ' ').slice(0, 700));

const g = (n) => { const m = new RegExp(`<${n}>([^<]*)</${n}>`).exec(capRes.text); return m ? m[1] : ''; };
const cap = {
  sessionID: g('sessionID'),
  challenge: g('challenge'),
  salt: g('salt'),
  iterations: Number(g('iterations') || 1),
  isIrreversible: /^true$/i.test(g('isIrreversible')),
  sessionIDVersion: Number(g('sessionIDVersion') || 1),
  isSupportSessionTag: /^true$/i.test(g('isSupportSessionTag')),
};
console.log('\n   解析结果:', JSON.stringify({
  ...cap, challenge: cap.challenge ? `${cap.challenge.slice(0, 12)}…(${cap.challenge.length} chars)` : '',
}));

const digest = encodePwd(pass, {
  userName: user, salt: cap.salt, challenge: cap.challenge, iIterate: cap.iterations,
}, cap.isIrreversible);
console.log(`\n2) encodePwd -> ${digest}`);

const xml = buildSessionLoginXml({
  userName: user, passwordDigest: digest, sessionID: cap.sessionID,
  sessionIDVersion: cap.sessionIDVersion, needSessionTag: cap.isSupportSessionTag,
});
console.log('\n3) POST /ISAPI/Security/sessionLogin?timeStamp=…');
console.log('   body: ' + xml.replace(/\r?\n/g, ' ').slice(0, 500));
const res = await req('POST', `/ISAPI/Security/sessionLogin?timeStamp=${Date.now()}`, xml);
console.log(`   HTTP ${res.status}`);
console.log('   ' + res.text.replace(/\s+/g, ' ').slice(0, 700));

// If the irreversible branch failed, try the other one — diagnostic only.
if (!/<sessionID>/.test(res.text)) {
  console.log('\n4) 重试：普通（非不可逆）分支');
  const d2 = encodePwd(pass, { userName: user, salt: cap.salt, challenge: cap.challenge, iIterate: cap.iterations }, false);
  const x2 = buildSessionLoginXml({
    userName: user, passwordDigest: d2, sessionID: cap.sessionID,
    sessionIDVersion: cap.sessionIDVersion, needSessionTag: cap.isSupportSessionTag,
  });
  const r2 = await req('POST', `/ISAPI/Security/sessionLogin?timeStamp=${Date.now()}`, x2);
  console.log(`   HTTP ${r2.status}  ${r2.text.replace(/\s+/g, ' ').slice(0, 400)}`);
}