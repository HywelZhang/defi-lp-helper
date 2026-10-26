#!/usr/bin/env node
/**
 * LLM client for the research pipeline.
 *
 * Reads the DeepSeek provider config the same way OpenClaw does so there is one
 * credential source. Never logs the key.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResult {
  ok: boolean;
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  tookMs: number;
  error?: string;
}

/**
 * Resolve the model provider.
 *
 * Environment variables win, so the project can run outside OpenClaw with
 * nothing but `DEEPSEEK_API_KEY` set. The OpenClaw config file is the fallback
 * for the original deployment, where a key already lives there.
 *
 * Two sources rather than one because the first is required for anyone else to
 * use this at all: hard-coding "read OpenClaw's config" makes the project
 * unrunnable for every reader who is not already running OpenClaw.
 */
function providerConfig() {
  const envKey = process.env.DEEPSEEK_API_KEY ?? process.env.LP_LLM_API_KEY;
  if (envKey) {
    return {
      baseUrl: (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1").replace(/\/$/, ""),
      apiKey: envKey,
      model: process.env.LP_LLM_MODEL ?? "deepseek-flash",
    };
  }

  const path = process.env.LP_LLM_CONFIG ?? join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(path)) {
    throw new Error(
      "no model provider configured: set DEEPSEEK_API_KEY (or point LP_LLM_CONFIG at an OpenClaw config)",
    );
  }
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const p = cfg?.models?.providers?.deepseek;
  if (!p?.apiKey) {
    throw new Error("no model provider configured: set DEEPSEEK_API_KEY");
  }
  return {
    baseUrl: (p.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/$/, ""),
    apiKey: p.apiKey,
    model: p.models?.[0]?.id ?? process.env.LP_LLM_MODEL ?? "deepseek-flash",
  };
}

export async function chat(
  messages: LlmMessage[],
  opts: {
    json?: boolean;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    /**
     * DeepSeek reasoning models spend completion tokens on hidden
     * `reasoning_content` before emitting `content`. With a bounded max_tokens
     * that ends in finish_reason=length and empty content — silent, expensive
     * failures. Disabling thinking is required for structured output.
     */
    thinking?: "disabled" | "enabled";
  } = {},
): Promise<LlmResult> {
  const started = Date.now();
  let cfg;
  try {
    cfg = providerConfig();
  } catch (e: any) {
    return { ok: false, text: "", model: "none", tokensIn: 0, tokensOut: 0, tookMs: 0, error: e.message };
  }

  const model = process.env.LP_LLM_MODEL ?? cfg.model;
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1600,
    stream: false,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  // default off for JSON work: reasoning tokens starve the structured output
  body.thinking = { type: opts.thinking ?? (opts.json ? "disabled" : "enabled") };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 120_000);

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${process.env.LP_AUTH_SCHEME ?? "Bearer"} ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const text = await res.text();

    if (!res.ok) {
      return {
        ok: false, text: "", model, tokensIn: 0, tokensOut: 0, tookMs: Date.now() - started,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const j = JSON.parse(text);
    const choice = j.choices?.[0];
    const content = choice?.message?.content ?? "";
    if (!content && choice?.finish_reason === "length") {
      return {
        ok: false, text: "", model,
        tokensIn: j.usage?.prompt_tokens ?? 0, tokensOut: j.usage?.completion_tokens ?? 0,
        tookMs: Date.now() - started,
        error: `output truncated by max_tokens (reasoning consumed ${j.usage?.completion_tokens_details?.reasoning_tokens ?? "?"} tokens)`,
      };
    }
    return {
      ok: true,
      text: content,
      model,
      tokensIn: j.usage?.prompt_tokens ?? 0,
      tokensOut: j.usage?.completion_tokens ?? 0,
      tookMs: Date.now() - started,
    };
  } catch (e: any) {
    clearTimeout(timer);
    return {
      ok: false, text: "", model, tokensIn: 0, tokensOut: 0, tookMs: Date.now() - started,
      error: e?.name === "AbortError" ? "timeout" : String(e?.message ?? e),
    };
  }
}

