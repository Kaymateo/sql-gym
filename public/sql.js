/**
 * SQL 练习场前端：题库 + 判题 + 表树 + 结果
 * 引擎（console/grade/problems/scene）是纯 ESM，浏览器直接跑，与 Node 自检共用同一套代码。
 */
import { loadSqlJs, Db } from '/src/lib/db.mjs';
import { VFS } from '/src/lib/vfs.mjs';
import { Warehouse } from '/src/lib/hive.mjs';
import { runStatement, listAllTables } from '/src/lib/console.mjs';
import { seedWarehouse, SCENES, applySchemaDoc } from '/src/lib/scene.mjs';
import { PROBLEMS, SHOWCASE_SQL } from '/src/lib/problems.mjs';
import { gradeProblem, summarize } from '/src/lib/grade.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Number(n ?? 0).toLocaleString();

const SNIPPETS = [
  ['查前 20 行', () => 'SELECT * FROM ods.customers LIMIT 20'],
  ['分组聚合', () => 'SELECT c.cust_type, COUNT(*) AS cnt\nFROM ods.customers c\nGROUP BY c.cust_type\nORDER BY cnt DESC'],
  ['JOIN 三张表', () => `SELECT c.cust_type, SUM(r.usage_kwh) AS kwh
FROM ods.meter_readings r
JOIN ods.meters    m ON m.meter_id    = r.meter_id
JOIN ods.customers c ON c.customer_id = m.customer_id
WHERE r.dt = '202403'
GROUP BY c.cust_type`],
  ['窗口函数排名', () => `SELECT customer_id, kwh,
       ROW_NUMBER() OVER (ORDER BY kwh DESC) AS rn
FROM (SELECT customer_id, SUM(usage_kwh) AS kwh
      FROM ods.meter_readings JOIN ods.meters USING (meter_id)
      GROUP BY customer_id) t
LIMIT 10`],
  ['建数仓表', () => `CREATE EXTERNAL TABLE dwd.my_table (
  id BIGINT COMMENT '主键',
  amount DOUBLE COMMENT '金额'
)
COMMENT '我的明细表'
PARTITIONED BY (dt STRING COMMENT '分区日期')
STORED AS PARQUET
LOCATION '/user/hive/warehouse/dwd.db/my_table'`],
  ['写分区（产生数据）', () => `INSERT OVERWRITE TABLE dwd.my_table PARTITION (dt='202403')
SELECT reading_id, usage_kwh
FROM ods.meter_readings
WHERE dt = '202403'`],
];

const S = { scene: 'power', ctx: null, buffer: null, tab: 'result', last: null, history: [], busy: false,
  problem: null, hints: 0, attempts: 0, progress: {}, grade: null };

// ────────── 启动 ──────────
async function boot() {
  $('btnRun').onclick = $('btnRun2').onclick = () => runSql(false);
  $('btnSubmit').onclick = $('btnSubmit2').onclick = () => runSql(true);
  $('btnClear').onclick = () => { $('sql').value = ''; };
  $('btnShowcase').onclick = () => { $('sql').value = SHOWCASE_SQL; S.problem = null; renderProblemBox(); renderProbList(); };
  $('btnReset').onclick = () => loadScene(S.scene, { keepEditor: true });
  $('scene').onchange = (e) => { S.scene = e.target.value; loadProject(); };
  $('sql').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(e.shiftKey); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.target;
      const at = el.selectionStart;
      el.value = `${el.value.slice(0, at)}  ${el.value.slice(el.selectionEnd)}`;
      el.selectionStart = el.selectionEnd = at + 2;
    }
  });
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      S.tab = b.dataset.tab;
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
      renderPane();
    };
  });
  await loadProject();
}

async function loadProject(opts = {}) {
  const scene = S.scene;
  $('sceneInfo').textContent = '加载数据中…';
  $('btnRun').disabled = true;
  const [buf, schemaDoc] = await Promise.all([
    fetch(`/data/${scene}/${scene}.sqlite`).then((r) => r.arrayBuffer()),
    fetch(`/data/${scene}/schema.json`).then((r) => r.json()),
  ]);
  S.buffer = buf;
  const SQL = await loadSqlJs((f) => `/vendor/${f}`);
  const vfs = new VFS();
  S.ctx = applySchemaDoc({
    db: new Db(new SQL.Database(new Uint8Array(buf))), vfs,
    warehouse: new Warehouse(vfs), state: new Map(),
  }, schemaDoc);
  const seed = seedWarehouse(S.ctx, scene);
  S.progress = loadProgress(scene);
  S.problem = null; S.hints = 0; S.attempts = 0; S.grade = null; S.last = null;
  $('sceneInfo').textContent = `${SCENES[scene].label} · ODS 就绪 ${seed.tables} 张表 / ${fmt(seed.rows)} 行`;
  $('btnRun').disabled = false;
  $('btnSubmit').disabled = false;
  setStatus('就绪', '');
  if (!opts.keepEditor) $('sql').value = SHOWCASE_SQL;
  renderTree(); renderProbList(); renderProblemBox(); renderSnippets(); renderPane();
}
const loadScene = loadProject;

