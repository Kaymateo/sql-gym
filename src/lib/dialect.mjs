/**
 * Hive / Spark SQL 方言层
 * ------------------------------------------------------------------
 * 训练场里的"数仓"用 SQLite 当执行引擎，但用户写的是 Hive 风格 SQL。
 * 本模块负责：把 Hive 语法翻译成 SQLite 能跑的 SQL，并识别
 * INSERT OVERWRITE ... PARTITION 这类"写数仓分区"的语句（交给 VFS 落地）。

 * 覆盖范围（V1）：常用函数 + INSERT OVERWRITE + PARTITION + 常见语法糖。
 * 明确不支持（会给出人话错误）：LATERAL VIEW explode、UDF、复杂数据类型。
 */

export class DialectError extends Error {}

/** 函数映射：Hive 名 → SQLite 表达式模板 */
const FN_MAP = {
  nvl: 'IFNULL',
  coalesce: 'COALESCE',
  ifnull: 'IFNULL',
  length: 'LENGTH',
  lower: 'LOWER',
  upper: 'UPPER',
  trim: 'TRIM',
  ltrim: 'LTRIM',
  rtrim: 'RTRIM',
  abs: 'ABS',
  round: 'ROUND',
  floor: 'FLOOR',
  ceil: 'CEIL',
  ceiling: 'CEIL',
  power: 'POWER',
  sqrt: 'SQRT',
  mod: 'MOD',
  max: 'MAX',
  min: 'MIN',
  sum: 'SUM',
  avg: 'AVG',
  count: 'COUNT',
  concat_ws: 'CONCAT_WS_SIM',
  instr: 'INSTR',
  replace: 'REPLACE',
  nullif: 'NULLIF',
};

/** 自定义函数 → SQLite 可用表达式（用字符串替换实现，足够教学用） */
function translateFunctions(sql) {
  let s = sql;

  // 简单改名：nvl( → IFNULL(  等
  for (const [hive, sqlite] of Object.entries(FN_MAP)) {
    if (sqlite.endsWith('_SIM')) continue;
    s = s.replace(new RegExp(`\\b${hive}\\s*\\(`, 'gi'), `${sqlite}(`);
  }

  // concat_ws(sep, a, b)  → a || sep || b（忽略 NULL 的简化版）
  s = s.replace(/CONCAT_WS_SIM\s*\(([^)]*)\)/gi, (_m, inner) => {
    const parts = inner.split(',').map((x) => x.trim());
    const [sep, ...rest] = parts;
    if (!rest.length) return sep;
    return rest.map((r) => `IFNULL(${r},'')`).join(` || ${sep} || `);
  });

  // datediff(a, b) → CAST(julianday(a) - julianday(b) AS INTEGER)
  s = s.replace(/\bdatediff\s*\(([^,()]+),([^,()]+)\)/gi,
    (_m, a, b) => `CAST(julianday(${a.trim()}) - julianday(${b.trim()}) AS INTEGER)`);

  // to_date(x) → date(x)
  s = s.replace(/\bto_date\s*\(/gi, 'date(');

  // date_add(d, n) / date_sub(d, n) → date(d, '+n day')
  s = s.replace(/\bdate_add\s*\(([^,()]+),\s*([^,()]+)\)/gi,
    (_m, d, n) => `date(${d.trim()}, '+' || (${n.trim()}) || ' day')`);
  s = s.replace(/\bdate_sub\s*\(([^,()]+),\s*([^,()]+)\)/gi,
    (_m, d, n) => `date(${d.trim()}, '-' || (${n.trim()}) || ' day')`);

  // from_unixtime(ts, 'yyyy-MM-dd') → date(ts, 'unixepoch')
  s = s.replace(/\bfrom_unixtime\s*\(\s*([^,()]+)\s*(?:,\s*'([^']*)'\s*)?\)/gi,
    (_m, ts) => `date(${ts.trim()}, 'unixepoch')`);

  // unix_timestamp(x) → CAST(strftime('%s', x) AS INTEGER)
  s = s.replace(/\bunix_timestamp\s*\(([^()]*)\)/gi,
    (_m, x) => (x.trim() ? `CAST(strftime('%s', ${x.trim()}) AS INTEGER)` : `CAST(strftime('%s','now') AS INTEGER)`));

  // substr(s, start[, len]) → SUBSTR(s, start[, len])（SQLite 语义一致，仅大小写）
  s = s.replace(/\bsubstr\s*\(/gi, 'SUBSTR(');

  // get_json_object(col, '$.k') → json_extract(col, '$.k')
  s = s.replace(/\bget_json_object\s*\(/gi, 'json_extract(');

  // regexp_extract(x, pat, idx) → 简化：不支持，明确报错
  if (/\bregexp_extract\s*\(/i.test(s)) {
    throw new DialectError('暂不支持 regexp_extract()（教学环境未实现正则抽取），可改用 SUBSTR / INSTR 组合');
  }
  // LATERAL VIEW explode
  if (/\blateral\s+view\b/i.test(s)) {
    throw new DialectError('暂不支持 LATERAL VIEW explode()（数组炸裂），本训练场的数据都是扁平表');
  }
  // 分区裁剪提示：dt 字段是虚拟分区列（真实数仓里不在数据文件里）
  return s;
}

/** 去掉开头的注释行/块（用户几乎一定会写注释，解析前必须先剥掉） */
export function stripLeadingComments(sql) {
  return String(sql).replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)+/g, '').trim();
}

/** 识别 INSERT OVERWRITE / INSERT INTO，返回 {kind, target, partitions, selectSql} */
export function parseWriteStatement(sql) {
  const s = stripLeadingComments(sql).replace(/;\s*$/, '');
  const m = s.match(/^insert\s+(overwrite|into)\s+(?:table\s+)?([\w.]+)\s*(partition\s*\(([^)]*)\))?\s*(select[\s\S]*)$/i);
  if (!m) return null;
  const partitions = {};
  if (m[4]) {
    for (const kv of m[4].split(',')) {
      const [k, v] = kv.split('=').map((x) => x.trim());
      if (k) partitions[k] = (v ?? '').replace(/^'|'$/g, '');
    }
  }
  return {
    kind: m[1].toLowerCase() === 'overwrite' ? 'overwrite' : 'into',
    target: m[2],
    partitions,
    selectSql: m[5],
  };
}

