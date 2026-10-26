/**
 * Tool result helper. Every tool returns the same envelope so the UI, the CLI
 * and the LLM pipeline all consume one shape.
 */

import type { Fact, SourceRef, ToolResult } from "../types.ts";

export class ResultBuilder<T = any> {
  private facts: Fact[] = [];
  private sources: SourceRef[] = [];
  private degraded = false;
  private degradedReason: string | undefined;
  private started = Date.now();
  private version: string;

  constructor(version: string) {
    this.version = version;
  }

  fact(
    id: string,
    label: string,
    value: string | number | null,
    opts: { unit?: string; source?: string; approx?: boolean; ts?: number } = {},
  ): this {
    this.facts.push({
      id,
      label,
      value,
      unit: opts.unit,
      source: opts.source ?? "internal",
      approx: opts.approx,
      ts: opts.ts ?? Math.floor(Date.now() / 1000),
    });
    return this;
  }

  source(name: string, url?: string): this {
    this.sources.push({ name, url, ts: Math.floor(Date.now() / 1000) });
    return this;
  }

  degrade(reason: string): this {
    this.degraded = true;
    this.degradedReason = [this.degradedReason, reason].filter(Boolean).join("; ");
    return this;
  }

  ok(data: T): ToolResult<T> {
    return {
      ok: true,
      data,
      facts: this.facts,
      sources: dedupeSources(this.sources),
      degraded: this.degraded,
      degradedReason: this.degradedReason,
      tookMs: Date.now() - this.started,
      version: this.version,
    };
  }

  fail(error: string): ToolResult<T> {
    return {
      ok: false,
      data: null,
      facts: this.facts,
      sources: dedupeSources(this.sources),
      degraded: true,
      degradedReason: error,
      tookMs: Date.now() - this.started,
      version: this.version,
    };
  }
}

function dedupeSources(s: SourceRef[]): SourceRef[] {
  const m = new Map<string, SourceRef>();
  for (const x of s) if (!m.has(x.name)) m.set(x.name, x);
  return [...m.values()];
}
