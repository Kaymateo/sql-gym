# 数据工场 · 大数据链路训练场（sql-gym）

浏览器里的大数据 / 数仓训练平台：**把整条数据传输链路搬进网页**，你在每一环写真实代码，
系统用四层校验告诉你**哪里错了、错在哪一层**。

- **零安装**：不用搭 Hadoop / Hive / Spark 集群，`npm install` 即可开练
- **零框架**：Node ESM + sql.js(WASM)，前端原生 JS，无构建步骤
- **仿真数据**：电力（电网营销 / 用电采集）+ 银行（零售银行）两个真实业务口径场景
- **真校验**：不是"看起来对"，而是真的模拟执行——产出行数、分区目录、血缘、端到端金额一致性

> ⚠️ **诚实边界**：这是**教学模拟器**，不是真集群。用 SQLite 当 Hive/Spark 引擎、内存目录树当 HDFS、
> 虚拟时钟推 DAG。理由见 [`docs/数据链路模拟器设计.md`](docs/数据链路模拟器设计.md) 第八节——
> 真实集群要 8 台机器 + 3 天搭环境，劝退 99% 的初学者；而数据链路的核心难点在于**想清楚怎么搬、搬对没有**，
> 不在于装 Hadoop。

---

## 一、快速开始

```bash
npm install          # 只装一个依赖：sql.js
npm test             # 引擎端到端单测（9 个用例）
npm run demo         # 在 Node 里跑一遍完整链路，打印每一环的校验结果
npm run serve -- --port 3010   # 起界面，浏览器打开 http://localhost:3010
```

`npm run serve` 只暴露白名单目录（`public` / `src` / `vendor` / `data` / `docs`），
不会把 `node_modules` 和脚本目录暴露出去。

---

## 二、界面

| 页面 | 路径 | 说明 |
|---|---|---|
| 首页 | `/` | 场景与题目入口（ODPS / DataWorks 风格） |
| **链路工作台** | `/pipeline.html` | **主战场**：八个节点串成一条日调度链路，逐节点写代码 + 校验 + 看产物 |
| **SQL 控制台** | `/sql-console.html` | 像 ODPS 那样写 SQL，左侧目录树看表、字段、分区、数据字典 |

两个场景各带一条**预置演示链路**（`public/demos/*.json`），打开即可跑：

| 场景 | 演示链路 | 节点数 |
|---|---|---|
| 电力 | 电力·台区抄表日链路 | 8 |
| 银行 | 银行·交易流水日链路（含反洗钱质检） | 8 |

每个节点都是真实工具口径：`source_mysql` → `sqoop_import` → `hive_create_table` →
`hive_sql` → `data_quality` → `export_mysql` → `dag_schedule`。

---

## 三、校验的三层含义（产品技术核心）

| 层级 | 校验什么 | 举例 |
|---|---|---|
| **L1 代码正确** | 语法、必填参数、命名规范 | `sqoop import` 缺 `--target-dir` → 报错 |
| **L2 产物正确** | 产出的表 / 分区 / 文件是否符合期望 | 分区目录 `dt=202403` 下应有 4 个 part 文件、共 5691 行 |
| **L3 链路正确** | 端到端数据是否一致、血缘是否完整 | 源表 → ODS → DWD 去重后行数与金额合计必须相等 |

每种节点类型实现统一的校验器接口（`src/lib/validators.mjs`）：

```js
validator = {
  type: 'sqoop_import',
  lint(code, node, ctx)    -> { errors, warnings },   // ① 静态：只看代码
  resolve(code, node, ctx) -> { plan, errors },       // ② 语义：表/字段/路径存不存在
  run(plan, ctx)           -> { outputs, logs },      // ③ 模拟执行：真的跑
  check(outputs, expect)   -> { status, details },    // ④ 产物：与期望比对
}
```

**四层校验的价值**：用户得到的不是"错/对"，而是**具体哪一层错了**——
`lint` 挂 → "你少写了 `--target-dir`"；`run` 挂 → "表不存在"；
`check` 挂 → "行数差了 137 行，是不是没剔除估抄？"

---

## 四、目录结构

