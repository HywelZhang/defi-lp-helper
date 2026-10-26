import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = resolve(process.env.LP_DB ?? new URL("../data/lp.db", import.meta.url).pathname);
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT,
  weight REAL DEFAULT 1.0,
  last_ok_at INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  summary TEXT DEFAULT '',
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  entities TEXT DEFAULT '[]',
  fingerprint TEXT NOT NULL,
  UNIQUE(source_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_news_pub ON news_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_fp ON news_items(fingerprint);

CREATE TABLE IF NOT EXISTS tokens (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  price_usd REAL,
  fdv_usd REAL,
  mcap_usd REAL,
  total_supply REAL,
  volume24h_usd REAL,
  image_url TEXT,
  cg_id TEXT,
  fetched_at INTEGER,
  PRIMARY KEY (chain, address)
);

CREATE TABLE IF NOT EXISTS pools (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  dex TEXT,
  name TEXT,
  base_symbol TEXT,
  quote_symbol TEXT,
  base_address TEXT,
  quote_address TEXT,
  fee_tier_pct REAL,
  created_at TEXT,
  fetched_at INTEGER,
  PRIMARY KEY (chain, address)
);

CREATE TABLE IF NOT EXISTS pool_snapshots (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price_usd REAL,
  price_change_24h REAL,
  tvl_usd REAL,
  vol_24h_usd REAL,
  vol_6h_usd REAL,
  vol_1h_usd REAL,
  tx_24h INTEGER,
  fee_apr_pct REAL,
  turnover REAL,
  raw TEXT,
  PRIMARY KEY (chain, address, ts)
);
CREATE INDEX IF NOT EXISTS idx_snap_pool_ts ON pool_snapshots(chain, address, ts DESC);

CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  title TEXT NOT NULL,
  score REAL,
  grade TEXT,
  confidence REAL,
  facts TEXT NOT NULL,
  gates_hit TEXT NOT NULL,
  reasons TEXT NOT NULL,
  weights_version TEXT NOT NULL,
  outcome_7d REAL,
  outcome_30d REAL,
  outcome_checked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reco_created ON recommendations(created_at DESC);

CREATE TABLE IF NOT EXISTS feed_cards (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT DEFAULT '',
  payload TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  rank_score REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL,
  UNIQUE(dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_feed_created ON feed_cards(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_kind ON feed_cards(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS analyses (
  cache_key TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  evidence_version TEXT NOT NULL,
  status TEXT NOT NULL,
  report TEXT NOT NULL,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at INTEGER NOT NULL,
  degraded INTEGER DEFAULT 0,
  degrade_reason TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- position | period | style
  subject_id TEXT NOT NULL,        -- position id, period key, or 'global'
  period_start INTEGER,
  period_end INTEGER,
  status TEXT NOT NULL,            -- ok | degraded | invalid
  facts TEXT NOT NULL,             -- deterministic layer, always trustworthy
  report TEXT,                     -- LLM layer, nullable when degraded
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at INTEGER NOT NULL,
  evidence_version TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  degrade_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_kind ON reviews(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_subject ON reviews(kind, subject_id, created_at DESC);

-- Trading style distilled from realised outcomes. Kept separate from reviews so
-- the scoring pipeline can read one small row instead of re-deriving history.
CREATE TABLE IF NOT EXISTS style_profile (
  id TEXT PRIMARY KEY,             -- always 'current'; history lives in reviews
  created_at INTEGER NOT NULL,
  positions_observed INTEGER NOT NULL,
  closed_observed INTEGER NOT NULL,
  risk_appetite INTEGER,           -- 1 conservative .. 3 aggressive
  prefer_symbols TEXT,             -- JSON array
  avoid_symbols TEXT,              -- JSON array
  median_hold_hours REAL,
  rebalance_frequency REAL,        -- rebalances per position
  win_rate REAL,
  avg_realised_pnl_pct REAL,
  fee_share_of_pnl REAL,           -- how much of gross came from fees
  evidence TEXT NOT NULL,          -- JSON: the facts the profile was derived from
  notes TEXT
);

-- ── AI assistant ─────────────────────────────────────────────
-- Named chat_sessions because the plain name sessions is the login table.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  skill_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_upd ON chat_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,              -- user | assistant
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  error TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_msg ON chat_messages(session_id, created_at);

-- Which skills are switched on. The catalogue itself lives on disk; only the
-- user's choice is state, so a new skill appears enabled by default.
CREATE TABLE IF NOT EXISTS skill_settings (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- Third-party platforms the assistant can talk about / link out to.
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- chain | dex | data | protocol | tool
  url TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',  -- connected | available | error | unknown
  note TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  inserted INTEGER DEFAULT 0,
  updated INTEGER DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_job ON ingest_runs(job, started_at DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  added_at INTEGER,
  PRIMARY KEY (chain, address)
);

-- Session tokens are stored hashed: copying the DB does not copy live logins.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

-- Daily LLM spend ledger, so the budget survives restarts.
CREATE TABLE IF NOT EXISTS llm_spend (
  day TEXT PRIMARY KEY,
  runs INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0
);

-- Investment plans. The payload column holds the full deterministic plan so a
-- saved plan stays reproducible even after scoring weights change.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  pool_name TEXT,
  capital_usd REAL,
  range_down_pct REAL,
  range_up_pct REAL,
  entry_price REAL,
  lower_price REAL,
  upper_price REAL,
  hold_days INTEGER,
  expected_fee_usd REAL,
  expected_il_usd REAL,
  net_usd REAL,
  breakeven_days REAL,
  score REAL,
  grade TEXT,
  risk_tier INTEGER,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  onchain_tx TEXT,
  activated_at INTEGER,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plans_created ON plans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status, created_at DESC);
/**
 * A live LP position we opened, plus an append-only log of what we did to it.
 *
 * Why duplicate what onchainos already knows: the chain only tells us the
 * CURRENT state. It cannot tell us which plan produced the position, what the
 * entry snapshot was, or why we exited. Those are our own decisions, and they
 * are exactly what "我的资产" needs to show next to each position.
 */
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  investment_id INTEGER NOT NULL,
  token_id TEXT,
  platform_id INTEGER,
  platform_name TEXT,
  pool_name TEXT,
  value_usd REAL,
  tokens_json TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  last_synced_at INTEGER,
  UNIQUE(chain, address, investment_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status, opened_at DESC);

/**
 * Append-only action log per position. Never updated in place: an audit trail
 * that can be rewritten is not an audit trail. kind covers open / withdraw /
 * collect / range_adjust, and payload keeps the numbers we saw at the time.
 */
CREATE TABLE IF NOT EXISTS position_events (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_usd REAL,
  tokens_json TEXT DEFAULT '[]',
  tx_hashes TEXT DEFAULT '[]',
  payload TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pevents_pos ON position_events(position_id, created_at DESC);
`);

export const now = () => Date.now();

export function one<T = Record<string, unknown>>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Record<string, unknown>>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Additive migrations.
 *
 * SQLite has no "ADD COLUMN IF NOT EXISTS", so guard on pragma results. Kept
 * idempotent: every boot runs this, and re-running must be a no-op.
 */
function ensureColumn(table: string, column: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

// Actual capital deployed, in USD. The plan stores what was *requested*
// (e.g. 50), which is not what got spent (e.g. 0.945). PnL must use the real
// cost or the portfolio shows a fake -$49 loss.
ensureColumn("positions", "cost_usd", "REAL");
ensureColumn("positions", "fees_usd", "REAL DEFAULT 0");
ensureColumn("positions", "last_value_usd", "REAL");

// Real spend of an executed plan, in USD. plans.capital_usd is what the user
// *asked* for (e.g. 50); this is what the chain actually took (e.g. 0.9456).
// PnL must use this, otherwise the portfolio invents a huge fake loss.
ensureColumn("plans", "real_cost_usd", "REAL");

// The onchainos investmentId a plan actually executed against. Storing it on
// the plan makes position<->plan linking exact (match on investmentId) instead
// of a fragile guess based on pool name or timestamps.
ensureColumn("plans", "investment_id", "INTEGER");

// Cash actually received when a position was closed, in USD. Closed positions
// must report realized PnL (proceeds - cost); using value_usd=0 made every
// closed position look like a total loss even when the money came back.
ensureColumn("positions", "proceeds_usd", "REAL");

// Rebalance intent: the tick range we want to move this position into.
// Set when a rebalance starts, consumed when the rebuild is prepared, and left
// in place on failure so the user can see what was being attempted.
ensureColumn("positions", "rebalance_json", "TEXT");

// Current tick range of a V3 position. Needed to show "旧区间 → 新区间" when
// rebalancing; without it the UI can only show where we are going, not where
// the position came from.
ensureColumn("positions", "tick_lower", "INTEGER");
ensureColumn("positions", "tick_upper", "INTEGER");

// PnL realized by rebalancing (withdraw value minus cost basis at that moment).
// Without this the row keeps charging the ORIGINAL cost against the NEW
// position, double-counting capital that already came back to the wallet.
ensureColumn("positions", "realized_pnl_usd", "REAL DEFAULT 0");

// Cash that a rebalance returned to the wallet but did not redeploy. The pool
// consumes both legs in proportion, so the offered amount is rarely fully used;
// the remainder is still the user's capital and must count toward PnL.
ensureColumn("positions", "cash_back_usd", "REAL DEFAULT 0");
