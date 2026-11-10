// What EZVIZ / cloud-binding information can we actually get from this device?
import { IsapiClient } from '../src/client.js';

const ip = process.argv[2] || '192.168.1.64';
const port = Number(process.argv[3]) || 80;
const user = process.argv[4] || 'admin';
const pass = process.argv[5] || '1q2w3e4r';

const c = new IsapiClient({ ip, port, username: user, password: pass, timeoutMs: 12000 });
await c.login();
console.log(`登录: authMode=${c.authMode}\n`);

const paths = [
  '/ISAPI/System/Network/EZVIZ',
  '/ISAPI/System/Network/EZVIZ/capabilities',
  '/ISAPI/System/Network/EZVIZ/QRCode',
  '/ISAPI/System/Network/EZVIZ/unbind',
  '/ISAPI/System/Network/HikCloud',
  '/ISAPI/System/Network/Integrate',
  '/ISAPI/System/capabilities',
];

for (const p of paths) {
  try {
    const r = await c.request('GET', p, { timeoutMs: 10000, retries: 0 });
    const txt = r.text.replace(/\s+/g, ' ');
    console.log(`\n──── ${p}   HTTP ${r.status}  ${r.body.length} 字节`);
    console.log('  ' + txt.slice(0, 700));
  } catch (e) {
    console.log(`\n──── ${p}   ✗ ${e.message}`);
    if (e.body) console.log('  ' + String(e.body).replace(/\s+/g, ' ').slice(0, 240));
  }
  await new Promise((r) => setTimeout(r, 200));
}
c.close();