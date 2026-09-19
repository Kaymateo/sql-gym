#!/usr/bin/env python3
"""
电力场景（电网营销/用电采集）仿真数据生成器
================================================
固定随机种子 → 完全可复现（同种子两次生成 md5 一致）。

产出：
  data/power/power.sqlite      沙箱库（浏览器 sql.js 直接加载）
  data/power/schema.json       表结构元数据（喂数据字典页 + 编辑器自动补全）
  data/power/dirty_report.json 脏数据实测比例（验收依据）

用法：
  python3 scripts/gen_power_data.py [--seed 20260918] [--small]
"""
import argparse
import hashlib
import json
import os
import random
import sqlite3
import sys
from collections import Counter
from datetime import date, datetime, timedelta

# ──────────────────────────── 规模参数 ────────────────────────────
P = {
    "org_units": 200,
    "stations": 300,
    "lines": 800,
    "transformers": 3000,
    "employees": 1500,
    "customers": 20000,
    "months": 4,              # 抄表/账单覆盖月数（越小库越小）
    "curve_meters": 50,       # 96 点曲线覆盖计量点数
    "curve_days": 31,
    "overages": 8000,
    "work_orders": 30000,
}

# ──────────────────────── 脏数据注入比例（设计值） ────────────────────────
DIRTY = {
    "meter_swap": 0.020,       # 换表导致表底跳变
    "ct_missed": 0.015,        # CT 倍率漏乘
    "estimated": 0.080,        # 估抄
    "closed_with_usage": 0.050,  # 销户用户仍有电量（客户维度）
    "outage_overlap": 0.060,   # 停电事件时间重叠
    "wo_time_reversed": 0.005,  # 工单完工早于受理
    "curve_missing": 0.030,    # 96 点缺采样（天维度）
    "negative_loss": 0.040,    # 台区线损为负
    "paid_but_owing": 0.020,   # 欠费但状态已缴
    "null_capacity": 0.030,    # 电压等级/容量为空
    "dup_bill": 0.008,         # 重复出账
}

CUST_TYPES = ["居民", "一般工商业", "大工业", "农业生产", "非居民"]
CUST_TYPE_W = [70, 18, 4, 5, 3]
VOLT = ["10kV", "35kV", "110kV", "220kV"]
LINE_VOLT = ["10kV", "35kV", "110kV", "220kV"]
CITIES = ["合肥", "芜湖", "蚌埠", "淮南", "马鞍山", "淮北", "铜陵", "安庆", "黄山", "滁州"]
INDUSTRY = ["制造业", "纺织业", "食品加工", "金属制品", "建材", "商业综合体", "酒店", "学校", "医院", None]
POSITIONS = ["抄表员", "装表接电工", "抢修工", "客户经理", "班长", "所长", "数据员"]
OUTAGE_REASON = ["计划检修", "故障", "限电", "用户申请"]
WO_TYPE = ["报修", "咨询", "投诉", "装表", "过户", "缴费查询"]


