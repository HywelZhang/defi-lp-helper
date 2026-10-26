/**
 * M1 server — zero-dependency Node HTTP.
 *
 * Serves the feed UI and the tool layer over HTTP so the browser, the CLI and
 * an OpenClaw agent all consume identical data.
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { feedBuild, feedList } from "../core/tools/feed.ts";
import { newsIngest, newsRank, getWatchlistSymbols } from "../core/tools/news.ts";
import { poolsList, poolDetail, tokenProfile, tokenPools } from "../core/tools/pools.ts";
import { computeScore } from "../core/tools/score.ts";
import { marketSnapshot } from "../core/tools/market.ts";
import { startResearch, getJob, listJobs } from "../core/jobs.ts";
import { planBuild, planList, planGet, planSetStatus, resolvePolicy } from "../core/tools/plan.ts";
import {
  walletStatus, walletAddresses, chainBalance, resolveInvestmentId, isInstalled as onchainosInstalled,
} from "../core/tools/onchainos.ts";
import { DEFAULT_CHAIN, CHAINS, chainLabel, geckoNetwork } from "../core/config.ts";
import { prepareExecution, confirmExecution, cancelExecution } from "../core/tools/execute.ts";
import { prepareClose, prepareRebalance, prepareRebuild } from "../core/tools/execute.ts";
import { syncPositions, getPortfolio, positionEvents } from "../core/tools/portfolio.ts";
import {
  listSessions as listChatSessions,
  createSession as createChatSession,
  getSession as getChatSession,
  renameSession as renameChatSession,
  deleteSession as deleteChatSession,
  listMessages as listChatMessages,
  sendMessage as sendChatMessage,
  streamMessage as streamChatMessage,
  listSkills, setSkillEnabled,
  listIntegrations, upsertIntegration, deleteIntegration, seedIntegrations,
} from "../core/tools/assistant.ts";
import {
  review, deriveStyleProfile, loadStyleProfile, buildPositionFacts, buildPeriodFacts,
  styleScoreOverrides,
} from "../core/tools/review.ts";
import {
  checkPositions, listAlerts, ackAlert, ackAllAlerts, latestChecks,
  buildDailyDigest, saveDailyDigest, ensureMonitorTables,
} from "../core/tools/monitor.ts";
import {
  listNotifications, markRead, markAllRead, unreadCount, notify,
} from "../core/tools/notify.ts";
import { buildLeaderboard } from "../core/tools/leaderboard.ts";
import { listWatchlist, addWatch, removeWatch } from "../core/tools/watchlist.ts";
import { buildPoolContext } from "../core/tools/poolContext.ts";
import {
  autoEnabled, setAutoEnabled, runAutoRebalance, ensureSettingsTable,
} from "../core/tools/autoRebalance.ts";
import {
  authConfigured, loadAuth, saveAuth, verifyPassword,
  createSession, destroySession, sessionFromRequest, parseCookies,
  sessionCookie, clearCookie, purgeExpiredSessions,
  loginBlocked, recordLoginFailure, clearLoginFailures,
  budgetAllows, recordSpend, spendStatus,
} from "../core/auth.ts";
import { all, run, one } from "../core/db.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const PUBLIC = resolve(new URL("./public", import.meta.url).pathname);
const TOKEN = process.env.LP_ACCESS_TOKEN ?? "";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

// ---------- SSE hub ----------
type Client = { id: number; res: import("node:http").ServerResponse };
const clients = new Set<Client>();
let clientId = 0;

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.res.write(payload); } catch { clients.delete(c); }
  }
}

/**
 * Review history for the list view. Reports are included only where they exist;
 * a degraded row still shows its facts, which is the point of keeping them in a
 * separate column.
 */
function allReviewRows(kind: string | null, limit = 30) {
  const sql = kind
    ? `SELECT id,kind,subject_id,status,report,created_at,degrade_reason FROM reviews WHERE kind=? ORDER BY created_at DESC LIMIT ?`
    : `SELECT id,kind,subject_id,status,report,created_at,degrade_reason FROM reviews ORDER BY created_at DESC LIMIT ?`;
  const args = kind ? [kind, limit] : [limit];
  const rows = all<any>(sql, ...args);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    subjectId: r.subject_id,
    status: r.status,
    createdAt: Number(r.created_at),
    degradeReason: r.degrade_reason ?? null,
    report: (() => { try { return r.report ? JSON.parse(r.report) : null; } catch { return null; } })(),
  }));
}

function json(res: import("node:http").ServerResponse, body: unknown, status = 200) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(s);
}

function clientIp(req: import("node:http").IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function isHttps(req: import("node:http").IncomingMessage): boolean {
  const proto = req.headers["x-forwarded-proto"];
  return proto === "https" || Boolean((req.socket as any).encrypted);
}

/**
 * Every non-public path requires a session. Static assets are also gated:
 * leaving JS/CSS open would let anyone scrape the app shell and API shapes.
 */
const PUBLIC_PATHS = new Set([
  "/login",
  "/login.css",
  "/api/auth/login",
  "/api/auth/status",
  "/favicon.ico",
]);

function authOk(req: import("node:http").IncomingMessage): boolean {
  if (TOKEN) {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.searchParams.get("token") === TOKEN || (req.headers["x-lp-token"] as string) === TOKEN) return true;
  }
  return Boolean(sessionFromRequest(req.headers));
}

function body(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((ok, bad) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 1e6) bad(new Error("too large")); });
    req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { bad(e); } });
    req.on("error", bad);
  });
}

