/* LP Agent — M1 feed client. Plain ES module, no build step. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ── icons ──────────────────────────────── */
const ICONS = {
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8"/>',
  feed: '<path d="M4 6h16M4 12h10M4 18h13"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  layers: '<path d="M12 3l8 4.5-8 4.5-8-4.5L12 3zM4 12l8 4.5 8-4.5M4 16.5L12 21l8-4.5"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14h2"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  book: '<path d="M5 4h9a3 3 0 013 3v13H8a3 3 0 00-3 3V4z"/><path d="M5 20V4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrow: '<path d="M7 17L17 7M9 7h8v8"/>',
};
function mountIcons(root = document) {
  for (const el of $$("i[data-i]", root)) {
    const k = el.dataset.i;
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">${ICONS[k] ?? ""}</svg>`;
  }
}

/* ── formatting ─────────────────────────── */
const usd = (n, d = 2) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(d)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(d)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${n.toFixed(d)}`;
  return `$${n.toPrecision(3)}`;
};
const pct = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(d)}%`);
const ago = (sec) => {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Just enough markdown for a model answer: bold, inline code, bullets.
 *
 * `esc` first, so the model cannot inject HTML through its reply — the content
 * is untrusted even though we asked for it.
 */
const fmtMd = (text) => {
  let out = esc(text);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  out = out.replace(/^\s*[-*]\s+(.+)$/gm, "· $1");
  out = out.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br/>");
  return `<p>${out}</p>`;
};

/* ── state ──────────────────────────────── */
const state = {
  cards: [],
  filter: "",
  q: "",
  watch: [],
  freshIds: new Set(),
  compact: false,
  autoRefresh: true,
};

/* ── api ────────────────────────────────── */
const token = new URLSearchParams(location.search).get("token");
const H = token ? { "x-lp-token": token } : {};
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  // Read the body even on failure: the server puts the actionable reason in
  // `error` (e.g. "余额不足：需要 1，可用 0"). Throwing only the status code hid
  // every real cause behind "400 /api/...".
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body; fall through to the status message */
  }
  if (!res.ok) {
    const msg = data?.error || data?.degradedReason || `${res.status} ${path}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data ?? {};
}

/* ── card rendering ─────────────────────── */
function poolIcon(p) {
  return `${(p.baseSymbol || "?").slice(0, 2)}`;
}

function gradeBadge(g) {
  const map = { A: "a", B: "b", C: "c", D: "d", F: "warn" };
  return `<span class="badge ${map[g] ?? "d"}">${g}</span>`;
}

function renderPoolCard(c) {
  const p = c.payload;
  const chg = Number(p.priceChange24h ?? 0);
  const blocked = p.blocked?.length;
  return `
  <article class="card ${state.freshIds.has(c.id) ? "fresh" : ""}" data-id="${c.id}">
    <div class="card-top">
      <div class="card-icon">${esc(poolIcon(p))}</div>
      <div class="card-head">
        <div class="card-title" data-act="open" data-ref="${esc(c.refId)}">${esc(c.title)}</div>
        <div class="card-sub">
          <span>${esc(p.dex)}</span><span class="d">·</span>
          <span>池龄 ${p.ageDays ?? "—"}d</span><span class="d">·</span>
          <span>${esc(p.baseSymbol)}/USD</span>
        </div>
      </div>
      <div class="card-right">
        <div style="display:flex;align-items:center;gap:5px">
          ${gradeBadge(p.grade)}
          <span class="badge d">${p.score}</span>
        </div>
        <span class="time">${ago(c.createdAt)}</span>
      </div>
    </div>

    <div class="metrics">
      <div class="metric"><div class="metric-k">TVL</div><div class="metric-v">${usd(p.tvlUsd)}</div></div>
      <div class="metric"><div class="metric-k">24H VOL</div><div class="metric-v">${usd(p.vol24hUsd)}</div></div>
      <div class="metric"><div class="metric-k">FEE APR</div><div class="metric-v lime">${pct(p.feeAprPct, 1)}</div></div>
      <div class="metric"><div class="metric-k">换手</div><div class="metric-v">${p.turnover ?? "—"}x</div></div>
      <div class="metric"><div class="metric-k">24H</div><div class="metric-v ${chg >= 0 ? "pos" : "neg"}">${pct(chg)}</div></div>
    </div>

    <div class="card-why">${esc(p.reasons?.[0] ?? "")}</div>

    <div class="card-foot">
      <div class="tags">
        ${(c.tags || []).filter((t) => !["pool"].includes(t)).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
        ${blocked ? `<span class="badge warn">${blocked} 项拦截</span>` : ""}
        ${p.confidence !== null && p.confidence < 0.8 ? `<span class="badge c">置信 ${p.confidence}</span>` : ""}
      </div>
      <div class="card-actions">
        <button class="mini" data-act="open" data-ref="${esc(c.refId)}">深度调研</button>
        <button class="mini solid" data-act="plan" data-ref="${esc(c.refId)}">生成计划</button>
      </div>
    </div>
  </article>`;
}

function renderNewsCard(c) {
  const p = c.payload;
  const matched = p.matched?.length
    ? `<span class="badge watch">命中 ${p.matched.map(esc).join(" · ")}</span>`
    : "";
  return `
  <article class="card ${state.freshIds.has(c.id) ? "fresh" : ""}" data-id="${c.id}">
    <div class="card-top">
      <div class="card-icon news">${esc((p.source || "?").slice(0, 2).toUpperCase())}</div>
      <div class="card-head">
        <div class="card-title" data-act="news" data-url="${esc(p.url)}">${esc(c.title)}</div>
        <div class="card-sub">
          <span>${esc(p.source)}</span><span class="d">·</span>
          <span>${ago(p.publishedAt)}</span>
          ${p.alsoCoveredBy?.length ? `<span class="d">·</span><span>另 ${p.alsoCoveredBy.length} 源报道</span>` : ""}
        </div>
      </div>
      <div class="card-right">${matched}<span class="time">${esc(p.why ?? "")}</span></div>
    </div>
    ${p.summary ? `<div class="card-why">${esc(p.summary.slice(0, 180))}</div>` : ""}
    <div class="card-foot">
      <div class="tags">
        ${(p.entities || []).slice(0, 5).map((e) => `<span class="tag">${esc(e)}</span>`).join("")}
      </div>
      <div class="card-actions">
        <button class="mini" data-act="news" data-url="${esc(p.url)}">阅读原文</button>
        <button class="mini solid" data-act="news-research" data-url="${esc(p.url)}" data-title="${esc(c.title)}">AI 解读</button>
      </div>
    </div>
  </article>`;
}

function visibleCards() {
  let list = state.cards;
  if (state.filter === "watch") list = list.filter((c) => c.tags.includes("watch"));
  else if (state.filter === "high-score") list = list.filter((c) => c.tags.includes("high-score"));
  else if (state.filter) list = list.filter((c) => c.kind === state.filter);
  if (state.q) {
    const q = state.q.toLowerCase();
    list = list.filter((c) =>
      c.title.toLowerCase().includes(q) ||
      JSON.stringify(c.payload).toLowerCase().includes(q) ||
      (c.tags || []).some((t) => t.includes(q)));
  }
  // interleave: avoid 6 pool cards in a row by injecting news after 2 pools
  if (!state.filter && !state.q && !state.compact) list = interleave(list);
  return list;
}

function interleave(list) {
  const pools = list.filter((c) => c.kind === "pool");
  const news = list.filter((c) => c.kind === "news");
  const out = [];
  let pi = 0, ni = 0;
  while (pi < pools.length || ni < news.length) {
    for (let k = 0; k < 2 && pi < pools.length; k++) out.push(pools[pi++]);
    if (ni < news.length) out.push(news[ni++]);
    if (pi >= pools.length && ni < news.length) { while (ni < news.length) out.push(news[ni++]); }
  }
  return out;
}

function render() {
  const list = visibleCards();
  const stream = $("#stream");
  if (!list.length) {
    stream.innerHTML = `<div class="empty">没有匹配的卡片。${state.q ? "换个关键词试试。" : "等待下一轮抓取…"}</div>`;
    return;
  }
  stream.innerHTML = list.map((c) => (c.kind === "pool" ? renderPoolCard(c) : renderNewsCard(c))).join("");
  const pools = state.cards.filter((c) => c.kind === "pool");
  const best = pools.reduce((m, c) => Math.max(m, c.payload.score ?? 0), 0);
  $("#heroStats").innerHTML = `
    <div class="stat"><div class="stat-k">候选池</div><div class="stat-v">${pools.length}</div></div>
    <div class="stat"><div class="stat-k">已评分</div><div class="stat-v">${pools.length}</div></div>
    <div class="stat"><div class="stat-k">新闻卡</div><div class="stat-v">${state.cards.filter((c) => c.kind === "news").length}</div></div>
    <div class="stat"><div class="stat-k">最高分</div><div class="stat-v" style="color:var(--lime)">${best || "—"}</div></div>`;
  $("#streamFoot").textContent = `${list.length} 张卡片 · 数据延迟 ≤ 15 分钟 · 池子评分为确定性计算`;
  setTimeout(() => state.freshIds.clear(), 3500);
}

/* ── drawer ─────────────────────────────── */

/** News drawer: the subject is the article, and the AI reads it for LP impact. */
async function openNews(cardId) {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card) return;
  const p = card.payload ?? {};
  // `card.id` is the feed_cards row id; the research layer keys on
  // news_items.id, which is carried as refId. Mixing them returns
  // "news item not found" and silently degrades every news report.
  const newsId = card.refId;

  const drawer = $("#drawer");
  $("#drawerEyebrow").textContent = "NEWS · " + String(p.source ?? "").toUpperCase();
  $("#drawerTitle").textContent = card.title;
  $("#drawerSub").textContent = ago(p.publishedAt);
  $("#drawerBody").innerHTML = `<div class="loading">加载新闻上下文…</div>`;
  drawer.classList.add("on");
  $("#scrim").classList.add("on");

  const matched = (p.matched ?? []).length
    ? `<span class="badge watch">命中 ${p.matched.map(esc).join(" · ")}</span>`
    : "";

  $("#drawerBody").innerHTML = `
    <div class="dsec">
      <div class="ai-head">${matched}
        ${p.alsoCoveredBy?.length ? `<span class="badge d">另 ${p.alsoCoveredBy.length} 源报道</span>` : ""}
      </div>
      ${p.summary ? `<div class="card-why">${esc(p.summary)}</div>` : ""}
      <div class="tags">${(p.entities ?? []).map((e) => `<span class="tag">${esc(e)}</span>`).join("")}</div>
    </div>

    <div class="dsec" id="aiSection">
      <div class="dsec-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>AI 解读 · LP 视角</span>
        <button class="mini" id="btnResearch" style="padding:2px 8px;font-size:10px">生成</button>
      </div>
      <div id="aiBody"><div class="ai-hint">判断这条新闻对 LP 仓位意味着什么。若无直接关联，会明确说明。</div></div>
    </div>

    <div class="dsec" style="flex-direction:row;gap:8px">
      <button class="mini solid" style="flex:1;padding:9px" id="btnOpenNews">阅读原文 ↗</button>
    </div>
  `;

  $("#btnOpenNews")?.addEventListener("click", () => window.open(p.url, "_blank", "noopener"));
  loadCachedReport("news", newsId);
  $("#btnResearch").addEventListener("click", () => runResearch("news", newsId));
}

async function openPool(ref) {
  const [chain, addr] = ref.split(":");
  const drawer = $("#drawer");
  $("#drawerEyebrow").textContent = "POOL · BASE";
  $("#drawerTitle").textContent = "加载中…";
  $("#drawerSub").textContent = addr;
  $("#drawerBody").innerHTML = `<div class="loading">正在聚合数据…</div>`;
  drawer.classList.add("on");
  $("#scrim").classList.add("on");

  try {
    const r = await api(`/api/pool/${chain}/${addr}`);
    const d = r.data;
    const s = d.score;
    $("#drawerTitle").textContent = `${d.baseSymbol} / ${d.quoteSymbol}${d.feeTierPct !== null ? " " + d.feeTierPct + "%" : ""}`;
    $("#drawerSub").textContent = `${d.dex} · ${d.address}`;

    const series = d.series ?? [];
    const dims = s.dims.map((x) => `
      <div class="dim-row">
        <span class="dim-k">${x.label}</span>
        <div class="dim-track"><div class="dim-fill ${x.score < 45 ? "low" : ""}" style="width:${x.score}%"></div></div>
        <span class="dim-v">${x.score}</span>
      </div>`).join("");

    const gates = s.gates.map((g) =>
      `<span class="badge ${g.blocked ? (g.severity === "block" ? "warn" : "c") : "d"}">${g.blocked ? "✗" : "✓"} ${esc(g.label)}</span>`).join("");

    $("#drawerBody").innerHTML = `
      <div class="score-block">
        <div class="score-ring" style="--p:${s.total}">
          <div class="score-ring-in">
            <div class="score-num">${s.total}</div>
            <div class="score-lbl">${s.grade}</div>
          </div>
        </div>
        <div class="score-meta">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${gradeBadge(s.grade)}
            <span class="badge d">置信度 ${s.confidence}</span>
            <span class="badge d">${esc(r.version)}</span>
          </div>
          <div style="font-size:11.5px;color:var(--muted)">
            ${s.gates.some((g) => g.blocked && g.severity === "block") ? "存在硬门槛拦截，不建议入场" : "通过硬门槛"}
          </div>
        </div>
      </div>

      <div class="dsec">
        <div class="dsec-title">客观事实</div>
        <div class="kv">
          <div><div class="kv-k">TVL</div><div class="kv-v">${usd(d.tvlUsd)}</div></div>
          <div><div class="kv-k">24H 成交</div><div class="kv-v">${usd(d.vol24hUsd)}</div></div>
          <div><div class="kv-k">FEE APR（估算）</div><div class="kv-v" style="color:var(--lime)">${pct(d.feeAprPct, 1)}</div></div>
          <div><div class="kv-k">换手率</div><div class="kv-v">${d.turnover !== null ? Number(d.turnover).toFixed(3) : "—"}x</div></div>
          <div><div class="kv-k">价格</div><div class="kv-v">${usd(d.priceUsd, 6)}</div></div>
          <div><div class="kv-k">24H 涨跌</div><div class="kv-v" style="color:${(d.priceChange24h ?? 0) >= 0 ? "var(--green)" : "var(--red)"}">${pct(d.priceChange24h)}</div></div>
          <div><div class="kv-k">池龄</div><div class="kv-v">${d.ageDays?.toFixed(0) ?? "—"} 天</div></div>
          <div><div class="kv-k">费率档</div><div class="kv-v">${d.feeTierPct ?? "—"}%</div></div>
        </div>
      </div>

      ${series.length > 4 ? `<div class="dsec"><div class="dsec-title">价格 / 72h</div><canvas class="spark" id="spark"></canvas></div>` : ""}

      <div class="dsec">
        <div class="dsec-title">评分拆解 · ${esc(s.weightsVersion ?? "")}</div>
        <div class="dims">${dims}</div>
      </div>

      <div class="dsec">
        <div class="dsec-title">硬门槛</div>
        <div class="gate-list">${gates}</div>
      </div>

      <div class="dsec">
        <div class="dsec-title">判断（确定性，非 LLM）</div>
        <div class="reasons">${s.reasons.map((x) => `<div class="reason">${esc(x)}</div>`).join("")}</div>
      </div>

      ${s.risks.length ? `<div class="dsec"><div class="dsec-title">风险</div><div class="reasons">${s.risks.map((x) => `<div class="reason risk">${esc(x)}</div>`).join("")}</div></div>` : ""}

      <div class="dsec">
        <div class="dsec-title">同 token 其他池</div>
        <div class="kv" style="grid-template-columns:1fr">
          ${(d.siblings ?? []).slice(0, 5).map((p) => `
            <div style="display:flex;align-items:center;gap:8px;font-size:12px">
              <span style="font-family:var(--mono);color:var(--muted)">${esc(p.name).slice(0, 34)}</span>
              <span style="margin-left:auto;font-family:var(--mono)">${usd(p.tvlUsd)}</span>
              <span style="font-family:var(--mono);color:var(--lime)">${pct(p.feeAprPct, 1)}</span>
            </div>`).join("") || `<div style="font-size:12px;color:var(--muted-2)">无同 token 池数据</div>`}
        </div>
      </div>

      <div class="dsec" id="aiSection">
        <div class="dsec-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>AI 调研报告</span>
          <button class="mini" id="btnResearch" style="padding:2px 8px;font-size:10px">生成</button>
        </div>
        <div id="aiBody"><div class="ai-hint">基于确定性证据包生成，每条判断带引用，数字不可来自模型臆测。</div></div>
      </div>

      <div class="dsec ask-section">
        <div class="dsec-title">对这个池子有疑问？</div>
        <div class="ask-box">
          <textarea id="askInput" rows="1"
            placeholder="例如：现在这个波动水平下还值得进吗？"></textarea>
          <button class="mini solid" id="btnAsk">提问</button>
        </div>
        <div id="askAnswer"></div>
      </div>

      <div class="dsec" style="flex-direction:row;gap:8px">
        <button class="mini solid" id="btnPlanFromPool" style="flex:1;padding:9px">生成投资计划</button>
        <button class="mini" id="btnWatch" style="flex:1;padding:9px">加入关注</button>
        <a class="mini" style="flex:1;padding:9px;text-align:center" href="${esc(d.url)}" target="_blank" rel="noopener">GeckoTerminal ↗</a>
      </div>
    `;

    if (series.length > 4) drawSpark($("#spark"), series.map((x) => x.c));

    // auto-load a cached report if one exists; otherwise wait for the click
    loadCachedReport("pool", `${chain}:${addr}`);
    $("#btnResearch").addEventListener("click", () => runResearch("pool", `${chain}:${addr}`));

    bindPoolActions(chain, addr, d, s);
  } catch (e) {
    $("#drawerBody").innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * Wire the three buttons under a pool drawer.
 *
 * These were previously bare markup: `<button class="mini">生成投资计划</button>`
 * with no id, no data-act, and no listener. They rendered as real buttons and
 * did nothing when clicked — the worst kind of broken, because the UI claims an
 * affordance that does not exist.
 */
function bindPoolActions(chain, addr, pool, score) {
  // 1) Plan — reuses openPlan(ref) so the sizing form and the risk gate are the
  //    same ones the feed's "生成计划" button goes through.
  $("#btnPlanFromPool")?.addEventListener("click", () => {
    openPlan(`${chain}:${addr}`);
  });

  // 2) Watch — writes to the watchlist, which also feeds news relevance and the
  //    "与你相关" leaderboard. Reflects current state instead of assuming off.
  const btn = $("#btnWatch");
  const setState = (watched) => {
    if (!btn) return;
    btn.textContent = watched ? "已在关注" : "加入关注";
    btn.classList.toggle("solid", false);
    btn.style.color = watched ? "var(--lime)" : "";
    btn.dataset.watched = watched ? "1" : "0";
  };
  setState(false);

  api(`/api/watchlist?chain=${encodeURIComponent(chain)}`)
    .then((d) => {
      const hit = (d.entries ?? []).some(
        (e) => String(e.address).toLowerCase() === String(addr).toLowerCase(),
      );
      setState(hit);
    })
    .catch(() => { /* read failure leaves the button in its default state */ });

  btn?.addEventListener("click", async () => {
    const watched = btn.dataset.watched === "1";
    btn.disabled = true;
    try {
      await api("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chain,
          address: addr,
          label: pool?.name ?? null,
          remove: watched,
        }),
      });
      setState(!watched);
    } catch (e) {
      btn.textContent = "操作失败";
      setTimeout(() => setState(watched), 1800);
    } finally {
      btn.disabled = false;
    }
  });

  // 3) Ask — a question scoped to this pool. The context is rebuilt server-side
  //    from the address, so the answer is grounded in numbers rather than the
  //    generic book summary.
  const input = $("#askInput");
  const askBtn = $("#btnAsk");
  const box = $("#askAnswer");

  const ask = async () => {
    const q = String(input?.value ?? "").trim();
    if (!q || askBtn?.disabled) return;

    askBtn.disabled = true;
    askBtn.textContent = "思考中…";
    box.innerHTML = `<div class="ask-loading"><span class="spin"></span><span>基于这个池子的数据回答</span></div>`;

    try {
      const r = await api("/api/ask/pool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain, address: addr, question: q }),
      });
      box.innerHTML = `
        <div class="ask-q">${esc(q)}</div>
        <div class="ask-a">${fmtMd(r.answer ?? "")}</div>
        <a class="ask-more" href="/assistant?session=${encodeURIComponent(r.sessionId ?? "")}">在 AI 助手里继续这个对话 ↗</a>`;
      if (input) input.value = "";
      resizeAsk();
    } catch (e) {
      box.innerHTML = `<div class="ask-err">回答失败：${esc(e.message)}</div>`;
    } finally {
      askBtn.disabled = false;
      askBtn.textContent = "提问";
    }
  };

  askBtn?.addEventListener("click", ask);
  input?.addEventListener("keydown", (e) => {
    // Enter sends, Shift+Enter newline. isComposing guards Chinese IME, which
    // fires Enter to commit candidates and would otherwise send mid-word.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask();
    }
  });

  function resizeAsk() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }
  input?.addEventListener("input", resizeAsk);
  resizeAsk();
}

/* ── investment plan ────────────────────── */

const PLAN_VERDICT = {
  go:      { label: "可以执行", cls: "a" },
  caution: { label: "谨慎执行", cls: "c" },
  "no-go": { label: "不建议执行", cls: "warn" },
};

function openPlan(ref) {
  const [chain, addr] = ref.split(":");
  const drawer = $("#drawer");
  $("#drawerEyebrow").textContent = "PLAN · " + String(chain).toUpperCase();
  $("#drawerTitle").textContent = "生成投资计划";
  $("#drawerSub").textContent = addr;
  drawer.classList.add("on");
  $("#scrim").classList.add("on");

  // Sizing inputs live in the drawer because the plan is meaningless without
  // them: a "good" pool at 1/3 of TVL is a bad trade.
  $("#drawerBody").innerHTML = `
    <div class="dsec">
      <div class="dsec-title">参数</div>
      <div class="plan-form">
        <label><span>本金 (USD)</span>
          <input id="planCapital" type="number" min="50" step="100" value="2000" /></label>
        <label><span>持有天数</span>
          <input id="planDays" type="number" min="1" max="180" step="1" value="14" /></label>
        <label><span>区间宽度 ±%</span>
          <input id="planRange" type="number" min="2" max="60" step="1" placeholder="自动" /></label>
        <label><span>风险档</span>
          <select id="planRisk">
            <option value="1">1 · 保守</option>
            <option value="2" selected>2 · 均衡</option>
            <option value="3">3 · 激进</option>
          </select></label>
      </div>
      <div class="ai-hint">区间留空则按 30d 实现波动率自动取值（目标覆盖 70%）。所有数字都是确定性计算，非 AI 生成。</div>

      <!-- Standing automation. Declared here because "when should this position
           be re-centred" is part of the investment decision, not an ops setting
           buried elsewhere. Off by default: an unattended money-moving rule must
           be an explicit choice, not an inherited default. -->
      <div class="auto-block">
        <label class="auto-head">
          <input type="checkbox" id="autoOn" />
          <span>开仓后自动调仓（recenter）</span>
        </label>
        <div class="auto-fields" id="autoFields" hidden>
          <label><span>中心死区 ±%</span>
            <input id="autoTolerance" type="number" min="1" max="45" step="1" value="12" /></label>
          <label><span>调后区间 ±%</span>
            <input id="autoHalf" type="number" min="1" max="50" step="1" value="10" /></label>
          <label><span>每日最多</span>
            <input id="autoMax" type="number" min="1" max="10" step="1" value="2" /></label>
          <label><span>最小仓位 (USD)</span>
            <input id="autoMin" type="number" min="0" step="10" value="20" /></label>
        </div>
        <div class="ai-hint" id="autoHint">
          关闭。开启后，价格偏离区间中心超过死区时系统会自动撤出并重建区间，无需确认，会真实动用资金。
        </div>
      </div>
      <button class="mini solid" id="btnBuildPlan" style="padding:10px">生成计划</button>
    </div>
    <div id="planBody"></div>
  `;

  // Reveal the numeric fields only when automation is actually on. Leaving them
  // visible while disabled invites the user to tune values that will be ignored.
  $("#autoOn")?.addEventListener("change", (ev) => {
    const on = ev.currentTarget.checked;
    $("#autoFields").hidden = !on;
    const hint = $("#autoHint");
    if (hint) {
      hint.textContent = on
        ? "开启：价格偏离区间中心超过死区时，系统会自动撤出并重建区间，不需要确认，会真实动用资金。可在资产页随时关闭全局开关。"
        : "关闭。开启后，价格偏离区间中心超过死区时系统会自动撤出并重建区间，无需确认，会真实动用资金。";
      hint.style.color = on ? "var(--amber)" : "";
    }
  });

  $("#btnBuildPlan").addEventListener("click", async () => {
    const btn = $("#btnBuildPlan");
    const bodyEl = $("#planBody");
    btn.disabled = true;
    btn.textContent = "计算中…";
    bodyEl.innerHTML = `<div class="ai-progress"><span class="spin"></span><span>聚合池数据并计算</span></div>`;

    try {
      const range = $("#planRange").value.trim();
      const r = await api("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ref,
          capitalUsd: Number($("#planCapital").value || 2000),
          holdDays: Number($("#planDays").value || 14),
          riskTier: Number($("#planRisk").value || 2),
          rangeHalfWidthPct: range ? Number(range) : undefined,
          automation: $("#autoOn")?.checked
            ? {
              enabled: true,
              mode: "recenter",
              tolerancePct: Number($("#autoTolerance").value || 12),
              halfWidthPct: Number($("#autoHalf").value || 10),
              maxPerDay: Number($("#autoMax").value || 2),
              minValueUsd: Number($("#autoMin").value || 20),
            }
            : { enabled: false },
          save: true,
        }),
      });
      if (!r.ok) {
        bodyEl.innerHTML = `<div class="empty">生成失败：${esc(r.degradedReason ?? r.error ?? "未知")}</div>`;
        return;
      }
      bodyEl.innerHTML = renderPlan(r.data.payload, r.data.id);
      bindPlanActions(r.data.payload, r.data.id);
    } catch (e) {
      bodyEl.innerHTML = `<div class="empty">生成失败：${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "重新生成";
    }
  });
}

