/**
 * 内置节点校验器
 * ------------------------------------------------------------------
 * 每种链路节点实现 4 层校验（lint / resolve / run / check）。
 * 这是"用户写代码 → 系统校验能过"的实现主体。
 */

import { registerValidator, NodeError, Stage } from './pipeline.mjs';
import { translate, DialectError, humanizeError, splitQualified, sqliteize, stripLeadingComments } from './dialect.mjs';
import { defaultLocation, LAYERS } from './hive.mjs';
import { sqliteName, quoteIdent } from './db.mjs';
import { compareResults } from './judge.mjs';

// ════════════════════════════ 工具 ════════════════════════════

/** shell 风格分词（支持引号与续行） */
export function tokenize(cmd) {
  const s = String(cmd).replace(/\\\r?\n/g, ' ');
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (q) throw new Error('命令里的引号没有闭合');
  if (cur) out.push(cur);
  return out;
}

const SHORT = { '-m': 'num-mappers', '-P': 'password-prompt', '-n': 'num-mappers' };

/** 解析 --k v 形式的参数 */
export function parseFlags(tokens) {
  const args = {};
  for (let i = 0; i < tokens.length; i += 1) {
    let t = tokens[i];
    if (!t.startsWith('-')) continue;
    let name = t.replace(/^--?/, '');
    name = SHORT[t] ?? name;
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith('-')) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

/** 校验 5 段 cron 表达式 */
export function validateCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  const names = ['分钟', '小时', '日', '月', '星期'];
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  if (fields.length !== 5) {
    throw new Error(`cron 表达式必须是 5 段（分 时 日 月 周），你写了 ${fields.length} 段：${expr}`);
  }
  fields.forEach((f, i) => {
    const [lo, hi] = ranges[i];
    const ok = f.split(',').every((part) => {
      if (part === '*') return true;
      const step = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
      if (step) return Number(step[2]) > 0;
      const range = part.match(/^(\d+)-(\d+)$/);
      if (range) return Number(range[1]) >= lo && Number(range[2]) <= hi && Number(range[1]) <= Number(range[2]);
      return /^\d+$/.test(part) && Number(part) >= lo && Number(part) <= hi;
    });
    if (!ok) throw new Error(`cron 的「${names[i]}」字段非法：${f}（合法范围 ${lo}-${hi}）`);
  });
  return true;
}