// ---------- job runner (preview of the automations module) ----------
const jobs: Record<string, { id: number; name: string; status: string; startedAt: number; finishedAt?: number; note?: string }> = {};
let jobSeq = 0;

async function runJob(name: string, fn: () => Promise<string>) {
  const id = ++jobSeq;
  jobs[name] = { id, name, status: "running", startedAt: Date.now() };
  broadcast("job", { name, status: "running", startedAt: jobs[name].startedAt });
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    const note = await fn();
    jobs[name] = { ...jobs[name], status: "ok", finishedAt: Date.now(), note };
    run(
      `INSERT INTO ingest_runs (job,started_at,finished_at,status,inserted,error) VALUES (?,?,?,?,?,?)`,
      name, startedAt, Math.floor(Date.now() / 1000), "ok", 0, null,
    );
    broadcast("job", jobs[name]);
  } catch (e: any) {
    jobs[name] = { ...jobs[name], status: "error", finishedAt: Date.now(), note: e?.message };
    broadcast("job", jobs[name]);
    run(
      `INSERT INTO ingest_runs (job,started_at,finished_at,status,inserted,error) VALUES (?,?,?,?,?,?)`,
      name, startedAt, Math.floor(Date.now() / 1000), "error", 0, String(e?.message ?? e),
    );
  }
  return jobs[name];
}

let refreshing = false;
async function refreshAll(trigger: string) {
  if (refreshing) return { skipped: true };
  refreshing = true;
  try {
    const news = await runJob("news.ingest", async () => {
      const s = await newsIngest();
      const ins = s.reduce((a, x) => a + x.inserted, 0);
      const errs = s.filter((x) => x.error);
      if (errs.length) broadcast("notice", { level: "warn", text: `${errs.length} 个源抓取失败` });
      return `${ins} 条新增`;
    });
    const feed = await runJob("feed.build", async () => {
      const r = await feedBuild({ capitalUsd: 2000, riskTier: 2 });
      return `${r.data?.count ?? 0} 张卡片（新 ${r.data?.inserted ?? 0}）`;
    });
    broadcast("refreshed", { trigger, news: news.note, feed: feed.note, at: Date.now() });
    return { news: news.note, feed: feed.note };
  } finally {
    refreshing = false;
  }
}

