// tools/staticcheck.mjs — 零依赖静态检查
// 1) ES 模块具名导入是否真的被源模块导出
// 2) 所有调用点标识符是否在文件内声明 / 已导入 / 属于浏览器全局
// 3) 顶层声明的函数清单（可审计）
// 用法: node tools/staticcheck.mjs web
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || '.');
const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

const GLOBALS = new Set(`window document console fetch EventSource WebSocket setTimeout clearTimeout setInterval
clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask JSON Object Array String Number Boolean
Math Date Map Set WeakMap WeakSet Promise Error TypeError RangeError RegExp URLSearchParams URL CSS localStorage
sessionStorage navigator location history AbortController AbortSignal isNaN isFinite parseInt parseFloat
encodeURIComponent decodeURIComponent TextDecoder TextEncoder Blob File FileReader FormData Intl structuredClone
Node Element HTMLElement CustomEvent Event KeyboardEvent MouseEvent Image Audio atob btoa crypto performance
getComputedStyle alert confirm prompt Symbol Reflect Proxy globalThis encodeURI decodeURI escape unescape
if for while switch catch return typeof new do else function await yield in of case delete void instanceof
MJPEG CSV XLSX HTTP HTTPS IP NTP RTSP SSE URL async await get set super constructor
String Number Boolean Array Object`.split(/\s+/).filter(Boolean));

/** 仅去除注释，保留字符串/模板/正则原文（用于提取 import/export） */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prev = '';
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; } out += src[i]; i++; }
      out += q; i++; prev = q; continue;
    }
    // 正则字面量：前一个有效字符不是 标识符/数字/)/] 时视为正则
    if (c === '/' && !/[\w$)\]]/.test(prev)) {
      out += c; i++;
      let cls = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { out += ch + (src[i + 1] || ''); i += 2; continue; }
        if (ch === '[') cls = true; else if (ch === ']') cls = false;
        else if (ch === '/' && !cls) break;
        else if (ch === '\n') break;
        out += ch; i++;
      }
      out += '/'; i++;
      while (i < n && /[a-z]/.test(src[i])) { out += src[i]; i++; }
      prev = '/'; continue;
    }
    out += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return out;
}

/** 字符串内容替换为占位（保留引号），用于调用点扫描 */
function maskStrings(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++; out += q + q;
      let depth = 0;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (q === '`' && code[i] === '$' && code[i + 1] === '{') {
          // 保留模板插值内的表达式
          let d2 = 1; i += 2; const start = i;
          while (i < n && d2 > 0) { if (code[i] === '{') d2++; else if (code[i] === '}') d2--; if (d2 > 0) i++; }
          out += ' ' + code.slice(start, i) + ' '; i++; continue;
        }
        if (code[i] === q && depth === 0) break;
        i++;
      }
      i++; continue;
    }
    out += c; i++;
  }
  return out;
}

const codeOf = new Map(), rawOf = new Map();
for (const f of files) {
  rawOf.set(f, readFileSync(join(dir, f), 'utf8'));
  codeOf.set(f, stripComments(rawOf.get(f)));
}

const declaredOf = new Map(), exportedOf = new Map(), importedOf = new Map();
const topFunctionsOf = new Map();

function addParams(set, raw) {
  const s = raw.replace(/\{[^}]*\}/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/=[^,]*/g, ' ');
  for (const p of s.split(',')) { const t = p.trim().replace(/\.\.\./, ''); if (/^[A-Za-z_$][\w$]*$/.test(t)) set.add(t); }
}

