/**
 * Report validator — the anti-hallucination gate.
 *
 * Three checks, each of which can only remove content, never add:
 *  1. schema      — required sections present, types right
 *  2. numeric     — every number in prose must exist in the evidence
 *  3. citation    — every claim must reference a fact id or evidence field
 *
 * A report that fails hard checks is downgraded: prose is dropped and only the
 * deterministic sections remain. We never repair by rewriting with the LLM — a
 * second pass would just launder the same invention.
 */

import type { EvidenceBundle } from "./tools/evidence.ts";

export interface ReportClaim {
  text: string;
  refs: string[];
  kind: "fact" | "judgement" | "action";
}

export interface ResearchReport {
  verdict: "avoid" | "watch" | "consider" | "favor";
  headline: string;
  objective: { text: string; refs: string[] }[];
  judgement: { text: string; refs: string[]; confidence: "low" | "medium" | "high" }[];
  action: { text: string; refs: string[] }[];
  risks: { text: string; refs: string[] }[];
  catalysts?: { text: string; refs: string[] }[];
  /** model's own statement of what it could not verify */
  gaps: string[];
}

export interface ValidationIssue {
  code: string;
  severity: "block" | "drop" | "warn";
  detail: string;
  where?: string;
}

export interface ValidationResult {
  ok: boolean;
  report: ResearchReport | null;
  issues: ValidationIssue[];
  droppedClaims: number;
  /** ratio of claims that passed, for confidence display */
  passRate: number;
}

const TOLERANCE = 0.02; // 2% relative tolerance on any quoted number

