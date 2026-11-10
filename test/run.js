/**
 * hikctl test suite: unit tests + end-to-end integration against a mock device.
 * Run: node test/run.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';

import { parseXml, serializeXml, first, textOf, setText, build, document, elementsOf } from '../src/xml.js';
import { expandRange, parseCidr, isIPv4, mapLimit, makeId, sanitizeXmlValue } from '../src/util.js';
import { encodePwd, makeLoginRandom, parseDigestChallenge, buildDigestAuth, extractResponseStatus, isRebootRequired, md5 } from '../src/auth.js';
import { makeZip, buildXlsx, buildCsv, rowsToMatrix } from '../src/report.js';
import { createServer } from '../src/server.js';
import { createConsole, detectPackageRoot, listPackages } from '../src/console.js';
import { sadpDiscover, parseProbeResponse } from '../src/sadp.js';
import { scanRange } from '../src/discover.js';
import {
  getActivateStatus, fetchActivateChallenge, activateDevice,
  PASSWORD_RULES, buildEncryptPassword, encodeAesCbc,
} from '../src/activate.js';
import { MockDevice } from './mock-device.js';
import { IsapiClient } from '../src/client.js';
import { probe, setNetwork, factoryReset, snapshot, upgradeFirmware, waitUpgrade, getEzviStatus } from '../src/ops.js';

let PASS = 0;
let FAIL = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    PASS++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    FAIL++;
    failures.push({ name, error: e });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}
function group(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

const PASSWORD = 'Test@12345';

/* ================================================================== */
group('1. XML 引擎');

await test('parse → serialize → parse 保持结构', () => {
  const src = '<?xml version="1.0" encoding="UTF-8"?><A x="1"><B>t</B><C><D>1</D><D>2</D></C></A>';
  const a = parseXml(src);
  const out = serializeXml(a);
  const b = parseXml(out);
  assert.equal(textOf(b, 'B'), 't');
  assert.equal(elementsOf(b, 'D').length, 2);
  assert.equal(first(b, 'A').attrs[0].value, '1');
});

await test('未知字段在 patch 后不丢失（这是 ISAPI 写操作的关键）', () => {
  const src = '<IPAddress><ipAddress>1.2.3.4</ipAddress><unknownTag>keepme</unknownTag><subnetMask>255.0.0.0</subnetMask></IPAddress>';
  const root = parseXml(src);
  const el = first(root, 'IPAddress');
  setText(el, 'ipAddress', '10.0.0.5');
  const out = serializeXml(root);
  assert.match(out, /10\.0\.0\.5/);
  assert.match(out, /keepme/, '未知字段被丢弃了');
  assert.match(out, /255\.0\.0\.0/);
});

await test('setText 能创建不存在的节点', () => {
  const root = parseXml('<T><a>1</a></T>');
  const el = first(root, 'T');
  setText(el, 'timeMode', 'NTP');
  assert.match(serializeXml(root), /<timeMode>NTP<\/timeMode>/);
});

await test('CDATA / 注释 / 自闭合标签可往返', () => {
  const src = '<R><a/><b><![CDATA[ x<y ]]></b><!--c--></R>';
  const out = serializeXml(parseXml(src));
  assert.match(out, /<a\/>/);
  assert.match(out, /<!\[CDATA\[ x<y \]\]>/);
  assert.match(out, /<!--c-->/);
});

await test('build/document 生成合法 XML', () => {
  const x = document(build('Time', { timeMode: 'manual', localTime: '2025-01-01T00:00:00' }));
  assert.match(x, /<Time><timeMode>manual<\/timeMode>/);
});

/* ================================================================== */
group('2. 工具函数');

await test('IPv4 校验与范围展开', () => {
  assert.equal(isIPv4('192.168.1.1'), true);
  assert.equal(isIPv4('192.168.1.256'), false);
  assert.equal(isIPv4('abc'), false);
  const r = expandRange('192.168.1.1', '192.168.1.5');
  assert.deepEqual(r, ['192.168.1.1', '192.168.1.2', '192.168.1.3', '192.168.1.4', '192.168.1.5']);
  assert.throws(() => expandRange('10.0.0.0', '10.255.255.255', 1000));
});

await test('CIDR 解析', () => {
  const r = parseCidr('192.168.1.0/24');
  assert.equal(r.from, '192.168.1.0');
  assert.equal(r.to, '192.168.1.255');
  assert.equal(r.size, 256);
});

await test('mapLimit 并发受限且不丢结果', async () => {
  let inflight = 0;
  let peak = 0;
  const items = Array.from({ length: 50 }, (_, i) => i);
  const res = await mapLimit(items, 7, async (i) => {
    inflight++; peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    if (i === 13) throw new Error('boom');
    return i * 2;
  });
  assert.equal(peak <= 7, true, `并发峰值 ${peak} 超过限制`);
  assert.equal(res.length, 50);
  assert.equal(res[0].value, 0);
  assert.equal(res[13].ok, false);
  assert.equal(res[49].value, 98);
});

await test('sanitizeXmlValue 去掉控制字符', () => {
  assert.equal(sanitizeXmlValue('a\u0000b\u001Fc'), 'abc');
});

/* ================================================================== */
group('3. 登录算法（Python hashlib 独立算出的已知答案）');

await test('encodePwd 不可逆分支 = Python 参考值', () => {
  const got = encodePwd('Test@12345', { userName: 'admin', salt: '1a2b3c4d', challenge: 'abcdef0123456789', iIterate: 100 }, true);
  assert.equal(got, 'b1406329ac353ad0862c9c74730ffd0ef6fcc259f177405a1d06196e8688c7ac');
});

await test('encodePwd 普通分支 = Python 参考值', () => {
  const got = encodePwd('Test@12345', { userName: 'admin', salt: '1a2b3c4d', challenge: 'abcdef0123456789', iIterate: 100 }, false);
  assert.equal(got, 'ec08f72936fd73a41dbff545a3708dc9c7b7df1c8c9c448c6857e53220162fbf');
});

await test('encodePwd 迭代 1 次的边界 = Python 参考值', () => {
  assert.equal(
    encodePwd('Test@12345', { userName: 'admin', salt: '1a2b3c4d', challenge: 'abcdef0123456789', iIterate: 1 }, true),
    'c019958b57cfb7cb7b6655774dad65069a8ff0ec64b9dd3a21ea8ac223193113',
  );
  assert.equal(
    encodePwd('Test@12345', { userName: 'admin', salt: '1a2b3c4d', challenge: 'abcdef0123456789', iIterate: 1 }, false),
    '6d987a391d90fc2451751b2bb85890fc6e452bc057f39a85d8d1fd552f965fb2abcdef0123456789',
  );
});

await test('makeLoginRandom 是 8 位十进制', () => {
  const r = makeLoginRandom(1730000000000);
  assert.match(r, /^\d{1,8}$/);
  assert.equal(r, makeLoginRandom(1730000000000), '同一时间戳应稳定');
});

/* ================================================================== */
group('4. HTTP Digest');

await test('解析 WWW-Authenticate', () => {
  const c = parseDigestChallenge('Digest realm="IP Camera(MOCK)", qop="auth", nonce="abc", opaque="xyz", algorithm=MD5');
  assert.equal(c.realm, 'IP Camera(MOCK)');
  assert.equal(c.nonce, 'abc');
  assert.equal(c.qop, 'auth');
  assert.equal(c.opaque, 'xyz');
});

await test('Digest 摘要与独立实现一致', () => {
  const challenge = { realm: 'IP Camera(MOCK)', nonce: 'n1', qop: 'auth', opaque: 'o1', algorithm: 'MD5' };
  const header = buildDigestAuth({
    username: 'admin', password: PASSWORD, method: 'GET',
    uri: '/ISAPI/System/deviceInfo', challenge, nc: 1, cnonce: 'deadbeef',
  });
  const ha1 = md5(`admin:IP Camera(MOCK):${PASSWORD}`);
  const ha2 = md5('GET:/ISAPI/System/deviceInfo');
  const expected = md5(`${ha1}:n1:00000001:deadbeef:auth:${ha2}`);
  assert.match(header, new RegExp(`response="${expected}"`));
  assert.match(header, /nc=00000001/);
});