function renderPlan(p, planId) {
  const v = PLAN_VERDICT[p.verdict] ?? { label: p.verdict, cls: "d" };
  const pr = p.pool;

  const scen = p.expectations.scenarios.map((s) => `
    <tr>
      <td>${esc(s.label)}</td>
      <td class="num">${Math.round(s.captureRate * 100)}%</td>
      <td class="num">${usd(s.feeUsd)}</td>
      <td class="num ${s.netUsd >= 0 ? "pos" : "neg"}">${usd(s.netUsd)}</td>
      <td class="num ${s.netPct >= 0 ? "pos" : "neg"}">${pct(s.netPct, 2)}</td>
    </tr>`).join("");

  const ilRows = p.ilTable.map((x) => `
    <tr>
      <td class="num">${x.movePct > 0 ? "+" : ""}${x.movePct}%</td>
      <td class="num neg">${x.ilPct}%</td>
      <td class="num">${usd(x.ilUsd)}</td>
      <td class="num ${x.netUsdBase >= 0 ? "pos" : "neg"}">${usd(x.netUsdBase)}</td>
    </tr>`).join("");

  const checks = p.riskChecks.map((c) => `
    <div class="check ${c.pass ? "ok" : "bad"}">
      <span class="check-mark">${c.pass ? "✓" : "✗"}</span>
      <span class="check-label">${esc(c.label)}</span>
      <span class="check-detail">${esc(c.detail)}</span>
    </div>`).join("");

  const entry = p.entry.map((e) =>
    `<div class="reason"><b>${esc(e.condition)}</b><br/><span class="dim-note">${esc(e.rationale)}</span></div>`).join("");

  const exit = p.exit.map((e) =>
    `<div class="reason"><b>${esc(e.condition)}</b><br/><span class="dim-note">→ ${esc(e.action)}</span></div>`).join("");

  return `
    <div class="dsec plan-head">
      <div class="ai-head">
        <span class="badge ${v.cls}">${v.label}</span>
        <span class="badge d">${esc(pr.baseSymbol)}/${esc(pr.quoteSymbol)} ${pr.feeTierPct ?? ""}%</span>
        <span class="badge d">评分 ${esc(String(p.pool.score ?? ""))}</span>
      </div>
      <div class="ai-headline">${esc(p.summary)}</div>
    </div>

    <div class="dsec">
      <div class="dsec-title">区间与资金</div>
      <div class="kv">
        <div><div class="kv-k">投入本金</div><div class="kv-v">${usd(p.capital.deployedUsd)}${p.capital.capped ? ` <span class="badge c">已压缩</span>` : ""}</div></div>
        <div><div class="kv-k">区间宽度</div><div class="kv-v">±${p.range.halfWidthPct}% (${p.range.source === "manual" ? "手动" : "波动率"})</div></div>
        <div><div class="kv-k">下界价格</div><div class="kv-v">${p.range.lowerPrice}</div></div>
        <div><div class="kv-k">上界价格</div><div class="kv-v">${p.range.upperPrice}</div></div>
        <div><div class="kv-k">覆盖概率</div><div class="kv-v">${p.range.coverageProb ?? "?"}% / ${p.range.holdDays}天</div></div>
        <div><div class="kv-k">当前价</div><div class="kv-v">${pr.price}</div></div>
      </div>
      <div class="range-bar">
        <div class="range-fill" style="left:0;right:0"></div>
        <div class="range-mark" title="当前价"></div>
      </div>
    </div>

    <div class="dsec">
      <div class="dsec-title">收益情景（费用为上限估算）</div>
      <table class="plan-table">
        <thead><tr><th>情形</th><th>费率捕获</th><th>费用</th><th>净收益</th><th>净收益率</th></tr></thead>
        <tbody>${scen}</tbody>
      </table>
      <div class="dim-note">边界 IL ${usd(p.expectations.worstEdgeIlUsd)} · 费用覆盖边界 IL 需 ${p.expectations.breakevenDays ?? "?"} 天 · gas 假设 ${usd(p.expectations.gasUsd)}</div>
    </div>

    <div class="dsec">
      <div class="dsec-title">价格变动 vs 无常损失</div>
      <table class="plan-table">
        <thead><tr><th>价格变动</th><th>IL</th><th>IL 金额</th><th>净收益(基准)</th></tr></thead>
        <tbody>${ilRows}</tbody>
      </table>
    </div>

    <div class="dsec">
      <div class="dsec-title">入场条件</div>
      <div class="reasons">${entry}</div>
    </div>

    <div class="dsec">
      <div class="dsec-title">退出条件</div>
      <div class="reasons">${exit}</div>
    </div>

    <div class="dsec">
      <div class="dsec-title">风险检查</div>
      <div class="checks">${checks}</div>
    </div>

    <div class="dsec">
      <div class="dsec-title">链上坐标（可直接交给 onchainos）</div>
      ${p.ticks ? `
      <div class="kv">
        <div><div class="kv-k">token0</div><div class="kv-v">${esc(p.ticks.token0Symbol)}</div></div>
        <div><div class="kv-k">token1</div><div class="kv-v">${esc(p.ticks.token1Symbol)}</div></div>
        <div><div class="kv-k">tick lower</div><div class="kv-v">${p.ticks.tickLower}</div></div>
        <div><div class="kv-k">tick upper</div><div class="kv-v">${p.ticks.tickUpper}</div></div>
        <div><div class="kv-k">tick spacing</div><div class="kv-v">${p.ticks.spacing}</div></div>
        <div><div class="kv-k">宽度偏离</div><div class="kv-v">${p.ticks.widened ? "已外扩对齐" : "符合"}</div></div>
      </div>
      <div class="dim-note">价格按 token1/token0 计价，token 顺序按合约地址排序（非按符号）。tick 已对齐到 spacing=${p.ticks.spacing}，实际区间比 ±${p.range.halfWidthPct}% 略宽，不会比你要的更窄。</div>
      ` : `<div class="ai-hint">缺少 tick 坐标（token 地址或价格不可用），无法构造链上交易。</div>`}
    </div>

    <div class="dsec">
      <div class="dsec-title">执行入口</div>
      <div class="exec-box ${p.execution.ready ? "ready" : "blocked"}">
        <div class="exec-head">
          <span class="badge ${p.execution.ready ? "a" : "warn"}">${p.execution.ready ? "可下单" : "不可下单"}</span>
          <span class="dim-note">${esc(p.execution.provider)}${p.execution.investmentId ? " · ID " + esc(String(p.execution.investmentId)) : ""}</span>
        </div>
        <div class="dim-note" style="margin:6px 0">${esc(p.execution.note)}</div>
        ${p.execution.command ? `<pre class="cmd">${esc(p.execution.command)}</pre>` : ""}
      </div>
    </div>

    ${p.execution.available
      ? `<div class="dsec">
      <div class="dsec-title">真实下单</div>
      <div class="exec-warn">
        <b>这会动用真实资金</b>。下单经由 onchainos 钱包签名广播，不可撤回。
      </div>
      <div class="plan-form" style="margin-top:9px">
        <label><span>投入金额（${esc(p.pool.quoteSymbol)}）</span>
          <input id="execAmount" type="number" min="0.01" step="0.01"
                 value="${esc(String(p.capital.deployedUsd))}" /></label>
        <label><span>操作</span>
          <button class="mini solid" id="btnPrepare" style="padding:7px 9px">预览下单</button></label>
      </div>
      <div id="execPreview"></div>
    </div>`
      : `<div class="dsec">
      <div class="dsec-title">真实下单</div>
      <div class="exec-box blocked">
        <div class="dim-note">该池子未在 onchainos 收录，无法通过它下单。计划参数仍然有效，可用于手动建仓。</div>
        ${p.execution.unavailableReason ? `<div class="dim-note" style="margin-top:6px">原因：${esc(p.execution.unavailableReason)}</div>` : ""}
      </div>
    </div>`}

    <div class="dsec plan-actions">
      <button class="mini" style="flex:1;padding:10px" id="btnPlanCopy">复制参数</button>
    </div>
    <div class="dsec">
      <div class="ai-hint" id="planHint">计划已保存（${esc(planId ?? "")}）。${p.execution.available ? "预览会先校验余额并生成 calldata，确认前不会签名。" : "参数可复制后手动在 DEX 建仓。"}</div>
    </div>
  `;
}