// ---------- routes ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  try {
    // ---- auth (public) ----
    if (path === "/api/auth/status") {
      const s = sessionFromRequest(req.headers);
      return json(res, {
        ok: true,
        authenticated: Boolean(s),
        username: s?.username ?? null,
        configured: authConfigured(),
        budget: spendStatus(),
      });
    }

    if (path === "/api/auth/login" && req.method === "POST") {
      const ip = clientIp(req);
      const gate = loginBlocked(ip);
      if (gate.blocked) {
        res.setHeader("retry-after", String(gate.retryAfterSec));
        return json(res, { ok: false, error: `尝试过于频繁，请 ${Math.ceil(gate.retryAfterSec / 60)} 分钟后再试` }, 429);
      }

      const b = await body(req).catch(() => ({}));
      const username = String(b.username ?? "").trim();
      const password = String(b.password ?? "");
      const rec = loadAuth();

      // Constant-ish work either way: unknown user still pays a scrypt verify
      // so response timing does not reveal whether the username exists.
      const userOk = Boolean(rec && username === rec.username);
      const passOk = rec ? verifyPassword(password, rec.hash) : verifyPassword(password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");

      if (!userOk || !passOk) {
        recordLoginFailure(ip);
        return json(res, { ok: false, error: "用户名或密码错误" }, 401);
      }

      clearLoginFailures(ip);
      const sess = createSession(username, { ip, ua: req.headers["user-agent"] as string });
      res.setHeader("set-cookie", sessionCookie(sess.token, isHttps(req), Math.floor((sess.expiresAt - Date.now()) / 1000)));
      return json(res, { ok: true, username });
    }

    if (path === "/api/auth/logout" && req.method === "POST") {
      destroySession(parseCookies(req.headers.cookie)["lp_session"]);
      res.setHeader("set-cookie", clearCookie());
      return json(res, { ok: true });
    }

    // ---- gate ----
    if (!PUBLIC_PATHS.has(path) && !authOk(req)) {
      if (path.startsWith("/api/")) return json(res, { ok: false, error: "unauthorized" }, 401);
      if (path === "/login") {
        // fall through to static handler below
      } else {
        res.writeHead(302, { location: "/login" });
        return res.end();
      }
    }

    if (path.startsWith("/api/")) {
      if (path === "/api/health") {
        const n = one<{ c: number }>(`SELECT COUNT(*) c FROM news_items`);
        const f = one<{ c: number }>(`SELECT COUNT(*) c FROM feed_cards`);
        return json(res, { ok: true, news: n?.c ?? 0, cards: f?.c ?? 0, jobs, at: Date.now() });
      }

      if (path === "/api/feed") {
        const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean);
        const limit = Number(url.searchParams.get("limit") ?? 40);
        const sinceHours = Number(url.searchParams.get("hours") ?? 72);
        const cards = feedList({ limit, kinds, sinceHours });
        return json(res, { ok: true, count: cards.length, cards });
      }

      if (path === "/api/news") {
        const r = await newsRank({
          limit: Number(url.searchParams.get("limit") ?? 20),
          hours: Number(url.searchParams.get("hours") ?? 72),
        });
        return json(res, r);
      }

      if (path === "/api/pools") {
        const r = await poolsList({
          chain: url.searchParams.get("chain") ?? DEFAULT_CHAIN,
          sort: (url.searchParams.get("sort") ?? "vol24h") as any,
          minTvl: Number(url.searchParams.get("minTvl") ?? 250000),
          limit: Number(url.searchParams.get("limit") ?? 30),
          q: url.searchParams.get("q") ?? undefined,
        });
        if (!r.ok || !r.data) return json(res, r, 502);
        const capital = Number(url.searchParams.get("capital") ?? 2000);
        const rows = r.data.rows.map((p: any) => ({ ...p, score: computeScore(p, { capitalUsd: capital }) }));
        return json(res, { ...r, data: { ...r.data, rows } });
      }

      // Ask a question about one pool, server-side grounded.
      // Non-streaming on purpose: inside a drawer the answer is short, and a
      // stream buys nothing but failure modes.
      if (path === "/api/ask/pool" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const chain = String(b.chain ?? "");
        const address = String(b.address ?? "");
        const question = String(b.question ?? "").trim();
        if (!chain || !address) return json(res, { ok: false, error: "缺少 chain 或 address" }, 400);
        if (!question) return json(res, { ok: false, error: "问题为空" }, 400);

        const pc = await buildPoolContext(chain, address);
        if (!pc.ok) return json(res, { ok: false, error: pc.error ?? "池子数据不可用" }, 502);

        // Reuse the caller's session when given, so the exchange lands in the
        // conversation the user will actually look at later.
        let sessionId = typeof b.sessionId === "string" && b.sessionId
          ? String(b.sessionId)
          : "";
        if (sessionId && !getChatSession(sessionId)) sessionId = "";
        if (!sessionId) {
          const created = createChatSession(pc.title ? `关于 ${pc.title}` : "池子提问");
          sessionId = created.id;
        }

        const r = await sendChatMessage(sessionId, question, {
          chain,
          extraContext: pc.text,
        });
        if (!r.ok) return json(res, r, 400);

        return json(res, {
          ok: true,
          sessionId,
          answer: r.assistantMessage?.content ?? "",
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          model: r.model,
        });
      }

      if (path.startsWith("/api/pool/")) {
        const [, , , chain, addr] = path.split("/");
        const r = await poolDetail(chain, addr);
        if (!r.ok || !r.data) return json(res, r, 502);
        const score = computeScore(r.data, { capitalUsd: 2000, riskTier: 2 });
        const pools = await tokenPools(chain, r.data.baseAddress);
        return json(res, {
          ok: true,
          data: { ...r.data, score, siblings: pools.ok ? pools.data?.rows?.slice(0, 8) ?? [] : [] },
          facts: [...r.facts, ...score.gates.length ? [] : []],
          degraded: r.degraded,
          sources: r.sources,
          version: r.version,
          tookMs: r.tookMs,
        });
      }

      if (path.startsWith("/api/token/")) {
        const [, , , chain, addr] = path.split("/");
        const r = await tokenProfile(chain, addr);
        return json(res, r);
      }

      if (path === "/api/market") {
        const r = await marketSnapshot();
        return json(res, r);
      }

      if (path === "/api/watchlist" && req.method === "GET") {
        const chain = url.searchParams.get("chain") ?? undefined;
        return json(res, {
          ok: true,
          symbols: getWatchlistSymbols(),
          entries: listWatchlist(chain),
        });
      }

      // Add / remove. The read-only version above existed from the start, which
      // is why "加入关注" had nowhere to write and the nav item could never fill.
      if (path === "/api/watchlist" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const chain = String(b.chain ?? "");
        const address = String(b.address ?? "");
        if (!chain || !address) return json(res, { ok: false, error: "缺少 chain 或 address" }, 400);

        if (b.remove === true) {
          const removed = removeWatch(chain, address);
          return json(res, { ok: true, removed, watched: false, symbols: getWatchlistSymbols() });
        }

        if (!/^0x[0-9a-fA-F]{6,}$/.test(address)) {
          return json(res, { ok: false, error: "地址格式不正确" }, 400);
        }
        addWatch(chain, address, typeof b.label === "string" ? b.label : null);
        return json(res, { ok: true, watched: true, symbols: getWatchlistSymbols() });
      }

      if (path === "/api/refresh" && req.method === "POST") {
        const out = await refreshAll("manual");
        return json(res, { ok: true, ...out, jobs });
      }

      if (path === "/api/jobs") {
        const runs = all(
          `SELECT job,started_at,finished_at,status,error FROM ingest_runs ORDER BY started_at DESC LIMIT 20`,
        );
        return json(res, { ok: true, jobs, runs });
      }

      // ---- leaderboards ----
      if (path === "/api/leaderboard" && req.method === "GET") {
        const r = await buildLeaderboard(
          url.searchParams.get("chain") ?? DEFAULT_CHAIN,
          {
            limit: Number(url.searchParams.get("limit") ?? 8),
            capitalUsd: Number(url.searchParams.get("capital") ?? 2000),
          },
        );
        return json(res, r, r.ok ? 200 : 502);
      }

      // ---- auto rebalance ----
      if (path === "/api/auto/status" && req.method === "GET") {
        ensureSettingsTable();
        const last = one<any>(
          `SELECT created_at FROM notifications WHERE kind='auto_rebalance' ORDER BY created_at DESC LIMIT 1`,
        );
        return json(res, {
          ok: true,
          enabled: autoEnabled(),
          lastActionAt: last ? Number(last.created_at) : null,
        });
      }

      if (path === "/api/auto/toggle" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        if (typeof b.enabled !== "boolean") {
          return json(res, { ok: false, error: "缺少 enabled" }, 400);
        }
        setAutoEnabled(b.enabled);
        return json(res, { ok: true, enabled: autoEnabled() });
      }

      // Dry run by default. A caller must pass dryRun:false to actually trade,
      // so an accidental GET-like call cannot move funds.
      if (path === "/api/auto/run" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const r = await runAutoRebalance({
          dryRun: b.dryRun !== false,
          positionId: typeof b.positionId === "string" ? b.positionId : undefined,
        });
        return json(res, r, r.ok ? 200 : 502);
      }

      if (path === "/api/auto/policy" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const planId = String(b.planId ?? "");
        if (!planId) return json(res, { ok: false, error: "缺少 planId" }, 400);
        const row = one<any>(`SELECT payload FROM plans WHERE id=?`, planId);
        if (!row?.payload) return json(res, { ok: false, error: "计划不存在" }, 404);
        let payload: any;
        try { payload = JSON.parse(row.payload); } catch {
          return json(res, { ok: false, error: "计划数据损坏" }, 500);
        }
        payload.automation = resolvePolicy(b.automation ?? {});
        run(`UPDATE plans SET payload=? WHERE id=?`, JSON.stringify(payload), planId);
        return json(res, { ok: true, automation: payload.automation });
      }

      // ---- notifications (inbox) ----
      if (path === "/api/notifications" && req.method === "GET") {
        const unreadOnly = url.searchParams.get("unread") === "1";
        const kind = url.searchParams.get("kind") as any;
        return json(res, {
          ok: true,
          unread: unreadCount(),
          notifications: listNotifications({
            limit: Number(url.searchParams.get("limit") ?? 100),
            unreadOnly,
            kind: kind || undefined,
          }),
        });
      }

      if (path === "/api/notifications/read" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        if (b.all === true) markAllRead();
        else if (typeof b.id === "string" && b.id) markRead(b.id);
        else return json(res, { ok: false, error: "缺少 id" }, 400);
        return json(res, { ok: true, unread: unreadCount() });
      }

      // ---- position monitoring ----
      if (path === "/api/alerts" && req.method === "GET") {
        const includeAck = url.searchParams.get("all") === "1";
        ensureMonitorTables();
        return json(res, {
          ok: true,
          alerts: listAlerts(Number(url.searchParams.get("limit") ?? 50), includeAck),
        });
      }

      if (path === "/api/alerts/ack" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        if (b.all === true) ackAllAlerts();
        else if (typeof b.id === "string" && b.id) ackAlert(b.id);
        else return json(res, { ok: false, error: "缺少 id" }, 400);
        return json(res, { ok: true, alerts: listAlerts(50) });
      }

      if (path === "/api/monitor/checks" && req.method === "GET") {
        const pid = url.searchParams.get("positionId") ?? undefined;
        return json(res, { ok: true, checks: latestChecks(pid) });
      }

      if (path === "/api/monitor/digest" && req.method === "GET") {
        return json(res, { ok: true, digest: buildDailyDigest(DEFAULT_CHAIN) });
      }

      // Manual trigger. The hourly job runs itself, but a user staring at a
      // position should not have to wait up to an hour for a fresh reading.
      if (path === "/api/monitor/run" && req.method === "POST") {
        const r = await checkPositions(DEFAULT_CHAIN);
        for (const a of r.alerts) broadcast("alert", a);
        return json(res, r, r.ok ? 200 : 502);
      }

      // ---- research (M2) ----
      if (path === "/api/research" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const kind = b.kind === "news" ? "news" : "pool";
        if (!b.id) return json(res, { ok: false, error: "missing id" }, 400);

        // Spend gate before anything expensive happens. A cached report is
        // free, so let the client short-circuit on the cache endpoint first;
        // if it still asks, we count it only when the model actually runs.
        const budget = budgetAllows();
        if (!budget.ok) return json(res, { ok: false, error: budget.reason, budget: spendStatus() }, 429);

        const job = startResearch(kind, String(b.id), {
          capitalUsd: Number(b.capitalUsd ?? 2000),
          riskTier: Number(b.riskTier ?? 2) as 1 | 2 | 3,
          force: Boolean(b.force),
        });
        return json(res, { ok: true, job: { id: job.id, status: job.status, phase: job.phase }, budget: spendStatus() }, 202);
      }

      if (path === "/api/budget") {
        return json(res, { ok: true, ...spendStatus() });
      }

      // ---- AI assistant: chat ----
      if (path === "/api/chat/sessions" && req.method === "GET") {
        return json(res, { ok: true, sessions: listChatSessions() });
      }

      if (path === "/api/chat/sessions" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        return json(res, { ok: true, session: createChatSession(b.title) });
      }

      if (path.startsWith("/api/chat/sessions/") && req.method === "PATCH") {
        const id = decodeURIComponent(path.slice("/api/chat/sessions/".length));
        const b = await body(req).catch(() => ({}));
        if (!getChatSession(id)) return json(res, { ok: false, error: "会话不存在" }, 404);
        if (typeof b.title === "string" && b.title.trim()) renameChatSession(id, b.title);
        return json(res, { ok: true, session: getChatSession(id) });
      }

      if (path.startsWith("/api/chat/sessions/") && req.method === "DELETE") {
        const id = decodeURIComponent(path.slice("/api/chat/sessions/".length));
        if (!getChatSession(id)) return json(res, { ok: false, error: "会话不存在" }, 404);
        deleteChatSession(id);
        return json(res, { ok: true });
      }

      if (path.startsWith("/api/chat/sessions/") && path.endsWith("/messages") && req.method === "GET") {
        const id = decodeURIComponent(path.slice("/api/chat/sessions/".length, -"/messages".length));
        if (!getChatSession(id)) return json(res, { ok: false, error: "会话不存在" }, 404);
        return json(res, { ok: true, messages: listChatMessages(id), session: getChatSession(id) });
      }

      if (path === "/api/chat/send" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const sessionId = String(b.sessionId ?? "");
        const text = String(b.text ?? "");
        if (!sessionId) return json(res, { ok: false, error: "缺少 sessionId" }, 400);
        if (!text.trim()) return json(res, { ok: false, error: "消息为空" }, 400);
        const r = await sendChatMessage(sessionId, text, { chain: b.chain || undefined });
        return json(res, r, r.ok ? 200 : 400);
      }

      // Streaming chat. Uses POST + SSE rather than EventSource because the
      // request carries a message body; EventSource can only do GET.
      if (path === "/api/chat/stream" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const sessionId = String(b.sessionId ?? "");
        const text = String(b.text ?? "");
        if (!sessionId) return json(res, { ok: false, error: "缺少 sessionId" }, 400);
        if (!text.trim()) return json(res, { ok: false, error: "消息为空" }, 400);

        // Rebuild the pool context server-side from the ref, never from text the
        // client could have edited. The whole point is that the answer is
        // grounded in numbers we can point at.
        let extraContext: string | undefined;
        if (typeof b.poolRef === "string" && b.poolRef.includes(":")) {
          const [pchain, paddr] = b.poolRef.split(":");
          const pc = await buildPoolContext(pchain, paddr).catch(() => null);
          if (pc?.ok) extraContext = pc.text;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          // nginx buffers proxied responses by default, which would hold the
          // whole stream until the end and defeat the purpose.
          "x-accel-buffering": "no",
        });

        const send = (ev: Record<string, unknown>) => {
          if (res.writableEnded) return;
          try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* peer gone */ }
        };

        // Long answers can exceed proxy idle timeouts; a comment line keeps the
        // connection warm without polluting the event stream.
        const ping = setInterval(() => {
          if (res.writableEnded) return;
          try { res.write(": ping\n\n"); } catch { /* peer gone */ }
        }, 15000);

        // Tie model generation to the socket: if the user closes the tab, stop
        // paying for tokens nobody will read.
        //
        // Use `res`, not `req`. Measured: on Node 24 `req.on("close")` fires as
        // soon as the request BODY is consumed (about 4ms here) rather than when
        // the client disconnects — and this listener is attached after `body(req)`
        // has already drained it, so it never fires at all. A client hanging up
        // mid-answer therefore left the model running to completion: the user hit
        // stop, saw the reply end, and the server kept generating and saving a
        // full answer they never saw. `res.on("close")` fires at the real
        // disconnect (about 994ms in the same test).
        const ctl = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) ctl.abort();
        });

        try {
          await streamChatMessage(sessionId, text, {
            chain: b.chain || undefined,
            signal: ctl.signal,
            extraContext,
            onEvent: send,
          });
        } catch (e: any) {
          send({ type: "error", error: String(e?.message ?? e) });
        } finally {
          clearInterval(ping);
          if (!res.writableEnded) res.end();
        }
        return;
      }

      // ---- AI assistant: skills ----
      if (path === "/api/skills") {
        return json(res, { ok: true, skills: listSkills() });
      }

      if (path.startsWith("/api/skills/") && req.method === "POST") {
        const id = decodeURIComponent(path.slice("/api/skills/".length));
        const b = await body(req).catch(() => ({}));
        if (!listSkills().some((x) => x.id === id)) {
          return json(res, { ok: false, error: "技能不存在" }, 404);
        }
        setSkillEnabled(id, b.enabled !== false);
        return json(res, { ok: true, skills: listSkills() });
      }

      // ---- AI assistant: third-party links ----
      if (path === "/api/integrations" && req.method === "GET") {
        seedIntegrations();
        return json(res, { ok: true, integrations: listIntegrations() });
      }

      if (path === "/api/integrations" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        try {
          const it = upsertIntegration({
            id: b.id, name: b.name, kind: b.kind ?? "tool",
            url: b.url, status: b.status, note: b.note,
          });
          return json(res, { ok: true, integration: it, integrations: listIntegrations() });
        } catch (e: any) {
          return json(res, { ok: false, error: String(e?.message ?? e) }, 400);
        }
      }

      if (path.startsWith("/api/integrations/") && req.method === "DELETE") {
        const id = decodeURIComponent(path.slice("/api/integrations/".length));
        deleteIntegration(id);
        return json(res, { ok: true, integrations: listIntegrations() });
      }

      // ---- plans (M3) ----
      if (path === "/api/plan" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const ref = String(b.ref ?? "");
        const [chain, addr] = ref.split(":");
        if (!chain || !addr) return json(res, { ok: false, error: "missing pool ref" }, 400);

        const r = await planBuild(chain, addr, {
          capitalUsd: Number(b.capitalUsd ?? 2000),
          riskTier: Number(b.riskTier ?? 2) as 1 | 2 | 3,
          holdDays: Number(b.holdDays ?? 14),
          rangeHalfWidthPct: b.rangeHalfWidthPct !== undefined ? Number(b.rangeHalfWidthPct) : undefined,
          automation: b.automation && typeof b.automation === "object" ? b.automation : undefined,
          save: Boolean(b.save),
        });
        if (!r.ok) return json(res, r, 502);
        return json(res, r);
      }

      if (path === "/api/plans") {
        return json(res, { ok: true, plans: planList(Number(url.searchParams.get("limit") ?? 20)) });
      }

      // ---- onchainos bridge ----
      if (path === "/api/onchainos/status") {
        if (!onchainosInstalled()) {
          return json(res, { ok: true, installed: false, loggedIn: false, chain: DEFAULT_CHAIN, chainLabel: chainLabel(DEFAULT_CHAIN) });
        }
        const st = await walletStatus();
        let balances: any[] = [];
        let address: string | null = null;
        if (st.loggedIn) {
          const addrs = await walletAddresses(DEFAULT_CHAIN);
          address = addrs[0] ?? null;
          // primary chain first: that is where phase 1 funds live
          for (const ch of [DEFAULT_CHAIN, ...Object.keys(CHAINS).filter((c) => c !== DEFAULT_CHAIN)]) {
            const b = await chainBalance(ch);
            balances.push({ chain: ch, label: chainLabel(ch), totalValueUsd: b.totalValueUsd, tokens: b.tokens });
          }
        }
        return json(res, {
          ok: true, installed: true, ...st, address, balances,
          chain: DEFAULT_CHAIN, chainLabel: chainLabel(DEFAULT_CHAIN),
        });
      }

      // ---- portfolio (我的资产) ----
      if (path === "/api/positions") {
        const chain = url.searchParams.get("chain") ?? DEFAULT_CHAIN;
        // `sync=0` reads our table only: the UI polls this endpoint and we do
        // not want every poll to hit onchainos (rate limits + slow).
        const doSync = url.searchParams.get("sync") !== "0";
        let syncError: string | undefined;
        if (doSync) {
          const s = await syncPositions(chain);
          if (!s.ok) syncError = s.error;
        }
        const pf = getPortfolio(chain);
        const wallet = doSync ? (await walletAddresses(chain))[0] ?? null : null;
        const bal = doSync ? await chainBalance(chain) : null;
        return json(res, {
          ok: true,
          chain,
          chainLabel: chainLabel(chain),
          degradedReason: syncError,
          wallet,
          cash: bal ? { totalValueUsd: bal.totalValueUsd, tokens: bal.tokens } : null,
          ...pf,
        });
      }

      // ---- reviews ----
      // Facts are always served; the LLM layer is optional. A degraded review
      // still shows the arithmetic, so the user never gets nothing.
      if (path.startsWith("/api/review/position/") && path.endsWith("/facts")) {
        const id = decodeURIComponent(path.slice("/api/review/position/".length, -"/facts".length));
        const f = buildPositionFacts(id);
        if ("error" in f) return json(res, { ok: false, error: f.error }, 404);
        return json(res, { ok: true, facts: f });
      }

      if (path.startsWith("/api/review/position/") && req.method === "POST") {
        const id = decodeURIComponent(path.slice("/api/review/position/".length));
        const b = await body(req).catch(() => ({}));
        const r = await review("position", id, {
          force: b.force === true,
          ttlHours: Number(b.ttlHours ?? 6),
        });
        return json(res, r);
      }

      if (path === "/api/review/period" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const days = Number(b.days ?? 7);
        const end = Date.now();
        const start = end - days * 86_400_000;
        const r = await review("period", `p${days}d`, {
          force: b.force === true, startMs: start, endMs: end, ttlHours: 1,
        });
        return json(res, r);
      }

      if (path === "/api/review/period/facts") {
        const days = Number(url.searchParams.get("days") ?? 7);
        const end = Date.now();
        const f = buildPeriodFacts(end - days * 86_400_000, end);
        return json(res, { ok: true, facts: f });
      }

      if (path === "/api/review/style" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const r = await review("style", "global", { force: b.force === true, ttlHours: 1 });
        return json(res, r);
      }

      if (path === "/api/style") {
        const saved = loadStyleProfile();
        const override = styleScoreOverrides();
        return json(res, {
          ok: true,
          profile: saved?.profile ?? null,
          createdAt: saved?.createdAt ?? null,
          appliedToScoring: override.applied,
          applyBlockedReason: override.applied ? null : override.reason,
        });
      }

      if (path === "/api/reviews") {
        const kind = url.searchParams.get("kind");
        const rows = kind
          ? allReviewRows(kind, 30)
          : allReviewRows(null, 30);
        return json(res, { ok: true, reviews: rows });
      }

      if (path.startsWith("/api/position/") && path.endsWith("/events")) {
        const id = decodeURIComponent(path.slice("/api/position/".length, -"events".length - 1));
        return json(res, { ok: true, events: positionEvents(id) });
      }

      if (path.startsWith("/api/position/") && path.endsWith("/prepare") && req.method === "POST") {
        const id = decodeURIComponent(path.slice("/api/position/".length, -"prepare".length - 1));
        const b = await body(req).catch(() => ({}));
        const action = String(b.action ?? "withdraw");
        if (!["withdraw", "collect", "rebalance", "rebuild"].includes(action)) {
          return json(res, { ok: false, error: "action 必须是 withdraw / collect / rebalance / rebuild" }, 400);
        }
        const ratio = b.ratio == null ? 1 : Number(b.ratio);
        if (action === "withdraw" && !(ratio > 0 && ratio <= 1)) {
          return json(res, { ok: false, error: "ratio 必须在 (0, 1] 之间" }, 400);
        }

        // Rebalance is two confirmations on purpose: the withdraw releases the
        // capital, then the rebuild spends it. Splitting them means a failure
        // after step 1 leaves tokens in the wallet, never a half-built position.
        let r;
        if (action === "rebalance") {
          const half = b.halfWidthPct == null ? 3 : Number(b.halfWidthPct);
          r = await prepareRebalance(id, half);
        } else if (action === "rebuild") {
          r = await prepareRebuild(id);
        } else {
          r = await prepareClose(id, action as "withdraw" | "collect", ratio);
        }
        return json(res, r, r.ok ? 200 : 400);
      }

      if (path === "/api/onchainos/resolve") {
        const ref = String(url.searchParams.get("ref") ?? "");
        const [chain, addr] = ref.split(":");
        if (!chain || !addr) return json(res, { ok: false, error: "missing ref" }, 400);
        const d = await poolDetail(chain, addr);
        if (!d.ok || !d.data) return json(res, { ok: false, error: "pool unavailable" }, 502);
        const p: any = d.data;
        const r = await resolveInvestmentId({
          chain,
          baseSymbol: p.baseSymbol,
          quoteSymbol: p.quoteSymbol,
          feeTierPct: p.feeTierPct,
          tvlUsd: p.tvlUsd,
        });
        return json(res, { ok: r.ok, ...r });
      }

      // ---- execution (real money) ----
      // These MUST be matched before the generic /api/plan/<id> route, which
      // would otherwise treat "<id>/prepare" as a plan id.
      if (path.startsWith("/api/plan/") && path.endsWith("/prepare") && req.method === "POST") {
        const id = decodeURIComponent(path.slice("/api/plan/".length, -"prepare".length - 1));
        const b = await body(req).catch(() => ({}));
        const amount = Number(b.amount ?? 0);
        if (!(amount > 0)) return json(res, { ok: false, error: "金额必须大于 0" }, 400);
        // force + forceReason flow through so a blocked plan can still be traded,
        // but only deliberately and with the reason recorded server-side.
        const r = await prepareExecution(id, amount, {
          force: b.force === true,
          forceReason: typeof b.forceReason === "string" ? b.forceReason : undefined,
        });
        return json(res, r, r.ok ? 200 : 400);
      }

      if (path === "/api/execute/confirm" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const token = String(b.token ?? "");
        if (!token) return json(res, { ok: false, error: "missing token" }, 400);
        const r = await confirmExecution(token);
        // `needsCliConfirm` is a normal intermediate state, not a failure:
        // nothing was signed yet and the user must confirm once more. Returning
        // 500 here made the browser surface it as an error.
        const status = r.ok || r.needsCliConfirm ? 200 : 500;
        return json(res, r, status);
      }

      if (path === "/api/execute/cancel" && req.method === "POST") {
        const b = await body(req).catch(() => ({}));
        const ok = cancelExecution(String(b.token ?? ""));
        return json(res, { ok });
      }

      if (path.startsWith("/api/plan/")) {
        const id = decodeURIComponent(path.slice("/api/plan/".length));
        if (req.method === "POST") {
          const b = await body(req).catch(() => ({}));
          const status = String(b.status ?? "") as any;
          if (!["draft", "active", "closed", "cancelled"].includes(status)) {
            return json(res, { ok: false, error: "bad status" }, 400);
          }
          const p = planSetStatus(id, status);
          if (!p) return json(res, { ok: false, error: "not found" }, 404);
          return json(res, { ok: true, plan: p });
        }
        const p = planGet(id);
        if (!p) return json(res, { ok: false, error: "not found" }, 404);
        return json(res, { ok: true, plan: p });
      }

      if (path.startsWith("/api/research/")) {
        const id = decodeURIComponent(path.slice("/api/research/".length));
        const job = getJob(id);
        if (!job) return json(res, { ok: false, error: "job not found" }, 404);
        // while running, return light status so polling stays cheap
        if (job.status === "running") {
          return json(res, { ok: true, job: { id: job.id, status: job.status, phase: job.phase } });
        }
        return json(res, { ok: true, job });
      }

      if (path === "/api/research-jobs") {
        return json(res, { ok: true, jobs: listJobs() });
      }

      // Cached reports for a subject, so a reload does not re-bill the model
      if (path === "/api/research-cache") {
        const kind = url.searchParams.get("kind");
        const id = url.searchParams.get("id");
        if (!kind || !id) return json(res, { ok: false, error: "missing kind/id" }, 400);
        const row = one<any>(
          `SELECT * FROM analyses WHERE subject_type=? AND subject_id=? AND status='ok' ORDER BY created_at DESC LIMIT 1`,
          kind, id,
        );
        if (!row) return json(res, { ok: true, cached: false });
        return json(res, {
          ok: true,
          cached: true,
          report: JSON.parse(row.report),
          createdAt: row.created_at,
          model: row.model,
        });
      }

      if (path === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(`retry: 3000\n\n`);
        const c: Client = { id: ++clientId, res };
        clients.add(c);
        const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch { /* noop */ } }, 20000);
        req.on("close", () => { clearInterval(ping); clients.delete(c); });
        return;
      }

      return json(res, { error: "not found" }, 404);
    }

    // static
    const PAGES: Record<string, string> = {
      "/": "/index.html",
      "/login": "/login.html",
      "/assets": "/assets.html",
      "/review": "/review.html",
      "/assistant": "/assistant.html",
      "/notifications": "/notifications.html",
      "/leaderboard": "/leaderboard.html",
    };
    let file = PAGES[path] ?? path;
    if (file.includes("..")) return json(res, { error: "bad path" }, 400);
    const full = join(PUBLIC, file);
    if (!existsSync(full)) return json(res, { error: "not found" }, 404);
    const type = MIME[extname(full)] ?? "application/octet-stream";
    const buf = readFileSync(full);
    const isHtml = type.startsWith("text/html");
    res.writeHead(200, {
      "content-type": type,
      // HTML must never be cached: after logout the browser would otherwise
      // happily render a stale authenticated shell from disk.
      "cache-control": isHtml ? "no-store" : "no-cache",
      "x-robots-tag": "noindex, nofollow",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "same-origin",
    });
    res.end(buf);
  } catch (e: any) {
    console.error("ERR", path, e);
    if (!res.headersSent) json(res, { ok: false, error: String(e?.message ?? e) }, 500);
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`LP feed  http://${HOST}:${PORT}`);
  const n = one<{ c: number }>(`SELECT COUNT(*) c FROM feed_cards`);
  console.log(`cards in db: ${n?.c ?? 0}`);
  if (!n?.c) {
    console.log("empty db -> initial refresh");
    await refreshAll("boot");
  }

  // light scheduler: news every 10m, feed rebuild every 15m
  // NOTE: runJob returns a Promise, so it must be fire-and-forget inside the
  // callback. Calling .unref() on the promise throws and killed the server at
  // the 15-minute mark.
  setInterval(() => {
    runJob("news.ingest", async () => {
      const s = await newsIngest();
      return `${s.reduce((a, x) => a + x.inserted, 0)} 条新增`;
    }).then(() => broadcast("feed_stale", {}));
  }, 10 * 60_000).unref();

  setInterval(() => {
    runJob("feed.build", async () => {
      const r = await feedBuild({ capitalUsd: 2000, riskTier: 2 });
      broadcast("feed_new", { count: r.data?.inserted ?? 0 });
      return `${r.data?.count ?? 0} 张卡片`;
    }).catch((e) => console.error("feed.build failed", e?.message ?? e));
  }, 15 * 60_000).unref();

  // ── position monitoring ───────────────────────────────────────
  // Hourly, not continuously: a V3 position only changes state when price
  // crosses an edge, and that is not an millisecond-scale event. Hourly keeps
  // the chain calls cheap while still catching a break the same day it happens.
  //
  // Auto-rebalance is chained to this job rather than given its own timer, so
  // its decisions are always made on checks that were written moments earlier.
  // Two independent timers would eventually read a stale band position, and the
  // consequence here is moving real money based on yesterday's price.
  setInterval(() => {
    runJob("position.monitor", async () => {
      const r = await checkPositions(DEFAULT_CHAIN);
      if (!r.ok) throw new Error(r.error ?? "监控失败");
      for (const a of r.alerts) broadcast("alert", a);

      let autoNote = "";
      // Checked before calling in, so a disabled switch does not fill the job
      // log with hourly no-op rows.
      if (autoEnabled()) {
        try {
          const ar = await runAutoRebalance({ dryRun: false });
          if (ar.acted) broadcast("auto_rebalance", { count: ar.acted });
          autoNote = ` / 自动调仓 ${ar.acted} 个`;
        } catch (e: any) {
          // A failing automation must not take the monitor down with it: the
          // alerts above are already valuable on their own.
          console.error("auto_rebalance failed", e?.message ?? e);
          autoNote = " / 自动调仓异常";
        }
      }

      return `${r.checked} 个仓位 / ${r.alerts.length} 条新告警${autoNote}`;
    }).catch((e) => console.error("position.monitor failed", e?.message ?? e));
  }, 60 * 60_000).unref();

  // Daily digest shortly after local midnight. Offset by a few minutes so it
  // does not race the hourly check writing the same rows.
  setInterval(() => {
    const now = new Date();
    // 00:05 local — only once per day, guarded by the row-exists check inside.
    if (now.getHours() !== 0 || now.getMinutes() < 5) return;
    runJob("position.digest", async () => {
      const r = saveDailyDigest(DEFAULT_CHAIN);
      if (r.saved) broadcast("digest", { day: r.day });
      return r.summary;
    }).catch((e) => console.error("position.digest failed", e?.message ?? e));
  }, 10 * 60_000).unref();

  // First pass shortly after boot so a restart does not leave the book
  // unmonitored until the next top of hour.
  setTimeout(() => {
    runJob("position.monitor", async () => {
      const r = await checkPositions(DEFAULT_CHAIN);
      if (!r.ok) throw new Error(r.error ?? "监控失败");
      for (const a of r.alerts) broadcast("alert", a);

      // Wait a moment after boot instead of acting instantly: a crash loop would
      // otherwise re-trigger automation on every restart, and the position would
      // be re-centred repeatedly with no human ever seeing it happen.
      if (autoEnabled()) {
        const recent = one<any>(
          `SELECT created_at FROM notifications
           WHERE kind='auto_rebalance' AND level='success' ORDER BY created_at DESC LIMIT 1`,
        );
        const tooSoon = recent && Date.now() - Number(recent.created_at) < 30 * 60_000;
        if (!tooSoon) {
          try {
            const ar = await runAutoRebalance({ dryRun: false });
            if (ar.acted) broadcast("auto_rebalance", { count: ar.acted });
            return `${r.checked} 个仓位 / ${r.alerts.length} 条新告警 / 自动调仓 ${ar.acted} 个`;
          } catch (e: any) {
            console.error("auto_rebalance failed on boot", e?.message ?? e);
          }
        }
        return `${r.checked} 个仓位 / ${r.alerts.length} 条新告警 / 自动调仓跳过（30 分钟内已执行）`;
      }

      return `${r.checked} 个仓位 / ${r.alerts.length} 条新告警`;
    }).catch(() => {});
  }, 20_000).unref();
});
