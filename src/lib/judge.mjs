/**
 * 判题器（结果集比对）
 * ------------------------------------------------------------------
 * 设计原则（PRD 6.3）：
 *   比对"结果集"而不是"SQL 文本" → 用 JOIN 写的和用子查询写的都应判过。
 *   列名不敏感（按列位置比）、行顺序默认不敏感（题目可要求有序）、
 *   NULL = NULL、浮点按精度四舍五入后比较、字符串去首尾空格。
 * 三态反馈：pass / close（接近，给差异单元格）/ fail（给明确原因）
 */

export const R = {
  pass: 'pass',
  close: 'close',
  fail: 'fail',
};

function normCell(v, precision) {
  if (v === null || v === undefined) return '\u0000NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    const p = precision ?? 4;
    // 整数与浮点视为相等：3 与 3.0000 → 同一个 key
    const r = Number(v.toFixed(p));
    return String(r === 0 ? 0 : r);
  }
  const s = String(v).trim();
  // 数字字符串（SQLite 有时把 REAL 读成字符串）统一当数字处理
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const r = Number(Number(s).toFixed(precision ?? 4));
    return String(r === 0 ? 0 : r);
  }
  return s;
}

/** 把结果集归一化成可比较的行键 */
export function normalizeRows(rows, opts = {}) {
  const { precision = 4, caseSensitive = true } = opts;
  return rows.map((r) => r.map((c) => {
    const k = normCell(c, precision);
    return caseSensitive ? k : k.toLowerCase();
  }));
}

const rowKey = (r) => r.join('\u0001');

/**
 * 比对结果集
 * @param {{columns:string[], rows:any[][]}} actual   用户结果
 * @param {{columns:string[], rows:any[][], orderSensitive?:boolean, precision?:number, rowCount?:number}} expected
 */
export function compareResults(actual, expected) {
  const opts = { precision: expected.precision ?? 4, caseSensitive: expected.caseSensitive ?? true };
  const expCols = expected.columns ?? [];
  const actCols = actual.columns ?? [];

  if (actCols.length !== expCols.length) {
    return {
      status: R.fail,
      reason: 'column_count',
      message: `你返回了 ${actCols.length} 列，题目要求 ${expCols.length} 列。`,
      hint: colCountHint(actCols.length, expCols.length),
    };
  }

  const expRows = normalizeRows(expected.rows, opts);
  const actRows = normalizeRows(actual.rows, opts);

  if (expRows.length !== actRows.length) {
    return {
      status: R.fail,
      reason: 'row_count',
      message: `你返回了 ${actRows.length} 行，期望 ${expRows.length} 行。`,
      hint: rowCountHint(actRows.length, expRows.length),
    };
  }

  if (expected.orderSensitive) {
    for (let i = 0; i < expRows.length; i += 1) {
      if (rowKey(expRows[i]) !== rowKey(actRows[i])) {
        return closeResult(actRows, expRows, i, expected);
      }
    }
  } else {
    const ec = new Map();
    expRows.forEach((r) => ec.set(rowKey(r), (ec.get(rowKey(r)) ?? 0) + 1));
    const matched = [];
    for (let i = 0; i < actRows.length; i += 1) {
      const k = rowKey(actRows[i]);
      if ((ec.get(k) ?? 0) > 0) { ec.set(k, ec.get(k) - 1); matched.push(i); }
    }
    if (matched.length !== expRows.length) {
      const missIdx = actRows.findIndex((_r, i) => !matched.includes(i));
      return closeResult(actRows, expRows, missIdx < 0 ? 0 : missIdx, expected);
    }
  }

  return { status: R.pass, message: '结果集完全一致，通过！' };
}

function closeResult(actRows, expRows, rowIdx, expected) {
  const diffs = [];
  const n = expected.columns.length;
  const a = actRows[rowIdx] ?? [];
  // 找期望里最接近的一行做对照，便于定位差异列
  let best = expRows[rowIdx] ?? expRows[0] ?? [];
  if (actRows.length === 1 && expRows.length === 1) best = expRows[0];
  for (let c = 0; c < n; c += 1) {
    if ((a[c] ?? '') !== (best[c] ?? '')) {
      diffs.push({ row: rowIdx, col: c, column: expected.columns[c], got: a[c] ?? null, want: best[c] ?? null });
    }
  }
  const first = diffs[0];
  return {
    status: R.close,
    reason: 'value_diff',
    message: first
      ? `行列数都对，但有 ${diffs.length} 个单元格不匹配。第一个差异：第 ${first.row + 1} 行「${first.column}」你得到 ${fmt(first.got)}，期望 ${fmt(first.want)}。`
      : '行列数都对，但内容有差异，检查一下过滤条件或聚合口径。',
    diffs,
    hint: '常见原因：口径没对齐（该剔除的没剔除 / 该保留的被过滤掉）、聚合前没去重、单位没换算。',
  };
}

function fmt(v) {
  if (v === '\u0000NULL') return 'NULL';
  return String(v);
}

function colCountHint(got, want) {
  if (got > want) return '多返回了列：检查 SELECT 里是不是把所有字段都写出来了，题目只要求指定的几列。';
  return '少返回了列：检查是否漏了某个统计指标（例如要求同时输出分子和分母）。';
}

function rowCountHint(got, want) {
  if (got > want) return '行数偏多：常见原因是 JOIN 产生了重复（一对多未去重），或少了筛选条件（如未剔除已取消/销户数据）。';
  return '行数偏少：常见原因是用了 INNER JOIN 丢掉了不匹配的行（该用 LEFT JOIN），或过滤条件太严。';
}

/** 结果集转 CSV（导出用） */
export function toCsv(columns, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}
