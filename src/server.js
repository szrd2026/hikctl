/**
 * hikctl HTTP API + static UI server. Node built-ins only.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { Store } from './store.js';
import { EventHub, TaskManager } from './tasks.js';
import { sadpDiscover } from './sadp.js';
import { scanRange } from './discover.js';
import { serveMjpeg, serveSnapshot, rtspUrl } from './preview.js';
import { collectReport, writeReport } from './report.js';
import {
  probe, getNetwork, setNetwork, getTime, setTimeManual, setTimeNtp,
  changePassword, reboot, factoryReset, upgradeFirmware, waitUpgrade,
  listUsers, listStreamingChannels, getOsd, setOsdRaw, getImageParams, setImageRaw,
} from './ops.js';
import { errMsg, localIPv4List, clamp } from './util.js';
import { getActivateStatus, fetchActivateChallenge, activateDevice, PASSWORD_RULES, DEFAULT_ACTIVATION_PASSWORD, DEFAULT_ACTIVATION_CONCURRENCY } from './activate.js';
import os from 'node:os';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const MAX_BODY = 4 * 1024 * 1024;

export function createServer({ rootDir, version = '1.0.0', ctx = {}, dataDir = null, reportsDir = null }) {
  const store = new Store(rootDir, { dataDir, reportsDir });
  const hub = new EventHub();
  const tasks = new TaskManager(hub);
  const webDir = path.join(rootDir, 'web');
  const startedAt = Date.now();
  let activeScans = 0;

  const json = (res, code, obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  };
  const fail = (res, code, message, extra) => json(res, code, { error: { code: String(code), message, ...(extra || {}) } });

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const readJson = async (req) => {
    const buf = await readBody(req);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error('请求体不是合法 JSON'); }
  };

  /* --------------------------- device helpers -------------------------- */

  const deviceList = () => store.list().map((d) => ({
    ...store.toPublic(d),
    status: d.status || null,
  }));

  async function probeAndStore(id, { deep = true, broadcast = true } = {}) {
    const dev = store.get(id);
    if (!dev) throw new Error('设备不存在');
    const client = store.client(id);
    const status = await probe(client, { deep });
    store.setStatus(id, status);
    if (broadcast) hub.broadcast('device.status', { id, status });
    return status;
  }

  /**
   * Probe with a couple of retries. A freshly activated device can take a moment
   * before its ISAPI stack is ready, and one failed probe used to leave the device
   * stuck showing a stale/incorrect status in the UI.
   */
  async function probeWithRetry(id, { attempts = 3, delayMs = 1200, deep = true } = {}) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      try {
        last = await probeAndStore(id, { deep });
      } catch (e) {
        last = { online: false, error: errMsg(e), activated: null, checkedAt: Date.now() };
      }
      if (last && last.online) return last;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return last;
  }

  /** Resolve the { params } block used by batch actions into a per-device worker. */
  function batchWorker(action, params) {
    const p = params || {};
    switch (action) {
      case 'probe':
        return async (id) => {
          const st = await probeAndStore(id, { deep: true });
          return st.online
            ? { ok: true, message: `在线 ${st.latencyMs}ms · ${st.model || ''}`.trim() }
            : { ok: false, message: st.error || '离线' };
        };
      case 'reboot':
        return async (id) => {
          const r = await reboot(store.client(id));
          return { ok: true, message: r.message };
        };
      case 'reset':
        return async (id) => {
          const dev = store.secret(store.get(id));
          const r = await factoryReset(store.client(id), { mode: p.mode || 'basic', password: dev.password });
          return { ok: true, message: r.message };
        };
      case 'setTime':
        return async (id) => {
          const client = store.client(id);
          if (p.mode === 'ntp') {
            const r = await setTimeNtp(client, { server: p.server, port: p.port || 123, intervalMinutes: p.intervalMinutes || 60, timeZone: p.timeZone });
            return { ok: true, message: r.applied };
          }
          if (p.mode === 'manual') {
            const r = await setTimeManual(client, p.dateTime);
            return { ok: true, message: `已设置为 ${r.applied}` };
          }
          const r = await setTimeManual(client, null);
          return { ok: true, message: `已与电脑对时 ${r.applied}` };
        };
      case 'setNetwork':
        return async (id) => {
          const r = await setNetwork(store.client(id), p);
          return { ok: true, message: r.message, detail: { newId: r.newId, rebootRequired: r.rebootRequired } };
        };
      case 'setPassword':
        return async (id) => {
          const dev = store.secret(store.get(id));
          const r = await changePassword(store.client(id), {
            userName: p.userName || dev.username,
            oldPassword: dev.password,
            newPassword: p.newPassword,
          });
          store.update(id, { password: p.newPassword });
          return { ok: true, message: r.message };
        };
      default:
        throw new Error(`不支持的批量操作: ${action}`);
    }
  }

  /* ------------------------------- routing ----------------------------- */

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const method = req.method.toUpperCase();
    const seg = p.split('/').filter(Boolean).map(decodeURIComponent);
    // seg: ['api', ...]

    if (seg[1] === 'health') {
      return json(res, 200, {
        ok: true, version,
        uptimeMs: Date.now() - startedAt,
        port: url.port || null,
        devices: store.list().length,
        sseClients: hub.size,
        interfaces: localIPv4List(os),
      });
    }

    /**
     * 优雅关闭（供桌面「关闭」快捷方式调用）。
     * 只允许本机回环地址调用 —— 即使服务用 --host 0.0.0.0 暴露出去，别人也关不掉它。
     */
    if (seg[1] === 'shutdown' && method === 'POST') {
      const ra = String(req.socket.remoteAddress || '');
      const isLoopback = ra === '::1' || ra === '127.0.0.1' || ra.startsWith('::ffff:127.');
      if (!isLoopback) return fail(res, 403, '只允许本机调用关闭接口');
      json(res, 200, { ok: true, message: '正在关闭 hikctl' });
      // 先把响应发出去，再关，否则调用方拿到的是连接被重置
      setTimeout(() => {
        try {
          if (typeof ctx.onShutdown === 'function') ctx.onShutdown();
        } catch (e) {
          process.exit(0);
        }
      }, 200);
      return undefined;
    }

    if (seg[1] === 'events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\r\n\r\n');
      hub.add(res);
      const ka = setInterval(() => { try { res.write(': ka\r\n\r\n'); } catch { clearInterval(ka); } }, 25_000);
      req.on('close', () => clearInterval(ka));
      return undefined;
    }

    /* ---- tasks ---- */
    if (seg[1] === 'tasks') {
      if (!seg[2]) return json(res, 200, tasks.list());
      const t = tasks.get(seg[2]);
      if (!t) return fail(res, 404, '任务不存在');
      if (method === 'DELETE') { tasks.cancel(t.taskId); return json(res, 200, { ok: true }); }
      return json(res, 200, {
        taskId: t.taskId, action: t.action, state: t.state, total: t.total,
        done: t.done, ok: t.ok, failed: t.failed, startedAt: t.startedAt,
        finishedAt: t.finishedAt, elapsedMs: t.elapsedMs,
        summary: t.summary, meta: t.meta, results: t.results,
      });
    }

    /* ---- activation (works on a device that is not yet in the store) ---- */
    if (seg[1] === 'activate') {
      if (seg[2] === 'config' && method === 'GET') {
        return json(res, 200, {
          defaultPassword: DEFAULT_ACTIVATION_PASSWORD,
          minLength: PASSWORD_RULES.minLength,
          maxLength: PASSWORD_RULES.maxLength,
          minClasses: PASSWORD_RULES.minClasses,
          defaultConcurrency: DEFAULT_ACTIVATION_CONCURRENCY,
        });
      }
      if (seg[2] === 'status' && method === 'GET') {
        const ip = url.searchParams.get('ip');
        if (!ip) return fail(res, 400, '缺少 ip');
        return json(res, 200, await getActivateStatus(ip, {
          port: Number(url.searchParams.get('port')) || 80,
          https: url.searchParams.get('https') === 'true',
        }));
      }
      if (seg[2] === 'challenge' && method === 'POST') {
        const body = await readJson(req);
        if (!body.ip) return fail(res, 400, '缺少 ip');
        const r = await fetchActivateChallenge(body.ip, {
          port: Number(body.port) || 80, https: !!body.https,
        });
        return json(res, r.ok ? 200 : 502, r);
      }

      /* --- batch activation --- */
      if (seg[2] === 'batch' && method === 'POST') {
        const body = await readJson(req);
        const raw = Array.isArray(body.targets) ? body.targets : [];
        const targets = raw
          .map((t) => (typeof t === 'string'
            ? { ip: t.split(':')[0], port: Number(t.split(':')[1]) || 80 }
            : { ip: t && t.ip, port: Number(t && t.port) || 80, https: !!(t && t.https) }))
          .filter((t) => t.ip);

        if (!targets.length) return fail(res, 400, 'targets 为空');

        const password = body.password || DEFAULT_ACTIVATION_PASSWORD;
        const ruleError = PASSWORD_RULES.check(password);
        if (ruleError) return fail(res, 400, ruleError);

        const autoAdd = body.autoAdd !== false;
        const concurrency = clamp(Number(body.concurrency) || DEFAULT_ACTIVATION_CONCURRENCY, 1, 16);
        const task = tasks.create('activate', targets.length, {
          password: '***',
          concurrency,
          autoAdd,
        });

        const worker = async (t) => {
          const status = await getActivateStatus(t.ip, { port: t.port, https: t.https });
          if (!status.reachable) {
            return { ok: false, message: `设备不可达：${status.error || '无响应'}` };
          }
          if (status.activated) {
            // Already activated: make sure it is in the library, then report as ok.
            const id = `${t.ip}:${t.port}`;
            if (autoAdd && !store.get(id)) {
              store.add({
                ip: t.ip, port: t.port, https: t.https,
                username: body.userName || 'admin', password,
                label: body.label || '',
              });
              store.save();
              try { await probeWithRetry(id); } catch { /* ignore */ }
            }
            return { ok: true, message: '设备已激活，已同步到设备库', detail: { alreadyActivated: true, deviceId: id } };
          }

          const r = await activateDevice(t.ip, {
            password, port: t.port, https: t.https, userName: body.userName || 'admin',
          });

          const id = `${t.ip}:${t.port}`;
          if (autoAdd && !store.get(id)) {
            const dev = store.add({
              ip: t.ip, port: t.port, https: t.https,
              username: body.userName || 'admin', password,
              label: body.label || '',
            });
            store.save();
            try { await probeWithRetry(dev.id); } catch { /* ignore */ }
            return {
              ok: true,
              message: '激活成功，已加入设备库',
              detail: { keyFormat: r.keyFormat, deviceId: dev.id, challengeBytes: r.challengeBytes },
            };
          }
          return { ok: true, message: '激活成功', detail: { keyFormat: r.keyFormat, deviceId: id } };
        };

        tasks.run(task, targets, worker, concurrency, (t) => `${t.ip}:${t.port}`).catch(() => {});
        return json(res, 200, { taskId: task.taskId, total: targets.length, concurrency });
      }

      if (!seg[2] && method === 'POST') {
        const body = await readJson(req);
        if (!body.ip) return fail(res, 400, '缺少 ip');
        const password = body.password || DEFAULT_ACTIVATION_PASSWORD;
        const ruleError = PASSWORD_RULES.check(password);
        if (ruleError) return fail(res, 400, ruleError);
        try {
          const r = await activateDevice(body.ip, {
            password,
            port: Number(body.port) || 80,
            https: !!body.https,
            userName: body.userName || 'admin',
          });
          if (body.autoAdd !== false) {
            const id = `${body.ip}:${Number(body.port) || 80}`;
            if (!store.get(id)) {
              const dev = store.add({
                ip: body.ip, port: Number(body.port) || 80, https: !!body.https,
                username: body.userName || 'admin', password,
                label: body.label || '',
              });
              try { await probeWithRetry(dev.id); } catch { /* ignore */ }
              store.save();
            }
            r.device = store.toPublic(store.get(id));
          }
          return json(res, 200, r);
        } catch (e) {
          return fail(res, 400, errMsg(e));
        }
      }
      if (seg[2] === 'rules' && method === 'GET') {
        return json(res, 200, {
          minLength: PASSWORD_RULES.minLength,
          maxLength: PASSWORD_RULES.maxLength,
          minClasses: PASSWORD_RULES.minClasses,
          defaultPassword: DEFAULT_ACTIVATION_PASSWORD,
        });
      }
      return fail(res, 404, '未知的激活接口');
    }

    /* ---- discovery ---- */
    if (seg[1] === 'discover') {
      if (seg[2] === 'sadp' && method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const timeoutMs = clamp(Number(body.timeoutMs) || 3000, 500, 30_000);
        const r = await sadpDiscover({ timeoutMs, onResult: (d) => hub.broadcast('sadp.result', d) });
        const known = new Set(store.list().map((d) => d.ip));
        r.found = r.found.map((d) => ({ ...d, alreadyAdded: known.has(d.ip) }));
        return json(res, 200, r);
      }
      if (seg[2] === 'scan' && method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        if (!body.from || !body.to) return fail(res, 400, '缺少 from / to');
        if (activeScans > 0) return fail(res, 409, '已有扫描任务在运行');
        activeScans++;
        const task = tasks.create('scan', 1, { from: body.from, to: body.to });
        (async () => {
          try {
            const summary = await scanRange({
              from: body.from, to: body.to, cidr: body.cidr,
              username: body.username || 'admin', password: body.password || '',
              concurrency: clamp(Number(body.concurrency) || 64, 1, 256),
              timeoutMs: clamp(Number(body.timeoutMs) || 800, 100, 10_000),
              https: !!body.https,
              ports: Array.isArray(body.ports) ? body.ports : undefined,
              isCancelled: () => task.cancelRequested,
              onResult: (r) => {
                hub.broadcast('scan.result', r);
                if (r.found && r.ip) {
                  task.done++;
                  task.ok += 1;
                  task.results.push({ id: r.ip, state: 'ok', message: r.model || '在线', ms: r.latencyMs || 0 });
                }
              },
            });
            task.state = 'done';
            task.finishedAt = Date.now();
            task.elapsedMs = summary.elapsedMs;
            task.summary = { ...summary };
            hub.broadcast('task.done', { taskId: task.taskId, summary: task.summary, state: 'done' });
          } catch (e) {
            task.state = 'failed';
            task.finishedAt = Date.now();
            task.summary = { error: errMsg(e) };
            hub.broadcast('task.done', { taskId: task.taskId, summary: task.summary, state: 'failed' });
          } finally {
            activeScans--;
          }
        })();
        return json(res, 200, { taskId: task.taskId });
      }
      return fail(res, 404, '未知的发现接口');
    }

    /* ---- devices ---- */
    if (seg[1] === 'devices') {
      if (!seg[2]) {
        if (method === 'GET') return json(res, 200, deviceList());
        if (method === 'POST') {
          const body = await readJson(req);
          if (!body.ip) return fail(res, 400, '缺少 ip');
          const dev = store.add({
            ip: String(body.ip).trim(), port: Number(body.port) || 80, https: !!body.https,
            username: body.username || 'admin', password: body.password || '',
            label: body.label || '', group: body.group || '默认分组',
          });
          let status = null;
          try { status = await probeAndStore(dev.id); } catch (e) { status = { online: false, error: errMsg(e) }; }
          store.save();
          return json(res, 200, { device: { ...store.toPublic(dev), status }, probe: status });
        }
        return fail(res, 405, '方法不允许');
      }

      if (seg[2] === 'import' && method === 'POST') {
        const body = await readJson(req);
        const lines = String(body.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const defUser = body.defaultUsername || 'admin';
        const failed = [];
        const addedIds = [];
        for (const line of lines) {
          const parts = line.split(/[,\t;]/).map((s) => s.trim());
          const ip = parts[0];
          if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { failed.push({ line, reason: 'IP 格式不正确' }); continue; }
          const device = store.add({
            ip,
            port: Number(parts[3]) || 80,
            username: parts[1] || defUser,
            password: parts[2] || '',
            label: parts[4] || '',
          });
          addedIds.push(device.id);
        }
        store.save();
        const task = tasks.create('probe', addedIds.length, { source: 'import' });
        const worker = batchWorker('probe', {});
        tasks.run(task, addedIds, worker, 16, (x) => x).catch(() => {});
        return json(res, 200, { added: addedIds.length, skipped: 0, failed, taskId: task.taskId });
      }

      if (seg[2] === 'probe-all' && method === 'POST') {
        const ids = store.list().map((d) => d.id);
        const task = tasks.create('probe', ids.length, {});
        const worker = batchWorker('probe', {});
        tasks.run(task, ids, worker, 16, (x) => x).catch(() => {});
        return json(res, 200, { taskId: task.taskId });
      }

      const id = seg[2];
      const dev = store.get(id);
      const sub = seg[3];

      // Binary/stream endpoints must not require the device record to exist twice.
      if (sub === 'snapshot' && method === 'GET') {
        if (!dev) return fail(res, 404, '设备不存在');
        const channel = Number(url.searchParams.get('channel')) || 101;
        try {
          await serveSnapshot(res, store.client(id), { channel });
        } catch (e) {
          return fail(res, 502, `抓图失败：${errMsg(e)}`);
        }
        return undefined;
      }

      if (sub === 'preview.mjpg' && method === 'GET') {
        if (!dev) return fail(res, 404, '设备不存在');
        const channel = Number(url.searchParams.get('channel')) || 101;
        const fps = Number(url.searchParams.get('fps')) || 5;
        try {
          await serveMjpeg(req, res, store.client(id), { channel, fps });
        } catch (e) {
          if (!res.headersSent) return fail(res, 502, `预览失败：${errMsg(e)}`);
          try { res.end(); } catch { /* ignore */ }
        }
        return undefined;
      }

      if (!dev) return fail(res, 404, '设备不存在');
      const client = () => store.client(id);

      if (!sub) {
        if (method === 'GET') {
          let live = null;
          try { live = await getNetwork(client(), 1); } catch { /* optional */ }
          return json(res, 200, { device: { ...store.toPublic(dev), status: dev.status || null }, network: live });
        }
        if (method === 'DELETE') { store.remove(id); return json(res, 200, { ok: true }); }
        if (method === 'PATCH') {
          const body = await readJson(req);
          const updated = store.update(id, body);
          if (!updated) return fail(res, 404, '设备不存在');
          return json(res, 200, { device: store.toPublic(updated) });
        }
        return fail(res, 405, '方法不允许');
      }

      switch (sub) {
        case 'probe': {
          const status = await probeAndStore(id);
          store.save();
          return json(res, 200, { status });
        }
        case 'stream': {
          const channel = Number(url.searchParams.get('channel')) || 101;
          const secret = store.secret(dev);
          return json(res, 200, {
            rtsp: rtspUrl(secret, channel),
            mjpeg: `/api/devices/${encodeURIComponent(id)}/preview.mjpg?channel=${channel}`,
            snapshot: `/api/devices/${encodeURIComponent(id)}/snapshot?channel=${channel}`,
            modes: ['device-mjpeg', 'snapshot-poll'],
          });
        }
        case 'isapi': {
          if (method === 'GET') {
            const target = url.searchParams.get('path');
            if (!target || !target.startsWith('/ISAPI/')) return fail(res, 400, 'path 必须以 /ISAPI/ 开头');
            const r = await client().request('GET', target);
            return json(res, 200, {
              status: r.status, contentType: r.headers['content-type'] || '',
              body: r.body.toString('utf8').slice(0, 512 * 1024), ms: r.ms, isapi: r.isapi,
            });
          }
          if (method === 'PUT') {
            const body = await readJson(req);
            if (!body.path || !body.path.startsWith('/ISAPI/')) return fail(res, 400, 'path 必须以 /ISAPI/ 开头');
            const r = await client().request('PUT', body.path, {
              body: body.body || '',
              contentType: body.contentType || 'application/xml',
            });
            return json(res, 200, {
              status: r.status, body: r.body.toString('utf8').slice(0, 256 * 1024), ms: r.ms, isapi: r.isapi,
            });
          }
          return fail(res, 405, '方法不允许');
        }
        case 'reboot': {
          const r = await reboot(client());
          return json(res, 200, r);
        }
        case 'reset': {
          const body = await readJson(req);
          const secret = store.secret(dev);
          const r = await factoryReset(client(), {
            mode: body.mode || 'basic',
            password: body.password || secret.password,
          });
          return json(res, 200, r);
        }
        case 'network': {
          if (method === 'GET') return json(res, 200, await getNetwork(client(), Number(url.searchParams.get('interfaceId')) || 1));
          if (method === 'PUT') {
            const body = await readJson(req);
            const r = await setNetwork(client(), body);
            if (r.newId && r.newId !== id) {
              const p = store.get(id);
              if (p) { p.status = { ...(p.status || {}), online: false, error: 'IP 已修改，等待重启' }; }
              store.save();
            }
            return json(res, 200, r);
          }
          return fail(res, 405, '方法不允许');
        }
        case 'time': {
          if (method === 'GET') return json(res, 200, await getTime(client()));
          if (method === 'PUT') {
            const body = await readJson(req);
            if (body.mode === 'ntp') {
              return json(res, 200, await setTimeNtp(client(), {
                server: body.server, port: body.port || 123,
                intervalMinutes: body.intervalMinutes || 60, timeZone: body.timeZone,
              }));
            }
            if (body.mode === 'manual') return json(res, 200, await setTimeManual(client(), body.dateTime));
            return json(res, 200, await setTimeManual(client(), null));
          }
          return fail(res, 405, '方法不允许');
        }
        case 'password': {
          const body = await readJson(req);
          if (!body.newPassword) return fail(res, 400, '缺少 newPassword');
          const secret = store.secret(dev);
          const r = await changePassword(client(), {
            userName: body.userName || secret.username,
            oldPassword: body.oldPassword || secret.password,
            newPassword: body.newPassword,
          });
          if (body.userName && body.userName !== secret.username) store.update(id, { username: body.userName });
          store.update(id, { password: body.newPassword });
          return json(res, 200, r);
        }
        case 'users': {
          if (method === 'GET') return json(res, 200, await listUsers(client()));
          return fail(res, 405, '方法不允许');
        }
        case 'channels': {
          return json(res, 200, await listStreamingChannels(client()));
        }
        case 'osd': {
          const channel = Number(url.searchParams.get('channel')) || 1;
          if (method === 'GET') return json(res, 200, await getOsd(client(), channel));
          if (method === 'PUT') {
            const body = await readJson(req);
            return json(res, 200, await setOsdRaw(client(), channel, body.xml || body.body || ''));
          }
          return fail(res, 405, '方法不允许');
        }
        case 'image': {
          const channel = Number(url.searchParams.get('channel')) || 1;
          if (method === 'GET') return json(res, 200, await getImageParams(client(), channel));
          if (method === 'PUT') {
            const body = await readJson(req);
            return json(res, 200, await setImageRaw(client(), channel, body.xml || body.body || ''));
          }
          return fail(res, 405, '方法不允许');
        }
        case 'upgrade': {
          if (method !== 'POST') return fail(res, 405, '方法不允许');
          const body = await readJson(req);
          if (!body.filePath) return fail(res, 400, '缺少 filePath');
          if (!fs.existsSync(body.filePath)) return fail(res, 400, `文件不存在: ${body.filePath}`);
          const task = tasks.create('upgrade', 1, { filePath: body.filePath });
          (async () => {
            try {
              await upgradeFirmware(client(), body.filePath, (sent, total) => {
                const percent = Math.round((sent / total) * 90);
                hub.broadcast('upgrade.progress', { taskId: task.taskId, id, percent, status: 'uploading' });
              });
              hub.broadcast('upgrade.progress', { taskId: task.taskId, id, percent: 95, status: 'installing' });
              const st = await waitUpgrade(client(), {
                onTick: (t) => hub.broadcast('upgrade.progress', { taskId: task.taskId, id, percent: Math.max(95, t.percent), status: t.status, description: t.description }),
              });
              const ok = !/fail|error/i.test(st.status);
              task.ok += ok ? 1 : 0; task.failed += ok ? 0 : 1;
              task.results.push({ id, state: ok ? 'ok' : 'failed', message: st.description || st.status, ms: 0 });
              task.state = 'done'; task.done = 1; task.finishedAt = Date.now();
              task.elapsedMs = task.finishedAt - task.startedAt;
              task.summary = { total: 1, ok: ok ? 1 : 0, failed: ok ? 0 : 1, elapsedMs: task.elapsedMs };
              hub.broadcast('upgrade.progress', { taskId: task.taskId, id, percent: 100, status: st.status });
              hub.broadcast('task.done', { taskId: task.taskId, summary: task.summary, state: 'done' });
            } catch (e) {
              task.state = 'failed'; task.done = 1; task.failed = 1;
              task.results.push({ id, state: 'failed', message: errMsg(e), ms: 0 });
              task.summary = { total: 1, ok: 0, failed: 1, error: errMsg(e) };
              hub.broadcast('task.done', { taskId: task.taskId, summary: task.summary, state: 'failed' });
            }
          })();
          return json(res, 200, { taskId: task.taskId });
        }
        default:
          return fail(res, 404, `未知接口: ${sub}`);
      }
    }

    /* ---- 设备后台（离线配置包，HiToolsDelivery「内置浏览器」的等价实现） ---- */
    if (seg[1] === 'console') {
      const ch = ctx.consoleHost;
      if (!ch) return json(res, 200, { running: false, error: '离线配置包服务未启动' });
      if (seg[2] === 'url') {
        const id = url.searchParams.get('device');
        if (!id) return fail(res, 400, '缺少 device');
        if (!store.get(id)) return fail(res, 404, '设备不在库中');
        return json(res, 200, { url: ch.urlFor(id), base: ch.landingUrl() });
      }
      return json(res, 200, {
        running: true,
        port: ch.port,
        base: ch.landingUrl(),
        packageRoot: ch.packageRoot,
        hasPackages: !!ch.packageRoot,
      });
    }

    /* ---- batch ---- */
    if (seg[1] === 'batch' && method === 'POST') {
      const body = await readJson(req);
      const ids = Array.isArray(body.deviceIds) ? body.deviceIds.filter((x) => store.get(x)) : [];
      if (!ids.length) return fail(res, 400, 'deviceIds 为空');
      let worker;
      try { worker = batchWorker(body.action, body.params); } catch (e) { return fail(res, 400, errMsg(e)); }
      const concurrency = clamp(Number(body.concurrency) || 16, 1, 64);
      const task = tasks.create(body.action, ids.length, { params: body.params || {}, concurrency });
      tasks.run(task, ids, worker, concurrency, (x) => x).catch(() => {});
      return json(res, 200, { taskId: task.taskId });
    }

    if (seg[1] === 'batch-upgrade' && method === 'POST') {
      const body = await readJson(req);
      if (!body.filePath || !fs.existsSync(body.filePath)) return fail(res, 400, '升级包不存在');
      const ids = (body.deviceIds || []).filter((x) => store.get(x));
      if (!ids.length) return fail(res, 400, 'deviceIds 为空');
      const task = tasks.create('upgrade', ids.length, { filePath: body.filePath });
      const worker = async (id) => {
        const client = store.client(id);
        await upgradeFirmware(client, body.filePath, (sent, total) => {
          hub.broadcast('upgrade.progress', { taskId: task.taskId, id, percent: Math.round((sent / total) * 90), status: 'uploading' });
        });
        const st = await waitUpgrade(client, {
          onTick: (t) => hub.broadcast('upgrade.progress', { taskId: task.taskId, id, percent: Math.max(95, t.percent), status: t.status }),
        });
        return { ok: !/fail|error/i.test(st.status), message: st.description || st.status };
      };
      tasks.run(task, ids, worker, clamp(Number(body.concurrency) || 4, 1, 16), (x) => x).catch(() => {});
      return json(res, 200, { taskId: task.taskId });
    }

    /* ---- report ---- */
    if (seg[1] === 'report' && method === 'POST') {
      const body = await readJson(req);
      const ids = (body.deviceIds && body.deviceIds.length ? body.deviceIds : store.list().map((d) => d.id))
        .filter((x) => store.get(x));
      if (!ids.length) return fail(res, 400, '没有可巡检的设备');
      try {
        const rows = await collectReport(store, ids);
        const out = writeReport(store.reportsDir, rows, body.format || 'csv', body.prefix || '巡检报表');
        return json(res, 200, { file: out.name, url: `/reports/${encodeURIComponent(out.name)}`, rows: rows.length, bytes: out.bytes });
      } catch (e) {
        return fail(res, 500, `生成报表失败：${errMsg(e)}`);
      }
    }

    /* ---- debug ---- */
    if (seg[1] === 'debug' && seg[2] === 'clients') {
      return json(res, 200, [...store.clients.entries()].map(([key, c]) => ({
        key, authMode: c.authMode, lastUsedAt: c.lastUsedAt,
        hasSession: !!c.session, log: c.log.slice(-20),
      })));
    }

    return fail(res, 404, `未知接口 ${p}`);
  }

  /* ------------------------------ static ------------------------------- */

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    let baseDir = webDir;
    if (rel.startsWith('/reports/')) {
      baseDir = store.reportsDir;
      rel = rel.slice('/reports'.length);
    }

    const target = path.normalize(path.join(baseDir, rel));
    if (!target.startsWith(path.normalize(baseDir))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(target, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        // no-store 而不是 no-cache：这是本机工具，缓存没有任何收益，
        // 但一旦浏览器缓存了坏版本（例如被中断的写入），页面会一直白屏。
        'Cache-Control': 'no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      });
      fs.createReadStream(target).pipe(res);
    });
  }

  /* ------------------------------ server ------------------------------- */

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        serveStatic(req, res, url);
      }
    } catch (e) {
      if (!res.headersSent) fail(res, 500, errMsg(e));
      else { try { res.end(); } catch { /* ignore */ } }
    }
  });

  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
  });

  return { server, store, hub, tasks, rootDir };
}