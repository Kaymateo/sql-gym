/**
 * 数仓元数据（Hive Metastore 的模拟）
 * ------------------------------------------------------------------
 * 管理分层（ODS/DWD/DWS/ADS/default）下的表定义、分区、存储位置与血缘。
 * 表数据本身存在 SQLite 里（名字规则：db__table），元数据在这里。
 * HDFS 目录由 VFS 承担；本模块负责"元数据 ↔ 目录"的一致性校验。
 */

import { VFS } from './vfs.mjs';

export const LAYERS = ['ods', 'dwd', 'dws', 'ads', 'default', 'tmp'];

export function defaultLocation(db, table) {
  return `/user/hive/warehouse/${db}.db/${table}`;
}

export class Warehouse {
  constructor(vfs) {
    this.vfs = vfs ?? new VFS();
    this.tables = new Map();       // 'db.table' → meta
    this.partitions = new Map();   // 'db.table' → Map(partKey → {values, location, rows})
    this.lineage = [];             // {from:{db,table}|{system}, to:{db,table}, node, kind}
  }

  key(db, table) { return `${db}.${table}`; }

  createTable(meta) {
    const db = meta.db ?? 'default';
    const table = meta.table;
    const k = this.key(db, table);
    if (this.tables.has(k)) {
      throw new Error(`表已存在：${k}（要重写请用 INSERT OVERWRITE，或先 DROP）`);
    }
    const full = {
      db, table,
      comment: meta.comment ?? '',
      columns: (meta.columns ?? []).map((c) => ({
        name: c.name, type: (c.type ?? 'string').toLowerCase(),
        comment: c.comment ?? '', cn: c.cn ?? '',
      })),
      partitionColumns: (meta.partitionedBy ?? []).map((c) => ({
        name: c.name, type: (c.type ?? 'string').toLowerCase(),
      })),
      format: (meta.format ?? 'parquet').toLowerCase(),
      location: meta.location ?? defaultLocation(db, table),
      external: meta.external ?? true,
      createdAt: Date.now(),
    };
    this.tables.set(k, full);
    this.partitions.set(k, new Map());
    return full;
  }

  get(db, table) { return this.tables.get(this.key(db, table)) ?? null; }
  has(db, table) { return this.tables.has(this.key(db, table)); }
  list(db) {
    return [...this.tables.values()].filter((t) => !db || t.db === db);
  }
  layerNames() { return LAYERS; }

  /** 挂载分区：要求 HDFS 目录真实存在（Hive 的经典坑） */
  addPartition(db, table, values) {
    const t = this.get(db, table);
    if (!t) throw new Error(`表不存在：${db}.${table}`);
    for (const p of t.partitionColumns) {
      if (!(p.name in values)) throw new Error(`缺少分区键 ${p.name}`);
    }
    const partDir = this.partitionPath(db, table, values);
    if (!this.vfs.exists(partDir)) {
      const err = new Error(`分区目录不存在：${partDir}。Hive 只能挂载已存在的数据目录（先让采集/计算节点产出数据）`);
      err.code = 'PARTITION_DIR_MISSING';
      throw err;
    }
    const files = this.vfs.findFiles(partDir);
    const key = this.partKey(values);
    this.partitions.get(this.key(db, table)).set(key, {
      values, location: partDir, files: files.length,
      rows: files.reduce((s, f) => s + (f.rows ?? 0), 0),
    });
    return this.partitions.get(this.key(db, table)).get(key);
  }

  partitionPath(db, table, values) {
    const t = this.get(db, table);
    const base = t?.location ?? defaultLocation(db, table);
    const suffix = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('/');
    return suffix ? `${base}/${suffix}` : base;
  }

  partKey(values) {
    return Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('/');
  }

  partitionsOf(db, table) {
    return [...(this.partitions.get(this.key(db, table))?.values() ?? [])];
  }

  /** 记录血缘 */
  link(from, to, node, kind = 'transform') {
    this.lineage.push({ from, to, node, kind, at: Date.now() });
  }

  /** 反向追溯某产物的所有上游 */
  upstreamOf(db, table, seen = new Set()) {
    const k = this.key(db, table);
    if (seen.has(k)) return [];
    seen.add(k);
    const edges = this.lineage.filter((e) => e.to?.db === db && e.to?.table === table);
    return edges.flatMap((e) => [
      e.from,
      ...(e.from?.db && e.from?.table ? this.upstreamOf(e.from.db, e.from.table, seen) : []),
    ]);
  }

  /** 元数据 ↔ HDFS 一致性检查（用于校验节点） */
  consistencyIssues() {
    const issues = [];
    for (const t of this.tables.values()) {
      if (!this.vfs.exists(t.location)) {
        issues.push(`${t.db}.${t.table}: LOCATION ${t.location} 在 HDFS 上不存在`);
      }
      for (const p of this.partitionsOf(t.db, t.table)) {
        if (!this.vfs.exists(p.location)) {
          issues.push(`${t.db}.${t.table} 分区 ${this.partKey(p.values)} 目录丢失`);
        }
      }
    }
    return issues;
  }
}
