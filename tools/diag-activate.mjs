// Diagnostic: probe the real device's GetChallengeV3 with several body shapes and
// print the FULL error it returns. Non-destructive.
import crypto from 'node:crypto';
import http from 'node:http';

const ip = process.argv[2] || '192.168.1.64';
const port = Number(process.argv[3]) || 80;

function post(path, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const payload = Buffer.from(body, 'utf8');
    const req = http.request({
      host: ip, port, method: 'POST', path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Accept: '*/*',
        Connection: 'close',
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, text: `ERROR ${e.message}` }));
    req.write(payload);
    req.end();
  });
}

const { publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});

const spkiB64 = publicKey.toString('base64');
const pkcs1B64 = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
  .export({ type: 'pkcs1', format: 'der' }).toString('base64');
const pem = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
  .export({ type: 'spki', format: 'pem' }).toString();
const pemB64 = Buffer.from(pem, 'utf8').toString('base64');

const path = '/ISAPI/System/activate/GetChallengeV3?format=json';

const cases = [
  ['spki-der  {"publicKey":b64}', path, JSON.stringify({ publicKey: spkiB64 })],
  ['pkcs1-der {"publicKey":b64}', path, JSON.stringify({ publicKey: pkcs1B64 })],
  ['pem-text  {"publicKey":b64}', path, JSON.stringify({ publicKey: pemB64 })],
  ['pem 原文   {"publicKey":pem}', path, JSON.stringify({ publicKey: pem })],
  ['无 format=json', '/ISAPI/System/activate/GetChallengeV3', JSON.stringify({ publicKey: spkiB64 })],
  ['空 JSON {}', path, '{}'],
  ['GET 方式', '/ISAPI/System/activate/GetChallengeV3?format=json', ''],
];

for (const [name, p, body] of cases) {
  const r = await post(p, body);
  console.log(`\n──────── ${name} ────────`);
  console.log(`HTTP ${r.status}`);
  console.log(r.text.slice(0, 900));
}