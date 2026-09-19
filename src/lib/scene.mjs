/**
 * 场景定义与数仓初始化
 * ------------------------------------------------------------------
 * 每个场景有：
 *   business[]  业务库表（用户可以直接查）
 *   ods[]       ODS 层的初始化规则（模拟器把业务库落到数仓 ODS 分区）
 *   tasks[]     练手任务（题干 + 提示 + 参考解），给用户一个起点
 *
 * seedWarehouse() 让用户一打开就有"分层的数仓"可练：ODS 已就绪，你写 DWD/DWS/ADS。
 */

import { sqliteName, quoteIdent } from './db.mjs';

const HIVE_TYPE = (t) => {
  const s = String(t ?? '').toUpperCase();
  if (s.includes('INT')) return 'BIGINT';
  if (s.includes('REAL') || s.includes('FLOA') || s.includes('DOUB') || s.includes('NUM')) return 'DOUBLE';
  return 'STRING';
};

export const SCENES = {
  power: {
    label: '电力场景（电网营销 / 用电采集）',
    business: ['meter_readings', 'customers', 'transformer_supply', 'bills', 'meters', 'transformers', 'outages', 'work_orders'],
    ods: [
      { table: 'meter_readings', src: 'meter_readings', partition: 'period' },
      { table: 'transformer_supply', src: 'transformer_supply', partition: 'period' },
      { table: 'customers', src: 'customers', partition: null },
      { table: 'meters', src: 'meters', partition: null },
      { table: 'transformers', src: 'transformers', partition: null },
    ],
    tasks: [
      {
        level: 'L1',
        title: '看看有多少用户在运',
        body: '查 ods.customers，统计在运用户数与销户用户数，两列输出。',
        hint: 'SELECT status, COUNT(*) FROM ods.customers GROUP BY status',
      },
      {
        level: 'L2',
        title: '各类型的抄表电量合计',
        body: '从 ods.meter_readings 按用户类别统计总电量（需 JOIN ods.customers）。',
        hint: '先 JOIN 再 GROUP BY cust_type，注意 meter_readings 用 meter_id 关联 meters 再关联 customers',
      },
      {
        level: 'L2',
        title: '剔除估抄，建 DWD 明细表',
        body: '建 dwd.readings_di（reading_id, meter_id, usage_kwh + 分区 dt），把 2024-03 的抄表数据剔除「估抄」后写入 dt=\'202403\' 分区。',
        hint: "CREATE EXTERNAL TABLE dwd.readings_di (...) PARTITIONED BY (dt STRING) STORED AS PARQUET LOCATION '/user/hive/warehouse/dwd.db/readings_di'，再 INSERT OVERWRITE ... PARTITION(dt='202403')",
      },
      {
        level: 'L3',
        title: '台区月度线损率',
        body: '线损率 =（供电量 - 售电量）/ 供电量。用 ods.transformer_supply 的供电量和用户电量的售电量，算 2024-03 各台区线损率（% 保留 2 位），找出 > 10% 的异常台区。',
        hint: '售电量要 JOIN customers 聚合到台区；销户用户当月有电量的也要算进去',
      },
    ],
  },
  bank: {
    label: '银行场景（零售银行 / 信贷风控）',
    business: ['transactions', 'accounts', 'customers', 'loans', 'overdue_records', 'branches', 'card_statements', 'deposits_daily'],
    ods: [
      { table: 'transactions', src: 'transactions', partition: 'dt0' },
      { table: 'overdue_records', src: 'overdue_records', partition: null },
      { table: 'loans', src: 'loans', partition: null },
      { table: 'accounts', src: 'accounts', partition: null },
      { table: 'branches', src: 'branches', partition: null },
    ],
    tasks: [
      {
        level: 'L1',
        title: '各账户类型的开户数',
        body: '从 accounts 统计各账户类型的开户数与总余额。',
        hint: 'SELECT account_type, COUNT(*), SUM(balance) FROM accounts GROUP BY account_type',
      },
      {
        level: 'L2',
        title: '剔除冲正交易，建 DWD 明细表',
        body: "建 dwd.transactions_di，把 ods.transactions 中 status 不是「冲正/失败」的交易写入 dt='202606' 分区。",
        hint: "INSERT OVERWRITE TABLE dwd.transactions_di PARTITION (dt='202606') SELECT ... WHERE dt='202606' AND status NOT IN ('冲正','失败')",
      },
      {
        level: 'L3',
        title: '各机构不良率',
        body: '不良率 = 不良贷款余额 / 贷款总余额。不良 = 五级分类中的「次级 + 可疑 + 损失」。按机构统计（万元，保留 2 位）。',
        hint: '用 LEFT JOIN 关联 overdue_records，别用 INNER JOIN（会丢掉正常类，分母偏小）',
      },
      {
        level: 'L4',
        title: '可疑取现识别',
        body: '找出同一账户 10 分钟内多笔等额取现的可疑交易（反洗钱规则）。',
        hint: '自关联同账户，比较时间差（julianday）与金额相等',
      },
    ],
  },
};

/**
 * 把 schema.json 挂到 ctx 上（业务库字段结构 + 表中文名/表含义 + 字段中文名）
 * —— 所有构造 ctx 的地方都必须走这里，否则中文信息会漏（曾因此丢过字段注释和表含义）
 */
