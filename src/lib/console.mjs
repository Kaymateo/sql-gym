/**
 * SQL 控制台执行入口
 * ------------------------------------------------------------------
 * 浏览器控制台和 Node 测试共用这一个函数，保证"页面上能跑"与"测试通过"是同一套逻辑。
 *
 * 支持的语句：
 *   CREATE [EXTERNAL] TABLE ...      建数仓表（Hive 语法）
 *   INSERT OVERWRITE/INTO ...        写数仓分区（真的产生数据 + HDFS 分区目录）
 *   SELECT / WITH ...                查询（业务库表与数仓表都能查）
 *
 * 返回统一结构，便于前端渲染：
 *   {ok, kind, columns, rows, rowCount, ms, logs, warnings, hint,
 *    write:{table, partition, rows, dirs}, error:{stage, message, hint}}
 */

import { VALIDATORS } from './pipeline.mjs';
import { translate, DialectError, humanizeError } from './dialect.mjs';
import './validators.mjs';     // 注册校验器（副作用导入）

const WRITE_RE = /^insert\s+(overwrite|into)\b/i;
const DDL_RE = /^create\s+(external\s+)?table\b/i;
const ALT_RE = /^alter\s+table\b/i;
const CTAS_RE = /^create\s+table\b[\s\S]*\bas\s+select\b/i;

export function classify(sql) {
  const s = String(sql).trim().replace(/^--[^\n]*\n/gm, '').trim();
  if (DDL_RE.test(s)) return CTAS_RE.test(s) ? 'ctas' : 'ddl';
  if (WRITE_RE.test(s)) return 'write';
  if (ALT_RE.test(s)) return 'alter';
  return 'select';
}

/** 从任意结果集取第一个标量（用于 COUNT(*) 这类） */
const scalar = (r) => (r.rows.length === 1 && r.rows[0].length === 1 ? r.rows[0][0] : null);

export function runStatement(ctx, sqlText, opts = {}) {
  const t0 = Date.now();
  const sql = String(sqlText ?? '').trim().replace(/;\s*$/, '');
  const base = { columns: [], rows: [], rowCount: 0, logs: [], warnings: [], write: null };
  if (!sql) return { ...base, ok: false, kind: 'empty', error: { stage: 'lint', message: '还没有写 SQL' } };

  const kind = classify(sql);

  try {
    if (kind === 'ddl' || kind === 'ctas') return { ...runDdl(ctx, sql, kind, opts), kind, ms: Date.now() - t0 };
    if (kind === 'write') return { ...runWrite(ctx, sql, opts), kind, ms: Date.now() - t0 };
    if (kind === 'alter') return { ...runAlter(ctx, sql), kind, ms: Date.now() - t0 };
    return { ...runSelect(ctx, sql), kind, ms: Date.now() - t0 };
  } catch (e) {
    const isDialect = e instanceof DialectError;
    return {
      ...base, ok: false, kind, ms: Date.now() - t0,
      error: {
        stage: e.stage ?? 'lint',
        message: isDialect ? e.message : humanizeError(e.message, { tables: tableMap(ctx) }),
        hint: e.hint ?? (isDialect ? '本训练场支持的 Hive 函数见「函数对照」' : ''),
      },
      warnings: [],
    };
  }
}

// ── CREATE TABLE ───────────────────────────────────────────────
function runDdl(ctx, sql, kind, opts) {
  const v = VALIDATORS.get('hive_create_table');
  const node = { id: 'console-ddl', code: sql, expect: opts.expect ?? {} };
  const lint = v.lint(sql, node, ctx) ?? {};
  if (lint.errors?.length) {
    return { ok: false, logs: [], warnings: lint.warnings ?? [], error: { stage: 'lint', message: lint.errors.join('\n'), hint: lint.hint ?? '' } };
  }
  const plan = v.resolve(sql, node, ctx, {});
  if (kind === 'ctas') {
    // CREATE TABLE ... AS SELECT：建表 + 直接灌数
    const d = plan.tableDef;
    ctx.warehouse.createTable({
      db: d.db, table: d.table, columns: d.columns, partitionedBy: d.partitionedBy,
      format: d.format ?? 'parquet', location: d.location, external: d.external,
    });
    return { ok: true, logs: [`已建表 ${d.db}.${d.table}（CTAS：下一步请在编辑器里用 INSERT OVERWRITE 写入数据）`], warnings: plan.warnings ?? [] };
  }
  const out = v.run(plan, node, ctx);
  return { ok: true, logs: out.logs, warnings: [...(plan.warnings ?? []), ...lint.warnings ?? []], columns: [], rows: [], rowCount: 0, table: out.outputs[0] };
}

