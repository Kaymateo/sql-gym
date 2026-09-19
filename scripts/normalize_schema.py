#!/usr/bin/env python3
"""
schema.json 归一化
------------------------------------------------------------------
不同数据生成器可能产出不同的 schema.json 结构，前端与校验引擎需要统一格式：

  {"scene": "...", "tables": {"表名": [{"name","type","pk","notnull","comment"}, ...]}, "row_counts": {...}}

本脚本接受以下两种输入结构并统一为标准格式：
  A) {"tables": {"t": [列, ...]}}                       ← gen_power_data + dump_schema.py
  B) {"tables": {"t": {"columns": [列, ...], ...}}}      ← gen_bank_data.py

用法：python3 scripts/normalize_schema.py data/bank/schema.json [--db data/bank/bank.sqlite]
"""
import argparse
import json
import os
import sqlite3
import sys

FIELD_KEYS = ("name", "type", "pk", "notnull", "comment", "comment_zh", "desc", "description")


def norm_column(c, db_cols=None, table=None):
    if isinstance(c, str):
        base = {"name": c, "type": (db_cols or {}).get(c, "text"), "pk": False, "notnull": False, "comment": ""}
        return base
    out = {
        "name": c.get("name") or c.get("field") or c.get("column") or "",
        "type": (c.get("type") or c.get("data_type") or (db_cols or {}).get(c.get("name", ""), "text")).lower(),
        "pk": bool(c.get("pk") or c.get("primary_key")),
        "notnull": bool(c.get("notnull") or c.get("not_null")),
        "comment": c.get("comment") or c.get("comment_zh") or c.get("desc") or c.get("description") or "",
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--db", default=None, help="可选：从 sqlite 反射补齐类型/主键/非空")
    ap.add_argument("--scene", default=None)
    ap.add_argument("--inplace", action="store_true", default=True)
    a = ap.parse_args()

    doc = json.load(open(a.path, encoding="utf-8"))
    tables_raw = doc.get("tables") or doc

    reflected = {}
    row_counts = doc.get("row_counts") or {}
    db_path = a.db
    if not db_path:
        guess = os.path.join(os.path.dirname(os.path.abspath(a.path)), os.path.basename(a.path).replace("schema.json", "") + "")
        for cand in (f"{doc.get('generated_from','')}", "power.sqlite", "bank.sqlite"):
            p = os.path.join(os.path.dirname(os.path.abspath(a.path)), cand) if cand else None
            if p and os.path.exists(p):
                db_path = p
                break
    if db_path and os.path.exists(db_path):
        con = sqlite3.connect(db_path)
        for (t,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            reflected[t] = {
                r[1]: {"type": (r[2] or "text").lower(), "pk": bool(r[5]), "notnull": bool(r[3])}
                for r in con.execute(f"PRAGMA table_info({t})")
            }
            if t not in row_counts:
                row_counts[t] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        con.close()

    out_tables = {}
    stats = {"tables": 0, "columns": 0, "no_comment": []}
    for tname, val in tables_raw.items():
        db_cols = {k: v["type"] for k, v in (reflected.get(tname) or {}).items()}
        if isinstance(val, dict) and "columns" in val:
            cols = [norm_column(c, db_cols, tname) for c in val["columns"]]
        elif isinstance(val, list):
            cols = [norm_column(c, db_cols, tname) for c in val]
        else:
            cols = []
        # 用反射结果补齐缺失的类型/主键
        for c in cols:
            ref = (reflected.get(tname) or {}).get(c["name"])
            if ref:
                if not c["type"] or c["type"] in ("text", ""):
                    c["type"] = ref["type"]
                c["pk"] = c["pk"] or ref["pk"]
                c["notnull"] = c["notnull"] or ref["notnull"]
            if not c["comment"]:
                stats["no_comment"].append(f"{tname}.{c['name']}")
        out_tables[tname] = cols
        stats["tables"] += 1
        stats["columns"] += len(cols)

    out = {
        "scene": a.scene or doc.get("scene") or "unknown",
        "generated_from": doc.get("generated_from") or (os.path.basename(db_path) if db_path else None),
        "table_count": len(out_tables),
        "tables": out_tables,
        "row_counts": row_counts,
    }
    with open(a.path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"✅ 归一化完成：{a.path}")
    print(f"   表 {stats['tables']} 张 / 字段 {stats['columns']} 个 / 无注释 {len(stats['no_comment'])} 个")
    if stats["no_comment"][:5]:
        print(f"   缺注释示例：{', '.join(stats['no_comment'][:5])}")


if __name__ == "__main__":
    main()
