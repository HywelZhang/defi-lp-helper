# DeFi LP 交易辅助台 — 技术方案（v0.2）

> 前置：`PLAN.md` v0.1 已获确认（Base + Uniswap V3、纸面优先、本机+Tailscale、加 Alchemy/Basescan 免费 key、产出 skill、UI 神似）。
> 本文件回答一个问题：**哪些是代码、哪些是 skill、哪些是 tool，各自干什么，怎么串起来。**
> 所有 API 结论来自 2026-10-25 实测（见 §10）。

---

## 1. 三层分工（核心答案）

一句话：**Tool 出事实，Skill 出判断口径，Code 出产品和执行。**

```
        ┌─────────────────────────────────────────────┐
        │ Code：页面 / API / 采集 / 调度 / 规则 / 签名  │  ← 产品与执行力
        └───────────────┬─────────────────────────────┘
                        │ 调用
        ┌───────────────▼─────────────────────────────┐
        │ Tool：确定性函数 (CLI + HTTP)，只回 JSON      │  ← 事实与计算
        └───────────────┬─────────────────────────────┘
                        │ 被读入 prompt
        ┌───────────────▼─────────────────────────────┐
        │ Skill：Markdown 流程 + 阈值 + 输出结构        │  ← 判断口径
        └─────────────────────────────────────────────┘
```

| 层 | 载体 | 谁调用 | 能否产生数字 | 可否单测 |
|---|---|---|---|---|
| **Tool** | TypeScript 库 + `lp` CLI + `/api/tools/*` | Code、OpenClaw agent、你手动 | 是，唯一来源 | 是（纯函数 + 录制回放） |
| **Skill** | `skills/defi-lp-*/SKILL.md` | OpenClaw agent、App 的报告生成器 | 否 | 是（golden 用例） |
| **Code** | Next.js 应用、worker、DB | 人 | 只透传 | 部分 |

**关键约束（不可破）**：
1. LLM 文本里出现的任何数字，必须能在 Tool 输出里找到；找不到 → 报告标记 `degraded` 并剔除该句。
2. Skill 不写死具体池子/价格，只写口径与流程。
3. Tool 不读 LLM 输出，Tool 之间可自由组合。

---

## 2. Tool 清单（确定性能力层）

统一约定：
- 返回 `{ ok, data, facts: [{id, label, value, unit, ts, source}], sources: [{name,url,ts}], degraded?: bool }`
- `facts[].id` 是**引用锚点**，报告里的每条结论必须挂 `fact_id`，这是防幻觉的物理基础
- 全部有 `--json` 输出，agent 可直接 shell 调用
- 每个 tool 有 schema 版本号，破坏性变更升 major

### 2.1 发现类
| Tool | 功能 | 输入 → 输出 |
|---|---|---|
| `pools.list` | 榜单查询（排序/过滤/分页） | chain, dex, feeTier, sort(tvl/vol/feeApr/turnover), minTvl, page → 池行 |
| `pools.trending` | 热门池（按 1h/6h/24h 成交与涨幅） | chain, window → 池行 |
| `tokens.pools` | 某 token 的全部池，聚合对比 | token → 池列表 + 汇总（最佳深度/最佳收益） |
| `tokens.profile` | token 元数据 + 持有人集中度 + 合约安全标记 | token → profile + facts |
| `news.fetch` | 新闻抓取（RSS/API），抽取实体（token/pool） | sources, since → items[] |
| `news.rank` | 按相关性排序（持仓 > 关注 > 热门） | items, watchlist, positions → ranked |

### 2.2 分析类
| Tool | 功能 | 说明 |
|---|---|---|
| `pool.detail` | 池全量事实：价格、TVL、vol、fee、turnover、区间宽度、年龄、价格序列 | 单次聚合并缓存 |
| `pool.depth` | 给定金额的滑点曲线 + 深度分档 | 由 V3 tick liquidity 计算（RPC + subgraph/logs） |
| `pool.holders` | 持仓集中度：top LP 占比、独立 LP 数、NFT 分布 | **依赖见 §9 风险 R2** |
| `token.narrative` | 叙事素材：简介、社交链接、相关新闻标题、同赛道对比 | 只回素材，判断交给 skill |
| `vol.realize` | 已实现波动率（7/30/90d）、区间覆盖概率 | GBM 近似 + 历史分位 |
| `range.sim` | 集中流动性区间模拟：资金分配、预期手续费、IL 情景表 | 输入下/上界%、本金、持有期 |
| `il.simulate` | 历史区间 IL 回放 | 给定入场时间与区间 |
| `score.compute` | 五维评分 + 硬门槛 + 置信度 | **纯确定性**，同输入同输出，可回测 |
| `evidence.bundle` | 把上述事实压成 LLM 可读的紧凑 JSON（token 预算内） | 报告流水线的唯一输入 |

