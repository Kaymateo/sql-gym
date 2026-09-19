/**
 * 数据链路工作台 · 前端逻辑
 * 引擎模块（vfs/dialect/hive/pipeline/validators/judge）是纯 ESM，浏览器直接 import。
 */
import { loadSqlJs, Db } from '/src/lib/db.mjs';
import { VFS } from '/src/lib/vfs.mjs';
import { Warehouse } from '/src/lib/hive.mjs';
import { Pipeline, VALIDATORS, listNodeTypes } from '/src/lib/pipeline.mjs';
import '/src/lib/validators.mjs';            // 注册所有节点校验器（副作用导入）
import { compareResults } from '/src/lib/judge.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STAGE_LABEL = { lint: '语法', resolve: '语义', run: '执行', check: '产物', done: '完成', topology: '拓扑', dependency: '依赖' };
const TYPE_LABEL = {
  source_mysql: '业务库数据源', sqoop_import: 'Sqoop 导入', sqoop_export: 'Sqoop 导出',
  hive_create_table: 'Hive 建表', hive_sql: 'Hive/Spark SQL', datax_sync: 'DataX 同步',
  dag_schedule: '调度 DAG', export_mysql: '回写业务库', data_quality: '数据质量校验',
};

const state = {
  scene: 'power', ctx: null, nodes: [], selected: null, result: null, tab: 'logs', running: false,
};

// ─────────────────────────── 场景加载 ───────────────────────────
async function loadScene(scene) {
  $('sceneInfo').textContent = '加载数据中…';
  $('btnRun').disabled = true;
  const SQL = await loadSqlJs((f) => `/vendor/${f}`);
  const [dbBuf, schemaDoc] = await Promise.all([
    fetch(`/data/${scene}/${scene}.sqlite`).then((r) => r.arrayBuffer()),
    fetch(`/data/${scene}/schema.json`).then((r) => r.json()),
  ]);
  const raw = new SQL.Database(new Uint8Array(dbBuf));
  const vfs = new VFS();
  const warehouse = new Warehouse(vfs);
  state.ctx = { db: new Db(raw), vfs, warehouse, schema: schemaDoc.tables, state: new Map() };
  const total = Object.values(schemaDoc.row_counts ?? {}).reduce((a, b) => a + b, 0);
  $('sceneInfo').textContent = `${schemaDoc.table_count} 张表 / ${total.toLocaleString()} 行 / ${Object.keys(schemaDoc.tables).length} 张可查`;
  $('btnRun').disabled = false;
  state.result = null;
  renderResult();
}

// ─────────────────────────── 节点编辑 ───────────────────────────
function addNode(type) {
  const n = {
    id: `n${state.nodes.length + 1}`,
    type,
    title: TYPE_LABEL[type] ?? type,
    code: '',
    deps: state.nodes.length ? [state.nodes[state.nodes.length - 1].id] : [],
    expect: {},
  };
  state.nodes.push(n);
  state.selected = n.id;
  renderNodes();
  renderDetail();
}

function renderPalette() {
  $('palette').innerHTML = listNodeTypes()
    .map((t) => `<button data-type="${t}">${esc(TYPE_LABEL[t] ?? t)}</button>`).join('');
  $('palette').querySelectorAll('button').forEach((b) => {
    b.onclick = () => addNode(b.dataset.type);
  });
}

