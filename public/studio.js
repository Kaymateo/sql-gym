/**
 * DataStudio 前端（ODPS / DataWorks 风格）
 * 项目空间 → 业务流程 → 节点 → 提交作业 → 实例(InstanceId) + Logview → 产出分区表
 */
import { loadSqlJs, Db } from '/src/lib/db.mjs';
import { VFS } from '/src/lib/vfs.mjs';
import { Warehouse } from '/src/lib/hive.mjs';
import { runStatement, listAllTables } from '/src/lib/console.mjs';
import { seedWarehouse, applySchemaDoc } from '/src/lib/scene.mjs';
import { PROJECTS, defaultNodes, topoOrder } from '/src/lib/project.mjs';
import { submit, cycleInstances, backfill, dependencyGraph, NODE_TYPES, FOLDERS } from '/src/lib/odps.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtRows = (n) => (n == null ? '' : Number(n).toLocaleString());

const S = {
  scene: 'power', ctx: null, nodes: [], openTabs: [], active: null,
  instances: [], nodeStatus: {}, view: 'dev', timers: new Set(),
};

// ─────────────────────────── 启动 ───────────────────────────
async function boot() {
  document.querySelectorAll('nav button').forEach((b) => {
    b.onclick = () => switchView(b.dataset.view);
  });
  $('scene').onchange = (e) => { S.scene = e.target.value; loadProject(); };
  $('btnRunAll').onclick = runAll;
  $('btnNew').onclick = newFolderlessNode;
  $('opsDays').onchange = renderOps;
  $('btnBackfill').onclick = doBackfill;
  await loadProject();
}

async function loadProject() {
  const scene = S.scene;
  $('status').className = 'pill';
  $('status').textContent = '加载中…';
  const [buf, schemaDoc] = await Promise.all([
    fetch(`/data/${scene}/${scene}.sqlite`).then((r) => r.arrayBuffer()),
    fetch(`/data/${scene}/schema.json`).then((r) => r.json()),
  ]);
  const SQL = await loadSqlJs((f) => `/vendor/${f}`);
  const vfs = new VFS();
  S.ctx = applySchemaDoc({
    db: new Db(new SQL.Database(new Uint8Array(buf))), vfs,
    warehouse: new Warehouse(vfs), state: new Map(),
  }, schemaDoc);
  const seed = seedWarehouse(S.ctx, scene);
  S.nodes = defaultNodes(scene);
  S.openTabs = [];
  S.active = null;
  S.instances = [];
  S.nodeStatus = {};
  $('proj').textContent = PROJECTS[scene].name;
  renderTree();
  renderEditor();
  renderOps();
  renderMap();
  $('status').className = 'pill ok';
  $('status').textContent = `ODS 就绪 ${seed.rows.toLocaleString()} 行`;
}

function switchView(v) {
  S.view = v;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  ['dev', 'ops', 'map'].forEach((k) => $(`view-${k}`).classList.toggle('on', k === v));
  if (v === 'ops') renderOps();
  if (v === 'map') renderMap();
}

// ─────────────────────────── 业务流程树 ───────────────────────────
function renderTree() {
  const byFolder = new Map(FOLDERS.map((f) => [f, []]));
  for (const n of S.nodes) {
    if (!byFolder.has(n.folder)) byFolder.set(n.folder, []);
    byFolder.get(n.folder).push(n);
  }
  $('tree').innerHTML = [...byFolder.entries()].filter(([, l]) => l.length).map(([f, list]) => `
    <div class="fldr">▾ ${esc(f)}<span class="note"> (${list.length})</span></div>
    ${list.map((n) => {
    const st = S.nodeStatus[n.name];
    const icon = st === 'SUCCESS' ? '✅' : st === 'FAILED' ? '❌' : '';
    return `<div class="nd ${S.active === n.name ? 'on' : ''}" data-n="${esc(n.name)}">
        <span class="badge">${NODE_TYPES[n.type]?.icon ?? '?'}</span>
        <span class="nm" title="${esc(n.name)}">${esc(n.name)}</span>
        <span class="st">${icon}</span></div>`;
  }).join('')}`).join('');

  $('tree').querySelectorAll('.nd').forEach((el) => {
    el.onclick = () => openNode(el.dataset.n);
    el.ondblclick = () => { openNode(el.dataset.n); switchView('dev'); };
  });
}

function openNode(name) {
  const n = S.nodes.find((x) => x.name === name);
  if (!n) return;
  if (!S.openTabs.includes(name)) S.openTabs.push(name);
  S.active = name;
  renderTree();
  renderEditor();
  renderProps();
}

