/**
 * HTTP layer with hard rate limiting, retry/backoff and stale-cache fallback.
 * Public DeFi APIs throttle silently (wrong data, not errors) — so every
 * response carries a fetchedAt and callers must surface it.
 */

export interface FetchOpts {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  minIntervalMs?: number;
  cacheTtlMs?: number;
  accept?: string;
}

interface Bucket {
  nextAt: number;
}

const buckets = new Map<string, Bucket>();
const cache = new Map<string, { at: number; body: string }>();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle(key: string, minIntervalMs: number) {
  const b = buckets.get(key) ?? { nextAt: 0 };
  const t = Date.now();
  if (b.nextAt > t) await sleep(b.nextAt - t);
  b.nextAt = Date.now() + minIntervalMs;
  buckets.set(key, b);
}

export async function fetchText(
  url: string,
  opts: FetchOpts = {},
): Promise<{ ok: boolean; body: string; status: number; stale: boolean; error?: string }> {
  const {
    timeoutMs = 15000,
    retries = 2,
    headers = {},
    minIntervalMs = 0,
    cacheTtlMs = 0,
    accept = "application/json",
  } = opts;

  const ck = url;
  const cached = cache.get(ck);
  if (cacheTtlMs > 0 && cached && Date.now() - cached.at < cacheTtlMs) {
    return { ok: true, body: cached.body, status: 200, stale: false };
  }

  const host = new URL(url).host;
  let lastErr = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host, minIntervalMs);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(url, {
        headers: { accept, "user-agent": "defi-lp/0.1 (+research)", ...headers },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const body = await res.text();

      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after") ?? 0);
        lastErr = `429 rate limited`;
        await sleep(Math.min(30000, (ra || 2 ** attempt) * 1000));
        continue;
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        if (res.status >= 500) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        // 4xx (other than 429) is terminal; fall back to cache if present
        if (cached) return { ok: true, body: cached.body, status: res.status, stale: true, error: lastErr };
        return { ok: false, body: "", status: res.status, stale: false, error: lastErr };
      }

      if (cacheTtlMs > 0) cache.set(ck, { at: Date.now(), body });
      return { ok: true, body, status: res.status, stale: false };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      await sleep(400 * 2 ** attempt);
    }
  }

  if (cached) return { ok: true, body: cached.body, status: 0, stale: true, error: lastErr };
  return { ok: false, body: "", status: 0, stale: false, error: lastErr };
}

export async function fetchJson<T = any>(
  url: string,
  opts: FetchOpts = {},
): Promise<{ ok: boolean; data: T | null; stale: boolean; error?: string }> {
  const r = await fetchText(url, opts);
  if (!r.ok) return { ok: false, data: null, stale: r.stale, error: r.error };
  try {
    return { ok: true, data: JSON.parse(r.body) as T, stale: r.stale };
  } catch (e: any) {
    return { ok: false, data: null, stale: r.stale, error: "invalid json: " + e.message };
  }
}