const progKey = (scene) => `sqlgym:prog:${scene}`;
function loadProgress(scene) {
  try { return JSON.parse(localStorage.getItem(progKey(scene)) ?? '{}'); } catch { return {}; }
}
function saveProgress() {
  try { localStorage.setItem(progKey(S.scene), JSON.stringify(S.progress)); } catch { /* 忽略 */ }
}

// ────────── 题库 ──────────
function renderProbList() {
  const list = PROBLEMS[S.scene] ?? [];
  const sum = summarize(list, S.progress);
  $('progText').textContent = `${sum.done}/${sum.total} 已通过`;
  $('progBar').style.width = `${sum.total ? (100 * sum.done) / sum.total : 0}%`;
  const byLevel = {};
  for (const p of list) (byLevel[p.level] ??= []).push(p);
  $('probList').innerHTML = Object.entries(byLevel).map(([lv, ps]) => `
    <div class="grp"><h2>${lv}</h2>
      ${ps.map((p) => {
    const solved = S.progress[p.id] === 'pass';
    return `<div class="prob ${S.problem?.id === p.id ? 'on' : ''} ${solved ? 'solved' : ''}" data-p="${p.id}">
        <span class="lv">${p.level}</span>
        <span class="tt">${esc(p.title)}</span>
        <span class="st">${solved ? '✅' : ''}</span></div>`;
  }).join('')}</div>`).join('');
  $('probList').querySelectorAll('[data-p]').forEach((el) => {
    el.onclick = () => selectProblem(el.dataset.p);
  });
}

function selectProblem(id) {
  const p = (PROBLEMS[S.scene] ?? []).find((x) => x.id === id);
  if (!p) return;
  S.problem = p; S.hints = 0; S.attempts = 0; S.grade = null;
  // 给一个起步骨架（引导但不给答案）
  $('sql').value = p.kind === 'write'
    ? `-- ${p.title}\n-- 提示：先建表，再 INSERT OVERWRITE 写入分区\n\n`
    : `-- ${p.title}\nSELECT\nFROM\nWHERE\n`;
  $('feedback').innerHTML = '';
  renderProbList(); renderProblemBox(); renderPane();
  $('sql').focus();
}

function renderProblemBox() {
  const p = S.problem;
  if (!p) {
    $('problemBox').innerHTML = `<div class="brief">
      <h4>从右侧题库选一道题开始</h4>
      <div class="bg">编辑器里已经放了一条「复杂示例 SQL」（台区线损全表体检：多层 CTE + 多表 JOIN + 窗口函数 + 异常打标），
      直接点「▶ 运行」就能看到结果。</div>
      <div class="bg">想刷题就点右侧题目 → 先自己写 → 「✓ 提交判题」→ 系统会告诉你差在哪。</div>
    </div>`;
    return;
  }
  const attemptsUsed = S.attempts;
  const hintsShown = S.hints;
  const canReveal = attemptsUsed >= 3 || hintsShown >= p.hints.length;
  $('problemBox').innerHTML = `
    <div class="brief">
      <h4>${esc(p.id)} · ${esc(p.title)} <span class="note">（${esc(p.level)}）</span></h4>
      ${p.background ? `<div class="bg">📖 ${esc(p.background)}</div>` : ''}
      <div class="req"><b>需求：</b>${esc(p.requirement)}</div>
      ${p.expectedColumns?.length ? `<div class="bg">期望输出列：${p.expectedColumns.map((c) => `<code>${esc(c)}</code>`).join(' ')}
        <span class="note">（列名不敏感，列数要对；行序不敏感）</span></div>` : ''}
      <div class="tags">${(p.points ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="bar" style="margin:7px 0 0">
        <button class="sm" id="btnHint">💡 提示 ${hintsShown}/${p.hints.length}</button>
        <button class="sm" id="btnSol" ${canReveal ? '' : 'disabled'}>${canReveal ? '📖 看参考答案' : '📖 参考答案（失败 3 次或看完提示后解锁）'}</button>
        <span class="note" style="margin:0">已提交 ${attemptsUsed} 次</span>
      </div>
      ${hintsShown ? `<div style="margin-top:7px">${p.hints.slice(0, hintsShown).map((h, i) => `<div class="msg hint">提示 ${i + 1}：${esc(h)}</div>`).join('')}</div>` : ''}
    </div>`;
  $('btnHint').onclick = () => { S.hints = Math.min(S.hints + 1, p.hints.length); renderProblemBox(); };
  $('btnSol').onclick = () => {
    $('sql').value = p.solution;
    $('feedback').innerHTML = '<div class="msg warn">📖 参考答案已填入编辑器。看懂之后建议清空自己重写一遍——照抄不算学会。</div>';
  };
}