function newFolderlessNode() {
  const name = `new_node_${S.nodes.length + 1}`;
  S.nodes.push({
    name, folder: '临时', type: 'odps_sql', desc: '未命名节点',
    code: '-- 在这里写 SQL\nSELECT 1',
    schedule: { enabled: false, cycle: 'once', cron: '0 0 * * *', deps: [] },
  });
  openNode(name);
}

// ─────────────────────────── 编辑器 ───────────────────────────
function renderEditor() {
  $('edTabs').innerHTML = S.openTabs.map((t) => `<div class="tb ${S.active === t ? 'on' : ''}" data-t="${esc(t)}">
      ${esc(t)}<span class="x" data-x="${esc(t)}">×</span></div>`).join('');
  $('edTabs').querySelectorAll('.tb').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.x) {
        S.openTabs = S.openTabs.filter((x) => x !== e.target.dataset.x);
        if (S.active === e.target.dataset.x) S.active = S.openTabs.at(-1) ?? null;
        renderEditor(); renderTree(); renderProps();
      } else openNode(el.dataset.t);
    };
  });

  const n = S.nodes.find((x) => x.name === S.active);
  if (!n) {
    $('edWrap').innerHTML = '<div class="empty">左侧双击节点打开编辑器。</div>';
    return;
  }
  const last = [...S.instances].reverse().find((i) => i.nodeName === n.name);
  $('edWrap').innerHTML = `
    <div class="toolbar">
      <b class="mono">${esc(n.name)}</b>
      <span class="badge note">${NODE_TYPES[n.type]?.label ?? n.type}</span>
      <button id="btnRun" class="primary sm">▶ 运行</button>
      <button id="btnSave" class="sm">保存</button>
      <span class="note" style="margin:0">${esc(n.desc ?? '')}</span>
    </div>
    <textarea id="code" spellcheck="false">${esc(n.code ?? '')}</textarea>
    <div class="toolbar">
      <button data-pane="log" class="sm on" id="paneLogBtn">Logview</button>
      <button data-pane="result" class="sm" id="paneResBtn">结果表</button>
      <span class="note" style="margin:0" id="instInfo">${last ? `最近实例 ${last.id} · ${last.status} · ${last.durationMs}ms` : '尚未运行'}</span>
    </div>
    <div id="pane"></div>`;

  const code = $('code');
  code.addEventListener('input', () => { n.code = code.value; });
  code.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runNode(n); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const at = code.selectionStart;
      code.value = `${code.value.slice(0, at)}  ${code.value.slice(code.selectionEnd)}`;
      code.selectionStart = code.selectionEnd = at + 2;
      n.code = code.value;
    }
  });
  $('btnRun').onclick = () => runNode(n);
  $('btnSave').onclick = () => { n.code = $('code').value; $('status').textContent = '已保存'; };
  $('paneLogBtn').onclick = () => renderPane('log');
  $('paneResBtn').onclick = () => renderPane('result');
  renderPane('log', last);
}

function renderPane(which, inst) {
  const n = S.nodes.find((x) => x.name === S.active);
  const last = inst ?? [...S.instances].reverse().find((i) => i.nodeName === n?.name);
  $('paneLogBtn')?.classList.toggle('on', which === 'log');
  $('paneResBtn')?.classList.toggle('on', which === 'result');
  const pane = $('pane');
  if (!pane) return;

  if (!last) { pane.innerHTML = '<div class="empty">点「▶ 运行」提交作业，这里会显示 InstanceId 与 Logview。</div>'; return; }

  if (which === 'result') {
    const r = last.result;
    if (!r?.ok) { pane.innerHTML = '<div class="msg err">作业未成功，先看 Logview。</div>'; return; }
    if (r.write) {
      pane.innerHTML = `<div class="msg ok">✅ 已写入 <b>${fmtRows(r.write.rows)}</b> 行 → <code>${esc(r.write.table)}</code>
        分区 ${esc(Object.entries(r.write.partition ?? {}).map(([k, v]) => `${k}=${v}`).join(','))}
        <div class="mono" style="color:var(--dim)">产出目录：${esc(r.write.dirs?.[0] ?? '')}</div></div>`;
      return;
    }
    if (!r.columns.length) { pane.innerHTML = '<div class="msg ok">执行完成。</div>'; return; }
    const head = r.columns.map((c) => `<th>${esc(c)}</th>`).join('');
    const body = r.rows.map((row) => `<tr>${row.map((v) => (v === null || v === undefined ? '<td class="null">NULL</td>'
      : `<td>${esc(typeof v === 'number' ? (Number.isInteger(v) ? v : Number(v.toFixed(4))) : v)}</td>`)).join('')}</tr>`).join('');
    pane.innerHTML = `<div class="scroll"><table class="res"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="note">共 ${fmtRows(r.rowCount)} 行，展示前 ${r.rows.length} 行</div>`;
    return;
  }

  pane.innerHTML = `<div class="inst">
      <span>InstanceId</span><span class="id">${esc(last.id)}</span>
      <span class="pill ${last.status === 'SUCCESS' ? 'ok' : 'err'}">${last.status}</span>
      <span class="note" style="margin:0">耗时 ${last.durationMs} ms</span>
      ${last.output?.table ? `<span class="note" style="margin:0">产出 ${esc(last.output.table)}</span>` : ''}
    </div>
    <div class="log" id="logBox">${last.logs.map(renderLogLine).join('')}</div>`;
}