### 2.3 计划 / 执行类
| Tool | 功能 |
|---|---|
| `plan.build` | 由池 + 本金 + 风险档生成计划（区间、目标、进出场、情景表） |
| `risk.check` | 计划过门槛；返回拦截项与告警项 |
| `position.discover` | 钱包在 Base 上的 V3 NFT 仓位枚举 |
| `position.snapshot` | 当前价值、待领费用、IL、是否在区间、距边界 % |
| `pnl.compute` | 区间内 PNL 曲线（含费用、IL 归因、gas） |
| `tx.build` | 生成未签名交易（approve/mint/increase/decrease/collect/burn）+ 本地模拟 |
| `tx.simulate` | `eth_call` 预演，返回是否 revert、预估 gas、余额变化 |

### 2.4 复盘类
| Tool | 功能 |
|---|---|
| `review.build` | 单笔仓位的结构化事实包（开仓 vs 平仓、归因、规则命中记录、同期对比） |
| `review.aggregate` | 周/月多仓位汇总统计（胜率、平均持有、IL 占比、费用效率） |
| `style.profile` | 统计画像：风险档、持有期分布、止损纪律、追高倾向、区间选择偏差 |
| `weights.apply` | 把画像转成评分卡权重/门槛调整（有边界，禁止自我放大） |
| `reco.outcome` | 推荐快照的 7/30 天结果回填（回测闭环） |

**Tool 层总计约 22 个，全部可在聊天里被 agent 直接调用** —— 这是「沉淀」的落点。

---

## 3. Skill 清单（判断口径，Markdown）

| Skill | 何时触发 | 内容 | 被谁用 |
|---|---|---|---|
| `defi-lp-scoring` | 出榜单/评价某池 | 硬门槛、五维权重、理由写法、置信度定义 | App 榜单解释 + agent |
| `defi-lp-research` | 「深度调研/值不值得做」 | 调研顺序（token→池对比→深度→holders→风险）、报告章节、引用规范 | App 报告 + agent |
| `defi-lp-plan` | 「给我一个建仓计划」 | 区间选择法、仓位 sizing、进出场条件、情景表格式 | App 计划页 + agent |
| `defi-lp-position-review` | 仓位结束/「复盘这笔」 | 归因框架、错误分类（择时/区间/资产/纪律）、结论格式 | App 单笔复盘 + agent |
| `defi-lp-periodic-review` | 每周/每月 | 聚合指标、风格画像解读、下期调整建议 | App 周期报告 + 定时任务 |

**单一事实源设计**：App 的报告生成器**直接读取**这些 SKILL.md 作为 system prompt 片段（构建时打包），所以「聊天里的分析」和「页面上的分析」口径永远一致。改 skill = 同时改两处，不会漂移。

配套：
- `references/scoring.md` 权重表与阈值（数值只在这里出现一次）
- `scripts/demo.sh` 用真实池跑通全流程，作为 golden 用例
- 每个 skill 带 1 个「反例」段落，说明什么情况下不给推荐

---

## 4. Code 清单（产品与执行力）

