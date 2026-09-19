/**
 * 练习题库
 * ------------------------------------------------------------------
 * 判题方式：跑「参考解」得到期望结果集 → 与你的结果集比对（多解都算对）。
 * 所以每题只要 solution 能跑通，判题就是自洽的；scripts/check_problems.mjs 会逐题验证。
 *
 * kind:
 *   query —— 写 SELECT，比对结果集
 *   write —— 写 INSERT OVERWRITE / CREATE，校验产出表的行数
 */

export const PROBLEMS = {
  power: [
    {
      id: 'pw-01', level: 'L2', title: '按用户类别的电量汇总',
      points: ['多表JOIN', '分组聚合', '户均计算'],
      background: '营销部要按用户类别看用电结构，判断哪类用户是售电主力。',
      requirement: '统计 2024-03 账期（dt=202403）各用户类别的：用户数、总电量、户均电量（保留 2 位），按总电量降序。',
      expectedColumns: ['cust_type', 'cust_cnt', 'total_kwh', 'avg_kwh'],
      hints: [
        '电量在 ods.meter_readings，用户类别在 ods.customers，中间要经过 ods.meters 才能连起来（meter_id → customer_id）',
        '用户数要去重：同一个用户可能有多条账期记录，用 COUNT(DISTINCT ...)',
        '户均 = 总电量 / 用户数，注意用 ROUND(x, 2)',
      ],
      solution: `SELECT c.cust_type,
       COUNT(DISTINCT c.customer_id) AS cust_cnt,
       ROUND(SUM(r.usage_kwh), 1) AS total_kwh,
       ROUND(SUM(r.usage_kwh) / COUNT(DISTINCT c.customer_id), 2) AS avg_kwh
FROM ods.meter_readings r
JOIN ods.meters    m ON m.meter_id   = r.meter_id
JOIN ods.customers c ON c.customer_id = m.customer_id
WHERE r.dt = '202403'
GROUP BY c.cust_type
ORDER BY total_kwh DESC`,
    },
    {
      id: 'pw-02', level: 'L2', title: '台区线损率异常榜',
      points: ['多表JOIN', 'LEFT JOIN', '比率计算', '异常筛选'],
      background: '线损率 =（供电量 − 售电量）/ 供电量。线损率高于 10% 通常意味着窃电或计量故障，低于 0 则是数据异常（供电量小于售电量），两者都要去现场核查。',
      requirement: '统计 2024-03 各配变台区的线损率，输出：台区名称、供电量、售电量、线损率（% 保留 2 位）。只保留线损率 > 10% 或 < 0 的台区，按线损率降序。',
      expectedColumns: ['transformer_name', 'supply_kwh', 'sale_kwh', 'loss_rate'],
      hints: [
        '供电量在 ods.transformer_supply（台区总表），售电量 = 该台区所有用户抄见电量之和',
        '售电量要先按 transformer_id 聚合，再用 LEFT JOIN 挂到台区上（漏掉没有用户的台区）',
        '对比率做筛选，SQL 里不能直接用 SELECT 里的别名，要把表达式再写一遍或套一层子查询',
      ],
      solution: `SELECT t.transformer_name,
       ROUND(s.supply_kwh, 1) AS supply_kwh,
       ROUND(COALESCE(u.sale_kwh, 0), 1) AS sale_kwh,
       ROUND((s.supply_kwh - COALESCE(u.sale_kwh, 0)) / s.supply_kwh * 100, 2) AS loss_rate
FROM ods.transformer_supply s
JOIN ods.transformers t ON t.transformer_id = s.transformer_id
LEFT JOIN (
    SELECT c.transformer_id AS tid, SUM(r.usage_kwh) AS sale_kwh
    FROM ods.meter_readings r
    JOIN ods.meters    m ON m.meter_id    = r.meter_id
    JOIN ods.customers c ON c.customer_id = m.customer_id
    WHERE r.dt = '202403'
    GROUP BY c.transformer_id
) u ON u.tid = s.transformer_id
WHERE s.dt = '202403'
  AND s.supply_kwh > 0
  AND ((s.supply_kwh - COALESCE(u.sale_kwh, 0)) / s.supply_kwh > 0.10
       OR (s.supply_kwh - COALESCE(u.sale_kwh, 0)) < 0)
ORDER BY loss_rate DESC`,
    },
    {
      id: 'pw-03', level: 'L3', title: '估抄率监控（找出异常月份）',
      points: ['条件聚合', 'HAVING', '占比计算'],
      background: '估抄电量不是实测值，占比过高说明采集设备或抄表管理有问题。',
      requirement: '按账期统计总抄表条数与估抄条数、估抄率（% 保留 2 位），只保留估抄率 > 5% 的账期，按估抄率降序。',
      expectedColumns: ['period', 'total_cnt', 'est_cnt', 'est_pct'],
      hints: [
        '估抄条数用条件聚合：SUM(CASE WHEN read_type = \'估抄\' THEN 1 ELSE 0 END)',
        'HAVING 过滤分组后的结果（WHERE 不能过滤聚合值）',
        '账期字段在 ODS 里叫 dt',
      ],
      solution: `SELECT dt AS period,
       COUNT(*) AS total_cnt,
       SUM(CASE WHEN read_type = '估抄' THEN 1 ELSE 0 END) AS est_cnt,
       ROUND(100.0 * SUM(CASE WHEN read_type = '估抄' THEN 1 ELSE 0 END) / COUNT(*), 2) AS est_pct
FROM ods.meter_readings
GROUP BY dt
HAVING 100.0 * SUM(CASE WHEN read_type = '估抄' THEN 1 ELSE 0 END) / COUNT(*) > 5
ORDER BY est_pct DESC`,
    },
    {
      id: 'pw-04', level: 'L3', title: '用电量环比增长率 Top 20',
      points: ['CTE', '窗口函数LAG', '环比计算'],
      background: '找出用电量环比暴涨的用户，可能是新上产线，也可能是计量异常。',
      requirement: '按用户按月汇总电量，计算每个用户相邻账期的环比增长率（% 保留 2 位），输出环比增长率最高的 20 条记录（含用户ID、名称、账期、本期电量、上期电量、环比）。',
      expectedColumns: ['customer_id', 'cust_name', 'period', 'kwh', 'prev_kwh', 'mom_pct'],
      hints: [
        '先用 CTE 把「用户 × 账期」的电量聚合出来',
        '窗口函数 LAG(kwh) OVER (PARTITION BY customer_id ORDER BY period) 取上一期',
        '窗口函数不能写在 WHERE 里，要再套一层 CTE 过滤 prev_kwh IS NOT NULL',
      ],
      solution: `WITH e AS (
    SELECT c.customer_id, c.cust_name, r.dt AS period, SUM(r.usage_kwh) AS kwh
    FROM ods.meter_readings r
    JOIN ods.meters    m ON m.meter_id    = r.meter_id
    JOIN ods.customers c ON c.customer_id = m.customer_id
    GROUP BY c.customer_id, c.cust_name, r.dt
), g AS (
    SELECT customer_id, cust_name, period, kwh,
           LAG(kwh) OVER (PARTITION BY customer_id ORDER BY period) AS prev_kwh
    FROM e
)
SELECT customer_id, cust_name, period,
       ROUND(kwh, 1) AS kwh,
       ROUND(prev_kwh, 1) AS prev_kwh,
       ROUND((kwh - prev_kwh) / prev_kwh * 100, 2) AS mom_pct
FROM g
WHERE prev_kwh IS NOT NULL AND prev_kwh > 0
ORDER BY mom_pct DESC
LIMIT 20`,
    },
    {
      id: 'pw-05', level: 'L3', title: '连续 3 个月用电量下滑的用户',
      points: ['CTE', 'LAG多阶', '连续行为识别'],
      background: '连续下滑可能是停产、搬迁，需要客户经理回访。',
      requirement: '找出「连续 3 个账期用电量逐期下降」的记录，输出用户ID与出现下降的账期，按用户ID、账期升序。',
      expectedColumns: ['customer_id', 'period'],
      hints: [
        'LAG 可以带偏移量：LAG(kwh, 2) 取前两期',
        '要同时比较三期：kwh < 前一期的值 且 前一期的值 < 前两期的值',
        '先聚合到「用户 × 账期」再算，否则一条账期多条抄表记录会算错',
      ],
      solution: `WITH e AS (
    SELECT c.customer_id, r.dt AS period, SUM(r.usage_kwh) AS kwh
    FROM ods.meter_readings r
    JOIN ods.meters    m ON m.meter_id    = r.meter_id
    JOIN ods.customers c ON c.customer_id = m.customer_id
    GROUP BY c.customer_id, r.dt
), g AS (
    SELECT customer_id, period, kwh,
           LAG(kwh)    OVER (PARTITION BY customer_id ORDER BY period) AS p1,
           LAG(kwh, 2) OVER (PARTITION BY customer_id ORDER BY period) AS p2
    FROM e
)
SELECT customer_id, period
FROM g
WHERE p2 IS NOT NULL AND kwh < p1 AND p1 < p2
ORDER BY customer_id, period`,
    },
    {
      id: 'pw-06', level: 'L4', title: '每个台区用电量 Top 3 的台区冠军用户',
      points: ['窗口函数ROW_NUMBER', 'PARTITION BY', '分组排名'],
      background: '给每个台区挑出用电大户，用于大客户走访。',
      requirement: '先用 2024-03 电量按「台区 × 用户」汇总，再对每个台区按电量降序排名，输出台区ID、用户ID、用户名、电量（1 位小数）、台区内排名（1/2/3），按台区ID升序、排名升序。',
      expectedColumns: ['transformer_id', 'customer_id', 'cust_name', 'kwh', 'rn'],
      hints: [
        'ROW_NUMBER() OVER (PARTITION BY transformer_id ORDER BY kwh DESC) 生成组内排名',
        '同样不能在 WHERE 里直接用排名，外层再过滤 rn <= 3',
        '注意：用 RANK 还是 ROW_NUMBER？并列时行为不同——题目要「前 3 名」用 ROW_NUMBER',
      ],
      solution: `WITH u AS (
    SELECT c.transformer_id, c.customer_id, c.cust_name, SUM(r.usage_kwh) AS kwh
    FROM ods.meter_readings r
    JOIN ods.meters    m ON m.meter_id    = r.meter_id
    JOIN ods.customers c ON c.customer_id = m.customer_id
    WHERE r.dt = '202403'
    GROUP BY c.transformer_id, c.customer_id, c.cust_name
), rk AS (
    SELECT transformer_id, customer_id, cust_name, kwh,
           ROW_NUMBER() OVER (PARTITION BY transformer_id ORDER BY kwh DESC) AS rn
    FROM u
)
SELECT transformer_id, customer_id, cust_name, ROUND(kwh, 1) AS kwh, rn
FROM rk
WHERE rn <= 3
ORDER BY transformer_id, rn`,
    },
    {
      id: 'pw-07', level: 'L4', title: '96 点负荷曲线：峰谷电量与最大负荷',
      points: ['时序数据', '条件聚合', '时段划分'],
      background: '96 点负荷曲线每 15 分钟一个采样点（point_index 1–96）。峰时段：08:00–11:59 与 17:00–21:59；其余为谷/平时段。峰谷电量 = 该时段功率平均值（kW × 小时数）。',
      requirement: '用业务库的 load_curve_96（2024-06 全月数据），按计量点统计峰段电量(kWh)、谷平段电量(kWh)、最大负荷(kW)，输出负荷最大的前 10 个计量点，按最大负荷降序。峰/谷电量保留 1 位小数。',
      expectedColumns: ['meter_id', 'peak_kwh', 'flat_kwh', 'max_load_kw'],
      hints: [
        '每个点代表 15 分钟，所以每点电量 = p_kw × 0.25 小时',
        '小时 = (point_index - 1) / 4（整数除法），峰段判断：小时 BETWEEN 8 AND 11 OR BETWEEN 17 AND 21',
        '用条件聚合 SUM(CASE WHEN 峰段 THEN p_kw * 0.25 ELSE 0 END) 分开算两段',
      ],
      solution: `SELECT l.meter_id,
       ROUND(SUM(CASE WHEN (l.point_index - 1) / 4 BETWEEN 8 AND 11
                        OR (l.point_index - 1) / 4 BETWEEN 17 AND 21
                  THEN l.p_kw * 0.25 ELSE 0 END), 1) AS peak_kwh,
       ROUND(SUM(CASE WHEN (l.point_index - 1) / 4 BETWEEN 8 AND 11
                        OR (l.point_index - 1) / 4 BETWEEN 17 AND 21
                  THEN 0 ELSE l.p_kw * 0.25 END), 1) AS flat_kwh,
       ROUND(MAX(l.p_kw), 1) AS max_load_kw
FROM load_curve_96 l
GROUP BY l.meter_id
ORDER BY max_load_kw DESC
LIMIT 10`,
    },
    {
      id: 'pw-08', level: 'L4', title: '停电事件时长与重叠检测',
      points: ['日期时间计算', '自关联', '重叠区间'],
      background: '同一台区的停电事件不应该时间重叠（重叠说明重复录入），需要找出来。',
      requirement: '找出「同一台区存在时间重叠」的停电事件对，输出台区ID、事件A的ID与开始时间、事件B的ID与开始时间。每对只输出一次（a.outage_id < b.outage_id），按台区ID、A事件ID升序。',
      expectedColumns: ['transformer_id', 'outage_id_a', 'start_a', 'outage_id_b', 'start_b'],
      hints: [
        '重叠判定：a.start < b.end AND b.start < a.end',
        '自关联时用 a.outage_id < b.outage_id 避免同一对出现两次、也避免自己和自己比',
        '时间可以直接用字符串比较（YYYY-MM-DD HH:MM:SS 格式下字典序 = 时间序）',
      ],
      solution: `SELECT a.transformer_id,
       a.outage_id AS outage_id_a, a.start_time AS start_a,
       b.outage_id AS outage_id_b, b.start_time AS start_b
FROM outages a
JOIN outages b
  ON a.transformer_id = b.transformer_id
 AND a.outage_id < b.outage_id
 AND a.start_time < b.end_time
 AND b.start_time < a.end_time
ORDER BY a.transformer_id, a.outage_id`,
    },
    {
      id: 'pw-09', level: 'L3', title: '建 DWD 表并写入清洗后数据（写入题）',
      kind: 'write', points: ['建表', '分区', 'INSERT OVERWRITE', '数据清洗'],
      background: 'ODS 层保留原始数据，清洗动作放在 DWD 层。本题把「剔除估抄」后的抄表明细写入 DWD 分区。',
      requirement: `两步（可以分两次运行）：
① 建外部表 dwd.readings_di（reading_id、meter_id、usage_kwh 三列，分区键 dt），LOCATION 用 '/user/hive/warehouse/dwd.db/readings_di'
② 用 INSERT OVERWRITE 把 ods.meter_readings 中 dt='202403' 且 read_type 不是「估抄」的记录写入分区 dt='202403'`,
      expectedColumns: [],
      hints: [
        '建表语法：CREATE EXTERNAL TABLE 库.表 (字段 类型 COMMENT \'说明\', ...) COMMENT \'表说明\' PARTITIONED BY (dt STRING COMMENT \'分区日期\') STORED AS PARQUET LOCATION \'/user/hive/warehouse/dwd.db/readings_di\'',
        '写入语法：INSERT OVERWRITE TABLE dwd.readings_di PARTITION (dt=\'202403\') SELECT ... WHERE dt=\'202403\' AND read_type <> \'估抄\'',
        '输出列顺序要和建表的字段顺序一致',
      ],
      writeCheck: { table: 'dwd.readings_di', partition: { dt: '202403' }, ddlNode: 'dwd_readings_di_ddl',
        expectedCountSql: "SELECT COUNT(*) FROM ods.meter_readings WHERE dt='202403' AND read_type <> '估抄'" },
      solution: `INSERT OVERWRITE TABLE dwd.readings_di PARTITION (dt='202403')
SELECT reading_id, meter_id, usage_kwh
FROM ods.meter_readings
WHERE dt = '202403' AND read_type <> '估抄'`,
    },
  ],

  bank: [
    {
      id: 'bk-01', level: 'L2', title: '各账户类型的客户数与余额',
      points: ['多表JOIN', '分组聚合', '余额汇总'],
      background: '看存款结构：活期/定期/对公各占多少。',
      requirement: '统计各账户类型的账户数、客户数（去重）、总余额（万元，保留 2 位），按总余额降序。',
      expectedColumns: ['account_type', 'acct_cnt', 'cust_cnt', 'balance_wan'],
      hints: [
        '账户表 ods.accounts 里有 customer_id，客户数要 COUNT(DISTINCT customer_id)',
        '单位换算：元 → 万元 除以 10000',
        '同一个客户可能有多个同类型账户，注意去重口径',
      ],
      solution: `SELECT account_type,
       COUNT(*) AS acct_cnt,
       COUNT(DISTINCT customer_id) AS cust_cnt,
       ROUND(SUM(balance) / 10000, 2) AS balance_wan
FROM ods.accounts
GROUP BY account_type
ORDER BY balance_wan DESC`,
    },
    {
      id: 'bk-02', level: 'L2', title: '各机构交易笔数与借贷金额',
      points: ['多表JOIN', '条件聚合', '借贷方向'],
      background: 'direction = C 是贷记（资金流入账户），D 是借记（流出）。',
      requirement: '按机构统计 2026-06 的交易笔数、贷记总金额、借记总金额（元，保留 2 位），按交易笔数降序，只输出笔数 ≥ 50 的机构。',
      expectedColumns: ['branch_id', 'txn_cnt', 'in_amt', 'out_amt'],
      hints: [
        '交易在 ods.transactions，机构在 ods.accounts.branch_id，用 account_id 关联',
        '冲正/失败交易要剔除（status NOT IN (\'冲正\',\'失败\')），否则发生额虚高',
        '用 CASE WHEN direction = \'C\' THEN amount ELSE 0 END 分开累加',
      ],
      solution: `SELECT a.branch_id,
       COUNT(*) AS txn_cnt,
       ROUND(SUM(CASE WHEN t.direction = 'C' THEN t.amount ELSE 0 END), 2) AS in_amt,
       ROUND(SUM(CASE WHEN t.direction = 'D' THEN t.amount ELSE 0 END), 2) AS out_amt
FROM ods.transactions t
JOIN ods.accounts a ON a.account_id = t.account_id
WHERE t.dt = '202606' AND t.status NOT IN ('冲正', '失败')
GROUP BY a.branch_id
HAVING COUNT(*) >= 50
ORDER BY txn_cnt DESC`,
    },
    {
      id: 'bk-03', level: 'L3', title: '各渠道冲正率排名',
      points: ['条件聚合', '占比', 'HAVING'],
      background: '冲正率高说明该渠道的报文或对账有问题，需要科技部排查。',
      requirement: '按交易渠道统计总笔数、冲正失败笔数、异常率（% 保留 2 位），只保留异常率 > 1% 的渠道，按异常率降序。',
      expectedColumns: ['channel', 'total_cnt', 'bad_cnt', 'bad_pct'],
      hints: [
        '异常笔数 = status IN (\'冲正\',\'失败\')',
        '占比用 100.0 * SUM(CASE WHEN ...) / COUNT(*)（乘 100.0 才会得到小数，别用整数除）',
        'HAVING 过滤聚合结果',
      ],
      solution: `SELECT channel,
       COUNT(*) AS total_cnt,
       SUM(CASE WHEN status IN ('冲正', '失败') THEN 1 ELSE 0 END) AS bad_cnt,
       ROUND(100.0 * SUM(CASE WHEN status IN ('冲正', '失败') THEN 1 ELSE 0 END) / COUNT(*), 2) AS bad_pct
FROM ods.transactions
GROUP BY channel
HAVING 100.0 * SUM(CASE WHEN status IN ('冲正', '失败') THEN 1 ELSE 0 END) / COUNT(*) > 1
ORDER BY bad_pct DESC`,
    },
    {
      id: 'bk-04', level: 'L3', title: '各贷款类型不良率',
      points: ['LEFT JOIN', '五级分类', '比率', '口径陷阱'],
      background: '不良 = 五级分类中的「次级 + 可疑 + 损失」。不良率 = 不良余额 / 贷款总余额。注意：用 INNER JOIN 关联逾期表会丢掉「正常」类贷款，导致分母偏小、不良率虚高。',
      requirement: '按贷款类型统计贷款笔数、贷款总余额（万元）、不良余额（万元）、不良率（% 保留 2 位），按不良率降序。',
      expectedColumns: ['loan_type', 'loan_cnt', 'total_wan', 'npl_wan', 'npl_rate'],
      hints: [
        '贷款在 ods.loans，五级分类在 ods.overdue_records（按 loan_id 关联）',
        '必须用 LEFT JOIN：没有逾期记录的正常贷款也计入分母',
        '不良余额口径：SUM(CASE WHEN classification IN (\'次级\',\'可疑\',\'损失\') THEN overdue_amount ELSE 0 END)',
      ],
      solution: `SELECT l.loan_type,
       COUNT(DISTINCT l.loan_id) AS loan_cnt,
       ROUND(SUM(l.outstanding) / 10000, 2) AS total_wan,
       ROUND(SUM(CASE WHEN o.classification IN ('次级', '可疑', '损失')
                      THEN o.overdue_amount ELSE 0 END) / 10000, 2) AS npl_wan,
       ROUND(100.0 * SUM(CASE WHEN o.classification IN ('次级', '可疑', '损失')
                              THEN o.overdue_amount ELSE 0 END) / NULLIF(SUM(l.outstanding), 0), 2) AS npl_rate
FROM ods.loans l
LEFT JOIN ods.overdue_records o ON o.loan_id = l.loan_id
GROUP BY l.loan_type
ORDER BY npl_rate DESC`,
    },
    {
      id: 'bk-05', level: 'L3', title: '交易金额分箱分布',
      points: ['CASE分箱', '条件聚合', '分布分析'],
      background: '看交易金额分布，识别大额交易占比，用于反洗钱阈值设定。',
      requirement: '把 2026-06 的成功交易按金额分成 5 档：<1千、1千–1万、1万–10万、10万–100万、≥100万，输出每档的笔数、金额合计（万元，2 位）、笔数占比（% 2 位），按档位从小到大排列（用档位序号排序）。',
      expectedColumns: ['bucket_no', 'bucket_desc', 'cnt', 'amt_wan', 'cnt_pct'],
      hints: [
        '用 CASE WHEN amount < 1000 THEN 1 WHEN amount < 10000 THEN 2 ... ELSE 5 END 生成档位序号',
        '先在一个 CTE 里算出档位，外层再按档位 GROUP BY（避免把 CASE 写很多遍）',
        '占比用 100.0 * COUNT(*) / SUM(COUNT(*)) OVER ()，窗口函数可以直接算全局占比',
      ],
      solution: `WITH b AS (
    SELECT CASE WHEN amount < 1000    THEN 1
                WHEN amount < 10000   THEN 2
                WHEN amount < 100000  THEN 3
                WHEN amount < 1000000 THEN 4
                ELSE 5 END AS bucket_no,
           CASE WHEN amount < 1000    THEN '<1千'
                WHEN amount < 10000   THEN '1千-1万'
                WHEN amount < 100000  THEN '1万-10万'
                WHEN amount < 1000000 THEN '10万-100万'
                ELSE '>=100万' END AS bucket_desc,
           amount
    FROM ods.transactions
    WHERE dt = '202606' AND status = '成功'
)
SELECT bucket_no, bucket_desc,
       COUNT(*) AS cnt,
       ROUND(SUM(amount) / 10000, 2) AS amt_wan,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS cnt_pct
FROM b
GROUP BY bucket_no, bucket_desc
ORDER BY bucket_no`,
    },
    {
      id: 'bk-06', level: 'L4', title: '可疑取现识别（反洗钱规则）',
      points: ['自关联', '时间窗口', '金额相等', '反洗钱'],
      background: '反洗钱经典规则 R02：同一账户在 10 分钟内出现多笔「等额」取现，疑似拆分交易规避大额上报。',
      requirement: '找出同一账户 10 分钟内金额完全相同的取现交易对，输出账户ID、两笔交易ID、两笔交易时间、金额。每对只输出一次（a.txn_id < b.txn_id），按账户ID、交易时间升序，最多 50 条。',
      expectedColumns: ['account_id', 'txn_a', 'time_a', 'txn_b', 'time_b', 'amount'],
      hints: [
        '取现的 txn_type 是「取现」，且只要成功交易',
        '时间差用 julianday(b.txn_time) - julianday(a.txn_time)，单位是「天」，10 分钟 = 10.0/1440',
        '自关联条件：同账户 AND a.txn_id < b.txn_id AND 金额相等 AND 时间差在 0 到 10/1440 天之间',
      ],
      solution: `SELECT a.account_id,
       a.txn_id AS txn_a, a.txn_time AS time_a,
       b.txn_id AS txn_b, b.txn_time AS time_b,
       ROUND(a.amount, 2) AS amount
FROM ods.transactions a
JOIN ods.transactions b
  ON b.account_id = a.account_id
 AND b.txn_id > a.txn_id
 AND b.amount = a.amount
 AND b.txn_type = '取现' AND a.txn_type = '取现'
 AND b.status = '成功' AND a.status = '成功'
 AND julianday(b.txn_time) - julianday(a.txn_time) BETWEEN 0 AND (10.0 / 1440)
ORDER BY a.account_id, a.txn_time
LIMIT 50`,
    },
    {
      id: 'bk-07', level: 'L4', title: '各机构交易金额排名（并列处理）',
      points: ['RANK vs DENSE_RANK', '窗口函数', '并列语义'],
      background: '评优要用「并列同名次」的排名语义，而不是强制 1/2/3。',
      requirement: '按机构汇总 2026-06 的有效交易金额，输出机构ID、交易笔数、金额（万元 2 位）、金额降序排名。要求并列金额共享同一名次（1,1,3 形式）。',
      expectedColumns: ['branch_id', 'txn_cnt', 'amt_wan', 'rank_no'],
      hints: [
        'RANK() 是 1,1,3；DENSE_RANK() 是 1,1,2；ROW_NUMBER() 是 1,2,3（并列也不共享）',
        '题目要「1,1,3」形式 → 用 RANK()',
        '窗口函数要作用在聚合结果上，先 GROUP BY 再套一层 CTE 排名',
      ],
      solution: `WITH s AS (
    SELECT a.branch_id,
           COUNT(*) AS txn_cnt,
           SUM(t.amount) AS amt
    FROM ods.transactions t
    JOIN ods.accounts a ON a.account_id = t.account_id
    WHERE t.dt = '202606' AND t.status NOT IN ('冲正', '失败')
    GROUP BY a.branch_id
)
SELECT branch_id, txn_cnt, ROUND(amt / 10000, 2) AS amt_wan,
       RANK() OVER (ORDER BY amt DESC) AS rank_no
FROM s
ORDER BY rank_no, branch_id`,
    },
    {
      id: 'bk-08', level: 'L4', title: '每机构余额 Top 3 账户',
      points: ['ROW_NUMBER', 'PARTITION BY', '组内排名'],
      background: '客户经理要盯住各支行的头部账户，防止大额资金搬家。',
      requirement: '对每个机构按账户余额降序取前 3 个账户，输出机构ID、账户ID、余额（万元 2 位）、组内排名，按机构ID、排名升序。',
      expectedColumns: ['branch_id', 'account_id', 'balance_wan', 'rn'],
      hints: [
        'ROW_NUMBER() OVER (PARTITION BY branch_id ORDER BY balance DESC)',
        '组内排名不能直接写在 WHERE 里，要外层再过滤',
        '余额为 0 或负数的账户也算（题目没说剔除）',
      ],
      solution: `WITH r AS (
    SELECT branch_id, account_id, balance,
           ROW_NUMBER() OVER (PARTITION BY branch_id ORDER BY balance DESC) AS rn
    FROM ods.accounts
)
SELECT branch_id, account_id, ROUND(balance / 10000, 2) AS balance_wan, rn
FROM r
WHERE rn <= 3
ORDER BY branch_id, rn`,
    },
    {
      id: 'bk-09', level: 'L3', title: '建 DWD 表并写入有效交易（写入题）',
      kind: 'write', points: ['建表', '分区', 'INSERT OVERWRITE', '剔除冲正'],
      background: '冲正/失败交易不是真实发生额，必须在 DWD 层剔除，否则下游指标全部虚高。',
      requirement: `两步（可以分两次运行）：
① 建外部表 dwd.transactions_di（txn_id、account_id、direction、amount、status 五列，分区键 dt），LOCATION 用 '/user/hive/warehouse/dwd.db/transactions_di'
② 把 ods.transactions 中 dt='202606' 且 status 不是「冲正/失败」的记录写入分区 dt='202606'`,
      expectedColumns: [],
      hints: [
        '建表语句参考：CREATE EXTERNAL TABLE dwd.transactions_di (txn_id BIGINT COMMENT \'交易流水ID\', ...) PARTITIONED BY (dt STRING COMMENT \'分区日期\') STORED AS PARQUET LOCATION \'/user/hive/warehouse/dwd.db/transactions_di\'',
        '写入：INSERT OVERWRITE TABLE dwd.transactions_di PARTITION (dt=\'202606\') SELECT txn_id, account_id, direction, amount, status FROM ods.transactions WHERE dt=\'202606\' AND status NOT IN (\'冲正\',\'失败\')',
        '记得在表里给每个字段写 COMMENT——生产数仓没注释会被打回',
      ],
      writeCheck: { table: 'dwd.transactions_di', partition: { dt: '202606' }, ddlNode: 'dwd_transactions_di_ddl',
        expectedCountSql: "SELECT COUNT(*) FROM ods.transactions WHERE dt='202606' AND status NOT IN ('冲正','失败')" },
      solution: `INSERT OVERWRITE TABLE dwd.transactions_di PARTITION (dt='202606')
SELECT txn_id, account_id, direction, amount, status
FROM ods.transactions
WHERE dt = '202606' AND status NOT IN ('冲正', '失败')`,
    },
  ],
};