export function applySchemaDoc(ctx, doc) {
  ctx.schema = doc?.tables ?? {};
  ctx.tableComments = doc?.table_comments ?? {};
  return ctx;
}

/** dt0：把日期/时间字段转成 YYYYMM 分区值 */
function dtExpression(partition, cols) {
  if (partition === 'period') return 'period';
  if (partition === 'dt0') {
    const t = cols.includes('txn_time') ? 'txn_time' : cols[0];
    return `replace(substr(${t}, 1, 7), '-', '')`;
  }
  return null;
}

/**
 * 初始化 ODS 层：业务库表 → 数仓 ODS（分区目录 + 元数据 + 可查询镜像）
 * @returns {{tables:number, partitions:number, rows:number, logs:string[]}}
 */
export function seedWarehouse(ctx, sceneKey) {
  const spec = SCENES[sceneKey];
  if (!spec) throw new Error(`未知场景：${sceneKey}`);
  const logs = [];
  let partitions = 0;
  let rows = 0;

  for (const o of spec.ods) {
    if (!ctx.db.hasTable(o.src)) { logs.push(`跳过 ${o.src}（业务库中不存在）`); continue; }
    // 列顺序取 SQLite 反射（保证与 SELECT * 一致），中文注释从 schema.json 按字段名补上
    // —— 反射拿不到 comment，这里曾导致数仓表字段全丢注释
    const meta = new Map((ctx.schema?.[o.src] ?? []).map((c) => [c.name, c]));
    const cols = ctx.db.columnsOf(o.src).map((c) => ({
      name: c.name,
      type: c.type,
      comment: meta.get(c.name)?.comment ?? '',
      cn: meta.get(c.name)?.cn ?? '',
    }));
    const dExpr = dtExpression(o.partition, cols.map((c) => c.name));
    const partCols = dExpr ? [{ name: 'dt', type: 'string' }] : [];
    const table = o.table;
    const sName = sqliteName(`ods.${table}`);

    // 1) SQLite 镜像（Hive 查询用）
    ctx.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(sName)}`);
    ctx.db.exec(`CREATE TABLE ${quoteIdent(sName)} AS SELECT * FROM ${quoteIdent(o.src)} WHERE 1=0`);
    if (dExpr) ctx.db.exec(`ALTER TABLE ${quoteIdent(sName)} ADD COLUMN dt TEXT`);
    const sel = dExpr
      ? `SELECT *, CAST(${dExpr} AS TEXT) AS dt FROM ${quoteIdent(o.src)}`
      : `SELECT * FROM ${quoteIdent(o.src)}`;
    ctx.db.exec(`INSERT INTO ${quoteIdent(sName)} (${[...cols.map((c) => c.name), ...(dExpr ? ['dt'] : [])].map(quoteIdent).join(',')}) ${sel}`);
    const n = ctx.db.rowCount(sName);

    // 2) Hive 元数据 + HDFS 目录
    const location = `/user/hive/warehouse/ods.db/${table}`;
    ctx.warehouse.createTable({
      db: 'ods', table,
      comment: ctx.tableComments?.[table]?.desc ?? '',
      columns: cols.map((c) => ({ name: c.name, type: HIVE_TYPE(c.type), comment: c.comment, cn: c.cn })),
      partitionedBy: partCols, format: 'parquet', location, external: true,
    });
    ctx.vfs.mkdir(location);
    const groups = dExpr
      ? ctx.db.query(`SELECT dt, COUNT(*) FROM ${quoteIdent(sName)} GROUP BY dt ORDER BY dt`).rows
      : [[null, n]];
    for (const [dtv, cnt] of groups) {
      const dir = dtv ? `${location}/dt=${dtv}` : location;
      ctx.vfs.mkdir(dir);
      ctx.vfs.writeFile(`${dir}/part-00000`, `[parquet] ${cnt} rows`, { format: 'parquet', rows: cnt });
      if (dtv) {
        try { ctx.warehouse.addPartition('ods', table, { dt: String(dtv) }); partitions += 1; } catch { /* 忽略 */ }
      }
    }
    rows += n;
    logs.push(`ods.${table} 就绪：${n} 行${partCols.length ? ` / ${groups.length} 个分区` : ''}`);
  }

  return { tables: spec.ods.length, partitions, rows, logs };
}

/** 给前端的场景摘要（表 + 字段注释 + 行数） */
export function sceneSummary(ctx, sceneKey) {
  const spec = SCENES[sceneKey];
  const out = { business: [], ods: [] };
  for (const t of spec.business) {
    if (!ctx.db.hasTable(t)) continue;
    out.business.push({ name: t, rows: ctx.db.rowCount(t), columns: ctx.schema[t] ?? [] });
  }
  for (const t of ctx.warehouse.list('ods')) {
    out.ods.push({
      name: `ods.${t.table}`, rows: ctx.db.rowCount(sqliteName(`ods.${t.table}`)),
      columns: t.columns, partitionedBy: t.partitionColumns,
      partitions: ctx.warehouse.partitionsOf('ods', t.table).map((p) => p.values),
    });
  }
  return out;
}
