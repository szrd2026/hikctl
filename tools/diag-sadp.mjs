// Raw SADP probe: sends to every plausible destination and prints EVERY datagram
// received, so we can tell "device does not answer" from "we never asked correctly".
import dgram from 'node:dgram';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const PORT = 37020;
const uuid = randomUUID();
const payload = Buffer.from(
  `<?xml version="1.0" encoding="utf-8"?>\r\n<Probe><Uuid>${uuid}</Uuid><Types>inquiry</Types></Probe>`,
  'utf8',
);

const targets = [
  ['multicast', '239.255.255.250'],
  ['global-broadcast', '255.255.255.255'],
  ['subnet-255', '192.168.1.255'],
  ['subnet-mask-based', null], // computed below
];

// compute the real directed broadcast from our own netmask
for (const [, list] of Object.entries(os.networkInterfaces())) {
  for (const ni of list || []) {
    if (ni.family !== 'IPv4' || ni.internal) continue;
    const a = ni.address.split('.').map(Number);
    const m = ni.netmask.split('.').map(Number);
    const b = a.map((x, i) => (x & m[i]) | (~m[i] & 255));
    console.log(`本机 ${ni.address}/${ni.netmask}  →  定向广播 ${b.join('.')}`);
    targets[3][1] = b.join('.');
  }
}

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let got = 0;

sock.on('message', (msg, rinfo) => {
  got++;
  const text = msg.toString('utf8');
  console.log(`\n▼ 收到来自 ${rinfo.address}:${rinfo.port} 的 ${msg.length} 字节`);
  console.log(text.replace(/\r?\n\s*/g, '\n').slice(0, 900));
});

sock.on('error', (e) => console.log('socket error:', e.message));

await new Promise((r) => sock.bind(PORT, () => r()));
try { sock.setBroadcast(true); } catch (e) { console.log('setBroadcast:', e.message); }
try { sock.setMulticastTTL(4); } catch { /* ignore */ }
try { sock.addMembership('239.255.255.250'); console.log('已加入组播 239.255.255.250'); } catch (e) { console.log('join:', e.message); }

for (let round = 0; round < 3; round++) {
  for (const [name, addr] of targets) {
    if (!addr) continue;
    await new Promise((r) => sock.send(payload, PORT, addr, (err) => {
      if (err) console.log(`send ${name}(${addr}) 失败: ${err.message}`);
      r();
    }));
  }
  console.log(`第 ${round + 1} 轮已发送（组播/全局广播/定向广播）`);
  await new Promise((r) => setTimeout(r, 900));
}

await new Promise((r) => setTimeout(r, 1200));
console.log(`\n合计收到 ${got} 个数据报`);
sock.close();