### 4.1 页面（对应你三张截图）
| 路由 | 模块 | 要点 |
|---|---|---|
| `/discover` | 榜单 + **Feed** | 顶部资产/费率/时间筛选、表格式密集行（对齐第二张截图）、分组折叠（token→其下多池）、右侧 rail |
| `/feed` | 实时信息流 | 卡片流：新闻卡（来源/时间/实体标签）、池推荐卡（评分/关键数字/风险标签）、仓位异动卡；SSE 推送；「深度调研」按钮 |
| `/pools/[chain]/[addr]` | 深度调研 | 左：事实区（价格+区间图、TVL/vol/APR、深度曲线、holders、token 信息）；右：AI 结论卡（评分雷达、推荐度、理由带引用、风险、计划草案） |
| `/plans/[id]` | 投资计划 | 区间可视化、本金分配、情景表、进出场条件、风险清单、生成交易 |
| `/positions` | 仓位管理 | 卡片：当前价值/费用/IL/区间位置条/健康度；每卡「AI 分析」入口；右上「今日报告」 |
| `/positions/[id]` | 单仓详情 | PNL 曲线、费用累计、规则状态、操作/复盘时间线 |
| `/automations` | **定时任务** | 复刻第一张截图：计划已开启/已完成、下次运行、运行记录、立即执行/暂停/编辑/删除 |
| `/portfolio` | 我的资产 | 复刻第三张：总览卡、各账户、最近记录 |
| `/review` | 复盘 | 单笔列表、周期报告、风格画像变化 |
| `/ai` | AI 助手 | 对话 + 工具调用步骤卡 + 右侧行情/能力栏 |
| `/settings` | 设置 | 钱包、数据源 key、阈值、通知 |

设计系统：深色 `#0b0d0a` 底、卡片 `#12140f`、荧光绿 `#c8f751` 主色、等宽数字、1px 细边框、密集表格。全局 ⌘K。

### 4.2 API / 服务
- `app/api/*` REST + zod 校验；SSE `/api/stream/feed`、`/api/stream/job/:id`
- 服务端只做编排与鉴权（单用户 + 访问口令），无状态

### 4.3 报告生成器（回答「内容 → AI 分析」怎么办）
```
内容(池/新闻/仓位)
   ↓ 路由判定 kind
evidence.bundle          ← Tool，确定性事实 + fact_id
   ↓
score.compute            ← Tool，先出确定性结论（LLM 不可改）
   ↓
Skill prompt + evidence  ← 从 SKILL.md 组装
   ↓
LLM（结构化 JSON 输出）
   ↓
Validator  ← ① schema ② 数字溯源 ③ 引用合法 ④ 禁词
   ↓ 失败重试 1 次，仍失败 → degraded 报告（只显示事实+确定性评分）
渲染：事实即时出现，AI 段落流式追加，每条结论点击可看来源
```
- 缓存键 = `hash(subjectId + evidenceVersion + skillVersion)`，同池 6h 内不重复烧 token
- `degraded` 明确显示「AI 部分不可用」，绝不静默编造
- 新闻跳转时带 `trigger` 上下文（哪条新闻、什么催化），AI 必须把「催化」与「事实」分小节写

### 4.4 规则引擎 + 调度
- DSL 存库、UI 可视化、可导出；评估纯函数
- 每次评估落 `rule_runs`（输入 hash、判定、动作、tx、错误）
- 幂等：`(ruleId, positionId, 时间窗)` 唯一约束 + 行锁
- 三级保护：全局 kill switch / 单仓开关 / 连续失败 3 次自动降级为仅通知
- 调度用 Graphile Worker（Postgres 队列，自带重试/退避），不用裸 cron

### 4.5 数据层
Postgres 16（docker compose），Drizzle ORM。核心表：
`tokens / pools / pool_snapshots / token_snapshots / positions / position_snapshots / plans / recommendations / reco_outcomes / research_reports / news_items / news_links / rules / rule_runs / jobs / job_runs / events / style_profiles`

- `pool_snapshots` 按小时落，保留 90 天热数据
- `events` append-only，所有关键动作可回放
- 所有表带 `source` 与 `fetched_at`，UI 显示数据时间

---

## 5. 三个新模块的具体设计（你这次补的）

### 5.1 Feed 模块（`/feed` + 首页右栏）
- **来源**：RSS/API（CoinDesk、The Block、律动、项目官方 blog）+ DefiLlama 公告 + 池异动（TVL 骤变、APR 跳升、新池）
- **卡片类型**：新闻卡 / 池推荐卡 / 仓位异动卡 / 规则触发卡
- **排序**：`相关性(持仓>关注>赛道) × 时效衰减 × 来源权重`，去重（标题指纹 + 相似度）
- **交互**：SSE 实时插入（新卡高亮 3s）、按类型筛选、「深度调研」一键带上下文进 `/pools`
- **落库**：`news_items` 保留 30 天，卡片渲染用快照，不实时打 API

