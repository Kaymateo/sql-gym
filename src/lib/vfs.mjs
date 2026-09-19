/**
 * 虚拟 HDFS（VFS）
 * ------------------------------------------------------------------
 * 用内存目录树模拟 HDFS：支持 mkdir / ls / find / writeFile / readFile / size。
 * 文件带元数据：format(textfile|parquet|orc)、rows、part 序号、模拟字节数。
 * 目的：让用户在浏览器里"看到" Sqoop 导入后在 HDFS 上产生的分区目录与 part 文件。
 */

export class VfsError extends Error {}

/** UTF-8 字节数：浏览器与 Node 通用（不能用 Buffer，浏览器没有） */
const utf8Bytes = (s) => new TextEncoder().encode(s).length;

const dir = (name) => ({ type: 'dir', name, children: new Map(), mtime: Date.now() });

export class VFS {
  constructor() {
    this.root = dir('');
    this.files = 0;
  }

  /** 规范化路径：折叠重复 /，去掉末尾 /（根除外） */
  static norm(p) {
    if (!p) return '/';
    const s = '/' + String(p).split('/').filter(Boolean).join('/');
    return s === '/' ? '/' : s.replace(/\/+$/, '');
  }

  static parent(p) {
    const n = VFS.norm(p);
    if (n === '/') return null;
    const i = n.lastIndexOf('/');
    return i === 0 ? '/' : n.slice(0, i);
  }

  static base(p) {
    const n = VFS.norm(p);
    return n === '/' ? '' : n.slice(n.lastIndexOf('/') + 1);
  }

  _node(path) {
    const n = VFS.norm(path);
    if (n === '/') return this.root;
    let cur = this.root;
    for (const seg of n.split('/').filter(Boolean)) {
      if (!cur.children) return null;
      const next = cur.children.get(seg);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  exists(path) { return this._node(path) !== null; }
  isDir(path) { return this._node(path)?.type === 'dir'; }
  isFile(path) { return this._node(path)?.type === 'file'; }

  /** 递归创建目录；若路径上已存在文件则报错 */
  mkdir(path) {
    const n = VFS.norm(path);
    let cur = this.root;
    for (const seg of n.split('/').filter(Boolean)) {
      const next = cur.children.get(seg);
      if (!next) {
        const d = dir(seg);
        cur.children.set(seg, d);
        cur = d;
      } else if (next.type === 'file') {
        throw new VfsError(`路径 ${path} 上已存在文件 ${seg}`);
      } else {
        cur = next;
      }
    }
    return n;
  }

  /** 写文件；自动创建父目录 */
  writeFile(path, content, meta = {}) {
    const n = VFS.norm(path);
    const p = VFS.parent(n);
    if (p) this.mkdir(p);
    const parent = this._node(p || '/');
    const name = VFS.base(n);
    if (parent.children.get(name)?.type === 'dir') {
      throw new VfsError(`路径 ${path} 是一个目录，不能写入文件`);
    }
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const bytes = meta.bytes ?? utf8Bytes(text);
    parent.children.set(name, {
      type: 'file', name, bytes, text, mtime: Date.now(),
      format: meta.format ?? 'textfile',
      rows: meta.rows ?? null,
      partition: meta.partition ?? null,
      comment: meta.comment ?? null,
    });
    this.files += 1;
    return n;
  }

  readFile(path) {
    const node = this._node(path);
    if (!node || node.type !== 'file') throw new VfsError(`文件不存在: ${path}`);
    return node.text;
  }

  /** ls：返回直接子项（目录优先） */
  ls(path = '/') {
    const node = this._node(path);
    if (!node) throw new VfsError(`路径不存在: ${path}`);
    if (node.type === 'file') {
      return [{ name: node.name, type: 'file', size: node.bytes, format: node.format, rows: node.rows }];
    }
    return [...node.children.values()]
      .map((c) => c.type === 'dir'
        ? { name: c.name, type: 'dir', size: null }
        : { name: c.name, type: 'file', size: c.bytes, format: c.format, rows: c.rows })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  /** 递归列出某目录下所有文件（用于校验分区目录内容） */
  findFiles(path = '/') {
    const out = [];
    const walk = (node, prefix) => {
      for (const c of node.children?.values() ?? []) {
        const full = `${prefix === '/' ? '' : prefix}/${c.name}`;
        if (c.type === 'dir') walk(c, full);
        else out.push({
          path: full, size: c.bytes, format: c.format, rows: c.rows, partition: c.partition,
        });
      }
    };
    const node = this._node(path);
    if (!node) throw new VfsError(`路径不存在: ${path}`);
    if (node.type === 'file') {
      return [{ path: VFS.norm(path), size: node.bytes, format: node.format, rows: node.rows, partition: node.partition }];
    }
    walk(node, VFS.norm(path) === '/' ? '/' : VFS.norm(path));
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** 目录树（给前端画图用） */
  tree(path = '/', depth = 3) {
    const node = this._node(path);
    if (!node) return null;
    const build = (n, pre, d) => {
      if (n.type === 'file') return { name: n.name, type: 'file', size: n.bytes, rows: n.rows, format: n.format };
      if (d <= 0) return { name: n.name, type: 'dir', truncated: true, count: n.children.size };
      return {
        name: n.name || '/', type: 'dir',
        children: [...n.children.values()].map((c) => build(c, pre, d - 1)),
      };
    };
    return build(node, VFS.norm(path), depth);
  }

  sizeOf(path = '/') {
    return this.findFiles(path).reduce((s, f) => s + (f.size ?? 0), 0);
  }

  /** 估算 textfile 字节数（按 CSV 行估算，非精确） */
  static estimateTextBytes(rows, ncols) {
    return rows * (ncols * 8 + 2);
  }
}