// ────────── 运行 / 判题 ──────────
async function runSql(submit) {
  const text = $('sql').value.trim();
  if (!text || S.busy) return;
  S.busy = true;
  const res = runStatement(S.ctx, text);
  S.last = res;
  $('runInfo').textContent = `${res.ms}ms · ${fmt(res.rowCount)} 行`;
  setStatus(res.ok ? (res.write ? `✅ 已写入 ${fmt(res.write.rows)} 行` : `✅ 返回 ${fmt(res.rowCount)} 行`) : '❌ 执行失败',
    res.ok ? 'ok' : 'err');
  pushHistory(text, res);
  renderFeedback(res);

  if (submit) {
    if (!S.problem) {
      $('feedback').innerHTML += '<div class="msg warn">先到右侧题库选一道题，再点「提交判题」。</div>';
    } else if (text === S.problem.solution) {
      $('feedback').innerHTML = '<div class="msg warn">这是参考答案本身，直接提交不算通过哦——清空自己写一遍。</div>';
    } else {
      S.attempts += 1;
      const g = gradeProblem(S.ctx, S.problem, text);
      S.grade = g;
      if (g.status === 'pass') {
        S.progress[S.problem.id] = 'pass';
        saveProgress();
      }
      renderGrade(g);
      renderProbList(); renderProblemBox();
    }
  }
  S.busy = false;
  renderTree(); renderPane();
}

function renderFeedback(res) {
  const box = $('feedback');
  const head = $('problemBox');
  const extra = head?.querySelector('.msg.err') ? '' : '';
  if (res.ok && res.write) {
    box.innerHTML = `<div class="msg ok">✅ 已写入 <b>${fmt(res.write.rows)}</b> 行 → <code>${esc(res.write.table)}</code>
      分区 ${esc(Object.entries(res.write.partition ?? {}).map(([k, v]) => `${k}=${v}`).join(',') || '-')}</div>${extra}`;
  } else if (res.ok) {
    box.innerHTML = `<div class="msg ok">✅ ${esc(res.logs?.[0] ?? '执行成功')}</div>${extra}`;
  } else {
    box.innerHTML = `<div class="msg err">✖ ${esc(res.error?.message ?? '执行失败')}</div>`
      + (res.error?.hint ? `<div class="msg hint">💡 ${esc(res.error.hint)}</div>` : '');
  }
}

