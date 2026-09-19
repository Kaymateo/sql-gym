#!/usr/bin/env python3
"""
补全 schema.json 的表级中文信息
------------------------------------------------------------------
原 schema.json 只有字段注释，没有「表中文名/表含义」，导致数据地图里表名一片英文。
本脚本为每个场景写入 table_comments：{英文表名: {"cn": 中文表名, "desc": 表含义}}

顺带把每个字段的中文名（cn）也补上——从注释里取主名（括号/冒号前的那部分），
用于「字段名 / 中文名 / 类型 / 业务含义」四列展示。

用法：python3 scripts/add_table_comments.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TABLE_COMMENTS = {
    "power": {
        "org_units": {"cn": "供电单位", "desc": "省-市-县-供电所四级组织架构，用于统计口径归属"},
        "stations": {"cn": "变电站", "desc": "变电站档案：电压等级、主变容量、投运日期"},
        "lines": {"cn": "线路", "desc": "输电/配电线路档案，归属变电站"},
        "transformers": {"cn": "配变台区", "desc": "配变台区（线损考核的最小单元），归属线路"},
        "employees": {"cn": "员工", "desc": "员工档案：岗位（抄表员/抢修工/客户经理等）"},
        "customers": {"cn": "用户档案", "desc": "用电客户档案：用户类别、行业、所属台区、在运状态"},
        "meters": {"cn": "计量点(电能表)", "desc": "电能表档案，含 CT 倍率——抄见电量需乘倍率才是实际电量"},
        "meter_readings": {"cn": "抄表电量", "desc": "按月抄见的电量记录，含抄见/估抄/远抄三种方式"},
        "bills": {"cn": "电费账单", "desc": "月度电费账单：电度电费+基本电费+力率调整电费"},
        "payments": {"cn": "缴费流水", "desc": "用户缴费记录，含渠道与到账状态"},
        "outages": {"cn": "停电事件", "desc": "台区停电记录：起止时间、原因（计划/故障/限电）"},
        "work_orders": {"cn": "服务工单", "desc": "报修/咨询/投诉/装表等工单，含受理与完工时间"},
        "load_curve_96": {"cn": "96点负荷曲线", "desc": "每 15 分钟一个采样点的功率数据（96 点/天），用于峰谷分析"},
        "transformer_supply": {"cn": "台区总表供电量", "desc": "台区总表抄见电量，用于计算线损率"},
        "tariff": {"cn": "电价表", "desc": "目录电价：居民阶梯电价与各类别单价"},
    },
    "bank": {
        "branches": {"cn": "机构网点", "desc": "总行-分行-支行三级机构，业务归属与考核单元"},
        "employees": {"cn": "员工", "desc": "员工档案：柜员/客户经理及其所属机构"},
        "customers": {"cn": "客户", "desc": "个人/对公客户：风险等级、AUM、开户机构"},
        "accounts": {"cn": "账户", "desc": "活期/定期/对公结算账户：余额、利率、状态"},
        "transactions": {"cn": "交易流水", "desc": "账户交易明细：借贷方向、金额、渠道、冲正状态"},
        "loans": {"cn": "贷款", "desc": "贷款台账：类型、余额、利率、还款方式、核销状态"},
        "loan_repayments": {"cn": "还款计划与实还", "desc": "逐期应还本息与实际还款记录，用于算逾期"},
        "overdue_records": {"cn": "逾期与五级分类", "desc": "逾期天数(DPD)与五级分类，不良率计算的来源"},
        "credit_cards": {"cn": "信用卡", "desc": "信用卡额度与账期信息"},
        "card_statements": {"cn": "信用卡账单", "desc": "每期账单金额、最低还款、已还金额"},
        "card_repayments": {"cn": "信用卡还款明细", "desc": "单张账单的分次还款记录"},
        "deposits_daily": {"cn": "存款日终快照", "desc": "账户每日日终余额，用于计算日均存款"},
        "wealth_products": {"cn": "理财产品", "desc": "理财产品：风险等级、期限、预期收益率"},
        "wealth_holdings": {"cn": "理财持仓", "desc": "客户持仓：买入金额、赎回日期（空=持有中）"},
        "aml_alerts": {"cn": "反洗钱预警", "desc": "可疑交易预警：命中规则、金额、处理状态"},
    },
}


def cn_name_from_comment(comment: str) -> str:
    """从注释里取中文字段名：括号/冒号/全角括号之前的部分"""
    if not comment:
        return ""
    head = re.split(r"[（(：:，,、\[]", comment, 1)[0].strip()
    return head[:24]


def main() -> int:
    total_tables = total_cols = 0
    for scene, tables in TABLE_COMMENTS.items():
        path = os.path.join(ROOT, "data", scene, "schema.json")
        if not os.path.exists(path):
            print(f"⚠️  跳过 {scene}：{path} 不存在")
            continue
        doc = json.load(open(path, encoding="utf-8"))
        doc["table_comments"] = tables
        unknown = [t for t in doc.get("tables", {}) if t not in tables]
        for t, cols in doc.get("tables", {}).items():
            for c in cols:
                c["cn"] = cn_name_from_comment(c.get("comment", ""))
            total_cols += len(cols)
        total_tables += len(doc.get("tables", {}))
        json.dump(doc, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        miss = sum(1 for cols in doc.get("tables", {}).values() for c in cols if not c.get("cn"))
        print(f"✅ {scene}: {len(doc.get('tables', {}))} 表 / {len(tables)} 条表注释"
              f"{' / ⚠️ 未覆盖：' + ','.join(unknown) if unknown else ''} / 字段缺中文名 {miss}")
    print(f"\n合计：{total_tables} 张表 / {total_cols} 个字段，已补 cn 字段名与表含义")
    return 0


if __name__ == "__main__":
    sys.exit(main())
