// Does a reboot actually restart the device? A real restart destroys every ISAPI
// session, so we log in, reboot, then replay the OLD session cookie.
import http from 'node:http';
import { encodePwd, makeLoginRandom, buildSessionLoginXml } from '../src/auth.js';

const ip = process.argv[2] || '192.168.1.64';
const port = Number(process.argv[3]) || 80;
const user = process.argv[4] || 'admin';
const pass = process.argv[5] || '1q2w3e4r';

function req(method, path, { body, headers = {}, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(body, 'utf8') : null;
    const h = { Accept: '*/*', Connection: 'close', ...headers };
    if (payload) { h['Content-Length'] = payload.length; h['Content-Type'] = h['Content-Type'] || 'application/xml'; }
    const t0 = Date.now();
    const r = http.request({ host: ip, port, method, path, headers: h }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8'), ms: Date.now() - t0 }));
    });
    r.setTimeout(timeoutMs, () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ status: 0, headers: {}, text: `ERR ${e.message}`, ms: Date.now() - t0 }));
    if (payload) r.write(payload);
    r.end();
  });
}

// 1) log in
const random = makeLoginRandom();
const capRes = await req('GET', `/ISAPI/Security/sessionLogin/capabilities?username=${user}&random=${random}`);
const g = (n) => { const m = new RegExp(`<${n}[^>]*>([^<]*)</${n}>`).exec(capRes.text); return m ? m[1] : ''; };
const digest = encodePwd(pass, {
  userName: user, salt: g('salt'), challenge: g('challenge'), iIterate: Number(g('iterations') || 1),
}, /^true$/i.test(g('isIrreversible')));
const login = await req('POST', `/ISAPI/Security/sessionLogin?timeStamp=${Date.now()}`, {
  body: buildSessionLoginXml({
    userName: user, passwordDigest: digest, sessionID: g('sessionID'),
    sessionIDVersion: Number(g('sessionIDVersion') || 1), needSessionTag: true,
  }),
});
const setCookie = login.headers['set-cookie'];
const cookie = /^\s*([^=;]+=[^;]+)/.exec(String(Array.isArray(setCookie) ? setCookie[0] : setCookie))[1];
const tag = /<sessionTag>([^<]*)<\/sessionTag>/.exec(login.text)?.[1] || '';
console.log(`登录: HTTP ${login.status}  cookie=${cookie.split('=')[0]}=…  tag=${tag ? '有' : '无'}`);

const auth = { Cookie: cookie, ...(tag ? { SessionTag: tag } : {}) };
const before = await req('GET', '/ISAPI/System/deviceInfo', { headers: auth });
console.log(`重启前用该会话请求: HTTP ${before.status}`);

// 2) reboot
const rb = await req('PUT', '/ISAPI/System/reboot', { body: '' });
console.log(`\n下发重启: HTTP ${rb.status}  ${rb.text.replace(/\s+/g, ' ').slice(0, 200)}`);

// 3) watch for the service to drop, then replay the old cookie
console.log('\n观察 90 秒：服务是否中断 / 旧会话是否失效');
let sawDrop = false;
for (let i = 1; i <= 18; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const r = await req('GET', '/ISAPI/System/deviceInfo', { headers: auth, timeoutMs: 4000 });
  const note = r.status === 0 ? '（不可达/超时 → 服务中断）' : '';
  if (r.status === 0) sawDrop = true;
  console.log(`  [${i * 5}s] HTTP ${r.status} ${note}`);
  if (r.status === 401) { console.log('  → 旧会话已被销毁，说明设备确实重启过'); break; }
  if (i >= 6 && !sawDrop) { console.log('  → 服务始终未中断'); break; }
}
console.log(`\n结论: 服务中断=${sawDrop ? '是' : '否'}；旧会话状态=${'见上'}`);