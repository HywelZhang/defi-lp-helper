/**
 * AI assistant: conversations, the skill catalogue, and third-party links.
 *
 * Design notes that matter beyond this file:
 *
 *  - The assistant answers from *this system's* data, not from vibes. Every turn
 *    builds a fresh context block (positions, plans, feed, style) so "我的仓位
 *    怎么样" is answered with the same numbers the assets page shows. Without
 *    that, the chat becomes a confident stranger.
 *
 *  - The skill catalogue is read from disk every time. A skill file added later
 *    shows up without a migration; only the user's on/off choice is stored.
 *
 *  - Sessions are `chat_sessions`, deliberately distinct from the login table
 *    `sessions`. Mixing those two would be a security bug, not a naming nit.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { all, one, run } from "../db.ts";
import { sha, fmtUsd, fmtPct } from "../util.ts";
import { chat, chatStream, type LlmMessage } from "../llm.ts";
import { DEFAULT_CHAIN, chainLabel } from "../config.ts";
import { budgetAllows, recordSpend, spendStatus } from "../auth.ts";
import { latestChecks, listAlerts } from "./monitor.ts";

const SKILLS_DIR = resolve(new URL("../../skills", import.meta.url).pathname);

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  skillIds: string[];
  messageCount?: number;
  preview?: string | null;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  error?: string | null;
}

/* ─────────────────────────── skill catalogue ─────────────────────────── */

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** short tag shown in the picker, e.g. PLUGIN / 内置 */
  source: string;
}

function readSkillFrontmatter(dir: string): { name?: string; description?: string } {
  const p = resolve(SKILLS_DIR, dir, "SKILL.md");
  if (!existsSync(p)) return {};
  const text = readFileSync(p, "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const body = fm ? fm[1] : text.slice(0, 800);
  const name = body.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = body.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

/** Enabled state for one skill; anything unseen defaults to on. */
function skillEnabled(id: string): boolean {
  const row = one<any>(`SELECT enabled FROM skill_settings WHERE id=?`, id);
  return row ? Boolean(row.enabled) : true;
}

export function listSkills(): SkillInfo[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(SKILLS_DIR, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();

  return dirs.map((dir) => {
    const fm = readSkillFrontmatter(dir);
    return {
      id: dir,
      name: fm.name ?? dir,
      description: fm.description ?? "",
      enabled: skillEnabled(dir),
      source: dir.startsWith("defi-lp-") ? "内置" : "扩展",
    };
  });
}

export function setSkillEnabled(id: string, enabled: boolean) {
  run(
    `INSERT INTO skill_settings (id, enabled, updated_at) VALUES (?,?,?)
     ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`,
    id, enabled ? 1 : 0, Date.now(),
  );
}

/** Full text of the enabled skills, used to ground the assistant. */
export function enabledSkillText(maxChars = 6000): string {
  const on = listSkills().filter((s) => s.enabled);
  const parts: string[] = [];
  let used = 0;
  for (const s of on) {
    const p = resolve(SKILLS_DIR, s.id, "SKILL.md");
    if (!existsSync(p)) continue;
    const body = readFileSync(p, "utf8");
    // The head of each skill carries its rules; the tail is usually examples.
    const slice = body.slice(0, 1400);
    if (used + slice.length > maxChars) break;
    parts.push(`### ${s.name}（${s.id}）\n${slice}`);
    used += slice.length;
  }
  return parts.join("\n\n");
}

/* ─────────────────────────── sessions ─────────────────────────── */

export function createSession(title?: string): ChatSession {
  const id = "cs_" + sha(`chat:${Date.now()}:${Math.random()}`, 16);
  const now = Date.now();
  const t = (title ?? "").trim() || "新对话";
  run(
    `INSERT INTO chat_sessions (id,title,created_at,updated_at,archived,skill_ids)
     VALUES (?,?,?,?,0,'[]')`,
    id, t.slice(0, 80), now, now,
  );
  return { id, title: t, createdAt: now, updatedAt: now, archived: false, skillIds: [] };
}

export function listSessions(limit = 50): ChatSession[] {
  const rows = all<any>(
    `SELECT s.*, 
            (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS msg_count,
            (SELECT content FROM chat_messages m WHERE m.session_id = s.id ORDER BY created_at DESC LIMIT 1) AS last_content
     FROM chat_sessions s
     WHERE s.archived = 0
     ORDER BY s.updated_at DESC
     LIMIT ?`,
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archived: Boolean(r.archived),
    skillIds: safeJson(r.skill_ids, []),
    messageCount: Number(r.msg_count ?? 0),
    preview: r.last_content ? String(r.last_content).slice(0, 90) : null,
  }));
}

function safeJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function getSession(id: string): ChatSession | null {
  const r = one<any>(`SELECT * FROM chat_sessions WHERE id=?`, id);
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archived: Boolean(r.archived),
    skillIds: safeJson(r.skill_ids, []),
  };
}

