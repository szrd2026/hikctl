/**
 * Inspection reports: CSV (Excel-friendly, UTF-8 BOM) and a minimal but valid
 * XLSX produced by hand (no dependencies — a zip of XML parts).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { getNetwork, getTime, listUsers, probe } from './ops.js';
import { mapLimit, nowStamp } from './util.js';

/* ------------------------------- CRC32 ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

/* -------------------------------- ZIP ------------------------------- */

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/** Build a ZIP archive from [{name, data:Buffer}] using deflate. */
export function makeZip(entries) {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 flag
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* -------------------------------- XLSX ------------------------------ */

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** rows: array of arrays of (string|number) */
export function buildXlsx(rows, sheetName = '巡检报表') {
  const sheetRows = rows.map((row, r) => {
    const cells = row.map((v, c) => {
      const ref = `${colName(c)}${r + 1}`;
      if (typeof v === 'number' && Number.isFinite(v)) {
        return `<c r="${ref}"><v>${v}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${sheetRows}</sheetData></worksheet>`;

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${xmlEsc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '</Relationships>';

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

/* -------------------------------- CSV ------------------------------- */

export function buildCsv(rows) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

/* ---------------------------- data collection ----------------------- */

export const REPORT_COLUMNS = [
  ['序号', 'index'],
  ['名称', 'label'],
  ['IP', 'ip'],
  ['端口', 'port'],
  ['在线', 'online'],
  ['设备名称', 'deviceName'],
  ['型号', 'model'],
  ['序列号', 'serialNumber'],
  ['MAC', 'macAddress'],
  ['固件版本', 'firmwareVersion'],
  ['固件日期', 'firmwareReleasedDate'],
  ['设备类型', 'deviceType'],
  ['通道数', 'channelCount'],
  ['已激活', 'activated'],
  ['鉴权方式', 'authMode'],
  ['耗时(ms)', 'latencyMs'],
  ['IP地址', 'netIp'],
  ['子网掩码', 'netMask'],
  ['网关', 'netGateway'],
  ['DNS', 'netDns'],
  ['地址模式', 'netMode'],
  ['设备时间', 'deviceTime'],
  ['时区', 'timeZone'],
  ['对时方式', 'timeMode'],
  ['用户数', 'userCount'],
  ['用户名', 'userNames'],
  ['萤石云支持', 'ezvizSupported'],
  ['萤石云开启', 'ezvizEnabled'],
  ['萤石云绑定', 'ezvizBound'],
  ['萤石云绑定值', 'ezvizBindStatus'],
  ['绑定验证码', 'ezvizCode'],
  ['错误', 'error'],
  ['采集时间', 'collectedAt'],
];

/**
 * Probe devices and gather report rows.
 * @param {import('./store.js').Store} store
 * @param {string[]} ids
 * @param {(id:string, result:object)=>void} [onDevice]
 */
export async function collectReport(store, ids, onDevice) {
  const rows = [];
  let index = 0;

  const results = await mapLimit(ids, 12, async (id) => {
    const dev = store.get(id);
    if (!dev) return { id, online: false, error: '设备不存在' };
    const client = store.client(id);
    if (!client) return { id, online: false, error: '设备不存在' };

    const status = await probe(client, { deep: true });
    const row = { ...status, ip: dev.ip, port: dev.port, label: dev.label || '' };

    if (status.online) {
      try {
        const net = await getNetwork(client, 1);
        row.netIp = net.ip; row.netMask = net.mask; row.netGateway = net.gateway;
        row.netDns = net.dns; row.netMode = net.addressingType;
      } catch { /* optional */ }
      try {
        const t = await getTime(client);
        row.deviceTime = t.localTime; row.timeZone = t.timeZone; row.timeMode = t.timeMode;
      } catch { /* optional */ }
      try {
        const users = await listUsers(client);
        row.userCount = users.length;
        row.userNames = users.map((u) => u.userName).join(' / ');
      } catch { /* optional */ }
      if (status.ezviz) {
        row.ezvizSupported = status.ezviz.supported ? '是' : '否';
        row.ezvizEnabled = status.ezviz.enabled ? '是' : '否';
        row.ezvizBound = status.ezviz.supported ? (status.ezviz.bound ? '已绑定' : '未绑定') : '不支持';
        row.ezvizBindStatus = status.ezviz.registerStatus || status.ezviz.bindStatus || '';
        row.ezvizCode = status.ezviz.verificationCode || '';
      }
    }
    row.collectedAt = new Date().toLocaleString('zh-CN');
    return row;
  });

  for (const r of results) {
    const row = r.ok ? r.value : { ip: '', error: r.error && r.error.message };
    index += 1;
    row.index = index;
    rows.push(row);
    if (onDevice) {
      try { onDevice(row.ip || '', row); } catch { /* ignore */ }
    }
  }
  return rows;
}

export function rowsToMatrix(rows) {
  const header = REPORT_COLUMNS.map(([zh]) => zh);
  const body = rows.map((r) => REPORT_COLUMNS.map(([, key]) => {
    const v = r[key];
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? '是' : '否';
    return v;
  }));
  return [header, ...body];
}

export function writeReport(dir, rows, format = 'csv', prefix = '巡检') {
  fs.mkdirSync(dir, { recursive: true });
  const matrix = rowsToMatrix(rows);
  const stamp = nowStamp();
  if (String(format).toLowerCase() === 'xlsx') {
    const file = path.join(dir, `${prefix}_${stamp}.xlsx`);
    fs.writeFileSync(file, buildXlsx(matrix, prefix));
    return { file, name: path.basename(file), bytes: fs.statSync(file).size };
  }
  const file = path.join(dir, `${prefix}_${stamp}.csv`);
  const csv = buildCsv(matrix);
  fs.writeFileSync(file, csv, 'utf8');
  return { file, name: path.basename(file), bytes: Buffer.byteLength(csv, 'utf8') };
}