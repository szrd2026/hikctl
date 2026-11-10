/**
 * Device store + client pool.
 *
 * Persistence is a single JSON file under ./data. Credentials are sealed with
 * AES-256-GCM using a key derived from this machine + user, so the file is not
 * trivially readable if copied elsewhere. (This is obfuscation, not a vault —
 * anything running as this user can decrypt it. Documented in README.)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { IsapiClient } from './client.js';
import { makeId } from './util.js';

const MAGIC = 'sealed:v1:';

function machineKey() {
  const seed = [
    'hikctl',
    os.hostname(),
    (os.userInfo && os.userInfo().username) || '',
    process.env.USERDOMAIN || '',
  ].join('|');
  return scryptSync(seed, 'hikctl-static-salt', 32);
}

export function seal(plain) {
  if (plain == null || plain === '') return '';
  const key = machineKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return MAGIC + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function unseal(sealed) {
  if (!sealed) return '';
  const s = String(sealed);
  if (!s.startsWith(MAGIC)) return s; // legacy / plaintext
  try {
    const buf = Buffer.from(s.slice(MAGIC.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const d = createDecipheriv('aes-256-gcm', machineKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export class Store {
  /**
   * @param {string} rootDir  程序根目录（web/ 所在位置）
   * @param {{dataDir?:string, reportsDir?:string}} [opts]
   *        dataDir 可指向别处，用于「演示配置」或多套设备库并存——
   *        这样跑 demo / 截图时不会碰到真实设备库。
   */
  constructor(rootDir, opts = {}) {
    this.dir = rootDir;
    this.dataDir = opts.dataDir ? path.resolve(opts.dataDir) : path.join(rootDir, 'data');
    this.file = path.join(this.dataDir, 'devices.json');
    this.reportsDir = opts.reportsDir
      ? path.resolve(opts.reportsDir)
      : (opts.dataDir ? path.join(this.dataDir, 'reports') : path.join(rootDir, 'reports'));
    this.devices = [];
    this.clients = new Map(); // key -> IsapiClient
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch { /* ignore */ }
    try {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    } catch { /* ignore */ }
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.devices)) this.devices = parsed.devices;
    } catch {
      this.devices = [];
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    const payload = JSON.stringify({ version: 1, savedAt: Date.now(), devices: this.devices }, null, 2);
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /* ------------------------------ CRUD ------------------------------- */

  list() { return this.devices; }

  get(id) { return this.devices.find((d) => d.id === id) || null; }

  /** Full record including the plaintext password (internal use only). */
  secret(device) {
    return { ...device, password: unseal(device.passwordSealed) };
  }

  /** Record safe to hand to the UI. */
  toPublic(device) {
    if (!device) return null;
    const { passwordSealed, ...rest } = device;
    return { ...rest, hasPassword: !!passwordSealed };
  }

  add({ ip, port = 80, https = false, username = 'admin', password = '', label = '', group = '默认分组' }) {
    const id = makeId(ip, port, https);
    const existing = this.get(id);
    const now = Date.now();
    if (existing) {
      existing.username = username || existing.username;
      if (password) existing.passwordSealed = seal(password);
      if (label) existing.label = label;
      if (group) existing.group = group;
      existing.updatedAt = now;
      this.save();
      this.dropClient(id);
      return existing;
    }
    const dev = {
      id, ip, port: Number(port), https: !!https,
      username, passwordSealed: seal(password),
      label: label || '', group: group || '默认分组',
      addedAt: now, updatedAt: now,
      status: null,
    };
    this.devices.push(dev);
    this.save();
    return dev;
  }

  update(id, patch) {
    const dev = this.get(id);
    if (!dev) return null;
    if (patch.label !== undefined) dev.label = patch.label;
    if (patch.group !== undefined) dev.group = patch.group;
    if (patch.username !== undefined) dev.username = patch.username;
    if (patch.password) dev.passwordSealed = seal(patch.password);
    if (patch.port !== undefined) dev.port = Number(patch.port);
    if (patch.https !== undefined) dev.https = !!patch.https;
    dev.updatedAt = Date.now();

    // If the address changed, the id must change too.
    if (patch.ip || patch.port !== undefined || patch.https !== undefined) {
      const newId = makeId(patch.ip || dev.ip, dev.port, dev.https);
      if (newId !== id) {
        dev.ip = patch.ip || dev.ip;
        dev.id = newId;
        this.dropClient(id);
      }
    }
    this.save();
    this.dropClient(dev.id);
    return dev;
  }

  remove(id) {
    const i = this.devices.findIndex((d) => d.id === id);
    if (i === -1) return false;
    this.dropClient(id);
    this.devices.splice(i, 1);
    this.save();
    return true;
  }

  setStatus(id, status) {
    const dev = this.get(id);
    if (!dev) return;
    dev.status = status;
    // status is volatile: keep it out of the hot path of save() frequency by
    // persisting lazily (callers may call save() explicitly).
  }

  /* ---------------------------- clients ------------------------------ */

  /** Get (or create) a logged-in-capable client for a device id. */
  client(id, { timeoutMs } = {}) {
    const dev = this.get(id);
    if (!dev) return null;
    const secret = this.secret(dev);
    const key = `${secret.ip}:${secret.port}:${secret.https}:${secret.username}:${secret.password ? secret.password.length : 0}:${timeoutMs || ''}`;
    let c = this.clients.get(key);
    if (!c) {
      c = new IsapiClient({
        ip: secret.ip, port: secret.port, https: secret.https,
        username: secret.username, password: secret.password,
        timeoutMs: timeoutMs || 8000,
      });
      this.clients.set(key, c);
      this._pruneClients();
    }
    return c;
  }

  dropClient(id) {
    const dev = this.get(id);
    for (const [key, c] of this.clients) {
      if (!dev || key.startsWith(`${dev.ip}:${dev.port}:`)) {
        try { c.close(); } catch { /* ignore */ }
        this.clients.delete(key);
      }
    }
  }

  _pruneClients() {
    if (this.clients.size <= 128) return;
    const entries = [...this.clients.entries()].sort((a, b) => (a[1].lastUsedAt || 0) - (b[1].lastUsedAt || 0));
    const drop = entries.slice(0, entries.length - 128);
    for (const [key, c] of drop) {
      try { c.close(); } catch { /* ignore */ }
      this.clients.delete(key);
    }
  }

  closeAll() {
    for (const c of this.clients.values()) {
      try { c.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}