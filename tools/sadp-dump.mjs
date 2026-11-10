// SADP discovery that dumps the raw ProbeResponse (includes BootTime / uptime fields).
// Usage: node tools/sadp-dump.mjs [timeoutMs] [filterIp]
import { sadpDiscover } from '../src/sadp.js';

const timeoutMs = Number(process.argv[2]) || 4000;
const filter = process.argv[3] || '';

const res = await sadpDiscover({ timeoutMs });
console.log(`发现 ${res.found.length} 台设备，耗时 ${res.elapsedMs} ms`);
console.log('diagnostics:', JSON.stringify(res.diagnostics));

for (const d of res.found) {
  if (filter && d.ip !== filter) continue;
  console.log('\n════════════════════════════════');
  console.log(JSON.stringify({
    ip: d.ip, mac: d.mac, model: d.model, serialNumber: d.serialNumber,
    firmwareVersion: d.firmwareVersion, deviceType: d.deviceType,
    httpPort: d.httpPort, sdkPort: d.sdkPort, activated: d.activated,
    dhcpEnabled: d.dhcpEnabled, gateway: d.gateway, subnetMask: d.subnetMask,
    dnsServer: d.dnsServer, bootTime: d.bootTime, softwareVersion: d.softwareVersion,
    dspVersion: d.dspVersion, deviceDescription: d.deviceDescription,
  }, null, 2));
  if (d.raw) {
    console.log('--- 原始 ProbeResponse ---');
    console.log(d.raw.replace(/\r?\n\s*/g, '\n'));
  }
}