export function renameSession(id: string, title: string) {
  run(`UPDATE chat_sessions SET title=?, updated_at=? WHERE id=?`, title.slice(0, 80), Date.now(), id);
}

export function deleteSession(id: string) {
  run(`DELETE FROM chat_messages WHERE session_id=?`, id);
  run(`DELETE FROM chat_sessions WHERE id=?`, id);
}

export function listMessages(sessionId: string, limit = 200): ChatMessage[] {
  const rows = all<any>(
    `SELECT * FROM chat_messages WHERE session_id=? ORDER BY created_at ASC LIMIT ?`,
    sessionId, limit,
  );
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    createdAt: Number(r.created_at),
    model: r.model,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    error: r.error,
  }));
}

/**
 * Patch a message that is still being written.
 *
 * Streaming replies are saved *after* the fact: the row is created empty, then
 * updated as text accumulates. Without this, a client that disconnects mid-answer
 * would lose everything already shown on screen — the user would read a reply,
 * reload, and find it gone.
 */
function updateMessage(
  id: string,
  patch: { content?: string; error?: string; tokensIn?: number; tokensOut?: number },
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.content !== undefined) { sets.push("content=?"); vals.push(patch.content); }
  if (patch.error !== undefined) { sets.push("error=?"); vals.push(patch.error); }
  if (patch.tokensIn !== undefined) { sets.push("tokens_in=?"); vals.push(patch.tokensIn); }
  if (patch.tokensOut !== undefined) { sets.push("tokens_out=?"); vals.push(patch.tokensOut); }
  if (!sets.length) return;
  vals.push(id);
  run(`UPDATE chat_messages SET ${sets.join(", ")} WHERE id=?`, ...vals);
}

function appendMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  extra: { model?: string; tokensIn?: number; tokensOut?: number; error?: string } = {},
): ChatMessage {
  const id = "cm_" + sha(`${sessionId}:${Date.now()}:${Math.random()}`, 16);
  const now = Date.now();
  run(
    `INSERT INTO chat_messages (id,session_id,role,content,created_at,model,tokens_in,tokens_out,error)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, sessionId, role, content, now,
    extra.model ?? null, extra.tokensIn ?? null, extra.tokensOut ?? null, extra.error ?? null,
  );
  run(`UPDATE chat_sessions SET updated_at=? WHERE id=?`, now, sessionId);
  return {
    id, sessionId, role, content, createdAt: now,
    model: extra.model, tokensIn: extra.tokensIn, tokensOut: extra.tokensOut, error: extra.error,
  };
}

/* ─────────────────────────── live context ─────────────────────────── */

/**
 * Build a compact snapshot of this system's own data.
 *
 * Everything here is read from the same tables the UI reads, so the assistant
 * cannot drift from what the user sees on screen.
 */
export function buildContext(chain = DEFAULT_CHAIN): string {
  const lines: string[] = [];
  lines.push(`## 当前系统状态（${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC）`);
  lines.push(`- 链: ${chainLabel(chain)}（${chain}）`);

  // --- positions ---
  const pos = all<any>(`SELECT * FROM positions WHERE chain=? ORDER BY opened_at DESC LIMIT 20`, chain);
  if (pos.length) {
    lines.push(`\n### 我的 LP 仓位（${pos.length} 个）`);
    for (const p of pos) {
      const cost = Number(p.cost_usd ?? 0);
      const isClosed = p.status !== "open";
      const proceeds = Number(p.proceeds_usd ?? NaN);
      const cashBack = Number(p.cash_back_usd ?? 0) || 0;
      const value = Number(p.value_usd ?? 0) || 0;
      const recovered = isClosed && Number.isFinite(proceeds) ? proceeds : value + cashBack;
      const pnl = cost > 0 ? recovered - cost : null;
      const pnlPct = cost > 0 && pnl != null ? (pnl / cost) * 100 : null;
      lines.push(
        `- ${p.pool_name ?? "?"} · ${isClosed ? "已平仓" : "持有中"} · 投入 ${fmtUsd(cost, 4)}` +
        (pnl != null ? ` · 盈亏 ${fmtUsd(pnl, 4)}（${fmtPct(pnlPct, 2)}）` : "") +
        (p.token_id ? ` · NFT #${p.token_id}` : ""),
      );
    }
  } else {
    lines.push(`\n### 我的 LP 仓位\n- 当前没有仓位`);
  }

  // --- plans ---
  const plans = all<any>(`SELECT * FROM plans ORDER BY created_at DESC LIMIT 8`);
  if (plans.length) {
    lines.push(`\n### 最近的投资计划`);
    for (const p of plans) {
      lines.push(
        `- ${p.pool_name} · 投入 ${fmtUsd(Number(p.capital_usd ?? 0), 2)} · 评分 ${p.score ?? "?"}` +
        `（${p.grade ?? "?"}）· 状态 ${p.status}`,
      );
    }
  }

  // --- feed ---
  // Pool cards carry score/grade inside the payload JSON, not as columns; the
  // only score column is rank_score, which is the feed's own ordering metric and
  // is NOT the 0-100 pool score. Reading the wrong one would misreport quality.
  const cards = all<any>(
    `SELECT title, kind, rank_score, payload FROM feed_cards
     WHERE kind='pool' ORDER BY rank_score DESC LIMIT 6`,
  );
  if (cards.length) {
    lines.push(`\n### 当前推荐池（按系统排名）`);
    for (const c of cards) {
      let pl: any = {};
      try { pl = JSON.parse(c.payload ?? "{}"); } catch { /* keep {} */ }
      const bits = [
        pl.score != null ? `${pl.score} 分` : null,
        pl.grade ? String(pl.grade) : null,
        pl.feeAprPct != null ? `fee APR ${Number(pl.feeAprPct).toFixed(1)}%` : null,
      ].filter(Boolean);
      lines.push(`- ${c.title}${bits.length ? " · " + bits.join(" / ") : ""}`);
    }
  }

  // --- style ---
  const st = one<any>(`SELECT * FROM style_profile WHERE id='current'`);
  if (st) {
    let ev: any = {};
    try { ev = JSON.parse(st.evidence ?? "{}"); } catch { /* keep {} */ }
    lines.push(`\n### 交易风格`);
    lines.push(
      `- 观察 ${st.positions_observed} 个仓位 · 胜率 ${st.win_rate ?? "—"}% · ` +
      `平均盈亏 ${st.avg_realised_pnl_pct ?? "—"}%`,
    );
    lines.push(`- 结论可靠性: ${ev?.reliable ? "可用" : "不可用（" + (ev?.unreliableReason ?? "样本不足") + "）"}`);
  }

  // --- automated monitoring ---
  // The assistant is asked "怎么亏的" and "要不要调仓"; answering that without
  // the band position and the open alerts would be guessing. Both come from the
  // monitor's own tables so the chat and the assets page cannot disagree.
  try {
    const checks = latestChecks();
    const open = checks.filter((c) => c.valueUsd > 0 || c.costUsd > 0);
    if (open.length) {
      lines.push(`\n### 仓位监控（最近一次自动检查）`);
      for (const c of open) {
        const stateText: Record<string, string> = {
          in: "区间内", near_lower: "接近下沿", near_upper: "接近上沿",
          out_below: "已跌破下沿", out_above: "已涨破上沿", unknown: "区间未知",
        };
        const bits = [
          stateText[c.state] ?? c.state,
          c.price != null ? `现价 ${c.price.toFixed(6)}` : null,
          c.lower != null && c.upper != null ? `区间 ${c.lower.toFixed(6)}–${c.upper.toFixed(6)}` : null,
          c.bandPos != null ? `位于带宽 ${(c.bandPos * 100).toFixed(1)}%` : null,
        ].filter(Boolean);
        lines.push(`- ${c.poolName || c.positionId}：${bits.join(" · ")}`);
      }
    }

    const al = listAlerts(8);
    if (al.length) {
      lines.push(`\n### 未读告警（${al.length} 条）`);
      for (const a of al) lines.push(`- [${a.level}] ${a.title}`);
    }
  } catch { /* monitoring is optional context; never break the chat */ }

  // --- integrations ---
  const ints = all<any>(`SELECT name, status FROM integrations ORDER BY name`);
  if (ints.length) {
    lines.push(`\n### 三方接入`);
    for (const i of ints) lines.push(`- ${i.name}: ${i.status}`);
  }

  return lines.join("\n");
}

/* ─────────────────────────── chat ─────────────────────────── */

const SYSTEM_BASE = `你是 LP Agent 的 AI 助手，服务于一个 DeFi 流动性做市（LP）工作台。

## 你的职责
- 回答关于 LP 策略、池子选择、仓位管理、风险控制的问题
- 用户问"我的仓位/计划/推荐"时，必须使用下面提供的实时数据，不要编造
- 给出具体、可执行的建议，不要空话

## 硬规则
1. 数字只能来自下面提供的实时数据或用户明确的输入。没有数据就说没有。
2. 亏损就直说亏损，不要用"基本符合预期""接近平衡"软化。
3. 用户问的东西超出能力范围（例如实时行情报价、链上转账），直接说明并给出替代做法。
4. 不要声称你已经执行了任何链上操作——你只能给建议，执行由用户确认。
5. 简洁。默认 3-6 句，用户要求详细时再展开。
6. 用中文回答。`;

/** Build the system+history message list. Shared so streaming and non-streaming
 *  cannot drift apart in what the model is told. */
function buildMessages(sessionId: string, chain?: string, extraContext?: string): LlmMessage[] {
  const history = listMessages(sessionId, 40);
  const skillText = enabledSkillText();
  const context = buildContext(chain ?? DEFAULT_CHAIN);
  // `extraContext` carries a subject the generic summary cannot cover — today
  // that is the pool a user is looking at when they ask from its drawer.
  const system = [
    SYSTEM_BASE,
    context,
    extraContext ? `# 本次提问的具体对象\n${extraContext}` : "",
    skillText ? `## 已启用的技能说明\n${skillText}` : "",
  ].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: system },
    ...history.map((m) => ({ role: m.role, content: m.content } as LlmMessage)),
  ];
}

