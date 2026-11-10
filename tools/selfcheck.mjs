// End-to-end read-only self check against a real device.
// Usage: node tools/selfcheck.mjs <ip> <password> [user] [port]
import { IsapiClient } from '../src/client.js';
import { probe, snapshot, getNetwork, getTime, listUsers, listStreamingChannels } from '../src/ops.js';

const ip = process.argv[2] || '192.168.1.64';
const password = process.argv[3] || '';
const username = process.argv[4] || 'admin';
const port = Number(process.argv[5]) || 80;

const c = new IsapiClient({ ip, port, username, password, timeoutMs: 12000 });

const t0 = Date.now();
const loggedIn = await c.login();
console.log(`登录        : ${loggedIn ? '成功' : '失败'}  authMode=${c.authMode}  耗时=${Date.now() - t0}ms`
  + (c.session ? `  sessionID回显=${c.session.echoed}  SessionTag=${c.session.supportSessionTag}` : ''));

const st = await probe(c, { deep: true });
console.log(`探测        : online=${st.online}  ${st.model}  ${st.firmwareVersion}  ${st.latencyMs}ms`);
console.log(`WEBLocation : ${st.webLocation || '(设备未上报)'}`);

const s = await snapshot(c, { channel: 101 });
console.log(`抓图        : 通道${s.channel}  ${s.contentType}  ${s.buffer.length} 字节  magic=${s.buffer.subarray(0, 3).toString('hex')}`);
const t1 = Date.now();
const s2 = await snapshot(c, { channel: 101 });
console.log(`二次抓图    : ${Date.now() - t1}ms  (缓存通道 ${c.snapshotChannel}, ${s2.buffer.length} 字节)`);

const net = await getNetwork(c, 1);
console.log(`网络        : ${net.ip}/${net.mask} gw=${net.gateway} dns=${net.dns} mode=${net.addressingType}`);
const tm = await getTime(c);
console.log(`时间        : ${tm.localTime}  ${tm.timeZone}  ${tm.timeMode}`);
const users = await listUsers(c);
console.log(`用户        : ${users.map((u) => `${u.userName}(${u.userLevel})`).join(', ')}`);
const chans = await listStreamingChannels(c);
console.log(`码流通道    : ${chans.map((x) => x.id).join(', ')}`);

const t2 = Date.now();
for (let i = 0; i < 5; i++) await probe(c, { deep: false });
console.log(`连续 5 次探测: ${Date.now() - t2}ms  (平均 ${Math.round((Date.now() - t2) / 5)}ms)`);

c.close();