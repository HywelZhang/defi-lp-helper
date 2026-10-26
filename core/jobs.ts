/**
 * In-process job registry for research runs.
 *
 * A research call takes 15-25s (LLM). Holding an HTTP request open that long
 * makes the drawer feel broken and burns through proxy timeouts, so the client
 * starts a job and polls. Jobs are intentionally not persisted: a page reload
 * mid-analysis just re-runs (results are cached by evidence hash anyway).
 */

import { research, type ResearchResult } from "./research.ts";
import { recordSpend } from "./auth.ts";

export interface ResearchJob {
  id: string;
  kind: "pool" | "news";
  subjectId: string;
  status: "running" | "ok" | "error";
  startedAt: number;
  finishedAt?: number;
  /** coarse progress label the UI can show */
  phase: string;
  result?: ResearchResult;
  error?: string;
}

const jobs = new Map<string, ResearchJob>();
const MAX_JOBS = 40;

function evict() {
  if (jobs.size <= MAX_JOBS) return;
  const done = [...jobs.values()].filter((j) => j.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
  for (const j of done.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
}

export function startResearch(
  kind: "pool" | "news",
  subjectId: string,
  opts: { capitalUsd?: number; riskTier?: 1 | 2 | 3; force?: boolean } = {},
): ResearchJob {
  const id = `${kind}:${subjectId}:${Date.now().toString(36)}`;
  const job: ResearchJob = {
    id,
    kind,
    subjectId,
    status: "running",
    startedAt: Date.now(),
    phase: "构建证据包",
  };
  jobs.set(id, job);
  evict();

  // fire and forget; the client polls
  (async () => {
    try {
      job.phase = "调用模型";
      const result = await research(kind, subjectId, opts);
      job.result = result;
      job.status = result.ok ? "ok" : "error";
      job.error = result.ok ? undefined : result.degradeReason;
      job.phase = result.degraded ? "已降级" : "完成";

      // Only count real model calls: a cache hit costs nothing.
      if (!result.cached) recordSpend((result.tokensIn ?? 0) + (result.tokensOut ?? 0));
    } catch (e: any) {
      job.status = "error";
      job.error = String(e?.message ?? e);
      job.phase = "失败";
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return job;
}

export function getJob(id: string): ResearchJob | undefined {
  return jobs.get(id);
}

export function listJobs(limit = 12): ResearchJob[] {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map((j) => ({
      id: j.id, kind: j.kind, subjectId: j.subjectId, status: j.status,
      startedAt: j.startedAt, finishedAt: j.finishedAt, phase: j.phase,
      error: j.error,
      // omit the heavy result in listings
      result: undefined,
    }));
}