function renderGrade(g) {
  const box = $('feedback');
  const icon = g.status === 'pass' ? '✅' : g.status === 'close' ? '🟡' : g.status === 'partial' ? '🔶' : '🔴';
  const cls = g.status === 'pass' ? 'ok' : g.status === 'close' || g.status === 'partial' ? 'close' : 'err';
  let html = `<div class="msg ${cls}">${icon} <b>${g.status === 'pass' ? '通过！' : g.status === 'close' ? '很接近了' : g.status === 'partial' ? '进行中' : '未通过'}</b>　${esc(g.message ?? '')}`;
  if (g.expectedRows !== undefined && g.status !== 'pass') {
    html += `<div class="mono" style="color:var(--dim)">期望 ${g.expectedRows} 行 / 你返回 ${g.gotRows} 行`;
    if (g.expectedColumns?.length) html += `　期望列：${g.expectedColumns.map(esc).join(', ')}`;
    if (g.gotColumns?.length) html += `　你返回列：${g.gotColumns.map(esc).join(', ')}`;
    html += '</div>';
  }
  html += '</div>';
  if (g.hint) html += `<div class="msg hint">💡 ${esc(g.hint)}</div>`;
  if (g.diffs?.length) {
    html += `<div class="msg warn">差异明细（前 8 条）：${g.diffs.slice(0, 8).map((d) =>
      `<div class="mono">第 ${d.row + 1} 行「${esc(d.column)}」你得到 ${esc(d.got)}，期望 ${esc(d.want)}</div>`).join('')}</div>`;
  }
  if (g.preview?.length && g.status !== 'pass') {
    const cols = g.gotColumns ?? [];
    html += `<div class="msg"><b>你的结果（前 ${g.preview.length} 行）</b>
      <div class="scroll" style="margin-top:5px;max-height:170px"><table class="res"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${g.preview.map((r) => `<tr>${r.map((v) => (v === null ? '<td class="null">NULL</td>' : `<td>${esc(v)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  }
  box.innerHTML += html;
}

function pushHistory(sql, res) {
  S.history.unshift({ sql, ok: res.ok, at: new Date().toLocaleTimeString('zh-CN') });
  S.history = S.history.slice(0, 30);
}
function setStatus(t, c) { $('status').className = `pill ${c}`; $('status').textContent = t; }

// ────────── 结果面板 ──────────
function renderPane() {
  const pane = $('pane');
  const res = S.last;
  const ctx = S.ctx;
  if (S.tab === 'hdfs') {
    const files = ctx.vfs.findFiles('/user/hive');
    pane.innerHTML = files.length
      ? `<div class="tree">${files.map((f) => `${esc(f.path)}\n  ${f.format ?? ''}  ${f.rows != null ? `${f.rows} 行` : ''}`).join('\n')}</div>`
      : '<div class="empty">还没有产物。写一条 INSERT OVERWRITE 就会看到分区与 part 文件。</div>';
    return;
  }
  if (S.tab === 'warehouse') {
    const list = ctx.warehouse.list();
    pane.innerHTML = list.length ? list.map((t) => {
      const parts = ctx.warehouse.partitionsOf(t.db, t.table);
      return `<div class="msg"><b>${t.db}.${t.table}</b>
        <div class="mono" style="color:var(--dim)">${t.columns.length} 字段 · ${t.format} · ${esc(t.location)}</div>
        <div class="mono" style="color:var(--ok)">${parts.length ? `分区：${parts.map((p) => Object.values(p.values).join(',')).join(' | ')}` : '无分区'}</div></div>`;
    }).join('') : '<div class="empty">数仓里还没有表。</div>';
    return;
  }
  if (S.tab === 'dict') {
    const groups = listAllTables(ctx);
    const order = [['business', '业务库（源系统）'], ['ods', 'ODS 原始层'], ['dwd', 'DWD 明细层'], ['dws', 'DWS 汇总层'], ['ads', 'ADS 应用层'], ['other', '其他']];
    const html = order.map(([k, label]) => {
      const list = groups[k] ?? [];
      if (!list.length) return '';
      return `<h3>${label}</h3>${list.map((t) => `
        <div class="msg" style="margin-bottom:4px">
          <b>${esc(t.cn || '（无中文名）')}</b>　<span class="mono" style="color:var(--acc)">${esc(t.name)}</span>
          <span class="note">${fmt(t.rows)} 行</span>
          ${t.comment ? `<div style="color:var(--dim)">${esc(t.comment)}</div>` : ''}
          <div class="scroll" style="margin-top:5px;max-height:150px"><table class="res">
            <thead><tr><th>字段名</th><th>中文名</th><th>类型</th><th>业务含义</th></tr></thead>
            <tbody>${(t.columns ?? []).map((c) => (typeof c === 'string'
    ? `<tr><td class="mono">${esc(c)}</td><td></td><td></td><td></td></tr>`
    : `<tr><td class="mono">${esc(c.name)}</td><td>${esc(c.cn ?? '')}</td><td>${esc(c.type ?? '')}</td><td>${esc(c.comment ?? '')}</td></tr>`)).join('')}</tbody>
          </table></div>
        </div>`).join('')}`;
    }).join('');
    pane.innerHTML = html || '<div class="empty">没有可展示的表。</div>';
    return;
  }

  if (S.tab === 'history') {
    pane.innerHTML = S.history.length ? S.history.map((h, i) => `<div class="msg ${h.ok ? '' : 'err'}" data-i="${i}" style="cursor:pointer">
      <span class="mono" style="color:var(--dim)">${esc(h.at)}</span><div class="mono">${esc(h.sql.slice(0, 150))}</div></div>`).join('')
      : '<div class="empty">还没有执行记录。</div>';
    pane.querySelectorAll('[data-i]').forEach((el) => { el.onclick = () => { $('sql').value = S.history[Number(el.dataset.i)].sql; }; });
    return;
  }
  if (!res) { pane.innerHTML = '<div class="empty">运行 SQL 后这里显示结果。</div>'; return; }
  if (!res.ok) { pane.innerHTML = '<div class="msg err">执行失败，看上方提示。</div>'; return; }
  if (!res.columns.length) { pane.innerHTML = `<div class="msg ok">写入完成：${fmt(res.rowCount)} 行。</div>`; return; }
  const head = res.columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = res.rows.map((r) => `<tr>${r.map((v) => (v === null || v === undefined ? '<td class="null">NULL</td>'
    : `<td>${esc(typeof v === 'number' ? (Number.isInteger(v) ? v : Number(v.toFixed(4))) : v)}</td>`)).join('')}</tr>`).join('');
  pane.innerHTML = `<div class="scroll"><table class="res"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="note">共 ${fmt(res.rowCount)} 行，展示前 ${res.rows.length} 行；NULL 显示为灰色。</div>`;
}

// ────────── 表树 / 速查 ──────────
let treeOpen = new Set();
function renderTree() {
  const groups = listAllTables(S.ctx);
  const order = [['business', '业务库（源）'], ['ods', 'ODS 原始层'], ['dwd', 'DWD 明细层'], ['dws', 'DWS 汇总层'], ['ads', 'ADS 应用层'], ['other', '其他']];
  $('tree').innerHTML = order.map(([k, label]) => {
    const list = groups[k] ?? [];
    if (!list.length) return '';
    return `<div class="grp"><h2>${label}</h2>${list.map((t) => {
      const open = treeOpen.has(t.name);
      const cols = (t.columns ?? []).map((c) => {
        const cn = typeof c === 'string' ? c : c.name;
        if (typeof c === 'string') {
          return `<div class="colf" data-col="${esc(cn)}"><span class="cn">${esc(cn)}</span></div>`;
        }
        return `<div class="colf" data-col="${esc(cn)}" title="点击插入字段名">
          <span class="cn">${esc(cn)}</span> <span class="ct">${esc(c.type)}</span>
          ${c.cn ? `<span class="ct" style="color:var(--tx)">${esc(c.cn)}</span>` : ''}
          ${c.comment ? `<div class="cc">${esc(c.comment)}</div>` : ''}</div>`;
      }).join('');
      const pk = t.partitionedBy?.length ? ` <span style="color:var(--ok)">分区:${t.partitionedBy.map((p) => p.name).join(',')}</span>` : '';
      return `<div class="tbl" data-tbl="${esc(t.name)}" title="${esc(t.comment ?? '')}">
        <span style="color:${open ? 'var(--acc)' : 'var(--dim)'}">${open ? '▾' : '▸'}</span>
        <span class="nm">${t.cn ? `<b>${esc(t.cn)}</b>　` : ''}<span style="color:var(--dim)">${esc(t.name)}</span></span>
        <span class="rc">${fmt(t.rows)}</span></div>${pk}
        ${open && t.comment ? `<div class="cc" style="padding-left:16px;color:var(--dim)">${esc(t.comment)}</div>` : ''}
        ${open ? `<div class="cols">${cols}</div>` : ''}`;
    }).join('')}</div>`;
  }).join('');

  $('tree').querySelectorAll('.tbl').forEach((el) => {
    el.onclick = (e) => {
      const name = el.dataset.tbl;
      if (e.offsetX < 18) { treeOpen.has(name) ? treeOpen.delete(name) : treeOpen.add(name); renderTree(); return; }
      $('sql').value = `SELECT * FROM ${name} LIMIT 20`;
      $('sql').focus();
    };
  });
  $('tree').querySelectorAll('.colf').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const inp = $('sql');
      const at = inp.selectionStart ?? inp.value.length;
      inp.value = inp.value.slice(0, at) + el.dataset.col + inp.value.slice(at);
      inp.focus();
      inp.selectionStart = inp.selectionEnd = at + el.dataset.col.length;
    };
  });
}

function renderSnippets() {
  $('snippets').innerHTML = SNIPPETS.map(([label], i) => `<button class="sm" data-s="${i}" style="margin:0 4px 4px 0">${esc(label)}</button>`).join('');
  $('snippets').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const inp = $('sql');
      const at = inp.selectionStart ?? inp.value.length;
      inp.value = inp.value.slice(0, at) + SNIPPETS[Number(b.dataset.s)][1]() + inp.value.slice(at);
      inp.focus();
    };
  });
}

boot().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<div class="msg err" style="margin:14px">启动失败：${esc(e.message)}</div>`);
});
