# DeFi LP 交易辅助台

一个自托管的 DeFi 流动性做市（LP）工作台：**发现池子 → 评分 → 生成投资计划 → 执行 → 持仓监控 → 复盘**。

界面是深色终端风格，所有数字可追溯到具体来源，判断逻辑是确定性代码而非模型臆测。

---

## 它解决什么问题

做 LP 的日常是这样的：在 GeckoTerminal 上翻池子、心算无常损失、开仓、然后忘了它，两周后才发现早就跑出区间了。

这个项目把这条流程固化下来，并且**拒绝让 AI 编造数字**：

- 池子评分是确定性公式（5 个维度加权），同样的输入永远同样的输出
- 研究报告里每个数字都带引用，模型只能引用证据包里的值
- 生成计划后先过风险闸门，不达标直接拦下

## 功能

| 模块 | 说明 |
|---|---|
| **发现 Feed** | 池子推荐 + 新闻混合流，按持仓和关注 token 计算相关性 |
| **榜单** | 7 个榜位：综合最优、稳健优先、高手续费、高成交、长尾热点、与你相关、新池观察 |
| **池子详情** | 评分拆解、硬门槛检查、同 token 其它池对比、72h 价格 |
| **深度调研** | 生成带引用的研究报告；可就该池子追问 |
| **投资计划** | 按本金/天数/风险档算区间、tick、手续费与 IL 场景预估 |
| **持仓看板** | 真实成本、已实现/未实现盈亏、区间状态 |
| **自动调仓** | 价格偏离中心超死区则撤出重建（默认关闭，需显式开启） |
| **通知** | 告警、自动调仓、系统事件统一收件箱，带去重 |
| **复盘** | 按仓位/周期/风格复盘，样本不足时拒绝给风格结论 |
| **AI 助手** | 基于系统内真实数据对话，可带池子上下文提问 |

## 快速开始

需要 **Node.js ≥ 22**（用到内置 `node:sqlite`）。无需安装依赖，零 npm 包。

```bash
git clone <this-repo>
cd defi-lp

# 1. 配置
cp .env.example .env
# 编辑 .env，至少填 DEEPSEEK_API_KEY

# 2. 建登录账号
LP_USER=admin LP_PASS='your-password' node cli/set-password.ts

# 3. 启动
node app/server.ts
# 打开 http://localhost:3000
```

首次启动会自动建库（`data/lp.db`）并拉取行情。

### 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 模型 Key。兼容 OpenAI 协议 |
| `DEEPSEEK_BASE_URL` | 否 | 自定义端点，默认 `https://api.deepseek.com/v1` |
| `LP_LLM_MODEL` | 否 | 默认 `deepseek-flash` |
| `LP_USER` / `LP_PASS` | 首次 | 建账号用，之后可删 |
| `PORT` | 否 | 默认 3000 |
| `LP_CHAIN` | 否 | 默认 `x-layer`，支持 base / ethereum / arbitrum |
| `LP_DB` | 否 | 数据库路径 |
| `ONCHAINOS_BIN` | 否 | 链上执行工具路径，不做真实交易可不配 |

## 项目结构

```
app/
  server.ts            HTTP 服务 + 路由 + 定时任务
  public/              前端（原生 ES module，无构建步骤）
core/
  db.ts                SQLite schema（自动建表）
  llm.ts               模型客户端（流式 + 非流式）
  auth.ts              密码哈希、会话、预算闸门
  research.ts          报告生成流水线
  jobs.ts              后台任务
  tools/
    pools.ts           行情数据（GeckoTerminal）
    score.ts           评分引擎 ← 所有阈值只在这一处
    plan.ts            投资计划生成
    ticks.ts           V3 tick 数学
    execute.ts         链上执行（需确认）
    monitor.ts         持仓巡检
    autoRebalance.ts   自动调仓决策
    leaderboard.ts     榜单
    review.ts          复盘与风格分析
    assistant.ts       助手对话
    ...
cli/
  lp.ts                数据管道命令
  set-password.ts      设置登录凭据
skills/                4 个技能说明（给 AI agent 用）
playbooks/             6 份工程 playbook（怎么把这个系统搭起来）
```

## 设计原则

**1. 阈值只在一处。** `core/tools/score.ts` 是唯一写数字的地方，`skills/` 里的文档镜像这些数字，测试断言两者一致。

**2. 模型不许编数字。** 研究报告先构建证据包（每个值带 `factId`），模型只能引用包里有的。引用不存在的 id 会被判为无效。

**3. 不确定就降级。** 数据源失败时报告标记 `degraded` 并列出缺失项，不猜。

**4. 危险操作默认关闭。** 自动调仓、链上执行都需要显式开启，且执行前有风险闸门。

**5. 样本不足不下结论。** 复盘模块会检查观察窗口；3 笔仓位观察 2 小时得出的"交易风格"会被标记为不可靠，并且不参与榜单个性化。

## 链上执行

`core/tools/execute.ts` 通过外部 `onchainos` CLI 执行真实交易。

**默认情况下不配置它，系统就是纯分析工具** —— 发现、评分、计划、监控、复盘全部可用，只是不能下单。

如果要用真实交易，你需要：
1. 安装 `onchainos` 并配置钱包
2. 设置 `ONCHAINOS_BIN`
3. 每笔交易都要在界面上手动确认

## 数据来源

- 行情、池子、OHLCV：[GeckoTerminal](https://www.geckoterminal.com) 公开 API（无需 key）
- 新闻：RSS 源，在 `core/tools/news.ts` 里配置
- 行情接口有速率限制，已内置缓存和最小请求间隔

## 已知限制

- 长尾 token 的持仓分布、流动性集中度拿不到（数据源不提供），报告里会列为 gap
- 只支持 Uniswap V3 风格的集中流动性
- 单用户设计，没有多租户
- 自动调仓只做 recenter，不做自动平仓（风险不对称，故意没做）

## 许可

MIT
