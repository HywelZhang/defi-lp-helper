/**
 * Research pipeline: evidence → skill prompt → LLM → validator → cache.
 *
 * The invariant this file enforces: the LLM never invents a number, and a
 * report that fails validation is *downgraded*, never repaired. A degraded
 * report still shows the deterministic score and facts — the user always gets
 * something true, sometimes less of it.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chat } from "./llm.ts";
import { buildPoolEvidence, buildNewsEvidence, type EvidenceBundle } from "./tools/evidence.ts";
import { validateReport, type ResearchReport, type ValidationResult } from "./validator.ts";
import { sha, fmtUsd, fmtPct } from "./util.ts";
import { one, run } from "./db.ts";

const SKILLS_DIR = resolve(new URL("../skills", import.meta.url).pathname);

export interface ResearchResult {
  ok: boolean;
  subjectKind: "pool" | "news";
  subjectId: string;
  subjectLabel: string;
  /** deterministic facts, always present */
  evidence: EvidenceBundle | null;
  report: ResearchReport | null;
  validation: ValidationResult | null;
  degraded: boolean;
  degradeReason?: string;
  cached: boolean;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  tookMs: number;
  cacheKey: string;
}

function loadSkill(name: string): { text: string; version: string } {
  const p = resolve(SKILLS_DIR, name, "SKILL.md");
  if (!existsSync(p)) return { text: "", version: "missing" };
  const text = readFileSync(p, "utf8");
  return { text, version: sha(text, 12) };
}

/** Compact, token-bounded rendering of evidence for the prompt. */
function renderEvidence(ev: EvidenceBundle): string {
  const s = ev.sections;
  const lines: string[] = [];

  lines.push(`## 研究对象\n${ev.subjectLabel} (${ev.subjectId})`);

  if (s.pool) {
    const p = s.pool;
    lines.push(
      `\n## 池子客观数据
- DEX: ${p.dex}
- TVL: ${p.tvl}
- 24h 成交: ${p.vol24h}
- fee APR（估算上限）: ${p.feeApr}
- 换手率: ${p.turnover}
- 池龄: ${p.ageDays ?? "未知"} 天
- 费率档: ${p.feeTier ?? "未知"}%
- 当前价: ${p.price}
- 24h 涨跌: ${p.change24h}
- 72h 数据点: ${p.seriesPoints}`,
    );
  }

  if (s.token) {
    lines.push(`\n## 基础资产
- 符号: ${s.token.symbol} (${s.token.name})
- 价格: ${s.token.price}
- FDV: ${s.token.fdv}
- 市值: ${s.token.mcap}
- 24h 成交: ${s.token.vol24h}`);
  }

  if (s.score) {
    lines.push(`\n## 确定性评分（score.compute，不可改写）
- 总分: ${s.score.total} / 100
- 评级: ${s.score.grade}
- 置信度: ${s.score.confidence}
- 权重版本: ${s.score.weightsVersion}`);
    lines.push("\n### 维度");
    for (const d of s.score.dims) lines.push(`- ${d.label}: ${d.score} 分 (权重 ${d.weight}) — ${d.note}`);
    lines.push("\n### 门槛判定");
    for (const g of s.score.gates) {
      lines.push(`- [${g.blocked ? (g.severity === "block" ? "未通过" : "警告") : "通过"}] ${g.label}: ${g.detail}`);
    }
    lines.push("\n### 系统给出的理由（可引用，不可改写数字）");
    for (const r of s.score.reasons) lines.push(`- ${r}`);
    if (s.score.risks.length) {
      lines.push("\n### 系统识别的风险");
      for (const r of s.score.risks) lines.push(`- ${r}`);
    }
  }

  if (s.siblings?.length) {
    lines.push("\n## 同 token 其他池（对比用）");
    for (const x of s.siblings) lines.push(`- ${x.name}: TVL ${x.tvl}, fee APR ${x.feeApr}, 换手 ${x.turnover}`);
  }

  if (s.risk) {
    const r = s.risk;
    lines.push(`\n## 风险量化（确定性计算，可引用）
- 30d 年化波动率: ${r.vol30dPct ?? "未知"}%
- 7d 年化波动率: ${r.vol7dPct ?? "未知"}%
- 当前价在 30d 区间的百分位: ${r.pricePercentile ?? "未知"}%
- 价格偏离 30d 均值: ${r.deviationFromMeanPct ?? "未知"}%
- 持有期假设: ${r.rangeWindowDays} 天`);

    if (r.suggestedRange) {
      lines.push(`- 建议区间（覆盖概率 ≥70%）: 下界 -${r.suggestedRange.downPct}% / 上界 +${r.suggestedRange.upPct}%，该宽度覆盖概率 ${r.suggestedRange.coverage}%`);
    }

    lines.push("\n### 不同区间宽度的覆盖概率（持有 " + r.rangeWindowDays + " 天）");
    for (const c of r.coverageAt) lines.push(`- ±${c.width}%: ${c.prob ?? "未知"}%`);

    lines.push("\n### 无常损失对照表（v2 基准，V3 集中仓位会放大）");
    for (const x of r.ilTable) lines.push(`- 价格变动 ${x.movePct > 0 ? "+" : ""}${x.movePct}%: IL ${x.ilPct}%`);

    lines.push(`\n### 仓位约束
- 分析本金: ${fmtUsd(r.capitalUsd)}
- 单仓上限（TVL 的 1/20）: ${fmtUsd(r.maxPositionUsd)}`);
  }

  if (s.news) {
    const n = s.news;
    lines.push(`\n## 新闻
- 标题: ${n.title}
- 来源: ${n.source}
- 摘要: ${n.summary}
- 涉及实体: ${n.entities.join(", ") || "无"}
- 命中关注: ${n.matched.join(", ") || "无"}
- 其他报道源: ${n.alsoCoveredBy.join(", ") || "无"}`);
  }

  lines.push(`\n## 允许引用的数字（超出此范围的数字一律不得出现）
${ev.allowedNumbers.map((n) => (Math.abs(n) >= 1000 ? Math.round(n) : n)).join(", ")}`);

  lines.push(`\n## 可用的 ref 名称（放在 refs 数组里）
${Object.keys(ev.facts).join(", ")}, score.total, score.grade, score.confidence, score.dims, score.gates, pool.tvl, pool.vol24h, pool.feeApr, pool.turnover, pool.ageDays, risk.vol30dPct, risk.vol7dPct, risk.suggestedRange, risk.ilTable, risk.maxPositionUsd, news.title, siblings`);

  return lines.join("\n");
}