/** Wire plan actions after the markup is in the DOM. */
/**
 * Wire the "I know the risk" override.
 *
 * The gate is not meant to make trading impossible — it is meant to make blind
 * trading impossible. Placing an order against a refused plan stays possible,
 * but only with a written reason that the server logs.
 */
function bindForceButton(box, planId, amount) {
  const btn = box.querySelector("#btnForce");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const reason = prompt(
      "强制下单会绕过上述全部检查，并在服务端留下记录。\n\n请写明理由（至少 4 个字）：",
    );
    if (reason === null) return;
    if (String(reason).trim().length < 4) {
      alert("理由太短，未通过。强制下单必须可追溯。");
      return;
    }

    box.innerHTML = `<div class="ai-progress"><span class="spin"></span><span>按强制模式生成 calldata…</span></div>`;

    let r;
    try {
      r = await api(`/api/plan/${encodeURIComponent(planId)}/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount, force: true, forceReason: reason }),
      });
    } catch (e) {
      box.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`;
      return;
    }

    const pv = r.preview;
    if (!pv) {
      box.innerHTML = `<div class="exec-box blocked"><div class="dim-note">生成失败</div></div>`;
      return;
    }

    const rows = (pv.steps ?? []).map((s) => `
      <tr>
        <td>${s.index + 1}</td>
        <td>${s.kind === "approve" ? "授权" : "存款"}</td>
        <td class="num">${esc(String(s.to).slice(0, 10))}…</td>
      </tr>`).join("");
    const legs = (pv.legs ?? []).map((l) => `
      <tr>
        <td>${esc(l.symbol)}</td>
        <td class="num">${esc(String(l.amountHuman))}</td>
        <td class="num">${esc(String(l.balance))}${l.enough ? "" : " 不足"}</td>
      </tr>`).join("");

    box.innerHTML = `
      <div class="exec-box blocked">
        <div class="exec-head">
          <span class="badge" style="background:rgba(245,181,68,.16);color:var(--amber,#f5b544)">强制模式</span>
          <span class="dim-note">${esc(pv.expiresInSec)} 秒内有效 · 理由已记录</span>
        </div>
        <div class="dim-note" style="margin:8px 0 4px">本次下单绕过了风险闸门：</div>
        <table class="mini-table">${legs}</table>
        <table class="mini-table">${rows}</table>
        <div style="display:flex;gap:8px;margin-top:9px">
          <button class="mini solid" id="btnForceConfirm" style="flex:1;padding:9px">确认执行（强制）</button>
          <button class="mini" id="btnForceCancel" style="padding:9px">取消</button>
        </div>
      </div>`;

    box.querySelector("#btnForceCancel")?.addEventListener("click", () => {
      box.innerHTML = `<div class="dim-note">已取消，未签名。</div>`;
    });

    box.querySelector("#btnForceConfirm")?.addEventListener("click", async (ev) => {
      const el = ev.currentTarget;
      el.disabled = true;
      el.textContent = "签名广播中…";
      try {
        const res = await api("/api/execute/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: r.confirmToken }),
        });
        if (res.ok) {
          const txs = (res.results ?? [])
            .map((x) => `<div class="reason">步骤 ${x.step + 1} 成功${x.txHash ? `：<code>${esc(String(x.txHash))}</code>` : ""}</div>`)
            .join("");
          box.innerHTML = `<div class="exec-box blocked">
            <div class="exec-head"><span class="badge">已强制成交</span></div>
            <div class="dim-note">这次交易违反了风险闸门，理由已写入服务端日志。</div>
            ${txs}
          </div>`;
          return;
        }
        if (res.needsCliConfirm) {
          el.disabled = false;
          el.textContent = "继续签名";
          box.querySelector(".dim-note:last-of-type")?.insertAdjacentHTML(
            "afterend",
            `<div class="dim-note" style="margin-top:7px">${esc(res.cliMessage ?? "需要再确认一次")}</div>`,
          );
          return;
        }
        box.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(res.error ?? "失败")}</div></div>`;
      } catch (e) {
        box.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`;
      }
    });
  });
}

