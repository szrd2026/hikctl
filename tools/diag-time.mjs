// Why does PUT /ISAPI/System/time get rejected? Dump the device's own document and
// try progressively more faithful payloads.
import { IsapiClient } from '../src/client.js';
import { parseXml, serializeXml, first, setText, xmlBody } from '../src/xml.js';

const ip = process.argv[2] || '192.168.1.64';
const port = Number(process.argv[3]) || 80;
const user = process.argv[4] || 'admin';
const pass = process.argv[5] || '1q2w3e4r';

const c = new IsapiClient({ ip, port, username: user, password: pass, timeoutMs: 12000 });
await c.login();

const got = await c.getText('/ISAPI/System/time');
console.log('=== 设备返回的原始 Time 文档 ===');
console.log(got.text);

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
const slash = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
console.log(`本机时间: ISO=${iso}  斜杠=${slash}`);

// candidate 1: minimal
const variants = [
  ['最小 XML（当前实现）',
    '<?xml version="1.0" encoding="UTF-8"?>\r\n<Time><timeMode>manual</timeMode><localTime>' + iso + '</localTime></Time>'],
  ['最小 XML + 斜杠格式',
    '<?xml version="1.0" encoding="UTF-8"?>\r\n<Time><timeMode>manual</timeMode><localTime>' + slash + '</localTime></Time>'],
];

// candidate 3+: GET the doc, patch it, PUT the whole thing back
try {
  const root = parseXml(got.text);
  const el = first(root, 'Time') || root;
  setText(el, 'timeMode', 'manual');
  setText(el, 'localTime', iso);
  variants.push(['GET→改→整份 PUT（ISO，单一声明）', xmlBody(root)]);

  const root2 = parseXml(got.text);
  const el2 = first(root2, 'Time') || root2;
  setText(el2, 'timeMode', 'manual');
  setText(el2, 'localTime', slash);
  variants.push(['GET→改→整份 PUT（斜杠，单一声明）', xmlBody(root2)]);

  // and the production code path itself
  const { setTimeManual } = await import('../src/ops.js');
  variants.push(['__prod__', null]);
} catch (e) {
  console.log('构造整份文档失败:', e.message);
}

for (const [name, body] of variants) {
  console.log(`\n──── ${name}`);
  if (body === null) {
    // exercise the real production helper
    const { setTimeManual } = await import('../src/ops.js');
    try {
      const r = await setTimeManual(c, null);
      console.log(`  setTimeManual() OK: ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`  setTimeManual() 失败: HTTP ${e.httpStatus} ${e.message}`);
    }
    continue;
  }
  console.log('  body: ' + body.replace(/\r?\n/g, ' '));
  try {
    const r = await c.putText('/ISAPI/System/time', body, { retries: 0 });
    console.log(`  HTTP ${r.status}  ${r.text.replace(/\s+/g, ' ').slice(0, 220)}`);
  } catch (e) {
    console.log(`  失败: HTTP ${e.httpStatus} ${e.message}`);
    if (e.body) console.log('  ' + String(e.body).replace(/\s+/g, ' ').slice(0, 260));
  }
  await new Promise((r) => setTimeout(r, 300));
}

const after = await c.getText('/ISAPI/System/time');
console.log('\n=== 最终设备时间 ===');
console.log(first(parseXml(after.text), 'Time') ? serializeXml(first(parseXml(after.text), 'Time')) : after.text);
c.close();