export interface ChatResult {
  ok: boolean;
  sessionId: string;
  userMessage?: ChatMessage;
  assistantMessage?: ChatMessage;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  tookMs?: number;
  budget?: ReturnType<typeof spendStatus>;
}

export async function sendMessage(
  sessionId: string,
  userText: string,
  opts: { chain?: string; regenerate?: boolean; extraContext?: string } = {},
): Promise<ChatResult> {
  const started = Date.now();
  const text = String(userText ?? "").trim();
  if (!text) return { ok: false, sessionId, error: "消息为空" };

  const session = getSession(sessionId);
  if (!session) return { ok: false, sessionId, error: "会话不存在" };

  // Spend gate before anything expensive. Mirrors the research pipeline so one
  // daily budget covers every model call in the product.
  const budget = budgetAllows();
  if (!budget.ok) {
    return { ok: false, sessionId, error: budget.reason, budget: spendStatus() };
  }

  const userMessage = appendMessage(sessionId, "user", text);

  // Replay the recent window. Long enough for continuity, short enough that the
  // context block still fits.
  const messages = buildMessages(sessionId, opts.chain, opts.extraContext);

  // Token budget has to cover hidden reasoning, not just the visible answer.
  // DeepSeek spends `reasoning_content` before emitting anything, so a 1200-token
  // cap produced finish_reason=length with empty content on longer questions —
  // the user saw a blank reply. 4000 leaves room for both.
  const baseOpts = { temperature: 0.4, maxTokens: 4000, timeoutMs: 120_000 };

  let llm = await chat(messages, baseOpts);

  // Reasoning length varies per question, so any fixed cap can be outgrown. If
  // the model truncates, retry once with thinking off: less deliberation, but a
  // real answer instead of nothing.
  if (!llm.ok && /truncated by max_tokens/i.test(llm.error ?? "")) {
    llm = await chat(messages, { ...baseOpts, thinking: "disabled" as const });
  }

  if (!llm.ok) {
    const err = appendMessage(sessionId, "assistant", "", { error: llm.error ?? "unknown" });
    return {
      ok: false, sessionId, userMessage, assistantMessage: err,
      error: llm.error ?? "模型调用失败",
      tookMs: Date.now() - started,
    };
  }

  const reply = appendMessage(sessionId, "assistant", llm.text, {
    model: llm.model, tokensIn: llm.tokensIn, tokensOut: llm.tokensOut,
  });
  recordSpend(llm.tokensIn + llm.tokensOut);

  // First user turn names the conversation; a wall of identical "新对话"
  // entries is useless for finding anything later.
  if (session.title === "新对话") {
    renameSession(sessionId, text.slice(0, 40));
  }

  return {
    ok: true, sessionId, userMessage, assistantMessage: reply,
    tokensIn: llm.tokensIn, tokensOut: llm.tokensOut, model: llm.model,
    tookMs: Date.now() - started, budget: spendStatus(),
  };
}