### 5.2 深度调研的 AI 链路
见 §4.3。补充三点：
- **token 维度**：叙事（是什么/谁在做/催化）+ 同 token 各池对比表 + 集中度与解锁风险
- **LP 维度**：区间、深度、费用真实来源（有机 vs 激励）、IL 历史分位、top position 行为
- **输出必须分三段**：`客观事实`（纯数据）/ `判断`（评分+理由，带引用）/ `行动计划`（区间/金额/条件）。混在一起就不可审计。

### 5.3 仓位管理 + 每日/结束报告
- `/positions` 卡片行：资产对、区间位置条（当前价在区间中的百分比）、当前价值、已赚费用、IL、健康度（绿/黄/红）、规则状态
- 每卡 **[AI 分析]**：走同一报告流水线（kind=position），带「立即分析/后台生成」
- **每日报告**：默认 09:00（可配）生成，内容 = 全部仓位快照 + 变化归因 + 风险提醒 + 今日机会 3 条；推送到 LightClawBot + 落 `/automations` 运行记录 + `/review`
- **结束报告**：仓位 liquidity 归零或 NFT 转出 → 自动触发单笔复盘（开仓快照 vs 平仓、费用/IL/gas 拆解、规则是否按预期执行、同类池对比）

### 5.4 定时任务模块（`/automations`）
任务类型（预置模板）：
| 模板 | 默认频率 |
|---|---|
| 资产行情观察 | 30 min |
| 持仓风险巡检 | 5 min |
| 榜单刷新 + 新机会 | 15 min |
| Feed 抓取 | 30 min |
| 每日持仓报告 | 每天 09:00 |
| 周复盘 | 周一 09:00 |
| 月复盘 + 风格画像 | 每月 1 日 |

卡片信息：名称、频率、状态（计划已开启/已完成/已暂停）、下次运行、运行记录（时长、结果摘要、是否告警）。操作：立即执行 / 暂停 / 编辑 / 删除 / 看历史。
实行：每个任务 = 一个 Graphile Worker 的重复作业 + 一张 `job_runs` 记录；UI 直接读 `job_runs`，不另建状态。

---

## 6. 技术选型（本机实测可用版本）

| 项 | 选择 | 说明 |
|---|---|---|
| 运行时 | Node 24.21 | 已装 |
| 框架 | Next.js 16.4.3 + React 19.3.1 | App Router，SSE 走 Route Handler |
| 语言 | TypeScript strict | 全栈同栈，无 Rust 依赖 |
| 样式 | Tailwind v4 + CSS 变量 | 主题 token 集中 |
| DB | Postgres 16 (docker) + Drizzle 0.45.4 | |
| 链 | viem 2.57.11 | 只读优先；签名走前端 wallet |
| 队列 | Graphile Worker | 幂等、重试、重复任务 |
| 图表 | lightweight-charts | 价格/PNL 曲线 |
| 校验 | zod | 工具入参 + LLM 输出 schema |
| 测试 | vitest + 录制回放 | 工具层用真实响应快照做回放 |

---

## 7. 仓库结构

```
projects/defi-lp/
├─ app/                      # Next.js 路由与页面
│  ├─ (dashboard)/discover|feed|pools|plans|positions|automations|portfolio|review|ai|settings
│  └─ api/{tools,research,feed,positions,rules,jobs}/...
├─ core/
│  ├─ tools/                 # ← Tool 层（无 LLM 依赖）
│  │   ├─ pools.ts tokens.ts news.ts
│  │   ├─ analysis.ts (depth/vol/range/il)
│  │   ├─ score.ts plan.ts risk.ts
│  │   ├─ positions.ts pnl.ts review.ts
│  │   └─ index.ts (registry + zod schemas)
│  ├─ agent/                 # evidence builder / prompt / validator / cache
│  ├─ rules/                 # DSL 解析 + 评估 + 执行
│  ├─ ingest/                # 采集器 + 限流 + 归一化
│  └─ db/                    # Drizzle schema + migrations
├─ cli/lp.ts                 # agent 与人类共用的 CLI 入口
├─ skills/                   # ← Skill 层（同时链接到 workspace/skills）
│  ├─ defi-lp-scoring/{SKILL.md,references/,scripts/}
│  ├─ defi-lp-research/
│  ├─ defi-lp-plan/
│  ├─ defi-lp-position-review/
│  └─ defi-lp-periodic-review/
├─ workers/                  # 队列消费者
├─ docker-compose.yml        # postgres + app + worker
└─ tests/{golden,replay}/
```

