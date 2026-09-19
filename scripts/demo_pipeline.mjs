#!/usr/bin/env node
/**
 * 链路演示：跑通「Sqoop 采集 → HDFS → ODS 表 → DWD 加工 → 数据质量 → 导出 → 调度」
 * 用法：node scripts/demo_pipeline.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSqlJs, Db } from '../src/lib/db.mjs';
import { VFS } from '../src/lib/vfs.mjs';
import { Warehouse } from '../src/lib/hive.mjs';
import { Pipeline } from '../src/lib/pipeline.mjs';
import '../src/lib/validators.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { r: '\u001b[31m', g: '\u001b[32m', y: '\u001b[33m', b: '\u001b[34m', d: '\u001b[2m', B: '\u001b[1m', x: '\u001b[0m' };

(async () => {
  console.log(`${C.B}╔══════════════════════════════════════════════════════════════╗${C.x}`);
  console.log(`${C.B}║  SQL 训练场 · 数据链路模拟执行                                ║${C.x}`);
  console.log(`${C.B}╚══════════════════════════════════════════════════════════════╝${C.x}`);

  let SQL;
  try {
    SQL = await loadSqlJs((f) => path.join(ROOT, 'node_modules', 'sql.js', 'dist', f));
  } catch (e) {
    console.error(`${C.r}❌ 需要先安装依赖：npm install sql.js${C.x}`);
    process.exit(1);
  }
  const raw = new SQL.Database(fs.readFileSync(path.join(ROOT, 'data/power/power.sqlite')));
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/power/schema.json'), 'utf8')).tables;
  const vfs = new VFS();
  const warehouse = new Warehouse(vfs);
  const ctx = { db: new Db(raw), vfs, warehouse, schema, state: new Map() };

  const expRows = ctx.db.query("SELECT COUNT(*) FROM meter_readings WHERE period='202403'").rows[0][0];
  const expDwd = ctx.db.query("SELECT COUNT(*) FROM meter_readings WHERE period='202403' AND read_type<>'估抄'").rows[0][0];
  console.log(`\n${C.d}业务库：meter_readings 共 ${ctx.db.rowCount('meter_readings')} 行；`
    + `202403 账期 ${expRows} 行（其中估抄 ${expRows - expDwd} 行）${C.x}\n`);

  const p = new Pipeline(ctx);
  p.add({
    id: 'n1', type: 'source_mysql', title: '① 业务库取数（MySQL）',
    code: "SELECT * FROM meter_readings WHERE period = '202403'",
    expect: { rowsExact: expRows },
  });
  p.add({
    id: 'n2', type: 'sqoop_import', title: '② Sqoop 采集 → HDFS',
    code: `sqoop import \\
  --connect jdbc:mysql://localhost:3306/power \\
  --username root --password bigdata123 \\
  --table meter_readings \\
  --where "period = '202403'" \\
  --target-dir /user/hive/warehouse/ods.db/meter_readings/dt=202403 \\
  --split-by reading_id \\
  --num-mappers 4 \\
  --as-parquetfile`,
    deps: ['n1'], expect: { rowsExact: expRows, partCount: 4, format: 'parquet' },
  });
  p.add({
    id: 'n3', type: 'hive_create_table', title: '③ 建 ODS 外部表',
    code: `CREATE EXTERNAL TABLE ods.meter_readings (
  reading_id BIGINT COMMENT '抄表记录ID',
  meter_id BIGINT COMMENT '计量点ID',
  read_date STRING COMMENT '抄表日期',
  period STRING COMMENT '账期',
  read_type STRING COMMENT '抄表方式',
  prev_total_kwh DOUBLE COMMENT '上期表底',
  curr_total_kwh DOUBLE COMMENT '本期表底',
  usage_kwh DOUBLE COMMENT '本期电量',
  p_kwh DOUBLE COMMENT '有功电量',
  q_kwh DOUBLE COMMENT '无功电量',
  operator_id BIGINT COMMENT '抄表人'
) COMMENT '计量点抄表电量ODS层'
PARTITIONED BY (dt STRING COMMENT '分区日期')
STORED AS PARQUET
LOCATION '/user/hive/warehouse/ods.db/meter_readings'`,
    deps: ['n2'], expect: { hiveTable: 'ods.meter_readings', partitionKey: 'dt', locationMustExist: true },
  });
  p.add({
    id: 'n4', type: 'hive_create_table', title: '④ 建 DWD 明细表',
    code: `CREATE EXTERNAL TABLE dwd.readings_di (
  reading_id BIGINT COMMENT '抄表记录ID',
  meter_id BIGINT COMMENT '计量点ID',
  usage_kwh DOUBLE COMMENT '本期电量(已剔除估抄)'
) COMMENT '抄表明细DWD层'
PARTITIONED BY (dt STRING COMMENT '分区日期')
STORED AS PARQUET
LOCATION '/user/hive/warehouse/dwd.db/readings_di'`,
    deps: ['n2'], expect: { hiveTable: 'dwd.readings_di' },
  });
  p.add({
    id: 'n5', type: 'hive_sql', title: '⑤ Hive SQL 加工（剔除估抄）',
    code: `INSERT OVERWRITE TABLE dwd.readings_di PARTITION (dt='202403')
SELECT reading_id, meter_id, usage_kwh
FROM ods.meter_readings
WHERE dt = '202403' AND read_type <> '估抄'`,
    deps: ['n3', 'n4'], expect: { rowsExact: expDwd },
  });
  p.add({
    id: 'n6', type: 'data_quality', title: '⑥ 数据质量校验（电量为负=表底跳变）',
    code: "SELECT COUNT(*) FROM dwd.readings_di WHERE dt='202403' AND usage_kwh < 0",
    deps: ['n5'], expect: { rule: '电量不能为负', expectZero: true },
  });
  p.add({
    id: 'n7', type: 'export_mysql', title: '⑦ 回写报表库',
    code: `sqoop export \\
  --connect jdbc:mysql://localhost:3306/report \\
  --username root --password bigdata123 \\
  --table rpt_readings_di \\
  --export-dir /user/hive/warehouse/dwd.db/readings_di/dt=202403`,
    deps: ['n5'], expect: { table: 'rpt_readings_di', rowsExact: expDwd },
  });
  p.add({
    id: 'n8', type: 'dag_schedule', title: '⑧ 每日 08:00 调度编排',
    code: JSON.stringify({
      dag: {
        name: 'meter_readings_daily',
        schedule: '0 8 * * *',
        tasks: [
          { id: 't1_source', type: 'source_mysql', deps: [] },
          { id: 't2_sqoop', type: 'sqoop_import', deps: ['t1_source'] },
          { id: 't3_ods', type: 'hive_create_table', deps: ['t2_sqoop'] },
          { id: 't4_dwd', type: 'hive_sql', deps: ['t3_ods'] },
          { id: 't5_export', type: 'export_mysql', deps: ['t4_dwd'] },
        ],
      },
    }, null, 2),
    deps: ['n7'], expect: { taskCount: 5, cron: '0 8 * * *', deps: [['t1_source', 't2_sqoop'], ['t4_dwd', 't5_export']] },
  });

  const t0 = Date.now();
  const res = await p.run();
  const ms = Date.now() - t0;

  console.log(`${C.B}──── 逐节点执行结果 ────${C.x}`);
  for (const n of res.nodes) {
    const icon = n.status === 'pass' ? `${C.g}✅${C.x}` : n.status === 'close' ? `${C.y}🟡${C.x}` : `${C.r}❌${C.x}`;
    console.log(`\n${icon} ${C.B}${n.title}${C.x}  ${C.d}[${n.type} · ${n.status} · ${n.stage} · ${n.durationMs}ms]${C.x}`);
    for (const l of n.logs ?? []) console.log(`   ${C.d}·${C.x} ${l}`);
    for (const w of n.warnings ?? []) console.log(`   ${C.y}⚠${C.x}  ${w}`);
    for (const e of n.errors ?? []) console.log(`   ${C.r}✖${C.x}  ${e}`);
    if (n.hint) console.log(`   ${C.b}💡${C.x} ${n.hint}`);
    for (const o of n.outputs ?? []) {
      if (o.rows != null) console.log(`   ${C.d}产物：${o.rows} 行${o.partCount ? ` / ${o.partCount} 个 part` : ''}${o.targetDir ? ` → ${o.targetDir}` : ''}${o.hiveTable ? ` → ${o.hiveTable}` : ''}${C.x}`);
    }
  }

  console.log(`\n${C.B}──── HDFS 目录（模拟）────${C.x}`);
  for (const f of vfs.findFiles('/user/hive')) {
    console.log(`  ${C.d}${f.path}${C.x}  ${f.format ?? ''} ${f.rows != null ? `${f.rows} 行` : ''} ${f.size}B`);
  }

  console.log(`\n${C.B}──── Hive 数仓 ────${C.x}`);
  for (const t of warehouse.list()) {
    const parts = warehouse.partitionsOf(t.db, t.table);
    console.log(`  ${t.db}.${t.table}  ${C.d}${t.columns.length} 字段 / ${t.format} / ${t.location}${C.x}`
      + (parts.length ? `  ${C.g}分区: ${parts.map((x) => Object.entries(x.values).map(([k, v]) => `${k}=${v}`).join(',')).join(' | ')}${C.x}` : ''));
  }

  console.log(`\n${C.B}──── 数据血缘 ────${C.x}`);
  for (const e of res.lineage) {
    const fmt = (x) => (x?.table ? `${x.system ?? x.db}.${x.table}` : (x?.path ?? '?'));
    console.log(`  ${fmt(e.from)}  ${C.d}--[${e.kind}]-->${C.x}  ${fmt(e.to)}`);
  }

  console.log(`\n${C.B}──── 链路总判定 ────${C.x}`);
  const pass = res.nodes.filter((n) => n.status === 'pass').length;
  console.log(`  节点：${pass}/${res.nodes.length} 通过`);
  console.log(`  元数据 ↔ HDFS 一致性：${res.consistency.length === 0 ? `${C.g}通过${C.x}` : `${C.r}${res.consistency.join('; ')}${C.x}`}`);
  console.log(`  血缘边：${res.lineage.length}`);
  console.log(`  总耗时：${ms}ms`);
  console.log(`\n  ${res.ok ? `${C.g}${C.B}🎉 整条链路校验通过${C.x}` : `${C.r}${C.B}❌ 链路未通过${C.x}`}`);
})().catch((e) => {
  console.error(`${C.r}运行失败：${C.x}`, e);
  process.exit(1);
});
