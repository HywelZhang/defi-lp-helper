---
name: defi-lp-research
description: Produce an auditable LP research report for one pool — objective facts, deterministic score, judgement with citations, and an action plan. Use when asked "这个池子值不值得做", "深度调研某个 LP", or when a feed card needs full analysis.
---

# DeFi LP 深度调研

对单个 LP 池产出一份**可审计**的报告。报告分三段，顺序不可变：客观事实 → 判断 → 行动计划。

## 铁律

1. **数字只有一个来源**：证据包。证据包外的数字不得出现在任何段落，包括标题。
2. **评分不可改写**。`score.total`、`score.grade`、各维度分是 `score.compute` 的输出，你只能解释，不能重算、不能调整。
3. **每条判断必须挂 ref**。ref 是证据包里的字段名，没有 ref 的判断直接丢弃。
4. **判断与评分必须自洽**：评分低不能说"值得做"，有硬门槛未通过不能说"可以考虑"。
5. **不许空话**。"表现良好""值得关注""具有一定的优势"一律禁止，必须带具体数值。

## 判断口径

### verdict 与评分的映射

| 评分 | 硬门槛 | 允许的 verdict |
|---|---|---|
| ≥ 80 (A) | 全通过 | consider / favor |
| 68–79 (B) | 全通过 | watch / consider |
| 55–67 (C) | 全通过 | watch |
| < 55 | 任意 | avoid / watch |
| 任意 | 有 block 级未通过 | avoid（唯一选择） |

### 收益怎么看

fee APR 是**上限估算**（24h 成交 × 费率档 / TVL × 365）。真实收益通常更低，因为 V3 成交集中在活跃 tick。写收益时必须带上这个限定，例如"fee APR 54.7%，这是按全部成交走同一费率档算出的上限"。

判断收益是否可信，看两个信号：
- **换手率**（vol/TVL）：低于 0.1 说明池子冷，高于 5 说明可能刷量。0.3–3 是健康区间。
- **APR 与池龄是否匹配**：新池高 APR 往往是激励期，不可持续。

### 风险怎么看

按这个优先级排序，最严重的写第一条：
1. **IL 放大**：双波动资产 + 价格 24h 波动 > 10%
2. **容量不足**：TVL / 本金 < 20x，进出会显著推动价格
3. **刷量嫌疑**：APR > 300% 或换手 > 5
4. **流动性撤离**：单一 LP 占比高、TVL 快速下降
5. **资产本身**：长尾 token、无审计、集中度高

### 行动计划怎么写

必须可执行，包含四项：
- **区间**：给出具体百分比范围，并说明依据（如"±10%，覆盖 30d 波动的 1.5 倍"）
- **金额**：不超过容量的 1/20
- **进入条件**：什么情况下才进（不要"现在就可以"）
- **退出条件**：至少一条，必须是可判定的（价格越界 N 小时、APR 跌破 N%、TVL 跌破 N）

## 输出结构

严格按此 JSON 输出，不要 markdown 围栏：

```json
{
  "verdict": "avoid|watch|consider|favor",
  "headline": "一句话结论",
  "objective":    [{ "text": "...", "refs": ["pool.tvl"] }],
  "judgement":    [{ "text": "...", "refs": ["score.total"], "confidence": "low|medium|high" }],
  "action":       [{ "text": "...", "refs": ["pool.feeApr"] }],
  "risks":        [{ "text": "...", "refs": ["score.dims"] }],
  "catalysts":    [{ "text": "...", "refs": ["news.title"] }],
  "gaps":         ["无法确认的事"]
}
```

- `objective` 2–4 条，只陈述数据
- `judgement` 2–4 条，解释这些数据意味着什么
- `action` 0–3 条，verdict 是 avoid 时留空数组
- `risks` 1–3 条
- `gaps` 至少一条（你确实不知道的事）

## 不要给推荐的场景

- 池龄 < 48 小时且 TVL 仍在爬升（激励制造的假深度）
- fee APR > 300%（数字本身就是警告信号，不是卖点）
- 稳定对 APR < 8%（扣掉 gas 和管理成本后不如闲置）
- 数据不完整（confidence < 0.8）且无法补充