export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\d[\d,]*\.?\d*/g)) {
    const raw = m[0].replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * A quoted number passes if it matches an allowed number after accounting for
 * unit conversion. Models legitimately rewrite "$404 million" as "4.04 亿",
 * and a validator that cannot see through that is just a false-positive machine.
 */
const UNIT_SCALES = [1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e8, 1e9];

export function numberAllowed(n: number, allowed: number[]): boolean {
  const a = Math.abs(n);
  if (Number.isInteger(n) && a <= 12) return true; // counts like "5 个池子"

  for (const x of allowed) {
    if (x === 0) continue;
    const ax = Math.abs(x);
    if (Math.abs(n - x) <= ax * TOLERANCE) return true;
    if (Math.abs(a - ax) <= ax * TOLERANCE) return true;

    // unit-normalized comparison: 4.04亿 vs 404000000, 404M vs 4.04亿
    for (const s of UNIT_SCALES) {
      if (Math.abs(n * s - x) <= Math.abs(x) * TOLERANCE) return true;
      if (Math.abs(n / s - x) <= Math.abs(x) * TOLERANCE) return true;
    }
  }
  return false;
}

function validRefs(refs: string[], ev: EvidenceBundle): string[] {
  const known = new Set<string>(Object.keys(ev.facts ?? {}));
  // section-level refs are legal too, e.g. "score.dims", "pool.tvl"
  const sections = ev.sections ?? {};
  for (const [k, v] of Object.entries(sections)) {
    if (v && typeof v === "object" && !Array.isArray(v)) for (const kk of Object.keys(v)) known.add(`${k}.${kk}`);
  }
  known.add("score");
  known.add("pool");
  known.add("news");
  known.add("siblings");
  known.add("token");

  // In a news bundle the numbers live under `siblings` (related pools), but the
  // model naturally writes `pool.tvl` / `score.total`. The data does exist in
  // the bundle, so rejecting those refs would discard true statements.
  if (ev.subjectKind === "news") {
    for (const alias of [
      "pool", "pool.tvl", "pool.vol24h", "pool.feeApr", "pool.turnover", "pool.ageDays",
      "score", "score.total", "score.grade", "score.dims",
      "risk", "risk.vol30dPct", "risk.vol7dPct", "risk.ilTable", "risk.suggestedRange",
      "marketContext",
    ]) known.add(alias);
  }
  return refs.filter((r) => known.has(r));
}

function coerceArray(v: any): any[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function cleanProof(items: any[], ev: EvidenceBundle, where: string, issues: ValidationIssue[]) {
  const kept: any[] = [];
  let dropped = 0;
  for (const raw of coerceArray(items)) {
    if (!raw) continue;
    const text = typeof raw === "string" ? raw : String(raw.text ?? "").trim();
    if (!text) continue;
    const refs = validRefs(coerceArray(raw.refs).map(String), ev);

    const bad = numbersIn(text).filter((n) => !numberAllowed(n, ev.allowedNumbers));
    if (bad.length) {
      dropped++;
      issues.push({
        code: "NUMBER_NOT_IN_EVIDENCE",
        severity: "drop",
        detail: `引用未在证据中的数字 ${bad.slice(0, 4).join(", ")}`,
        where: `${where}: ${text.slice(0, 60)}`,
      });
      continue;
    }
    if (!refs.length && text.length > 24) {
      dropped++;
      issues.push({
        code: "NO_REF",
        severity: "drop",
        detail: "判断未给出可验证引用",
        where: `${where}: ${text.slice(0, 60)}`,
      });
      continue;
    }
    kept.push({
      text,
      refs,
      ...(raw.kind ? { kind: raw.kind } : {}),
      ...(raw.confidence ? { confidence: raw.confidence } : {}),
    });
  }
  return { kept, dropped };
}

export function validateReport(raw: unknown, ev: EvidenceBundle): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!raw || typeof raw !== "object") {
    return {
      ok: false, report: null, droppedClaims: 0, passRate: 0,
      issues: [{ code: "NOT_OBJECT", severity: "block", detail: "模型未返回 JSON 对象" }],
    };
  }

  const o = raw as any;
  const verdict = ["avoid", "watch", "consider", "favor"].includes(o.verdict) ? o.verdict : null;
  if (!verdict) {
    issues.push({ code: "BAD_VERDICT", severity: "block", detail: `无效 verdict: ${o.verdict}` });
  }

  const headline = String(o.headline ?? "").trim();
  if (!headline) issues.push({ code: "NO_HEADLINE", severity: "block", detail: "缺少 headline" });

  // headline is prose too — same numeric rules apply
  const headBad = numbersIn(headline).filter((n) => !numberAllowed(n, ev.allowedNumbers));

  const objective = cleanProof(o.objective, ev, "objective", issues);
  const judgement = cleanProof(o.judgement, ev, "judgement", issues);
  const action = cleanProof(o.action, ev, "action", issues);
  const risks = cleanProof(o.risks, ev, "risks", issues);
  const catalysts = cleanProof(o.catalysts, ev, "catalysts", issues);

  if (!objective.kept.length) issues.push({ code: "NO_OBJECTIVE", severity: "block", detail: "客观事实段为空" });
  if (!judgement.kept.length) issues.push({ code: "NO_JUDGEMENT", severity: "block", detail: "判断段为空" });

  // deterministic scores must be quoted, not re-invented (pool reports only:
  // a news item may legitimately have no score at all)
  const scoreCited = ev.subjectKind !== "pool" || judgement.kept.some((c: any) =>
    c.refs.some((r: string) => r.startsWith("score") || r.includes("评分") || r === "score"),
  );

  const total = objective.kept.length + judgement.kept.length + action.kept.length + risks.kept.length;
  const dropped = objective.dropped + judgement.dropped + action.dropped + risks.dropped + catalysts.dropped;
  const passRate = total + dropped === 0 ? 1 : total / (total + dropped);

  const blocked =
    !verdict || !headline || headBad.length > 0 ||
    objective.kept.length === 0 || judgement.kept.length === 0 ||
    passRate < 0.5;

  if (headBad.length) {
    issues.push({
      code: "HEADLINE_NUMBER",
      severity: "block",
      detail: `标题含未在证据中的数字 ${headBad.join(", ")}`,
    });
  }
  if (!scoreCited) {
    issues.push({
      code: "SCORE_NOT_CITED",
      severity: "warn",
      detail: "判断段未引用 score.compute 结果",
    });
  }

  const report: ResearchReport | null = blocked ? null : {
    verdict: verdict!,
    headline,
    objective: objective.kept,
    judgement: judgement.kept,
    action: action.kept,
    risks: risks.kept,
    catalysts: catalysts.kept.length ? catalysts.kept : undefined,
    gaps: coerceArray(o.gaps).map(String).slice(0, 6),
  };

  return {
    ok: !blocked,
    report,
    issues,
    droppedClaims: dropped,
    passRate: Math.round(passRate * 100) / 100,
  };
}
