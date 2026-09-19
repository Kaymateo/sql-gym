/**
 * 链路（Pipeline）引擎
 * ------------------------------------------------------------------
 * 把"数据传输链路"建模成有向无环图：
 *   节点(Node) = 一个环节（采集/存储/计算/调度/输出）
 *   边(deps)   = 数据依赖
 * 每个节点按 4 层校验执行：lint → resolve → run → check
 *   lint    静态：代码写得对不对（语法/必填参数）
 *   resolve 语义：表/字段/路径/依赖存不存在
 *   run     模拟执行：真的在 SQLite + VFS 上跑一遍
 *   check   产物校验：产物是否符合题目期望
 *
 * 这样用户得到的不是"错"，而是"哪一层错了、错在哪"。
 */

export const Stage = Object.freeze({
  lint: 'lint', resolve: 'resolve', run: 'run', check: 'check',
});

export class NodeError extends Error {
  constructor(message, stage = Stage.resolve, code = 'NODE_ERROR', hint = '') {
    super(message);
    this.stage = stage;
    this.code = code;
    this.hint = hint;
  }
}

/** 校验器注册表：type → {lint, resolve, run, check} */
export const VALIDATORS = new Map();

export function registerValidator(v) {
  if (!v?.type) throw new Error('校验器必须声明 type');
  for (const fn of ['lint', 'resolve', 'run', 'check']) {
    if (typeof v[fn] !== 'function') {
      throw new Error(`校验器 ${v.type} 缺少 ${fn}()`);
    }
  }
  VALIDATORS.set(v.type, v);
  return v;
}

export function listNodeTypes() {
  return [...VALIDATORS.keys()];
}

export class Pipeline {
  /**
   * @param {object} ctx 执行上下文：
   *   { db, vfs, warehouse, schema, kafka, clock, state }
   *   - db        : Db 实例（SQLite）
   *   - vfs       : VFS 实例（HDFS）
   *   - warehouse : Warehouse 实例（Hive 元数据）
   *   - schema    : {table: [{name,type,comment}]} 业务库表结构
   *   - state     : Map，供节点间传递中间状态
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.nodes = new Map();
    this.results = new Map();
  }

  add(node) {
    if (!node.id) throw new Error('节点必须有 id');
    if (this.nodes.has(node.id)) throw new Error(`节点 id 重复：${node.id}`);
    if (!VALIDATORS.has(node.type)) {
      throw new Error(`未知节点类型：${node.type}（可用：${listNodeTypes().join(', ')}）`);
    }
    this.nodes.set(node.id, { deps: [], expect: {}, params: {}, title: node.id, ...node });
    return this;
  }

  /** 拓扑排序 + 依赖存在性检查（含环检测） */
  validateTopology() {
    const errors = [];
    for (const n of this.nodes.values()) {
      for (const d of n.deps) {
        if (!this.nodes.has(d)) errors.push(`节点 ${n.id} 依赖了不存在的节点 ${d}`);
      }
    }
    const order = [];
    const state = new Map();   // 0 未访问 1 访问中 2 完成
    const visit = (id, stack) => {
      const s = state.get(id) ?? 0;
      if (s === 2) return;
      if (s === 1) {
        errors.push(`检测到循环依赖：${[...stack, id].join(' → ')}（链路必须是有向无环图）`);
        return;
      }
      state.set(id, 1);
      for (const d of this.nodes.get(id).deps) {
        if (this.nodes.has(d)) visit(d, [...stack, id]);
      }
      state.set(id, 2);
      order.push(id);
    };
    for (const id of this.nodes.keys()) visit(id, []);
    return { ok: errors.length === 0, errors, order };
  }

