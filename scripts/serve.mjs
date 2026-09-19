#!/usr/bin/env node
/**
 * 训练场本地服务
 * ------------------------------------------------------------------
 * 只暴露白名单目录（/public /src /vendor /data /docs），避免把整个工程
 * （含 node_modules、脚本）暴露出去。
 * 用法：node scripts/serve.mjs [--port 3000]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 3000;

const ALLOW = ['public', 'src', 'vendor', 'data', 'docs'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.sqlite': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);

  if (rel === '/' || rel === '') rel = '/public/index.html';

  // 解析顺序：先 public/（前端根），再白名单根目录
  const seg = rel.split('/').filter(Boolean)[0];
  const candidates = [path.join(ROOT, 'public', rel)];
  if (ALLOW.includes(seg)) candidates.push(path.join(ROOT, rel));
  const file = candidates.find((f) => f.startsWith(ROOT) && fs.existsSync(f) && !fs.statSync(f).isDirectory());

  if (!file) {
    const allowed = ALLOW.includes(seg);
    res.writeHead(allowed ? 404 : 403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(allowed
      ? `404 未找到：${rel}`
      : `403 禁止访问：/${seg}（只允许 ${ALLOW.join('/ ')} 与前端静态资源）`);
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[sql-gym] 链路工作台已启动：http://localhost:${PORT}`);
  console.log(`          局域网访问：http://<本机IP>:${PORT}`);
});