/** 解析 dwd.db.tbl / dwd.tbl → {db, table} */
export function splitQualified(name) {
  const parts = String(name).split('.');
  if (parts.length === 1) return { db: 'default', table: parts[0] };
  return { db: parts[0], table: parts.slice(1).join('.') };
}

/** 主入口：把 Hive SQL 翻译成 {mode:'select'|'write', sql, hiveSql, write} */
export function translate(hiveSql) {
  const write = parseWriteStatement(hiveSql);
  if (write) {
    return {
      mode: 'write',
      sql: sqliteize(translateFunctions(write.selectSql)),
      hiveSql: write.selectSql,
      write,
    };
  }
  const sel = sanitizeSelect(hiveSql);
  return { mode: 'select', sql: sqliteize(translateFunctions(sel)), hiveSql: sel };
}

const WAREHOUSE_DBS = '(ods|dwd|dws|ads|tmp|default)';

/**
 * Hive 的库限定名 → SQLite 可用表名
 *   ods.meter_readings → ods__meter_readings
 * 只改写标准数仓分层库名，避免误伤函数内的点号或字符串。
 */
export function sqliteize(sql) {
  return String(sql).replace(
    new RegExp(`\\b${WAREHOUSE_DBS}\\.([a-zA-Z_]\\w*)`, 'gi'),
    (_m, db, table) => `${db}__${table}`,
  );
}

/** 反向：SQLite 表名 → Hive 限定名展示用 */
export function hiveize(name) {
  const m = String(name).match(new RegExp(`^${WAREHOUSE_DBS}__(.+)$`, 'i'));
  return m ? `${m[1]}.${m[2]}` : name;
}

/** 读语句只允许 SELECT / WITH / SHOW / DESCRIBE */
function sanitizeSelect(sql) {
  const s = stripLeadingComments(sql).replace(/;\s*$/, '');
  if (!/^(select|with|show|describe|desc)\b/i.test(s)) {
    throw new DialectError('只允许 SELECT / WITH 查询，或 INSERT OVERWRITE 写入数仓分区。训练沙箱禁止 DDL/DML。');
  }
  return s;
}

/** 把 SQLite 报错翻译成人话 */
export function humanizeError(msg, ctx = {}) {
  const m = String(msg);
  const noCol = m.match(/no such column:\s*([\w.]+)/i);
  const tables = ctx.tables ? Object.keys(ctx.tables) : [];
  const perTable = ctx.tables ?? {};

  if (noCol) {
    const col = noCol[1];
    const bare = col.includes('.') ? col.split('.').pop() : col;
    const guess = [];
    for (const [t, cols] of Object.entries(perTable)) {
      for (const c of cols) {
        const cn = typeof c === 'string' ? c : c.name;
        if (cn === bare) continue;
        if (cn.includes(bare) || bare.includes(cn) ||
            levenshtein(cn.toLowerCase(), bare.toLowerCase()) <= 2) {
          guess.push(`${t}.${cn}`);
        }
      }
    }
    const hint = guess.length
      ? `你要找的可能是：${[...new Set(guess)].slice(0, 3).join('、')}（可打开「数据字典」查看全部字段）`
      : '可打开「数据字典」查看字段名';
    return `字段名不存在：「${bare}」。${hint}`;
  }

  const noTable = m.match(/no such table:\s*([\w.]+)/i);
  if (noTable) {
    const near = tables.filter((t) => levenshtein(t.toLowerCase(), noTable[1].toLowerCase()) <= 3);
    return `表不存在：「${noTable[1]}」。${near.length ? `你要找的可能是：${near.join('、')}` : `当前可用表：${tables.slice(0, 8).join('、')}…`}`;
  }

  if (/misuse of aggregate/i.test(m)) {
    return '聚合函数用错位置了：WHERE 里不能用 SUM/COUNT 这类聚合函数，要放在 HAVING 里（WHERE 过滤行，HAVING 过滤分组）。';
  }
  if (/GROUP BY term out of range/i.test(m) || /aggregate.*group by/i.test(m)) {
    return 'GROUP BY 有问题：SELECT 里每个非聚合列都必须出现在 GROUP BY 中（Hive 与 SQLite 在这点上行为一致）。';
  }
  if (/ambiguous column/i.test(m)) {
    return `字段名有歧义：多张表里都有同名字段，请用「表名.字段名」写清楚。原始报错：${m}`;
  }
  if (/syntax error/i.test(m)) {
    return `SQL 语法有误：${m}。常见原因：逗号多了/少了、关键字拼写（FROM、WHERE、GROUP BY）、引号不配对。`;
  }
  if (/no such function/i.test(m)) {
    return `函数不存在或本训练场未实现：${m}。可打开「函数对照表」查看支持的 Hive 函数。`;
  }
  return m;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}