const renderLogLine = (l) => `<div class="l"><span class="lv">${new Date(l.ts).toLocaleTimeString('zh-CN')}</span>
  <span class="${esc(l.level)}">[${esc(l.level)}] ${esc(l.msg)}</span></div>`;

// ─────────────────────────── 运行 ───────────────────────────
async function runNode(node, { silent = false } = {}) {
  if (!silent) { $('status').className = 'pill'; $('status').textContent = '提交作业中…'; }
  const inst = submit(S.ctx, node, { project: PROJECTS[S.scene].name });
  S.instances.push(inst);
  S.nodeStatus[node.name] = inst.status;
  renderTree();
  if (S.active === node.name && S.view === 'dev') {
    renderEditor();
    const instInfo = $('instInfo');
    if (instInfo) instInfo.textContent = `最近实例 ${inst.id} · ${inst.status} · ${inst.durationMs}ms`;
    await revealLogs(inst);
  }
  if (!silent) {
    $('status').className = `pill ${inst.status === 'SUCCESS' ? 'ok' : 'err'}`;
    $('status').textContent = inst.status === 'SUCCESS'
      ? `✅ ${node.name} 成功 ${inst.durationMs}ms`
      : `❌ ${node.name} 失败`;
  }
  if (S.view === 'ops') renderOps();
  return inst;
}

/** Logview 逐行显示（观感，日志内容是真实的） */
function revealLogs(inst) {
  return new Promise((resolve) => {
    const box = $('logBox');
    if (!box) { resolve(); return; }
    box.innerHTML = '';
    let i = 0;
    const t = setInterval(() => {
      if (!box.isConnected) { clearInterval(t); resolve(); return; }
      if (i >= inst.logs.length) { clearInterval(t); resolve(); return; }
      box.insertAdjacentHTML('beforeend', renderLogLine(inst.logs[i]));
      box.scrollTop = box.scrollHeight;
      i += 1;
    }, 22);
    S.timers.add(t);
  });
}

async function runAll() {
  const order = topoOrder(S.nodes);
  $('status').className = 'pill';
  const results = [];
  for (const n of order) {
    $('status').textContent = `运行中… ${n.name}`;
    // eslint-disable-next-line no-await-in-loop
    const inst = await runNode(n, { silent: true });
    results.push(inst);
    if (inst.status === 'FAILED') break;
  }
  const okN = results.filter((i) => i.status === 'SUCCESS').length;
  $('status').className = `pill ${okN === results.length ? 'ok' : 'err'}`;
  $('status').textContent = `全流程 ${okN}/${results.length} 成功`;
  renderEditor();
  renderOps();
}

