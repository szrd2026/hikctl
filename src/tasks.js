/**
 * Async task registry + Server-Sent-Events hub.
 *
 * Every long operation (batch config, scan, probe-all, upgrade) runs as a task:
 * it gets an id, streams progress over SSE, and its per-device results stay
 * queryable via GET /api/tasks/:id.
 */
import { randomUUID } from 'node:crypto';
import { mapLimit } from './util.js';

export class EventHub {
  constructor() {
    this.clients = new Set();
    this.history = [];
  }

  add(res) {
    const client = { res, id: randomUUID() };
    this.clients.add(client);
    res.on('close', () => this.clients.delete(client));
    // replay a little history so a freshly opened UI is not blank
    for (const evt of this.history.slice(-30)) {
      try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* ignore */ }
    }
    return client;
  }

  broadcast(type, data) {
    const evt = { type, data, ts: Date.now() };
    this.history.push(evt);
    if (this.history.length > 300) this.history.splice(0, this.history.length - 300);
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const c of this.clients) {
      try { c.res.write(line); } catch { this.clients.delete(c); }
    }
    return evt;
  }

  get size() { return this.clients.size; }
}

export class TaskManager {
  constructor(hub, { keepFinished = 50 } = {}) {
    this.hub = hub;
    this.tasks = new Map();
    this.keepFinished = keepFinished;
  }

  create(action, total, meta = {}) {
    const task = {
      taskId: `t_${randomUUID().slice(0, 8)}`,
      action,
      state: 'running',
      total,
      done: 0,
      ok: 0,
      failed: 0,
      startedAt: Date.now(),
      finishedAt: null,
      elapsedMs: 0,
      results: [],
      summary: null,
      meta,
      cancelRequested: false,
    };
    this.tasks.set(task.taskId, task);
    this.hub.broadcast('task.start', {
      taskId: task.taskId, action, total, meta,
    });
    this._trim();
    return task;
  }

  get(id) { return this.tasks.get(id) || null; }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((t) => ({
        taskId: t.taskId, action: t.action, state: t.state,
        total: t.total, done: t.done, ok: t.ok, failed: t.failed,
        startedAt: t.startedAt, finishedAt: t.finishedAt, elapsedMs: t.elapsedMs,
        meta: t.meta,
      }));
  }

  cancel(id) {
    const t = this.get(id);
    if (!t) return false;
    t.cancelRequested = true;
    return true;
  }

  /**
   * Run `worker(item)` over items with bounded concurrency, streaming progress.
   * @param {object} task
   * @param {Array} items
   * @param {(item:any)=>Promise<any>} worker must resolve to { ok, message } or throw
   * @param {number} concurrency
   */
  async run(task, items, worker, concurrency = 16, keyOf = (x) => String(x)) {
    const t0 = Date.now();
    await mapLimit(items, concurrency, async (item) => {
      const key = keyOf(item);
      if (task.cancelRequested) {
        task.results.push({ id: key, state: 'skipped', message: '已取消', ms: 0 });
        task.done++;
        this.hub.broadcast('task.progress', { taskId: task.taskId, id: key, state: 'skipped', message: '已取消', ms: 0 });
        return;
      }
      const s0 = Date.now();
      let entry;
      try {
        const r = await worker(item);
        const ok = r && r.ok === false ? false : true;
        entry = {
          id: key,
          state: ok ? 'ok' : 'failed',
          message: (r && r.message) || (ok ? '完成' : '失败'),
          detail: r && r.detail ? r.detail : undefined,
          ms: Date.now() - s0,
        };
      } catch (e) {
        entry = { id: key, state: 'failed', message: e && e.message ? e.message : String(e), ms: Date.now() - s0 };
      }
      task.results.push(entry);
      task.done++;
      if (entry.state === 'ok') task.ok++; else if (entry.state === 'failed') task.failed++;
      this.hub.broadcast('task.progress', { taskId: task.taskId, ...entry });
    });

    task.state = task.cancelRequested ? 'cancelled' : 'done';
    task.finishedAt = Date.now();
    task.elapsedMs = Date.now() - t0;
    task.summary = {
      total: task.total, ok: task.ok, failed: task.failed,
      skipped: task.results.filter((r) => r.state === 'skipped').length,
      elapsedMs: task.elapsedMs,
    };
    this.hub.broadcast('task.done', { taskId: task.taskId, summary: task.summary, state: task.state });
    return task;
  }

  _trim() {
    const finished = [...this.tasks.values()]
      .filter((t) => t.state !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt);
    while (finished.length > this.keepFinished) {
      const t = finished.shift();
      this.tasks.delete(t.taskId);
    }
  }
}