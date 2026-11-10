// Activate a device. Usage: node tools/activate.mjs <ip> [password] [port]
// Password defaults to DEFAULT_ACTIVATION_PASSWORD when omitted.
import {
  getActivateStatus, activateDevice, PASSWORD_RULES, DEFAULT_ACTIVATION_PASSWORD,
} from '../src/activate.js';

const ip = process.argv[2];
const password = process.argv[3] || DEFAULT_ACTIVATION_PASSWORD;
const port = Number(process.argv[4]) || 80;

if (!ip) {
  console.error('用法: node tools/activate.mjs <ip> [password] [port]');
  process.exit(2);
}
if (process.argv[3] === undefined) {
  console.log(`未指定密码，使用默认激活密码: ${DEFAULT_ACTIVATION_PASSWORD}`);
}

const rule = PASSWORD_RULES.check(password);
if (rule) { console.error(`密码不合规: ${rule}`); process.exit(2); }
console.log(`密码强度评估: ${PASSWORD_RULES.strength(password)}（${PASSWORD_RULES.classes(password)} 类字符，${password.length} 位）`);

const before = await getActivateStatus(ip, { port });
console.log('\n激活前:', JSON.stringify({ activated: before.activated, supportVersion: before.supportVersion }));
if (before.activated) { console.log('设备已激活，无需操作。'); process.exit(0); }

console.log('\n开始激活（会设置设备管理员密码）…');
const t0 = Date.now();
try {
  const r = await activateDevice(ip, { port, password });
  console.log(`\n耗时 ${Date.now() - t0} ms`);
  console.log(JSON.stringify(r, null, 2));
} catch (e) {
  console.error(`\n激活失败: ${e.message}`);
  process.exit(1);
}

const after = await getActivateStatus(ip, { port });
console.log('\n激活后:', JSON.stringify({ activated: after.activated, supportVersion: after.supportVersion }));