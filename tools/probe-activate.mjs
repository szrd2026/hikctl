// Read-only diagnostics for a device's activation state and challenge handshake.
// Changes NOTHING on the device. Usage: node tools/probe-activate.mjs <ip> [port]
import { getActivateStatus, fetchActivateChallenge } from '../src/activate.js';

const ip = process.argv[2] || '192.168.1.64';
const port = Number(process.argv[3]) || 80;

const status = await getActivateStatus(ip, { port });
console.log('=== /SDK/activateStatus ===');
console.log(JSON.stringify(status, null, 2));

if (status.reachable && !status.activated) {
  console.log('\n=== GetChallengeV3 握手（不改变设备状态） ===');
  const hs = await fetchActivateChallenge(ip, { port });
  console.log(JSON.stringify({
    ok: hs.ok,
    keyFormat: hs.keyFormat,
    challengeBytes: hs.challengeBytes,
    challengeHex: hs.challengeHex ? `${hs.challengeHex.slice(0, 16)}…(${hs.challengeHex.length} hex chars)` : undefined,
    error: hs.error,
    attempts: hs.attempts.map((a) => ({
      format: a.format, httpStatus: a.httpStatus, ok: a.ok,
      bytes: a.challengeBytes, error: a.error && String(a.error).slice(0, 160),
    })),
  }, null, 2));
} else if (status.activated) {
  console.log('\n设备已激活，无需握手。');
}