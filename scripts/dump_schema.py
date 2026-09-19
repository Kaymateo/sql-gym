#!/usr/bin/env python3
"""
导出数仓元数据（schema.json）
------------------------------------------------------------------
从 sqlite 反射表结构，合并人工维护的中文字段注释，
产出浏览器端用的 schema.json（数据字典页 + 编辑器自动补全 + 校验器语义检查）。

用法：python3 scripts/dump_schema.py --scene power --db data/power/power.sqlite
"""
import argparse
import json
import os
import sqlite3

COMMENTS = {
    "org_units": {
        "org_id": "供电单位ID", "org_name": "单位名称", "parent_id": "上级单位ID（四级层级）",
        "org_level": "层级：1省 2市 3县 4供电所", "city": "所属地市", "is_active": "是否有效",
    },
    "stations": {
        "station_id": "变电站ID", "station_name": "变电站名称", "org_id": "所属供电单位",
        "voltage_level": "电压等级(kV)", "capacity_mva": "主变容量(MVA，3%为空)",
        "commission_date": "投运日期", "status": "状态：在运/停运/退役",
    },
    "lines": {
        "line_id": "线路ID", "line_name": "线路名称", "station_id": "所属变电站",
        "voltage_level": "电压等级", "length_km": "线路长度(km)", "status": "状态",
    },
    "transformers": {
        "transformer_id": "配变台区ID", "transformer_name": "台区名称", "line_id": "所属线路",
        "capacity_kva": "配变容量(kVA)", "status": "状态：在运/停运/退役", "install_date": "投运日期",
    },
    "employees": {
        "emp_id": "员工ID", "emp_name": "姓名", "org_id": "所属单位",
        "position": "岗位：抄表员/抢修工/客户经理等", "hire_date": "入职日期",
    },
    "customers": {
        "customer_id": "用户ID", "cust_no": "用户编号(10位)", "cust_name": "用户名称",
        "cust_type": "用户类别：居民/一般工商业/大工业/农业生产/非居民",
        "industry_code": "行业分类码（约24%为空）", "transformer_id": "所属配变台区",
        "address": "用电地址", "status": "状态：在运/暂停/销户（销户后可能仍有历史电量）",
        "archive_date": "建档日期", "is_vip": "是否VIP用户",
    },
    "meters": {
        "meter_id": "计量点ID", "customer_id": "用户ID", "asset_no": "资产编号",
        "meter_model": "表计型号", "ct_ratio": "CT电流互感器倍率（漏乘会导致电量偏小数十倍）",
        "install_date": "安装日期", "status": "状态：运行/故障/拆除", "last_verify_date": "最近检定日期",
    },
    "meter_readings": {
        "reading_id": "抄表记录ID", "meter_id": "计量点ID", "read_date": "抄表日期（每月1-25号漂移）",
        "period": "账期YYYYMM", "read_type": "抄表方式：抄见/估抄/远抄（估抄约8%）",
        "prev_total_kwh": "上期表底(kWh)", "curr_total_kwh": "本期表底(kWh)",
        "usage_kwh": "本期电量(kWh)【注意：约2%记录因换表导致表底不连续，curr-prev会得到负数】",
        "p_kwh": "有功电量(kWh)", "q_kwh": "无功电量(kvarh)", "operator_id": "抄表人",
    },
    "bills": {
        "bill_id": "账单ID", "customer_id": "用户ID", "meter_id": "计量点ID", "period": "账期YYYYMM",
        "usage_kwh": "计费电量(kWh)", "energy_fee": "电度电费(元)",
        "basic_fee": "基本电费(元，大工业按容量计)", "pf_fee": "力率调整电费(元，可为负=奖励)",
        "additional_fee": "附加费(元)", "total_fee": "应收总额(元)", "paid_amount": "已收金额(元)",
        "pay_status": "缴费状态：未缴/已缴/部分缴纳/欠费（约2%欠费但状态为已缴）",
        "bill_date": "出账日期", "due_date": "应交截止日", "paid_date": "实交日期",
    },
    "payments": {
        "payment_id": "缴费流水ID", "bill_id": "账单ID", "customer_id": "用户ID",
        "amount": "缴费金额(元)", "method": "缴费渠道：支付宝/微信/银行代扣/柜面/网银",
        "paid_at": "到账时间", "status": "状态：成功/失败/处理中",
    },
    "outages": {
        "outage_id": "停电事件ID", "transformer_id": "配变台区ID", "start_time": "停电开始时间",
        "end_time": "恢复时间", "reason": "原因：计划检修/故障/限电/用户申请",
        "affected_customers": "影响户数", "restore_minutes": "停电时长(分钟)",
    },
    "work_orders": {
        "order_id": "工单ID", "customer_id": "用户ID", "order_type": "类型：报修/咨询/投诉/装表/过户/缴费查询",
        "org_id": "受理单位", "create_time": "受理时间", "accept_time": "派单时间",
        "finish_time": "完工时间（约0.5%记录早于受理时间=脏数据）", "status": "状态",
        "handler_id": "处理人",
    },
    "load_curve_96": {
        "meter_id": "计量点ID", "data_date": "数据日期", "point_index": "采样点序号1-96（15分钟一点）",
        "p_kw": "有功功率(kW)", "q_kvar": "无功功率(kvar)【约3%的天数有采集失败缺采样点】",
    },
    "transformer_supply": {
        "transformer_id": "配变台区ID", "period": "账期YYYYMM",
        "supply_kwh": "台区总表供电量(kWh)【线损率=(供电量-售电量)/供电量，约4%台区为负=异常】",
        "read_type": "抄表方式",
    },
    "tariff": {
        "tariff_id": "电价ID", "cust_type": "用户类别", "tier_no": "阶梯档位",
        "lower_kwh": "本档下限(kWh)", "upper_kwh": "本档上限(kWh，NULL=不限)", "price": "电价(元/kWh)",
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default="power")
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.db)), "schema.json")

    con = sqlite3.connect(a.db)
    cur = con.cursor()
    tables = [r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    schema = {}
    for t in tables:
        cols = []
        for _cid, name, ctype, notnull, _dflt, pk in cur.execute(f"PRAGMA table_info({t})"):
            cols.append({
                "name": name,
                "type": (ctype or "TEXT").lower(),
                "pk": bool(pk),
                "notnull": bool(notnull),
                "comment": COMMENTS.get(t, {}).get(name, ""),
            })
        schema[t] = cols
    rowcounts = {t: cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}
    con.close()

    doc = {
        "scene": a.scene,
        "generated_from": os.path.basename(a.db),
        "table_count": len(schema),
        "tables": schema,
        "row_counts": rowcounts,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    missing = [f"{t}.{c['name']}" for t, cols in schema.items() for c in cols if not c["comment"]]
    print(f"✅ {out}")
    print(f"   表 {len(schema)} 张 / 字段 {sum(len(v) for v in schema.values())} 个 / 未写注释 {len(missing)} 个")
    if missing[:5]:
        print(f"   缺注释示例：{', '.join(missing[:5])}")


if __name__ == "__main__":
    main()