await test('解析 ResponseStatus（XML 与 JSON）', () => {
  const x = extractResponseStatus('<ResponseStatus><statusCode>7</statusCode><subStatusCode>rebootRequired</subStatusCode></ResponseStatus>');
  assert.equal(x.statusCode, '7');
  assert.equal(isRebootRequired(x), true);
  const j = extractResponseStatus('{"statusCode":1,"statusString":"OK"}');
  assert.equal(j.statusCode, '1');
  assert.equal(isRebootRequired(j), false);
});

/* ================================================================== */
group('5. 报表生成');

await test('makeZip 生成结构合法的 ZIP', () => {
  const zip = makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.txt', data: 'world' }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, '本地文件头签名错误');
  const eocdPos = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdPos), 0x06054b50, 'EOCD 签名错误');
  assert.equal(zip.readUInt16LE(eocdPos + 10), 2, '条目数错误');
});

await test('buildXlsx 输出以 PK 开头且包含工作表', () => {
  const buf = buildXlsx([['名称', 'IP'], ['cam1', '192.168.1.64']]);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const s = buf.toString('latin1');
  assert.ok(s.includes('sheet1.xml'), '缺少工作表条目');
  assert.ok(s.includes('xl/workbook.xml'), '缺少 workbook 条目');
});

