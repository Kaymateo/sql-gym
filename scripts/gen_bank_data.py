#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
银行场景（零售 + 信贷）仿真数据生成器
==========================================
固定随机种子 → 完全可复现（同种子两次生成 bank.sqlite 的 md5 一致）。
仅使用 Python 标准库：argparse / hashlib / json / os / random / sqlite3 / datetime。

产出：
  data/bank/bank.sqlite       沙箱库（浏览器 sql.js 直接加载，small < 15MB）
  data/bank/schema.json       表结构元数据（表名 → 每列 name/type/comment，中文业务解释）
  data/bank/dirty_report.json 脏数据实测比例 + 各表行数（验收依据）

用法：
  python3 scripts/gen_bank_data.py [--seed 20260918] [--size small|full] [--out data/bank]
"""
import argparse
import json
import os
import random
import sqlite3
from datetime import date, datetime, timedelta

# ──────────────────────────── 规模参数（small 基准） ────────────────────────────
P = {
    "branches": 60,            # 1 总行 + 10 分行 + 49 支行
    "employees": 900,
    "customers": 5000,
    "accounts": 8000,
    "transactions": 40000,     # 体积主要来源
    "loans": 4000,
    "max_installments": 6,     # 每笔贷款生成最近 N 期还款计划
    "overdue_records": 6000,
    "credit_cards": 3000,
    "statements_per_card": 4,  # 信用卡账单期数
    "deposit_accounts": 1500,  # 有日终快照的账户数
    "deposit_days": 12,        # 日终快照天数
    "wealth_products": 40,
    "wealth_holdings": 5000,
    "aml_extra": 60,           # 除可疑取现外的额外反洗钱预警
}

# ──────────────────────── 脏数据注入比例（设计值） ────────────────────────
# 键名与 dirty_report.json 里的实测比例键名一一对应，便于自动比对。
DIRTY = {
    "reversed_failed_rate": 0.025,        # 冲正/失败交易
    "balance_mismatch_rate": 0.040,       # balance_after 与流水累加不一致
    "value_date_cross_day_rate": 0.090,   # 记账日 = 交易日 + 1~3 天
    "closed_account_txn_rate": 0.020,     # 销户账户仍有交易记录
    "closed_loan_outstanding_rate": 0.015,  # 已结清贷款余额不为 0
    "classification_mismatch_rate": 0.060,  # 五级分类与 DPD 不匹配
    "card_overpayment_rate": 0.030,       # 信用卡溢缴款
    "multi_partial_repay_rate": 0.150,    # 一笔账单 2~3 条部分还款记录
    "suspicious_withdraw_rate": 0.004,    # 10 分钟内多笔等额取现（可疑交易）
    "wealth_null_redeem_rate": 0.150,     # 理财持仓赎回日期为 NULL（持有中）
    "negative_amount_rate": 0.003,        # 金额为负的异常流水
    "null_counterparty_rate": 0.200,      # 对手方名称为空
    "branch_level_inconsistent_rate": 0.120,  # 支行直接挂总行（层级深度不一致）
}

# ──────────────────────────── 业务枚举 ────────────────────────────
CITIES = ["北京", "上海", "广州", "深圳", "杭州", "南京", "成都", "武汉", "西安", "苏州"]
POSITIONS = ["柜员", "客户经理", "大堂经理", "信贷审批", "支行行长", "风控专员", "运营主管", "理财顾问"]
MANAGER_POS = ("客户经理", "理财顾问")     # 视为客户经理条线
CUST_TYPES = ["个人", "对公"]
CUST_TYPE_W = [85, 15]
ID_TYPES_P = ["身份证", "护照", "港澳台居民居住证"]
ID_TYPES_C = ["统一社会信用代码", "营业执照"]
RISK_LEVELS = ["低", "中", "高"]
ACCT_TYPES = ["活期", "定期", "对公结算"]
ACCT_TYPE_W = [62, 22, 16]
CURRENCIES = ["CNY", "CNY", "CNY", "CNY", "USD", "HKD", "EUR"]
TXN_TYPES = ["转账", "消费", "取现", "工资代发", "缴费", "理财申购"]
LOAN_TYPES = ["房贷", "经营贷", "消费贷", "信用贷"]
LOAN_TYPE_W = [40, 20, 25, 15]
REPAY_METHODS = ["等额本息", "等额本金", "先息后本"]
CARD_STATUS = ["正常", "冻结", "销户"]
CLASSIFICATIONS = ["正常", "关注", "次级", "可疑", "损失"]
AML_RULES = ["R01", "R02", "R03", "R04"]
AML_STATUS = ["待处理", "已排除", "已上报"]

SURNAME = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜谢邹"
GIVEN = ["伟", "芳", "娜", "敏", "静", "丽", "强", "磊", "洋", "艳", "勇", "军", "杰",
         "娟", "涛", "明", "超", "霞", "平", "刚", "秀英", "桂英", "文杰", "雨欣"]
BRAND = ["华创", "中远", "恒瑞", "蓝海", "天翼", "安信", "金石", "长虹", "汇通", "嘉合",
         "瑞丰", "德胜", "天润", "宏源", "中辉", "远东", "新元", "嘉信"]
SUFFIX = ["科技有限公司", "贸易有限公司", "建筑工程有限公司", "物流有限公司", "医药有限公司",
          "食品有限公司", "机械制造有限公司", "信息咨询有限公司", "文化传媒有限公司", "环保科技有限公司"]
MALLS = ["京东商城", "天猫超市", "美团外卖", "永辉超市", "屈臣氏", "国美电器", "携程旅行",
         "滴滴出行", "星巴克咖啡", "华为商城", "山姆会员店", "苏宁易购", "贝壳找房", "中国石化"]
UTILS = ["市自来水公司", "国家电网供电公司", "中国移动通信", "中国联通", "城市燃气公司",
         "物业管理有限公司", "有线电视网络公司"]
INDUSTRY = ["制造业", "批发零售业", "建筑业", "交通运输业", "信息技术服务业", "房地产业",
            "住宿餐饮业", "医药健康业", "教育业", "农林牧渔业"]

DATA_START = date(2026, 1, 1)      # 流水观察期起点
DATA_END = date(2026, 6, 30)       # 流水观察期终点 / 统计基准日
SNAPSHOT_DATES = [date(2026, 6, 30) - timedelta(days=30 * i) for i in range(4)]  # 逾期统计日
DB_LIMIT_MB = 15.0                 # small 预设硬上限（浏览器 sql.js 加载）


# ════════════════════════════ 表结构元数据（schema.json 来源 + DDL 来源） ════════════════════════════
SCHEMA = {
    "branches": {
        "comment": "机构（三级层级：总行→分行→支行，parent_id 自关联）",
        "columns": [
            {"name": "branch_id", "type": "INTEGER", "comment": "机构ID 主键", "pk": True},
            {"name": "branch_name", "type": "TEXT", "comment": "机构名称"},
            {"name": "branch_level", "type": "INTEGER", "comment": "层级 1总行/2分行/3支行"},
            {"name": "parent_id", "type": "INTEGER", "comment": "上级机构ID（自关联 branches.branch_id，总行为空）"},
            {"name": "city", "type": "TEXT", "comment": "所在城市"},
            {"name": "branch_type", "type": "TEXT", "comment": "机构类型 总行/分行/支行"},
            {"name": "open_date", "type": "TEXT", "comment": "机构开业日期"},
            {"name": "status", "type": "TEXT", "comment": "状态 正常/停业"},
        ],
    },
    "employees": {
        "comment": "员工（所属机构、岗位、是否客户经理）",
        "columns": [
            {"name": "emp_id", "type": "INTEGER", "comment": "员工ID 主键", "pk": True},
            {"name": "emp_no", "type": "TEXT", "comment": "员工工号"},
            {"name": "emp_name", "type": "TEXT", "comment": "员工姓名"},
            {"name": "branch_id", "type": "INTEGER", "comment": "所属机构ID"},
            {"name": "position", "type": "TEXT", "comment": "岗位 柜员/客户经理/信贷审批等"},
            {"name": "is_manager", "type": "INTEGER", "comment": "是否客户经理条线 1是/0否"},
            {"name": "hire_date", "type": "TEXT", "comment": "入职日期"},
            {"name": "status", "type": "TEXT", "comment": "状态 在职/离职"},
        ],
    },
    "customers": {
        "comment": "客户（个人/对公，风险等级，开户机构，AUM 管理资产）",
        "columns": [
            {"name": "customer_id", "type": "INTEGER", "comment": "客户ID 主键", "pk": True},
            {"name": "cust_no", "type": "TEXT", "comment": "客户号（业务系统唯一编号）"},
            {"name": "cust_name", "type": "TEXT", "comment": "客户名称（个人姓名/企业名称）"},
            {"name": "cust_type", "type": "TEXT", "comment": "客户类型 个人/对公"},
            {"name": "id_type", "type": "TEXT", "comment": "证件类型 身份证/护照/统一社会信用代码"},
            {"name": "id_no", "type": "TEXT", "comment": "证件号码（脱敏展示）"},
            {"name": "risk_level", "type": "TEXT", "comment": "风险等级 高/中/低"},
            {"name": "open_branch_id", "type": "INTEGER", "comment": "开户机构ID"},
            {"name": "open_date", "type": "TEXT", "comment": "开户日期"},
            {"name": "aum", "type": "REAL", "comment": "AUM 管理资产规模（元）"},
            {"name": "industry", "type": "TEXT", "comment": "所属行业（对公客户）"},
            {"name": "status", "type": "TEXT", "comment": "客户状态 正常/冻结/销户"},
        ],
    },
    "accounts": {
        "comment": "账户（活期/定期/对公结算，余额、利率、状态）",
        "columns": [
            {"name": "account_id", "type": "INTEGER", "comment": "账户ID 主键", "pk": True},
            {"name": "account_no", "type": "TEXT", "comment": "账号"},
            {"name": "customer_id", "type": "INTEGER", "comment": "所属客户ID"},
            {"name": "account_type", "type": "TEXT", "comment": "账户类型 活期/定期/对公结算"},
            {"name": "currency", "type": "TEXT", "comment": "币种 CNY/USD/HKD/EUR"},
            {"name": "balance", "type": "REAL", "comment": "账户余额（元）"},
            {"name": "annual_rate", "type": "REAL", "comment": "年利率（%）"},
            {"name": "open_date", "type": "TEXT", "comment": "开户日期"},
            {"name": "status", "type": "TEXT", "comment": "账户状态 正常/冻结/销户"},
            {"name": "branch_id", "type": "INTEGER", "comment": "所属机构ID"},
        ],
    },
    "transactions": {
        "comment": "交易流水（含交易时间、记账日期、借贷方向、交易后余额）",
        "columns": [
            {"name": "txn_id", "type": "INTEGER", "comment": "流水ID 主键", "pk": True},
            {"name": "account_id", "type": "INTEGER", "comment": "账户ID"},
            {"name": "txn_time", "type": "TEXT", "comment": "交易时间（含时分秒）"},
            {"name": "value_date", "type": "TEXT", "comment": "value_date 记账日期（可能因节假日顺延晚于交易日）"},
            {"name": "direction", "type": "TEXT", "comment": "借贷方向 D借方(出账)/C贷方(入账)"},
            {"name": "amount", "type": "REAL", "comment": "交易金额（元）"},
            {"name": "balance_after", "type": "REAL", "comment": "balance_after 交易后余额"},
            {"name": "txn_type", "type": "TEXT", "comment": "交易类型 转账/消费/取现/工资代发/缴费/理财申购"},
            {"name": "channel", "type": "TEXT", "comment": "交易渠道 柜面/网银/手机银行/ATM/POS/第三方"},
            {"name": "counterparty_name", "type": "TEXT", "comment": "counterparty_name 对手方名称"},
            {"name": "status", "type": "TEXT", "comment": "交易状态 成功/失败/冲正"},
        ],
    },
    "loans": {
        "comment": "贷款（房贷/经营贷/消费贷/信用贷，合同本金与贷款余额）",
        "columns": [
            {"name": "loan_id", "type": "INTEGER", "comment": "贷款ID 主键", "pk": True},
            {"name": "loan_no", "type": "TEXT", "comment": "贷款合同号"},
            {"name": "customer_id", "type": "INTEGER", "comment": "借款人客户ID"},
            {"name": "loan_type", "type": "TEXT", "comment": "贷款品种 房贷/经营贷/消费贷/信用贷"},
            {"name": "principal", "type": "REAL", "comment": "合同本金（元）"},
            {"name": "outstanding", "type": "REAL", "comment": "贷款余额（未偿本金，结清应为 0）"},
            {"name": "annual_rate", "type": "REAL", "comment": "年利率（%）"},
            {"name": "disbursement_date", "type": "TEXT", "comment": "放款日期"},
            {"name": "maturity_date", "type": "TEXT", "comment": "到期日期"},
            {"name": "term_months", "type": "INTEGER", "comment": "贷款期限（月）"},
            {"name": "repay_method", "type": "TEXT", "comment": "还款方式 等额本息/等额本金/先息后本"},
            {"name": "status", "type": "TEXT", "comment": "贷款状态 正常/逾期/结清/核销"},
            {"name": "branch_id", "type": "INTEGER", "comment": "经办机构ID"},
            {"name": "manager_id", "type": "INTEGER", "comment": "客户经理员工ID"},
        ],
    },
    "loan_repayments": {
        "comment": "贷款还款计划与实还（按期次的应还/实还明细）",
        "columns": [
            {"name": "repay_id", "type": "INTEGER", "comment": "还款记录ID 主键", "pk": True},
            {"name": "loan_id", "type": "INTEGER", "comment": "贷款ID"},
            {"name": "period_no", "type": "INTEGER", "comment": "期次（第几期）"},
            {"name": "due_date", "type": "TEXT", "comment": "应还日期"},
            {"name": "due_principal", "type": "REAL", "comment": "应还本金（元）"},
            {"name": "due_interest", "type": "REAL", "comment": "应还利息（元）"},
            {"name": "due_total", "type": "REAL", "comment": "应还合计（本金+利息）"},
            {"name": "paid_date", "type": "TEXT", "comment": "实还日期（未还为 NULL）"},
            {"name": "paid_amount", "type": "REAL", "comment": "实还金额（元）"},
            {"name": "status", "type": "TEXT", "comment": "状态 已还/部分还款/逾期/未到期"},
        ],
    },
    "overdue_records": {
        "comment": "逾期与五级分类（统计日快照，dpd 逾期天数）",
        "columns": [
            {"name": "overdue_id", "type": "INTEGER", "comment": "记录ID 主键", "pk": True},
            {"name": "loan_id", "type": "INTEGER", "comment": "贷款ID"},
            {"name": "stat_date", "type": "TEXT", "comment": "统计日期（月末快照）"},
            {"name": "dpd", "type": "INTEGER", "comment": "dpd 逾期天数 Days Past Due"},
            {"name": "overdue_amount", "type": "REAL", "comment": "逾期金额（元）"},
            {"name": "classification", "type": "TEXT", "comment": "五级分类 正常/关注/次级/可疑/损失"},
            {"name": "is_manual_adjusted", "type": "INTEGER", "comment": "是否人工调整过分类 1是/0否"},
        ],
    },
    "credit_cards": {
        "comment": "信用卡（授信额度、已用额度、账单日与到期还款日）",
        "columns": [
            {"name": "card_id", "type": "INTEGER", "comment": "信用卡ID 主键", "pk": True},
            {"name": "card_no", "type": "TEXT", "comment": "卡号（脱敏）"},
            {"name": "customer_id", "type": "INTEGER", "comment": "持卡客户ID"},
            {"name": "credit_limit", "type": "REAL", "comment": "授信额度（元）"},
            {"name": "used_limit", "type": "REAL", "comment": "已用额度（元）"},
            {"name": "bill_day", "type": "INTEGER", "comment": "账单日（每月几号）"},
            {"name": "due_day", "type": "INTEGER", "comment": "到期还款日（每月几号）"},
            {"name": "status", "type": "TEXT", "comment": "卡状态 正常/冻结/销户"},
            {"name": "open_date", "type": "TEXT", "comment": "发卡日期"},
        ],
    },
    "card_statements": {
        "comment": "信用卡账单（按账期 YYYYMM 的账单金额与最低还款额）",
        "columns": [
            {"name": "statement_id", "type": "INTEGER", "comment": "账单ID 主键", "pk": True},
            {"name": "card_id", "type": "INTEGER", "comment": "信用卡ID"},
            {"name": "period", "type": "TEXT", "comment": "账期（YYYYMM，如 202603）"},
            {"name": "statement_amount", "type": "REAL", "comment": "账单金额（本期应还）"},
            {"name": "min_payment", "type": "REAL", "comment": "最低还款额"},
            {"name": "repaid_amount", "type": "REAL", "comment": "已还金额（大于账单金额即为溢缴款）"},
            {"name": "status", "type": "TEXT", "comment": "账单状态 已结清/部分还款/未还款/逾期"},
        ],
    },
    "card_repayments": {
        "comment": "信用卡还款明细（一笔账单可对应多条部分还款记录）",
        "columns": [
            {"name": "repay_id", "type": "INTEGER", "comment": "还款ID 主键", "pk": True},
            {"name": "card_id", "type": "INTEGER", "comment": "信用卡ID"},
            {"name": "statement_id", "type": "INTEGER", "comment": "所属账单ID"},
            {"name": "repay_date", "type": "TEXT", "comment": "还款日期"},
            {"name": "repay_amount", "type": "REAL", "comment": "还款金额（元）"},
            {"name": "channel", "type": "TEXT", "comment": "还款渠道 柜面/手机银行/第三方/自动扣款"},
        ],
    },
    "deposits_daily": {
        "comment": "存款日终快照（账户维度的每日日终余额）",
        "columns": [
            {"name": "account_id", "type": "INTEGER", "comment": "账户ID"},
            {"name": "data_date", "type": "TEXT", "comment": "数据日期（日终）"},
            {"name": "eod_balance", "type": "REAL", "comment": "日终余额（元）"},
        ],
    },
    "wealth_products": {
        "comment": "理财产品（风险等级、期限、预期年化收益率）",
        "columns": [
            {"name": "product_id", "type": "INTEGER", "comment": "产品ID 主键", "pk": True},
            {"name": "product_name", "type": "TEXT", "comment": "产品名称"},
            {"name": "risk_level", "type": "TEXT", "comment": "风险等级 低/中低/中/中高/高"},
            {"name": "term_days", "type": "INTEGER", "comment": "产品期限（天）"},
            {"name": "expected_annual_return", "type": "REAL", "comment": "预期年化收益率（%）"},
            {"name": "min_amount", "type": "REAL", "comment": "起购金额（元）"},
            {"name": "status", "type": "TEXT", "comment": "产品状态 在售/停售"},
        ],
    },
    "wealth_holdings": {
        "comment": "理财持仓（赎回日期为 NULL 表示持有中）",
        "columns": [
            {"name": "holding_id", "type": "INTEGER", "comment": "持仓ID 主键", "pk": True},
            {"name": "customer_id", "type": "INTEGER", "comment": "客户ID"},
            {"name": "product_id", "type": "INTEGER", "comment": "理财产品ID"},
            {"name": "amount", "type": "REAL", "comment": "持仓金额（元）"},
            {"name": "buy_date", "type": "TEXT", "comment": "买入日期"},
            {"name": "redeem_date", "type": "TEXT", "comment": "赎回日期（NULL=持有中）"},
        ],
    },
    "aml_alerts": {
        "comment": "反洗钱可疑交易预警（规则命中）",
        "columns": [
            {"name": "alert_id", "type": "INTEGER", "comment": "预警ID 主键", "pk": True},
            {"name": "customer_id", "type": "INTEGER", "comment": "客户ID"},
            {"name": "rule_code", "type": "TEXT", "comment": "规则码 R01短时多笔等额取现/R02大额现金/R03分散转入集中转出/R04夜间异常"},
            {"name": "hit_date", "type": "TEXT", "comment": "规则命中日期"},
            {"name": "amount", "type": "REAL", "comment": "涉及金额（元）"},
            {"name": "status", "type": "TEXT", "comment": "处理状态 待处理/已排除/已上报"},
        ],
    },
}


# ════════════════════════════ 工具函数 ════════════════════════════
def _d(rnd, start: date, end: date) -> str:
    """区间内随机日期（ISO 字符串）"""
    return (start + timedelta(days=rnd.randint(0, (end - start).days))).isoformat()


def add_months(d: date, n: int) -> date:
    """日期加 n 个月（按自然月对齐，日溢出则取月末）"""
    y, m = d.year, d.month + n
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    day = min(d.day, [31, 29 if y % 4 == 0 and (y % 100 != 0 or y % 400 == 0) else 28,
                      31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1])
    return date(y, m, day)


def pick_weighted(rnd, items, weights):
    return rnd.choices(items, weights=weights, k=1)[0]


def person_name(rnd):
    return rnd.choice(SURNAME) + rnd.choice(GIVEN)


def company_name(rnd):
    return rnd.choice(BRAND) + rnd.choice(SUFFIX)


def mask_no(s: str, keep_head=4, keep_tail=4) -> str:
    """证件号/卡号脱敏"""
    if len(s) <= keep_head + keep_tail:
        return s
    return s[:keep_head] + "*" * (len(s) - keep_head - keep_tail) + s[-keep_tail:]


def create_tables(cur):
    """按 SCHEMA 生成 DDL，保证 schema.json 与真实库结构永远一致"""
    for tname, meta in SCHEMA.items():
        cols = []
        for c in meta["columns"]:
            s = f"{c['name']} {c['type']}"
            if c.get("pk"):
                s += " PRIMARY KEY"
            if c.get("notnull"):
                s += " NOT NULL"
            cols.append(s)
        cur.execute(f"CREATE TABLE {tname}(\n  " + ",\n  ".join(cols) + "\n)")


def dump_schema(out_path: str, rowcounts: dict):
    """输出 schema.json —— 与 scripts/dump_schema.py 同构，浏览器端（数据字典页/自动补全）
    可直接按 tables.<表名> 取字段列表，无需为 bank 场景另写加载逻辑。"""
    doc = {
        "scene": "bank",
        "generated_from": "bank.sqlite",
        "table_count": len(SCHEMA),
        "tables": {t: [{"name": c["name"], "type": c["type"].lower(),
                        "pk": bool(c.get("pk")), "notnull": bool(c.get("notnull")),
                        "comment": c["comment"]} for c in meta["columns"]]
                   for t, meta in SCHEMA.items()},
        "table_comments": {t: meta["comment"] for t, meta in SCHEMA.items()},
        "row_counts": rowcounts,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)


# ════════════════════════════ 主体生成 ════════════════════════════
def build(rnd: random.Random, db_path: str, scale: float = 1.0):
    if os.path.exists(db_path):
        os.remove(db_path)
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    create_tables(cur)

    target_txn = int(P["transactions"] * scale)
    n_dep_acct = max(50, int(P["deposit_accounts"] * scale))
    n_dep_days = max(3, int(round(P["deposit_days"] * scale)))
    n_stmt_per_card = max(1, int(round(P["statements_per_card"] * scale)))

    # ── branches：三级层级 总行→分行→支行（含脏数据 13：层级深度不一致） ──
    br_rows = [(1, "全国总行", 1, None, "北京", "总行", "1996-01-01", "正常")]
    city_pairs = {}
    bid = 2
    for c in CITIES:
        br_rows.append((bid, f"{c}分行", 2, 1, c, "分行", _d(rnd, date(2000, 1, 1), date(2015, 12, 31)), "正常"))
        city_pairs[c] = bid
        bid += 1
    # 每个分行下挂若干支行；12% 的支行直接挂到总行（层级深度不一致，现场台账常见）
    n_sub = P["branches"] - 1 - len(CITIES)
    branch_cities = {c: [] for c in CITIES}
    # 脏数据 13：按设计比例精确抽取「层级深度不一致」的支行
    bad_level_idx = set(rnd.sample(range(n_sub),
                                   int(round(DIRTY["branch_level_inconsistent_rate"] * n_sub))))
    for i in range(n_sub):
        c = rnd.choice(CITIES)
        parent = 1 if i in bad_level_idx else city_pairs[c]   # 脏数据：支行直接挂总行
        br_rows.append((bid, f"{c}{'城东' if i % 3 == 0 else '城西' if i % 3 == 1 else '开发区'}"
                             f"第{i + 1}支行", 3, parent, c, "支行",
                        _d(rnd, date(2005, 1, 1), date(2024, 12, 31)), "正常"))
        branch_cities[c].append(bid)
        bid += 1
    cur.executemany("INSERT INTO branches VALUES(?,?,?,?,?,?,?,?)", br_rows)
    all_branches = [b[0] for b in br_rows]
    sub_branches = [b[0] for b in br_rows if b[2] == 3]
    br_city = {b[0]: b[4] for b in br_rows}

    # ── employees ──
    emp_rows = []
    for i in range(1, P["employees"] + 1):
        pos = rnd.choice(POSITIONS)
        emp_rows.append((i, f"E{i:06d}", person_name(rnd), rnd.choice(all_branches), pos,
                         1 if pos in MANAGER_POS else 0,
                         _d(rnd, date(2005, 1, 1), date(2026, 3, 31)),
                         rnd.choices(["在职", "离职"], [94, 6])[0]))
    cur.executemany("INSERT INTO employees VALUES(?,?,?,?,?,?,?,?)", emp_rows)
    manager_ids = [e[0] for e in emp_rows if e[5] == 1]

    # ── customers ──
    cust_rows = []
    closed_cust = []
    for i in range(1, P["customers"] + 1):
        ct = pick_weighted(rnd, CUST_TYPES, CUST_TYPE_W)
        if ct == "个人":
            name, id_type = person_name(rnd), pick_weighted(rnd, ID_TYPES_P, [90, 6, 4])
        else:
            name, id_type = company_name(rnd), pick_weighted(rnd, ID_TYPES_C, [70, 30])
        open_br = rnd.choice(sub_branches)
        status = pick_weighted(rnd, ["正常", "冻结", "销户"], [88, 7, 5])
        if status == "销户":
            closed_cust.append(i)
        # AUM：对公远大于个人，个人近似对数正态
        if ct == "对公":
            aum = round(rnd.lognormvariate(13.5, 1.1), 2)
        else:
            aum = round(rnd.lognormvariate(11.0, 1.3), 2)
        cust_rows.append((i, f"C{rnd.randint(10 ** 7, 10 ** 8 - 1)}", name, ct, id_type,
                          mask_no(str(rnd.randint(10 ** 16, 10 ** 17 - 1))), 
                          pick_weighted(rnd, RISK_LEVELS, [70, 22, 8]), open_br,
                          _d(rnd, date(2012, 1, 1), date(2026, 3, 31)), aum,
                          rnd.choice(INDUSTRY) if ct == "对公" else None,
                          status))
    cur.executemany("INSERT INTO customers VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", cust_rows)

    # ── accounts（先只算基准余额，交易生成后再回填最终余额） ──
    acct_rows = []
    acct_base = {}
    for i in range(1, P["accounts"] + 1):
        cust = rnd.choice(cust_rows)
        atype = pick_weighted(rnd, ACCT_TYPES, ACCT_TYPE_W)
        if atype == "对公结算":
            base_bal = round(rnd.uniform(5e4, 5e6), 2)
        elif atype == "定期":
            base_bal = round(rnd.uniform(1e4, 8e5), 2)
        else:
            base_bal = round(rnd.uniform(1e3, 2e5), 2)
        rate = {"活期": 0.20, "定期": round(rnd.uniform(1.35, 2.75), 2),
                "对公结算": 0.20}[atype]
        status = pick_weighted(rnd, ["正常", "冻结", "销户"], [91, 5, 4])
        acct_base[i] = base_bal
        acct_rows.append((i, f"{rnd.randint(60, 69)}{rnd.randint(10 ** 12, 10 ** 13 - 1)}",
                          cust[0], atype, rnd.choice(CURRENCIES), base_bal, rate,
                          _d(rnd, date(2013, 1, 1), date(2026, 4, 30)), status,
                          rnd.choice(sub_branches)))
    closed_accts = [a[0] for a in acct_rows if a[8] == "销户"]

    # ── transactions（脏数据 1/2/3/4/9/11/12 的主战场） ──
    # 脏数据 4：销户账户仍有交易记录（按设计比例精确抽取销户账户）
    dirty_closed = set(rnd.sample(closed_accts,
                                  int(round(DIRTY["closed_account_txn_rate"] * len(closed_accts)))))

    # 1) 先按活跃度权重给每个账户分配笔数
    weights = []
    for a in acct_rows:
        if a[8] == "销户":
            w = rnd.uniform(0.3, 0.9) if a[0] in dirty_closed else 0.0
        else:
            w = pick_weighted(rnd, [0.0, 1.0, 2.2, 4.0], [15, 45, 28, 12]) * rnd.uniform(0.6, 1.4)
        weights.append(w)
    tot_w = sum(weights) or 1.0
    events = {}          # account_id -> [ {ts, ...} ]
    span_days = (DATA_END - DATA_START).days
    for a, w in zip(acct_rows, weights):
        k = int(round(target_txn * w / tot_w))
        if k <= 0:
            continue
        ev = []
        for _ in range(k):
            ts = datetime(DATA_START.year, DATA_START.month, DATA_START.day) + timedelta(
                days=rnd.randint(0, span_days), hours=rnd.randint(7, 21),
                minutes=rnd.randint(0, 59), seconds=rnd.randint(0, 59))
            ev.append({"ts": ts, "cluster": False})
        ev.sort(key=lambda x: x["ts"])
        events[a[0]] = ev

    # 2) 脏数据 9：同一账户 10 分钟内多笔等额取现（并会生成 aml_alerts）
    n_ev0 = sum(len(v) for v in events.values())
    n_clusters = int(round(DIRTY["suspicious_withdraw_rate"] * n_ev0
                           / (3.0 * (1 - DIRTY["suspicious_withdraw_rate"]))))
    # 优先在活跃账户中挑选（自动削减规模时也能抽出足够样本）
    cand = sorted([aid for aid, v in events.items() if len(v) >= 3],
                  key=lambda x: (-len(events[x]), x))[:max(200, n_clusters * 4)]
    cluster_accts = rnd.sample(cand, min(n_clusters, len(cand)))
    cluster_log = []
    for aid in cluster_accts:
        v = events[aid]
        pos = rnd.randint(1, len(v) - 1)
        amount = float(rnd.choice([2000, 5000, 10000, 10000, 20000, 30000]))
        t0 = v[pos]["ts"]
        for j in range(3):
            v.append({"ts": t0 + timedelta(seconds=j * rnd.randint(20, 180)),
                      "cluster": True, "amount": amount})
        v.sort(key=lambda x: x["ts"])
        cluster_log.append((aid, t0, amount))
    # 重新排序后打平为全局序列，txn_id = 序号
    flat = []
    first_pos = set()
    for a in acct_rows:
        v = events.get(a[0])
        if not v:
            continue
        first_pos.add(len(flat))
        flat.extend((a[0], e) for e in v)
    total_txn = len(flat)

    # 精确抽样：先按设计比例抽出要写脏的行号，实测比例才能与设计值严格对齐
    non_cluster = [p for p in range(total_txn) if not flat[p][1]["cluster"]]
    # 脏数据 2：balance_after 不一致。跳过每个账户首笔——首笔没有前序余额可校验，
    #           属于无法识别的异常；因此这 4% 从「非首笔」中抽，但比例仍按全部流水计。
    eligible = [p for p in range(total_txn) if p not in first_pos]
    n_dev = int(round(DIRTY["balance_mismatch_rate"] * total_txn))
    dev_pos = set(rnd.sample(eligible, min(n_dev, len(eligible))))
    fail_pos = set(rnd.sample(range(total_txn),
                              int(round(DIRTY["reversed_failed_rate"] * total_txn))))       # 脏数据 1
    vdate_pos = set(rnd.sample(range(total_txn),
                               int(round(DIRTY["value_date_cross_day_rate"] * total_txn))))  # 脏数据 3
    neg_pos = set(rnd.sample(non_cluster,
                             int(round(DIRTY["negative_amount_rate"] * total_txn))))        # 脏数据 11
    nullcp_pos = set(rnd.sample(range(total_txn),
                                int(round(DIRTY["null_counterparty_rate"] * total_txn))))    # 脏数据 12

    # 3) 走一遍流水，滚动计算真实余额，再按需注入脏数据
    txn_rows = []
    final_bal = {}
    for pos, (aid, ev) in enumerate(flat):
        if pos in first_pos:
            cur_bal = round(acct_base[aid] * rnd.uniform(0.5, 1.5), 2)
        amt = ev.get("amount") if ev.get("amount") is not None else 0.0
        special = ev["cluster"]
        if not special:
            # 按类型生成金额 + 交易要素
            ttype = pick_weighted(rnd, TXN_TYPES, [22, 30, 12, 8, 18, 10])
            channel = {"转账": pick_weighted(rnd, ["网银", "手机银行", "柜面", "第三方"], [40, 35, 15, 10]),
                       "消费": pick_weighted(rnd, ["POS", "第三方", "手机银行"], [55, 30, 15]),
                       "取现": pick_weighted(rnd, ["ATM", "柜面"], [75, 25]),
                       "工资代发": "柜面", "缴费": "手机银行",
                       "理财申购": pick_weighted(rnd, ["手机银行", "网银", "柜面"], [50, 40, 10])}[ttype]
            direction = "D" if ttype in ("消费", "取现", "缴费", "理财申购") else \
                pick_weighted(rnd, ["D", "C"], [55, 45])
            if ttype == "工资代发":
                amt = round(rnd.uniform(4000, 45000), 2)
            elif ttype == "消费":
                amt = round(rnd.uniform(15, 6800), 2)
            elif ttype == "取现":
                amt = float(rnd.choice([100, 300, 500, 1000, 2000, 3000, 5000, 10000]))
            elif ttype == "缴费":
                amt = round(rnd.uniform(30, 3200), 2)
            elif ttype == "理财申购":
                amt = round(rnd.uniform(1e4, 3e6), 2)
            else:
                amt = round(rnd.uniform(100, 300000), 2)
            ev.update(dict(ttype=ttype, channel=channel, direction=direction, amount=amt))
        else:
            # 可疑取现簇：3 笔等额 ATM 取现
            ev.update(dict(ttype="取现", channel="ATM", direction="D", amount=amt))
        # 脏数据 11：金额为负的异常记录 0.3%
        if pos in neg_pos:
            ev["amount"] = -abs(ev["amount"])
        # 余额约束：出账金额超过可用余额时，85% 按余额缩减（避免大批账户长期大额透支），
        # 其余 15% 允许小额透支——真实零售账户也存在偶发透支。
        elif not ev["cluster"] and ev["direction"] == "D" and ev["amount"] > 0 \
                and ev["amount"] > cur_bal and rnd.random() < 0.85:
            ev["amount"] = round(max(1.0, cur_bal * rnd.uniform(0.05, 0.85)), 2)
        amt = ev["amount"]
        # 滚动真实余额（不在过程里取整，保证 SQL 端能逐笔精确复核）
        if ev["direction"] == "C":
            cur_bal = cur_bal + amt
        else:
            cur_bal = cur_bal - amt
        balance_after = round(cur_bal, 2)
        # 脏数据 2：故意让 4% 的记录 balance_after 偏离真实值 10%~30%
        if pos in dev_pos:
            sign = rnd.choice([1, -1])
            delta = max(abs(cur_bal) * rnd.uniform(0.10, 0.30), 0.50)
            balance_after = round(cur_bal + sign * delta, 2)
        # 脏数据 3：记账日 = 交易日 + 1~3 天（节假日顺延）
        tf_date = ev["ts"].date()
        vd = tf_date + timedelta(days=rnd.randint(1, 3)) if pos in vdate_pos else tf_date
        # 脏数据 1：冲正/失败 2.5%
        status = ("冲正" if rnd.random() < 0.72 else "失败") if pos in fail_pos else "成功"
        # 脏数据 12：对手方名称为空 20%
        if pos in nullcp_pos:
            cp = None
        elif ev["ttype"] == "消费":
            cp = rnd.choice(MALLS)
        elif ev["ttype"] == "工资代发":
            cp = company_name(rnd) + "代发工资"
        elif ev["ttype"] == "缴费":
            cp = f"{br_city[rnd.choice(sub_branches)]}{rnd.choice(UTILS)}"
        elif ev["ttype"] == "取现":
            cp = "现金支取"
        elif ev["ttype"] == "理财申购":
            cp = "理财资金归集专户"
        else:
            cp = company_name(rnd) if rnd.random() < 0.55 else person_name(rnd)
        txn_rows.append((pos + 1, aid, ev["ts"].strftime("%Y-%m-%d %H:%M:%S"), vd.isoformat(),
                         ev["direction"], round(amt, 2), balance_after, ev["ttype"],
                         ev["channel"], cp, status))
        final_bal[aid] = round(cur_bal, 2)
    # 回填账户余额（无流水账户保留基准余额）
    acct_rows = [a[:5] + (final_bal.get(a[0], acct_base[a[0]]),) + a[6:] for a in acct_rows]
    cur.executemany("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?,?)", acct_rows)
    cur.executemany("INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?,?)", txn_rows)

    # ── loans（脏数据 5） ──
    loan_rows = []
    closed_loan_idx = []
    for i in range(1, P["loans"] + 1):
        cust = rnd.choice(cust_rows)
        ltype = pick_weighted(rnd, LOAN_TYPES, LOAN_TYPE_W)
        principal = round({"房贷": rnd.uniform(3e5, 5e6), "经营贷": rnd.uniform(1e5, 3e6),
                           "消费贷": rnd.uniform(1e4, 5e5), "信用贷": rnd.uniform(5e3, 3e5)}[ltype], 2)
        annual_rate = round({"房贷": rnd.uniform(3.1, 5.2), "经营贷": rnd.uniform(3.5, 8.0),
                             "消费贷": rnd.uniform(4.0, 15.0), "信用贷": rnd.uniform(4.0, 18.0)}[ltype], 2)
        term = {"房贷": rnd.randint(120, 360), "经营贷": rnd.randint(12, 60),
                "消费贷": rnd.randint(6, 60), "信用贷": rnd.randint(6, 36)}[ltype]
        disb = date(2020, 1, 1) + timedelta(days=rnd.randint(0, (date(2026, 6, 30) - date(2020, 1, 1)).days))
        mat = add_months(disb, term)
        method = pick_weighted(rnd, REPAY_METHODS, [70, 20, 10])
        status = pick_weighted(rnd, ["正常", "逾期", "结清", "核销"], [78, 10, 10, 2])
        elapsed = max(0, min(term, (date(2026, 6, 30).year - disb.year) * 12 + date(2026, 6, 30).month - disb.month))
        if status == "结清":
            out = 0.0
            closed_loan_idx.append(i)
        elif status == "核销":
            out = round(principal * rnd.uniform(0.30, 0.80), 2)
        else:
            out = round(min(principal, principal * (1 - elapsed / term) * rnd.uniform(0.92, 1.08)), 2)
        loan_rows.append((i, f"LN{disb.year}{rnd.randint(10 ** 6, 10 ** 7 - 1)}", cust[0], ltype,
                          principal, out, annual_rate, disb.isoformat(), mat.isoformat(), term,
                          method, status, rnd.choice(sub_branches), rnd.choice(manager_ids),
                          elapsed))
    # 脏数据 5：1.5% 的已结清贷款余额不为 0
    for i in rnd.sample(closed_loan_idx,
                        int(round(DIRTY["closed_loan_outstanding_rate"] * len(closed_loan_idx)))):
        r = loan_rows[i - 1]
        loan_rows[i - 1] = r[:5] + (round(r[4] * rnd.uniform(0.05, 0.35), 2),) + r[6:]
    elapsed_map = {r[0]: r[14] for r in loan_rows}
    cur.executemany("INSERT INTO loans VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [r[:14] for r in loan_rows])

    # ── loan_repayments（生成最近 N 期还款计划与实还） ──
    repay_rows = []
    rid = 0
    for r in loan_rows:
        loan_id, principal, annual_rate, disb, term, method, status = r[0], r[4], r[6], \
            date.fromisoformat(r[7]), r[9], r[10], r[11]
        if status == "核销" and rnd.random() < 0.5:
            continue                       # 部分核销贷款无计划
        mr = annual_rate / 100.0 / 12.0
        elapsed = elapsed_map[loan_id]
        start = max(1, elapsed - P["max_installments"] + 1)
        stop = min(term, elapsed + 1)
        bal = principal
        for k in range(1, stop + 1):
            if method == "等额本息":
                pay = principal * mr / (1 - (1 + mr) ** (-term)) if mr > 0 else principal / term
                interest = bal * mr
                prin = pay - interest
            elif method == "等额本金":
                prin = principal / term
                interest = bal * mr
            else:                          # 先息后本
                prin = principal if k == term else 0.0
                interest = bal * mr
            due_date = add_months(disb, k)
            bal = max(0.0, bal - prin)
            if k < start:
                continue
            due_principal = round(prin, 2)
            due_interest = round(interest, 2)
            due_total = round(due_principal + due_interest, 2)
            rid += 1
            if due_date <= DATA_END:
                r2 = rnd.random()
                if status == "逾期" and rnd.random() < 0.6:
                    st, pd, pa = "逾期", None, 0.0
                elif r2 < 0.90:
                    st = "已还"
                    pd = (due_date + timedelta(days=rnd.randint(-4, 5))).isoformat()
                    pa = due_total
                elif r2 < 0.96:
                    st = "部分还款"
                    pd = (due_date + timedelta(days=rnd.randint(0, 8))).isoformat()
                    pa = round(due_total * rnd.uniform(0.2, 0.8), 2)
                else:
                    st, pd, pa = "逾期", None, 0.0
            else:
                st, pd, pa = "未到期", None, 0.0
            repay_rows.append((rid, loan_id, k, due_date.isoformat(), due_principal,
                               due_interest, due_total, pd, pa, st))
    cur.executemany("INSERT INTO loan_repayments VALUES(?,?,?,?,?,?,?,?,?,?)", repay_rows)

    # ── overdue_records（脏数据 6：五级分类与 DPD 不匹配） ──
    def cls_of(dpd: int) -> str:
        if dpd <= 0:
            return "正常"
        if dpd <= 30:
            return "关注"
        if dpd <= 90:
            return "次级"
        if dpd <= 180:
            return "可疑"
        return "损失"

    ov_rows = []
    oid = 0
    for r in loan_rows:
        n = pick_weighted(rnd, [0, 1, 2, 3, 4], [20, 30, 25, 15, 10])
        if n == 0:
            continue
        base_dpd = 0
        if r[11] == "逾期":
            base_dpd = rnd.choice([45, 75, 95, 120, 150, 200, 260])
        elif r[11] == "核销":
            base_dpd = rnd.choice([280, 360, 420])
        elif rnd.random() < 0.5:
            base_dpd = rnd.randint(1, 30)
        else:
            continue
        for j in range(n):
            oid += 1
            stat = SNAPSHOT_DATES[j % len(SNAPSHOT_DATES)]
            # 越早的统计日 DPD 越小（逾期天数随时间增长）
            dpd = max(0, base_dpd - 30 * (n - 1 - j))
            cls = cls_of(dpd)
            manual = 0
            ov_rows.append((oid, r[0], stat.isoformat(), dpd,
                            round(r[5] * rnd.uniform(0.02, 0.30) + 1, 2), cls, manual))
    # 脏数据 6：6% 的记录分类与 DPD 不匹配，且被人工调整过（按设计比例精确抽样）
    for idx in rnd.sample(range(len(ov_rows)),
                          int(round(DIRTY["classification_mismatch_rate"] * len(ov_rows)))):
        r = ov_rows[idx]
        alt = [c for c in CLASSIFICATIONS if c != cls_of(r[3])]
        ov_rows[idx] = r[:5] + (rnd.choice(alt), 1)
    cur.executemany("INSERT INTO overdue_records VALUES(?,?,?,?,?,?,?)", ov_rows)

    # ── credit_cards / card_statements / card_repayments（脏数据 7/8） ──
    card_rows = []
    for i in range(1, P["credit_cards"] + 1):
        cust = rnd.choice(cust_rows)
        limit = float(rnd.choice([5000, 10000, 20000, 30000, 50000, 80000, 100000, 200000]))
        used = round(limit * rnd.uniform(0.0, 0.92), 2)
        bill_day = rnd.randint(1, 28)
        due_day = bill_day + 20 if bill_day + 20 <= 28 else bill_day + 20 - 28
        card_rows.append((i, mask_no(f"62{rnd.randint(10 ** 14, 10 ** 15 - 1)}"), cust[0], limit, used,
                          bill_day, due_day,
                          pick_weighted(rnd, CARD_STATUS, [90, 6, 4]),
                          _d(rnd, date(2016, 1, 1), date(2025, 12, 31))))
    cur.executemany("INSERT INTO credit_cards VALUES(?,?,?,?,?,?,?,?,?)", card_rows)

    stmt_rows, cr_rows = [], []
    # 脏数据 7/8：按设计比例精确抽取「溢缴款」账单与「多次部分还款」账单
    total_stmt = P["credit_cards"] * n_stmt_per_card
    over_idx = set(rnd.sample(range(total_stmt),
                              int(round(DIRTY["card_overpayment_rate"] * total_stmt))))
    multi_idx = set(rnd.sample(range(total_stmt),
                               int(round(DIRTY["multi_partial_repay_rate"] * total_stmt))))
    sid = crid = 0
    for c in card_rows:
        for k in range(n_stmt_per_card):
            period_d = add_months(date(2026, 6, 1), -k)
            period = f"{period_d.year:04d}{period_d.month:02d}"
            amount = round(c[3] * rnd.uniform(0.05, 0.85), 2)
            if amount <= 0:
                amount = round(rnd.uniform(200, 5000), 2)
            min_pay = round(amount * 0.10, 2)
            sid += 1
            idx = sid - 1
            if idx in over_idx:                                         # 脏数据 7：溢缴款
                repaid = round(amount * rnd.uniform(1.02, 1.40), 2)     # 已还 > 账单
            else:
                r3 = rnd.random()
                if r3 < 0.62:
                    repaid = amount
                elif r3 < 0.85:
                    repaid = round(amount * rnd.uniform(0.15, 0.9), 2)
                else:
                    repaid = 0.0
            # 脏数据 8：15% 的账单拆成 2~3 条部分还款记录
            if idx in multi_idx:
                if repaid <= 0:
                    repaid = round(amount * rnd.uniform(0.15, 0.90), 2)
                n_rep = rnd.randint(2, 3)
            else:
                n_rep = 1 if repaid > 0 else 0
            if repaid >= amount and amount > 0:
                st = "已结清"
            elif repaid <= 0:
                # 账期已过且分文未还 → 逾期
                st = "逾期" if period < "202606" else "未还款"
            else:
                st = "部分还款"
            stmt_rows.append((sid, c[0], period, amount, min_pay, round(repaid, 2), st))
            # 还款明细：一笔账单可对应 1~3 条记录（15% 的账单 2~3 条部分还款）
            if n_rep > 0 and repaid > 0:
                if n_rep == 1:
                    parts = [round(repaid, 2)]
                else:
                    # 前 n-1 笔按比例拆分，最后一笔补齐，保证合计 = repaid
                    cuts = sorted(rnd.uniform(0.2, 0.8) for _ in range(n_rep - 1))
                    prev, parts = 0.0, []
                    for cut in cuts:
                        parts.append(round(repaid * (cut - prev), 2))
                        prev = cut
                    parts.append(round(repaid - sum(parts), 2))
                base_day = date(int(period[:4]), int(period[4:]), c[5])
                for pj, amt in enumerate(parts):
                    crid += 1
                    cr_rows.append((crid, c[0], sid,
                                    (base_day + timedelta(days=rnd.randint(1, 24))).isoformat(),
                                    amt, rnd.choice(["柜面", "手机银行", "第三方", "自动扣款"])))
    cur.executemany("INSERT INTO card_statements VALUES(?,?,?,?,?,?,?)", stmt_rows)
    cur.executemany("INSERT INTO card_repayments VALUES(?,?,?,?,?,?)", cr_rows)

    # ── deposits_daily（日终快照） ──
    dep_rows = []
    dep_cands = [a for a in acct_rows if a[8] != "销户"]
    for a in rnd.sample(dep_cands, min(n_dep_acct, len(dep_cands))):
        lvl = a[5]
        for d in range(n_dep_days):
            day = DATA_END - timedelta(days=d)
            bal = round(max(0.0, lvl * rnd.uniform(0.75, 1.25)), 2)
            dep_rows.append((a[0], day.isoformat(), bal))
    cur.executemany("INSERT INTO deposits_daily VALUES(?,?,?)", dep_rows)

    # ── wealth_products / wealth_holdings（脏数据 10） ──
    wp_rows = []
    for i in range(1, P["wealth_products"] + 1):
        risk = pick_weighted(rnd, ["低", "中低", "中", "中高", "高"], [22, 27, 25, 16, 10])
        wp_rows.append((i, f"{rnd.choice(BRAND)}·{rnd.choice(['稳利', '增利', '天天盈', '鑫享', '季季盈'])}"
                            f"{rnd.choice(['A款', 'B款', 'C款', '90天', '180天'])}", risk,
                        rnd.choice([7, 30, 90, 180, 365, 730, 1095]),
                        round({"低": rnd.uniform(1.8, 2.8), "中低": rnd.uniform(2.6, 3.6),
                               "中": rnd.uniform(3.2, 4.6), "中高": rnd.uniform(4.0, 6.5),
                               "高": rnd.uniform(5.5, 9.0)}[risk], 2),
                        float(rnd.choice([1, 1000, 10000, 50000, 100000])),
                        pick_weighted(rnd, ["在售", "停售"], [85, 15])))
    cur.executemany("INSERT INTO wealth_products VALUES(?,?,?,?,?,?,?)", wp_rows)

    wh_rows = []
    # 脏数据 10：15% 的持仓赎回日期为 NULL（持有中），按设计比例精确抽样
    null_redeem_idx = set(rnd.sample(range(1, P["wealth_holdings"] + 1),
                                     int(round(DIRTY["wealth_null_redeem_rate"] * P["wealth_holdings"]))))
    for i in range(1, P["wealth_holdings"] + 1):
        buy = date(2024, 1, 1) + timedelta(days=rnd.randint(0, (date(2026, 6, 30) - date(2024, 1, 1)).days))
        if i in null_redeem_idx:
            redeem = None
        else:
            redeem = (buy + timedelta(days=rnd.randint(30, 900))).isoformat()
        wh_rows.append((i, rnd.choice(cust_rows)[0], rnd.choice(wp_rows)[0],
                        round(rnd.uniform(1e4, 5e6), 2), buy.isoformat(), redeem))
    cur.executemany("INSERT INTO wealth_holdings VALUES(?,?,?,?,?,?)", wh_rows)

    # ── aml_alerts（R01 来自可疑取现簇，另有若干其他规则命中） ──
    aml_rows = []
    aid_cnt = 0
    cust_of_acct = {a[0]: a[2] for a in acct_rows}
    for acct_id, t0, amount in cluster_log:
        aid_cnt += 1
        aml_rows.append((aid_cnt, cust_of_acct[acct_id], "R01", t0.date().isoformat(),
                         round(amount * 3, 2), pick_weighted(rnd, AML_STATUS, [55, 25, 20])))
    for _ in range(P["aml_extra"]):
        aid_cnt += 1
        rule = rnd.choice(["R02", "R03", "R04"])
        hit = date(2026, 1, 1) + timedelta(days=rnd.randint(0, 180))
        amt = round({"R02": rnd.uniform(5e4, 3e6), "R03": rnd.uniform(1e5, 8e6),
                     "R04": rnd.uniform(1e4, 5e5)}[rule], 2)
        aml_rows.append((aid_cnt, rnd.choice(cust_rows)[0], rule, hit.isoformat(), amt,
                         pick_weighted(rnd, AML_STATUS, [45, 30, 25])))
    cur.executemany("INSERT INTO aml_alerts VALUES(?,?,?,?,?,?)", aml_rows)

    con.commit()

    # ── 索引：覆盖高频查询（客户维度、时间维度、关联外键） ──
    indexes = [
        "CREATE INDEX idx_emp_branch ON employees(branch_id)",
        "CREATE INDEX idx_cust_branch ON customers(open_branch_id)",
        "CREATE INDEX idx_cust_risk ON customers(risk_level, status)",
        "CREATE INDEX idx_acct_cust ON accounts(customer_id)",
        "CREATE INDEX idx_acct_branch ON accounts(branch_id, account_type)",
        "CREATE INDEX idx_acct_status ON accounts(status)",
        "CREATE INDEX idx_txn_acct_time ON transactions(account_id, txn_time)",
        "CREATE INDEX idx_txn_time ON transactions(txn_time)",
        "CREATE INDEX idx_txn_status ON transactions(status)",
        "CREATE INDEX idx_loan_cust ON loans(customer_id)",
        "CREATE INDEX idx_loan_branch ON loans(branch_id, loan_type)",
        "CREATE INDEX idx_loan_status ON loans(status)",
        "CREATE INDEX idx_lr_loan ON loan_repayments(loan_id, period_no)",
        "CREATE INDEX idx_lr_due ON loan_repayments(due_date)",
        "CREATE INDEX idx_ov_loan ON overdue_records(loan_id, stat_date)",
        "CREATE INDEX idx_ov_class ON overdue_records(classification, dpd)",
        "CREATE INDEX idx_card_cust ON credit_cards(customer_id)",
        "CREATE INDEX idx_stmt_card ON card_statements(card_id, period)",
        "CREATE INDEX idx_crep_stmt ON card_repayments(statement_id)",
        "CREATE INDEX idx_dep_acct_date ON deposits_daily(account_id, data_date)",
        "CREATE INDEX idx_wh_cust ON wealth_holdings(customer_id)",
        "CREATE INDEX idx_wh_prod ON wealth_holdings(product_id)",
        "CREATE INDEX idx_aml_cust ON aml_alerts(customer_id, hit_date)",
    ]
    for s in indexes:
        cur.execute(s)
    con.commit()
    cur.execute("VACUUM")          # 压实文件（浏览器加载体积友好）
    con.close()
    return db_path


# ════════════════════════════ 实测报告 ════════════════════════════
def measure(con, a, db_path):
    q = lambda s: con.execute(s).fetchone()[0]
    total_txn = q("SELECT COUNT(*) FROM transactions") or 1
    rep = {}

    # 1 冲正/失败
    rep["reversed_failed_rows"] = q("SELECT COUNT(*) FROM transactions WHERE status IN ('冲正','失败')")
    rep["reversed_failed_rate"] = round(rep["reversed_failed_rows"] / total_txn, 4)

    # 2 balance_after 与流水累加不一致：用「账户首笔余额 + 逐笔借贷累加」还原真实余额，
    #   逐笔比对存储值（首笔为基准，生成时即保证它不被污染），可精确命中被改写的记录。
    rep["balance_mismatch_rows"] = q("""
        WITH t AS (
          SELECT balance_after,
                CASE WHEN direction='C' THEN amount ELSE -amount END AS d,
                 FIRST_VALUE(balance_after) OVER w AS first_ba,
                 FIRST_VALUE(CASE WHEN direction='C' THEN amount ELSE -amount END) OVER w AS first_d,
                 SUM(CASE WHEN direction='C' THEN amount ELSE -amount END)
                     OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum
          FROM transactions
          WINDOW w AS (PARTITION BY account_id ORDER BY txn_time, txn_id))
        SELECT COUNT(*) FROM t WHERE ABS(balance_after - (first_ba - first_d + cum)) > 0.01""")
    rep["balance_mismatch_rate"] = round(rep["balance_mismatch_rows"] / total_txn, 4)

    # 3 value_date 与交易日跨日（记账日 ≠ 交易日）
    rep["value_date_cross_day_rows"] = q(
        "SELECT COUNT(*) FROM transactions WHERE value_date <> substr(txn_time,1,10)")
    rep["value_date_cross_day_rate"] = round(rep["value_date_cross_day_rows"] / total_txn, 4)

    # 4 销户账户仍有交易记录
    rep["closed_accounts"] = q("SELECT COUNT(*) FROM accounts WHERE status='销户'")
    rep["closed_account_with_txn"] = q("""SELECT COUNT(DISTINCT a.account_id) FROM accounts a
        JOIN transactions t ON t.account_id=a.account_id WHERE a.status='销户'""")
    rep["closed_account_txn_rate"] = round(
        rep["closed_account_with_txn"] / max(1, rep["closed_accounts"]), 4)

    # 5 已结清贷款余额不为 0
    rep["closed_loans"] = q("SELECT COUNT(*) FROM loans WHERE status='结清'")
    rep["closed_loan_with_outstanding"] = q(
        "SELECT COUNT(*) FROM loans WHERE status='结清' AND outstanding <> 0")
    rep["closed_loan_outstanding_rate"] = round(
        rep["closed_loan_with_outstanding"] / max(1, rep["closed_loans"]), 4)

    # 6 五级分类与 DPD 不匹配
    rep["classification_mismatch_rows"] = q("""
        SELECT COUNT(*) FROM overdue_records
        WHERE classification <> CASE
            WHEN dpd <= 0 THEN '正常' WHEN dpd <= 30 THEN '关注'
            WHEN dpd <= 90 THEN '次级' WHEN dpd <= 180 THEN '可疑' ELSE '损失' END""")
    rep["classification_mismatch_rate"] = round(
        rep["classification_mismatch_rows"] / max(1, q("SELECT COUNT(*) FROM overdue_records")), 4)

    # 7 信用卡溢缴款
    rep["card_statements"] = q("SELECT COUNT(*) FROM card_statements")
    rep["card_overpayment_rows"] = q(
        "SELECT COUNT(*) FROM card_statements WHERE repaid_amount > statement_amount")
    rep["card_overpayment_rate"] = round(
        rep["card_overpayment_rows"] / max(1, rep["card_statements"]), 4)

    # 8 一笔账单 2~3 条还款记录
    rep["multi_partial_repay_rows"] = q("""
        SELECT COUNT(*) FROM (SELECT statement_id FROM card_repayments
                              GROUP BY statement_id HAVING COUNT(*) BETWEEN 2 AND 3)""")
    rep["multi_partial_repay_rate"] = round(
        rep["multi_partial_repay_rows"] / max(1, rep["card_statements"]), 4)

    # 9 10 分钟内多笔等额取现
    rep["suspicious_withdraw_clusters"] = q("""
        WITH t AS (
          SELECT account_id, amount, txn_time,
                 LEAD(txn_time,2) OVER (PARTITION BY account_id, amount ORDER BY txn_time) AS third
          FROM transactions
          WHERE txn_type='取现' AND channel='ATM' AND direction='D' AND amount > 0)
        SELECT COUNT(*) FROM t
        WHERE third IS NOT NULL
          AND (julianday(third) - julianday(txn_time)) * 24 * 60 <= 10""")
    rep["suspicious_withdraw_rows"] = rep["suspicious_withdraw_clusters"] * 3
    rep["suspicious_withdraw_rate"] = round(rep["suspicious_withdraw_rows"] / total_txn, 4)
    rep["aml_alerts_r01"] = q("SELECT COUNT(*) FROM aml_alerts WHERE rule_code='R01'")

    # 10 理财持仓赎回日期为 NULL（持有中）
    rep["wealth_holdings_total"] = q("SELECT COUNT(*) FROM wealth_holdings")
    rep["wealth_null_redeem_rows"] = q("SELECT COUNT(*) FROM wealth_holdings WHERE redeem_date IS NULL")
    rep["wealth_null_redeem_rate"] = round(
        rep["wealth_null_redeem_rows"] / max(1, rep["wealth_holdings_total"]), 4)

    # 11 金额为负
    rep["negative_amount_rows"] = q("SELECT COUNT(*) FROM transactions WHERE amount < 0")
    rep["negative_amount_rate"] = round(rep["negative_amount_rows"] / total_txn, 4)

    # 12 对手方名称为空
    rep["null_counterparty_rows"] = q("SELECT COUNT(*) FROM transactions WHERE counterparty_name IS NULL")
    rep["null_counterparty_rate"] = round(rep["null_counterparty_rows"] / total_txn, 4)

    # 13 支行直接挂总行（层级深度不一致）
    rep["sub_branches"] = q("SELECT COUNT(*) FROM branches WHERE branch_level=3")
    rep["branch_level_inconsistent_rows"] = q("""
        SELECT COUNT(*) FROM branches b JOIN branches p ON p.branch_id=b.parent_id
        WHERE b.branch_level=3 AND p.branch_level=1""")
    rep["branch_level_inconsistent_rate"] = round(
        rep["branch_level_inconsistent_rows"] / max(1, rep["sub_branches"]), 4)

    # 汇总
    rep["designed"] = dict(DIRTY)
    rep["size_preset"] = a.size
    rep["seed"] = a.seed
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    rep["tables"] = {t: q(f"SELECT COUNT(*) FROM {t}") for t in tables}
    rep["total_rows"] = sum(rep["tables"].values())
    rep["db_size_mb"] = round(os.path.getsize(db_path) / 1024.0 / 1024.0, 3)
    rep["db_size_bytes"] = os.path.getsize(db_path)
    rep["db_limit_mb"] = DB_LIMIT_MB
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20260918, help="随机种子（同种子结果完全一致）")
    ap.add_argument("--size", choices=["small", "full"], default="small",
                    help="small=浏览器沙箱库(<15MB)  full=全量(供服务端大库)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                  "..", "data", "bank"))
    a = ap.parse_args()

    # 规模预设：full 在 small 基础上放大 5~10 倍
    presets = {
        "small": {"branches": 60, "employees": 900, "customers": 5000, "accounts": 8000,
                  "transactions": 36000, "loans": 4000, "max_installments": 5,
                  "overdue_records": 6000, "credit_cards": 3000, "statements_per_card": 3,
                  "deposit_accounts": 1200, "deposit_days": 10, "wealth_products": 40,
                  "wealth_holdings": 5000, "aml_extra": 60},
        "full":  {"branches": 200, "employees": 4500, "customers": 30000, "accounts": 60000,
                  "transactions": 300000, "loans": 30000, "max_installments": 12,
                  "overdue_records": 45000, "credit_cards": 20000, "statements_per_card": 8,
                  "deposit_accounts": 6000, "deposit_days": 30, "wealth_products": 120,
                  "wealth_holdings": 40000, "aml_extra": 400},
    }
    P.update(presets[a.size])

    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    db_path = os.path.join(out, "bank.sqlite")

    # small：若超 15MB 自动削减 transactions / deposits_daily / card_statements 规模重跑
    scale, rep, scaled_any = 1.0, None, False
    for attempt in range(4):
        rnd = random.Random(a.seed)      # 每次都用同一种子 → 结果依然可复现
        build(rnd, db_path, scale)
        con = sqlite3.connect(db_path)
        rep = measure(con, a, db_path)
        con.close()
        if a.size == "full" or rep["db_size_mb"] <= DB_LIMIT_MB:
            break
        scale = round(scale * 0.72, 4)
        scaled_any = True
    rep["auto_scaled"] = scaled_any
    rep["scale_factor"] = scale

    # 重建 rep 使 image 顺序更易读：seed/size 在前
    ordered = {"seed": a.seed, "size_preset": a.size, "scale_factor": scale,
               "auto_scaled": rep["auto_scaled"], "db_size_mb": rep["db_size_mb"],
               "db_size_bytes": rep["db_size_bytes"], "db_limit_mb": DB_LIMIT_MB}
    for k, v in rep.items():
        if k not in ordered:
            ordered[k] = v
    rep = ordered

    dump_schema(os.path.join(out, "schema.json"), rep["tables"])
    with open(os.path.join(out, "dirty_report.json"), "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=2)
    print(json.dumps(rep, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
