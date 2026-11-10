/**
 * 演示环境 —— 用于生成文档截图 / 手工体验。
 *
 * 会做两件事：
 *   1. 在若干本地端口上启动「模拟设备」（型号/序列号/固件全部是编造的）
 *   2. 往指定数据目录写入一份演示设备库（含在线 + 离线设备）
 *
 * 截图里出现的所有 IP、型号、序列号、MAC 都是编造的，与真实设备无关：
 *   在线 → 127.0.0.1:91xx（本机回环，明显是演示）
 *   离线 → 192.0.2.10 / .11（RFC 5737 TEST-NET-1，永远不会是真实设备）
 *
 * 用法：
 *   node tools/demo.mjs [--data <目录>] [--base-port 9100]
 * 然后：
 *   node src/main.js --data <目录> --port 8899 --console-port 9199 --no-open
 */
import fs from 'node:fs';
import path from 'node:path';
import { MockDevice } from '../test/mock-device.js';

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const DATA_DIR = path.resolve(argOf('--data', path.join(process.cwd(), 'demo-data')));
const BASE_PORT = Number(argOf('--base-port', '9100'));

/** 全部为编造的身份，与任何真实设备无关。 */
const DEMO = [
  {
    ip: '127.0.0.1', port: BASE_PORT, label: '展厅-入口枪机', group: '展厅',
    model: 'DS-2CD2347G2-LU', serial: 'DS-2CD2347G2-LU20240101AAWRD000001', firmware: 'V5.7.5 build 230612',
  },
  {
    ip: '127.0.0.1', port: BASE_PORT + 1, label: '大厅-球机', group: '展厅',
    model: 'DS-2DE4425IW-DE', serial: 'DS-2DE4425IW-DE20240202BBWRE000002', firmware: 'V5.7.3 build 230520',
  },
  {
    ip: '127.0.0.1', port: BASE_PORT + 2, label: '机房-NVR', group: '机房',
    model: 'DS-7608NXI-K2', serial: 'DS-7608NXI-K2_20240303CCWRF000003', firmware: 'V4.74.000 build 230401',
  },
  // RFC 5737 TEST-NET-1：保留给文档示例，永远不可能是真实设备
  { ip: '192.0.2.10', port: 80, label: '仓库-已停用', group: '仓库', offline: true },
  { ip: '192.0.2.11', port: 80, label: '备件-未装机', group: '仓库', offline: true },
];

const PASSWORD = 'Demo1pass';

const mocks = [];
for (const d of DEMO.filter((x) => !x.offline)) {
  const m = new MockDevice({
    model: d.model, serial: d.serial, firmware: d.firmware,
    password: PASSWORD, authMode: 'session',
  });
  await m.listen(d.port, '127.0.0.1');
  mocks.push({ m, d });
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// 先起一个临时 hikctl 无必要：直接按存储格式写文件，密码用 store 自己的加密。
const { Store } = await import('../src/store.js');
const seedDir = path.join(DATA_DIR, '__seed');
fs.rmSync(seedDir, { recursive: true, force: true });
const store = new Store(seedDir, { dataDir: DATA_DIR, reportsDir: path.join(DATA_DIR, 'reports') });
for (const d of DEMO) {
  store.add({
    ip: d.ip, port: d.port, username: 'admin', password: PASSWORD,
    label: d.label, group: d.group,
  });
}
store.save();
fs.rmSync(seedDir, { recursive: true, force: true });

console.log('');
console.log('  演示环境已就绪');
console.log('  ─────────────────────────────────────────────');
console.log(`  数据目录 : ${DATA_DIR}`);
console.log(`  设备数   : ${DEMO.length}（在线 ${mocks.length} / 离线 ${DEMO.length - mocks.length}）`);
console.log(`  登录密码 : ${PASSWORD}（演示用，全部为模拟设备）`);
for (const { d } of mocks) console.log(`    在线  ${d.ip}:${d.port}  ${d.model}  ${d.label}`);
for (const d of DEMO.filter((x) => x.offline)) console.log(`    离线  ${d.ip}:${d.port}  ${d.label}`);
console.log('  ─────────────────────────────────────────────');
console.log('  启动演示实例：');
console.log(`    node src/main.js --data "${DATA_DIR}" --port 8899 --console-port 9199 --no-open`);
console.log('');

const shutdown = () => { for (const { m } of mocks) { try { m.close(); } catch { /* ignore */ } } process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);   // 保活