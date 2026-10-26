/* LP Agent — 榜单. Plain ES module, no build step. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const ICONS = {
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8"/>',
  feed: '<path d="M4 6h16M4 12h10M4 18h13"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  layers: '<path d="M12 3l8 4.5-8 4.5-8-4.5L12 3zM4 12l8 4.5 8-4.5M4 16.5L12 21l8-4.5"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14h2"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  book: '<path d="M5 4h9a3 3 0 013 3v13H8a3 3 0 00-3 3V4z"/><path d="M5 20V4"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/>',
};

function mountIcons(root = document) {
  for (const el of $$("i[data-i]", root)) {
    const k = el.dataset.i;
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">${ICONS[k] ?? ""}</svg>`;
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const usd = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};
const pct = (n, d = 1) =>
  n == null || !Number.isFinite(Number(n)) ? "—" : `${Number(n).toFixed(d)}%`;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}) } });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(data?.error || `${res.status}`);
  return data ?? {};
}

const state = { boards: [], active: "best", capital: 2000, loading: false };

function renderTabs() {
  $("#lbTabs").innerHTML = state.boards.map((b) => `
    <button class="lb-tab ${b.id === state.active ? "on" : ""}" data-board="${esc(b.id)}" title="${esc(b.intent)}">
      <span class="lb-tab-label">${esc(b.label)}</span>
      <span class="lb-tab-count">${b.count}</span>
    </button>`).join("");

  for (const b of $$(".lb-tab")) {
    b.addEventListener("click", () => {
      state.active = b.dataset.board;
      renderTabs();
      renderBoard();
    });
  }
}

function renderBoard() {
  const board = state.boards.find((b) => b.id === state.active) ?? state.boards[0];
  if (!board) {
    $("#lbBody").innerHTML = `<div class="lb-empty">没有可用的榜单数据</div>`;
    return;
  }

  $("#lbBody").innerHTML = `
    <div class="lb-intent"><b>${esc(board.label)}</b> — ${esc(board.intent)}</div>
    <div class="lb-list">
      ${board.items.map((it, i) => row(it, i)).join("")}
    </div>`;

  for (const el of $$(".lb-open")) {
    el.addEventListener("click", () => {
      const [chain, addr] = el.dataset.ref.split(":");
      // The feed page owns pool detail; hand it the ref it already understands.
      location.href = `/?ref=${encodeURIComponent(`${chain}:${addr}`)}`;
    });
  }
}

function row(it, i) {
  const grade = String(it.grade ?? "").toLowerCase();
  return `<div class="lb-row" data-ref="${esc(it.chain)}:${esc(it.address)}">
    <div class="lb-rank">${i + 1}</div>
    <div class="lb-main">
      <div class="lb-name">
        <b>${esc(it.name)}</b>
        <span class="lb-dex">${esc(it.dex)}</span>
        ${it.feeTierPct != null ? `<span class="lb-fee">${(it.feeTierPct * 100).toFixed(2)}%</span>` : ""}
      </div>
      <div class="lb-why">
        ${esc(it.why)}
        ${it.personal ? `<span class="lb-personal">· ${esc(it.personal)}</span>` : ""}
      </div>
    </div>
    <div class="lb-nums">
      <div class="lb-num">
        <div class="lb-num-k">TVL</div>
        <div class="lb-num-v">${usd(it.tvlUsd)}</div>
      </div>
      <div class="lb-num">
        <div class="lb-num-k">24h 成交</div>
        <div class="lb-num-v">${usd(it.vol24hUsd)}</div>
      </div>
      <div class="lb-num">
        <div class="lb-num-k">fee APR</div>
        <div class="lb-num-v hi">${pct(it.feeAprPct)}</div>
      </div>
    </div>
    <div class="lb-grade">
      <div class="lb-grade-badge ${esc(grade)}">${esc(it.grade)}</div>
      <div class="lb-grade-score">${it.score}</div>
    </div>
    <button class="lb-open" data-ref="${esc(it.chain)}:${esc(it.address)}">查看</button>
  </div>`;
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  $("#lbBody").innerHTML = `<div class="lb-empty">加载中…</div>`;

  try {
    const d = await api(`/api/leaderboard?limit=8&capital=${encodeURIComponent(state.capital)}`);
    state.boards = d.boards ?? [];

    const basis = $("#lbBasis");
    basis.textContent = d.personalNote ?? (d.personalized ? "已按你的历史习惯调整" : "全站数据");
    basis.classList.toggle("personal", Boolean(d.personalized));

    if (!state.boards.some((b) => b.id === state.active)) {
      state.active = state.boards[0]?.id ?? "best";
    }
    renderTabs();
    renderBoard();
  } catch (e) {
    $("#lbBody").innerHTML = `<div class="lb-empty">加载失败：${esc(e.message)}</div>`;
  } finally {
    state.loading = false;
  }
}

async function boot() {
  mountIcons();

  try {
    const s = await api("/api/auth/status");
    if (!s.authenticated) { location.href = "/login"; return; }
    $("#userName").textContent = s.username ?? "—";
  } catch {
    location.href = "/login";
    return;
  }

  $("#chainName").textContent = "X Layer";

  $("#btnLogout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login";
  });

  $("#btnRefresh")?.addEventListener("click", () => load());

  // Re-ranking on capital change is the point of the input: a $5 bet and a
  // $50k bet face different capacity limits, so the ordering should differ.
  const cap = $("#capitalInput");
  cap?.addEventListener("change", () => {
    const v = Number(cap.value);
    if (Number.isFinite(v) && v > 0) {
      state.capital = v;
      load();
    }
  });

  await load();
}

boot();