await test('buildCsv 带 UTF-8 BOM 并正确转义', () => {
  const csv = buildCsv([['a', 'b,c'], ['d"e', '1']]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.match(csv, /"b,c"/);
  assert.match(csv, /"d""e"/);
});

await test('rowsToMatrix 列顺序与列定义一致', () => {
  const m = rowsToMatrix([{ index: 1, ip: '1.1.1.1', online: true }]);
  assert.equal(m[0][0], '序号');
  assert.equal(m[0][2], 'IP');
  assert.equal(m[1][2], '1.1.1.1');
  assert.equal(m[1][4], '是');
});

/* ================================================================== */
group('6. 端到端：登录 / 探测');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hikctl-test-'));
let app = null;
let appPort = 0;
let mock = null;
let mockPort = 0;
let mockDigest = null;
let mockDigestPort = 0;

async function api(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${appPort}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  mock = new MockDevice({ authMode: 'session', password: PASSWORD });
  mockPort = await mock.listen(0);
  mockDigest = new MockDevice({ authMode: 'digest', password: PASSWORD, serial: 'DIGEST-SN-0001' });
  mockDigestPort = await mockDigest.listen(0);

  app = createServer({ rootDir: tmpRoot, version: 'test' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  appPort = app.server.address().port;

  await test('sessionLogin 挑战响应登录成功', async () => {
    const client = new IsapiClient({ ip: '127.0.0.1', port: mockPort, username: 'admin', password: PASSWORD, timeoutMs: 4000 });
    const ok = await client.login();
    assert.equal(ok, true);
    assert.equal(client.authMode, 'session');
    assert.ok(client.session && client.session.sessionID, '未拿到 sessionID');
    client.close();
  });

  await test('错误密码被拒绝且报错信息可读', async () => {
    const client = new IsapiClient({ ip: '127.0.0.1', port: mockPort, username: 'admin', password: 'wrong-password', timeoutMs: 4000 });
    const st = await probe(client);
    assert.equal(st.online, false);
    assert.match(st.error, /密码|鉴权|登录/);
    client.close();
  });

  await test('旧固件 Digest 回退登录成功', async () => {
    const client = new IsapiClient({ ip: '127.0.0.1', port: mockDigestPort, username: 'admin', password: PASSWORD, timeoutMs: 4000 });
    const st = await probe(client);
    assert.equal(st.online, true, st.error || '');
    assert.equal(client.authMode, 'digest');
    assert.equal(st.serialNumber, 'DIGEST-SN-0001');
    client.close();
  });

  await test('probe 解析设备信息字段', async () => {
    const client = new IsapiClient({ ip: '127.0.0.1', port: mockPort, username: 'admin', password: PASSWORD, timeoutMs: 4000 });
    const st = await probe(client, { deep: true });
    assert.equal(st.online, true);
    assert.equal(st.model, 'DS-2CD2347G2-LU');
    assert.match(st.serialNumber, /AAWR123456789$/);
    assert.equal(st.deviceType, 'IPCamera');
    assert.equal(st.channelCount, 1);
    assert.equal(st.latencyMs >= 0, true);
    client.close();
  });

  await test('setNetwork 识别 rebootRequired 并回传 newId', async () => {
    const client = new IsapiClient({ ip: '127.0.0.1', port: mockPort, username: 'admin', password: PASSWORD, timeoutMs: 4000 });
    const r = await setNetwork(client, { ip: '192.168.1.99', mask: '255.255.255.0', gateway: '192.168.1.254' });
    assert.equal(r.rebootRequired, true);
    assert.equal(r.newId, `192.168.1.99:${mockPort}`);
    assert.equal(mock.state.ip, '192.168.1.99', '设备侧未收到新 IP');
    assert.equal(mock.state.gateway, '192.168.1.254');
    client.close();
  });

  await test('factoryReset full 会在要求二次校验时带密码重试', async () => {
    const client = new IsapiClient({ ip: '127.0.0.1', port: mockPort, username: 'admin', password: PASSWORD, timeoutMs: 4000 });
    mock.resetCalls = [];
    const r = await factoryReset(client, { mode: 'full', password: PASSWORD });
    assert.equal(r.ok, true);
    const first = mock.resetCalls[0];
    const last = mock.resetCalls[mock.resetCalls.length - 1];
    assert.equal(first.mode, 'full');
    assert.ok(first.demandedPassword, '设备未触发二次校验路径');
    assert.equal(last.loginPassword, PASSWORD, '重试时未携带密码');
    client.close();
  });

  await test('snapshot 返回 JPEG', async () => {
    const client = new IsapiClient({ ip: '127.0.0.1', port: mockPort, username: 'admin', password: PASSWORD, timeoutMs: 4000 });
    const s = await snapshot(client, { channel: 101 });
    assert.match(s.contentType, /image\/jpeg/);
    assert.ok(s.buffer.length > 50);
    client.close();
  });

  await test('固件升级：multipart 分片上传 + 进度回调 + 状态轮询', async () => {
    const fw = path.join(tmpRoot, 'fake-firmware.dav');
    const size = 300 * 1024;
    fs.writeFileSync(fw, Buffer.alloc(size, 0x5a));
    const client = new IsapiClient({ ip: '127.0.0.1', port: mockPort, username: 'admin', password: PASSWORD, timeoutMs: 8000 });
    mock.upgradeBytes = 0;
    const progress = [];
    const r = await upgradeFirmware(client, fw, (sent, total) => progress.push({ sent, total }));
    assert.equal(r.ok, true);
    assert.equal(r.bytes, size);
    assert.ok(mock.upgradeBytes > size, `设备收到的字节数偏少: ${mock.upgradeBytes}`);
    assert.ok(progress.length > 0, '没有进度回调');
    assert.equal(progress[progress.length - 1].sent, size);
    assert.equal(progress[progress.length - 1].total, size);
    const st = await waitUpgrade(client, { timeoutMs: 5000, intervalMs: 150 });
    assert.match(String(st.status), /success/i);
    client.close();
  });

  /* ------------------------- REST API ------------------------- */

  let deviceId = null;

  await test('POST /api/devices 添加并探测设备', async () => {
    const r = await api('POST', '/api/devices', {
      ip: '127.0.0.1', port: mockPort, username: 'admin', password: PASSWORD, label: '测试机',
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.probe.online, true, JSON.stringify(r.data.probe));
    assert.equal(r.data.probe.model, 'DS-2CD2347G2-LU');
    deviceId = r.data.device.id;
    assert.equal(deviceId, `127.0.0.1:${mockPort}`);
  });

  await test('GET /api/devices 列表含状态', async () => {
    const r = await api('GET', '/api/devices');
    assert.equal(r.status, 200);
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].status.online, true);
    assert.equal(r.data[0].hasPassword, true);
    assert.equal(r.data[0].password, undefined, 'API 泄露了密码');
  });

  await test('GET /api/devices/:id/network 读取网络参数', async () => {
    const r = await api('GET', `/api/devices/${encodeURIComponent(deviceId)}/network`);
    assert.equal(r.status, 200);
    assert.equal(r.data.ip, '192.168.1.99');
  });

  await test('PUT /api/devices/:id/time 与电脑对时', async () => {
    mock.state.time = '2025-01-01T00:00:00'; // reset so the assertion is meaningful
    const r = await api('PUT', `/api/devices/${encodeURIComponent(deviceId)}/time`, { mode: 'pc' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.notEqual(mock.state.time, '2025-01-01T00:00:00', '设备侧时间没有被下发（XML 体可能是空的）');
    assert.match(mock.state.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.equal(mock.state.timeMode, 'manual');
  });

  await test('PUT /api/devices/:id/time 配置 NTP', async () => {
    const r = await api('PUT', `/api/devices/${encodeURIComponent(deviceId)}/time`, {
      mode: 'ntp', server: '192.168.1.1', intervalMinutes: 30,
    });
    assert.equal(r.status, 200);
    assert.equal(mock.state.ntpServer, '192.168.1.1');
  });

  await test('GET /api/devices/:id/isapi 原始透传', async () => {
    const r = await api('GET', `/api/devices/${encodeURIComponent(deviceId)}/isapi?path=${encodeURIComponent('/ISAPI/System/deviceInfo')}`);
    assert.equal(r.status, 200);
    assert.match(r.data.body, /MOCK-CAM/);
  });

  await test('GET /api/devices/:id/snapshot 返回图片', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/api/devices/${encodeURIComponent(deviceId)}/snapshot`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /image\/jpeg/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 50);
  });

  await test('GET /api/devices/:id/preview.mjpg 走设备 MJPEG 通路', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${appPort}/api/devices/${encodeURIComponent(deviceId)}/preview.mjpg`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-preview-mode'), 'device-mjpeg');
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.ok(value && value.length > 0, '没有收到预览数据');
    ctrl.abort();
  });

  await test('GET /api/devices/:id/stream 返回 RTSP 地址', async () => {
    const r = await api('GET', `/api/devices/${encodeURIComponent(deviceId)}/stream`);
    assert.equal(r.status, 200);
    assert.match(r.data.rtsp, /^rtsp:\/\/admin:.+@127\.0\.0\.1:554\/Streaming\/Channels\/101$/);
  });

  await test('POST /api/devices/:id/reset 完全恢复', async () => {
    mock.resetCalled = null;
    const r = await api('POST', `/api/devices/${encodeURIComponent(deviceId)}/reset`, { mode: 'full' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(mock.resetCalled.mode, 'full');
  });

  await test('POST /api/devices/:id/reboot', async () => {
    mock.rebootCalled = false;
    const r = await api('POST', `/api/devices/${encodeURIComponent(deviceId)}/reboot`);
    assert.equal(r.status, 200);
    assert.equal(mock.rebootCalled, true);
  });

  await test('PUT /api/devices/:id/password 改密码并回写本地凭据', async () => {
    const r = await api('PUT', `/api/devices/${encodeURIComponent(deviceId)}/password`, {
      userName: 'admin', oldPassword: PASSWORD, newPassword: 'NewPass@9876',
    });
    assert.equal(r.status, 200);
    assert.equal(mock.password, 'NewPass@9876', '设备侧密码未变更');
    const dev = app.store.secret(app.store.get(deviceId));
    assert.equal(dev.password, 'NewPass@9876', '本地存储未更新新密码');
  });

  /* ------------------------- 批量 ------------------------- */

  async function waitTask(taskId, timeoutMs = 20000) {
    const t0 = Date.now();
    for (;;) {
      const r = await api('GET', `/api/tasks/${taskId}`);
      if (r.data && (r.data.state === 'done' || r.data.state === 'failed' || r.data.state === 'cancelled')) return r.data;
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待任务 ${taskId} 超时`);
      await sleep(120);
    }
  }

  await test('批量探测（SSE 事件 + 任务结果）', async () => {
    // second device (digest firmware)
    const add = await api('POST', '/api/devices', {
      ip: '127.0.0.1', port: mockDigestPort, username: 'admin', password: PASSWORD, label: '旧固件机',
    });
    assert.equal(add.data.probe.online, true, JSON.stringify(add.data.probe));
    const id2 = add.data.device.id;

    // listen to SSE while the batch runs
    const events = [];
    const ctrl = new AbortController();
    const ssePromise = (async () => {
      const res = await fetch(`http://127.0.0.1:${appPort}/api/events`, { signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line) { try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
          }
        }
      } catch { /* aborted */ }
    })();

    await sleep(150);
    const batch = await api('POST', '/api/batch', {
      deviceIds: [deviceId, id2], action: 'probe', concurrency: 4,
    });
    assert.equal(batch.status, 200);
    const t = await waitTask(batch.data.taskId);
    assert.equal(t.state, 'done');
    assert.equal(t.summary.total, 2);
    assert.equal(t.summary.ok, 2, JSON.stringify(t.results));
    assert.equal(t.results.length, 2);

    await sleep(200);
    ctrl.abort();
    await ssePromise.catch(() => {});
    const types = new Set(events.map((e) => e.type));
    assert.ok(types.has('task.start'), `SSE 缺少 task.start，收到: ${[...types]}`);
    assert.ok(types.has('task.progress'), 'SSE 缺少 task.progress');
    assert.ok(types.has('task.done'), 'SSE 缺少 task.done');

    await api('DELETE', `/api/devices/${encodeURIComponent(id2)}`);
  });

  await test('批量对时 + 任务列表', async () => {
    const list = await api('GET', '/api/tasks');
    assert.equal(list.status, 200);
    assert.ok(list.data.length >= 1);
    const batch = await api('POST', '/api/batch', {
      deviceIds: [deviceId], action: 'setTime', params: { mode: 'pc' }, concurrency: 2,
    });
    const t = await waitTask(batch.data.taskId);
    assert.equal(t.summary.ok, 1, JSON.stringify(t.results));
  });

  await test('批量重启', async () => {
    mock.rebootCalled = false;
    const batch = await api('POST', '/api/batch', { deviceIds: [deviceId], action: 'reboot' });
    const t = await waitTask(batch.data.taskId);
    assert.equal(t.summary.ok, 1, JSON.stringify(t.results));
    assert.equal(mock.rebootCalled, true);
  });

  /* ------------------------- 发现 / 报表 ------------------------- */

  await test('POST /api/discover/scan 扫到 mock 设备（自定义端口）', async () => {
    const r = await api('POST', '/api/discover/scan', {
      from: '127.0.0.1', to: '127.0.0.1',
      username: 'admin', password: 'NewPass@9876',
      ports: [mockPort], concurrency: 2, timeoutMs: 800,
    });
    assert.equal(r.status, 200);
    const t = await waitTask(r.data.taskId, 30000);
    assert.equal(t.summary.found >= 1, true, JSON.stringify(t.summary));
    assert.equal(t.summary.scanned, 1);
  });

  await test('POST /api/discover/scan 默认端口扫不到时返回 found=0', async () => {
    const r = await api('POST', '/api/discover/scan', {
      from: '127.0.0.1', to: '127.0.0.1', username: 'admin', password: 'x',
      ports: [65001], concurrency: 2, timeoutMs: 300,
    });
    const t = await waitTask(r.data.taskId, 30000);
    assert.equal(t.summary.found, 0);
    assert.equal(t.summary.scanned, 1);
  });

  await test('POST /api/report 生成 CSV', async () => {
    const r = await api('POST', '/api/report', { deviceIds: [deviceId], format: 'csv' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.rows, 1);
    const file = path.join(tmpRoot, 'reports', r.data.file);
    assert.ok(fs.existsSync(file));
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content.charCodeAt(0), 0xFEFF);
    assert.match(content, /巡检|序号/);
    assert.match(content, /DS-2CD2347G2-LU/);
  });

  await test('POST /api/report 生成 XLSX（ZIP 结构可校验）', async () => {
    const r = await api('POST', '/api/report', { deviceIds: [deviceId], format: 'xlsx' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const file = path.join(tmpRoot, 'reports', r.data.file);
    const buf = fs.readFileSync(file);
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
    const eocd = buf.length - 22;
    assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
    // keep a copy in the OS temp dir for external validation (Expand-Archive)
    const keep = path.join(os.tmpdir(), 'hikctl-sample-report.xlsx');
    fs.copyFileSync(file, keep);
    console.log(`      → 样本已保存: ${keep}`);
  });

  await test('GET /api/health 返回服务信息', async () => {
    const r = await api('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.devices, 1);
  });

  await test('DELETE /api/devices/:id 删除设备', async () => {
    const r = await api('DELETE', `/api/devices/${encodeURIComponent(deviceId)}`);
    assert.equal(r.status, 200);
    const list = await api('GET', '/api/devices');
    assert.equal(list.data.length, 0);
  });

  await test('错误请求返回结构化错误', async () => {
    const r = await api('POST', '/api/devices', { ip: '' });
    assert.equal(r.status, 400);
    assert.ok(r.data.error && r.data.error.message);
    const bad = await api('GET', '/api/nope');
    assert.equal(bad.status, 404);
  });
} finally {
  if (app) app.store.closeAll();
  if (app) await new Promise((r) => app.server.close(r));
  if (mock) await mock.close();
  if (mockDigest) await mockDigest.close();
}

/* ================================================================== */
group('7. SADP 发现');

const SAMPLE_PROBE_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<ProbeMatch>
<Uuid>f72917d7-9bb3-43e3-b1e3-10521d9dc42b</Uuid>
<Types>inquiry</Types>
<DeviceType>168482</DeviceType>
<DeviceDescription>HK-Y2S4M-GL/L</DeviceDescription>
<DeviceSN>HK-Y2S4M-GL/L20230101AAWRL000001</DeviceSN>
<CommandPort>8000</CommandPort>
<HttpPort>80</HttpPort>
<MAC>aa-bb-cc-dd-ee-01</MAC>
<IPv4Address>192.168.1.64</IPv4Address>
<IPv4SubnetMask>255.255.252.0</IPv4SubnetMask>
<IPv4Gateway>0.0.0.0</IPv4Gateway>
<DHCP>true</DHCP>
<AnalogChannelNum>0</AnalogChannelNum>
<DigitalChannelNum>1</DigitalChannelNum>
<SoftwareVersion>V5.8.110build 260713</SoftwareVersion>
<DSPVersion>V7.3 build 260326</DSPVersion>
<BootTime>2000-01-02 08:00:10</BootTime>
<Encrypt>true</Encrypt>
<ResetAbility>false</ResetAbility>
<Activated>true</Activated>
</ProbeMatch>`;

await test('parseProbeResponse 解析真机 ProbeMatch（字段名与真机一致）', () => {
  const d = parseProbeResponse(SAMPLE_PROBE_RESPONSE);
  assert.equal(d.ip, '192.168.1.64');
  assert.equal(d.mac, 'aa:bb:cc:dd:ee:01', 'MAC 未归一化为冒号分隔');
  assert.equal(d.model, 'HK-Y2S4M-GL/L', 'model 应取自 DeviceDescription');
  assert.equal(d.serialNumber, 'HK-Y2S4M-GL/L20230101AAWRL000001');
  assert.equal(d.firmwareVersion, 'V5.8.110build 260713');
  assert.equal(d.dspVersion, 'V7.3 build 260326');
  assert.equal(d.httpPort, 80);
  assert.equal(d.sdkPort, 8000, 'sdkPort 应取自 CommandPort');
  assert.equal(d.activated, true);
  assert.equal(d.dhcpEnabled, true, 'DHCP 字段名与 DHCPEnabled 不同');
  assert.equal(d.encrypt, true);
  assert.equal(d.bootTime, '2000-01-02 08:00:10');
  // 数字 DeviceType 不应原样当成类型展示
  assert.equal(d.deviceTypeCode, '168482');
  assert.equal(d.deviceType, 'IPCamera', '有数字通道时应归类为 IPCamera');
  assert.equal(d.digitalChannelNum, '1');
});

await test('parseProbeResponse 兼容其它固件的字段拼写', () => {
  const alt = '<ProbeResponse><ipAddress>10.0.0.9</ipAddress><macAddress>AA-BB-CC-00-11-22</macAddress>'
    + '<serialNumber>SN-ALT</serialNumber><Model>DS-2CD2347G2-LU</Model>'
    + '<DeviceType>IPCamera</DeviceType><Activated>1</Activated>'
    + '<DevicePort>8000</DevicePort><DHCPEnabled>false</DHCPEnabled></ProbeResponse>';
  const d = parseProbeResponse(alt);
  assert.equal(d.ip, '10.0.0.9');
  assert.equal(d.mac, 'aa:bb:cc:00:11:22');
  assert.equal(d.serialNumber, 'SN-ALT');
  assert.equal(d.model, 'DS-2CD2347G2-LU');
  assert.equal(d.deviceType, 'IPCamera');
  assert.equal(d.deviceTypeCode, '', '非数字 DeviceType 不应产生代码');
  assert.equal(d.activated, true);
  assert.equal(d.sdkPort, 8000);
  assert.equal(d.dhcpEnabled, false);
});

await test('parseProbeResponse 忽略自己的 Probe 回环包', () => {
  const own = '<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>x</Uuid><Types>inquiry</Types></Probe>';
  const d = parseProbeResponse(own);
  assert.equal(d.ip, '');
  assert.equal(d.model, '');
});

await test('parseProbeResponse 对垃圾数据不抛异常', () => {
  const d = parseProbeResponse('not xml at all');
  assert.equal(d.ip, '');
  assert.equal(d.httpPort, 80, '应有默认端口');
});

/**
 * Injection payload for the discovery tests. Uses an RFC-5737 documentation
 * address so it can never collide with a real device on the live network the
 * tests happen to be running on.
 */
const INJECT_PROBE_MATCH = `<?xml version="1.0" encoding="UTF-8"?>
<ProbeMatch>
<Uuid>00000000-1111-2222-3333-444444444444</Uuid>
<Types>inquiry</Types>
<DeviceType>999999</DeviceType>
<DeviceDescription>TEST-CAM-203</DeviceDescription>
<DeviceSN>TEST-CAM-20320260101TEST0000001</DeviceSN>
<CommandPort>8000</CommandPort>
<HttpPort>80</HttpPort>
<MAC>02-00-00-00-00-01</MAC>
<IPv4Address>203.0.113.7</IPv4Address>
<IPv4SubnetMask>255.255.255.0</IPv4SubnetMask>
<IPv4Gateway>203.0.113.1</IPv4Gateway>
<DHCP>false</DHCP>
<DigitalChannelNum>1</DigitalChannelNum>
<SoftwareVersion>V9.9.9 build 260101</SoftwareVersion>
<Activated>true</Activated>
</ProbeMatch>`;

await test('sadpDiscover 能收到并解析设备应答（注入应答包）', async () => {
  const inject = dgram.createSocket('udp4');
  const done = sadpDiscover({ timeoutMs: 1500 });
  // Give the discovery socket time to bind :37020, then answer it directly.
  await new Promise((r) => setTimeout(r, 350));
  await new Promise((resolve) => {
    inject.send(Buffer.from(INJECT_PROBE_MATCH, 'utf8'), 37020, '127.0.0.1', () => resolve());
  });
  await new Promise((r) => setTimeout(r, 400));
  const res = await done;
  inject.close();
  // NOTE: a live network may also contribute real devices; assert on the sentinel.
  const hit = res.found.find((d) => d.ip === '203.0.113.7');
  assert.ok(hit, `未解析出注入的设备；found=${JSON.stringify(res.found.map((d) => d.ip))}`);
  assert.equal(hit.model, 'TEST-CAM-203');
  assert.equal(hit.mac, '02:00:00:00:00:01');
  assert.equal(hit.sdkPort, 8000);
  assert.equal(hit.deviceType, 'IPCamera');
  assert.equal(hit.dhcpEnabled, false);
});

await test('sadpDiscover 忽略非 SADP 报文', async () => {
  const inject = dgram.createSocket('udp4');
  const seen = [];
  const done = sadpDiscover({ timeoutMs: 1200, onResult: (d) => seen.push(d) });
  await new Promise((r) => setTimeout(r, 350));
  // Noise that a naive filter would mistake for a device reply. Real devices on the
  // network may still answer, so assert that nothing noise-shaped was accepted.
  const noise = [
    'hello world',
    '<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>x</Uuid><Types>inquiry</Types></Probe>',
    '\x01\x02\x03\x04 binary garbage',
  ];
  for (const n of noise) {
    await new Promise((resolve) => inject.send(Buffer.from(n, 'utf8'), 37020, '127.0.0.1', () => resolve()));
  }
  const res = await done;
  inject.close();
  const bogus = [...res.found, ...seen].filter((d) => d.ip === '127.0.0.1' || (!d.model && !d.serialNumber));
  assert.equal(bogus.length, 0, `噪声被当成了设备: ${JSON.stringify(bogus.map((d) => d.ip))}`);
});

/* ================================================================== */
group('8. 设备激活（ISAPI ActivateV3：RSA-3072 模数握手 + AES-CBC，真机为 AES-128）');

const NEW_PASSWORD = 'Hik@2026Y2S4M';

await test('密码规则校验', () => {
  assert.match(PASSWORD_RULES.check('short'), /至少 8 位/);
  assert.match(PASSWORD_RULES.check('A'.repeat(17) + 'a1!'), /不能超过 16 位/);
  assert.match(PASSWORD_RULES.check('alllowercase'), /至少 2 类/);
  assert.match(PASSWORD_RULES.check('12345678'), /至少 2 类/);
  assert.match(PASSWORD_RULES.check('Has Space1!'), /空格/);
  assert.equal(PASSWORD_RULES.check(NEW_PASSWORD), null);
  // 海康实际策略是“至少 2 类”，这类密码必须放行
  assert.equal(PASSWORD_RULES.check('1q2w3e4r'), null, '小写+数字（2 类）应被接受');
  assert.equal(PASSWORD_RULES.classes('1q2w3e4r'), 2);
  assert.equal(PASSWORD_RULES.strength('1q2w3e4r'), 'weak');
  assert.equal(PASSWORD_RULES.strength('Hik@2026Y2S4M'), 'strong');
});

await test('buildEncryptPassword 输出 base64(ascii-hex)，长度符合预期', () => {
  const challenge = 'a'.repeat(64);
  const iv = '0'.repeat(32);
  const out = buildEncryptPassword(challenge, 'Password1!', iv);
  const decoded = Buffer.from(out, 'base64').toString('ascii');
  assert.match(decoded, /^[0-9a-f]+$/, '解密后不是十六进制密文');
  // 16 (challenge prefix) + 11 (password) = 27 bytes -> padded to 32 -> 64 hex chars
  assert.equal(decoded.length, 64);
});

await test('encodeAesCbc 拒绝非法密钥/IV', () => {
  assert.throws(() => encodeAesCbc('x', 'zz', '0'.repeat(32)), /十六进制/);
  assert.throws(() => encodeAesCbc('x', 'ab', '0'.repeat(32)), /密钥长度非法/);
  assert.throws(() => encodeAesCbc('x', 'a'.repeat(64), 'abcd'), /IV 长度非法/);
});

let actMock = null;
let actPort = 0;
try {
  actMock = new MockDevice({ authMode: 'session', activated: false, supportVersion: 3, password: '' });
  actPort = await actMock.listen(0);

  await test('未激活设备：状态查询返回未激活 + supportVersion 3', async () => {
    const st = await getActivateStatus('127.0.0.1', { port: actPort });
    assert.equal(st.reachable, true);
    assert.equal(st.inactive, true);
    assert.equal(st.activated, false);
    assert.equal(st.supportVersion, 3);
  });

  await test('未激活设备：其它 ISAPI 一律 403（与真机一致）', async () => {
    const client = new IsapiClient({ ip: '127.0.0.1', port: actPort, username: 'admin', password: 'x', timeoutMs: 4000 });
    const st = await probe(client);
    assert.equal(st.online, false);
    client.close();
  });

  await test('GetChallengeV3 挑战握手成功（RSA-3072 往返）', async () => {
    const hs = await fetchActivateChallenge('127.0.0.1', { port: actPort });
    assert.equal(hs.ok, true, `握手失败: ${JSON.stringify(hs.attempts)}`);
    assert.equal(hs.keyFormat, 'hex-modulus', '首选格式应为 hex-modulus（厂商库用 n.toString(16)）');
    assert.equal(hs.challengeBytes, 16, '与真机一致：16 字节挑战值 → AES-128');
    assert.match(hs.challengeHex, /^[0-9a-f]{32}$/);
    assert.equal(hs.decryptVia, 'base64->hex->bytes', '挑战值应按 base64(hex(bytes)) 解析');
  });

  await test('挑战值为 32 字节时走 AES-256 分支', async () => {
    const m32 = new MockDevice({ activated: false, challengeBytes: 32, password: '' });
    const p32 = await m32.listen(0);
    try {
      const hs = await fetchActivateChallenge('127.0.0.1', { port: p32 });
      assert.equal(hs.ok, true, JSON.stringify(hs.attempts));
      assert.equal(hs.challengeBytes, 32);
      const r = await activateDevice('127.0.0.1', { port: p32, password: NEW_PASSWORD });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(m32.password, NEW_PASSWORD, 'AES-256 分支解密出的密码不一致');
    } finally {
      await m32.close();
    }
  });

  await test('弱密码被拒绝且设备保持未激活', async () => {
    await assert.rejects(() => activateDevice('127.0.0.1', { port: actPort, password: 'abc' }), /至少 8 位/);
    const st = await getActivateStatus('127.0.0.1', { port: actPort });
    assert.equal(st.activated, false, '弱密码校验失败后设备不应被激活');
  });

  await test('激活成功：设备解密出的密码与下发一致', async () => {
    const r = await activateDevice('127.0.0.1', { port: actPort, password: NEW_PASSWORD });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.activated, true);
    assert.equal(r.keyFormat, 'hex-modulus');
    assert.equal(actMock.activated, true, '设备侧未进入已激活状态');
    assert.equal(actMock.password, NEW_PASSWORD, '设备解密得到的密码与下发不一致 —— AES 链路有误');
  });

  await test('激活后可用新密码登录并读取设备信息', async () => {
    const client = new IsapiClient({ ip: '127.0.0.1', port: actPort, username: 'admin', password: NEW_PASSWORD, timeoutMs: 5000 });
    const st = await probe(client);
    assert.equal(st.online, true, st.error || '');
    assert.equal(client.authMode, 'session');
    client.close();
  });

  await test('重复激活返回“已激活”而不报错', async () => {
    const r = await activateDevice('127.0.0.1', { port: actPort, password: NEW_PASSWORD });
    assert.equal(r.ok, true);
    assert.equal(r.alreadyActivated, true);
  });

  await test('激活失败时不会误报成功（错误 IV 前缀不匹配）', async () => {
    const m2 = new MockDevice({ activated: false, password: '' });
    const p2 = await m2.listen(0);
    try {
      const hs = await fetchActivateChallenge('127.0.0.1', { port: p2 });
      assert.equal(hs.ok, true);
      // Correct protocol but a password the device would still accept; now break the
      // prefix by feeding a challenge that is not the pending one.
      const iv = '0f'.repeat(16);
      const bad = buildEncryptPassword('f'.repeat(64), NEW_PASSWORD, iv);
      const res = await fetch(`http://127.0.0.1:${p2}/ISAPI/System/activate/StartActivateV3?format=json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: bad, iv }),
      });
      assert.equal(res.status, 400, '前缀不匹配时设备应拒绝');
      assert.equal(m2.activated, false);
    } finally {
      await m2.close();
    }
  });
} finally {
  if (actMock) await actMock.close();
}

