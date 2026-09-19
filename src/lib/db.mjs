/**
 * SQLite 执行层（sql.js / WASM）
 * ------------------------------------------------------------------
 * 同一份代码在浏览器与 Node 里都能跑：
 *   - 浏览器：locateFile 指向 /vendor/sql-wasm.wasm
 *   - Node   ：locateFile 指向 node_modules/sql.js/dist/sql-wasm.wasm
 * 提供：query / exec / 表结构反射 / 表行数，供校验器与判题器使用。
 */

let SQL_MODULE = null;

/**
 * 同时支持 Node 与浏览器：
 *   - 浏览器：页面用 <script src="/vendor/sql-wasm.js"> 引入后，全局有 initSqlJs
 *   - Node   ：动态 import('sql.js')
 * @param {(f:string)=>string} locateFile 定位 sql-wasm.wasm
 * @param {{moduleUrl?:string}} [opts]
 */
export async function loadSqlJs(locateFile, opts = {}) {
  if (SQL_MODULE) return SQL_MODULE;
  const g = globalThis;
  if (typeof g.initSqlJs === 'function') {
    SQL_MODULE = await g.initSqlJs({ locateFile });
    return SQL_MODULE;
  }
  const spec = opts.moduleUrl ?? 'sql.js';
  const mod = await import(/* webpackIgnore: true */ spec);
  const initSqlJs = mod.default ?? mod;
  SQL_MODULE = await initSqlJs({ locateFile });
  return SQL_MODULE;
}

export class Db {
  constructor(sqlDb, vfs = null) {
    this.raw = sqlDb;
    this.vfs = vfs;
  }

  /** 查询 → {columns, rows}（rows 为二维数组，判题器直接可用） */
  query(sql, params) {
    const stmt = this.raw.prepare(sql);
    try {
      if (params) stmt.bind(params);
      const rows = [];
      let columns = [];
      while (stmt.step()) {
        if (!columns.length) columns = stmt.getColumnNames();
        rows.push(stmt.get());
      }
      if (!columns.length) columns = stmt.getColumnNames();
      return { columns, rows };
    } finally {
      stmt.free();
    }
  }

  /** 执行写入/DDL，返回影响行数 */
  exec(sql, params) {
    if (params) {
      this.raw.run(sql, params);
    } else {
      this.raw.exec(sql);
    }
    return this.raw.getRowsModified();
  }

  /** 表是否存在 */
  hasTable(name) {
    const r = this.query(
      "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1", [name]);
    return r.rows.length > 0;
  }

  /** 表结构：[{name, type, notnull, pk}] */
  columnsOf(name) {
    if (!this.hasTable(name)) return [];
    return this.query(`PRAGMA table_info(${quoteIdent(name)})`).rows.map((r) => ({
      name: r[1], type: r[2] ?? '', notnull: !!r[3], pk: !!r[5],
    }));
  }

  rowCount(name) {
    if (!this.hasTable(name)) return null;
    return this.query(`SELECT COUNT(*) FROM ${quoteIdent(name)}`).rows[0][0];
  }

  tables() {
    return this.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .rows.map((r) => r[0]);
  }

  /** 从一条 SELECT 建表（Hive INSERT OVERWRITE 落地用）；已存在则复用 */
  ensureTableFromSelect(sqliteName, selectSql) {
    if (this.hasTable(sqliteName)) return false;
    this.exec(`CREATE TABLE ${quoteIdent(sqliteName)} AS SELECT * FROM (${selectSql}) LIMIT 0`);
    return true;
  }

  close() { this.raw.close(); }
}

export function quoteIdent(name) {
  const s = String(name);
  // Hive 风格 db.table → sqlite 用 db__table 规避 schema 限定
  const mapped = s.includes('.') ? s.replace(/\./g, '__') : s;
  return `"${mapped.replace(/"/g, '""')}"`;
}

export function sqliteName(hiveOrPlain) {
  return String(hiveOrPlain).replace(/\./g, '__');
}