function renderNodes() {
  const list = $('nodeList');
  if (!state.nodes.length) {
    list.innerHTML = '<div class="empty">还没有节点。先「载入示例链路」或点上面的节点库添加。</div>';
    return;
  }
  const byId = Object.fromEntries((state.result?.nodes ?? []).map((r) => [r.id, r]));
  list.innerHTML = state.nodes.map((n, i) => {
    const r = byId[n.id];
    const st = r ? (r.status === 'pass' ? '✅' : r.status === 'close' ? '🟡' : r.status === 'skipped' ? '⏭' : '❌') : '';
    return `<div class="node ${state.selected === n.id ? 'sel' : ''}" data-id="${n.id}">
      <span class="idx">${i + 1}</span>
      <span class="ttl">${esc(n.title)}</span>
      <span class="st">${st}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.node').forEach((el) => {
    el.onclick = () => { state.selected = el.dataset.id; renderNodes(); renderDetail(); };
  });
}

function renderDetail() {
  const n = state.nodes.find((x) => x.id === state.selected);
  if (!n) { $('detail').innerHTML = '<div class="empty">左侧选择/添加一个节点开始。</div>'; return; }
  const r = (state.result?.nodes ?? []).find((x) => x.id === n.id);
  const others = state.nodes.filter((x) => x.id !== n.id);

  $('detail').innerHTML = `
    <h2>节点详情 · ${esc(TYPE_LABEL[n.type] ?? n.type)}</h2>
    <div class="row">
      <div class="field"><label>节点 ID</label><input value="${esc(n.id)}" disabled></div>
      <div class="field"><label>标题</label><input id="fTitle" value="${esc(n.title)}"></div>
    </div>
    <div class="field"><label>依赖（上游节点，可多选：按住 Ctrl/Cmd）</label>
      <select id="fDeps" multiple size="${Math.min(5, Math.max(2, others.length))}">
        ${others.map((o) => `<option value="${o.id}" ${n.deps.includes(o.id) ? 'selected' : ''}>${esc(o.id)} · ${esc(o.title)}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>代码 / 配置（Sqoop 命令、Hive SQL、DataX JSON、DAG JSON…）</label>
      <textarea id="fCode" spellcheck="false" placeholder="在此写这一环的代码">${esc(n.code)}</textarea>
    </div>
    <div class="row">
      <button id="btnApply" class="primary">保存节点</button>
      <button id="btnDel">删除节点</button>
    </div>
    <div class="note">提示：Hive SQL 支持 INSERT OVERWRITE ... PARTITION(dt='202403')；Sqoop 用 <code>\\</code> 换行。</div>
    <div id="nodeResult"></div>`;

  $('fTitle').oninput = (e) => { n.title = e.target.value; renderNodes(); };
  $('btnApply').onclick = () => {
    n.code = $('fCode').value;
    n.deps = [...$('fDeps').selectedOptions].map((o) => o.value);
    n.title = $('fTitle').value;
    renderNodes();
    renderDetail();
  };
  $('btnDel').onclick = () => {
    state.nodes = state.nodes.filter((x) => x.id !== n.id).map((x, i) => ({ ...x, id: `n${i + 1}` }));
    state.selected = state.nodes[0]?.id ?? null;
    state.result = null;
    renderNodes(); renderDetail(); renderResult();
  };

  renderNodeResult(r);
}

function renderNodeResult(r) {
  const box = $('nodeResult');
  if (!r) { box.innerHTML = ''; return; }
  const stages = ['lint', 'resolve', 'run', 'check'];
  const reached = stages.indexOf(r.stage);
  const cls = (i) => {
    if (r.status === 'pass') return 'ok';
    if (r.stage === 'done') return 'ok';
    if (i < reached) return 'ok';
    if (i === reached) return 'err';
    return '';
  };
  box.innerHTML = `
    <h3>校验结果</h3>
    <div class="stages">${stages.map((s, i) => `<div class="stage ${cls(i)}">${i + 1} ${STAGE_LABEL[s]}</div>`).join('')}</div>
    ${r.errors?.map((e) => `<div class="msg err">✖ ${esc(e)}</div>`).join('') ?? ''}
    ${r.hint ? `<div class="msg hint">💡 ${esc(r.hint)}</div>` : ''}
    ${r.warnings?.map((w) => `<div class="msg warn">⚠ ${esc(w)}</div>`).join('') ?? ''}
    ${r.status === 'pass' ? '<div class="msg ok">✅ 该节点通过</div>' : ''}
    ${r.logs?.length ? `<h3>执行日志</h3>${r.logs.map((l) => `<div class="mono" style="color:var(--dim)">· ${esc(l)}</div>`).join('')}` : ''}
    ${r.outputs?.[0]?.rows != null ? `<div class="kv"><span>产物行数</span><span>${r.outputs[0].rows}</span></div>` : ''}
    ${r.outputs?.[0]?.partCount != null ? `<div class="kv"><span>part 文件数</span><span>${r.outputs[0].partCount}</span></div>` : ''}
    ${r.outputs?.[0]?.targetDir ? `<div class="kv"><span>落盘目录</span><span>${esc(r.outputs[0].targetDir)}</span></div>` : ''}`;
}

// ─────────────────────────── 运行链路 ───────────────────────────
async function runPipeline() {
  if (state.running || !state.nodes.length) return;
  state.running = true;
  $('btnRun').disabled = true;
  $('status').className = 'pill run';
  $('status').textContent = '运行中…';

  // 每次都从干净状态开始（重置 VFS / 数仓 / 沙箱库）
  const scene = state.scene;
  const dbBuffer = state.ctx.rawBuffer;
  try {
    if (dbBuffer) {
      const SQL = await loadSqlJs((f) => `/vendor/${f}`);
      state.ctx.db = new Db(new SQL.Database(new Uint8Array(dbBuffer)));
    }
    state.ctx.vfs = new VFS();
    state.ctx.warehouse = new Warehouse(state.ctx.vfs);
    state.ctx.state = new Map();

    const p = new Pipeline(state.ctx);
    for (const n of state.nodes) {
      p.add({ id: n.id, type: n.type, title: n.title, code: n.code, deps: n.deps, expect: n.expect });
    }
    const res = await p.run();
    state.result = res;
    const pass = res.nodes.filter((x) => x.status === 'pass').length;
    $('status').className = `pill ${res.ok ? 'ok' : 'err'}`;
    $('status').textContent = res.ok ? `✅ 链路通过 ${pass}/${res.nodes.length}` : `❌ 未通过 ${pass}/${res.nodes.length}`;
  } catch (e) {
    $('status').className = 'pill err';
    $('status').textContent = `❌ ${e.message}`;
  } finally {
    state.running = false;
    $('btnRun').disabled = false;
    renderNodes();
    renderDetail();
    renderResult();
  }
}

// ─────────────────────────── 结果面板 ───────────────────────────
function renderResult() {
  const pane = $('resultPane');
  const res = state.result;
  if (!res) { pane.innerHTML = '<div class="empty">运行链路后这里显示执行过程与产物。</div>'; return; }
  const ctx = state.ctx;

  if (state.tab === 'logs') {
    pane.innerHTML = res.nodes.map((n) => `
      <div class="msg ${n.status === 'pass' ? 'ok' : n.status === 'skipped' ? 'warn' : 'err'}">
        <b>${n.status === 'pass' ? '✅' : '❌'} ${esc(n.title)}</b>
        <span class="mono" style="color:var(--dim)">[${n.stage} · ${n.durationMs}ms]</span>
        ${n.logs?.map((l) => `<div class="mono" style="color:var(--dim)">· ${esc(l)}</div>`).join('') ?? ''}
        ${n.errors?.map((e) => `<div class="mono" style="color:var(--err)">✖ ${esc(e)}</div>`).join('') ?? ''}
        ${n.hint ? `<div class="mono" style="color:var(--acc)">💡 ${esc(n.hint)}</div>` : ''}
        ${n.warnings?.map((w) => `<div class="mono" style="color:var(--warn)">⚠ ${esc(w)}</div>`).join('') ?? ''}
      </div>`).join('')
      + `<div class="kv"><span>总耗时</span><span>${res.nodes.reduce((a, b) => a + b.durationMs, 0)}ms</span></div>`
      + `<div class="kv"><span>元数据 ↔ HDFS 一致性</span><span>${res.consistency.length === 0 ? '通过' : res.consistency.length + ' 处问题'}</span></div>`;
    return;
  }

  if (state.tab === 'hdfs') {
    const files = ctx.vfs.findFiles('/user/hive');
    if (!files.length) { pane.innerHTML = '<div class="empty">HDFS 还是空的——先跑一个 Sqoop/计算节点。</div>'; return; }
    pane.innerHTML = `<div class="tree">${files.map((f) => `${esc(f.path)}\n  ${f.format ?? ''}  ${f.rows != null ? f.rows + ' 行' : ''}  ${f.size}B`).join('\n')}</div>`;
    return;
  }

  if (state.tab === 'hive') {
    const list = ctx.warehouse.list();
    if (!list.length) { pane.innerHTML = '<div class="empty">数仓还没有表——先跑 Hive 建表节点。</div>'; return; }
    pane.innerHTML = list.map((t) => {
      const parts = ctx.warehouse.partitionsOf(t.db, t.table);
      return `<div class="msg"><b>${t.db}.${t.table}</b>
        <div class="mono" style="color:var(--dim)">${t.columns.length} 字段 · ${t.format} · ${esc(t.location)}</div>
        <div class="mono" style="color:var(--ok)">${parts.length ? '分区：' + parts.map((p) => Object.entries(p.values).map(([k, v]) => `${k}=${v}`).join(',')).join(' | ') : '无分区'}</div>
      </div>`;
    }).join('');
    return;
  }

  // lineage
  const lin = res.lineage ?? [];
  pane.innerHTML = lin.length
    ? lin.map((e) => {
      const fmt = (x) => (x?.table ? `${x.system ?? x.db}.${x.table}` : (x?.path ?? '?'));
      return `<div class="mono" style="margin:4px 0">${esc(fmt(e.from))} <span style="color:var(--dim)">--[${e.kind}]--&gt;</span> ${esc(fmt(e.to))}</div>`;
    }).join('')
    : '<div class="empty">还没有血缘——跑通一条链路后自动生成。</div>';
}

// ─────────────────────────── 初始化 ───────────────────────────
async function loadDemo(scene) {
  const demo = await fetch(`/demos/${scene}.json`).then((r) => r.json());
  state.nodes = demo.nodes;
  state.selected = state.nodes[0]?.id ?? null;
  state.result = null;
  renderNodes();
  renderDetail();
  renderResult();
}

async function boot() {
  renderPalette();
  $('tabs').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      $('tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      renderResult();
    };
  });
  $('btnRun').onclick = runPipeline;
  $('btnDemo').onclick = () => loadDemo(state.scene);
  $('scene').onchange = async (e) => {
    state.scene = e.target.value;
    state.nodes = [];
    state.selected = null;
    state.result = null;
    await loadScene(state.scene);
    state.ctx.rawBuffer = await fetch(`/data/${state.scene}/${state.scene}.sqlite`).then((r) => r.arrayBuffer());
    await loadDemo(state.scene);
  };
  await loadScene(state.scene);
  state.ctx.rawBuffer = await fetch(`/data/${state.scene}/${state.scene}.sqlite`).then((r) => r.arrayBuffer());
  await loadDemo(state.scene);
  $('status').textContent = '就绪 · 点「运行链路」试试';
}

boot().catch((e) => {
  document.body.insertAdjacentHTML('beforeend',
    `<div class="msg err" style="margin:16px">启动失败：${esc(e.message)}</div>`);
});