def month_list(start: date, n: int):
    out = []
    y, m = start.year, start.month
    for _ in range(n):
        out.append(f"{y:04d}{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def pick_weighted(rnd, items, weights):
    return rnd.choices(items, weights=weights, k=1)[0]


def build(rnd: random.Random, db_path: str):
    if os.path.exists(db_path):
        os.remove(db_path)
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.executescript("""
    CREATE TABLE org_units(
      org_id INTEGER PRIMARY KEY, org_name TEXT NOT NULL, parent_id INTEGER,
      org_level INTEGER NOT NULL, city TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE stations(
      station_id INTEGER PRIMARY KEY, station_name TEXT, org_id INTEGER,
      voltage_level TEXT, capacity_mva REAL, commission_date TEXT, status TEXT);
    CREATE TABLE lines(
      line_id INTEGER PRIMARY KEY, line_name TEXT, station_id INTEGER,
      voltage_level TEXT, length_km REAL, status TEXT);
    CREATE TABLE transformers(
      transformer_id INTEGER PRIMARY KEY, transformer_name TEXT, line_id INTEGER,
      capacity_kva REAL, status TEXT, install_date TEXT);
    CREATE TABLE employees(
      emp_id INTEGER PRIMARY KEY, emp_name TEXT, org_id INTEGER, position TEXT, hire_date TEXT);
    CREATE TABLE customers(
      customer_id INTEGER PRIMARY KEY, cust_no TEXT, cust_name TEXT, cust_type TEXT,
      industry_code TEXT, transformer_id INTEGER, address TEXT, status TEXT,
      archive_date TEXT, is_vip INTEGER DEFAULT 0);
    CREATE TABLE meters(
      meter_id INTEGER PRIMARY KEY, customer_id INTEGER, asset_no TEXT, meter_model TEXT,
      ct_ratio INTEGER, install_date TEXT, status TEXT, last_verify_date TEXT);
    CREATE TABLE meter_readings(
      reading_id INTEGER PRIMARY KEY, meter_id INTEGER, read_date TEXT, period TEXT,
      read_type TEXT, prev_total_kwh REAL, curr_total_kwh REAL, usage_kwh REAL,
      p_kwh REAL, q_kwh REAL, operator_id INTEGER);
    CREATE TABLE bills(
      bill_id INTEGER PRIMARY KEY, customer_id INTEGER, meter_id INTEGER, period TEXT,
      usage_kwh REAL, energy_fee REAL, basic_fee REAL, pf_fee REAL, additional_fee REAL,
      total_fee REAL, paid_amount REAL, pay_status TEXT, bill_date TEXT,
      due_date TEXT, paid_date TEXT);
    CREATE TABLE payments(
      payment_id INTEGER PRIMARY KEY, bill_id INTEGER, customer_id INTEGER,
      amount REAL, method TEXT, paid_at TEXT, status TEXT);
    CREATE TABLE outages(
      outage_id INTEGER PRIMARY KEY, transformer_id INTEGER, start_time TEXT, end_time TEXT,
      reason TEXT, affected_customers INTEGER, restore_minutes INTEGER);
    CREATE TABLE work_orders(
      order_id INTEGER PRIMARY KEY, customer_id INTEGER, order_type TEXT, org_id INTEGER,
      create_time TEXT, accept_time TEXT, finish_time TEXT, status TEXT, handler_id INTEGER);
    CREATE TABLE load_curve_96(
      meter_id INTEGER, data_date TEXT, point_index INTEGER, p_kw REAL, q_kvar REAL);
    CREATE TABLE tariff(
      tariff_id INTEGER PRIMARY KEY, cust_type TEXT, tier_no INTEGER, lower_kwh REAL,
      upper_kwh REAL, price REAL);
    """)

    # ── tariff（阶梯电价 / 分时电价，真实行业规则） ──
    tariff = [
        (1, "居民", 1, 0, 180, 0.5653), (2, "居民", 2, 180, 280, 0.6153), (3, "居民", 3, 280, None, 0.8653),
        (4, "一般工商业", 1, 0, None, 0.7830), (5, "大工业", 1, 0, None, 0.6418),
        (6, "农业生产", 1, 0, None, 0.4588), (7, "非居民", 1, 0, None, 0.7925),
    ]
    cur.executemany("INSERT INTO tariff VALUES(?,?,?,?,?,?)", tariff)

    # ── org_units：四级层级（省→市→县→供电所） ──
    org_rows = [(1, "省电力公司", None, 1, "合肥", 1)]
    oid = 2
    city_orgs, county_orgs, station_orgs = {}, {}, []
    for c in CITIES:
        org_rows.append((oid, f"{c}供电公司", 1, 2, c, 1))
        city_orgs[c] = oid
        oid += 1
    for c in CITIES:
        for k in range(2):
            org_rows.append((oid, f"{c}{'东南' if k == 0 else '西北'}县供电公司", city_orgs[c], 3, c, 1))
            county_orgs.setdefault(c, []).append(oid)
            oid += 1
    while oid <= P["org_units"]:
        c = rnd.choice(CITIES)
        parent = rnd.choice(county_orgs[c])
        org_rows.append((oid, f"{c}第{oid}供电所", parent, 4, c, 1))
        station_orgs.append(oid)
        oid += 1
    cur.executemany("INSERT INTO org_units VALUES(?,?,?,?,?,?)", org_rows)
    leaf_orgs = [r[0] for r in org_rows if r[3] == 4]

    # ── stations ──
    st_rows = []
    for i in range(1, P["stations"] + 1):
        v = pick_weighted(rnd, VOLT, [55, 30, 12, 3])
        cap = {"10kV": rnd.uniform(20, 63), "35kV": rnd.uniform(63, 180),
               "110kV": rnd.uniform(180, 400), "220kV": rnd.uniform(400, 900)}[v]
        st_rows.append((i, f"{rnd.choice(CITIES)}{i}号变电站", rnd.choice(leaf_orgs), v,
                        round(cap, 1), _d(rnd, date(1995, 1, 1), date(2023, 12, 31)),
                        rnd.choices(["在运", "停运", "退役"], [92, 5, 3])[0]))
    # 3% 容量为空（档案不全）
    for i, r in enumerate(st_rows):
        if rnd.random() < DIRTY["null_capacity"]:
            st_rows[i] = (r[0], r[1], r[2], r[3], None, r[4], r[5])
    cur.executemany("INSERT INTO stations VALUES(?,?,?,?,?,?,?)", st_rows)

    # ── lines ──
    ln_rows = []
    for i in range(1, P["lines"] + 1):
        st = rnd.choice(st_rows)
        ln_rows.append((i, f"{rnd.choice(CITIES)}{i}线路", st[0], st[3],
                        round(rnd.uniform(1.5, 85.0), 2),
                        rnd.choices(["在运", "停运", "退役"], [94, 4, 2])[0]))
    cur.executemany("INSERT INTO lines VALUES(?,?,?,?,?,?)", ln_rows)

    # ── transformers（配变台区） ──
    tr_rows = []
    for i in range(1, P["transformers"] + 1):
        ln = rnd.choice(ln_rows)
        tr_rows.append((i, f"{ln[1][:-2]}第{i}台区", ln[0], rnd.choice([100, 200, 315, 400, 630, 800, 1000]),
                        rnd.choices(["在运", "停运", "退役"], [93, 5, 2])[0],
                        _d(rnd, date(2000, 1, 1), date(2024, 5, 31))))
    cur.executemany("INSERT INTO transformers VALUES(?,?,?,?,?,?)", tr_rows)

    # ── employees ──
    emp_rows = [(i, f"员工{i:04d}", rnd.choice(org_rows)[0], rnd.choice(POSITIONS),
                 _d(rnd, date(1998, 1, 1), date(2024, 6, 1))) for i in range(1, P["employees"] + 1)]
    cur.executemany("INSERT INTO employees VALUES(?,?,?,?,?)", emp_rows)

    # ── customers ──
    cust_rows, closed_ids = [], []
    for i in range(1, P["customers"] + 1):
        ct = pick_weighted(rnd, CUST_TYPES, CUST_TYPE_W)
        status = rnd.choices(["在运", "暂停", "销户"], [90, 5, 5])[0]
        if status == "销户":
            closed_ids.append(i)
        tr = rnd.choice(tr_rows)
        cust_rows.append((i, f"CN{rnd.randint(10**9, 10**10 - 1)}", f"{ct}用户{i:05d}", ct,
                          rnd.choice(INDUSTRY) if rnd.random() > 0.15 else None,
                          tr[0], f"{rnd.choice(CITIES)}市XX路{rnd.randint(1, 999)}号", status,
                          _d(rnd, date(2010, 1, 1), date(2024, 5, 31)),
                          rnd.choices([0, 1], [88, 12])[0]))
    cur.executemany("INSERT INTO customers VALUES(?,?,?,?,?,?,?,?,?,?)", cust_rows)
    # 销户客户中 5% 仍继续产生电量与电费（脏数据）
    continuing_closed = {c for c in closed_ids if rnd.random() < DIRTY["closed_with_usage"]}

    # ── meters（CT 倍率关键） ──
    mt_rows = []
    mid = 0
    for c in cust_rows:
        n_meter = 1
        for _ in range(n_meter):
            mid += 1
            ct = rnd.choice([1, 1, 1, 1, 10, 20, 30, 40, 60, 80, 100])
            mt_rows.append((mid, c[0], f"ASSET{rnd.randint(10**8, 10**9 - 1)}",
                            rnd.choice(["DDZY", "DTZ", "DSZ", "DTSD"]),
                            ct, _d(rnd, date(2012, 1, 1), date(2024, 5, 31)),
                            rnd.choices(["运行", "故障", "拆除"], [95, 3, 2])[0],
                            _d(rnd, date(2020, 1, 1), date(2024, 5, 31))))
    cur.executemany("INSERT INTO meters VALUES(?,?,?,?,?,?,?,?)", mt_rows)

    # ── meter_readings（抄表电量，含 12 种脏数据里的 4 种） ──
    periods = month_list(date(2024, 3, 1), P["months"])
    rd_rows, bill_rows, pay_rows = [], [], []
    rid = bid = pid = 0
    base_kwh = {}   # meter_id -> 累计表底
    for m in mt_rows:
        meter_id, cust_id, ct_ratio = m[0], m[1], m[4]
        if cust_id in closed_ids and cust_id not in continuing_closed:
            continue          # 已销户且不再产生电量（干净数据）
        annual = {"居民": 2200, "一般工商业": 26000, "大工业": 260000,
                  "农业生产": 9000, "非居民": 12000}[cust_rows[cust_id - 1][3]]
        per_month = annual / 12.0 * rnd.uniform(0.75, 1.3)
        cum = rnd.uniform(50, 5000)
        closed = cust_id in closed_ids
        for pi, period in enumerate(periods):
            rid += 1
            # 抄表日期 1–25 号漂移
            rd = date(int(period[:4]), int(period[4:]), rnd.randint(1, 25))
            use = per_month * rnd.uniform(0.8, 1.2)
            read_type = "远抄" if ct_ratio > 1 else "抄见"
            if rnd.random() < DIRTY["estimated"]:
                read_type = "估抄"
                use = per_month * rnd.uniform(0.6, 1.4)   # 估抄偏离更大
            prev = cum
            # 换表（2% 月度记录）：新表从 0 起，但上期表底仍是旧表读数
            #   → 表底不连续，用 curr - prev 算电量会得到负数（真实生产 bug）
            swap = rnd.random() < DIRTY["meter_swap"]
            cum = use if swap else prev + use
            # CT 倍率漏乘（1.5%）：记的是表底差，未乘倍率
            missed_ct = ct_ratio > 1 and rnd.random() < DIRTY["ct_missed"]
            usage = use if not missed_ct else round(use / ct_ratio, 2)
            p_kwh = round(usage * rnd.uniform(0.92, 0.98), 2)
            q_kwh = round(usage * rnd.uniform(0.15, 0.55), 2)
            rd_rows.append((rid, meter_id, rd.isoformat(), period, read_type,
                            round(prev, 2), round(cum, 2), round(usage, 2), p_kwh, q_kwh,
                            rnd.choice(emp_rows)[0]))
            # ── bills ──
            bid += 1
            price = 0.5653 if cust_rows[cust_id - 1][3] == "居民" else {
                "一般工商业": 0.7830, "大工业": 0.6418, "农业生产": 0.4588, "非居民": 0.7925}[cust_rows[cust_id - 1][3]]
            energy_fee = round(usage * price, 2)
            ctype = cust_rows[cust_id - 1][3]
            basic_fee = round(rnd.uniform(300, 8000), 2) if ctype == "大工业" else 0.0
            pf = round(rnd.uniform(-0.02, 0.04) * energy_fee, 2)   # 力率调整可负
            add = round(energy_fee * 0.012, 2)
            total = round(energy_fee + basic_fee + pf + add, 2)
            bdate = rd.replace(day=min(26, rd.day + 1))
            due = (bdate + timedelta(days=20)).isoformat()
            r = rnd.random()
            if r < 0.72:
                status, paid_amt, paid_date = "已缴", total, (bdate + timedelta(days=rnd.randint(1, 19))).isoformat()
            elif r < 0.80:
                status, paid_amt, paid_date = "部分缴纳", round(total * rnd.uniform(0.2, 0.8), 2), None
            elif r < 0.92:
                status, paid_amt, paid_date = "欠费", 0.0, None
            else:
                status, paid_amt, paid_date = "未缴", 0.0, None
            # 「欠费但状态已缴」2%
            if status == "欠费" and rnd.random() < DIRTY["paid_but_owing"]:
                status = "已缴"
            bill_rows.append((bid, cust_id, meter_id, period, round(usage, 2), energy_fee,
                              basic_fee, pf, add, total, paid_amt, status, bdate.isoformat(),
                              due, paid_date))
            # 重复出账 0.8%
            if rnd.random() < DIRTY["dup_bill"]:
                bid += 1
                bill_rows.append((bid, cust_id, meter_id, period, round(usage, 2), energy_fee,
                                  basic_fee, pf, add, total, paid_amt, status,
                                  bdate.isoformat(), due, paid_date))
            # ── payments ──
            if paid_amt and paid_amt > 0:
                pid += 1
                pay_rows.append((pid, bid, cust_id, paid_amt,
                                 rnd.choice(["支付宝", "微信", "银行代扣", "柜面", "网银"]),
                                 (bdate + timedelta(days=rnd.randint(0, 25))).isoformat(),
                                 rnd.choices(["成功", "失败", "处理中"], [95, 4, 1])[0]))
    cur.executemany("INSERT INTO meter_readings VALUES(?,?,?,?,?,?,?,?,?,?,?)", rd_rows)
    cur.executemany("INSERT INTO bills VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", bill_rows)
    cur.executemany("INSERT INTO payments VALUES(?,?,?,?,?,?,?)", pay_rows)

    # ── outages（含时间重叠） ──
    out_rows, t_used = [], {}
    for i in range(1, P["overages"] + 1):
        tr = rnd.choice(tr_rows)
        st = datetime(2024, 3, 1) + timedelta(days=rnd.randint(0, 210), hours=rnd.randint(0, 23),
                                              minutes=rnd.randint(0, 59))
        dur = rnd.randint(15, 600)
        if rnd.random() < DIRTY["outage_overlap"] and tr[0] in t_used:
            st = t_used[tr[0]] + timedelta(minutes=rnd.randint(5, 120))
        et = st + timedelta(minutes=dur)
        t_used[tr[0]] = st
        out_rows.append((i, tr[0], st.strftime("%Y-%m-%d %H:%M:%S"), et.strftime("%Y-%m-%d %H:%M:%S"),
                         rnd.choice(OUTAGE_REASON), rnd.randint(1, 400), dur))
    cur.executemany("INSERT INTO outages VALUES(?,?,?,?,?,?,?)", out_rows)

    # ── work_orders（含时间倒挂） ──
    wo_rows = []
    for i in range(1, P["work_orders"] + 1):
        c = rnd.choice(cust_rows)
        ct = datetime(2024, 3, 1) + timedelta(days=rnd.randint(0, 210), hours=rnd.randint(6, 21),
                                              minutes=rnd.randint(0, 59))
        at = ct + timedelta(minutes=rnd.randint(1, 120))
        ft = at + timedelta(hours=rnd.randint(1, 72))
        if rnd.random() < DIRTY["wo_time_reversed"]:
            ft = ct - timedelta(hours=rnd.randint(1, 10))     # 完工早于受理
        wo_rows.append((i, c[0], rnd.choice(WO_TYPE), c[5] and rnd.choice(leaf_orgs),
                        ct.strftime("%Y-%m-%d %H:%M:%S"), at.strftime("%Y-%m-%d %H:%M:%S"),
                        ft.strftime("%Y-%m-%d %H:%M:%S"),
                        rnd.choices(["已完工", "处理中", "已派单", "已归档"], [78, 10, 8, 4])[0],
                        rnd.choice(emp_rows)[0]))
    cur.executemany("INSERT INTO work_orders VALUES(?,?,?,?,?,?,?,?,?)", wo_rows)

    # ── load_curve_96（96 点负荷曲线 + 缺采样） ──
    curve_rows = []
    big_meters = [m for m in mt_rows if cust_rows[m[1] - 1][3] in ("大工业", "一般工商业")]
    for m in big_meters[:P["curve_meters"]]:
        base = rnd.uniform(30, 400)
        for d in range(P["curve_days"]):
            day = date(2024, 6, 1) + timedelta(days=d)
            skip = set()
            if rnd.random() < DIRTY["curve_missing"]:
                skip = set(rnd.sample(range(1, 97), rnd.randint(2, 5)))   # 采集失败
            for pt in range(1, 97):
                if pt in skip:
                    continue
                hour = (pt - 1) / 4.0
                shape = 0.6 + 0.5 * (1 if 8 <= hour <= 11 or 17 <= hour <= 21 else 0)
                p = base * shape * rnd.uniform(0.9, 1.1)
                curve_rows.append((m[0], day.isoformat(), pt, round(p, 3),
                                   round(p * rnd.uniform(0.2, 0.4), 3)))
    cur.executemany("INSERT INTO load_curve_96 VALUES(?,?,?,?,?)", curve_rows)

    # ── 台区总表供电量 transformer_supply（线损率 = (供电量-售电量)/供电量） ──
    # 4% 的台区故意让「供电量 < 售电量」→ 线损率为负（现场数据异常）
    cur.execute("""CREATE TABLE transformer_supply(
        transformer_id INTEGER, period TEXT, supply_kwh REAL, read_type TEXT)""")
    sale = {(t, p): s for t, p, s in cur.execute("""
        SELECT c.transformer_id, b.period, SUM(b.usage_kwh)
        FROM bills b JOIN customers c ON c.customer_id = b.customer_id
        WHERE b.usage_kwh IS NOT NULL
        GROUP BY c.transformer_id, b.period""").fetchall()}
    neg_trs = set(rnd.sample([t[0] for t in tr_rows], n_neg := int(P["transformers"] * DIRTY["negative_loss"])))
    sup_rows = []
    for t in tr_rows:
        for period in periods:
            sale_kwh = sale.get((t[0], period), 0.0) or 0.0
            if sale_kwh <= 0:
                continue
            ratio = rnd.uniform(0.90, 0.985) if t[0] in neg_trs else rnd.uniform(1.03, 1.12)
            sup_rows.append((t[0], period, round(sale_kwh * ratio, 2), "抄见"))
    cur.executemany("INSERT INTO transformer_supply VALUES(?,?,?,?)", sup_rows)
    con.commit()

    indexes = [
        "CREATE INDEX idx_cust_tr ON customers(transformer_id)",
        "CREATE INDEX idx_meter_cust ON meters(customer_id)",
        "CREATE INDEX idx_rd_meter_period ON meter_readings(meter_id, period)",
        "CREATE INDEX idx_bill_cust_period ON bills(customer_id, period)",
        "CREATE INDEX idx_bill_period ON bills(period)",
        "CREATE INDEX idx_pay_bill ON payments(bill_id)",
        "CREATE INDEX idx_wo_cust ON work_orders(customer_id)",
        "CREATE INDEX idx_curve ON load_curve_96(meter_id, data_date)",
    ]
    for s in indexes:
        cur.execute(s)
    con.commit()
    return con


def _d(rnd, start: date, end: date) -> str:
    return (start + timedelta(days=rnd.randint(0, (end - start).days))).isoformat()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20260918)
    ap.add_argument("--size", choices=["small", "full"], default="small",
                    help="small=浏览器沙箱库(<15MB)  full=全量(供服务端大库)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "power"))
    a = ap.parse_args()

    # 规模预设：small 必须把 sqlite 压在 15MB 以内（浏览器 WASM 加载）
    presets = {
        "small": {"customers": 6000, "curve_meters": 20, "work_orders": 12000,
                  "overages": 4000, "months": 4},
        "full":  {"customers": 20000, "curve_meters": 100, "work_orders": 30000,
                  "overages": 8000, "months": 12},
    }
    P.update(presets[a.size])

    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    db_path = os.path.join(out, "power.sqlite")

    rnd = random.Random(a.seed)
    con = build(rnd, db_path)
    con.commit()

    # 实测脏数据比例
    q = lambda s: con.execute(s).fetchone()[0]
    rep = {
        "seed": a.seed,
        "meter_swap_rate": round(q("SELECT 1.0*SUM(CASE WHEN curr_total_kwh < prev_total_kwh THEN 1 ELSE 0 END)/COUNT(*) FROM meter_readings"), 4),
        "estimated_rate": round(q("SELECT 1.0*SUM(CASE WHEN read_type='估抄' THEN 1 ELSE 0 END)/COUNT(*) FROM meter_readings"), 4),
        # CT 倍率漏乘的检测：某行电量显著低于该计量点自身均值（≈1/倍率）
        "ct_missed_rows": q("""
            WITH w AS (SELECT r.usage_kwh AS u, m.ct_ratio AS ct,
                              AVG(r.usage_kwh) OVER (PARTITION BY r.meter_id) AS avg_u
                       FROM meter_readings r JOIN meters m ON m.meter_id = r.meter_id)
            SELECT COUNT(*) FROM w WHERE ct > 1 AND u < avg_u / 2"""),
        "closed_customers": q("SELECT COUNT(*) FROM customers WHERE status='销户'"),
        "closed_with_usage": q("SELECT COUNT(DISTINCT b.customer_id) FROM bills b JOIN customers c ON c.customer_id=b.customer_id WHERE c.status='销户'"),
        "wo_time_reversed": q("SELECT COUNT(*) FROM work_orders WHERE finish_time < accept_time"),
        "paid_but_owing": q("SELECT COUNT(*) FROM bills WHERE pay_status='已缴' AND paid_amount=0"),
        "null_industry": q("SELECT COUNT(*) FROM customers WHERE industry_code IS NULL"),
        "null_capacity": q("SELECT COUNT(*) FROM stations WHERE capacity_mva IS NULL"),
        "dup_bill_rate": round(q("SELECT 1.0*(COUNT(*)-COUNT(DISTINCT customer_id||'-'||period))/COUNT(*) FROM bills"), 4),
        "curve_points": q("SELECT COUNT(*) FROM load_curve_96"),
        "curve_full": P["curve_meters"] * P["curve_days"] * 96,
    }
    rep["curve_missing_rate"] = round(1 - rep["curve_points"] / rep["curve_full"], 4)
    rep["closed_with_usage_rate"] = round(rep["closed_with_usage"] / max(1, rep["closed_customers"]), 4)
    # 线损率为负的台区比例
    neg = q("""SELECT COUNT(*) FROM (
                 SELECT s.transformer_id, s.period,
                        s.supply_kwh - COALESCE(x.sale,0) AS loss
                 FROM transformer_supply s LEFT JOIN (
                     SELECT c.transformer_id AS tid, b.period AS p, SUM(b.usage_kwh) AS sale
                     FROM bills b JOIN customers c ON c.customer_id=b.customer_id
                     GROUP BY c.transformer_id, b.period) x
                 ON x.tid=s.transformer_id AND x.p=s.period
                 WHERE s.supply_kwh - COALESCE(x.sale,0) < 0)""")
    tot = q("SELECT COUNT(*) FROM transformer_supply")
    rep["negative_loss_rate"] = round(neg / max(1, tot), 4)
    rep["designed"] = DIRTY          # 设计比例，供验收对比
    rep["size_preset"] = a.size

    # 各表行数
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    rep["tables"] = {t: q(f"SELECT COUNT(*) FROM {t}") for t in tables}
    rep["total_rows"] = sum(rep["tables"].values())
    con.close()

    with open(os.path.join(out, "dirty_report.json"), "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=2)
    print(json.dumps(rep, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
