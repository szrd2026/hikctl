/**
 * Live preview.
 *
 * Mode 1 (preferred): relay the device's own MJPEG stream
 *         `GET /ISAPI/Streaming/channels/<ch>/httpPreview`
 *         -> zero transcoding, lowest latency, straight into <img src>.
 * Mode 2 (fallback, always available): server-side snapshot polling
 *         `GET /ISAPI/Streaming/channels/<ch>/picture` re-framed as
 *         multipart/x-mixed-replace.
 *
 * Node built-ins only.
 */
import http from 'node:http';
import https from 'node:https';

import { snapshot } from './ops.js';

const BOUNDARY = 'hikctlframe';

/** Open a raw streaming request against the device, reusing the client's auth state. */
function deviceStream(client, path, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = client.https ? https : http;
    const req = lib.request({
      host: client.ip,
      port: client.port,
      method: 'GET',
      path,
      agent: client.agent,
      rejectUnauthorized: false,
      headers: {
        Accept: '*/*',
        Connection: 'keep-alive',
        ...client._authHeaders('GET', path),
      },
    }, (res) => {
      if ((res.statusCode || 0) >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      resolve({ req, res });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('预览连接超时')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Serve an MJPEG stream for a device.
 * @param {import('node:http').IncomingMessage} httpReq browser request
 * @param {import('node:http').ServerResponse} httpRes browser response
 * @param {import('./client.js').IsapiClient} client
 */
export async function serveMjpeg(httpReq, httpRes, client, { channel = 101, fps = 5 } = {}) {
  await client.login();

  // ---- Mode 1: device MJPEG ----
  const candidates = [
    `/ISAPI/Streaming/channels/${channel}/httpPreview`,
    `/Streaming/channels/${channel}/httpPreview`,
  ];
  for (const path of candidates) {
    try {
      const { req, res } = await deviceStream(client, path, { timeoutMs: 6000 });
      const ct = String(res.headers['content-type'] || '');
      if (/multipart|x-mixed-replace/i.test(ct)) {
        httpRes.writeHead(200, {
          'Content-Type': ct,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Connection: 'close',
          'X-Preview-Mode': 'device-mjpeg',
        });
        res.pipe(httpRes);
        const cleanup = () => { try { req.destroy(); } catch { /* ignore */ } try { res.destroy(); } catch { /* ignore */ } };
        httpRes.on('close', cleanup);
        res.on('error', cleanup);
        return;
      }
      res.resume();
      try { req.destroy(); } catch { /* ignore */ }
    } catch { /* try next candidate */ }
  }

  // ---- Mode 2: snapshot polling ----
  // Resolve the working snapshot channel up front so the header is accurate and
  // the first frame is not delayed (main stream 101 often answers 503 deviceBusy).
  let firstFrame = null;
  let usedChannel = channel;
  let firstError = null;
  try {
    firstFrame = await snapshot(client, { channel });
    usedChannel = firstFrame.channel;
  } catch (e) {
    firstError = e;
  }

  httpRes.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Connection: 'close',
    'X-Preview-Mode': 'snapshot-poll',
    'X-Preview-Channel': String(usedChannel),
  });

  const interval = Math.max(100, Math.round(1000 / Math.max(1, Math.min(25, Number(fps) || 5))));
  let closed = false;
  let timer = null;
  httpRes.on('close', () => { closed = true; if (timer) clearTimeout(timer); });

  const writeFrame = (buffer, contentType) => {
    httpRes.write(`--${BOUNDARY}\r\nContent-Type: ${contentType}\r\nContent-Length: ${buffer.length}\r\n\r\n`);
    httpRes.write(buffer);
    httpRes.write('\r\n');
  };

  if (firstFrame) writeFrame(firstFrame.buffer, firstFrame.contentType);
  else if (firstError) {
    httpRes.write(`--${BOUNDARY}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`);
    httpRes.write(`preview error: ${firstError.message}`);
    httpRes.write('\r\n');
  }

  const loop = async () => {
    if (closed) return;
    try {
      const { buffer, contentType, channel: ch } = await snapshot(client, { channel: usedChannel, timeoutMs: 6000 });
      usedChannel = ch;
      if (closed) return;
      writeFrame(buffer, contentType);
    } catch (e) {
      if (closed) return;
      httpRes.write(`--${BOUNDARY}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`);
      httpRes.write(`preview error: ${e.message}`);
      httpRes.write('\r\n');
    }
    if (!closed) timer = setTimeout(loop, interval);
  };
  if (firstFrame || firstError) loop();
}

/** One-shot snapshot for the detail drawer. */
export async function serveSnapshot(httpRes, client, { channel = 101 } = {}) {
  const { buffer, contentType } = await snapshot(client, { channel });
  httpRes.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  httpRes.end(buffer);
}

/** Build the RTSP URL used by external players / go2rtc. */
export function rtspUrl(device, channel = 101) {
  const user = encodeURIComponent(device.username || 'admin');
  const pass = encodeURIComponent(device.password || '');
  const cred = pass ? `${user}:${pass}@` : `${user}@`;
  return `rtsp://${cred}${device.ip}:554/Streaming/Channels/${channel}`;
}