for (const f of files) {
  const code = codeOf.get(f);
  const decl = new Set(), exp = new Set(), imp = new Set(), topFns = [];
  const masked = maskStrings(code);

  for (const m of masked.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) { decl.add(m[1]); if (/^\s*function/.test(masked.slice(m.index))) topFns.push(m[1]); }
  for (const m of masked.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) decl.add(m[1]);
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) decl.add(m[1]);
  for (const m of masked.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) addParams(decl, m[1]);
  for (const m of masked.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) addParams(decl, m[1]);
  for (const m of masked.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) addParams(decl, m[1]);
  for (const m of masked.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(decl, m[1]);
  for (const m of masked.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) decl.add(m[1]);
  for (const m of masked.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) decl.add(m[1]);
  for (const m of masked.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) decl.add(m[1]);
  for (const m of masked.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s*\{([^}]*)\}/g)) addParams(decl, m[1]);

  for (const m of code.matchAll(/\bimport\s+([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) for (const p of named[1].split(',')) { const t = p.trim().split(/\s+as\s+/).pop().trim(); if (t) imp.add(t); }
    const rest = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(rest)) imp.add(rest);
  }
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) exp.add(m[1]);
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) exp.add(m[1]);
  for (const m of code.matchAll(/\bexport\s+class\s+([A-Za-z_$][\w$]*)/g)) exp.add(m[1]);
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) for (const p of m[1].split(',')) { const t = p.trim().split(/\s+as\s+/).shift().trim(); if (t) exp.add(t); }
  if (/\bexport\s+default\b/.test(code)) exp.add('default');

  declaredOf.set(f, decl); exportedOf.set(f, exp); importedOf.set(f, imp); topFunctionsOf.set(f, topFns);
}

const problems = [];
// 1) 导入一致性
for (const f of files) {
  for (const m of codeOf.get(f).matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["']\.\/([^"']+)["']/g)) {
    const target = m[2], exp = exportedOf.get(target);
    if (!exp) { problems.push(`${f}: 引用的模块 ./${target} 不存在`); continue; }
    for (const p of m[1].split(',')) {
      const t = p.trim().split(/\s+as\s+/).shift().trim();
      if (t && !exp.has(t)) problems.push(`${f}: 从 ./${target} 导入了不存在的导出 "${t}"`);
    }
  }
}

// 2) 调用点
const unresolvedByFile = new Map();
for (const f of files) {
  const masked = maskStrings(codeOf.get(f));
  const decl = declaredOf.get(f), imp = importedOf.get(f);
  const missing = new Map();
  for (const m of masked.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (decl.has(name) || imp.has(name) || GLOBALS.has(name)) continue;
    // 跳过对象取值器 get x(){} / set x(v){}
    if (/(^|[^.\w$])(get|set)\s+$/.test(masked.slice(Math.max(0, m.index - 12), m.index + m[1].length))) continue;
    missing.set(name, (missing.get(name) || 0) + 1);
  }
  unresolvedByFile.set(f, [...missing.entries()]);
  for (const [name, count] of missing) problems.push(`${f}: 未解析的调用 ${name}() ×${count}`);
}

// 3) fetch 路径清单
console.log('=== 1. 模块清单 ===');
for (const f of files) {
  console.log(`\n--- ${f} (${rawOf.get(f).length} bytes) ---`);
  console.log(`  import 绑定: ${[...importedOf.get(f)].sort().join(', ') || '(无)'}`);
  console.log(`  export 名称: ${[...exportedOf.get(f)].sort().join(', ') || '(无)'}`);
  console.log(`  顶层函数声明 (${topFunctionsOf.get(f).length}): ${topFunctionsOf.get(f).join(', ')}`);
  console.log(`  未解析调用: ${unresolvedByFile.get(f).length ? unresolvedByFile.get(f).map(([n, c]) => `${n}×${c}`).join(', ') : '无 ✓'}`);
}

console.log('\n=== 2. 运行时 URL 拼接（模板/字面量中的接口路径） ===');
for (const f of files) {
  const hits = new Set();
  for (const m of rawOf.get(f).matchAll(/['"`](\/api\/[^'"`$]*|\/reports\/[^'"`$]*)/g)) hits.add(m[1]);
  for (const m of rawOf.get(f).matchAll(/(['"`])\/api\/[^'"`]*\$\{[^}]*\}[^'"`]*\1/g)) hits.add(m[0]);
  if (hits.size) { console.log(`--- ${f}`); for (const h of [...hits].sort()) console.log('   ' + h); }
}

console.log(`\n=== 结论: ${problems.length ? problems.length + ' 个问题' : '全部通过 ✓'} ===`);
for (const p of problems) console.log('  ! ' + p);
process.exit(problems.length ? 1 : 0);