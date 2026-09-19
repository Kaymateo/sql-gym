/**
 * 判题器（练习题库用）
 * ------------------------------------------------------------------
 * 判题思路：**用参考解当标尺** —— 先跑参考解拿到期望结果集，再和你的结果集比对。
 *   好处①：不用手写期望值，题库与数据永远自洽
 *   好处②：天然支持多解（JOIN 写的和子查询写的、列名不同、行序不同都算对）
 * 两类题：
 *   query —— 比对结果集（列数必须一致；列名/行序不敏感；NULL 相等；浮点按精度比）
 *   write —— 校验产出表的行数（判断题：数据有没有真的写对）
 */

import { runStatement } from './console.mjs';
import { compareResults, R } from './judge.mjs';
import { sqliteize } from './dialect.mjs';

const sqlName = (t) => String(t).replace(/\./g, '__');

/** 跑参考解，得到期望结果（题库自洽性由 scripts/check_problems.mjs 保证） */
export function expectedResult(ctx, problem) {
  const ref = runStatement(ctx, problem.solution);
  if (!ref.ok) {
    return { ok: false, message: `参考解执行失败：${ref.error?.message ?? '未知错误'}` };
  }
  return {
    ok: true,
    result: {
      columns: ref.columns,
      rows: ref.rows,
      orderSensitive: problem.orderSensitive ?? false,
      precision: problem.precision ?? 4,
    },
  };
}

/**
 * 判一道题
 * @returns {{status:'pass'|'close'|'fail'|'partial', stage?, message, hint?, diff?, detail?}}
 */
export function gradeProblem(ctx, problem, userSql) {
  const sql = String(userSql ?? '').trim();
  if (!sql) return { status: 'fail', stage: 'lint', message: '还没有写 SQL' };

  if (problem.kind === 'write') return gradeWrite(ctx, problem, sql);

  const exp = expectedResult(ctx, problem);
  if (!exp.ok) return { status: 'fail', message: exp.message, hint: '（这是题库的问题，请反馈）' };

  const act = runStatement(ctx, sql);
  if (!act.ok) {
    return {
      status: 'fail', stage: act.error?.stage ?? 'run',
      message: act.error?.message ?? '执行失败',
      hint: act.error?.hint ?? '',
    };
  }

  const cmp = compareResults({ columns: act.columns, rows: act.rows }, exp.result);
  return {
    ...cmp,
    stage: cmp.status === 'pass' ? 'done' : 'check',
    expectedColumns: problem.expectedColumns ?? [],
    gotColumns: act.columns,
    expectedRows: exp.result.rows.length,
    gotRows: act.rows.length,
    preview: act.rows.slice(0, 10),
  };
}

/** 写入题：先看是不是只建了表，再看产出表行数对不对 */
function gradeWrite(ctx, problem, sql) {
  const act = runStatement(ctx, sql);
  if (!act.ok) {
    return { status: 'fail', stage: act.error?.stage ?? 'run', message: act.error?.message ?? '执行失败', hint: act.error?.hint ?? '' };
  }
  const spec = problem.writeCheck ?? {};
  const table = spec.table;
  const sName = sqlName(table);

  if (!ctx.db.hasTable(sName)) {
    return {
      status: 'partial', stage: 'check',
      message: `执行成功，但还没看到产出表 ${table}。第一步要先建表（CREATE EXTERNAL TABLE ...），再写入。`,
      hint: problem.hints?.[0] ?? '',
    };
  }
  if (act.rowCount === 0 && act.kind !== 'write') {
    return { status: 'partial', stage: 'check', message: `表 ${table} 已就绪，接下来写 INSERT OVERWRITE 把数据写进分区。` };
  }

  const partCols = Object.keys(spec.partition ?? {});
  const where = partCols.length ? ` WHERE ${partCols.map((p) => `${p} = ?`).join(' AND ')}` : '';
  let actual;
  let expected;
  try {
    actual = ctx.db.query(`SELECT COUNT(*) FROM ${sName}${where}`,
      partCols.length ? partCols.map((p) => spec.partition[p]) : undefined).rows[0][0];
    expected = ctx.db.query(sqliteize(spec.expectedCountSql)).rows[0][0];
  } catch (e) {
    return { status: 'fail', stage: 'check', message: `产出表校验失败：${e.message}`, hint: '检查建表字段与 SELECT 输出列是否一致' };
  }

  if (actual === expected) {
    return {
      status: 'pass', stage: 'done',
      message: `通过！${table} 分区 ${JSON.stringify(spec.partition ?? {})} 共 ${actual} 行，与期望一致。`,
      detail: { table, rows: actual },
    };
  }
  return {
    status: 'close', stage: 'check',
    message: `产出行数不对：${table} 里查到 ${actual} 行，期望 ${expected} 行。`,
    hint: actual > expected
      ? '多了：检查过滤条件是否漏了（估抄 / 冲正 / 失效数据都要剔除）'
      : '少了：检查是不是过滤过头了，或者 JOIN 用了 INNER 丢掉了不匹配的行',
    detail: { table, rows: actual, expected },
  };
}

/** 练习进度统计（前端展示用） */
export function summarize(problems, progress = {}) {
  const byLevel = {};
  let done = 0;
  for (const p of problems) {
    byLevel[p.level] ??= { total: 0, done: 0 };
    byLevel[p.level].total += 1;
    if (progress[p.id] === 'pass') { byLevel[p.level].done += 1; done += 1; }
  }
  return { total: problems.length, done, byLevel };
}