```
sql-gym/
├── src/lib/                 # 引擎（纯 ESM，Node 与浏览器同构）
│   ├── vfs.mjs              # 虚拟 HDFS：目录树 / 分区 / part 文件 / 元数据
│   ├── dialect.mjs          # Hive / Spark SQL → SQLite 方言翻译 + 报错人话化
│   ├── hive.mjs             # 数仓元数据：分层表、字段、分区、LOCATION、血缘
│   ├── pipeline.mjs         # 节点模型 + 依赖图 + 执行器 + 校验器注册表
│   ├── validators.mjs       # 各节点类型的四层校验实现
│   ├── db.mjs               # sql.js(WASM) 执行层，浏览器/Node 双端加载
│   ├── judge.mjs            # 判题器：结果集归一化比对 + 三态反馈
│   ├── problems.mjs         # 题库（power 9 + bank 9）
│   ├── scene.mjs            # 场景定义 + ODS 层初始化
│   ├── project.mjs          # 工程/项目沙箱
│   ├── console.mjs          # SQL 控制台后端
│   ├── grade.mjs            # 评分
│   └── odps.mjs             # ODPS 风格接口适配
├── public/                  # 前端（原生 JS，无框架无构建）
│   ├── index.html           # 首页
│   ├── pipeline.html/.js    # 链路工作台
│   ├── sql-console.html/sql.js      # SQL 控制台
│   ├── studio.js            # 工作台逻辑
│   └── demos/{power,bank}.json      # 预置演示链路
├── data/                    # 仿真数据（可直接使用，见下节可复现生成）
│   ├── power/power.sqlite   # 电力 15 表 167,421 行
│   ├── bank/bank.sqlite     # 银行 15 表 118,356 行
│   └── */schema.json        # 表结构元数据（数据字典页 + 编辑器自动补全）
│       */dirty_report.json  # 脏数据实测比例（验收依据）
├── scripts/                 # 数据生成 / 自检 / 服务
├── tests/pipeline.test.mjs  # 引擎端到端测试
├── vendor/                  # sql.js 的 WASM 运行时（浏览器端用）
└── docs/                    # PRD + 链路模拟器设计文档
```

---

## 五、仿真数据

两个场景都是**真实业务口径**，不是玩具表（全中文元数据：表中文名、表含义、字段中文名、业务含义）。

| 场景 | 表数 | 总行数 | 代表表 |
|---|---|---|---|
| 电力（电网营销 / 用电采集） | 15 | 167,421 | `meter_readings` 22,764 / `load_curve_96` 59,461 / `transformer_supply` 10,240 |
| 银行（零售银行） | 15 | 118,356 | `transactions` 36,097 / `loan_repayments` 21,614 / `deposits_daily` 12,000 |

数据生成器只用 Python 标准库，**固定随机种子 → 完全可复现**（同种子两次生成 md5 一致）：

```bash
npm run gen:power        # 电力（默认 small 规模）
npm run gen:power:full   # 电力（full 规模）
npm run gen:bank         # 银行
npm run schema           # 重新导出 schema.json
```

> 仓库内**已提交**生成好的 `data/*/*.sqlite`，`npm install && npm run serve` 即可直接开练，
> 无需先跑生成器。想改数据规模再用上面的命令重新生成。

---

## 六、自检与测试

```bash
npm test             # 引擎端到端：真实电力库 → Sqoop 采集 → HDFS → Hive 建表 → DWD 加工 → 导出 → 调度
npm run demo         # 同上，打印人类可读的全链路报告（HDFS 目录 / 数仓表 / 血缘 / 总判定）
npm run verify:web   # 网页端业务流程 + 题库 + 演示 SQL 全量自检（19 项题库自检）
npm run check:problems   # 逐题验证：跑参考解，确认每题都判得出来
npm run check:browser    # 浏览器兼容性静态检查：扫描浏览器模块图，抓 Node 专有 API 与写错的导入名
```

`npm run demo` 的真实输出（节选）：

```
✅ ⑤ Hive SQL 加工（剔除估抄）  [hive_sql · pass · done · 2ms]
   · 数字校验通过
   产物：5209 行 → dwd.readings_di
✅ ⑦ 回写报表库  [export_mysql · pass · done · 0ms]
   · 从 /user/hive/warehouse/dwd.db/readings_di/dt=202403 导出 5209 行到报表库表 rpt_readings_di

──── HDFS 目录（模拟）────
  /user/hive/warehouse/ods.db/meter_readings/dt=202403/part-m-00000  parquet 1422 行 127980B
  /user/hive/warehouse/dwd.db/readings_di/dt=202403/part-00000       parquet 5209 行 177106B

──── 数据血缘 ────
  power.meter_readings  --[ingest]-->  /user/hive/warehouse/ods.db/meter_readings/dt=202403
  ods.meter_readings    --[transform]-->  dwd.readings_di

──── 链路总判定 ────
  节点：8/8 通过    元数据 ↔ HDFS 一致性：通过    血缘边：2

  🎉 整条链路校验通过
```

---

## 七、环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 18（实测 22） | 引擎与本地服务 |
| Python | ≥ 3.9（实测 3.11） | **仅**重新生成仿真数据时需要，只用标准库 |

---

## 八、文档

- [`docs/数据链路模拟器设计.md`](docs/数据链路模拟器设计.md) —— 六层链路、校验引擎、血缘、诚实边界
- [`docs/PRD.md`](docs/PRD.md) —— 产品需求（含 Word 版 `SQL训练场_PRD.docx`）

---

## 九、已知限制

- 模拟器不是真集群：方言翻译覆盖常用 Hive/Spark SQL 子集，不支持 UDF、窗口帧等高级语法
- 调度是虚拟时钟推进，不模拟真实资源竞争与 executor 队列
- 题库当前每场景 9 题（设计文档的 185 题为完整规划，未全部实现）