---

## 8. 交付顺序（更新版）

| 阶段 | 内容 | 验收 | 估时 |
|---|---|---|---|
| **M0** | 仓库、主题壳、DB、采集器、`pools.list/detail`、`score.compute`、CLI | 页面能看真实 Base 榜单；CLI 可出评分 | 3–4d |
| **M1** | `/discover` 榜单 + **Feed** + 推荐快照 | Feed 有真实新闻与推荐卡，可点进池 | 4–5d |
| **M2** | 深度调研页 + 报告流水线 + Validator | 点任一池，事实 1s 内出、AI 30s 内出且每条有引用 | 5–6d |
| **M3** | 计划 + 纸面仓位 + PNL | 完整跑一单纸面，看到费用/IL 曲线 | 4–5d |
| **M4** | `/positions` + AI 入口 + 每日报告 + 结束报告 | 纸面仓位自动出日报；平仓自动出复盘 | 5–6d |
| **M5** | `/automations` + 规则引擎 + 通知 + kill switch | 规则可复现触发，dry-run 与实盘隔离 | 4–5d |
| **M6** | 复盘 + 风格画像 + 权重回写 + 推荐回测 | 画像变化能改变榜单排序（可对比截图） | 4–5d |
| **M7**（可选） | 真实签名 + 小额实盘 | 测试钱包在 Base 完成一笔真实 LP | 4–6d |

M0–M6 约 **29–36 人日**，M7 另计。每阶段结束给可点的东西。

---

## 9. 风险与诚实说明

- **R1 数字溯源不是万能的**：validator 能挡住"编造数字"，挡不住"正确数字的错误解读"。所以报告强制分「事实/判断」两段，判断段可被回测检验。
- **R2 top positions / 持仓分布**：Uniswap V3 的子图依赖 The Graph 网关（需免费 key）。无 key 时降级为「通过 Mint/Burn 日志索引 LP NFT」或只给集中度近似值，并在 UI 标注 `近似`。
- **R3 免费 API 限流表现为数据错乱而非报错**，必须有缓存 + `degraded` 标记 + UI 显示数据时间。
- **R4 评分卡不保证盈利**，只过滤明显垃圾。唯一验证手段是 M1 起就落推荐快照、4 周后用 `reco.outcome` 回填。
- **R5 LLM 成本**：报告按 evidenceVersion 缓存，同池 6h 复用；榜单解释用模板+短推理，只有深度调研用长文。
- **R6 执行风险**：默认 dry-run，实盘需显式开启 + 单笔限额 + kill switch；服务端永不存私钥。

---

## 10. 本次实测记录（2026-10-25）

| 接口 | 结果 |
|---|---|
| GeckoTerminal `/networks/base/pools` | ✅ 返回池行：价格、reserve_in_usd、volume(5m/15m/30m/1h/6h/24h)、transactions、pool_created_at |
| GeckoTerminal `/tokens/{addr}` | ✅ 名称、decimals、FDV、市值、持有储备、top_pools 关系 |
| GeckoTerminal `/pools/{addr}/ohlcv/hour` | ✅ OHLCV 序列 |
| GeckoTerminal `/networks/base/trending_pools` | ✅ |
| DefiLlama `yields/pools` + `/chart/{id}` | ✅ TVL/APY/IL 风险/时序历史 |
| DefiLlama `coins.llama.fi/prices` | ✅ 多链价格，带 confidence |
| DefiLlama `protocol/{name}` | ✅ |
| Base RPC `eth_blockNumber` | ✅ 区块正常 |
| DexScreener `latest/dex/search` | ✅ 可作为备用源（含多链） |
| 版本：Next 16.4.3 / React 19.3.1 / Drizzle 0.45.4 / viem 2.57.11 | ✅ npm registry 实时查询 |

注：第二张截图顶部出现 `robinhood` 链与 `Robinhood` 资产 —— 若你后续想覆盖该链（它已出现在 DexScreener 的 chainId 里），采集层设计为多链，只需加适配器；v1 仍建议只做 Base。
