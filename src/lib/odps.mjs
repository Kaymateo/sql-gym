/**
 * ODPS / MaxCompute 作业模型
 * ------------------------------------------------------------------
 * 对齐 DataWorks 的核心概念：
 *   项目空间(project) → 节点(node) → 提交作业 → 实例(instance) → Logview 日志
 *                                              ↘ 产出分区表 / 执行计划
 *
 * 与真实 ODPS 的差异（诚实边界）：执行引擎是 SQLite，执行计划由 EXPLAIN QUERY PLAN 翻译而来，
 * 分阶段进度是模拟的。但「作业 → 实例 → 日志 → 产出」这条链路是真的。
 */

import { runStatement } from './console.mjs';
import { translate, stripLeadingComments } from './dialect.mjs';

export const NODE_TYPES = {
  odps_sql: { label: 'ODPS SQL', icon: 'SQL', runnable: true },
  di: { label: '数据集成', icon: 'DI', runnable: true },
  shell: { label: 'Shell', icon: 'SH', runnable: false },
  virtual: { label: '虚拟节点', icon: 'VN', runnable: true },
};

export const FOLDERS = ['数据集成', 'ODS层', 'DWD层', 'DWS层', 'ADS层', '临时'];

let SEQ = 0;
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 生成 ODPS 风格实例 ID：yyyymmddhhmmss + 3 位序号 */
export function makeInstanceId(d = new Date()) {
  SEQ += 1;
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(SEQ % 1000, 3)}`;
}

/** SQLite 执行计划 → 人话 */
export function humanizePlan(planRows) {
  const out = [];
  for (const r of planRows) {
    const d = String(r.detail ?? r[3] ?? '');
    if (/^SCAN TABLE (.+)$/i.test(d)) {
      const t = d.match(/^SCAN TABLE (.+)$/i)[1];
      out.push(`全表扫描 ${t}${/meter_readings|transactions/.test(t) ? '（大表，注意分区裁剪）' : ''}`);
    } else if (/^SCAN (.+) AS (.+)$/i.test(d)) {
      const m = d.match(/^SCAN (.+) AS (.+)$/i);
      out.push(`全表扫描 ${m[1]}（别名 ${m[2]}）`);
    } else if (/^SEARCH (.+) USING (COVERING )?INDEX (.+)$/i.test(d)) {
      const m = d.match(/^SEARCH (.+) USING (COVERING )?INDEX (.+)$/i);
      out.push(`索引查找 ${m[1]}${m[2] ? '（覆盖索引）' : ''}：${m[3]}`);
    } else if (/TEMP B-TREE FOR (.+)$/i.test(d)) {
      out.push(`临时 B 树：${d.match(/TEMP B-TREE FOR (.+)$/i)[1]}（数据量大时会落磁盘，是性能瓶颈点）`);
    } else if (/^USE TEMP B-TREE/i.test(d)) {
      out.push(`临时 B 树排序（性能瓶颈点）`);
    } else if (/SUBQUERY|CO-ROUTINE/i.test(d)) {
      out.push(`子查询/CTE 物化：${d.replace(/^CO-ROUTINE\s*/i, '')}`);
    } else if (/^SCAN SUBQUERY/i.test(d)) {
      out.push(`扫描子查询结果（会物化中间结果）`);
    } else {
      out.push(d);
    }
  }
  return out;
}

/** 取执行计划（真实 EXPLAIN，失败则忽略） */
export function explain(ctx, sql) {
  let translated;
  try {
    translated = translate(sql);              // 必须先过方言层：ods.x → ods__x
  } catch {
    return [];
  }
  const probe = stripLeadingComments(translated.sql);
  if (!/^(select|with)/i.test(probe)) return [];
  try {
    const r = ctx.db.query(`EXPLAIN QUERY PLAN ${probe.replace(/;\s*$/, '')}`);
    return humanizePlan(r.rows.map((row) => ({ detail: row[row.length - 1] })));
  } catch {
    return [];
  }
}

/** 解析作业涉及的源表/目标表（写日志用） */
function tablesIn(sql) {
  const src = new Set();
  const re = /\b(?:from|join)\s+([a-zA-Z_][\w.]*)/gi;
  let m;
  while ((m = re.exec(sql))) src.add(m[1]);
  const ins = String(sql).match(/insert\s+(?:overwrite|into)\s+(?:table\s+)?([\w.]+)/i);
  const ddl = String(sql).match(/create\s+(?:external\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w.]+)/i);
  return { sources: [...src], target: ins ? ins[1] : (ddl ? ddl[1] : null) };
}

/** 进度条字符串（Logview 里那种） */
export function progressBar(stage, pct) {
  const w = 20;
  const filled = Math.round((w * pct) / 100);
  return `Stage ${stage}: ${'▓'.repeat(filled)}${'░'.repeat(w - filled)} ${String(pct).padStart(3)}%`;
}

/**
 * 提交并执行一个节点作业 → 返回实例对象
 * @returns {{id,nodeName,type,status,startTs,durationMs,logs,result,planRows,output}}
 */
export function submit(ctx, node, opts = {}) {
  const id = makeInstanceId();
  const t0 = Date.now();
  const logs = [];
  const push = (level, msg) => logs.push({ level, msg, ts: Date.now() });

  push('INFO', `提交作业：${node.name}（项目空间 ${opts.project ?? 'default'}）`);
  push('INFO', `InstanceId: ${id}`);
  push('INFO', `作业类型：${NODE_TYPES[node.type]?.label ?? node.type}`);

  if (node.type === 'shell' || node.type === 'virtual') {
    push('INFO', '虚拟/Shell 节点：仅参与调度依赖，不产生数据');
    return {
      id, nodeName: node.name, type: node.type, status: 'SUCCESS', startTs: t0,
      durationMs: Date.now() - t0, logs, result: null, planRows: [],
      output: { table: null, rows: 0 },
    };
  }

  if (node.type === 'di') {
    // 数据集成节点：走 DataX 配置，产出到 ODS 分区
    const { sources, target } = tablesIn(String(node.meta?.sql ?? ''));
    push('INFO', `数据集成任务：reader=${node.meta?.reader ?? 'mysqlreader'} → writer=${node.meta?.writer ?? 'hdfswriter'}`);
    const res = node.meta?.sql ? runStatement(ctx, node.meta.sql) : { ok: true, rowCount: 0, logs: [] };
    for (const l of res.logs ?? []) push('INFO', l);
    const ok = res.ok !== false;
    if (!ok) push('ERROR', res.error?.message ?? '数据集成失败');
    push(ok ? 'INFO' : 'ERROR', ok ? 'OK：同步完成' : '作业失败');
    return {
      id, nodeName: node.name, type: node.type, status: ok ? 'SUCCESS' : 'FAILED', startTs: t0,
      durationMs: Date.now() - t0, logs, result: res, planRows: [],
      output: { table: target ?? null, rows: res.rowCount ?? 0, sources },
    };
  }

  // ODPS SQL 节点
  const sql = String(node.code ?? '');
  push('INFO', 'SQL 编译中…');
  const { sources, target } = tablesIn(sql);
  if (sources.length) push('INFO', `源表：${sources.join(', ')}`);

  const planRows = explain(ctx, sql);
  if (planRows.length) {
    push('INFO', '执行计划：');
    planRows.forEach((p, i) => push('INFO', `  ${i + 1}. ${p}`));
  }

  const res = runStatement(ctx, sql, { expect: node.expect });
  const isWrite = res.kind === 'write';

  if (!res.ok) {
    push('ERROR', `${res.error?.stage ? `[${res.error.stage}] ` : ''}${res.error?.message ?? '执行失败'}`);
    if (res.error?.hint) push('WARN', res.error.hint);
    push('ERROR', '作业失败');
    return {
      id, nodeName: node.name, type: node.type, status: 'FAILED', startTs: t0,
      durationMs: Date.now() - t0, logs, result: res, planRows, output: { table: target, rows: 0, sources },
    };
  }

  if (isWrite) {
    push('INFO', progressBar(1, 20));
    push('INFO', `Stage 1: 读取 ${sources.join(', ')}`);
    push('INFO', progressBar(1, 100));
    push('INFO', progressBar(2, 100));
    push('INFO', `OK: ${res.write.rows} 行写入 ${res.write.table} 分区 ${JSON.stringify(res.write.partition ?? {})}`);
    push('INFO', `产出目录：${res.write.dirs?.[0] ?? '-'}`);
    push('INFO', `作业结束，累计耗时 ${Date.now() - t0} ms`);
    return {
      id, nodeName: node.name, type: node.type, status: 'SUCCESS', startTs: t0,
      durationMs: Date.now() - t0, logs, result: res, planRows,
      output: { table: res.write.table, rows: res.write.rows, partition: res.write.partition, sources },
    };
  }

  push('INFO', `OK: 查询返回 ${res.rowCount} 行 / ${res.columns.length} 列`);
  push('INFO', `作业结束，累计耗时 ${Date.now() - t0} ms`);
  return {
    id, nodeName: node.name, type: node.type, status: 'SUCCESS', startTs: t0,
    durationMs: Date.now() - t0, logs, result: res, planRows,
    output: { table: null, rows: res.rowCount, columns: res.columns, sources },
  };
}

// ────────────────────────── 调度 ──────────────────────────

/** cron 5 段 → 一天内的触发时刻（仅支持常见形态，够教学用） */
export function cronTimes(cron) {
  const [mi, ho] = String(cron).trim().split(/\s+/);
  const hours = expand(ho, 0, 23);
  const mins = expand(mi, 0, 59);
  const out = [];
  for (const h of hours) for (const m of mins) out.push([h, m]);
  return out.length ? out : [[0, 0]];
}

function expand(field, lo, hi) {
  const out = [];
  for (const part of String(field).split(',')) {
    if (part === '*') { for (let i = lo; i <= hi; i += 1) out.push(i); continue; }
    const step = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (step) {
      const [a, b] = step[1] === '*' ? [lo, hi] : step[1].split('-').map(Number);
      for (let i = a; i <= b; i += Number(step[2])) out.push(i);
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) { for (let i = Number(range[1]); i <= Number(range[2]); i += 1) out.push(i); continue; }
    if (/^\d+$/.test(part)) out.push(Number(part));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * 生成周期实例（运维中心用）
 * 过去的时间点 = 已运行（成功/失败），今天尚未到点 & 次日预生成的 = 等待调度
 * 真实 DataWorks 也会预生成次日实例，这里保持一致。
 */
export function cycleInstances(nodes, opts = {}) {
  const { days = 3, now = new Date(), bizDate = null } = opts;
  const base = bizDate ? new Date(bizDate) : now;
  const insts = [];
  for (const n of nodes) {
    const sch = n.schedule ?? {};
    if (sch.enabled === false) continue;
    for (let d = days - 1; d >= -1; d -= 1) {   // -1 = 次日预生成
      const day = new Date(base);
      day.setDate(day.getDate() - d);
      for (const [h, m] of cronTimes(sch.cron ?? '0 8 * * *')) {
        const at = new Date(day);
        at.setHours(h, m, 0, 0);
        const past = at.getTime() < now.getTime();
        insts.push({
          id: `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(h)}${pad(m)}${pad(insts.length % 1000, 3)}`,
          nodeName: n.name,
          folder: n.folder,
          bizDate: fmtDate(day),
          scheduledAt: `${fmtDate(day)} ${pad(h)}:${pad(m)}`,
          cron: sch.cron,
          deps: sch.deps ?? [],
          status: past ? 'SUCCESS' : 'WAIT',
          simulated: past,
          durationMs: past ? 400 + ((n.name.length * 137) % 2600) : null,
        });
      }
    }
  }
  return insts.sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1));
}

/** 补数据：按日期区间对节点重跑（真的把分区换成目标日期执行） */
export function backfill(ctx, node, { start, end }) {
  const out = [];
  const d0 = new Date(start);
  const d1 = new Date(end);
  for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
    const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    let code = node.code ?? '';
    // 把第一个分区字面量替换为目标业务日期（真实补数据就是这么干的）
    const replaced = code.replace(/(partition\s*\(\s*\w+\s*=\s*')[^']+(')/i, `$1${ymd}$2`);
    const changed = replaced !== code;
    const res = runStatement(ctx, replaced);
    out.push({
      bizDate: fmtDate(d),
      partition: ymd,
      status: res.ok ? 'SUCCESS' : 'FAILED',
      rows: res.write?.rows ?? res.rowCount ?? 0,
      message: res.ok ? (changed ? `已重跑分区 ${ymd}` : '无分区字面量，按原样执行') : (res.error?.message ?? '失败'),
    });
  }
  return out;
}

/** 节点间依赖拓扑（数据开发里的依赖关系图） */
export function dependencyGraph(nodes) {
  const names = nodes.map((n) => n.name);
  return nodes.map((n) => ({
    name: n.name,
    folder: n.folder,
    deps: (n.schedule?.deps ?? []).filter((d) => names.includes(d)),
    missing: (n.schedule?.deps ?? []).filter((d) => !names.includes(d)),
  }));
}
