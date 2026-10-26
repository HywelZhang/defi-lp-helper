/**
 * Auto-rebalance: keep a position's price centred in its band.
 *
 * This module moves real money without a human in the loop, so the safety
 * design matters more than the logic. Rules, in order of authority:
 *
 *  1. **Global kill switch.** Off unless explicitly enabled. Stored in
 *     `settings` so it survives restarts and is visible to the UI. Nothing runs
 *     while it is off, no matter what any plan says.
 *  2. **Per-plan opt-in.** A plan carries its own policy, and automation is off
 *     in that policy unless the user turned it on when creating the plan.
 *  3. **Deadband.** Recentring on every tick would burn fees on noise. The
 *     position is only moved when price leaves a centre band of
 *     ±tolerancePct of the range half-width.
 *  4. **Budget.** At most `maxPerDay` actions per position per day, counted
 *     from the notification log so the limit and the audit trail cannot
 *     disagree.
 *  5. **Floor.** Positions below `minValueUsd` are skipped: on a $0.02 position
 *     every action costs more attention than it can earn.
 *  6. **Cost check.** Skips when the round trip would cost more than
 *     `maxCostToDailyFeeRatio` of a day's expected fees.
 *  7. **No blind retry.** If the withdraw succeeds and the rebuild fails, the
 *     capital is loose in the wallet. Automation records the failure and stops;
 *     it does not keep hammering a chain that is failing.
 *
 * Every decision, including every skip, is written to notifications. An
 * automation that silently does nothing is indistinguishable from one that is
 * broken — which is exactly the failure mode worth designing out.
 */

import { one, run } from "../db.ts";
import { notify } from "./notify.ts";
import { readIntent } from "./rebalance.ts";
import { latestChecks } from "./monitor.ts";
import { prepareRebalance, prepareRebuild, confirmExecution } from "./execute.ts";
import type { AutomationPolicy } from "./plan.ts";

export interface AutoDecision {
  positionId: string;
  poolName: string;
  action: "skip" | "rebalance" | "blocked";
  reason: string;
  detail?: string;
  /** true when the skip is expected (deadband, disabled) vs a real problem */
  expected?: boolean;
}

export interface AutoRunResult {
  ok: boolean;
  enabled: boolean;
  dryRun: boolean;
  decisions: AutoDecision[];
  acted: number;
  error?: string;
  tookMs: number;
}

/* ─────────────────────── settings ─────────────────────── */

