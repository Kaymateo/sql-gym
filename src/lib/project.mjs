/**
 * 项目空间 · 默认业务流程（DataStudio 打开就有的一套节点）
 * ------------------------------------------------------------------
 * 每个场景 = 一个项目空间，内含按数仓分层组织的节点（含调度依赖），
 * 用户可以像在 DataWorks 里一样：跑节点 → 看实例 → 看日志 → 查产出。
 */

const DDL = (t) => `-- 建表：一次性执行
CREATE EXTERNAL TABLE ${t.db}.${t.name} (
${t.cols.map((c) => `  ${c[0].padEnd(16)} ${c[1].padEnd(8)} COMMENT '${c[2]}'`).join(',\n')}
)
COMMENT '${t.comment}'
PARTITIONED BY (dt STRING COMMENT '业务日期分区')
STORED AS PARQUET
LOCATION '/user/hive/warehouse/${t.db}.db/${t.name}'`;

const NODES = {
  power: (p) => {
    const dwd = { db: 'dwd', name: 'readings_di', comment: '抄表明细DWD层',
      cols: [['reading_id', 'BIGINT', '抄表记录ID'], ['meter_id', 'BIGINT', '计量点ID'], ['usage_kwh', 'DOUBLE', '本期电量(已剔除估抄)']] };
    const dws = { db: 'dws', name: 'transformer_loss_1d', comment: '台区日线损DWS层',
      cols: [['transformer_id', 'BIGINT', '配变台区ID'], ['supply_kwh', 'DOUBLE', '供电量'], ['sale_kwh', 'DOUBLE', '售电量'], ['loss_rate', 'DOUBLE', '线损率(%)']] };
    return [
      {
        name: 'di_meter_readings_daily', folder: '数据集成', type: 'di',
        desc: '同步业务库抄表数据到 ODS（按账期分区）',
        code: `{
  "job": {
    "setting": { "speed": { "channel": 4 } },
    "content": [{
      "reader": { "name": "mysqlreader",
        "parameter": { "connection": [{ "table": ["meter_readings"] }],
          "column": ["reading_id","meter_id","read_date","period","read_type","usage_kwh"],
          "where": "period = '\${bizdate}'" } },
      "writer": { "name": "hdfswriter",
        "parameter": { "path": "/user/hive/warehouse/ods.db/meter_readings",
          "fileName": "dt=\${bizdate}", "fileType": "parquet" } }
    }]
  }
}`,
        meta: { reader: 'mysqlreader', writer: 'hdfswriter', sql: "SELECT * FROM meter_readings WHERE period='202403'" },
        schedule: { enabled: true, cycle: 'daily', cron: '0 1 * * *', deps: [] },
      },
      {
        name: 'ods_meter_readings_qc', folder: 'ODS层', type: 'odps_sql',
        desc: 'ODS 数据质量检查：统计各抄表方式占比',
        code: `-- 质量检查：估抄占比过高说明采集异常
SELECT read_type,
       COUNT(*) AS cnt,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
FROM ods.meter_readings
WHERE dt = '202403'
GROUP BY read_type
ORDER BY cnt DESC`,
        schedule: { enabled: true, cycle: 'daily', cron: '0 2 * * *', deps: ['di_meter_readings_daily'] },
      },
      {
        name: 'dwd_readings_di_ddl', folder: 'DWD层', type: 'odps_sql',
        desc: '建 DWD 抄表明细表（一次性）',
        code: DDL(dwd),
        schedule: { enabled: false, cycle: 'once', cron: '0 0 * * *', deps: [] },
      },
      {
        name: 'dwd_readings_di', folder: 'DWD层', type: 'odps_sql',
        desc: '清洗写入 DWD：剔除估抄电量',
        code: `INSERT OVERWRITE TABLE dwd.readings_di PARTITION (dt='202403')
SELECT reading_id, meter_id, usage_kwh
FROM ods.meter_readings
WHERE dt = '202403'
  AND read_type <> '估抄'`,
        schedule: { enabled: true, cycle: 'daily', cron: '0 3 * * *', deps: ['ods_meter_readings_qc', 'dwd_readings_di_ddl'] },
      },
      {
        name: 'dws_transformer_loss_1d_ddl', folder: 'DWS层', type: 'odps_sql',
        desc: '建台区线损汇总表（一次性）',
        code: DDL(dws),
        schedule: { enabled: false, cycle: 'once', cron: '0 0 * * *', deps: [] },
      },
      {
        name: 'dws_transformer_loss_1d', folder: 'DWS层', type: 'odps_sql',
        desc: '台区日线损率汇总（供电量-售电量）/供电量',
        code: `-- 线损率 =（供电量 - 售电量）/ 供电量 × 100%
-- 售电量来自台区内所有用户的抄见电量（销户用户当月有电量也要算）
INSERT OVERWRITE TABLE dws.transformer_loss_1d PARTITION (dt='202403')
SELECT s.transformer_id,
       ROUND(s.supply_kwh, 2) AS supply_kwh,
       ROUND(SUM(r.usage_kwh), 2) AS sale_kwh,
       ROUND((s.supply_kwh - SUM(r.usage_kwh)) / s.supply_kwh * 100, 2) AS loss_rate
FROM ods.transformer_supply s
JOIN ods.customers  c ON c.transformer_id = s.transformer_id
JOIN ods.meters     m ON m.customer_id   = c.customer_id
JOIN ods.meter_readings r ON r.meter_id  = m.meter_id
WHERE s.dt = '202403' AND r.dt = '202403'
GROUP BY s.transformer_id, s.supply_kwh`,
        schedule: { enabled: true, cycle: 'daily', cron: '0 4 * * *', deps: ['dwd_readings_di', 'dws_transformer_loss_1d_ddl'] },
      },
    ];
  },

  bank: (p) => {
    const dwd = { db: 'dwd', name: 'transactions_di', comment: '有效交易明细DWD层',
      cols: [['txn_id', 'BIGINT', '交易流水ID'], ['account_id', 'BIGINT', '账户ID'], ['direction', 'STRING', '借贷方向'], ['amount', 'DOUBLE', '交易金额'], ['status', 'STRING', '状态']] };
    const dws = { db: 'dws', name: 'branch_txn_1d', comment: '机构交易汇总DWS层',
      cols: [['branch_id', 'BIGINT', '机构ID'], ['txn_cnt', 'BIGINT', '交易笔数'], ['in_amt', 'DOUBLE', '贷记金额'], ['out_amt', 'DOUBLE', '借记金额']] };
    return [
      {
        name: 'di_transactions_daily', folder: '数据集成', type: 'di',
        desc: '同步业务库交易流水到 ODS（按月分区）',
        code: `{
  "job": {
    "setting": { "speed": { "channel": 8 } },
    "content": [{
      "reader": { "name": "mysqlreader",
        "parameter": { "connection": [{ "table": ["transactions"] }],
          "column": ["txn_id","account_id","txn_time","direction","amount","status"],
          "where": "txn_time >= '\${bizdate}'" } },
      "writer": { "name": "hdfswriter",
        "parameter": { "path": "/user/hive/warehouse/ods.db/transactions",
          "fileName": "dt=\${bizmonth}", "fileType": "parquet" } }
    }]
  }
}`,
        meta: { reader: 'mysqlreader', writer: 'hdfswriter', sql: "SELECT * FROM transactions WHERE txn_time >= '2026-06-01' AND txn_time < '2026-07-01'" },
        schedule: { enabled: true, cycle: 'daily', cron: '0 1 * * *', deps: [] },
      },
      {
        name: 'ods_transactions_qc', folder: 'ODS层', type: 'odps_sql',
        desc: 'ODS 质量检查：冲正/失败交易占比',
        code: `SELECT status, COUNT(*) AS cnt,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
FROM ods.transactions
WHERE dt = '202606'
GROUP BY status
ORDER BY cnt DESC`,
        schedule: { enabled: true, cycle: 'daily', cron: '0 2 * * *', deps: ['di_transactions_daily'] },
      },
      {
        name: 'dwd_transactions_di_ddl', folder: 'DWD层', type: 'odps_sql',
        desc: '建 DWD 有效交易明细表（一次性）',
        code: DDL(dwd),
        schedule: { enabled: false, cycle: 'once', cron: '0 0 * * *', deps: [] },
      },
      {
        name: 'dwd_transactions_di', folder: 'DWD层', type: 'odps_sql',
        desc: '清洗写入 DWD：剔除冲正/失败交易',
        code: `INSERT OVERWRITE TABLE dwd.transactions_di PARTITION (dt='202606')
SELECT txn_id, account_id, direction, amount, status
FROM ods.transactions
WHERE dt = '202606'
  AND status NOT IN ('冲正', '失败')`,
        schedule: { enabled: true, cycle: 'daily', cron: '0 3 * * *', deps: ['ods_transactions_qc', 'dwd_transactions_di_ddl'] },
      },
      {
        name: 'dws_branch_txn_1d_ddl', folder: 'DWS层', type: 'odps_sql',
        desc: '建机构交易汇总表（一次性）',
        code: DDL(dws),
        schedule: { enabled: false, cycle: 'once', cron: '0 0 * * *', deps: [] },
      },
      {
        name: 'dws_branch_txn_1d', folder: 'DWS层', type: 'odps_sql',
        desc: '按机构汇总交易笔数与借贷金额',
        code: `INSERT OVERWRITE TABLE dws.branch_txn_1d PARTITION (dt='202606')
SELECT a.branch_id,
       COUNT(*) AS txn_cnt,
       ROUND(SUM(CASE WHEN t.direction = 'C' THEN t.amount ELSE 0 END), 2) AS in_amt,
       ROUND(SUM(CASE WHEN t.direction = 'D' THEN t.amount ELSE 0 END), 2) AS out_amt
FROM dwd.transactions_di t
JOIN accounts a ON a.account_id = t.account_id
WHERE t.dt = '202606'
GROUP BY a.branch_id`,
        schedule: { enabled: true, cycle: 'daily', cron: '0 4 * * *', deps: ['dwd_transactions_di', 'dws_branch_txn_1d_ddl'] },
      },
    ];
  },
};

export const PROJECTS = {
  power: { name: 'power_dw_dev', label: '电力数仓开发', bizdate: '202403' },
  bank: { name: 'bank_dw_dev', label: '银行数仓开发', bizdate: '202606' },
};

export function defaultNodes(sceneKey) {
  return (NODES[sceneKey] ?? NODES.power)();
}

/** 按调度依赖做拓扑排序（跑整个业务流程用） */
export function topoOrder(nodes) {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const done = new Set();
  const out = [];
  const visit = (n, seen = new Set()) => {
    if (!n || done.has(n.name)) return;
    if (seen.has(n.name)) return;            // 有环时保护
    seen.add(n.name);
    for (const d of n.schedule?.deps ?? []) visit(byName.get(d), seen);
    done.add(n.name);
    out.push(n);
  };
  nodes.forEach((n) => visit(n));
  return out;
}
