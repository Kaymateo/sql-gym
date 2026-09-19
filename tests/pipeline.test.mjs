/**
 * 链路引擎端到端测试
 * 运行：node --test tests/
 * 验证：真实电力库 → Sqoop 采集 → HDFS → Hive 建表 → DWD 加工 → 导出 → 调度
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSqlJs, Db } from '../src/lib/db.mjs';
import { VFS } from '../src/lib/vfs.mjs';
import { Warehouse } from '../src/lib/hive.mjs';
import { Pipeline } from '../src/lib/pipeline.mjs';
import '../src/lib/validators.mjs';   // 注册所有节点校验器
import { compareResults, R } from '../src/lib/judge.mjs';
import { validateCron, tokenize, parseFlags } from '../src/lib/validators.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE = path.join(ROOT, 'data', 'power', 'power.sqlite');
const SCHEMA = path.join(ROOT, 'data', 'power', 'schema.json');
const wasmLocate = (f) => path.join(ROOT, 'node_modules', 'sql.js', 'dist', f);

async function newCtx() {
  const SQL = await loadSqlJs(wasmLocate);
  const raw = new SQL.Database(fs.readFileSync(SQLITE));
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8')).tables;
  const vfs = new VFS();
  const warehouse = new Warehouse(vfs);
  return { db: new Db(raw), vfs, warehouse, schema, state: new Map() };
}

const ODS_SQL = `CREATE EXTERNAL TABLE ods.meter_readings (
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
)
COMMENT '计量点抄表电量ODS层'
PARTITIONED BY (dt STRING COMMENT '分区日期')
STORED AS PARQUET
LOCATION '/user/hive/warehouse/ods.db/meter_readings'`;

const DWD_DDL = `CREATE EXTERNAL TABLE dwd.readings_di (
  reading_id BIGINT COMMENT '抄表记录ID',
  meter_id BIGINT COMMENT '计量点ID',
  usage_kwh DOUBLE COMMENT '本期电量(已剔除估抄)'
)
PARTITIONED BY (dt STRING COMMENT '分区日期')
STORED AS PARQUET
LOCATION '/user/hive/warehouse/dwd.db/readings_di'`;

const SQOOP_IMPORT = `sqoop import \\
  --connect jdbc:mysql://localhost:3306/power \\
  --username root --password bigdata123 \\
  --table meter_readings \\
  --where "period = '202403'" \\
  --target-dir /user/hive/warehouse/ods.db/meter_readings/dt=202403 \\
  --split-by reading_id \\
  --num-mappers 4 \\
  --as-parquetfile`;

const DWD_INSERT = `INSERT OVERWRITE TABLE dwd.readings_di PARTITION (dt='202403')
SELECT reading_id, meter_id, usage_kwh
FROM ods.meter_readings
WHERE dt = '202403' AND read_type <> '估抄'`;

const EXPORT = `sqoop export \\
  --connect jdbc:mysql://localhost:3306/report \\
  --username root --password bigdata123 \\
  --table rpt_readings_di \\
  --export-dir /user/hive/warehouse/dwd.db/readings_di/dt=202403`;

const DAG = JSON.stringify({
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
}, null, 2);

test('① 数据可加载：电力库 15 张表、抄表数据非空', async () => {
  const ctx = await newCtx();
  const tables = ctx.db.tables();
  assert.ok(tables.length >= 15, `表数量=${tables.length}`);
  const n = ctx.db.rowCount('meter_readings');
  assert.ok(n > 1000, `meter_readings=${n}`);
  assert.ok(ctx.schema.meter_readings.length === 11);
  assert.ok(ctx.schema.meter_readings.every((c) => c.comment), '每个字段都要有中文注释');
});

test('② 完整链路：采集 → HDFS → ODS 表 → DWD 加工 → 导出 → 调度 全部通过', async () => {
  const ctx = await newCtx();
  const expSrcRows = ctx.db.query("SELECT COUNT(*) FROM meter_readings WHERE period='202403'").rows[0][0];
  const expDwdRows = ctx.db.query(
    "SELECT COUNT(*) FROM meter_readings WHERE period='202403' AND read_type <> '估抄'").rows[0][0];
  assert.ok(expSrcRows > 0 && expDwdRows > 0 && expDwdRows < expSrcRows, '估抄数据应被剔除');

  const p = new Pipeline(ctx);
  p.add({ id: 'n1', type: 'source_mysql', title: '业务库取数', code: "SELECT * FROM meter_readings WHERE period = '202403'" });
  p.add({ id: 'n2', type: 'sqoop_import', title: 'Sqoop 采集到 ODS', code: SQOOP_IMPORT, deps: ['n1'], expect: { rowsExact: expSrcRows } });
  p.add({ id: 'n3', type: 'hive_create_table', title: 'ODS 外部表', code: ODS_SQL, deps: ['n2'], expect: { hiveTable: 'ods.meter_readings', partitionKey: 'dt', format: 'parquet', locationMustExist: true } });
  p.add({ id: 'n4', type: 'hive_create_table', title: 'DWD 明细表', code: DWD_DDL, deps: ['n2'], expect: { hiveTable: 'dwd.readings_di' } });
  p.add({ id: 'n5', type: 'hive_sql', title: 'DWD 加工（剔除估抄）', code: DWD_INSERT, deps: ['n3', 'n4'], expect: { rowsExact: expDwdRows } });
  p.add({ id: 'n6', type: 'export_mysql', title: '回写报表库', code: EXPORT, deps: ['n5'], expect: { table: 'rpt_readings_di', rowsExact: expDwdRows } });
  p.add({ id: 'n7', type: 'dag_schedule', title: '每日 8 点调度', code: DAG, deps: ['n6'], expect: { taskCount: 5, cron: '0 8 * * *', deps: [['t1_source', 't2_sqoop'], ['t4_dwd', 't5_export']] } });

  const res = await p.run();
  const failed = res.nodes.filter((r) => r.status !== 'pass');
  assert.deepEqual(failed.map((f) => `${f.id}:${f.stage}:${f.errors[0]}`), [], '所有节点应通过');
  assert.equal(res.ok, true);
  assert.deepEqual(res.consistency, []);

  const byId = Object.fromEntries(res.nodes.map((r) => [r.id, r]));
  assert.equal(byId.n2.outputs[0].rows, expSrcRows);
  assert.equal(byId.n2.outputs[0].partCount, 4, '--num-mappers 4 → 4 个 part');
  assert.equal(byId.n2.outputs[0].format, 'parquet');
  assert.equal(byId.n5.outputs[0].rows, expDwdRows);

  // HDFS 上真的产出了文件（含 _SUCCESS）
  const files = ctx.vfs.findFiles('/user/hive/warehouse/ods.db/meter_readings/dt=202403');
  assert.equal(files.length, 5, `part 文件 + _SUCCESS = 5，实际 ${files.length}`);
  assert.ok(files.some((f) => f.path.endsWith('_SUCCESS')));
  assert.ok(ctx.vfs.isDir('/user/hive/warehouse/dwd.db/readings_di/dt=202403'));

  // Hive 元数据 & 分区挂载
  assert.ok(ctx.warehouse.has('ods', 'meter_readings'));
  assert.ok(ctx.warehouse.partitionsOf('ods', 'meter_readings').length >= 1, 'ODS 分区应自动挂载');
  const dwdPart = ctx.warehouse.partitionsOf('dwd', 'readings_di');
  assert.equal(dwdPart.length, 1);
  assert.equal(dwdPart[0].values.dt, '202403');

  // DWD 表数据真的落进了 sqlite 镜像
  const mirror = ctx.db.query("SELECT COUNT(*) FROM dwd__readings_di WHERE dt='202403'").rows[0][0];
  assert.equal(mirror, expDwdRows);

  // 血缘
  assert.ok(res.lineage.length >= 2, `血缘边数=${res.lineage.length}`);
  const upstream = ctx.warehouse.upstreamOf('dwd', 'readings_di');
  assert.ok(upstream.some((u) => u.table === 'meter_readings' || u.path), 'DWD 应能追溯到上游');
});

test('③ Sqoop 缺 --target-dir → lint 阶段拦下并给出格式提示', async () => {
  const ctx = await newCtx();
  const p = new Pipeline(ctx);
  p.add({ id: 'x', type: 'sqoop_import', code: "sqoop import --connect jdbc:mysql://h:3306/power --username root --table customers" });
  const res = await p.run();
  assert.equal(res.ok, false);
  const r = res.nodes[0];
  assert.equal(r.stage, 'lint');
  assert.ok(r.errors.some((e) => e.includes('--target-dir')), r.errors.join('|'));
  assert.ok(r.hint.includes('sqoop import --connect'), '应给出正确格式示例');
});

test('④ Sqoop 抽了不存在的表 → resolve 阶段报错并猜表名', async () => {
  const ctx = await newCtx();
  const p = new Pipeline(ctx);
  p.add({ id: 'x', type: 'sqoop_import', code: "sqoop import --connect jdbc:mysql://h:3306/power --username root --table custmers --target-dir /user/hive/warehouse/ods.db/x" });
  const res = await p.run();
  assert.equal(res.nodes[0].stage, 'resolve');
  assert.equal(res.nodes[0].code, 'TABLE_NOT_FOUND');
  assert.ok(res.nodes[0].hint.includes('customers'), `提示应猜到 customers：${res.nodes[0].hint}`);
});

test('⑤ Hive 表 LOCATION 与采集落盘目录不一致 → 报 LOCATION_NOT_FOUND', async () => {
  const ctx = await newCtx();
  const p = new Pipeline(ctx);
  p.add({ id: 'n2', type: 'sqoop_import', code: SQOOP_IMPORT });
  p.add({
    id: 'n3', type: 'hive_create_table', deps: ['n2'],
    code: ODS_SQL.replace("LOCATION '/user/hive/warehouse/ods.db/meter_readings'",
      "LOCATION '/user/hive/warehouse/ods.db/telemetry'"),
    expect: { locationMustExist: true },
  });
  const res = await p.run();
  const n3 = res.nodes.find((r) => r.id === 'n3');
  assert.equal(n3.stage, 'resolve');
  assert.equal(n3.code, 'LOCATION_NOT_FOUND');
  assert.ok(n3.hint.includes('target-dir'), n3.hint);
});

test('⑥ 业务库只读：写 DML 被 lint 拒绝；导出目录不存在被拦', async () => {
  const ctx = await newCtx();
  const p = new Pipeline(ctx);
  p.add({ id: 'a', type: 'source_mysql', code: 'DELETE FROM meter_readings WHERE 1=1' });
  const res = await p.run();
  assert.equal(res.nodes[0].stage, 'lint');
  assert.ok(res.nodes[0].errors.some((e) => e.includes('只读')));

  const ctx2 = await newCtx();
  const p2 = new Pipeline(ctx2);
  p2.add({
    id: 'b', type: 'export_mysql',
    code: 'sqoop export --connect jdbc:mysql://h:3306/report --username root --table t --export-dir /user/hive/warehouse/ads.db/nope/dt=202401',
  });
  const res2 = await p2.run();
  assert.equal(res2.nodes[0].code, 'EXPORT_DIR_MISSING');
});

test('⑦ 调度：cron 非法被拦、依赖环被拦', async () => {
  const ctx = await newCtx();
  const p = new Pipeline(ctx);
  p.add({
    id: 'd', type: 'dag_schedule',
    code: JSON.stringify({ dag: { name: 'x', schedule: '0 25 * * *', tasks: [{ id: 'a', type: 'hive_sql', deps: [] }] } }),
  });
  const res = await p.run();
  assert.equal(res.nodes[0].stage, 'lint');
  assert.ok(res.nodes[0].errors.some((e) => e.includes('小时')), res.nodes[0].errors.join('|'));

  const ctx2 = await newCtx();
  const p2 = new Pipeline(ctx2);
  p2.add({
    id: 'd', type: 'dag_schedule',
    code: JSON.stringify({
      dag: {
        name: 'cyclic', schedule: '0 8 * * *',
        tasks: [{ id: 'a', type: 'hive_sql', deps: ['b'] }, { id: 'b', type: 'hive_sql', deps: ['a'] }],
      },
    }),
  });
  const res2 = await p2.run();
  assert.ok(res2.nodes[0].errors.some((e) => e.includes('环')), res2.nodes[0].errors.join('|'));
});

test('⑧ 判题器：多解都判过（JOIN 版 vs 子查询版）', () => {
  const expected = {
    columns: ['customer_id', 'total'],
    rows: [[1, 100.5], [2, 88], [3, 0]],
    orderSensitive: false,
    precision: 2,
  };
  // 行序不同、整数写成浮点 → 应判过
  const a = { columns: ['cid', 'amt'], rows: [[3, 0.0], [1, 100.50], [2, 88]] };
  assert.equal(compareResults(a, expected).status, R.pass);

  // 列数不对
  const b = { columns: ['c'], rows: [[1], [2], [3]] };
  assert.equal(compareResults(b, expected).status, R.fail);
  assert.ok(compareResults(b, expected).message.includes('1 列'), compareResults(b, expected).message);
  assert.ok(compareResults(b, expected).message.includes('2 列'));

  // 行数不对
  const c = { columns: ['a', 'b'], rows: [[1, 100.5], [2, 88]] };
  assert.equal(compareResults(c, expected).status, R.fail);

  // 值不对 → close + 差异明细
  const d = { columns: ['a', 'b'], rows: [[1, 100.5], [2, 88], [3, 9]] };
  const r = compareResults(d, expected);
  assert.equal(r.status, R.close);
  assert.ok(r.diffs.length >= 1);
  assert.equal(r.diffs[0].column, 'total');
});

test('⑨ 工具函数：shell 分词 / flag 解析 / cron 校验', () => {
  const t = tokenize('sqoop import --connect "jdbc:mysql://a b/db" --table x \\\n  --num-mappers 4');
  assert.deepEqual(t.slice(0, 2), ['sqoop', 'import']);
  assert.ok(t.includes('jdbc:mysql://a b/db'));
  const args = parseFlags(t.slice(2));
  assert.equal(args.table, 'x');
  assert.equal(args['num-mappers'], '4');
  assert.equal(validateCron('0 8 * * *'), true);
  assert.throws(() => validateCron('0 8 * *'), /5 段/);
});