/* ================================================================== */
group('9. 真机兼容性回归（HK-Y2S4M-GL/L 实测行为）');

await test('session 登录不回声 sessionID 且 Cookie 名为 WebSession_<hex> 时仍可用', async () => {
  const m = new MockDevice({ authMode: 'session', suffixCookieName: true, hideSessionIdEcho: true, password: PASSWORD });
  const p = await m.listen(0);
  try {
    const client = new IsapiClient({ ip: '127.0.0.1', port: p, username: 'admin', password: PASSWORD, timeoutMs: 5000 });
    const ok = await client.login();
    assert.equal(ok, true);
    assert.equal(client.authMode, 'session', '应保持 session 模式');
    assert.match(client.session.cookieName, /^WebSession_/, `Cookie 名未被正确捕获: ${client.session.cookieName}`);
    assert.match(client.session.cookie, /^WebSession_[0-9a-f]+=.+/, 'Cookie 键值对应完整保留');
    assert.ok(client.session.sessionTag, '未捕获 sessionTag');
    // and the session must actually work
    const st = await probe(client, { deep: false });
    assert.equal(st.online, true, st.error || '');
    assert.equal(st.model, 'DS-2CD2347G2-LQ'.replace('Q', 'U'));
    client.close();
  } finally { await m.close(); }
});

