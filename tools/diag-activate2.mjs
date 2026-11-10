// Broader activation-endpoint reconnaissance. Nothing here changes device state:
// GetChallengeV3 / Security/challenge only perform a public-key handshake.
import crypto from 'node:crypto';
import http from 'node:http';

const ip = process.argv[2] || '192.168.1.64';
const port = Number(process.argv[3]) || 80;

function req(method, path, body, ctype) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(body, 'utf8') : null;
    const headers = { Accept: '*/*', Connection: 'close' };
    if (payload) { headers['Content-Length'] = payload.length; headers['Content-Type'] = ctype || 'application/json'; }
    const r = http.request({ host: ip, port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.setTimeout(12000, () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ status: 0, text: `ERR ${e.message}` }));
    if (payload) r.write(payload);
    r.end();
  });
}

const short = (s) => String(s).replace(/\s+/g, ' ').slice(0, 240);

// ---- key material for both protocol generations ----
const v3 = crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});
const v1 = crypto.generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});
const v3b64 = v3.publicKey.toString('base64');
const v1b64 = v1.publicKey.toString('base64');

const probes = [
  ['GET  activate/capabilities', () => req('GET', '/ISAPI/System/activate/capabilities')],
  ['GET  activate (no body)', () => req('GET', '/ISAPI/System/activate')],
  ['GET  activateStatus', () => req('GET', '/SDK/activateStatus')],
  ['POST Security/challenge (V1, XML 1024)', () => req('POST', '/ISAPI/Security/challenge',
    `<?xml version="1.0" encoding="UTF-8"?><PublicKey><key>${v1b64}</key></PublicKey>`, 'application/xml')],
  ['POST Security/challenge (V1, json)', () => req('POST', '/ISAPI/Security/challenge?format=json',
    JSON.stringify({ publicKey: v1b64 }), 'application/json')],
  ['POST GetChallengeV3 +charset', () => req('POST', '/ISAPI/System/activate/GetChallengeV3?format=json',
    JSON.stringify({ publicKey: v3b64 }), 'application/json;charset=UTF-8')],
  ['POST GetChallengeV3 +username', () => req('POST', '/ISAPI/System/activate/GetChallengeV3?format=json',
    JSON.stringify({ userName: 'admin', publicKey: v3b64 }), 'application/json')],
  ['POST GetChallengeV3 大写 PublicKey', () => req('POST', '/ISAPI/System/activate/GetChallengeV3?format=json',
    JSON.stringify({ PublicKey: v3b64 }), 'application/json')],
  ['POST GetChallengeV3 key 字段名', () => req('POST', '/ISAPI/System/activate/GetChallengeV3?format=json',
    JSON.stringify({ key: v3b64 }), 'application/json')],
  ['POST GetChallengeV3 无 format', () => req('POST', '/ISAPI/System/activate/GetChallengeV3',
    JSON.stringify({ publicKey: v3b64 }), 'application/json')],
  ['POST GetChallengeV3 as XML', () => req('POST', '/ISAPI/System/activate/GetChallengeV3',
    `<?xml version="1.0" encoding="UTF-8"?><PublicKey><key>${v3b64}</key></PublicKey>`, 'application/xml')],
];

for (const [name, fn] of probes) {
  const r = await fn();
  const flag = r.status === 200 ? '  <== OK' : '';
  console.log(`\n──── ${name}${flag}`);
  console.log(`  HTTP ${r.status}  ${short(r.text)}`);
}