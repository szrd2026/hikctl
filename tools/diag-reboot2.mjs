// Decisive reboot check: issue the reboot through our IsapiClient (which handles
// auth/re-login), then watch TCP :80 every 400 ms. A real camera restart makes the
// HTTP daemon disappear for tens of seconds.
import net from 'node:net';
import { IsapiClient } from '../src/client.js';
import { reboot } from '../src/ops.js';

const ip = process.argv[2] || '192.168.1.64';
const port = Number(process.argv[3]) || 80;
const user = process.argv[4] || 'admin';
const pass = process.argv[5] || '1q2w3e4r';
const watchSec = Number(process.argv[6]) || 90;

const tcpOpen = (timeoutMs = 1200) => new Promise((resolve) => {
  const s = net.connect({ host: ip, port });
  let done = false;
  const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(v); } };
  s.setTimeout(timeoutMs);
  s.once('connect', () => fin(true));
  s.once('timeout', () => fin(false));
  s.once('error', () => fin(false));
});

const client = new IsapiClient({ ip, port, username: user, password: pass, timeoutMs: 15000 });
await client.login();
console.log(`登录: authMode=${client.authMode}  cookie=${client.session?.cookieName || '-'}`);

console.log('基线 TCP 探测:', await tcpOpen() ? '开放' : '关闭');

console.log('\n下发重启…');
try {
  const r = await reboot(client);
  console.log('  响应:', JSON.stringify(r));
} catch (e) {
  console.log('  失败:', e.message);
}

console.log(`\n以 400ms 粒度监控 TCP :${port}，共 ${watchSec} 秒`);
const t0 = Date.now();
let downCount = 0;
let firstDown = null;
let lastDown = null;
while ((Date.now() - t0) / 1000 < watchSec) {
  const open = await tcpOpen();
  if (!open) {
    downCount++;
    if (!firstDown) firstDown = ((Date.now() - t0) / 1000).toFixed(1);
    lastDown = ((Date.now() - t0) / 1000).toFixed(1);
  }
  await new Promise((r) => setTimeout(r, 400));
}

console.log(`\n结果: 不可达采样 ${downCount} 次`);
if (downCount) console.log(`  首次中断 ${firstDown}s，持续到 ${lastDown}s  →  设备确实重启了`);
else console.log('  端口全程开放 → 设备未真正重启（固件接受了命令但未执行/延迟执行）');
client.close();