/**
 * Streaming variant of `chat`.
 *
 * Emits visible text deltas as they arrive. Two things make this more than a
 * transport change:
 *
 *  1. Reasoning models send `reasoning_content` deltas before any `content`.
 *     Those must NOT reach the user's screen — they are deliberation, and in our
 *     measurements they can run to thousands of tokens. Only `content` is
 *     forwarded; reasoning is counted so the truncation check still works.
 *
 *  2. `finish_reason: "length"` with empty text is a silent failure in the
 *     non-streaming path. In streaming we already know how many characters were
 *     emitted, so we can tell "truncated mid-sentence" (partial answer, keep it)
 *     from "truncated before any answer" (failure, retry or report).
 */
export async function chatStream(
  messages: LlmMessage[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    thinking?: "disabled" | "enabled";
    /** called for each visible text delta */
    onDelta: (text: string) => void;
    /** called once when reasoning starts, so the UI can show "thinking…" */
    onReasoning?: () => void;
    /** abort from the caller (client disconnected, user cancelled) */
    signal?: AbortSignal;
  },
): Promise<LlmResult> {
  const started = Date.now();
  let cfg;
  try {
    cfg = providerConfig();
  } catch (e: any) {
    return { ok: false, text: "", model: "none", tokensIn: 0, tokensOut: 0, tookMs: 0, error: e.message };
  }

  const model = process.env.LP_LLM_MODEL ?? cfg.model;
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1600,
    stream: true,
    // Ask the provider to include usage in the final chunk; without it the
    // token ledger silently records zero and the daily budget never advances.
    stream_options: { include_usage: true },
  };
  body.thinking = { type: opts.thinking ?? "enabled" };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 120_000);
  const onOuterAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let text = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let reasoningTokens = 0;
  let finish: string | null = null;
  let sawReasoning = false;

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${process.env.LP_AUTH_SCHEME ?? "Bearer"} ${cfg.apiKey}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      clearTimeout(timer);
      return {
        ok: false, text: "", model, tokensIn: 0, tokensOut: 0, tookMs: Date.now() - started,
        error: `HTTP ${res.status}: ${raw.slice(0, 200)}`,
      };
    }
    if (!res.body) {
      clearTimeout(timer);
      return {
        ok: false, text: "", model, tokensIn: 0, tokensOut: 0, tookMs: Date.now() - started,
        error: "stream body missing",
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    // SSE frames are separated by a blank line. A chunk can split a frame in
    // half, so incomplete tails stay in `buf` until the next read.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let j: any;
          try { j = JSON.parse(payload); } catch { continue; }

          const choice = j.choices?.[0];
          if (choice?.finish_reason) finish = String(choice.finish_reason);

          const delta = choice?.delta ?? {};
          // Reasoning is counted, never displayed.
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length) {
            if (!sawReasoning) {
              sawReasoning = true;
              opts.onReasoning?.();
            }
          }
          if (typeof delta.content === "string" && delta.content.length) {
            text += delta.content;
            opts.onDelta(delta.content);
          }

          if (j.usage) {
            tokensIn = j.usage.prompt_tokens ?? tokensIn;
            tokensOut = j.usage.completion_tokens ?? tokensOut;
            reasoningTokens = j.usage.completion_tokens_details?.reasoning_tokens ?? reasoningTokens;
          }
        }
      }
    }

    clearTimeout(timer);

    // Nothing visible came back. Distinguish the two causes: a genuinely empty
    // answer, and reasoning that consumed the whole budget. The caller can retry
    // the second case with thinking disabled.
    if (!text) {
      const why = finish === "length"
        ? `output truncated by max_tokens (reasoning consumed ${reasoningTokens || "?"} tokens)`
        : "empty response";
      return {
        ok: false, text: "", model, tokensIn, tokensOut, tookMs: Date.now() - started, error: why,
      };
    }

    return {
      ok: true, text, model, tokensIn, tokensOut, tookMs: Date.now() - started,
      // Partial text is still useful: the user sees an unfinished answer rather
      // than a blank panel. Signal it so the UI can label the cut.
      ...(finish === "length" ? { error: "回答被长度上限截断" } : {}),
    };
  } catch (e: any) {
    clearTimeout(timer);
    const aborted = e?.name === "AbortError";
    return {
      ok: false,
      text,
      model,
      tokensIn,
      tokensOut,
      tookMs: Date.now() - started,
      error: aborted
        ? (opts.signal?.aborted ? "已取消" : "timeout")
        : String(e?.message ?? e),
    };
  } finally {
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}
