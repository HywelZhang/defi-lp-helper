/**
 * Notification inbox.
 *
 * Deliberately not a push channel. There is no email/SMS/IM integration here
 * because none was configured, and inventing one would mean either spending the
 * user's money on a provider or silently delivering to nowhere. Instead every
 * thing worth interrupting someone for lands in a table the web UI reads, and a
 * future transport (mail, telegram, webhook) can consume the same rows without
 * changing any producer.
 *
 * Design points that matter:
 *
 *  - `notify()` is idempotent per `dedupeKey`. A monitor that fires hourly must
 *    not create 24 identical rows; the inbox would become noise and the real
 *    signal would be lost.
 *  - Severity is separate from read state. "Unread danger" is the query that
 *    matters for a badge; conflating the two loses the distinction.
 *  - A notification can point at a subject (position, plan, pool) so the UI can
 *    link somewhere useful instead of showing text with no destination.
 */

import { all, one, run } from "../db.ts";
import { sha } from "../util.ts";

export type NotifyLevel = "info" | "warn" | "danger" | "success";
export type NotifyKind =
  | "alert"          // monitor found something (out of range, drawdown, fees)
  | "auto_rebalance" // automation moved a position
  | "auto_skip"      // automation decided not to act, and why
  | "digest"         // daily summary
  | "system";        // anything else worth recording

export interface Notification {
  id: string;
  kind: NotifyKind;
  level: NotifyLevel;
  title: string;
  body: string | null;
  /** where this came from, e.g. "monitor" | "auto_rebalance" */
  source: string | null;
  subjectType: string | null;
  subjectId: string | null;
  /** optional deep link inside the app */
  href: string | null;
  createdAt: number;
  readAt: number | null;
  meta: unknown;
}

export function ensureNotifyTable() {
  run(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    level TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    source TEXT,
    subject_type TEXT,
    subject_id TEXT,
    href TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    dedupe_key TEXT NOT NULL,
    meta TEXT
  )`);
  run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notify_dedupe ON notifications(dedupe_key)`);
  run(`CREATE INDEX IF NOT EXISTS idx_notify_unread ON notifications(read_at, created_at DESC)`);
}

function rowToNotification(r: any): Notification {
  let meta: unknown = null;
  if (r.meta) { try { meta = JSON.parse(r.meta); } catch { meta = null; } }
  return {
    id: r.id,
    kind: r.kind as NotifyKind,
    level: r.level as NotifyLevel,
    title: r.title,
    body: r.body,
    source: r.source,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    href: r.href,
    createdAt: Number(r.created_at),
    readAt: r.read_at ? Number(r.read_at) : null,
    meta,
  };
}

/**
 * Record a notification, at most once per dedupe key.
 *
 * Returns the row when newly created, null when it already existed. Callers
 * that care about "did the user just get told" can branch on that.
 */
export function notify(input: {
  kind: NotifyKind;
  level: NotifyLevel;
  title: string;
  body?: string;
  source?: string;
  subjectType?: string;
  subjectId?: string;
  href?: string;
  dedupeKey: string;
  meta?: unknown;
}): Notification | null {
  ensureNotifyTable();

  const existing = one<any>(`SELECT * FROM notifications WHERE dedupe_key=?`, input.dedupeKey);
  if (existing) return null;

  const id = "nt_" + sha(`${input.dedupeKey}:${Date.now()}`, 16);
  const now = Date.now();
  run(
    `INSERT INTO notifications
     (id,kind,level,title,body,source,subject_type,subject_id,href,created_at,read_at,dedupe_key,meta)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    id, input.kind, input.level, input.title, input.body ?? null,
    input.source ?? null, input.subjectType ?? null, input.subjectId ?? null,
    input.href ?? null, now, input.dedupeKey,
    input.meta ? JSON.stringify(input.meta) : null,
  );

  return {
    id, kind: input.kind, level: input.level, title: input.title,
    body: input.body ?? null, source: input.source ?? null,
    subjectType: input.subjectType ?? null, subjectId: input.subjectId ?? null,
    href: input.href ?? null, createdAt: now, readAt: null, meta: input.meta ?? null,
  };
}

export function listNotifications(opts: {
  limit?: number;
  unreadOnly?: boolean;
  kind?: NotifyKind;
} = {}): Notification[] {
  ensureNotifyTable();
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.unreadOnly) where.push("read_at IS NULL");
  if (opts.kind) { where.push("kind=?"); vals.push(opts.kind); }
  const sql = `SELECT * FROM notifications
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at DESC LIMIT ?`;
  return all<any>(sql, ...vals, opts.limit ?? 100).map(rowToNotification);
}

export function unreadCount(): { total: number; danger: number } {
  ensureNotifyTable();
  const r = one<any>(
    `SELECT COUNT(*) total, SUM(CASE WHEN level='danger' THEN 1 ELSE 0 END) danger
     FROM notifications WHERE read_at IS NULL`,
  );
  return { total: Number(r?.total ?? 0), danger: Number(r?.danger ?? 0) };
}

export function markRead(id: string) {
  ensureNotifyTable();
  run(`UPDATE notifications SET read_at=? WHERE id=? AND read_at IS NULL`, Date.now(), id);
}

export function markAllRead() {
  ensureNotifyTable();
  run(`UPDATE notifications SET read_at=? WHERE read_at IS NULL`, Date.now());
}

/** Delete old read rows so the table does not grow forever. */
export function pruneNotifications(days = 30) {
  ensureNotifyTable();
  const cutoff = Date.now() - days * 86_400_000;
  run(`DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?`, cutoff);
}

/**
 * Per-day counter, used by automation to enforce "at most N actions today".
 *
 * Reads from the notifications table rather than keeping separate state, so the
 * limit and the audit trail can never disagree about how many times something
 * happened.
 */
export function countToday(kind: NotifyKind, subjectId?: string): number {
  ensureNotifyTable();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const r = subjectId
    ? one<any>(
      `SELECT COUNT(*) c FROM notifications WHERE kind=? AND subject_id=? AND created_at>=?`,
      kind, subjectId, start.getTime(),
    )
    : one<any>(
      `SELECT COUNT(*) c FROM notifications WHERE kind=? AND created_at>=?`,
      kind, start.getTime(),
    );
  return Number(r?.c ?? 0);
}