const OUTPUT_CONTRACT = `你必须只返回一个 JSON 对象，结构如下（不要 markdown 代码块）：

{
  "verdict": "avoid" | "watch" | "consider" | "favor",
  "headline": "一句话结论，可含数字但必须是证据中出现的数字",
  "objective": [ { "text": "客观事实，只陈述数据", "refs": ["pool.tvl"] } ],
  "judgement": [ { "text": "你的判断，必须引用数据", "refs": ["score.total"], "confidence": "low|medium|high" } ],
  "action":   [ { "text": "如果要做，具体怎么做（区间、金额、条件）", "refs": ["pool.feeApr"] } ],
  "risks":    [ { "text": "风险，必须具体到数据", "refs": ["score.dims"] } ],
  "catalysts":[ { "text": "可选：可能改变结论的事件", "refs": ["news.title"] } ],
  "gaps":     [ "你无法从证据中确认的事情" ]
}

硬性规则：
1. 任何数字必须出现在上面「允许引用的数字」中，或由它们直接算出（如百分比差）。
2. 每条 objective/judgement/action/risks 至少给一个 refs。
3. 不许使用「表现良好」「值得关注」这类无数据的空话。
4. verdict 必须与确定性评分一致：评分 < 50 不得给 favor；有硬门槛未通过只能给 avoid 或 watch。
5. judging 段不得改写 score.total 的数值。
6. 保持简洁：objective 2-3 条，judgement 2-3 条，action 0-2 条，risks 1-2 条，每条不超过 60 字。总输出必须完整闭合的 JSON。`;

async function callModel(ev: EvidenceBundle, skill: { text: string; version: string }, opts: any) {
  const system = `${skill.text}

---
# 当前任务

你是一名 LP 投资研究员。基于下面的证据包，输出一份结构化调研报告。

${OUTPUT_CONTRACT}`;

  const user = renderEvidence(ev);

  return chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      json: true,
      temperature: 0.15,
      // 2200 was not enough: the model hit the cap mid-JSON and returned
      // unparseable text. Budget for the full contract plus Chinese verbosity.
      maxTokens: opts.maxTokens ?? 4000,
      timeoutMs: opts.timeoutMs ?? 150_000,
    },
  );
}