await test('session 应答 OK 但会话不可用时自动回退 Digest', async () => {
  const m = new MockDevice({ authMode: 'both', suffixCookieName: true, hideSessionIdEcho: true, breakSession: true, password: PASSWORD });
  const p = await m.listen(0);
  try {
    const client = new IsapiClient({ ip: '127.0.0.1', port: p, username: 'admin', password: PASSWORD, timeoutMs: 5000 });
    const st = await probe(client, { deep: false });
    assert.equal(st.online, true, st.error || '');
    assert.equal(client.authMode, 'digest', '应回退到 digest');
    client.close();
  } finally { await m.close(); }
});

await test('主码流 101 返回 deviceBusy 时抓图自动降级到 102', async () => {
  const m = new MockDevice({ authMode: 'session', password: PASSWORD, busySnapshotChannels: [101] });
  const p = await m.listen(0);
  try {
    const client = new IsapiClient({ ip: '127.0.0.1', port: p, username: 'admin', password: PASSWORD, timeoutMs: 5000 });
    const s = await snapshot(client, { channel: 101 });
    assert.equal(s.channel, 102, '未降级到子码流');
    assert.match(s.contentType, /image\/jpeg/);
    assert.equal(client.snapshotChannel, 102, '未缓存可用通道');
    const t0 = Date.now();
    const s2 = await snapshot(client, { channel: 101 });
    assert.equal(s2.channel, 102);
    assert.ok(Date.now() - t0 < 1500, '二次抓图没有直接命中缓存通道');
    client.close();
  } finally { await m.close(); }
});

