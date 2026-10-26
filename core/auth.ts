/**
 * Authentication and spend protection.
 *
 * Design decisions that matter:
 *  - The password is only ever stored as a scrypt hash. No plaintext on disk,
 *    no plaintext in logs, no plaintext in the client bundle.
 *  - Sessions are server-side rows; the cookie carries a random token whose
 *    SHA-256 we store, so a DB leak does not hand out live sessions.
 *  - Login is rate-limited per IP, because a single-user site on a public
 *    tunnel WILL be brute-forced.
 *  - LLM spend is capped per day and per session. Login protects the site;
 *    the budget protects the wallet if the login is ever shared.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { one, run } from "./db.ts";

const AUTH_FILE = resolve(process.env.LP_AUTH_FILE ?? new URL("../data/auth.json", import.meta.url).pathname);

const COOKIE = "lp_session";
const SESSION_TTL_MS = 14 * 24 * 3600_000; // 14 days
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export interface AuthRecord {
  username: string;
  hash: string; // scrypt$N$r$p$saltB64$hashB64
  createdAt: number;
}

/* ── password ─────────────────────────────── */

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ── credentials file ─────────────────────── */

export function loadAuth(): AuthRecord | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf8")) as AuthRecord;
  } catch {
    return null;
  }
}

export function saveAuth(username: string, password: string): AuthRecord {
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  const rec: AuthRecord = { username, hash: hashPassword(password), createdAt: Date.now() };
  writeFileSync(AUTH_FILE, JSON.stringify(rec, null, 2), { mode: 0o600 });
  return rec;
}

export function authConfigured(): boolean {
  return loadAuth() !== null;
}

/* ── sessions ─────────────────────────────── */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createSession(username: string, meta: { ip?: string; ua?: string } = {}): {
  token: string;
  expiresAt: number;
} {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  run(
    `INSERT INTO sessions (token_hash, username, created_at, expires_at, ip, ua)
     VALUES (?,?,?,?,?,?)`,
    sha256(token), username, now, expiresAt, meta.ip ?? null, (meta.ua ?? "").slice(0, 200),
  );
  return { token, expiresAt };
}

export interface SessionInfo {
  username: string;
  createdAt: number;
  expiresAt: number;
}

export function readSession(token: string | null | undefined): SessionInfo | null {
  if (!token) return null;
  const row = one<any>(
    `SELECT username, created_at, expires_at FROM sessions WHERE token_hash = ?`,
    sha256(token),
  );
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    run(`DELETE FROM sessions WHERE token_hash = ?`, sha256(token));
    return null;
  }
  return { username: row.username, createdAt: row.created_at, expiresAt: row.expires_at };
}

export function destroySession(token: string | null | undefined) {
  if (!token) return;
  run(`DELETE FROM sessions WHERE token_hash = ?`, sha256(token));
}

export function purgeExpiredSessions() {
  run(`DELETE FROM sessions WHERE expires_at < ?`, Date.now());
}

/* ── cookies ──────────────────────────────── */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean, maxAgeSec: number): string {
  // httpOnly: JS cannot read it. SameSite=Lax: blocks cross-site POSTs while
  // keeping normal navigation working. Secure only over https — the tunnel
  // terminates TLS upstream, so we trust x-forwarded-proto for that.
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function sessionFromRequest(headers: { cookie?: string }): SessionInfo | null {
  return readSession(parseCookies(headers.cookie)[COOKIE]);
}

/* ── login rate limiting ──────────────────── */

interface Attempt { count: number; firstAt: number; lockedUntil: number }
const attempts = new Map<string, Attempt>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

export function loginBlocked(ip: string): { blocked: boolean; retryAfterSec: number } {
  const a = attempts.get(ip);
  if (!a) return { blocked: false, retryAfterSec: 0 };
  if (a.lockedUntil > Date.now()) {
    return { blocked: true, retryAfterSec: Math.ceil((a.lockedUntil - Date.now()) / 1000) };
  }
  if (Date.now() - a.firstAt > WINDOW_MS) {
    attempts.delete(ip);
    return { blocked: false, retryAfterSec: 0 };
  }
  return { blocked: false, retryAfterSec: 0 };
}

export function recordLoginFailure(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.firstAt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }
  a.count++;
  if (a.count >= MAX_FAILS) a.lockedUntil = now + LOCK_MS;
}

export function clearLoginFailures(ip: string) {
  attempts.delete(ip);
}

/* ── LLM spend budget ─────────────────────── */

/**
 * Research runs are the expensive operation. We cap them so a leaked password
 * (or an over-enthusiastic user) cannot drain the API balance overnight.
 */
export const BUDGET = {
  perDayGlobal: Number(process.env.LP_BUDGET_DAY ?? 120),
  perHourGlobal: Number(process.env.LP_BUDGET_HOUR ?? 25),
};

function bucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function spendStatus(): {
  day: string; usedToday: number; limitToday: number;
  usedHour: number; limitHour: number;
  tokensToday: number;
} {
  const now = Date.now();
  const day = bucket(new Date());
  const row = one<any>(`SELECT runs, tokens FROM llm_spend WHERE day = ?`, day) ?? { runs: 0, tokens: 0 };
  const hourRow = one<any>(
    `SELECT COUNT(*) c FROM analyses WHERE created_at > ?`,
    now - 3600_000,
  ) ?? { c: 0 };
  return {
    day,
    usedToday: row.runs ?? 0,
    limitToday: BUDGET.perDayGlobal,
    usedHour: hourRow.c ?? 0,
    limitHour: BUDGET.perHourGlobal,
    tokensToday: row.tokens ?? 0,
  };
}

export function budgetAllows(): { ok: boolean; reason?: string } {
  const s = spendStatus();
  if (s.usedToday >= s.limitToday) {
    return { ok: false, reason: `今日 AI 分析额度已用完（${s.usedToday}/${s.limitToday}），明日重置` };
  }
  if (s.usedHour >= s.limitHour) {
    return { ok: false, reason: `每小时上限 ${s.limitHour} 次，请稍后再试` };
  }
  return { ok: true };
}

export function recordSpend(tokens: number) {
  const day = bucket(new Date());
  run(
    `INSERT INTO llm_spend (day, runs, tokens) VALUES (?, 1, ?)
     ON CONFLICT(day) DO UPDATE SET runs = runs + 1, tokens = tokens + excluded.tokens`,
    day, tokens,
  );
}