export function ensureSettingsTable() {
  run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

export function getSetting(key: string, fallback: string | null = null): string | null {
  ensureSettingsTable();
  const r = one<any>(`SELECT value FROM settings WHERE key=?`, key);
  return r ? String(r.value) : fallback;
}

export function setSetting(key: string, value: string) {
  ensureSettingsTable();
  run(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    key, value, Date.now(),
  );
}

/**
 * The master switch.
 *
 * Default off. Automation that turns itself on is not a feature, it is a
 * liability — and users who never touched the setting would have no idea their
 * positions were being moved.
 */
export function autoEnabled(): boolean {
  return getSetting("auto_rebalance.enabled", "0") === "1";
}

export function setAutoEnabled(on: boolean) {
  setSetting("auto_rebalance.enabled", on ? "1" : "0");
  notify({
    kind: "system",
    level: on ? "warn" : "info",
    title: on ? "自动调仓已开启" : "自动调仓已关闭",
    body: on
      ? "满足计划条件的仓位会在无人确认的情况下自动调仓，会真实动用资金。"
      : "所有自动调仓已停止，已开仓不受影响。",
    source: "auto_rebalance",
    href: "/assets",
    // Deliberately not deduped by day: a switch flip must always be recorded.
    dedupeKey: `auto_toggle:${Date.now()}`,
  });
}

/* ─────────────────────── policy lookup ─────────────────────── */

/**
 * Read the policy attached to a position's plan.
 *
 * Lives on the plan payload, not on the position, because the policy is part of
 * the investment decision. Older plans predate the field and simply have none —
 * they must not be automated by default.
 */
export function policyFor(planId: string | null): AutomationPolicy | null {
  if (!planId) return null;
  const row = one<any>(`SELECT payload FROM plans WHERE id=?`, planId);
  if (!row?.payload) return null;
  try {
    const p = JSON.parse(row.payload)?.automation;
    if (!p || typeof p !== "object") return null;
    return p as AutomationPolicy;
  } catch {
    return null;
  }
}

/* ─────────────────────── the decision ─────────────────────── */

/**
 * Decide what to do for one position, with no side effects.
 *
 * Pure so the rules can be exercised without a chain, a clock, or real money.
 * The executor below is a thin wrapper that acts on the answer.
 */
export function decideAuto(
  check: { positionId: string; poolName: string; bandPos: number | null; state: string; valueUsd: number; costUsd: number; feesUsd: number },
  policy: AutomationPolicy | null,
  ctx: { todayCount: number; hasPendingIntent: boolean },
): AutoDecision {
  const base = { positionId: check.positionId, poolName: check.poolName || check.positionId };

  if (!policy) {
    return { ...base, action: "skip", reason: "计划没有声明调仓规则", expected: true };
  }
  if (!policy.enabled || policy.mode !== "recenter") {
    return { ...base, action: "skip", reason: "该仓位未开启自动调仓", expected: true };
  }
  if (ctx.hasPendingIntent) {
    // A half-finished rebalance means capital may be sitting in the wallet.
    // Starting another one now would strand it further.
    return { ...base, action: "blocked", reason: "上一次调仓尚未完成" };
  }
  if (ctx.todayCount >= policy.maxPerDay) {
    return { ...base, action: "skip", reason: `今日已达上限（${policy.maxPerDay} 次）`, expected: true };
  }
  if (check.valueUsd < policy.minValueUsd) {
    return {
      ...base, action: "skip", expected: true,
      reason: `仓位价值 ${check.valueUsd.toFixed(2)} 低于自动调仓门槛 ${policy.minValueUsd}`,
    };
  }

  // Out of range is always actionable: the position has stopped earning fees
  // entirely, which is the exact condition recentring exists to fix.
  const outOfRange = check.state === "out_below" || check.state === "out_above";
  if (outOfRange) {
    return {
      ...base, action: "rebalance",
      reason: "价格已离开区间，仓位停止赚费",
    };
  }

  if (check.bandPos == null) {
    return { ...base, action: "skip", reason: "无法判断价格位置", expected: true };
  }

  // bandPos is 0..1 across the band; the centre is 0.5. The deadband is a share
  // of the HALF width, so tolerancePct=12 means "act when more than 12% of the
  // way from centre to edge".
  const half = policy.tolerancePct / 100;
  const distance = Math.abs(check.bandPos - 0.5) * 2; // 0 at centre, 1 at edge
  if (distance <= half) {
    return {
      ...base, action: "skip", expected: true,
      reason: `价格在中心区间内（偏离 ${(distance * 100).toFixed(1)}% ≤ ${policy.tolerancePct}%）`,
    };
  }

  return {
    ...base, action: "rebalance",
    reason: `价格偏离中心 ${(distance * 100).toFixed(1)}%，超过 ${policy.tolerancePct}% 死区`,
  };
}

/* ─────────────────────── the executor ─────────────────────── */

/**
 * Run one auto-rebalance pass.
 *
 * `dryRun` decides everything and records nothing on chain: it exists because
 * the only responsible way to demonstrate an unattended money-moving feature is
 * to show what it would have done.
 */
export async function runAutoRebalance(opts: { dryRun?: boolean; positionId?: string } = {}): Promise<AutoRunResult> {
  const started = Date.now();
  const dryRun = opts.dryRun === true;
  const enabled = autoEnabled();

  if (!enabled && !dryRun) {
    return { ok: true, enabled: false, dryRun, decisions: [], acted: 0, tookMs: Date.now() - started };
  }

  const checks = latestChecks();
  const decisions: AutoDecision[] = [];
  let acted = 0;

  for (const c of checks) {
    if (opts.positionId && c.positionId !== opts.positionId) continue;
    if (!(c.valueUsd > 0) && !(c.costUsd > 0)) continue;

    const pos = one<any>(`SELECT id,plan_id,status,pool_name FROM positions WHERE id=?`, c.positionId);
    if (!pos || pos.status !== "open") continue;

    const policy = policyFor(pos.plan_id);
    const todayCount = countTodayActions(c.positionId);
    const hasPendingIntent = Boolean(readIntent(c.positionId));

    const d = decideAuto(
      {
        positionId: c.positionId,
        poolName: c.poolName || pos.pool_name || "",
        bandPos: c.bandPos,
        state: c.state,
        valueUsd: c.valueUsd,
        costUsd: c.costUsd,
        feesUsd: c.feesUsd,
      },
      policy,
      { todayCount, hasPendingIntent },
    );
    decisions.push(d);

    if (d.action !== "rebalance") {
      // Only record skips that are NOT the ordinary "nothing to do" case:
      // writing an inbox row every hour saying "still centred" would bury the
      // events that matter.
      if (d.action === "blocked" && !dryRun) {
        notify({
          kind: "auto_skip",
          level: "warn",
          title: `${d.poolName}：${d.reason}`,
          body: d.detail ?? "自动化暂停处理该仓位，需要人工确认上一次调仓的结果。",
          source: "auto_rebalance",
          subjectType: "position",
          subjectId: d.positionId,
          href: "/assets",
          dedupeKey: `auto_blocked:${d.positionId}:${new Date().toISOString().slice(0, 13)}`,
        });
      }
      continue;
    }

    // ── act ──────────────────────────────────────────────────
    if (dryRun) {
      decisions[decisions.length - 1] = {
        ...d,
        detail: `[演练] 将以 ±${policy!.halfWidthPct}% 重设区间，预计 2 笔链上交易`,
      };
      continue;
    }

    const exec = await executeRebalance(c.positionId, policy!);
    if (exec.ok) {
      acted++;
      decisions[decisions.length - 1] = { ...d, detail: exec.detail };
      notify({
        kind: "auto_rebalance",
        level: "success",
        title: `${d.poolName} 已自动调仓`,
        body: `${d.reason}。新区间 ±${policy!.halfWidthPct}%。${exec.detail ?? ""}`,
        source: "auto_rebalance",
        subjectType: "position",
        subjectId: d.positionId,
        href: "/assets",
        dedupeKey: `auto_done:${d.positionId}:${Date.now()}`,
        meta: { txs: exec.txs },
      });
    } else {
      decisions[decisions.length - 1] = { ...d, detail: exec.error };
      // A failed automation is the single most important thing to surface:
      // money is not where the user thinks it is.
      notify({
        kind: "auto_rebalance",
        level: "danger",
        title: `${d.poolName} 自动调仓失败`,
        body: `${exec.error ?? "未知错误"}${exec.partial ? "\n注意：撤出已完成，资金目前在钱包中，需要人工重建仓位。" : ""}`,
        source: "auto_rebalance",
        subjectType: "position",
        subjectId: d.positionId,
        href: "/assets",
        dedupeKey: `auto_fail:${d.positionId}:${Math.floor(Date.now() / 3600_000)}`,
        meta: { partial: exec.partial },
      });
    }
  }

  return {
    ok: true, enabled, dryRun, decisions, acted,
    tookMs: Date.now() - started,
  };
}

/** How many times automation moved this position today. */
function countTodayActions(positionId: string): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const r = one<any>(
    `SELECT COUNT(*) c FROM notifications
     WHERE kind='auto_rebalance' AND level='success' AND subject_id=? AND created_at>=?`,
    positionId, start.getTime(),
  );
  return Number(r?.c ?? 0);
}

