#!/usr/bin/env node
/**
 * 训练场验收（四条）
 *   ① 前端资源可达性 + 白名单防护
 *   ② 链路编排：示例链路端到端
 *   ③ SQL 控制台：写 SQL → 真的产生数据
 *   ④ ODPS/DataWorks 作业流程：项目节点 → 实例 + Logview → 调度/补数据
 * 用法：node scripts/verify_web.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSqlJs, Db } from '../src/lib/db.mjs';
import { VFS } from '../src/lib/vfs.mjs';
import { Warehouse } from '../src/lib/hive.mjs';
import { Pipeline } from '../src/lib/pipeline.mjs';
import { runStatement, listAllTables } from '../src/lib/console.mjs';
import { seedWarehouse, applySchemaDoc } from '../src/lib/scene.mjs';
import { defaultNodes, topoOrder, PROJECTS } from '../src/lib/project.mjs';
import { submit, cycleInstances, backfill } from '../src/lib/odps.mjs';
import '../src/lib/validators.mjs';
import { checkBrowserCompat } from './check_browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3300 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures += 1;
};

const loadCtx = async (scene) => {
  const SQL = await loadSqlJs((f) => path.join(ROOT, 'node_modules', 'sql.js', 'dist', f));
  const raw = new SQL.Database(fs.readFileSync(path.join(ROOT, 'data', scene, `${scene}.sqlite`)));
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', scene, 'schema.json'), 'utf8'));
  const vfs = new VFS();
  return applySchemaDoc({ db: new Db(raw), vfs, warehouse: new Warehouse(vfs), state: new Map() }, doc);
};

// ── ⓪ 浏览器兼容性（Node 测试抓不到的那一类）──
console.log('──── ⓪ 浏览器兼容性 ────');
{
  const { errors, files } = checkBrowserCompat({ log: () => {} });
  ok(errors.length === 0, `浏览器模块图 ${files} 个文件：无 Node 专有 API、导入名全部存在`,
    errors.map((e) => `${e.file}: ${e.msg}`).join(' | '));
}

// ── ① 前端资源 + 白名单 ──
const srv = spawn(process.execPath, [path.join(ROOT, 'scripts/serve.mjs'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

console.log('──── ① 前端资源可达性 ────');
const assets = [
  ['/', 'text/html'], ['/studio.js', 'text/javascript'],
  ['/sql-console.html', 'text/html'], ['/sql.js', 'text/javascript'],
  ['/pipeline.html', 'text/html'], ['/pipeline.js', 'text/javascript'],
  ['/src/lib/odps.mjs', 'text/javascript'], ['/src/lib/project.mjs', 'text/javascript'],
  ['/src/lib/console.mjs', 'text/javascript'], ['/src/lib/scene.mjs', 'text/javascript'],
  ['/src/lib/pipeline.mjs', 'text/javascript'], ['/src/lib/validators.mjs', 'text/javascript'],
  ['/src/lib/dialect.mjs', 'text/javascript'], ['/src/lib/vfs.mjs', 'text/javascript'],
  ['/src/lib/hive.mjs', 'text/javascript'], ['/src/lib/judge.mjs', 'text/javascript'], ['/src/lib/db.mjs', 'text/javascript'],
  ['/vendor/sql-wasm.js', 'text/javascript'], ['/vendor/sql-wasm.wasm', 'application/wasm'],
  ['/demos/power.json', 'application/json'], ['/demos/bank.json', 'application/json'],
  ['/data/power/power.sqlite', 'application/octet-stream'], ['/data/bank/bank.sqlite', 'application/octet-stream'],
  ['/data/power/schema.json', 'application/json'], ['/data/bank/schema.json', 'application/json'],
];
for (const [p, want] of assets) {
  const r = await fetch(BASE + p).catch(() => ({ status: 0, headers: new Map() }));
  const ct = (r.headers?.get?.('content-type') ?? '').split(';')[0];
  const size = Number(r.headers?.get?.('content-length') ?? 0);
  ok(r.status === 200 && ct === want, p, `${r.status} ${ct}${size ? ` ${(size / 1024).toFixed(0)}KB` : ''}`);
}
for (const [p, label] of [['/package.json', '工程文件'], ['/node_modules/sql.js/package.json', 'node_modules']]) {
  const r = await fetch(BASE + p);
  ok(r.status === 403, `白名单拦截 ${p}（不暴露${label}）`, String(r.status));
}

// ── ② 链路编排 ──
console.log('\n──── ② 链路编排：示例链路端到端 ────');
for (const scene of ['power', 'bank']) {
  const demo = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'demos', `${scene}.json`), 'utf8'));
  const ctx = await loadCtx(scene);
  const p = new Pipeline(ctx);
  for (const n of demo.nodes) p.add(n);
  const res = await p.run();
  const bad = res.nodes.filter((n) => n.status !== 'pass');
  ok(res.ok, `${scene}：${demo.name}`, `${res.nodes.length - bad.length}/${res.nodes.length} 节点通过`);
  for (const b of bad) console.log(`     ↳ ${b.id} [${b.stage}] ${b.errors.join(' | ')}`);
}

// ── ③ SQL 控制台 ──
console.log('\n──── ③ SQL 控制台：写 SQL → 真的产生数据 ────');
const CASES = {
  power: {
    select: 'SELECT status, COUNT(*) AS cnt FROM ods.customers GROUP BY status',
    countSrc: "SELECT COUNT(*) FROM meter_readings WHERE period='202403' AND read_type <> '估抄'",
    dwdTable: 'readings_di',
    ddl: `CREATE EXTERNAL TABLE dwd.readings_di (
  reading_id BIGINT COMMENT '抄表记录ID',
  meter_id BIGINT COMMENT '计量点ID',
  usage_kwh DOUBLE COMMENT '本期电量'
)
COMMENT '抄表明细DWD层'
PARTITIONED BY (dt STRING COMMENT '分区日期')
STORED AS PARQUET
LOCATION '/user/hive/warehouse/dwd.db/readings_di'`,
    write: `INSERT OVERWRITE TABLE dwd.readings_di PARTITION (dt='202403')
SELECT reading_id, meter_id, usage_kwh
FROM ods.meter_readings
WHERE dt = '202403' AND read_type <> '估抄'`,
    check: "SELECT COUNT(*) FROM dwd__readings_di WHERE dt='202403'",
  },
  bank: {
    select: 'SELECT status, COUNT(*) AS cnt FROM ods.transactions GROUP BY status',
    countSrc: "SELECT COUNT(*) FROM transactions WHERE txn_time>='2026-06-01' AND txn_time<'2026-07-01' AND status NOT IN ('冲正','失败')",
    dwdTable: 'transactions_di',
    ddl: `CREATE EXTERNAL TABLE dwd.transactions_di (
  txn_id BIGINT COMMENT '交易流水ID',
  account_id BIGINT COMMENT '账户ID',
  amount DOUBLE COMMENT '交易金额',
  status STRING COMMENT '状态'
)
PARTITIONED BY (dt STRING COMMENT '分区日期') STORED AS PARQUET
LOCATION '/user/hive/warehouse/dwd.db/transactions_di'`,
    write: `INSERT OVERWRITE TABLE dwd.transactions_di PARTITION (dt='202606')
SELECT txn_id, account_id, amount, status FROM ods.transactions
WHERE dt = '202606' AND status NOT IN ('冲正', '失败')`,
    check: "SELECT COUNT(*) FROM dwd__transactions_di WHERE dt='202606'",
  },
};
for (const [scene, c] of Object.entries(CASES)) {
  const ctx = await loadCtx(scene);
  const seed = seedWarehouse(ctx, scene);
  ok(seed.tables >= 4 && seed.rows > 0, `${scene}：ODS 层初始化`, `${seed.tables} 张表 / ${seed.rows.toLocaleString()} 行 / ${seed.partitions} 分区`);
  const r1 = runStatement(ctx, c.select);
  ok(r1.ok && r1.rowCount > 0, `${scene}：查询 ODS 层`, `${r1.rowCount} 行`);
  // 不变量：数仓表字段必须带中文注释（数据字典/表树靠它，不能只有英文列名）
  const odsCols = ctx.warehouse.list('ods').flatMap((t) => t.columns);
  const noComment = odsCols.filter((x) => !x.comment);
  ok(odsCols.length > 0 && noComment.length === 0, `${scene}：ODS 字段带中文注释`,
    `${odsCols.length} 个字段${noComment.length ? ` / 缺注释 ${noComment.map((x) => x.name).join(',')}` : ''}`);
  // 不变量：每张表都要有中文名 + 表含义（数据地图靠它）
  const groups = listAllTables(ctx);
  const allTables = Object.values(groups).flat();
  const noCn = allTables.filter((t) => !t.cn || !t.comment);
  ok(allTables.length > 0 && noCn.length === 0, `${scene}：每张表都有中文名与表含义`,
    `${allTables.length} 张表${noCn.length ? ` / 缺失：${noCn.map((t) => t.name).join(',')}` : ''}`);
  ok(runStatement(ctx, c.ddl).ok, `${scene}：CREATE EXTERNAL TABLE`);
  const srcN = ctx.db.query(c.countSrc).rows[0][0];
  const r3 = runStatement(ctx, c.write);
  ok(r3.ok && r3.write.rows === srcN, `${scene}：INSERT OVERWRITE 写入分区`, `${r3.write?.rows} 行 → ${r3.write?.table}`);
  ok(ctx.db.query(c.check).rows[0][0] === srcN, `${scene}：数据真的落库了`, `${srcN} 行`);
  const r4 = runStatement(ctx, "INSERT OVERWRITE TABLE dwd.not_exists PARTITION (dt='202401') SELECT 1");
  ok(!r4.ok && /不存在|建表/i.test(r4.error?.hint + r4.error?.message), `${scene}：写不存在的表被拦下并指路`);
}

// ── ④ ODPS / DataWorks 作业流程 ──
console.log('\n──── ④ ODPS 作业流程：项目节点 → 实例 → 调度 ────');
for (const scene of ['power', 'bank']) {
  const ctx = await loadCtx(scene);
  seedWarehouse(ctx, scene);
  const nodes = defaultNodes(scene);
  const order = topoOrder(nodes);
  ok(order.length === nodes.length, `${scene}：业务流程节点与依赖拓扑`, `${order.length} 个节点`);

  // 先跑 DWS（依赖 DWD 但没跑）→ 应该失败并指路
  const dws = nodes.find((n) => n.name.startsWith('dws_') && !n.name.endsWith('_ddl'));
  const early = runStatement(ctx, dws.code);
  ok(!early.ok, `${scene}：依赖顺序不对会失败（教学点）`, (early.error?.message ?? '').slice(0, 34));

  const insts = [];
  for (const n of order) insts.push(submit(ctx, n, { project: PROJECTS[scene].name }));
  const bad = insts.filter((i) => i.status !== 'SUCCESS');
  ok(bad.length === 0, `${scene}：按依赖跑全流程`, `${insts.length - bad.length}/${insts.length} 作业成功`);
  for (const b of bad) console.log(`     ↳ ${b.nodeName}: ${b.logs.filter((l) => l.level !== 'INFO').map((l) => l.msg).join(' | ')}`);

  const withId = insts.every((i) => i.logs.some((l) => l.msg.startsWith('InstanceId:')));
  ok(withId, `${scene}：每个作业都有 InstanceId`);
  const selNode = nodes.find((n) => n.code.includes('GROUP BY'));
  const selInst = submit(ctx, selNode, {});
  ok(selInst.planRows.length > 0, `${scene}：Logview 含真实执行计划`, `${selInst.planRows.length} 条：${(selInst.planRows[0] ?? '').slice(0, 28)}`);

  const writes = insts.filter((i) => i.output?.table && i.output.rows > 0);
  ok(writes.length >= 2, `${scene}：产出分区表`, writes.map((w) => `${w.output.table}=${w.output.rows}`).join(', '));
  ok(ctx.warehouse.lineage.length >= 2, `${scene}：血缘已记录`, `${ctx.warehouse.lineage.length} 条`);
  ok(ctx.vfs.findFiles('/user/hive/warehouse/dwd.db').length > 0
    && ctx.vfs.findFiles('/user/hive/warehouse/dws.db').length > 0, `${scene}：DWD/DWS 分区目录已生成`);

  const cyc = cycleInstances(nodes, { days: 3 });
  const st = cyc.reduce((a, i) => { a[i.status] = (a[i.status] ?? 0) + 1; return a; }, {});
  ok(cyc.length > 0 && (st.WAIT ?? 0) > 0 && (st.SUCCESS ?? 0) > 0,
    `${scene}：运维中心周期实例`, `${cyc.length} 个（成功 ${st.SUCCESS ?? 0} / 等待 ${st.WAIT ?? 0}）`);

  const end = new Date();
  const start = new Date(end.getTime() - 2 * 86400000);
  const bf = backfill(ctx, nodes.find((n) => n.name.startsWith('dwd_') && !n.name.endsWith('_ddl')), { start, end });
  ok(bf.length === 3 && bf.every((r) => r.status === 'SUCCESS'),
    `${scene}：补数据（换分区重跑）`, bf.map((r) => r.partition).join(', '));
}

srv.kill();

// ── ⑤ 题库自检（跑参考解 + 判题自洽 + 不放水）──
console.log('\n──── ⑤ 题库自检 ────');
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check_problems.mjs')], { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const passed = out.split('\n').filter((l) => l.startsWith('✅')).length;
  const failed = out.split('\n').filter((l) => l.startsWith('❌'));
  ok(r.status === 0, `题库 ${passed} 项自检通过（参考解可运行 / 判题自洽 / 错误解不放水）`,
    out.trim().split('\n').pop());
  failed.forEach((l) => console.log(`  ${l}`));
}

console.log(`\n${failures === 0 ? '🎉 全部验收通过' : `❌ ${failures} 项未通过`}`);
process.exit(failures === 0 ? 0 : 1);