export async function research(
  kind: "pool" | "news",
  id: string,
  opts: { capitalUsd?: number; riskTier?: 1 | 2 | 3; force?: boolean; ttlHours?: number } = {},
): Promise<ResearchResult> {
  const started = Date.now();

  const skill = loadSkill(kind === "pool" ? "defi-lp-research" : "defi-lp-news");

  // ---- evidence ----
  const ev = kind === "pool"
    ? await buildPoolEvidence(id.split(":")[0], id.split(":")[1], opts)
    : await buildNewsEvidence(id);

  if ("error" in ev) {
    return {
      ok: false, subjectKind: kind, subjectId: id, subjectLabel: id,
      evidence: null, report: null, validation: null,
      degraded: true, degradeReason: ev.error, cached: false,
      tookMs: Date.now() - started, cacheKey: "",
    };
  }

  const evidenceHash = sha(JSON.stringify(ev.allowedNumbers) + JSON.stringify(ev.sections), 16);
  const cacheKey = sha(`${kind}|${id}|${evidenceHash}|${skill.version}|${opts.capitalUsd ?? 2000}|${opts.riskTier ?? 2}`, 24);

  // ---- cache ----
  const ttl = (opts.ttlHours ?? 6) * 3600_000;
  if (!opts.force) {
    const hit = one<any>(`SELECT * FROM analyses WHERE cache_key = ?`, cacheKey);
    if (hit && Date.now() - hit.created_at < ttl) {
      return {
        ok: true, subjectKind: kind, subjectId: id, subjectLabel: ev.subjectLabel,
        evidence: ev,
        report: JSON.parse(hit.report),
        validation: null,
        degraded: Boolean(hit.degraded),
        degradeReason: hit.degrade_reason ?? undefined,
        cached: true,
        model: hit.model,
        tokensIn: hit.tokens_in,
        tokensOut: hit.tokens_out,
        tookMs: Date.now() - started,
        cacheKey,
      };
    }
  }

  // ---- model ----
  const llm = await callModel(ev, skill, opts);

  if (!llm.ok) {
    return {
      ok: false, subjectKind: kind, subjectId: id, subjectLabel: ev.subjectLabel,
      evidence: ev, report: null, validation: null,
      degraded: true, degradeReason: `LLM: ${llm.error}`,
      cached: false, tookMs: Date.now() - started, cacheKey,
    };
  }

  // ---- validate ----
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(llm.text);
  } catch {
    const m = llm.text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* stays null */ } }
  }

  const validation = validateReport(parsed, ev);

  if (validation.ok && validation.report) {
    run(
      `INSERT OR REPLACE INTO analyses
       (cache_key,subject_type,subject_id,skill_version,evidence_version,status,report,model,tokens_in,tokens_out,created_at,degraded)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`,
      cacheKey, kind, id, skill.version, ev.version, "ok",
      JSON.stringify(validation.report), llm.model, llm.tokensIn, llm.tokensOut, Date.now(),
    );
  } else {
    // keep the failure for debugging, but never serve it
    run(
      `INSERT OR REPLACE INTO analyses
       (cache_key,subject_type,subject_id,skill_version,evidence_version,status,report,model,tokens_in,tokens_out,created_at,degraded,degrade_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      cacheKey, kind, id, skill.version, ev.version, "invalid",
      JSON.stringify({ issues: validation.issues, raw: llm.text.slice(0, 2000) }),
      llm.model, llm.tokensIn, llm.tokensOut, Date.now(),
      validation.issues.map((i) => i.code).join(","),
    );
  }

  return {
    ok: validation.ok,
    subjectKind: kind,
    subjectId: id,
    subjectLabel: ev.subjectLabel,
    evidence: ev,
    report: validation.report,
    validation,
    degraded: !validation.ok || ev.degraded,
    degradeReason: !validation.ok
      ? `报告未通过校验（${validation.issues.map((i) => i.code).join(", ")}）`
      : ev.degradedReason,
    cached: false,
    model: llm.model,
    tokensIn: llm.tokensIn,
    tokensOut: llm.tokensOut,
    tookMs: Date.now() - started,
    cacheKey,
  };
}