/** 演示用：一条"复杂 SQL"，打开就能跑（线损率 + 多层 CTE + 窗口函数） */
export const SHOWCASE_SQL = `-- 复杂示例：台区线损率全表体检（多层 CTE + 多表 JOIN + 窗口函数 + 异常打标）
-- 直接点「▶ 运行」看结果；这是 pw-02 的加强版，多了全市对比与排名
WITH supply AS (                          -- ① 台区总表供电量
    SELECT s.transformer_id, SUM(s.supply_kwh) AS supply_kwh
    FROM ods.transformer_supply s
    WHERE s.dt = '202403'
    GROUP BY s.transformer_id
),
sale AS (                                 -- ② 售电量：台区内所有用户抄见电量之和
    SELECT c.transformer_id, SUM(r.usage_kwh) AS sale_kwh, COUNT(DISTINCT c.customer_id) AS cust_cnt
    FROM ods.meter_readings r
    JOIN ods.meters    m ON m.meter_id    = r.meter_id
    JOIN ods.customers c ON c.customer_id = m.customer_id
    WHERE r.dt = '202403'
    GROUP BY c.transformer_id
),
loss AS (                                 -- ③ 计算线损率并打标
    SELECT t.transformer_id,
           t.transformer_name,
           t.capacity_kva,
           s.supply_kwh,
           COALESCE(l.sale_kwh, 0) AS sale_kwh,
           l.cust_cnt,
           ROUND((s.supply_kwh - COALESCE(l.sale_kwh, 0)) / s.supply_kwh * 100, 2) AS loss_rate,
           CASE WHEN s.supply_kwh < COALESCE(l.sale_kwh, 0) THEN '数据异常(线损为负)'
                WHEN (s.supply_kwh - COALESCE(l.sale_kwh, 0)) / s.supply_kwh > 0.10 THEN '高损(需现场核查)'
                WHEN (s.supply_kwh - COALESCE(l.sale_kwh, 0)) / s.supply_kwh > 0.07 THEN '偏高(关注)'
                ELSE '正常' END AS loss_flag
    FROM supply s
    JOIN ods.transformers t ON t.transformer_id = s.transformer_id
    LEFT JOIN sale l        ON l.transformer_id = s.transformer_id
    WHERE s.supply_kwh > 0
)
SELECT loss_flag,
       COUNT(*)                                             AS tr_cnt,
       ROUND(AVG(loss_rate), 2)                             AS avg_loss_rate,
       ROUND(MAX(loss_rate), 2)                             AS max_loss_rate,
       ROUND(SUM(supply_kwh), 0)                            AS total_supply,
       SUM(CASE WHEN loss_rate > 10 THEN 1 ELSE 0 END)      AS high_loss_cnt,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2)   AS tr_pct,
       RANK() OVER (ORDER BY AVG(loss_rate) DESC)           AS flag_rank
FROM loss
GROUP BY loss_flag
ORDER BY flag_rank`;