// ─────────────────────────── 节点属性 / 调度 ───────────────────────────
function renderProps() {
  const n = S.nodes.find((x) => x.name === S.active);
  if (!n) { $('props').innerHTML = '<div class="empty">选中节点后显示属性。</div>'; return; }
  const others = S.nodes.filter((x) => x.name !== n.name);
  const hist = S.instances.filter((i) => i.nodeName === n.name).reverse().slice(0, 8);
  $('props').innerHTML = `
    <h2>节点属性</h2>
    <div class="prop"><label>节点名称</label><input id="pName" value="${esc(n.name)}"></div>
    <div class="prop"><label>所属目录</label>
      <select id="pFolder">${FOLDERS.map((f) => `<option ${f === n.folder ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>
    <div class="prop"><label>节点类型</label>
      <select id="pType">${Object.entries(NODE_TYPES).map(([k, v]) => `<option value="${k}" ${k === n.type ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
    <div class="prop"><label>描述</label><input id="pDesc" value="${esc(n.desc ?? '')}"></div>

    <h2 style="margin-top:12px">调度配置</h2>
    <div class="prop"><label>是否参与调度</label>
      <select id="pEnabled"><option value="1" ${n.schedule?.enabled !== false ? 'selected' : ''}>是</option><option value="0" ${n.schedule?.enabled === false ? 'selected' : ''}>否（一次性）</option></select></div>
    <div class="prop"><label>调度周期</label>
      <select id="pCycle">
        <option value="daily" ${n.schedule?.cycle === 'daily' ? 'selected' : ''}>日调度</option>
        <option value="once" ${n.schedule?.cycle === 'once' ? 'selected' : ''}>一次性</option>
      </select></div>
    <div class="prop"><label>cron（分 时 日 月 周）</label><input id="pCron" value="${esc(n.schedule?.cron ?? '0 8 * * *')}"></div>
    <div class="prop"><label>上游依赖</label>
      ${others.length ? others.map((o) => `<label class="chk"><input type="checkbox" data-dep="${esc(o.name)}"
        ${(n.schedule?.deps ?? []).includes(o.name) ? 'checked' : ''}>${esc(o.name)}</label>`).join('') : '<div class="note">没有其它节点</div>'}
    </div>
    <button class="sm primary" id="pSave">保存配置</button>

    <h2 style="margin-top:12px">运行历史</h2>
    ${hist.length ? hist.map((i) => `<div class="kv"><span class="mono">${esc(i.id)}</span>
      <span class="${i.status === 'SUCCESS' ? '' : ''}">${i.status === 'SUCCESS' ? '✅' : '❌'} ${i.durationMs}ms</span></div>`).join('')
    : '<div class="note">还没有运行记录</div>'}`;

  const commit = (mutate) => { mutate(n); renderTree(); renderEditor(); renderProps(); };
  $('pName').onchange = (e) => commit((x) => {
    const old = x.name;
    x.name = e.target.value;
    S.openTabs = S.openTabs.map((t) => (t === old ? x.name : t));
    S.active = x.name;
    S.nodes.forEach((o) => { o.schedule.deps = (o.schedule.deps ?? []).map((d) => (d === old ? x.name : d)); });
  });
  $('pFolder').onchange = (e) => commit((x) => { x.folder = e.target.value; });
  $('pType').onchange = (e) => commit((x) => { x.type = e.target.value; });
  $('pDesc').onchange = (e) => commit((x) => { x.desc = e.target.value; });
  $('pEnabled').onchange = (e) => commit((x) => { x.schedule.enabled = e.target.value === '1'; });
  $('pCycle').onchange = (e) => commit((x) => { x.schedule.cycle = e.target.value; });
  $('pCron').onchange = (e) => commit((x) => { x.schedule.cron = e.target.value; });
  $('pSave').onclick = () => {
    const deps = [...$('props').querySelectorAll('[data-dep]')].filter((c) => c.checked).map((c) => c.dataset.dep);
    n.schedule.deps = deps;
    renderTree(); renderProps();
    $('status').textContent = `已保存 ${n.name} 的调度配置`;
  };
}

// ─────────────────────────── 运维中心 ───────────────────────────
function renderOps() {
  const days = Number($('opsDays').value);
  const insts = cycleInstances(S.nodes, { days });
  const byStatus = insts.reduce((a, i) => { a[i.status] = (a[i.status] ?? 0) + 1; return a; }, {});
  $('instList').innerHTML = `
    <table class="res"><thead><tr>
      <th>InstanceId</th><th>节点</th><th>业务日期</th><th>调度时间</th><th>状态</th><th>耗时</th><th>上游依赖</th>
    </tr></thead><tbody>
      ${insts.map((i) => `<tr>
        <td>${esc(i.id)}</td><td>${esc(i.nodeName)}</td><td>${esc(i.bizDate)}</td>
        <td>${esc(i.scheduledAt)}</td>
        <td>${i.status === 'SUCCESS' ? '✅ 运行成功' : '⏳ 等待'}</td>
        <td>${i.durationMs ? `${i.durationMs}ms` : '-'}</td>
        <td>${esc((i.deps ?? []).join(',') || '-')}</td></tr>`).join('')}
    </tbody></table>
    <div class="note">共 ${insts.length} 个周期实例（过去时间点为模拟历史运行，未来时间点为等待调度）。</div>`;

  $('opsStats').innerHTML = Object.entries(byStatus)
    .map(([k, v]) => `<div class="kv"><span>${k === 'SUCCESS' ? '运行成功' : '等待调度'}</span><span>${v}</span></div>`).join('');

  const g = dependencyGraph(S.nodes);
  $('dagView').innerHTML = g.map((n) => `${esc(n.name)}
${n.deps.length ? n.deps.map((d) => `   ← ${esc(d)}`).join('\n') : '   ← (根节点)'}${n.missing.length ? `\n   ⚠ 缺失依赖：${n.missing.map(esc).join(',')}` : ''}`).join('\n\n');
}

async function doBackfill() {
  const n = S.nodes.find((x) => x.name === S.active) ?? S.nodes[0];
  const days = Number($('opsDays').value);
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  const rows = backfill(S.ctx, n, { start, end });
  $('instList').insertAdjacentHTML('beforebegin', `<div class="msg ok">补数据：<b>${esc(n.name)}</b><br>
    ${rows.map((r) => `${esc(r.bizDate)} → 分区 ${esc(r.partition)}：${r.status}（${fmtRows(r.rows)} 行）${esc(r.message)}`).join('<br>')}</div>`);
  renderMap();
}

// ─────────────────────────── 数据地图 ───────────────────────────
function renderMap() {
  const groups = listAllTables(S.ctx);
  const order = [['business', '业务库（源）'], ['ods', 'ODS 原始层'], ['dwd', 'DWD 明细层'], ['dws', 'DWS 汇总层'], ['ads', 'ADS 应用层'], ['other', '其他']];
  $('catalog').innerHTML = order.map(([k, label]) => {
    const list = groups[k] ?? [];
    if (!list.length) return '';
    return `<h2>${label}</h2>${list.map((t) => `<div class="nd" data-m="${esc(t.name)}">
      <span class="nm">${t.cn ? `<b>${esc(t.cn)}</b>　` : ''}<span class="mono" style="color:var(--dim)">${esc(t.name)}</span></span>
      <span class="st note">${fmtRows(t.rows)}</span></div>`).join('')}`;
  }).join('');
  $('catalog').querySelectorAll('[data-m]').forEach((el) => { el.onclick = () => showTable(el.dataset.m); });
}

function showTable(name) {
  const groups = listAllTables(S.ctx);
  const t = Object.values(groups).flat().find((x) => x.name === name);
  if (!t) return;
  const lin = S.ctx.warehouse.lineage.filter((e) => (e.to?.table && `${e.to.db}.${e.to.table}` === name)
    || (e.from?.table && `${e.from.db}.${e.from.table}` === name));
  $('tblTitle').innerHTML = `${t.cn ? `<b>${esc(t.cn)}</b>　` : ''}<span class="mono">${esc(name)}</span>
    <span class="note">　${fmtRows(t.rows)} 行</span>`;
  $('tblDetail').innerHTML = `
    ${t.comment ? `<div class="msg" style="border-left-color:var(--acc);background:#0b2740">
      <b>表含义</b>：${esc(t.comment)}</div>` : '<div class="msg warn">该表没有中文含义（建议在 DDL 里补 COMMENT）</div>'}
    <div class="kv"><span>存储位置</span><span>${esc(t.location ?? '（业务库，非数仓表）')}</span></div>
    <div class="kv"><span>存储格式</span><span>${esc(t.format ?? '-')}</span></div>
    <div class="kv"><span>分区键</span><span>${esc((t.partitionedBy ?? []).map((p) => `${p.name} ${p.type}`).join(',') || '无')}</span></div>
    <div class="kv"><span>分区值</span><span>${esc((t.partitions ?? []).map((p) => Object.values(p).join(',')).join(' / ') || '无')}</span></div>
    <h3>字段（${(t.columns ?? []).length}）</h3>
    <table class="res"><thead><tr><th>字段名</th><th>中文名</th><th>类型</th><th>业务含义</th></tr></thead><tbody>
      ${(t.columns ?? []).map((c) => {
    const cn = typeof c === 'string' ? c : c.name;
    if (typeof c === 'string') return `<tr><td>${esc(cn)}</td><td></td><td></td><td></td></tr>`;
    return `<tr><td class="mono">${esc(c.name)}</td><td>${esc(c.cn ?? '')}</td><td>${esc(c.type ?? '')}</td><td>${esc(c.comment ?? '')}</td></tr>`;
  }).join('')}</tbody></table>
    <h3>血缘（${lin.length}）</h3>
    ${lin.length ? lin.map((e) => {
    const f = (x) => (x?.table ? `${x.system ?? x.db}.${x.table}` : (x?.path ?? '?'));
    return `<div class="mono">${esc(f(e.from))} <span style="color:var(--dim)">--[${esc(e.kind)}]--&gt;</span> ${esc(f(e.to))}</div>`;
  }).join('') : '<div class="note">暂无血缘记录（跑通一次写入后自动生成）</div>'}`;
}

boot().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<div class="msg err" style="margin:14px">启动失败：${esc(e.message)}</div>`);
});
