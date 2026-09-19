#!/usr/bin/env node
/**
 * 浏览器兼容性检查（Node 测试抓不到的那一类 bug）
 * ------------------------------------------------------------------
 * 1. 从 public/*.js 出发，沿 import 关系遍历整个"浏览器模块图"
 * 2. 检查图内是否有 Node 专有 API（Buffer / process / __dirname / node: 内置模块 / require）
 * 3. 检查每个 import 的具名导入目标模块确实导出了该名字
 *    （无构建步骤的 ESM 下，写错导入名会直接在浏览器抛
 *     "does not provide an export named X"，页面白屏）
 *
 * 用法：node scripts/check_browser.mjs   （退出码非 0 表示有问题）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

/** Node 专有 API（浏览器里不存在） */
const FORBIDDEN = [
  { re: /\bBuffer\s*[.(]/, msg: 'Buffer 是 Node 专有全局，浏览器没有（用 TextEncoder / Uint8Array 替代）' },
  { re: /\bprocess\s*\./, msg: 'process 是 Node 专有全局（浏览器里没有；环境判断用 typeof window）' },
  { re: /\b__dirname\b|\b__filename\b/, msg: '__dirname/__filename 是 Node 专有' },
  { re: /\brequire\s*\(/, msg: 'require() 在浏览器 ESM 里不可用（改用 import）' },
  { re: /from\s*['"]node:/, msg: "不能导入 node: 内置模块（浏览器没有 fs/path/os）" },
];

const read = (p) => fs.readFileSync(p, 'utf8');

/** 解析模块里的 import 语句 → [{spec, names:[...]}] */
function parseImports(src) {
  const out = [];
  const re = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+|([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const names = (m[2] ?? '')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    out.push({ spec: m[4], names });
  }
  // 副作用导入：import 'x'
  const side = /import\s*['"]([^'"]+)['"]/g;
  while ((m = side.exec(src))) out.push({ spec: m[1], names: [] });
  return out;
}

/** 解析模块导出的名字 */
function parseExports(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(',')) {
      const n = piece.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  return names;
}

/** 把 import 说明符解析成工程内的绝对路径；外部模块返回 null */
function resolveSpec(spec, fromFile) {
  if (spec.startsWith('/src/') || spec.startsWith('/public/')) return path.join(ROOT, spec);
  if (spec.startsWith('./') || spec.startsWith('../')) return path.resolve(path.dirname(fromFile), spec);
  return null;                     // 裸模块名（如 'sql.js'）：运行时才解析，跳过
}

export function checkBrowserCompat({ log = console.log } = {}) {
  const errors = [];
  const visited = new Set();
  const queue = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js')).map((f) => path.join(PUBLIC, f));

  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file) || !fs.existsSync(file)) continue;
    visited.add(file);
    const src = read(file);
    const rel = path.relative(ROOT, file);

    // ① Node 专有 API
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      for (const f of FORBIDDEN) {
        if (f.re.test(code)) errors.push({ file: rel, line: i + 1, msg: f.msg, code: line.trim().slice(0, 80) });
      }
    });

    // ② 具名导入是否存在
    for (const imp of parseImports(src)) {
      const target = resolveSpec(imp.spec, file);
      if (!target) continue;
      if (!fs.existsSync(target)) {
        errors.push({ file: rel, msg: `导入的文件不存在：${imp.spec}` });
        continue;
      }
      queue.push(target);
      if (!imp.names.length) continue;
      const exported = parseExports(read(target));
      for (const n of imp.names) {
        if (!exported.has(n)) {
          errors.push({ file: rel, msg: `导入名不存在：${n} 未被 ${path.relative(ROOT, target)} 导出（浏览器会白屏）` });
        }
      }
    }
  }

  log(`  扫描浏览器模块图：${visited.size} 个文件`);
  for (const e of errors) {
    log(`  ❌ ${e.file}${e.line ? `:${e.line}` : ''} — ${e.msg}${e.code ? `\n       ${e.code}` : ''}`);
  }
  return { errors, files: visited.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('──── 浏览器兼容性检查 ────');
  const { errors, files } = checkBrowserCompat();
  console.log(errors.length === 0
    ? `✅ ${files} 个文件全部通过（无 Node 专有 API、导入名全部存在）`
    : `❌ ${errors.length} 处问题`);
  process.exit(errors.length ? 1 : 0);
}
