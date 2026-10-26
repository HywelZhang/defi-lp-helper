---
name: defi-lp-news
description: Interpret a crypto news item for LP implications — separate what happened from what it means for liquidity positions. Use when a user clicks "AI 解读" on a news card or asks what a headline means for their LP portfolio.
---

# 新闻的 LP 视角解读

新闻解读的价值不在于复述标题，而在于回答一个问题：**这件事对 LP 仓位意味着什么？** 如果答不上来，就诚实说无关。

## 铁律

1. 不复述新闻。用户已经看过标题了。
2. 区分**已发生的事实**和**推测的影响**，分段落写，不许混。
3. 没有可操作含义就说没有。绝大多数新闻对 LP 没有直接影响，硬扯关联是最常见的失败模式。
4. 涉及具体 token 时，只能引用证据包里给出的池子数据，不得凭记忆补数据。

## 判断框架

按这个顺序逐层判断，命中即停：

### 1. 直接影响（有具体 token + 有池子数据）
新闻提到的 token 在证据包里有池子。要回答：
- 哪些池子受影响（给出名字）
- 影响路径（流动性撤离？成交量放大？价格单边？）
- 需要做什么（减仓？观望？加仓？）

### 2. 间接影响（有 token 但无池子数据）
该 token 属于什么赛道，同赛道是否有持仓。要回答：赛道层面的含义，不给具体操作。

### 3. 市场结构影响（宏观、监管、协议层）
影响全局风险偏好，不针对具体池子。给出"这意味着风险偏好上升/下降"这类判断，并说明依据。

### 4. 无关联
坦白说明这条新闻与 LP 无关。这是最常见的正确答案。

## 严重性分级

- **critical**：脱锚、协议被攻击、交易暂停、监管禁令 → 立刻检查相关仓位
- **high**：大额清算、巨鲸移动、协议重大升级 → 24 小时内关注
- **medium**：赛道级消息、融资、合作 → 记录，不影响操作
- **low**：观点文章、人事变动、无关科技新闻 → 无需行动

## 输出结构

严格按此 JSON 输出，不要 markdown 围栏：

```json
{
  "verdict": "avoid|watch|consider|favor",
  "headline": "一句话：这件事对你意味着什么（不是新闻标题的复述）",
  "objective":    [{ "text": "发生了什么（只陈述事实）", "refs": ["news.title"] }],
  "judgement":    [{ "text": "对 LP 的含义", "refs": ["news.title"], "confidence": "low|medium|high" }],
  "action":       [{ "text": "具体要做什么，或明确写无需行动", "refs": ["siblings"] }],
  "risks":        [{ "text": "如果判断错了会怎样", "refs": ["news.title"] }],
  "catalysts":    [{ "text": "后续值得盯的信号", "refs": ["news.title"] }],
  "gaps":         ["无法确认的事"]
}
```

### verdict 在新闻语境下的含义

- `avoid`：有明确负面含义，相关仓位应减或退
- `watch`：有潜在影响，暂不行动但要盯
- `consider`：有正面机会，值得进一步调研具体池子
- `favor`：罕见的强信号，可以直接进入计划流程

大部分新闻应该是 `watch` 或明确指出"无关联"（此时 verdict 填 `watch`，action 写"无需行动"）。

## 常见错误

- **硬扯关联**：把"某交易所上线新币"说成对 LP 有影响，除非真的说明了流动性路径
- **复述标题**：headline 和新闻标题几乎一样，等于没解读
- **编造数据**：凭记忆说出某个池子的 TVL，而证据包里没有
- **过度乐观**：把中性消息解读成利好，这在 LP 场景下会导致错误加仓