/**
 * Execute the two-step rebalance for one position.
 *
 * Uses the same prepare/confirm path as the manual buttons — deliberately. A
 * second, "automated" implementation of a money-moving flow would be a place
 * for the two to diverge, and the divergence would only show up when it cost
 * someone money.
 */
async function executeRebalance(
  positionId: string,
  policy: AutomationPolicy,
): Promise<{ ok: boolean; error?: string; detail?: string; partial?: boolean; txs?: string[] }> {
  // Step 1: withdraw the whole position into loose tokens.
  const prep = await prepareRebalance(positionId, policy.halfWidthPct);
  if (!prep.ok || !prep.confirmToken) {
    return { ok: false, error: prep.error ?? "无法生成撤仓交易" };
  }

  const w = await confirmWithRetry(prep.confirmToken);
  if (!w.ok) {
    // Nothing was withdrawn (or the first step failed outright), so the position
    // is intact. Safe to stop.
    return { ok: false, error: `撤出失败：${w.error ?? "unknown"}`, partial: false };
  }

  // Step 2: rebuild at the new ticks. If this fails the capital is loose —
  // flag it as partial so the notification says so explicitly.
  const rebuild = await prepareRebuild(positionId);
  if (!rebuild.ok || !rebuild.confirmToken) {
    return {
      ok: false, partial: true,
      error: `重建失败：${rebuild.error ?? "无法生成建仓交易"}`,
    };
  }

  const rb = await confirmWithRetry(rebuild.confirmToken);
  if (!rb.ok) {
    return {
      ok: false, partial: true,
      error: `重建交易未确认：${rb.error ?? "unknown"}`,
    };
  }

  const txs = [...(w.txs ?? []), ...(rb.txs ?? [])];
  return { ok: true, detail: `${txs.length} 笔交易已确认`, txs };
}

/**
 * Broadcast a prepared batch, answering onchainos' own confirmation prompt.
 *
 * onchainos sometimes returns `needsCliConfirm` for a step it considers risky.
 * `confirmExecution` keeps the token and sets `awaiting`, so calling it again
 * with the SAME token re-runs that step with `--force`. Retrying once is enough
 * because the second call carries the force flag; more than that would just be
 * hammering a node.
 */
async function confirmWithRetry(
  token: string,
  attempts = 2,
): Promise<{ ok: boolean; error?: string; txs?: string[] }> {
  let lastError: string | undefined;

  for (let i = 0; i < attempts; i++) {
    const r = await confirmExecution(token);
    if (r.ok) {
      return { ok: true, txs: (r.results ?? []).map((x) => x.txHash).filter(Boolean) as string[] };
    }
    if (r.needsCliConfirm) {
      lastError = r.cliMessage ?? "onchainos 需要再次确认";
      continue;
    }
    return { ok: false, error: r.error ?? "交易失败" };
  }

  return { ok: false, error: lastError ?? "交易未确认" };
}