await test('非 deviceBusy 的抓图错误不应被静默吞掉', async () => {
  const m = new MockDevice({ authMode: 'session', password: PASSWORD });
  const p = await m.listen(0);
  try {
    const client = new IsapiClient({ ip: '127.0.0.1', port: p, username: 'admin', password: PASSWORD, timeoutMs: 5000 });
    await client.login();
    // channel 999 is not implemented by the mock -> statusCode 3 notSupport
    await assert.rejects(() => snapshot(client, { channel: 999, fallback: [998] }), /抓图失败|notSupport|不支持/i);
    client.close();
  } finally { await m.close(); }
});

/* ================================================================== */
group('10. 萤石云状态 + 批量激活');

await test('getEzviStatus 解析真机字段（registerStatus 为绑定标志）', async () => {
  const m = new MockDevice({
    authMode: 'session', password: PASSWORD,
    ezviz: { enabled: true, registerStatus: 'true', verificationCode: 'ABC123' },
  });
  const p = await m.listen(0);
  try {
    const client = new IsapiClient({ ip: '127.0.0.1', port: p, username: 'admin', password: PASSWORD, timeoutMs: 5000 });
    const e = await getEzviStatus(client);
    assert.equal(e.supported, true);
    assert.equal(e.enabled, true);
    assert.equal(e.registerStatus, 'true');
    assert.equal(e.bound, true, 'registerStatus=true 应判定为已绑定');
    assert.equal(e.verificationCode, 'ABC123');
    assert.equal(e.serverAddress, 'litedev.ys7.com');
    assert.deepEqual(e.verificationCodeLength, { min: 6, max: 12 });
    assert.equal(e.supportUpIsapi, true);
    assert.equal(e.error, null);
    client.close();
  } finally { await m.close(); }
});

await test('未开启/未绑定时正确显示为 false', async () => {
  const m = new MockDevice({ authMode: 'session', password: PASSWORD });
  const p = await m.listen(0);
  try {
    const client = new IsapiClient({ ip: '127.0.0.1', port: p, username: 'admin', password: PASSWORD, timeoutMs: 5000 });
    const e = await getEzviStatus(client);
    assert.equal(e.supported, true);
    assert.equal(e.enabled, false);
    assert.equal(e.bound, false, 'registerStatus=false 不应判定为已绑定');
    assert.equal(e.registerStatus, 'false');
    client.close();
  } finally { await m.close(); }
});

await test('设备不支持萤石云时不抛异常，supported=false 且有 error', async () => {
  const m = new MockDevice({ authMode: 'session', password: PASSWORD, ezviz: { unsupported: true } });
  const p = await m.listen(0);
  try {
    const client = new IsapiClient({ ip: '127.0.0.1', port: p, username: 'admin', password: PASSWORD, timeoutMs: 5000 });
    const e = await getEzviStatus(client);
    assert.equal(e.supported, false);
    assert.equal(e.bound, false);
    assert.ok(e.error, '应给出错误原因');
    client.close();
  } finally { await m.close(); }
});

await test('probe(deep) 会带上 ezviz 字段', async () => {
  const m = new MockDevice({ authMode: 'session', password: PASSWORD, ezviz: { enabled: true, registerStatus: 'false' } });
  const p = await m.listen(0);
  try {
    const client = new IsapiClient({ ip: '127.0.0.1', port: p, username: 'admin', password: PASSWORD, timeoutMs: 5000 });
    const st = await probe(client, { deep: true });
    assert.equal(st.online, true);
    assert.ok(st.ezviz, 'deep probe 应包含 ezviz');
    assert.equal(st.ezviz.enabled, true);
    assert.equal(st.ezviz.bound, false);
    client.close();
  } finally { await m.close(); }
});

