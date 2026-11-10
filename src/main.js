#!/usr/bin/env node
/**
 * hikctl — 轻量海康设备管理工具
 *
 * 单进程、零依赖：仅使用 Node.js 内置模块。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';

import { createServer } from './server.js';
import { createConsole, detectPackageRoot, listPackages } from './console.js';
import { localIPv4List } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERSION = '1.0.0';

function parseArgs(argv) {
  const out = { port: 8787, open: true, host: '127.0.0.1', consolePort: 9099, packages: null, noConsole: false, dataDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || out.port;
    else if (a === '--no-open') out.open = false;
    else if (a === '--host') out.host = argv[++i] || out.host;
    else if (a === '--console-port') out.consolePort = Number(argv[++i]) || out.consolePort;
    else if (a === '--packages') out.packages = argv[++i] || null;
    else if (a === '--data') out.dataDir = argv[++i] || null;
    else if (a === '--no-console') out.noConsole = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
  }
  return out;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* the user can open the printed URL manually */ }
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`hikctl ${VERSION} — 轻量海康设备管理工具

用法:
  node src/main.js [选项]

选项:
  -p, --port <端口>      主服务端口（默认 8787，被占用时自动 +1）
      --host <地址>      监听地址（默认 127.0.0.1，仅本机可访问）
      --console-port <端口>  设备后台（离线配置包）端口（默认 9099）
      --packages <目录>  指定离线配置包目录（默认自动查找 HiToolsDelivery 的包）
      --data <目录>      指定设备库目录（默认 ./data；可用于多套配置/演示）
      --no-console       不启动设备后台服务
      --no-open          启动后不自动打开浏览器
  -v, --version          显示版本
  -h, --help             显示帮助

设备后台：把海康的离线 Web 配置包托管在本机，并把 /ISAPI/* 反向代理回设备，
         因此没有内置网页的摄像头也能打开"设备后台"。
`);
  process.exit(0);
}

if (args.version) {
  console.log(VERSION);
  process.exit(0);
}

const DATA_DIR = args.dataDir ? path.resolve(args.dataDir) : path.join(ROOT, 'data');

const ctx = {};
const { server, store, hub } = createServer({
  rootDir: ROOT, version: VERSION, ctx,
  dataDir: args.dataDir ? DATA_DIR : null,
});

/** 运行时状态文件：让「关闭」快捷方式知道服务在哪个端口、是哪个进程。 */
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
function writeRuntime(port, consolePort) {
  try {
    fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify({
      pid: process.pid,
      port,
      consolePort: consolePort || 0,
      startedAt: Date.now(),
      root: ROOT,
    }, null, 2), 'utf8');
  } catch { /* 非致命 */ }
}
function clearRuntime() {
  try { fs.rmSync(RUNTIME_FILE, { force: true }); } catch { /* ignore */ }
}

/* ---------------- 设备后台（离线配置包托管 + 反向代理） ---------------- */
let consoleHost = null;
if (!args.noConsole) {
  const packageRoot = detectPackageRoot([args.packages]);
  if (!packageRoot) {
    console.log('  [提示] 未找到离线配置包目录，设备后台将不可用。');
    console.log('         用 --packages <目录> 指定，或保持 HiToolsDelivery 安装在本机。');
  } else {
    const pkgs = listPackages(packageRoot);
    console.log(`  离线配置包 : ${pkgs.length} 个  (${packageRoot})`);
  }
  consoleHost = createConsole({
    store,
    packageRoot,
    host: args.host,
    port: args.consolePort,
    onLog: (m) => console.log(`  ${m}`),
  });
  ctx.consoleHost = consoleHost;
}

/**
 * 启动后的初始化。用 started 守卫保证只跑一次：
 * 端口重试路径下 server.listen 的回调可能被触发两次，重复初始化会打出两遍启动横幅，
 * 并让 consoleHost.listen() 被并发调用（表现为「设备后台：启动失败」但其实已经起来了）。
 */
let started = false;
async function onListening() {
  if (started) return;
  started = true;

  const actual = server.address().port;
  const url = `http://${args.host}:${actual}/`;
  const ifaces = localIPv4List(os);
  const bootMs = Math.round(process.uptime() * 1000);
  console.log('');
  console.log(`  hikctl ${VERSION}  已启动（${bootMs} ms）`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  界面地址 : ${url}`);
  console.log(`  数据目录 : ${store.dataDir}`);
  console.log(`  已存设备 : ${store.list().length} 台`);
  if (ifaces.length) {
    console.log(`  本机网段 : ${ifaces.map((i) => `${i.iface} ${i.address}`).join('  |  ')}`);
  }
  if (consoleHost) {
    try {
      await consoleHost.listen(args.consolePort);
      console.log(`  设备后台 : ${consoleHost.landingUrl()}`);
    } catch (e) {
      console.log(`  设备后台 : 启动失败 — ${e.message}`);
    }
  }
  writeRuntime(actual, consoleHost ? consoleHost.port : 0);
  console.log(`  ────────────────────────────────────────────`);
  console.log('  「关闭」快捷方式 / Ctrl+C 均可退出');
  console.log('');
  if (args.open) openBrowser(url);
}

let tries = 0;
function listen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < 12) {
      tries++;
      listen(port + 1);
      return;
    }
    console.error('启动失败:', err.message);
    process.exit(1);
  });
  server.listen(port, args.host, () => {
    onListening().catch((e) => {
      console.error('启动失败:', e && e.message);
      process.exit(1);
    });
  });
}
listen(args.port);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n正在退出…');
  clearRuntime();
  hub.broadcast('service.stopping', {});
  store.closeAll();
  if (consoleHost) consoleHost.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
// 供 POST /api/shutdown 调用
ctx.onShutdown = shutdown;
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', clearRuntime);
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));