/** 从 SQL 中提取引用的表名（排除 CTE 名） */
export function extractTables(sql) {
  const ctes = new Set();
  const cteRe = /(?:with|,)\s+([a-zA-Z_]\w*)\s+as\s*\(/gi;
  let m;
  while ((m = cteRe.exec(sql))) ctes.add(m[1].toLowerCase());
  const names = new Set();
  const re = /\b(?:from|join)\s+([a-zA-Z_][\w.]*)/gi;
  while ((m = re.exec(sql))) {
    const n = m[1];
    if (!ctes.has(n.toLowerCase())) names.add(n);
  }
  return [...names];
}

const normPath = (p) => `/${String(p).split('/').filter(Boolean).join('/')}`;
const estBytes = (rows, ncols) => Math.max(rows, 1) * (ncols * 8 + 2);
const FMT_EXT = { parquet: 'parquet', orc: 'orc', textfile: 'txt', avro: 'avro' };

function requireSchema(ctx) {
  if (!ctx.schema || !Object.keys(ctx.schema).length) {
    throw new NodeError('业务库表结构未加载（schema 为空）', Stage.resolve, 'NO_SCHEMA');
  }
}

function resolveTable(name, ctx) {
  const bare = name.includes('.') ? name.split('.').pop() : name;
  const found = Object.keys(ctx.schema).find((t) => t.toLowerCase() === bare.toLowerCase());
  if (!found) {
    const near = Object.keys(ctx.schema)
      .map((t) => [t, levenshtein(t.toLowerCase(), bare.toLowerCase())])
      .filter(([, d]) => d <= 3)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 5)
      .map(([t]) => t);
    throw new NodeError(
      `业务库里没有表「${bare}」`,
      Stage.resolve,
      'TABLE_NOT_FOUND',
      near.length ? `你要找的可能是：${near.join('、')}` : `可用表：${Object.keys(ctx.schema).slice(0, 8).join('、')}…`,
    );
  }
  return found;
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

/** 通用的"产物数字比对" */
function checkNumbers(expect, got, messages, details) {
  let ok = true;
  if (expect.rowsExact !== undefined && got.rows !== expect.rowsExact) {
    ok = false;
    messages.push(`行数不对：你产出 ${got.rows} 行，期望 ${expect.rowsExact} 行（差 ${got.rows - expect.rowsExact}）`);
  }
  if (expect.rowsMin !== undefined && got.rows < expect.rowsMin) {
    ok = false;
    messages.push(`行数偏少：你产出 ${got.rows} 行，至少要有 ${expect.rowsMin} 行`);
  }
  if (expect.rowsMax !== undefined && got.rows > expect.rowsMax) {
    ok = false;
    messages.push(`行数偏多：你产出 ${got.rows} 行，最多 ${expect.rowsMax} 行（是不是没去重/没过滤？）`);
  }
  if (expect.partCount !== undefined && got.partCount !== expect.partCount) {
    ok = false;
    messages.push(`part 文件数不对：你产生 ${got.partCount} 个，期望 ${expect.partCount} 个（检查 --num-mappers）`);
  }
  if (ok) details.push('数字校验通过');
  return ok;
}

// ═══════════════════ ① 数据源：业务库 SELECT ═══════════════════

registerValidator({
  type: 'source_mysql',
  label: '业务库数据源（MySQL/Oracle）',
  lint(code) {
    const errors = [];
    const s = String(code).trim();
    if (!/^(select|with)\b/i.test(s)) {
      errors.push('数据源节点只写查询语句：必须以 SELECT 或 WITH 开头');
    }
    if (/;\s*\S/.test(s)) errors.push('不允许多条语句（多个分号），一次只定义一个抽取范围');
    if (/\b(insert|update|delete|drop|truncate|alter)\b/i.test(s)) {
      errors.push('业务库是只读的：只能 SELECT，不能写业务库');
    }
    return { errors, hint: '这里定义"要抽取哪些数据"，下游 Sqoop/DataX 会用这个范围搬运' };
  },
  resolve(code, node, ctx) {
    requireSchema(ctx);
    const tables = extractTables(code);
    tables.forEach((t) => resolveTable(t, ctx));
    return { sql: String(code).trim().replace(/;\s*$/, ''), tables, warnings: [] };
  },
  run(plan, node, ctx) {
    let r;
    try {
      r = ctx.db.query(plan.sql);
    } catch (e) {
      throw new NodeError(humanizeError(e.message, { tables: ctx.schema }), Stage.run, 'SQL_ERROR');
    }
    return {
      outputs: [{
        system: 'mysql', rows: r.rows.length, columns: r.columns,
        tables: plan.tables, preview: r.rows.slice(0, 5),
      }],
      logs: [`在业务库执行查询：${r.rows.length} 行 / ${r.columns.length} 列`],
    };
  },
  check(out, expect, node, ctx) {
    const got = out.outputs[0];
    const messages = [];
    const details = [];
    const ok = checkNumbers(expect, { rows: got.rows }, messages, details);
    if (expect.columns && expect.columns.length && got.columns.length !== expect.columns.length) {
      messages.push(`返回列数不对：你返回 ${got.columns.length} 列，期望 ${expect.columns.length} 列`);
    }
    return ok ? { status: 'pass', messages } : { status: 'close', messages, details };
  },
});

// ═══════════════════ ② 采集：Sqoop import ═══════════════════

registerValidator({
  type: 'sqoop_import',
  label: 'Sqoop 导入（RDBMS → HDFS/Hive）',
  lint(code) {
    const errors = [];
    const warnings = [];
    let tokens;
    try {
      tokens = tokenize(code);
    } catch (e) {
      return { errors: [e.message] };
    }
    if (tokens[0] !== 'sqoop' || tokens[1] !== 'import') {
      errors.push('命令必须以 `sqoop import` 开头（导入 = 从关系库抽到 HDFS）');
      return { errors, hint: '格式：sqoop import --connect jdbc:mysql://主机:3306/库 --username 用户 --table 表 --target-dir /user/... ' };
    }
    const args = parseFlags(tokens.slice(2));
    if (!args.connect) errors.push('缺少 --connect：Sqoop 需要知道从哪个数据库取数');
    else if (!/^jdbc:\w+:\/\//.test(args.connect)) errors.push(`--connect 格式不对：${args.connect}（应为 jdbc:mysql://主机:3306/库名）`);
    if (!args.username && !args['password-file']) warnings.push('没有 --username，真实环境会连不上（教学环境放行）');
    if (!args.table && !args.query) errors.push('缺少 --table 或 --query：必须指定要导的表（或自定义查询）');
    if (args.table && args.query) errors.push('--table 与 --query 不能同时使用（Sqoop 只允许其一）');
    if (!args['target-dir'] && !args['warehouse-dir'] && !args['hive-table']) {
      errors.push('缺少 --target-dir：必须指定数据落到 HDFS 的哪个目录');
    }
    if (args['target-dir'] && !String(args['target-dir']).startsWith('/')) {
      warnings.push('--target-dir 建议用绝对路径（/user/hive/warehouse/...）');
    }
    const mappers = Number(args['num-mappers'] ?? 1);
    if (mappers > 16) warnings.push(`--num-mappers ${mappers} 过大，教学环境建议 ≤ 16（真实环境按数据量定）`);
    if (mappers > 1 && !args['split-by']) {
      warnings.push('多 mapper 但没有 --split-by：Sqoop 无法切分数据，会退化成单 mapper');
    }
    if (args['hive-import'] && !args['hive-table']) warnings.push('用了 --hive-import 但没写 --hive-table：会落到默认库');
    if (['table', 'query'].includes(String(args['as-parquetfile']))) warnings.push('--as-parquetfile 不需要参数值，允许使用');
    return { errors, warnings, hint: errors.length ? '对照格式：sqoop import --connect jdbc:mysql://localhost:3306/power --username root --password x --table customers --target-dir /user/hive/warehouse/ods.db/customers/dt=20240601 --split-by customer_id --num-mappers 4' : '' };
  },
  resolve(code, node, ctx, upstream) {
    requireSchema(ctx);
    const tokens = tokenize(code);
    const args = parseFlags(tokens.slice(2));
    const warnings = [];
    const dbName = String(args.connect).split('/').pop().split('?')[0];
    let table = null;
    let sql;
    if (args.table) {
      table = resolveTable(String(args.table), ctx);
      const cols = args.columns ? String(args.columns).split(',').map((c) => c.trim()) : null;
      if (cols) {
        const schemaCols = ctx.schema[table].map((c) => (typeof c === 'string' ? c : c.name));
        for (const c of cols) {
          if (!schemaCols.includes(c)) {
            throw new NodeError(`--columns 里的「${c}」在表 ${table} 中不存在`, Stage.resolve, 'COLUMN_NOT_FOUND',
              `可用的列：${schemaCols.slice(0, 12).join('、')}…`);
          }
        }
      }
      const where = args.where ? ` WHERE ${args.where}` : '';
      sql = `SELECT ${cols ? cols.join(', ') : '*'} FROM ${table}${where}`;
    } else {
      sql = String(args.query).replace(/\$CONDITIONS/gi, '1=1');
    }
    // SQL 可执行性校验
    try {
      ctx.db.query(`SELECT * FROM (${sql}) LIMIT 1`);
    } catch (e) {
      throw new NodeError(humanizeError(e.message, { tables: ctx.schema }), Stage.resolve, 'SQL_ERROR',
        '检查 --where / --query 里的条件是否引用了不存在的字段');
    }
    // --split-by 校验
    if (args['split-by'] && table) {
      const cols = ctx.schema[table].map((c) => (typeof c === 'string' ? { name: c, type: '' } : c));
      const col = cols.find((c) => c.name === String(args['split-by']));
      if (!col) {
        throw new NodeError(`--split-by 的字段「${args['split-by']}」在表 ${table} 中不存在`, Stage.resolve, 'SPLITBY_NOT_FOUND',
          `可选字段：${cols.slice(0, 12).map((c) => c.name).join('、')}…`);
      }
      if (/char|text|varchar|string/i.test(col.type)) {
        warnings.push(`--split-by 用了文本型字段「${col.name}」：真实环境会导致数据倾斜或任务失败，建议用数字型主键`);
      }
    }
    const targetDir = normPath(args['target-dir'] ?? `${args['warehouse-dir'] ?? '/user/hive/warehouse'}/${table ?? 'query_result'}`);
    const format = args['as-parquetfile'] ? 'parquet'
      : args['as-orcfile'] ? 'orc'
        : args['as-avrodatafile'] ? 'avro' : 'textfile';
    const numMappers = Number(args['num-mappers'] ?? (args['split-by'] ? 4 : 1));
    return {
      tool: 'sqoop', db: dbName, table, sql, targetDir, format, numMappers,
      splitBy: args['split-by'] ?? null,
      fieldsTerminatedBy: args['fields-terminated-by'] ?? '\u0001',
      upstreamTargetDirs: collectUpstreamTargetDirs(upstream),
      warnings,
    };
  },
  run(plan, node, ctx) {
    const r = ctx.db.query(plan.sql);
    const rows = r.rows.length;
    const partCount = Math.max(1, Math.min(plan.numMappers, Math.max(rows, 1)));
    const logs = [
      `源库查询返回 ${rows} 行`,
      `按 ${partCount} 个 mapper 切分 → 写入 ${partCount} 个 part 文件`,
      `目标目录：${plan.targetDir}（格式 ${plan.format}）`,
    ];
    const paths = [];
    ctx.vfs.mkdir(plan.targetDir);
    for (let i = 0; i < partCount; i += 1) {
      const from = Math.floor((rows * i) / partCount);
      const to = Math.floor((rows * (i + 1)) / partCount);
      const n = to - from;
      const name = `part-m-${String(i).padStart(5, '0')}`;
      const path = `${plan.targetDir}/${name}`;
      ctx.vfs.writeFile(path, `[${plan.format}] ${n} rows`, {
        format: plan.format, rows: n,
        bytes: estBytes(n, r.columns.length),
        partition: partitionOfDir(plan.targetDir),
      });
      paths.push(path);
    }
    ctx.vfs.writeFile(`${plan.targetDir}/_SUCCESS`, '', { format: 'marker', rows: 0, bytes: 0 });
    // —— 模拟器内部机制：HDFS 上的数据要能被 Hive 查询，
    //    因此同时注册一份 SQLite 镜像（真实环境是 Hive 读 HDFS，这里用镜像等价实现）
    const hp = parseHivePath(plan.targetDir);
    if (hp) {
      const sName = sqliteName(`${hp.db}.${hp.table}`);
      ctx.db.ensureTableFromSelect(sName, plan.sql);
      const existing = ctx.db.columnsOf(sName).map((c) => c.name);
      const partCols = Object.keys(hp.partition);
      for (const p of partCols) {
        if (!existing.includes(p)) {
          ctx.db.exec(`ALTER TABLE ${quoteIdent(sName)} ADD COLUMN ${quoteIdent(p)} TEXT`);
        }
      }
      const allCols = [...existing, ...partCols.filter((p) => !existing.includes(p))];
      const ins = `INSERT INTO ${quoteIdent(sName)} (${allCols.map(quoteIdent).join(',')}) VALUES (${allCols.map(() => '?').join(',')})`;
      for (const row of r.rows) {
        ctx.db.raw.run(ins, [...row, ...partCols.map((p) => hp.partition[p])]);
      }
      logs.push(`Hive 可查询视图已就绪：${hp.db}.${hp.table}（分区 ${partCols.map((p) => `${p}=${hp.partition[p]}`).join(',') || '无'}，${rows} 行）`);
    }
    ctx.warehouse?.link(
      { system: plan.db, table: plan.table ?? '(query)' },
      { system: 'hdfs', path: plan.targetDir },
      node.id, 'ingest',
    );
    if (plan.splitBy) logs.push(`切分字段：--split-by ${plan.splitBy}`);
    return {
      outputs: [{
        vfsPaths: paths, targetDir: plan.targetDir, rows, partCount,
        format: plan.format, sourceTable: plan.table, columns: r.columns,
        preview: r.rows.slice(0, 3),
      }],
      logs,
    };
  },
  check(out, expect, node, ctx, upstream) {
    const got = out.outputs[0];
    const messages = [];
    const details = [];
    let ok = checkNumbers(expect, got, messages, details);
    if (expect.targetDir && normPath(expect.targetDir) !== got.targetDir) {
      ok = false;
      messages.push(`落盘目录不对：你写到 ${got.targetDir}，期望 ${normPath(expect.targetDir)}`);
    }
    if (expect.format && expect.format !== got.format) {
      ok = false;
      messages.push(`存储格式不对：你用了 ${got.format}，期望 ${expect.format}`);
    }
    if (expect.sourceTable && expect.sourceTable !== got.sourceTable) {
      ok = false;
      messages.push(`抽错表了：你抽的是 ${got.sourceTable}，题目要求 ${expect.sourceTable}`);
    }
    // 链路一致性：与上游 target-dir 冲突检查
    const ups = collectUpstreamTargetDirs(upstream);
    if (ups.includes(got.targetDir)) {
      ok = false;
      messages.push(`目录冲突：上游节点已经写入了 ${got.targetDir}，两个环节不能写同一个目录`);
    }
    return ok ? { status: 'pass', messages, logs: details } : { status: 'close', messages, details };
  },
});

function collectUpstreamTargetDirs(upstream = {}) {
  const out = [];
  for (const v of Object.values(upstream ?? {})) {
    for (const o of v ?? []) if (o?.targetDir) out.push(normPath(o.targetDir));
  }
  return out;
}

function partitionOfDir(dir) {
  const seg = normPath(dir).split('/').find((s) => /^[\w-]+=.+$/.test(s));
  if (!seg) return null;
  const [k, v] = seg.split('=');
  return { [k]: v };
}

/** 从 HDFS 路径解析 Hive 库/表/分区：/user/hive/warehouse/ods.db/tbl/dt=202403 */
export function parseHivePath(path) {
  const p = normPath(path);
  const m = p.match(/^\/user\/hive\/warehouse\/([^.]+)\.db\/([^/]+)(?:\/(.+))?$/);
  if (!m) return null;
  const partition = {};
  for (const seg of (m[3] ?? '').split('/').filter(Boolean)) {
    const i = seg.indexOf('=');
    if (i > 0) partition[seg.slice(0, i)] = seg.slice(i + 1);
  }
  return { db: m[1], table: m[2], partition };
}

// ═══════════════════ ③ 存储：Hive 建表 ═══════════════════

const TYPE_OK = /^(tinyint|smallint|int|bigint|float|double|decimal|string|varchar|char|boolean|date|timestamp|binary|array|map|struct)\b/i;

export function parseCreateTable(sql) {
  const s = stripLeadingComments(sql).replace(/\s+/g, ' ').trim();
  const head = s.match(/^create\s+(external\s+)?table\s+(if\s+not\s+exists\s+)?([\w.]+)\s*\(/i);
  if (!head) return null;
  // 找到与之匹配的右括号
  let depth = 0;
  const start = s.indexOf('(', head.index + head[0].length - 1);
  let end = -1;
  for (let i = start; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const body = s.slice(start + 1, end);
  const tail = s.slice(end + 1);

  const splitTop = (str) => {
    const out = [];
    let d = 0;
    let cur = '';
    for (const ch of str) {
      if (ch === '(') d += 1;
      if (ch === ')') d -= 1;
      if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  };
  const columns = splitTop(body).map((line) => {
    const m = line.trim().match(/^([`"\w]+)\s+([\w()]+(?:\([\d,\s]+\))?)\s*(?:comment\s+'([^']*)')?/i);
    if (!m) return null;
    return { name: m[1].replace(/[`"]/g, ''), type: m[2], comment: m[3] ?? '' };
  }).filter(Boolean);

  const partM = tail.match(/partitioned\s+by\s*\(([^)]*)\)/i);
  const partitionedBy = partM
    ? splitTop(partM[1]).map((x) => {
      const m = x.trim().match(/^([`"\w]+)\s+([\w()]+(?:\([\d,\s]+\))?)\s*(?:comment\s+'([^']*)')?/i);
      return m ? { name: m[1], type: m[2], comment: m[3] ?? '' } : null;
    }).filter(Boolean)
    : [];
  const fmtM = tail.match(/stored\s+as\s+([\w]+)/i);
  const locM = tail.match(/location\s+'([^']+)'/i);
  const rowM = tail.match(/row\s+format\s+delimited\s+fields\s+terminated\s+by\s+'([^']*)'/i);
  // 列清单之后的 COMMENT 是「表含义」（列注释在括号内，不会误抓）
  const cmtM = tail.match(/comment\s+'([^']*)'/i);

  return {
    external: !!head[1],
    ifNotExists: !!head[2],
    name: head[3],
    columns,
    tableComment: cmtM ? cmtM[1] : '',
    partitionedBy,
    format: fmtM ? fmtM[1].toLowerCase() : null,
    location: locM ? locM[1] : null,
    fieldsTerminatedBy: rowM ? rowM[1] : null,
  };
}

registerValidator({
  type: 'hive_create_table',
  label: 'Hive 建表（外部表 + 分区）',
  lint(code, node, ctx, upstream) {
    const errors = [];
    const warnings = [];
    const t = parseCreateTable(code);
    if (!t) {
      return { errors: ['无法解析建表语句。格式：CREATE EXTERNAL TABLE 库.表 (字段 类型 COMMENT \'说明\', ...) PARTITIONED BY (dt STRING) STORED AS PARQUET LOCATION \'/user/...\''] };
    }
    if (!t.external) warnings.push('建议用 CREATE EXTERNAL TABLE：外部表删表不删数据，生产环境更安全');
    t.columns.forEach((c) => {
      if (!TYPE_OK.test(c.type)) errors.push(`字段「${c.name}」的类型「${c.type}」不是合法 Hive 类型`);
      if (!c.comment) warnings.push(`字段「${c.name}」没有 COMMENT：数仓表必须写中文注释，否则三个月后没人看得懂`);
    });
    if (!t.partitionedBy.length) warnings.push('没有 PARTITIONED BY：数仓表几乎都按 dt 分区，否则全表扫描');
    if (!t.format) warnings.push('没有 STORED AS：默认 textfile，生产大表建议 PARQUET/ORC');
    if (!t.location) errors.push('外部表缺少 LOCATION：必须指向 HDFS 上的数据目录，否则表是空的');
    return { errors, warnings, hint: '' };
  },
  resolve(code, node, ctx, upstream) {
    const t = parseCreateTable(code);
    const { db, table } = splitQualified(t.name);
    const warnings = [];
    if (db === 'default') warnings.push('没写库名：默认落到 default 库，数仓应落到 ods/dwd/dws/ads 分层库');
    else if (!LAYERS.includes(db)) warnings.push(`库名「${db}」不是标准分层（ods/dwd/dws/ads），确认这是有意为之`);
    if (ctx.warehouse.has(db, table) && !t.ifNotExists) {
      throw new NodeError(`表已存在：${db}.${table}`, Stage.resolve, 'TABLE_EXISTS',
        '用 IF NOT EXISTS 可跳过，或换表名（重新建表要先把旧表 DROP 掉）');
    }
    const location = normPath(t.location);
    // 链式一致性：LOCATION 应等于上游采集的 target-dir
    const ups = collectUpstreamTargetDirs(upstream);
    if (!ctx.vfs.exists(location) && !ups.includes(location)) {
      const hint = ups.length
        ? `上游节点的产地在 ${ups.join('、')}——Hive 表只是"挂载"目录，本身不产生数据。检查 LOCATION 与上游 --target-dir 是否写成一致`
        : 'Hive 外部表不会创建目录，需要先有采集节点把数据写进这个目录';
      if (node.expect?.locationMustExist) {
        throw new NodeError(`LOCATION 目录在 HDFS 上不存在：${location}`, Stage.resolve, 'LOCATION_NOT_FOUND', hint);
      }
      warnings.push(`LOCATION 目录当前为空：${location}（${hint}；若数据由下游 INSERT OVERWRITE 写入则可忽略）`);
    }
    return { tableDef: { ...t, db, table, location }, warnings };
  },
  run(plan, node, ctx) {
    const d = plan.tableDef;
    const meta = ctx.warehouse.createTable({
      db: d.db, table: d.table, columns: d.columns, comment: d.tableComment,
      partitionedBy: d.partitionedBy, format: d.format ?? 'textfile',
      location: d.location, external: d.external,
    });
    const logs = [
      `创建${d.external ? '外部表' : '表'}：${d.db}.${d.table}（${d.columns.length} 个字段，${d.partitionedBy.length} 个分区键）`
      + (d.tableComment ? `　表含义：${d.tableComment}` : ''),
      `存储格式：${meta.format}　LOCATION：${meta.location}`,
    ];
    // 自动挂载 LOCATION 下已有分区目录
    if (!ctx.vfs.exists(d.location)) {
      ctx.vfs.mkdir(d.location);
      logs.push(`已创建 LOCATION 空目录：${d.location}（Hive 外部表本身不创建目录，此处为链路完整性自动创建；数据由后续 INSERT OVERWRITE 写入）`);
    }
    const children = ctx.vfs.ls(d.location).filter((e) => e.type === 'dir' && /^[\w-]+=/.test(e.name));
    for (const c of children) {
      const [k, v] = c.name.split('=');
      if (d.partitionedBy.some((p) => p.name === k)) {
        try {
          ctx.warehouse.addPartition(d.db, d.table, { [k]: v });
          logs.push(`自动挂载已存在分区：${k}=${v}`);
        } catch { /* 忽略不完整分区目录 */ }
      }
    }
    return {
      outputs: [{ hiveTable: `${d.db}.${d.table}`, location: meta.location, rows: null, partitions: ctx.warehouse.partitionsOf(d.db, d.table).length }],
      logs,
    };
  },
  check(out, expect, node, ctx) {
    const got = out.outputs[0];
    const messages = [];
    let ok = true;
    if (expect.hiveTable && expect.hiveTable !== got.hiveTable) {
      ok = false;
      messages.push(`表名不对：你建的是 ${got.hiveTable}，期望 ${expect.hiveTable}`);
    }
    if (expect.location && normPath(expect.location) !== normPath(got.location)) {
      ok = false;
      messages.push(`LOCATION 不对：你挂在 ${got.location}，期望 ${normPath(expect.location)}`);
    }
    if (expect.partitionKey) {
      const t = ctx.warehouse.get(got.hiveTable.split('.')[0], got.hiveTable.split('.')[1]);
      if (!t.partitionColumns.some((p) => p.name === expect.partitionKey)) {
        ok = false;
        messages.push(`分区键不对：期望按「${expect.partitionKey}」分区`);
      }
    }
    if (expect.format) {
      const [d, t] = got.hiveTable.split('.');
      const meta = ctx.warehouse.get(d, t);
      if (meta && meta.format !== expect.format) {
        ok = false;
        messages.push(`存储格式不对：你用了 ${meta.format}，期望 ${expect.format}`);
      }
    }
    return ok ? { status: 'pass', messages } : { status: 'close', messages };
  },
});

// ═══════════════════ ④ 计算：Hive SQL ═══════════════════

registerValidator({
  type: 'hive_sql',
  label: 'Hive / Spark SQL 计算',
  lint(code) {
    try {
      translate(code);
      return { errors: [], warnings: [] };
    } catch (e) {
      if (e instanceof DialectError) return { errors: [e.message], hint: '本训练场支持的 Hive 函数见「函数对照表」' };
      return { errors: [e.message] };
    }
  },
  resolve(code, node, ctx) {
    const tr = translate(code);
    const tables = extractTables(tr.hiveSql);
    const warnings = [];
    for (const name of tables) {
      const { db, table } = splitQualified(name);
      const inWarehouse = ctx.warehouse.has(db, table);
      const inSource = Object.keys(ctx.schema ?? {}).some((t) => t.toLowerCase() === table.toLowerCase());
      if (!inWarehouse && !inSource) {
        throw new NodeError(`表不存在：${name}`, Stage.resolve, 'TABLE_NOT_FOUND',
          `数仓里已有：${ctx.warehouse.list().map((t) => `${t.db}.${t.table}`).slice(0, 8).join('、') || '(空)'}；业务库有：${Object.keys(ctx.schema ?? {}).slice(0, 8).join('、')}…`);
      }
      if (inSource && !inWarehouse) warnings.push(`表 ${name} 来自业务库（未经过数仓分层），生产上应先落 ODS 再加工`);
    }
    let target = null;
    if (tr.mode === 'write') {
      const { db, table } = splitQualified(tr.write.target);
      if (!ctx.warehouse.has(db, table)) {
        throw new NodeError(`写入目标不存在：${tr.write.target}`, Stage.resolve, 'TARGET_MISSING',
          'INSERT OVERWRITE 之前要先用 hive_create_table 节点建好表');
      }
      const meta = ctx.warehouse.get(db, table);
      target = { db, table, meta, partitions: tr.write.partitions, kind: tr.write.kind };
      for (const p of meta.partitionColumns) {
        if (!(p.name in tr.write.partitions)) {
          throw new NodeError(`目标表按 ${meta.partitionColumns.map((x) => x.name).join(',')} 分区，但 INSERT 里没写 PARTITION(...)`,
            Stage.resolve, 'PARTITION_REQUIRED');
        }
      }
    }
    return { mode: tr.mode, sql: tr.sql, selectSql: tr.write?.selectSql ?? tr.sql, target, tables, sourceTables: tables, warnings };
  },
  run(plan, node, ctx) {
    const logs = [];
    let r;
    try {
      r = ctx.db.query(plan.sql);
    } catch (e) {
      throw new NodeError(humanizeError(e.message, { tables: buildTableMap(ctx) }), Stage.run, 'SQL_ERROR');
    }
    const outputs = [];
    if (plan.mode === 'write') {
      const { db, table, meta, partitions } = plan.target;
      const sName = sqliteName(`${db}.${table}`);
      ctx.db.ensureTableFromSelect(sName, plan.sql);
      const partCols = meta.partitionColumns.map((p) => p.name);
      let cols = ctx.db.columnsOf(sName).map((c) => c.name);
      for (const p of partCols) {
        if (!cols.includes(p)) {
          ctx.db.exec(`ALTER TABLE ${quoteIdent(sName)} ADD COLUMN ${quoteIdent(p)} TEXT`);
          cols = ctx.db.columnsOf(sName).map((c) => c.name);
        }
      }
      const dataCols = cols.filter((c) => !partCols.includes(c));
      const where = partCols.map((p) => `${quoteIdent(p)} = ?`).join(' AND ');
      if (meta.external !== false) ctx.db.exec(`DELETE FROM ${quoteIdent(sName)} WHERE ${where}`, partCols.map((p) => partitions[p]));
      const insertSql = `INSERT INTO ${quoteIdent(sName)} (${[...dataCols, ...partCols].map(quoteIdent).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      const fullCols = r.columns;
      const idx = fullCols.map((c, i) => ({ c, i }));
      for (const row of r.rows) {
        const vals = [...idx.map(({ i }) => row[i]), ...partCols.map((p) => partitions[p])];
        ctx.db.raw.run(insertSql, vals);
      }
      const partDir = ctx.warehouse.partitionPath(db, table, partitions);
      ctx.vfs.mkdir(partDir);
      const nParts = r.rows.length > 10000 ? 2 : 1;
      const paths = [];
      for (let i = 0; i < nParts; i += 1) {
        const n = Math.ceil(r.rows.length / nParts);
        const path = `${partDir}/part-${String(i).padStart(5, '0')}`;
        ctx.vfs.writeFile(path, `[${meta.format}] ${n} rows`, {
          format: meta.format, rows: n, bytes: estBytes(n, cols.length), partition: partitions,
        });
        paths.push(path);
      }
      try {
        ctx.warehouse.addPartition(db, table, partitions);
      } catch (e) { logs.push(`分区挂载提示：${e.message}`); }
      for (const src of plan.sourceTables ?? []) {
        const s = splitQualified(src);
        if (ctx.warehouse.has(s.db, s.table)) ctx.warehouse.link(s, { db, table }, node.id, 'transform');
      }
      logs.push(`INSERT OVERWRITE ${db}.${table} PARTITION(${Object.entries(partitions).map(([k, v]) => `${k}='${v}'`).join(', ')}) → ${r.rows.length} 行`);
      logs.push(`写入分区目录：${partDir}（${nParts} 个 ${meta.format} 文件）`);
      outputs.push({ hiveTable: `${db}.${table}`, rows: r.rows.length, vfsPaths: paths, partition: partitions, columns: r.columns, preview: r.rows.slice(0, 3) });
    } else {
      logs.push(`查询返回 ${r.rows.length} 行 / ${r.columns.length} 列`);
      outputs.push({ rows: r.rows.length, columns: r.columns, preview: r.rows.slice(0, 5) });
    }
    return { outputs, logs };
  },
  check(out, expect, node, ctx) {
    const got = out.outputs[0];
    const messages = [];
    const details = [];
    let ok = checkNumbers(expect, got, messages, details);
    if (expect.mustContainRows?.length) {
      const norm = (v) => (v === null || v === undefined ? '\u0000N' : (typeof v === 'number' ? String(Number(v.toFixed(4))) : String(v).trim()));
      const have = new Set((got.preview ?? []).map((row) => row.map(norm).join('|')));
      const full = new Set();
      // 用真实结果集做包含校验（preview 只有前几行）
      try {
        const r = ctx.db.query(node.code.includes('insert') ? buildSelectForCheck(node, ctx) : node.code);
        r.rows.forEach((row) => full.add(row.map(norm).join('|')));
      } catch { /* 忽略 */ }
      for (const want of expect.mustContainRows) {
        const k = want.map(norm).join('|');
        if (!full.has(k) && !have.has(k)) {
          ok = false;
          messages.push(`缺少期望的结果行：${JSON.stringify(want)}`);
        }
      }
    }
    if (expect.partition && got.partition) {
      for (const [k, v] of Object.entries(expect.partition)) {
        if (String(got.partition[k]) !== String(v)) {
          ok = false;
          messages.push(`分区值不对：${k} 期望 ${v}，实际 ${got.partition[k]}`);
        }
      }
    }
    return ok ? { status: 'pass', messages, logs: details } : { status: 'close', messages, details };
  },
});

function buildSelectForCheck(node, ctx) {
  const tr = translate(node.code);
  return tr.mode === 'write' ? tr.sql : node.code;
}

function buildTableMap(ctx) {
  const map = { ...(ctx.schema ?? {}) };
  for (const t of ctx.warehouse?.list() ?? []) map[`${t.db}.${t.table}`] = t.columns;
  return map;
}

// ═══════════════════ ⑤ 采集：DataX 同步 ═══════════════════

const DATAX_READERS = ['mysqlreader', 'oraclereader', 'hdfsreader', 'txtfilereader', 'streamreader', 'sqlserverreader'];
const DATAX_WRITERS = ['mysqlwriter', 'hdfswriter', 'txtfilewriter', 'streamwriter', 'clickhousewriter'];

registerValidator({
  type: 'datax_sync',
  label: 'DataX 异构数据同步',
  lint(code) {
    const errors = [];
    const warnings = [];
    let cfg;
    try {
      cfg = JSON.parse(code);
    } catch (e) {
      return { errors: [`JSON 解析失败：${e.message}`, 'DataX 配置必须是一个合法 JSON（注意：不能有注释、不能有尾随逗号）'] };
    }
    if (!cfg.job) errors.push('缺少最外层 job 节点');
    if (!Array.isArray(cfg.job?.content) || !cfg.job.content.length) errors.push('job.content 必须是一个非空数组（每个元素一组 reader→writer）');
    if (cfg.job?.setting?.speed?.channel === undefined) warnings.push('建议设置 job.setting.speed.channel（控制并发数）');
    (cfg.job?.content ?? []).forEach((c, i) => {
      const tag = `content[${i}]`;
      if (!c.reader?.name) errors.push(`${tag} 缺少 reader.name`);
      else if (!DATAX_READERS.includes(c.reader.name)) errors.push(`${tag} reader.name「${c.reader.name}」不支持，可选：${DATAX_READERS.join('、')}`);
      if (!c.writer?.name) errors.push(`${tag} 缺少 writer.name`);
      else if (!DATAX_WRITERS.includes(c.writer.name)) errors.push(`${tag} writer.name「${c.writer.name}」不支持，可选：${DATAX_WRITERS.join('、')}`);
      if (c.reader && !c.reader.parameter) errors.push(`${tag} 缺少 reader.parameter`);
      if (c.writer && !c.writer.parameter) errors.push(`${tag} 缺少 writer.parameter`);
      if (c.writer?.parameter && !('column' in c.writer.parameter) && c.writer.name !== 'hdfswriter') {
        warnings.push(`${tag} writer.parameter 里没有 column：目标字段需要显式声明`);
      }
    });
    return { errors, warnings, hint: errors.length ? 'DataX 配置结构：job.content[].reader{name,parameter} / writer{name,parameter}；job.setting.speed.channel' : '' };
  },
  resolve(code, node, ctx) {
    requireSchema(ctx);
    const cfg = JSON.parse(code);
    const c = cfg.job.content[0];
    const rp = c.reader.parameter ?? {};
    const warnings = [];
    let table = null;
    if (c.reader.name === 'mysqlreader') {
      const conn = (rp.connection ?? [])[0];
      if (!conn?.table?.length) throw new NodeError('mysqlreader 必须写 connection[0].table（数组）', Stage.resolve, 'MISSING_TABLE');
      table = resolveTable(conn.table[0], ctx);
      const want = (rp.column ?? []).map((x) => (typeof x === 'string' ? x : x.name));
      const cols = ctx.schema[table].map((x) => (typeof x === 'string' ? x : x.name));
      for (const w of want) {
        if (!cols.includes(w)) {
          throw new NodeError(`reader.column 里的「${w}」在表 ${table} 不存在`, Stage.resolve, 'COLUMN_NOT_FOUND',
            `可用列：${cols.slice(0, 12).join('、')}…`);
        }
      }
      if (!want.length) warnings.push('reader.column 为空：建议显式列出字段，避免上游改表导致同步错位');
      if (!rp.where) warnings.push('没有 where 条件：全量同步，大表会拖垮源库（生产建议加增量条件）');
    }
    const wp = c.writer.parameter ?? {};
    const path = wp.path ? `${normPath(wp.path)}${wp.fileName ? `/${wp.fileName}` : ''}` : null;
    if (c.writer.name === 'hdfswriter' && !path) {
      throw new NodeError('hdfswriter 必须写 parameter.path', Stage.resolve, 'MISSING_PATH');
    }
    const channels = cfg.job?.setting?.speed?.channel ?? 1;
    return { config: cfg, table, path, channels, reader: c.reader.name, writer: c.writer.name, where: rp.where ?? null, warnings };
  },
  run(plan, node, ctx) {
    const sql = `SELECT * FROM ${plan.table}${plan.where ? ` WHERE ${plan.where}` : ''}`;
    let rows = 0;
    if (plan.table) {
      try { rows = ctx.db.query(sql).rows.length; }
      catch (e) { throw new NodeError(humanizeError(e.message, { tables: ctx.schema }), Stage.run, 'SQL_ERROR'); }
    }
    const outputs = [];
    const logs = [`DataX ${plan.reader} → ${plan.writer}（并发 channel=${plan.channels}）`];
    if (plan.path) {
      ctx.vfs.mkdir(plan.path.replace(/\/[^/]*$/, ''));
      ctx.vfs.writeFile(plan.path, `[datax] ${rows} rows`, { format: 'textfile', rows, bytes: estBytes(rows, 8) });
      outputs.push({ vfsPaths: [plan.path], path: plan.path, rows });
      logs.push(`写入 ${plan.path}：${rows} 行`);
    } else {
      outputs.push({ rows, table: plan.table });
    }
    ctx.warehouse?.link({ system: 'mysql', table: plan.table }, { system: 'hdfs', path: plan.path ?? plan.table }, node.id, 'sync');
    return { outputs, logs };
  },
  check(out, expect, node) {
    const got = out.outputs[0];
    const messages = [];
    let ok = checkNumbers(expect, { rows: got.rows, partCount: got.partCount }, messages, []);
    if (expect.path && normPath(expect.path) !== normPath(got.path)) {
      ok = false;
      messages.push(`落盘路径不对：你写到 ${got.path}，期望 ${normPath(expect.path)}`);
    }
    return ok ? { status: 'pass', messages } : { status: 'close', messages };
  },
});

// ═══════════════════ ⑥ 调度：DAG ═══════════════════

const TASK_COST_MS = {
  sqoop_import: 45000, datax_sync: 30000, hive_sql: 60000, hive_create_table: 2000,
  hive_add_partition: 1500, source_mysql: 3000, export_mysql: 20000, data_quality: 5000,
  flume_agent: 25000, kafka_connect: 20000, hdfs_mkdir: 500,
};

registerValidator({
  type: 'dag_schedule',
  label: '调度编排（Airflow / DolphinScheduler DAG）',
  lint(code) {
    const errors = [];
    const warnings = [];
    let cfg;
    try {
      cfg = JSON.parse(code);
    } catch (e) {
      return { errors: [`JSON 解析失败：${e.message}`] };
    }
    const dag = cfg.dag ?? cfg;
    if (!dag.name) warnings.push('建议给 DAG 起个名字（dag.name）');
    if (!Array.isArray(dag.tasks) || !dag.tasks.length) {
      return { errors: ['dag.tasks 必须是非空数组'] };
    }
    const ids = dag.tasks.map((t) => t.id);
    if (new Set(ids).size !== ids.length) errors.push('任务 id 有重复');
    dag.tasks.forEach((t) => {
      if (!t.id) errors.push('有任务缺少 id');
      if (!t.type) errors.push(`任务 ${t.id} 缺少 type`);
      else if (!TASK_COST_MS[t.type] && !['dag_schedule']) warnings.push(`任务 ${t.id} 的类型「${t.type}」不认识，默认按 10s 估算`);
    });
    if (dag.schedule) {
      try { validateCron(dag.schedule); }
      catch (e) { errors.push(`调度周期有问题：${e.message}`); }
    } else {
      errors.push('缺少 dag.schedule：生产任务必须定义调度周期（cron 5 段）');
    }
    // 依赖存在性 + 环检测
    dag.tasks.forEach((t) => {
      for (const d of t.deps ?? []) {
        if (!ids.includes(d)) errors.push(`任务 ${t.id} 依赖了不存在的任务「${d}」`);
      }
    });
    const state = new Map();
    const dfs = (id, stack) => {
      const s = state.get(id) ?? 0;
      if (s === 2) return;
      if (s === 1) { errors.push(`依赖有环：${[...stack, id].join(' → ')}`); return; }
      state.set(id, 1);
      const t = dag.tasks.find((x) => x.id === id);
      for (const d of t?.deps ?? []) dfs(d, [...stack, id]);
      state.set(id, 2);
    };
    dag.tasks.forEach((t) => dfs(t.id, []));
    return { errors, warnings, hint: errors.length ? 'DAG 结构：{dag:{name, schedule:"0 8 * * *", tasks:[{id, type, deps:[]}]}}' : '' };
  },
  resolve(code) {
    const cfg = JSON.parse(code);
    const dag = cfg.dag ?? cfg;
    const byId = new Map(dag.tasks.map((t) => [t.id, t]));
    const level = new Map();
    const compute = (id, stack = []) => {
      if (level.has(id)) return level.get(id);
      const t = byId.get(id);
      const l = (t.deps ?? []).length ? Math.max(...(t.deps ?? []).map((d) => compute(d, [...stack, id]))) + 1 : 1;
      level.set(id, l);
      return l;
    };
    dag.tasks.forEach((t) => compute(t.id));
    const levels = {};
    for (const [id, l] of level) (levels[l] ??= []).push(id);
    const dur = (id) => TASK_COST_MS[byId.get(id).type] ?? 10000;
    // 关键路径（按耗时最长，而不是层数）
    const finish = new Map();
    const topoLevels = Object.keys(levels).map(Number).sort((a, b) => a - b);
    for (const l of topoLevels) {
      for (const id of levels[l]) {
        const t = byId.get(id);
        const start = Math.max(0, ...(t.deps ?? []).map((d) => finish.get(d) ?? 0));
        finish.set(id, start + dur(id));
      }
    }
    const total = Math.max(...finish.values());
    const seq = dag.tasks.map((t) => t.id).sort((a, b) => (finish.get(a) ?? 0) - (finish.get(b) ?? 0));
    const parallel = Math.max(...Object.values(levels).map((v) => v.length));
    return { dag, levels, taskCount: dag.tasks.length, estimatedMs: total, maxParallel: parallel, sequence: seq, warnings: [] };
  },
  run(plan) {
    return {
      outputs: [{
        dag: plan.dag.name ?? 'unnamed', taskCount: plan.taskCount,
        levels: plan.levels, estimatedMs: plan.estimatedMs, maxParallel: plan.maxParallel,
        rows: null,
      }],
      logs: [
        `DAG「${plan.dag.name ?? 'unnamed'}」共 ${plan.taskCount} 个任务，分 ${Object.keys(plan.levels).length} 层`,
        `最大并行度：${plan.maxParallel} 个任务同时跑`,
        `预计总耗时：${(plan.estimatedMs / 1000).toFixed(0)} 秒（关键路径决定）`,
        `调度周期：${plan.dag.schedule}`,
      ],
    };
  },
  check(out, expect) {
    const got = out.outputs[0];
    const messages = [];
    let ok = true;
    if (expect.taskCount !== undefined && got.taskCount !== expect.taskCount) {
      ok = false;
      messages.push(`任务数不对：你编排了 ${got.taskCount} 个，题目要求 ${expect.taskCount} 个——漏了哪个环节？`);
    }
    if (expect.cron && expect.cron !== undefined) {
      const want = String(expect.cron).trim().split(/\s+/).join(' ');
      const have = String(got.levels ? (out.logs.find((l) => l.startsWith('调度周期'))?.replace('调度周期：', '').trim()) : '').split(/\s+/).join(' ');
      if (want !== have) {
        ok = false;
        messages.push(`调度周期不对：你写了 ${have || '(无)'}，期望 ${want}（每天早上 8 点 → 0 8 * * *）`);
      }
    }
    if (expect.deps?.length) {
      const have = new Map();
      for (const [lvl, ids] of Object.entries(got.levels)) for (const id of ids) have.set(id, Number(lvl));
      for (const [a, b] of expect.deps) {
        if ((have.get(b) ?? 0) <= (have.get(a) ?? 0)) {
          ok = false;
          messages.push(`依赖顺序不对：${b} 必须排在 ${a} 之后（${a} → ${b}）`);
        }
      }
    }
    return ok ? { status: 'pass', messages } : { status: 'close', messages };
  },
});

// ═══════════════════ ⑦ 输出：回写业务库 ═══════════════════

registerValidator({
  type: 'export_mysql',
  label: '结果回写（Hive → MySQL 报表库）',
  lint(code) {
    const errors = [];
    const warnings = [];
    let tokens;
    try { tokens = tokenize(code); } catch (e) { return { errors: [e.message] }; }
    if (tokens[0] !== 'sqoop' || tokens[1] !== 'export') {
      errors.push('回写业务库要用 `sqoop export`（导入用 import，导出用 export）');
      return { errors };
    }
    const args = parseFlags(tokens.slice(2));
    if (!args.connect) errors.push('缺少 --connect：要指定写入哪个目标库');
    if (!args['export-dir']) errors.push('缺少 --export-dir：要指定从 HDFS 哪个目录导出');
    if (!args.table) errors.push('缺少 --table：要指定写入哪张目标表');
    if (args['export-dir'] && !String(args['export-dir']).startsWith('/')) warnings.push('--export-dir 建议用绝对路径');
    return {
      errors, warnings,
      hint: '格式：sqoop export --connect jdbc:mysql://host:3306/report --username root --password x --table rpt_xxx --export-dir /user/hive/warehouse/ads.db/xxx/dt=20240601',
    };
  },
  resolve(code, node, ctx) {
    const args = parseFlags(tokenize(code).slice(2));
    const dir = normPath(args['export-dir']);
    if (!ctx.vfs.exists(dir)) {
      throw new NodeError(`--export-dir 在 HDFS 上不存在：${dir}`, Stage.resolve, 'EXPORT_DIR_MISSING',
        '导出前必须先在 HDFS 上产出数据（上游计算节点的分区目录）');
    }
    const files = ctx.vfs.findFiles(dir);
    const rows = files.reduce((s, f) => s + (f.rows ?? 0), 0);
    return { dir, table: String(args.table), rows, files: files.length, warnings: [] };
  },
  run(plan, node, ctx) {
    const name = `rpt_${plan.table}`;
    ctx.db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(name)} AS SELECT 1 AS _placeholder WHERE 0`);
    ctx.state?.set(`export:${plan.table}`, { rows: plan.rows, dir: plan.dir });
    return {
      outputs: [{ table: plan.table, rows: plan.rows, vfsPaths: [plan.dir], targetSystem: 'mysql' }],
      logs: [`从 ${plan.dir} 导出 ${plan.rows} 行到报表库表 ${plan.table}`],
    };
  },
  check(out, expect) {
    const got = out.outputs[0];
    const messages = [];
    let ok = true;
    if (expect.table && expect.table !== got.table) {
      ok = false;
      messages.push(`目标表不对：你写入 ${got.table}，期望 ${expect.table}`);
    }
    if (expect.rowsExact !== undefined && got.rows !== expect.rowsExact) {
      ok = false;
      messages.push(`导出行数不对：${got.rows} ≠ ${expect.rowsExact}`);
    }
    return ok ? { status: 'pass', messages } : { status: 'close', messages };
  },
});

// ═══════════════════ ⑧ 数据质量校验 ═══════════════════

registerValidator({
  type: 'data_quality',
  label: '数据质量校验（断言式 SQL）',
  lint(code) {
    const s = String(code).trim();
    const errors = [];
    if (!/^select\b/i.test(s)) errors.push('质量校验要写 SELECT：查出"异常行"，0 行 = 通过');
    if (!/\bcount\s*\(/i.test(s)) errors.push('建议用 COUNT(*) 形式：返回异常数量，便于定位（如 SELECT COUNT(*) FROM ... WHERE 金额 < 0）');
    return { errors, warnings: [], hint: '规则示例：SELECT COUNT(*) FROM dwd.x WHERE dt=\'20240601\' AND amount < 0' };
  },
  resolve(code, node, ctx) {
    const tables = extractTables(code);
    for (const t of tables) {
      const { db, table } = splitQualified(t);
      if (!ctx.warehouse.has(db, table) && !Object.keys(ctx.schema ?? {}).some((x) => x.toLowerCase() === table.toLowerCase())) {
        throw new NodeError(`校验规则里引用了不存在的表：${t}`, Stage.resolve, 'TABLE_NOT_FOUND');
      }
    }
    return { sql: sqliteize(String(code).trim().replace(/;\s*$/, '')), rule: node.expect?.rule ?? '', warnings: [] };
  },
  run(plan, node, ctx) {
    let bad = 0;
    try {
      const r = ctx.db.query(plan.sql);
      bad = r.rows.length === 1 && r.rows[0].length === 1 ? Number(r.rows[0][0]) : r.rows.length;
    } catch (e) {
      throw new NodeError(humanizeError(e.message, { tables: buildTableMap(ctx) }), Stage.run, 'SQL_ERROR');
    }
    return {
      outputs: [{ rule: plan.rule, badRows: bad, rows: bad }],
      logs: [bad === 0 ? '✅ 质量校验通过：未发现异常数据' : `❌ 质量校验未通过：发现 ${bad} 行异常数据`],
    };
  },
  check(out, expect) {
    const got = out.outputs[0];
    const messages = [];
    if (expect.badRows !== undefined && got.badRows !== expect.badRows) {
      return {
        status: 'close',
        messages: [`质量校验结果不对：你查出 ${got.badRows} 行异常，题目期望 ${expect.badRows} 行`,
          got.badRows === 0 ? '可能是你的规则太宽，漏掉了脏数据（想想：表底跳变 / 估抄 / 销户用户）'
            : '可能是规则太严，把正常数据也当成异常了'],
      };
    }
    if (expect.expectZero && got.badRows !== 0) {
      return { status: 'close', messages: [`题目要求这个规则查出 0 行（数据是干净的），你查出 ${got.badRows} 行——是不是条件写错了？`] };
    }
    return { status: 'pass', messages: [] };
  },
});

export function registerBuiltinValidators() {
  return [...TASK_COST_MS.keys()];
}