await test('POST /api/activate/batch 批量激活两台未激活设备（含自动入库）', async () => {
  const m1 = new MockDevice({ activated: false, password: '', supportVersion: 3 });
  const m2 = new MockDevice({ activated: false, password: '', supportVersion: 3 });
  const p1 = await m1.listen(0);
  const p2 = await m2.listen(0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hikctl-batch-'));
  const app2 = createServer({ rootDir: tmp, version: 'test' });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const port = app2.server.address().port;

  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  try {
    // config endpoint drives the UI pre-fill
    const cfg = await call('GET', '/api/activate/config');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.data.defaultPassword, '1q2w3e4r', '默认密码应为 1q2w3e4r');
    assert.equal(cfg.data.minClasses, 2);

    // batch activate without passing a password -> must use the default
    const r = await call('POST', '/api/activate/batch', {
      targets: [{ ip: '127.0.0.1', port: p1 }, { ip: '127.0.0.1', port: p2 }],
      autoAdd: true,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.total, 2);

    let task = null;
    for (let i = 0; i < 60; i++) {
      const t = await call('GET', `/api/tasks/${r.data.taskId}`);
      if (t.data && t.data.state !== 'running') { task = t.data; break; }
      await new Promise((res) => setTimeout(res, 150));
    }
    assert.ok(task, '任务未在超时内结束');
    assert.equal(task.state, 'done');
    assert.equal(task.summary.ok, 2, JSON.stringify(task.results));
    assert.equal(m1.activated, true, '设备 1 未激活');
    assert.equal(m2.activated, true, '设备 2 未激活');
    assert.equal(m1.password, '1q2w3e4r', '设备 1 收到的密码不是默认密码');
    assert.equal(m2.password, '1q2w3e4r', '设备 2 收到的密码不是默认密码');

    // both must have landed in the device library
    const list = await call('GET', '/api/devices');
    const ids = list.data.map((d) => d.id).sort();
    assert.deepEqual(ids, [`127.0.0.1:${p1}`, `127.0.0.1:${p2}`].sort(), `未自动入库: ${JSON.stringify(ids)}`);
    assert.ok(list.data.every((d) => d.hasPassword), '入库后应带凭据');
  } finally {
    app2.store.closeAll();
    await new Promise((r) => app2.server.close(r));
    await m1.close();
    await m2.close();
  }
});

await test('批量激活：已激活的设备被识别并跳过重复激活', async () => {
  const m = new MockDevice({ activated: true, password: PASSWORD });
  const p = await m.listen(0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hikctl-batch2-'));
  const app3 = createServer({ rootDir: tmp, version: 'test' });
  await new Promise((r) => app3.server.listen(0, '127.0.0.1', r));
  const port = app3.server.address().port;
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    const r = await call('POST', '/api/activate/batch', { targets: [{ ip: '127.0.0.1', port: p }] });
    let task = null;
    for (let i = 0; i < 40; i++) {
      const t = await call('GET', `/api/tasks/${r.data.taskId}`);
      if (t.data && t.data.state !== 'running') { task = t.data; break; }
      await new Promise((res) => setTimeout(res, 150));
    }
    assert.equal(task.summary.ok, 1);
    assert.match(task.results[0].message, /已激活/);
    assert.equal(task.results[0].detail.alreadyActivated, true);
    assert.equal(m.password, PASSWORD, '已激活设备不应被改密码');
  } finally {
    app3.store.closeAll();
    await new Promise((r) => app3.server.close(r));
    await m.close();
  }
});

await test('retries:0 的首次请求仍会自动登录并成功（回归）', async () => {
  // Regression: the very first call on a fresh client is what triggers the login.
  // Gating the post-login retry behind `retries` made `retries:0` fail with a bogus
  // "cannot connect" — which silently broke getEzviStatus' capabilities probe.
  const m = new MockDevice({ authMode: 'session', password: PASSWORD });
  const p = await m.listen(0);
  try {
    const client = new IsapiClient({ ip: '127.0.0.1', port: p, username: 'admin', password: PASSWORD, timeoutMs: 5000 });
    const r = await client.getText('/ISAPI/System/Network/EZVIZ/capabilities', { timeoutMs: 5000, retries: 0 });
    assert.equal(r.status, 200);
    assert.match(r.text, /isSupportUpISAPI/);
    assert.equal(client.authMode, 'session', '首次请求应完成 session 登录');
    client.close();
  } finally { await m.close(); }
});

await test('retries:0 遇到错误密码仍然抛鉴权错误', async () => {
  const m = new MockDevice({ authMode: 'session', password: PASSWORD });
  const p = await m.listen(0);
  try {
    const client = new IsapiClient({ ip: '127.0.0.1', port: p, username: 'admin', password: 'nope-nope', timeoutMs: 5000 });
    await assert.rejects(
      () => client.getText('/ISAPI/System/deviceInfo', { timeoutMs: 5000, retries: 0 }),
      /密码|鉴权|登录/,
    );
    client.close();
  } finally { await m.close(); }
});

await test('SADP 解析萤石云字段', () => {
  const xml = '<ProbeMatch><IPv4Address>203.0.113.9</IPv4Address>'
    + '<DeviceDescription>DS-TEST</DeviceDescription><DeviceSN>SN1</DeviceSN>'
    + '<EZVIZBindStatus>0</EZVIZBindStatus><supportEzvizUnbind>true</supportEzvizUnbind>'
    + '<HCPlatformEnable>true</HCPlatformEnable><Activated>false</Activated></ProbeMatch>';
  const d = parseProbeResponse(xml);
  assert.equal(d.ezvizBindStatus, '0');
  assert.equal(d.ezvizBound, false, 'EZVIZBindStatus=0 应判定未绑定');
  assert.equal(d.supportEzvizUnbind, true);
  assert.equal(d.hcPlatformEnable, true);
  assert.equal(d.activated, false);

  const bound = parseProbeResponse('<ProbeMatch><IPv4Address>203.0.113.9</IPv4Address><EZVIZBindStatus>1</EZVIZBindStatus></ProbeMatch>');
  assert.equal(bound.ezvizBound, true, 'EZVIZBindStatus=1 应判定已绑定');
});

/* ================================================================== */
group('11. IP 扫描发现未激活设备');

await test('扫描能发现未激活设备（ISAPI 全拒绝，但 /SDK/activateStatus 可读）', async () => {
  const m = new MockDevice({ activated: false, password: '', supportVersion: 3 });
  const p = await m.listen(0);
  try {
    const results = [];
    const summary = await scanRange({
      from: '127.0.0.1', to: '127.0.0.1', ports: [p], concurrency: 2, timeoutMs: 800,
      username: 'admin', password: 'whatever',
      onResult: (r) => results.push(r),
    });
    assert.equal(summary.found, 1, `未发现未激活设备: ${JSON.stringify(summary)}`);
    const hit = results.find((r) => r.ip === '127.0.0.1' && r.found);
    assert.ok(hit, '未上报该设备');
    assert.equal(hit.activated, false, '应标记为未激活');
    assert.equal(hit.needsActivation, true);
    assert.equal(hit.supportVersion, 3);
    assert.equal(hit.model, '', '未激活设备读不到型号');
  } finally { await m.close(); }
});

await test('扫描仍能发现已激活设备并标记 activated=true', async () => {
  const m = new MockDevice({ activated: true, password: PASSWORD });
  const p = await m.listen(0);
  try {
    const results = [];
    const summary = await scanRange({
      from: '127.0.0.1', to: '127.0.0.1', ports: [p], concurrency: 2, timeoutMs: 800,
      username: 'admin', password: PASSWORD,
      onResult: (r) => results.push(r),
    });
    assert.equal(summary.found, 1);
    const hit = results.find((r) => r.found);
    assert.equal(hit.activated, true);
    assert.equal(hit.needsActivation, false);
    assert.match(hit.model, /DS-2CD/);
  } finally { await m.close(); }
});

/* ================================================================== */
group('12. 设备后台（离线配置包托管 + 反向代理）');

await test('detectPackageRoot 能找到离线配置包根目录', () => {
  const root = detectPackageRoot();
  if (!root) {
    // 机器上没装 HiToolsDelivery 时跳过（CI 环境）
    console.log('      （本机未找到离线配置包，跳过后续用例）');
    return;
  }
  assert.ok(fs.existsSync(path.join(root, 'ConfigKitSDK.js')), '根目录下应有 ConfigKitSDK.js');
  const pkgs = listPackages(root);
  assert.ok(pkgs.length > 0, '应至少解析出一个包');
  assert.ok(pkgs.some((p) => p.sign === 'R0101'), `应有摄像头包 R0101，实际: ${pkgs.map((p) => p.sign).join(',')}`);
  assert.ok(pkgs.some((p) => p.sign === 'R0101' && p.variant === 'webs_5.0_isapi'));
});

const pkgRoot = detectPackageRoot();
if (pkgRoot) {
  const m = new MockDevice({ authMode: 'session', password: PASSWORD });
  const mp = await m.listen(0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hikctl-console-'));
  const app4ctx = {};
  const app4 = createServer({ rootDir: tmp, version: 'test', ctx: app4ctx });
  const consoleHost = createConsole({ store: app4.store, packageRoot: pkgRoot, port: 0 });
  const cport = await consoleHost.listen(0);
  app4ctx.consoleHost = consoleHost;
  app4.store.add({ ip: '127.0.0.1', port: mp, username: 'admin', password: PASSWORD, label: '代理测试机' });
  const deviceId = `127.0.0.1:${mp}`;
  const base = `http://127.0.0.1:${cport}`;

  try {
    await test('设备后台：/__state 报告包目录与已存设备', async () => {
      const r = await fetch(`${base}/__state`);
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.ok, true);
      assert.ok(j.packages > 0, '应报告可用包数量');
      assert.ok(j.devices.includes(deviceId), `设备列表应含 ${deviceId}`);
    });

    await test('设备后台：落地页列出设备与包', async () => {
      const r = await fetch(`${base}/console`);
      assert.equal(r.status, 200);
      const t = await r.text();
      assert.match(t, /打开设备后台/);
      assert.match(t, new RegExp(deviceId.replace(/[.:]/g, (c) => `\\${c}`)));
    });

    await test('设备后台：/open 下发 ProxyHostInfo 等 Cookie 并注入 ConfigKit.Init', async () => {
      const r = await fetch(`${base}/open?device=${encodeURIComponent(deviceId)}`);
      assert.equal(r.status, 200);
      const t = await r.text();
      assert.match(t, /ConfigKitSDK\.js/, '应加载 ConfigKitSDK');
      assert.match(t, /ConfigKit\.Init/, '应调用 ConfigKit.Init');
      assert.match(t, /"webLocation":"local"/);
      assert.match(t, /"needProxy":true/);
      assert.match(t, new RegExp(`"deviceId":"${deviceId.replace(/[.:]/g, (c) => `\\${c}`)}"`));
      const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
      const all = cookies.join(';');
      assert.match(all, /ProxyHostInfo=/, '必须下发 ProxyHostInfo（代理靠它选设备）');
      assert.match(all, /SDKMode=ip/);
    });

    await test('设备后台：托管 ConfigKitSDK.js 与包内静态资源', async () => {
      const sdk = await fetch(`${base}/WebConfigCtrl/ConfigKitSDK.js`);
      assert.equal(sdk.status, 200);
      const sdkText = await sdk.text();
      assert.ok(sdkText.length > 100_000, `ConfigKitSDK.js 过小: ${sdkText.length}`);
      assert.match(sdkText, /ConfigKit/);

      const idx = await fetch(`${base}/WebConfigCtrl/Packages/R0101/webs_5.0_isapi/doc/index.html`);
      assert.equal(idx.status, 200);
      assert.ok((await idx.text()).length > 10_000);
    });

    await test('设备后台：DISPATCH_ip_<host> 反向代理到设备（带鉴权）', async () => {
      const r = await fetch(`${base}/DISPATCH_ip_${deviceId}/ISAPI/System/deviceInfo`);
      assert.equal(r.status, 200);
      const t = await r.text();
      assert.match(t, /DS-2CD2347G2-LU/, `代理未返回设备信息: ${t.slice(0, 200)}`);
    });

    await test('设备后台：DISPATCH 代理可传查询串', async () => {
      const r = await fetch(`${base}/DISPATCH_ip_${deviceId}/ISAPI/System/deviceInfo?format=json`);
      assert.equal(r.status, 200);
      assert.ok((await r.text()).length > 100);
    });

    await test('设备后台：抓图经代理返回真实 JPEG', async () => {
      const r = await fetch(`${base}/DISPATCH_ip_${deviceId}/ISAPI/Streaming/channels/101/picture`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') || '', /image\/jpeg/);
      const buf = Buffer.from(await r.arrayBuffer());
      assert.equal(buf.subarray(0, 3).toString('hex'), 'ffd8ff', '不是 JPEG 魔数');
    });

    await test('设备后台：未知设备返回可读错误而不是崩溃', async () => {
      const r = await fetch(`${base}/open?device=203.0.113.99:80`);
      assert.equal(r.status, 404);
      assert.match(await r.text(), /设备不在库中/);
    });

    await test('设备后台：路径穿越被拒绝', async () => {
      const r = await fetch(`${base}/WebConfigCtrl/..%2F..%2F..%2FWindows%2Fwin.ini`);
      assert.ok(r.status === 404 || r.status === 403, `期望 404/403，实际 ${r.status}`);
    });

    await test('设备后台：listen() 幂等，并发调用不会报「无法监听端口」', async () => {
      // 回归：主服务 listen 回调在端口重试路径下可能触发两次，导致 consoleHost.listen()
      // 被并发调用；第二个调用撞上 ERR_SERVER_ALREADY_LISTEN，于是界面显示
      // 「设备后台：启动失败」——但其实它已经起来了。
      const h2 = createConsole({ store: app4.store, packageRoot: pkgRoot, port: 0 });
      try {
        const [p1, p2, p3] = await Promise.all([h2.listen(0), h2.listen(0), h2.listen(0)]);
        assert.equal(p1, p2, '并发 listen 应返回同一端口');
        assert.equal(p1, p3, '并发 listen 应返回同一端口');
        const again = await h2.listen(0);
        assert.equal(again, p1, '重复 listen 应复用同一实例');
        assert.ok(p1 > 0);
      } finally {
        await h2.close();
      }
    });

    await test('主服务 /api/console/state 与 /api/console/url 可用', async () => {
      await new Promise((r) => app4.server.listen(0, '127.0.0.1', r));
      const ap = app4.server.address().port;
      const st = await (await fetch(`http://127.0.0.1:${ap}/api/console/state`)).json();
      assert.equal(st.running, true);
      assert.equal(st.port, cport);
      const u = await (await fetch(`http://127.0.0.1:${ap}/api/console/url?device=${encodeURIComponent(deviceId)}`)).json();
      assert.match(u.url, /\/open\?device=/);
      const bad = await fetch(`http://127.0.0.1:${ap}/api/console/url?device=203.0.113.99:80`);
      assert.equal(bad.status, 404);
    });
  } finally {
    await consoleHost.close();
    app4.store.closeAll();
    if (app4.server.listening) await new Promise((r) => app4.server.close(r));
    await m.close();
  }
}

/* ================================================================== */
console.log(`\n${'─'.repeat(52)}`);
console.log(`  通过 \x1b[32m${PASS}\x1b[0m   失败 \x1b[31m${FAIL}\x1b[0m`);
if (FAIL) {
  console.log('\n失败详情:');
  for (const f of failures) console.log(` - ${f.name}: ${f.error.message}`);
}
console.log(`${'─'.repeat(52)}\n`);
process.exit(FAIL ? 1 : 0);