/* ─────────────────────────── integrations ─────────────────────────── */

export interface Integration {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  status: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export function listIntegrations(): Integration[] {
  const rows = all<any>(`SELECT * FROM integrations ORDER BY
    CASE kind WHEN 'chain' THEN 0 WHEN 'dex' THEN 1 WHEN 'protocol' THEN 2 ELSE 3 END, name`);
  return rows.map((r) => ({
    id: r.id, name: r.name, kind: r.kind, url: r.url,
    status: r.status, note: r.note,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  }));
}

export function upsertIntegration(input: {
  id?: string; name: string; kind: string; url?: string; status?: string; note?: string;
}): Integration {
  const now = Date.now();
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("名称不能为空");
  const id = input.id?.trim() || "int_" + sha(`${name}:${now}`, 12);

  const existing = one<any>(`SELECT * FROM integrations WHERE id=?`, id);
  if (existing) {
    run(
      `UPDATE integrations SET name=?, kind=?, url=?, status=?, note=?, updated_at=? WHERE id=?`,
      name, input.kind, input.url ?? null, input.status ?? existing.status,
      input.note ?? null, now, id,
    );
  } else {
    run(
      `INSERT INTO integrations (id,name,kind,url,status,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, name, input.kind, input.url ?? null, input.status ?? "unknown", input.note ?? null, now, now,
    );
  }

  const r = one<any>(`SELECT * FROM integrations WHERE id=?`, id)!;
  return {
    id: r.id, name: r.name, kind: r.kind, url: r.url, status: r.status, note: r.note,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

export function deleteIntegration(id: string) {
  run(`DELETE FROM integrations WHERE id=?`, id);
}

export function seedIntegrations() {
  const n = one<any>(`SELECT COUNT(*) c FROM integrations`);
  if (Number(n?.c ?? 0) > 0) return;
  const now = Date.now();
  const seed: [string, string, string, string, string][] = [
    ["onchainos", "OnchainOS", "tool", "https://onchainos.io", "connected"],
    ["xlayer", "X Layer", "chain", "https://www.okx.com/xlayer", "connected"],
    ["uniswap-v3", "Uniswap V3", "dex", "https://uniswap.org", "connected"],
    ["geckoterminal", "GeckoTerminal", "data", "https://www.geckoterminal.com", "connected"],
    ["curve", "Curve", "dex", "https://curve.fi", "available"],
    ["aave", "Aave", "protocol", "https://aave.com", "available"],
  ];
  for (const [id, name, kind, url, status] of seed) {
    run(
      `INSERT OR IGNORE INTO integrations (id,name,kind,url,status,note,created_at,updated_at)
       VALUES (?,?,?,?,?,NULL,?,?)`,
      id, name, kind, url, status, now, now,
    );
  }
}

/**
 * Streaming variant of `sendMessage`.
 *
 * The reply is persisted as it is produced, not at the end. If the client
 * disconnects halfway, whatever the user already read stays in the transcript —
 * a reply that vanishes on reload is worse than a slow one.
 *
 * `onEvent` receives:
 *   { type: "user",    message }        the stored user turn
 *   { type: "thinking" }                reasoning started (no text yet)
 *   { type: "delta",   text }           visible text increment
 *   { type: "done",    message, ... }   finished and saved
 *   { type: "error",   error, message? } failed; partial text is kept
 */
export async function streamMessage(
  sessionId: string,
  userText: string,
  opts: {
    chain?: string;
    signal?: AbortSignal;
    extraContext?: string;
    onEvent: (ev: Record<string, unknown>) => void;
  },
): Promise<ChatResult> {
  const started = Date.now();
  const text = String(userText ?? "").trim();
  if (!text) {
    opts.onEvent({ type: "error", error: "消息为空" });
    return { ok: false, sessionId, error: "消息为空" };
  }

  const session = getSession(sessionId);
  if (!session) {
    opts.onEvent({ type: "error", error: "会话不存在" });
    return { ok: false, sessionId, error: "会话不存在" };
  }

  const budget = budgetAllows();
  if (!budget.ok) {
    opts.onEvent({ type: "error", error: budget.reason });
    return { ok: false, sessionId, error: budget.reason, budget: spendStatus() };
  }

  const userMessage = appendMessage(sessionId, "user", text);
  opts.onEvent({ type: "user", message: userMessage });

  const messages = buildMessages(sessionId, opts.chain, opts.extraContext);

  // Create the assistant row up front so every later write has a target.
  const holder = appendMessage(sessionId, "assistant", "");
  opts.onEvent({ type: "assistant_start", messageId: holder.id });

  let acc = "";
  const baseOpts = { temperature: 0.4, maxTokens: 4000, timeoutMs: 180_000 };

  const attempt = (thinking: "enabled" | "disabled") =>
    chatStream(messages, {
      ...baseOpts,
      thinking,
      signal: opts.signal,
      onReasoning: () => opts.onEvent({ type: "thinking" }),
      onDelta: (d) => {
        acc += d;
        opts.onEvent({ type: "delta", text: d });
      },
    });

  let llm = await attempt("enabled");

  // Reasoning consumed the whole budget before any visible text. Retry with
  // thinking off — an answer without deliberation beats a blank panel.
  if (!llm.ok && !acc && /truncated by max_tokens/i.test(llm.error ?? "")) {
    const retry = await attempt("disabled");
    if (retry.ok || retry.text) llm = retry;
  }

  const aborted = opts.signal?.aborted === true;

  if (!llm.ok && !acc) {
    // A stop during reasoning produces nothing worth showing. Saving an empty
    // assistant row would leave the transcript with a blank reply bubble that
    // reappears on every reload — so remove the placeholder instead. The user's
    // question stays, which is the honest record of what happened.
    if (aborted) {
      run(`DELETE FROM chat_messages WHERE id=?`, holder.id);
      opts.onEvent({ type: "aborted", messageId: holder.id });
      return {
        ok: false, sessionId, userMessage, error: "已取消",
        tookMs: Date.now() - started,
      };
    }
    updateMessage(holder.id, { error: llm.error ?? "unknown" });
    opts.onEvent({ type: "error", error: llm.error ?? "模型调用失败", messageId: holder.id });
    return {
      ok: false, sessionId, userMessage, error: llm.error ?? "模型调用失败",
      tookMs: Date.now() - started,
    };
  }

  // Partial answers are kept and labelled. Losing them would hide the very
  // truncation the user needs to know about.
  const note = aborted
    ? "（已停止生成）"
    : llm.error && acc
      ? `（${llm.error}）`
      : "";
  const finalText = acc + (note ? `\n\n${note}` : "");

  updateMessage(holder.id, {
    content: finalText,
    ...(llm.tokensIn ? { tokensIn: llm.tokensIn } : {}),
    ...(llm.tokensOut ? { tokensOut: llm.tokensOut } : {}),
  });

  recordSpend((llm.tokensIn ?? 0) + (llm.tokensOut ?? 0));

  if (session.title === "新对话") renameSession(sessionId, text.slice(0, 40));

  const saved: ChatMessage = {
    id: holder.id, sessionId, role: "assistant", content: finalText, createdAt: Date.now(),
    model: llm.model, tokensIn: llm.tokensIn, tokensOut: llm.tokensOut,
    error: aborted ? "已停止生成" : (llm.error ?? null),
  };

  opts.onEvent({
    type: "done", message: saved,
    tokensIn: llm.tokensIn, tokensOut: llm.tokensOut, model: llm.model,
    tookMs: Date.now() - started, aborted,
  });

  return {
    ok: true, sessionId, userMessage, assistantMessage: saved,
    tokensIn: llm.tokensIn, tokensOut: llm.tokensOut, model: llm.model,
    tookMs: Date.now() - started, budget: spendStatus(),
  };
}