function bindPlanActions(p, planId) {
  const hint = $("#planHint");

  $("#btnPrepare")?.addEventListener("click", async () => {
    if (!planId) return;
    const btn = $("#btnPrepare");
    const box = $("#execPreview");
    const amount = Number($("#execAmount").value || 0);
    if (!(amount > 0)) {
      if (hint) hint.textContent = "输入金额必须大于 0";
      return;
    }

    btn.disabled = true;
    btn.textContent = "校验中…";
    box.innerHTML = `<div class="ai-progress"><span class="spin"></span><span>校验余额并生成 calldata</span></div>`;

    let r;
    try {
      r = await api(`/api/plan/${encodeURIComponent(planId)}/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount }),
      });
    } catch (e) {
      // A refused plan comes back as HTTP 400 with a structured body. Letting the
      // generic handler swallow it meant the user saw one run-on sentence and no
      // override path at all.
      const d = e.data ?? {};
      if (Array.isArray(d.blockers) && d.blockers.length) {
        box.innerHTML = `
          <div class="exec-box blocked">
            <div class="exec-head">
              <span class="badge" style="background:rgba(245,181,68,.16);color:var(--amber,#f5b544)">已拦截</span>
              <span class="dim-note">这道闸在拦截亏损交易，不是故障</span>
            </div>
            <ul class="block-reasons">
              ${d.blockers.map((x) => `<li>${esc(x)}</li>`).join("")}
            </ul>
            ${d.canForce ? `<button class="mini" id="btnForce" style="margin-top:8px">我知道风险，仍要下单</button>` : ""}
          </div>`;
        bindForceButton(box, planId, amount);
        btn.disabled = false;
        btn.textContent = "预览下单";
        return;
      }
      box.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`;
      btn.disabled = false;
      btn.textContent = "预览下单";
      return;
    }

    try {
      if (!r.ok) {
        // Show every reason, not one sentence: "已拦截" alone leaves the user
        // guessing which number failed and by how much.
        const reasons = Array.isArray(r.blockers) && r.blockers.length ? r.blockers : null;
        if (!reasons) {
          box.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(r.error ?? "预览失败")}</div></div>`;
          return;
        }
        box.innerHTML = `
          <div class="exec-box blocked">
            <div class="exec-head">
              <span class="badge" style="background:rgba(245,181,68,.16);color:var(--amber,#f5b544)">已拦截</span>
              <span class="dim-note">这道闸在拦截亏损交易，不是故障</span>
            </div>
            <ul class="block-reasons">
              ${reasons.map((x) => `<li>${esc(x)}</li>`).join("")}
            </ul>
            ${r.canForce ? `<button class="mini" id="btnForce" style="margin-top:8px">我知道风险，仍要下单</button>` : ""}
          </div>`;

        bindForceButton(box, planId, amount);
        return;
      }

      const pv = r.preview;
      const rows = pv.steps.map((s) => `
        <tr>
          <td>${s.index + 1}</td>
          <td>${s.kind === "approve" ? "授权" : "存款"}</td>
          <td class="num" title="${esc(s.to)}">${esc(s.to.slice(0, 10))}…</td>
        </tr>`).join("");

      // Both legs must be visible: a V3 deposit debits the base token too,
      // even when only the quote amount was typed in.
      const legRows = (pv.legs ?? [])
        .map((l) => `<tr>
          <td>${esc(l.symbol)}</td>
          <td class="num">${esc(String(l.amountHuman))}</td>
          <td class="num" style="color:${l.enough ? "inherit" : "var(--danger,#e5564b)"}">${esc(String(l.balance))}${l.enough ? "" : " 不足"}</td>
        </tr>`)
        .join("");

      box.innerHTML = `
        <div class="exec-box ready">
          <div class="exec-head">
            <span class="badge a">待确认</span>
            <span class="dim-note">${esc(pv.expiresInSec)} 秒内有效</span>
          </div>
          <div class="dim-note" style="margin:8px 0 4px">V3 建仓需要两侧代币，实际会从下面两个币扣款：</div>
          <table class="plan-table">
            <thead><tr><th>代币</th><th>需要</th><th>可用</th></tr></thead>
            <tbody>${legRows}</tbody>
          </table>
          <div class="kv" style="margin:8px 0">
            <div><div class="kv-k">合计金额</div><div class="kv-v">$${Number(pv.totalValueUsd ?? 0).toFixed(4)}</div></div>
            <div><div class="kv-k">当前余额(${esc(p.pool.quoteSymbol)})</div><div class="kv-v">${esc(String(pv.balanceBefore))}</div></div>
            <div><div class="kv-k">交易步数</div><div class="kv-v">${pv.steps.length}</div></div>
          </div>
          <table class="plan-table">
            <thead><tr><th>#</th><th>类型</th><th>目标合约</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="dim-note" style="margin:7px 0">${esc(pv.estimatedGasNote)}</div>
          <div style="display:flex;gap:8px">
            <button class="mini solid" id="btnConfirmExec" style="flex:1;padding:9px">确认签名并广播</button>
            <button class="mini" id="btnCancelExec" style="padding:9px">取消</button>
          </div>
        </div>`;

      $("#btnCancelExec")?.addEventListener("click", async () => {
        await api("/api/execute/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: r.confirmToken }),
        }).catch(() => {});
        box.innerHTML = `<div class="dim-note">已取消，未签名。</div>`;
      });

      // Shared confirm runner. Both the first confirm and the CLI's
      // second-phase confirmation drive the SAME token: the server remembers
      // which step was already confirmed and retries it with --force.
      const runConfirm = async (btnEl, label) => {
        const original = btnEl.textContent;
        btnEl.disabled = true;
        btnEl.textContent = "签名广播中…";
        const cancelBtn = box.querySelector("#btnCancelExec");
        if (cancelBtn) cancelBtn.disabled = true;

        try {
          const res = await api("/api/execute/confirm", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: r.confirmToken }),
          });

          if (res.ok) {
            const txs = (res.results ?? [])
              .map((x) => `<div class="reason">步骤 ${x.step + 1} 成功${x.txHash ? `：<code>${esc(String(x.txHash))}</code>` : ""}</div>`)
              .join("");
            box.innerHTML = `<div class="exec-box ready">
              <div class="exec-head"><span class="badge a">已成交</span></div>
              ${txs}
            </div>`;
            if (hint) hint.textContent = "下单已完成，计划状态更新为 active。";
            return;
          }

          if (res.needsCliConfirm) {
            // Nothing was signed or broadcast at this point.
            const done = (res.results ?? [])
              .map((x) => `<div class="reason">步骤 ${x.step + 1} 已广播：<code>${esc(String(x.txHash ?? ""))}</code></div>`)
              .join("");
            box.innerHTML = `<div class="exec-box blocked">
              <div class="exec-head">
                <span class="badge warn">待二次确认</span>
                <span class="dim-note">第 ${(res.stepIndex ?? 0) + 1}/${res.totalSteps ?? "?"} 步 · 尚未广播</span>
              </div>
              ${done}
              <div class="dim-note" style="margin:8px 0">${esc(res.cliMessage ?? "")}</div>
              <button class="mini solid" id="btnConfirmAgain" style="width:100%;padding:9px">我已核对，继续签名</button>
            </div>`;

            const again = $("#btnConfirmAgain");
            again?.addEventListener("click", () => runConfirm(again, "我已核对，继续签名"));
            if (hint) hint.textContent = "尚未广播。核对上面的提示后再次确认。";
            return;
          }

          const partial = (res.results ?? [])
            .map((x) => `<div class="reason">步骤 ${x.step + 1} ${x.ok ? "成功" : "失败"}${x.error ? "：" + esc(x.error) : ""}</div>`)
            .join("");
          box.innerHTML = `<div class="exec-box blocked">
            <div class="exec-head"><span class="badge warn">失败</span></div>
            <div class="dim-note">${esc(res.error ?? "")}</div>
            ${partial}
          </div>`;
        } catch (e) {
          box.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`;
        } finally {
          btnEl.disabled = false;
          btnEl.textContent = original || label;
        }
      };

      const firstBtn = $("#btnConfirmExec");
      firstBtn?.addEventListener("click", () => runConfirm(firstBtn, "确认签名并广播"));
    } catch (e) {
      box.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "预览下单";
    }
  });

  $("#btnPlanCopy")?.addEventListener("click", async () => {
    const text = JSON.stringify({
      pool: `${p.pool.chain}:${p.pool.address}`,
      name: p.pool.name,
      capitalUsd: p.capital.deployedUsd,
      rangePct: p.range.halfWidthPct,
      lowerPrice: p.range.lowerPrice,
      upperPrice: p.range.upperPrice,
      holdDays: p.range.holdDays,
      exitConditions: p.exit.map((e) => e.condition),
    }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      if (hint) hint.textContent = "参数已复制到剪贴板。";
    } catch {
      if (hint) hint.textContent = "复制失败，请手动选择文本。";
    }
  });
}

/* ── AI research ────────────────────────── */

const VERDICT_META = {
  avoid:    { label: "回避", cls: "warn" },
  watch:    { label: "观望", cls: "c" },
  consider: { label: "可考虑", cls: "b" },
  favor:    { label: "推荐", cls: "a" },
};

function renderReport(report, meta) {
  const v = VERDICT_META[report.verdict] ?? { label: report.verdict, cls: "d" };
  const block = (title, items, cls = "") => {
    if (!items?.length) return "";
    return `<div class="dsec">
      <div class="dsec-title">${title}</div>
      <div class="reasons">${items.map((x) =>
        `<div class="reason ${cls}">${esc(x.text)}${
          x.refs?.length ? `<span class="ref">${x.refs.slice(0, 2).map(esc).join(" · ")}</span>` : ""
        }</div>`).join("")}</div>
    </div>`;
  };

  return `
    <div class="ai-head">
      <span class="badge ${v.cls}">${v.label}</span>
      ${meta?.model ? `<span class="badge d">${esc(meta.model)}</span>` : ""}
      ${meta?.cached ? `<span class="badge d">缓存</span>` : ""}
    </div>
    <div class="ai-headline">${esc(report.headline)}</div>
    ${block("客观事实", report.objective)}
    ${block("判断", report.judgement)}
    ${block("行动计划", report.action)}
    ${block("风险", report.risks, "risk")}
    ${block("观察点", report.catalysts)}
    ${report.gaps?.length ? `<div class="dsec"><div class="dsec-title">不确定的部分</div>
      <div class="reasons">${report.gaps.map((g) => `<div class="reason gap">${esc(g)}</div>`).join("")}</div></div>` : ""}
  `;
}

async function loadCachedReport(kind, id) {
  try {
    const r = await api(`/api/research-cache?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
    if (r.cached && r.report) {
      $("#aiBody").innerHTML = renderReport(r.report, { cached: true, model: r.model });
      $("#btnResearch").textContent = "重新生成";
    }
  } catch { /* no cache is a normal state */ }
}

async function runResearch(kind, id) {
  const btn = $("#btnResearch");
  const bodyEl = $("#aiBody");
  if (!btn || !bodyEl) return;
  btn.disabled = true;
  btn.textContent = "分析中";
  bodyEl.innerHTML = `<div class="ai-progress">
    <span class="spin"></span>
    <span id="aiPhase">构建证据包</span>
  </div>`;

  try {
    const started = await api("/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, id, capitalUsd: 2000, riskTier: 2 }),
    });
    const jobId = started.job.id;

    // poll: the model call takes 15-30s, so poll rather than hold a request
    let job = null;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await api(`/api/research/${encodeURIComponent(jobId)}`);
      job = st.job;
      const phaseEl = $("#aiPhase");
      if (phaseEl && job.phase) phaseEl.textContent = job.phase;
      if (job.status !== "running") break;
    }

    if (!job || job.status === "running") {
      bodyEl.innerHTML = `<div class="empty">分析超时，请重试</div>`;
      return;
    }

    const res = job.result;
    if (res?.report) {
      bodyEl.innerHTML = renderReport(res.report, { model: res.model, cached: false });
    } else {
      // Downgrade path: show what is true, state what failed. Never invent.
      const why = res?.degradeReason ?? job.error ?? "未知错误";
      const issues = res?.validation?.issues ?? [];
      bodyEl.innerHTML = `
        <div class="dsec">
          <div class="degraded-note">
            <b>AI 段落已降级</b>：${esc(why)}<br/>
            下方事实与评分仍然可信（来自确定性计算），仅叙事部分不可用。
          </div>
          ${issues.length ? `<div class="reasons">${issues.slice(0, 5).map((i) =>
            `<div class="reason risk">${esc(i.code)}：${esc(i.detail)}</div>`).join("")}</div>` : ""}
        </div>`;
    }
  } catch (e) {
    bodyEl.innerHTML = `<div class="empty">生成失败：${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "重新生成";
  }
}

function drawSpark(canvas, values) {
  if (!canvas || !values.length) return;
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth || 560;
  const h = 70;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => h - 6 - ((v - min) / span) * (h - 12);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  const up = values[values.length - 1] >= values[0];
  grad.addColorStop(0, up ? "rgba(200,247,81,.24)" : "rgba(255,107,107,.22)");
  grad.addColorStop(1, "rgba(0,0,0,0)");

  ctx.beginPath();
  ctx.moveTo(x(0), y(values[0]));
  for (let i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
  ctx.strokeStyle = up ? "#c8f751" : "#ff6b6b";
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

function closeDrawer() {
  $("#drawer").classList.remove("on");
  $("#scrim").classList.remove("on");
}

/* ── side panels ────────────────────────── */
async function loadMarket() {
  try {
    const r = await api("/api/market");
    $("#market").innerHTML = (r.data?.rows ?? []).map((x) => `
      <div class="mkt-row">
        <div class="mkt-sym">${x.symbol.slice(0, 3)}</div>
        <div class="mkt-name">${x.symbol}<small>${x.confidence ? "conf " + x.confidence : ""}</small></div>
        <div class="mkt-price">${usd(x.price)}</div>
      </div>`).join("") || `<div class="loading">—</div>`;
  } catch { $("#market").innerHTML = `<div class="loading">行情不可用</div>`; }
}

async function loadSide() {
  const [wl, jobs] = await Promise.all([
    api("/api/watchlist").catch(() => ({ symbols: [] })),
    api("/api/jobs").catch(() => ({ jobs: {}, runs: [] })),
  ]);
  state.watch = wl.symbols ?? [];

  const hits = new Map();
  for (const c of state.cards) {
    for (const e of c.payload?.entities ?? []) hits.set(e, (hits.get(e) ?? 0) + 1);
    for (const m of c.payload?.matched ?? []) hits.set(m, (hits.get(m) ?? 0) + 1);
  }
  $("#watch").innerHTML = state.watch.map((s) =>
    `<span class="wchip ${hits.get(s) ? "hit" : ""}">${esc(s)}${hits.get(s) ? " " + hits.get(s) : ""}</span>`).join("");
  $("#watchCount").textContent = `${state.watch.length}`;

  $("#topics").innerHTML = state.watch.slice(0, 12).map((s) => `
    <div class="topic ${hits.get(s) ? "has-news" : ""}" data-sym="${esc(s)}">
      <span class="t-sym">${esc(s)}</span>
      <span>${hits.get(s) ? "相关动态" : "暂无动态"}</span>
      <span class="t-n">${hits.get(s) ?? 0}</span>
    </div>`).join("");

  const js = jobs.jobs ?? {};
  const list = Object.values(js);
  $("#jobs").innerHTML = (list.length ? list : [
    { name: "news.ingest", status: "idle", note: "等待" },
    { name: "feed.build", status: "idle", note: "等待" },
  ]).map((j) => `
    <div class="job ${j.status}">
      <span class="job-dot"></span>
      <span class="job-name">${esc(j.name)}</span>
      <span class="job-note">${esc(j.note ?? j.status)}</span>
    </div>`).join("");

  $("#connText").textContent = "已连接";
  $("#lastRefresh").textContent = new Date().toTimeString().slice(0, 5);
}

async function loadSources() {
  // derived from cards so users can see which outlets are actually in the pool
  const m = new Map();
  for (const c of state.cards) if (c.kind === "news") m.set(c.payload.source, (m.get(c.payload.source) ?? 0) + 1);
  $("#sources").innerHTML = [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `<div class="src"><span class="src-dot"></span>${esc(n)}<span class="src-n">${c}</span></div>`)
    .join("") || `<div class="loading">—</div>`;
}

/* ── data flow ──────────────────────────── */
async function loadFeed() {
  const r = await api("/api/feed?limit=60");
  state.cards = r.cards ?? [];
  render();
  loadSide();
  loadSources();
}

async function refresh() {
  const btn = $("#btnRefresh");
  btn.classList.add("busy");
  btn.innerHTML = `<i data-i="refresh"></i>抓取中…`;
  mountIcons(btn);
  try {
    await api("/api/refresh", { method: "POST" });
    await loadFeed();
    await loadMarket();
  } finally {
    btn.classList.remove("busy");
    btn.innerHTML = `<i data-i="refresh"></i>刷新`;
    mountIcons(btn);
  }
}

/* ── sse ────────────────────────────────── */
function connectStream() {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  const es = new EventSource(`/api/stream${q}`);
  es.addEventListener("feed_new", async (e) => {
    if (!state.autoRefresh) return;
    const before = new Set(state.cards.map((c) => c.id));
    await loadFeed();
    for (const c of state.cards) if (!before.has(c.id)) state.freshIds.add(c.id);
    render();
  });
  es.addEventListener("job", (e) => {
    const j = JSON.parse(e.data);
    loadSide();
  });
  es.addEventListener("notice", (e) => {
    const n = JSON.parse(e.data);
    console.warn("notice", n);
  });
  es.onerror = () => { $("#connText").textContent = "重连中…"; };
  es.onopen = () => { $("#connText").textContent = "已连接"; };
}

/* ── events ─────────────────────────────── */
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (act === "open") openPool(t.dataset.ref);
  if (act === "plan") openPlan(t.dataset.ref);
  if (act === "news") window.open(t.dataset.url, "_blank", "noopener");
  if (act === "news-research") {
    // Previously this opened a WETH pool — a placeholder that made "AI 解读"
    // look broken. It must open the news subject itself.
    const card = t.closest(".card");
    const id = card?.dataset.id;
    if (id) openNews(id);
  }
});

$("#closeDrawer").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
  if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); $("#search").focus(); }
});

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  $$("#tabs .tab").forEach((x) => x.classList.toggle("active", x === b));
  state.filter = b.dataset.kind;
  render();
});

let qTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 160);
});

$("#btnDensity").addEventListener("click", () => {
  state.compact = !state.compact;
  document.body.classList.toggle("compact", state.compact);
  render();
});
$("#autoRefresh").addEventListener("change", (e) => { state.autoRefresh = e.target.checked; });

/* ── boot ───────────────────────────────── */
mountIcons();

// Show who is signed in, and give a way out. The server already gated the
// page, so this is purely for orientation.
fetch("/api/auth/status", { credentials: "same-origin" })
  .then((r) => r.json())
  .then((d) => {
    if (d?.username) $("#userName").textContent = d.username;
  })
  .catch(() => {});

$("#btnLogout")?.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    location.replace("/login");
  }
});

loadFeed().then(() => {
  loadMarket();
  connectStream();

  // The leaderboard links here with ?ref=chain:poolAddress. Without this the
  // "查看" button landed on the feed with no detail open — a link that looks
  // functional and does nothing.
  const ref = new URLSearchParams(location.search).get("ref");
  if (ref && /^[a-zA-Z0-9_-]+:0x[0-9a-fA-F]+$/.test(ref)) {
    openPool(ref).catch(() => {
      // A pool can be delisted between the board being built and the click.
      // Say so instead of leaving a blank drawer.
      $("#drawerBody").innerHTML = `<div class="empty">该池子已不可用，可能已从行情源下架。</div>`;
      $("#drawer").classList.add("on");
      $("#scrim").classList.add("on");
    });
  }
}).catch((e) => {
  $("#stream").innerHTML = `<div class="empty">无法加载：${esc(e.message)}<br/>先运行 <code>node cli/lp.ts feed.build</code></div>`;
});