// ── INSERT OVERWRITE / INTO ────────────────────────────────────
function runWrite(ctx, sql, opts) {
  const v = VALIDATORS.get('hive_sql');
  const lint = v.lint(sql, { code: sql }, ctx) ?? {};
  if (lint.errors?.length) {
    return { ok: false, logs: [], warnings: [], error: { stage: 'lint', message: lint.errors.join('\n'), hint: lint.hint ?? '' } };
  }
  const plan = v.resolve(sql, { code: sql, expect: opts.expect ?? {} }, ctx, {});
  const out = v.run(plan, { id: 'console-write', code: sql }, ctx);
  const o = out.outputs[0];
  const dirs = o.vfsPaths ?? [];
  const logs = [...out.logs,
    `HDFS 分区目录：${plan.target ? ctx.warehouse.partitionPath(plan.target.db, plan.target.table, plan.target.partitions) : '-'}`];
  return {
    ok: true, columns: o.columns ?? [], rows: (o.preview ?? []).slice(0, 50),
    rowCount: o.rows ?? 0, logs, warnings: plan.warnings ?? [],
    write: { table: o.hiveTable, partition: o.partition, rows: o.rows, dirs },
  };
}

// ── ALTER TABLE ADD PARTITION ──────────────────────────────────
function runAlter(ctx, sql) {
  const m = sql.match(/^alter\s+table\s+([\w.]+)\s+add\s+(?:if\s+not\s+exists\s+)?partition\s*\(([^)]*)\)/i);
  if (!m) {
    return { ok: false, logs: [], warnings: [], error: { stage: 'lint', message: '只支持 ALTER TABLE ... ADD PARTITION (dt=\'202403\')' } };
  }
  const [db, ...rest] = m[1].split('.');
  const table = rest.join('.');
  const values = {};
  for (const kv of m[2].split(',')) {
    const [k, val] = kv.split('=').map((x) => x.trim());
    if (k) values[k] = String(val ?? '').replace(/^'|'$/g, '');
  }
  const p = ctx.warehouse.addPartition(db, table, values);
  return { ok: true, logs: [`已挂载分区 ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')}（${p.files} 个文件 / ${p.rows} 行）`], warnings: [] };
}

// ── SELECT ─────────────────────────────────────────────────────
function runSelect(ctx, sql) {
  const tr = translate(sql);
  const r = ctx.db.query(tr.sql);
  const logs = [`查询返回 ${r.rows.length} 行 / ${r.columns.length} 列`];
  if (r.rows.length > 500) logs.push('结果超过 500 行，页面只展示前 500 行（可加 LIMIT）');
  return {
    ok: true, columns: r.columns, rows: r.rows.slice(0, 500), rowCount: r.rows.length,
    logs, warnings: [], scalar: scalar(r),
  };
}

function tableMap(ctx) {
  const map = { ...(ctx.schema ?? {}) };
  for (const t of ctx.warehouse?.list() ?? []) map[`${t.db}.${t.table}`] = t.columns;
  return map;
}

/** 数仓 + 业务库的完整清单（给左侧表树 / 数据地图用），带中文名与表含义 */
export function listAllTables(ctx) {
  const groups = { business: [], ods: [], dwd: [], dws: [], ads: [], other: [] };
  const tc = ctx.tableComments ?? {};
  for (const [name, cols] of Object.entries(ctx.schema ?? {})) {
    if (ctx.db.hasTable(name)) {
      groups.business.push({
        name, db: '业务库', cn: tc[name]?.cn ?? '', comment: tc[name]?.desc ?? '',
        rows: ctx.db.rowCount(name), columns: cols, partitionedBy: [],
      });
    }
  }
  for (const t of ctx.warehouse.list()) {
    const full = `${t.db}.${t.table}`;
    const g = groups[t.db] ?? groups.other;
    g.push({
      name: full, db: t.db,
      cn: tc[t.table]?.cn ?? '',
      comment: t.comment || (tc[t.table]?.desc ?? ''),
      rows: ctx.db.rowCount(sqliteNameSafe(full)),
      columns: t.columns, partitionedBy: t.partitionColumns,
      partitions: ctx.warehouse.partitionsOf(t.db, t.table).map((p) => p.values),
      location: t.location, format: t.format,
    });
  }
  return groups;
}

const sqliteNameSafe = (s) => s.replace(/\./g, '__');
