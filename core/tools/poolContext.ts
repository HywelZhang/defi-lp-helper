/**
 * Pool-scoped context for the assistant.
 *
 * The generic context in assistant.ts summarises the book: positions, plans,
 * feed, watchlist. It deliberately does not include every pool ever viewed — that
 * would be thousands of tokens for data the user is not asking about.
 *
 * But when someone asks from inside a pool drawer ("现在这个波动水平下还值得进吗"),
 * the answer must be grounded in that exact pool. Without this block the model
 * would answer from the generic summary and, at best, hedge.
 *
 * Numbers here are copied verbatim from poolDetail/computeScore — the same calls
 * the drawer renders from — so the reply and the screen cannot disagree.
 */

import { poolDetail } from "./pools.ts";
import { computeScore } from "./score.ts";
import { fmtUsd, fmtPct } from "../util.ts";

export interface PoolContextResult {
  ok: boolean;
  error?: string;
  /** one-line label safe for a chat session title */
  title?: string;
  text?: string;
}

function n(v: unknown, digits = 2, suffix = ""): string {
  const x = Number(v);
  if (!Number.isFinite(x)) return "未知";
  return `${x.toFixed(digits)}${suffix}`;
}

export async function buildPoolContext(chain: string, address: string): Promise<PoolContextResult> {
  const d = await poolDetail(chain, address);
  if (!d.ok || !d.data) return { ok: false, error: d.degradedReason ?? "池子数据不可用" };

  const p: any = d.data;
  const score = computeScore(p, { capitalUsd: 2000, riskTier: 2 });

  const title = `${p.baseSymbol} / ${p.quoteSymbol}${p.feeTierPct != null ? ` ${p.feeTierPct}%` : ""}`;

  const dims = score.dims
    .map((x) => `  - ${x.label}: ${x.score}/100（权重 ${(x.weight * 100).toFixed(0)}%）`)
    .join("\n");

  const gates = score.gates.length
    ? score.gates
      .map((g) => `  - ${g.blocked ? "✗" : "✓"} ${g.label}（${g.severity === "block" ? "硬门槛" : "提示"}）：${g.detail}`)
      .join("\n")
    : "  - 无门槛检查项";

  const reasons = score.reasons.length ? score.reasons.map((x) => `  - ${x}`).join("\n") : "  - 无";
  const risks = score.risks.length ? score.risks.map((x) => `  - ${x}`).join("\n") : "  - 无";

  const text = [
    `## 用户当前正在查看的池子`,
    `名称: ${p.name}`,
    `链: ${p.chain} · DEX: ${p.dex} · 地址: ${p.address}`,
    `代币对: ${p.baseSymbol} / ${p.quoteSymbol} · 费率档: ${p.feeTierPct != null ? `${p.feeTierPct}%` : "未知"}`,
    ``,
    `### 客观数据（来自 GeckoTerminal，与页面显示一致）`,
    `- TVL: ${fmtUsd(Number(p.tvlUsd) || 0, 0)}`,
    `- 24h 成交: ${fmtUsd(Number(p.vol24hUsd) || 0, 0)}`,
    `- fee APR（估算）: ${p.feeAprPct != null ? `${Number(p.feeAprPct).toFixed(2)}%` : "未知"}`,
    `- 换手率: ${p.turnover != null ? `${Number(p.turnover).toFixed(3)}x` : "未知"}`,
    `- 池龄: ${p.ageDays != null ? `${Number(p.ageDays).toFixed(0)} 天` : "未知"}`,
    `- 当前价格: ${p.priceUsd != null ? Number(p.priceUsd).toPrecision(6) : "未知"}`,
    `- 24h 涨跌: ${p.priceChange24h != null ? fmtPct(Number(p.priceChange24h), 2) : "未知"}`,
    ``,
    `### 确定性评分（computeScore，非模型生成）`,
    `- 总分: ${score.total}（${score.grade}）· 置信度: ${score.confidence}`,
    ...dims.split("\n"),
    ``,
    `### 硬门槛`,
    gates,
    ``,
    `### 判断理由`,
    reasons,
    ``,
    `### 风险`,
    risks,
    ``,
    `回答时请针对这个池子，不要泛泛而谈。用户在页面下方提问，问题可能很短，` +
    `请结合上面数据给出直接结论；数据不足时说明缺什么，不要猜测。`,
  ].join("\n");

  return { ok: true, title, text };
}
