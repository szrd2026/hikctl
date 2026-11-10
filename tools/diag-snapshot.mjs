// Diagnose snapshot / preview availability on a real device (read-only).
import { IsapiClient } from '../src/client.js';
import { probe } from '../src/ops.js';

const ip = process.argv[2] || '192.168.1.64';
const port = Number(process.argv[3]) || 80;
const user = process.argv[4] || 'admin';
const pass = process.argv[5] || '1q2w3e4r';

const client = new IsapiClient({ ip, port, username: user, password: pass, timeoutMs: 12000 });
const st = await probe(client, { deep: true });
console.log('probe:', JSON.stringify({ online: st.online, authMode: st.authMode, model: st.model, latencyMs: st.latencyMs }));

const paths = [
  '/ISAPI/Streaming/channels/101/picture',
  '/ISAPI/Streaming/channels/102/picture',
  '/ISAPI/Streaming/channels/101/picture?videoResolutionWidth=1920&videoResolutionHeight=1080',
  '/ISAPI/Streaming/channels/1/picture',
  '/ISAPI/Streaming/channels/101',
  '/ISAPI/Streaming/channels',
  '/ISAPI/System/Video/inputs/channels',
  '/ISAPI/Streaming/channels/101/httpPreview',
];

for (const p of paths) {
  const t0 = Date.now();
  try {
    const r = await client.request('GET', p, { timeoutMs: 12000, retries: 0 });
    const ct = String(r.headers['content-type'] || '');
    const isImg = /image\//i.test(ct);
    console.log(`\n${p}\n  HTTP ${r.status}  ${ct}  ${r.body.length} bytes  ${Date.now() - t0} ms${isImg ? '   <== JPEG' : ''}`);
    if (!isImg) console.log(`  body: ${r.text.replace(/\s+/g, ' ').slice(0, 220)}`);
    else console.log(`  magic: ${r.body.subarray(0, 3).toString('hex')}`);
  } catch (e) {
    console.log(`\n${p}\n  ERROR ${Date.now() - t0} ms: ${e.message}${e.body ? ' | ' + String(e.body).replace(/\s+/g, ' ').slice(0, 200) : ''}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}

// session login capability, for completeness
const cap = await client._raw('GET', '/ISAPI/Security/sessionLogin/capabilities?username=admin&random=12345678', { timeoutMs: 8000 });
console.log(`\n/ISAPI/Security/sessionLogin/capabilities -> HTTP ${cap.status}`);
console.log('  ' + cap.body.toString('utf8').replace(/\s+/g, ' ').slice(0, 260));

client.close();