#!/usr/bin/env node
/**
 * 题库自检（必须全绿，否则题库不可用）
 * ------------------------------------------------------------------
 * 对每道题：
 *   ① 参考解必须能跑通，且返回数据（否则题目无意义）
 *   ② 用参考解自己去判题 → 必须 pass（判题器自洽）
 *   ③ 用一个明显错误的 SQL 去判题 → 必须不 pass（判题器不放水）
 *   ④ 写入题：先跑建表节点，再跑参考解，产出表行数必须等于期望
 * 用法：node scripts/check_problems.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSqlJs, Db } from '../src/lib/db.mjs';
import { VFS } from '../src/lib/vfs.mjs';
import { Warehouse } from '../src/lib/hive.mjs';
import { seedWarehouse, applySchemaDoc } from '../src/lib/scene.mjs';
import { defaultNodes } from '../src/lib/project.mjs';
import { runStatement } from '../src/lib/console.mjs';
import { PROBLEMS, SHOWCASE_SQL } from '../src/lib/problems.mjs';
import { gradeProblem } from '../src/lib/grade.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!cond) bad += 1;
};

const newCtx = async (scene) => {
  const SQL = await loadSqlJs((f) => path.join(ROOT, 'node_modules', 'sql.js', 'dist', f));
  const raw = new SQL.Database(fs.readFileSync(path.join(ROOT, 'data', scene, `${scene}.sqlite`)));
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', scene, 'schema.json'), 'utf8'));
  const vfs = new VFS();
  const ctx = applySchemaDoc({ db: new Db(raw), vfs, warehouse: new Warehouse(vfs), state: new Map() }, doc);
  seedWarehouse(ctx, scene);
  return ctx;
};

console.log('──── 题库自检 ────');
for (const [scene, problems] of Object.entries(PROBLEMS)) {
  console.log(`\n===== ${scene}（${problems.length} 题）=====`);
  const ctx = await newCtx(scene);
  const ddlByName = new Map(defaultNodes(scene).map((n) => [n.name, n]));

  for (const p of problems) {
    const tag = `${p.id} [${p.level}] ${p.title}`;
    let rows = null;

    if (p.kind === 'write') {
      const ddl = ddlByName.get(p.writeCheck?.ddlNode);
      if (ddl) runStatement(ctx, ddl.code);              // 先建表，模拟真实流程
      const r = runStatement(ctx, p.solution);
      if (!r.ok) { ok(false, tag, `参考解失败：${r.error?.message}`); continue; }
      const g = gradeProblem(ctx, p, p.solution);
      rows = g.detail?.rows ?? 0;
      ok(g.status === 'pass' && rows > 0, tag, `写入 ${rows} 行`);
    } else {
      const r = runStatement(ctx, p.solution);
      if (!r.ok) { ok(false, tag, `参考解失败：${r.error?.message}`); continue; }
      rows = r.rowCount;
      const self = gradeProblem(ctx, p, p.solution);
      ok(self.status === 'pass' && rows > 0, tag, `${rows} 行 / ${p.expectedColumns?.length ?? 0} 列`);
      if (self.status !== 'pass') console.log(`     ↳ ${self.message} ${self.hint ?? ''}`);
    }

    // ③ 判题器不放水：明显错误的 SQL 必须判不过
    const wrong = p.kind === 'write'
      ? "INSERT OVERWRITE TABLE dwd.nope PARTITION (dt='202401') SELECT 1"
      : 'SELECT 1 AS only_one';
    const wg = gradeProblem(ctx, p, wrong);
    if (wg.status === 'pass') ok(false, `${tag} · 判题器放水检查`, '错误 SQL 被判通过');
  }
}

// ④ 演示 SQL 必须能跑通
console.log('\n===== 演示 SQL（打开即跑）=====');
{
  const ctx = await newCtx('power');
  const r = runStatement(ctx, SHOWCASE_SQL);
  ok(r.ok && r.rowCount > 0, 'SHOWCASE_SQL 可执行', r.ok ? `${r.rowCount} 行 / ${r.columns.length} 列` : r.error?.message);
  if (!r.ok) console.log(`     ↳ ${r.error?.message} ${r.error?.hint ?? ''}`);
}

console.log(`\n${bad === 0 ? '🎉 题库自检全部通过' : `❌ ${bad} 项未通过`}`);
process.exit(bad === 0 ? 0 : 1);