  /** 顺序执行整条链路 */
  async run({ stopOnError = true } = {}) {
    const topo = this.validateTopology();
    if (!topo.ok) {
      return { ok: false, topology: topo, nodes: [], stage: 'topology' };
    }

    const reports = [];
    for (const id of topo.order) {
      const node = this.nodes.get(id);
      const upstream = {};
      for (const d of node.deps) {
        const r = this.results.get(d);
        upstream[d] = r?.outputs ?? null;
        if (r && r.status !== 'pass') {
          const rep = {
            id, title: node.title, type: node.type, status: 'skipped', stage: 'dependency',
            errors: [`上游节点 ${d} 未通过（${r.status}），本节点已跳过`], warnings: [],
            outputs: null, logs: [], durationMs: 0,
          };
          this.results.set(id, rep);
          reports.push(rep);
          if (stopOnError) return { ok: false, topology: topo, nodes: reports, stage: 'run' };
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const report = await this.runNode(node, upstream);
      this.results.set(id, report);
      reports.push(report);
      if (report.status !== 'pass' && stopOnError) {
        return { ok: false, topology: topo, nodes: reports, stage: report.stage };
      }
    }

    // 链路级校验：元数据与 HDFS 一致性 + 血缘完整
    const consistency = this.ctx.warehouse ? this.ctx.warehouse.consistencyIssues() : [];
    const ok = reports.every((r) => r.status === 'pass') && consistency.length === 0;
    return {
      ok,
      topology: topo,
      nodes: reports,
      consistency,
      lineage: this.ctx.warehouse?.lineage ?? [],
      artifacts: this.collectArtifacts(reports),
    };
  }

  async runNode(node, upstream) {
    const v = VALIDATORS.get(node.type);
    const t0 = Date.now();
    const ctx = this.ctx;
    const base = { id: node.id, title: node.title, type: node.type, logs: [] };
    const warnings = [];

    // ① lint
    let lr;
    try {
      lr = v.lint(node.code ?? '', node, ctx) ?? {};
    } catch (e) {
      return { ...base, status: 'fail', stage: Stage.lint, errors: [e.message], warnings, durationMs: Date.now() - t0 };
    }
    warnings.push(...(lr.warnings ?? []));
    if (lr.errors?.length) {
      return { ...base, status: 'fail', stage: Stage.lint, errors: lr.errors, warnings,
        hint: lr.hint ?? '', durationMs: Date.now() - t0 };
    }

    // ② resolve
    let plan;
    try {
      plan = v.resolve(node.code ?? '', node, ctx, upstream) ?? {};
    } catch (e) {
      if (e instanceof NodeError) {
        return { ...base, status: 'fail', stage: e.stage ?? Stage.resolve,
          errors: [e.message], hint: e.hint, code: e.code, warnings, durationMs: Date.now() - t0 };
      }
      return { ...base, status: 'fail', stage: Stage.resolve, errors: [e.message], warnings,
        durationMs: Date.now() - t0 };
    }
    warnings.push(...(plan.warnings ?? []));

    // ③ run
    let out;
    try {
      out = v.run(plan, node, ctx, upstream) ?? {};
    } catch (e) {
      return { ...base, status: 'fail', stage: Stage.run, errors: [e.message],
        hint: e.hint ?? '', code: e.code, warnings, plan: summarizePlan(plan),
        durationMs: Date.now() - t0 };
    }

    // ④ check
    let cr;
    try {
      cr = v.check(out, node.expect ?? {}, node, ctx, upstream) ?? { status: 'pass' };
    } catch (e) {
      return { ...base, status: 'fail', stage: Stage.check, errors: [e.message], warnings,
        plan: summarizePlan(plan), outputs: out?.outputs ?? null, durationMs: Date.now() - t0 };
    }
    const status = cr.status ?? 'pass';
    return {
      ...base,
      status,
      stage: status === 'pass' ? 'done' : Stage.check,
      errors: status === 'pass' ? [] : (cr.messages ?? [cr.message].filter(Boolean)),
      diff: cr.details ?? null,
      hint: cr.hint ?? '',
      warnings,
      plan: summarizePlan(plan),
      outputs: out?.outputs ?? null,
      logs: [...(out?.logs ?? []), ...(cr.logs ?? [])],
      durationMs: Date.now() - t0,
    };
  }

  collectArtifacts(reports) {
    const out = { vfs: [], hive: [], rows: 0 };
    for (const r of reports) {
      for (const o of r.outputs ?? []) {
        if (o.vfsPaths) out.vfs.push(...o.vfsPaths);
        if (o.hiveTable) out.hive.push(o.hiveTable);
        out.rows += o.rows ?? 0;
      }
    }
    return out;
  }
}

function summarizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const keep = ['tool', 'target', 'targetDir', 'selectSql', 'table', 'db', 'rows', 'partCount', 'hiveTable'];
  const s = {};
  for (const k of keep) if (plan[k] !== undefined) s[k] = plan[k];
  return Object.keys(s).length ? s : null;
}
