/* LP Agent — 我的资产 (M2). Plain ES module, no build step. */

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
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
function mountIcons(root = document) {
  for (const el of $$("i[data-i]", root)) {
    const k = el.dataset.i;
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">${ICONS[k] ?? ""}</svg>`;
  }
}

const usd = (n, d = 2) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(d)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${n.toFixed(d)}`;
  if (a === 0) return "$0";
  return `$${n.toPrecision(3)}`;
};
/**
 * Bare number with fixed precision, no currency symbol.
 *
 * Prices inside a V3 band need 6 decimals to show a move: USDG/USDT sits at
 * 0.998829 and `usd()` would render that as "$1.00", hiding the very drift the
 * band exists to show.
 */
const num = (n, d = 6) =>
  n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : Number(n).toFixed(d);

const pct = (n, d = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(d)}%`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ts = (ms) => {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const EVENT_LABEL = {
  open: "建仓",
  withdraw: "平仓",
  collect: "领取手续费",
  range_adjust: "调区间",
  sync: "同步",
};

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}) } });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(data?.error || data?.degradedReason || `${res.status} ${path}`);
    err.data = data;
    throw err;
  }
  return data ?? {};
}

/* ── state ─────────────────────────────── */
let current = null;

/* ── render ────────────────────────────── */

function renderSummary(d) {
  const s = d.summary ?? {};
  $("#pfTotal").textContent = usd(s.totalValueUsd, 4);

  const cash = d.cash?.totalValueUsd;
  $("#pfSub").innerHTML = [
    `现金 ${cash == null ? "—" : usd(cash, 2)}`,
    `仓位 ${s.openCount ?? 0} 个`,
    d.wallet ? `<span class="mono-dim">${esc(d.wallet.slice(0, 6))}…${esc(d.wallet.slice(-4))}</span>` : "",
  ].filter(Boolean).join(" · ");

  const pnl = s.unrealizedPnlUsd;
  const pnlCls = pnl > 0 ? "up" : pnl < 0 ? "down" : "";
  $("#pfStats").innerHTML = `
    <div class="stat"><div class="stat-k">仓位市值</div><div class="stat-v">${usd(s.totalValueUsd, 4)}</div></div>
    <div class="stat"><div class="stat-k">投入成本</div><div class="stat-v">${usd(s.totalCostUsd, 4)}</div></div>
    <div class="stat"><div class="stat-k">浮动盈亏</div><div class="stat-v ${pnlCls}">${usd(pnl, 4)}<span class="stat-sub">${pct(s.unrealizedPnlPct)}</span></div></div>
    <div class="stat"><div class="stat-k">未领手续费</div><div class="stat-v">${usd(s.unclaimedFeesUsd, 4)}</div></div>
  `;

  $("#chainName").textContent = d.chainLabel ?? d.chain ?? "—";
  $("#posCount").textContent = `${(d.positions ?? []).length} 个`;
  $("#lastSync").textContent = new Date().toTimeString().slice(0, 5);

  if (d.degradedReason) {
    $("#degraded").innerHTML = `<div class="degraded-note">部分数据降级：${esc(d.degradedReason)}</div>`;
  } else {
    $("#degraded").innerHTML = "";
  }
}

function tokenLine(tokens) {
  if (!tokens?.length) return `<span class="mono-dim">—</span>`;
  return tokens
    .map((t) => `<span class="tok"><b>${esc(t.symbol)}</b> ${esc(String(Number(t.amount).toFixed(6)))}</span>`)
    .join(" ");
}

function eventItem(e) {
  const txs = (() => { try { return JSON.parse(e.tx_hashes || "[]"); } catch { return []; } })();
  // Two lines per event, not four. Stacking kind / time / amount / note / tx each
  // on its own row made every entry ~95px, so three of them alone outweighed the
  // entire rest of the card.
  const sub = [
    e.note ? `<span class="tl-note">${esc(e.note)}</span>` : "",
    ...txs.map((h) => `<code title="${esc(h)}">${esc(String(h).slice(0, 8))}…</code>`),
  ].filter(Boolean).join("");

  return `<li>
    <span class="tl-dot ${esc(e.kind)}"></span>
    <div class="tl-body">
      <div class="tl-head">
        <b>${esc(EVENT_LABEL[e.kind] ?? e.kind)}</b>
        <span class="tl-time">${ts(e.created_at)}</span>
        ${e.amount_usd != null ? `<span class="tl-amt">${usd(e.amount_usd, 4)}</span>` : ""}
      </div>
      ${sub ? `<div class="tl-sub">${sub}</div>` : ""}
    </div>
  </li>`;
}

// Newest three stay open; the rest fold away. A rebalanced position can carry
// a dozen events, which made one card taller than the screen and pushed its own
// action buttons out of reach.
const EVENTS_VISIBLE = 3;

function eventList(events) {
  if (!events?.length) return `<div class="mono-dim">暂无记录</div>`;
  const list = events; // already newest-first from the API
  const head = list.slice(0, EVENTS_VISIBLE);
  const rest = list.slice(EVENTS_VISIBLE);

  const headHtml = `<ol class="timeline">${head.map(eventItem).join("")}</ol>`;
  if (!rest.length) return headHtml;

  return `${headHtml}
    <details class="tl-more">
      <summary>查看更早的 ${rest.length} 条</summary>
      <ol class="timeline">${rest.map(eventItem).join("")}</ol>
    </details>`;
}

// These are the verdicts the research pipeline actually writes (verified against
// the analyses table): consider / watch / avoid. Anything else falls through to
// the raw value rather than being silently mislabelled.
const VERDICT_LABEL = {
  consider: { text: "可考虑", cls: "ok" },
  watch: { text: "观察", cls: "warn" },
  avoid: { text: "不建议", cls: "bad" },
};

/**
 * The research note behind this position. Without it the card is just numbers;
 * with it you can see why the position was opened at all.
 */
function analysisBlock(a) {
  if (!a || (!a.headline && !a.verdict)) return "";
  const v = VERDICT_LABEL[a.verdict] ?? { text: a.verdict ?? "—", cls: "" };
  // Folded by default: the verdict chip is the actionable part and stays on the
  // summary line, but the full rationale is several lines of prose that repeats
  // on every card and dwarfs the numbers the user actually came for.
  return `<details class="pos-analysis">
    <summary>
      <span class="va ${v.cls}">${esc(v.text)}</span>
      <span class="mono-dim">研究结论${a.createdAt ? ` · ${ts(a.createdAt)}` : ""}</span>
      <span class="ana-more">展开理由</span>
    </summary>
    ${a.headline ? `<div class="pos-analysis-text">${esc(a.headline)}</div>` : ""}
  </details>`;
}

function positionCard(p) {
  const open = p.status === "open";
  const pnlCls = p.pnlUsd > 0 ? "up" : p.pnlUsd < 0 ? "down" : "";
  const r = p.tokens?.[0] ? "" : "";
  const plan = p.plan;

  return `<article class="pos-card ${open ? "" : "closed"}" data-pos="${esc(p.id)}">
    <header class="pos-head">
      <div class="pos-title">
        <div class="pos-name">${esc(p.pool_name || p.platform_name || "未命名")}</div>
        <div class="pos-meta">
          <span class="badge ${open ? "a" : "c"}">${open ? "持有中" : "已平仓"}</span>
          <span class="mono-dim">${esc(p.platform_name ?? "")}</span>
          ${p.token_id ? `<span class="mono-dim">NFT #${esc(p.token_id)}</span>` : ""}
        </div>
      </div>
      <div class="pos-value">
        <div class="pos-amt">${usd(p.value_usd, 4)}</div>
        <div class="pos-pnl ${pnlCls}">${p.pnlUsd == null ? "—" : usd(p.pnlUsd, 4)} ${p.pnlPct == null ? "" : `(${pct(p.pnlPct)})`}</div>
      </div>
    </header>

    <div class="pos-grid">
      <div><div class="kv-k">投入成本</div><div class="kv-v">${p.costUsd == null ? "—" : usd(p.costUsd, 4)}</div></div>
      <div><div class="kv-k">持有成分</div><div class="kv-v">${tokenLine(p.tokens)}</div></div>
      <div><div class="kv-k">未领手续费</div><div class="kv-v">${usd(p.feesUsd ?? 0, 4)}</div></div>
      <div><div class="kv-k">关联计划</div><div class="kv-v">${plan ? `${esc(plan.id.slice(0, 8))}… <span class="grade-pill">${esc(plan.grade ?? "")}</span>` : `<span class="mono-dim">无</span>`}</div></div>
    </div>

    ${open && checksByPos[p.id] ? `<div class="pos-band">
      <div class="kv-k">价格区间 · 自动监控</div>
      ${bandBar(checksByPos[p.id])}
      <div class="mono-dim" style="margin-top:4px">
        现价 ${num(checksByPos[p.id].price, 6)} · 上次检查 ${checksByPos[p.id].checkedAt ? new Date(checksByPos[p.id].checkedAt).toTimeString().slice(0, 5) : "—"}
      </div>
    </div>` : ""}

    ${analysisBlock(p.analysis)}

    <div class="pos-events">
      <div class="pos-events-title">操作记录</div>
      ${eventList(p.events)}
    </div>

    ${open ? `<footer class="pos-actions">
      <button class="mini" data-act="collect" data-id="${esc(p.id)}">领取手续费</button>
      <button class="mini" data-act="rebalance" data-id="${esc(p.id)}">调区间</button>
      <button class="mini" data-act="withdraw" data-id="${esc(p.id)}">全部平仓</button>
    </footer>
    <div class="exec-slot" data-slot="${esc(p.id)}"></div>` : ""}
  </article>`;
}

/* ── automated monitoring ──────────────── */

let checksByPos = {};

const STATE_TEXT = {
  in: "区间内",
  near_lower: "接近下沿",
  near_upper: "接近上沿",
  out_below: "跌破下沿",
  out_above: "涨破上沿",
  unknown: "区间未知",
};

const STATE_CLS = {
  in: "ok",
  near_lower: "warn",
  near_upper: "warn",
  out_below: "bad",
  out_above: "bad",
  unknown: "dim",
};

/**
 * Where the price sits inside the band, as a bar.
 *
 * A percentage number alone does not convey "about to fall out"; the bar shows
 * it at a glance. The marker is clamped to the track even when the derived
 * price is pinned at an edge, which is what an out-of-range position looks like.
 */
function bandBar(c) {
  if (c.bandPos == null) return "";
  const pct = Math.max(0, Math.min(1, c.bandPos)) * 100;
  const out = c.state === "out_below" || c.state === "out_above";
  return `<div class="band">
    <div class="band-track">
      <div class="band-fill ${out ? "out" : ""}" style="width:${pct}%"></div>
      <div class="band-pin ${out ? "out" : ""}" style="left:${pct}%"></div>
    </div>
    <div class="band-labels">
      <span>${num(c.lower, 6)}</span>
      <span class="band-state ${STATE_CLS[c.state] ?? "dim"}">${STATE_TEXT[c.state] ?? c.state}</span>
      <span>${num(c.upper, 6)}</span>
    </div>
  </div>`;
}

function alertCard(a) {
  const when = new Date(a.createdAt);
  const hhmm = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  return `<div class="alert-row ${esc(a.level)}" data-alert="${esc(a.id)}">
    <div class="alert-level">${a.level === "danger" ? "!" : a.level === "warn" ? "▲" : "i"}</div>
    <div class="alert-body">
      <div class="alert-row-title">${esc(a.title)}</div>
      ${a.detail ? `<div class="alert-detail">${esc(a.detail)}</div>` : ""}
    </div>
    <div class="alert-side">
      <span class="alert-time">${hhmm}</span>
      <button class="alert-ack" data-ack="${esc(a.id)}" title="标记已读">✓</button>
    </div>
  </div>`;
}

async function loadAlerts() {
  try {
    const d = await api("/api/alerts");
    const list = d.alerts ?? [];
    const sec = $("#alertSection");
    if (!list.length) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;
    $("#alertCount").textContent = `${list.length} 条未读`;
    $("#alerts").innerHTML = list.map(alertCard).join("");

    for (const b of $$("[data-ack]")) {
      b.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const id = ev.currentTarget.dataset.ack;
        try {
          await api("/api/alerts/ack", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id }),
          });
          await loadAlerts();
        } catch (e) { /* keep the row; a failed ack is not worth an alert */ }
      });
    }
  } catch { /* monitoring is additive; never block the page on it */ }
}

/* ── automation panel ──────────────────── */

let autoState = { enabled: false, lastActionAt: null };

/**
 * Show the master switch and what it last did.
 *
 * `enabled: false` is the default and must be visually unmistakable: a user who
 * believes automation is watching a position when it is not is worse off than
 * one who knows they have to look themselves.
 */
async function loadAuto() {
  try {
    const d = await api("/api/auto/status");
    autoState = d;
    const on = Boolean(d.enabled);
    $("#autoState").textContent = on ? "已开启" : "已关闭";
    $("#autoState").style.color = on ? "var(--amber)" : "var(--muted-2)";
    $("#autoDot").className = `auto-dot ${on ? "on" : ""}`;
    $("#btnAutoToggle").textContent = on ? "关闭" : "开启";

    const last = d.lastActionAt
      ? `上次自动调仓 ${new Date(d.lastActionAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
      : "从未执行过自动调仓";

    $("#autoBody").innerHTML = on
      ? `<div class="auto-note warn">按每个计划声明的规则自动执行最近一次检查中满足条件的仓位，不需要确认。</div>
         <div class="auto-last">${esc(last)}</div>`
      : `<div class="auto-note">关闭中。仓位不会被自动调整；计划里的调仓规则只是记录，不会执行。</div>
         <div class="auto-last">${esc(last)}</div>`;
  } catch {
    $("#autoState").textContent = "读取失败";
  }
}

async function loadChecks() {
  try {
    const d = await api("/api/monitor/checks");
    checksByPos = {};
    for (const c of d.checks ?? []) checksByPos[c.positionId] = c;
  } catch { checksByPos = {}; }
}

function renderPositions(d) {
  const list = d.positions ?? [];
  if (!list.length) {
    $("#positions").innerHTML = `<div class="empty">还没有仓位。去 <a href="/">发现</a> 找池子生成计划并下单。</div>`;
    return;
  }
  $("#positions").innerHTML = list.map(positionCard).join("");
  bindActions();
}

/* ── actions ───────────────────────────── */

async function prepareAction(positionId, action, ratio, slot, extra = {}) {
  slot.innerHTML = `<div class="ai-progress"><span class="spin"></span><span>生成 calldata…</span></div>`;
  const pv = await api(`/api/position/${encodeURIComponent(positionId)}/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ratio, ...extra }),
  });
  renderPreview(pv, slot);
}

const STEP_LABEL = {
  "approve-erc20": "授权代币",
  "approve-nft": "授权 NFT",
  withdraw: "撤销流动性",
  deposit: "建仓/加流动性",
  collect: "领取",
  rebalance: "撤销流动性",
};

function renderPreview(pv, slot) {
  const p = pv.preview;
  slot.dataset.kind = p.kind ?? "";
  slot.dataset.positionId = p.positionId ?? "";
  const rows = p.steps.map((s) => `<tr>
      <td>${s.index + 1}</td>
      <td>${esc(STEP_LABEL[s.kind] ?? s.kind)}</td>
      <td class="num mono-dim" title="${esc(s.to)}">${esc(s.to.slice(0, 10))}…</td>
    </tr>`).join("");

  // Rebalance is deliberately two confirmations: withdraw first, rebuild second.
  // Showing both the current and the target range makes clear that the position
  // is being moved, not duplicated.
  const isRb = p.kind === "rebalance_withdraw" || p.kind === "rebalance_rebuild";
  const opLabel = p.kind === "rebalance_withdraw" ? "调仓第 1/2 步 · 撤出旧区间"
    : p.kind === "rebalance_rebuild" ? "调仓第 2/2 步 · 在新区间建仓"
    : p.kind === "withdraw" ? `平仓 ${Math.round((p.ratio ?? 1) * 100)}%`
    : "领取手续费";

  const rbDetail = isRb ? `
    <div class="kv" style="margin:8px 0">
      <div><div class="kv-k">当前区间</div><div class="kv-v">${p.fromTicks?.tickLower ?? "—"} .. ${p.fromTicks?.tickUpper ?? "—"}</div></div>
      <div><div class="kv-k">目标区间</div><div class="kv-v">${p.toTicks.tickLower} .. ${p.toTicks.tickUpper}</div></div>
      <div><div class="kv-k">目标价格</div><div class="kv-v">${p.targetPrices.lower.toFixed(4)} - ${p.targetPrices.upper.toFixed(4)}</div></div>
      <div><div class="kv-k">区间宽度</div><div class="kv-v">±${esc(String(p.halfWidthPct))}%</div></div>
    </div>` : `
    <div class="kv" style="margin:8px 0">
      <div><div class="kv-k">当前仓位</div><div class="kv-v">${usd(p.valueUsd, 4)}</div></div>
      <div><div class="kv-k">交易步数</div><div class="kv-v">${p.steps.length}</div></div>
    </div>`;

  slot.innerHTML = `<div class="exec-box ready">
    <div class="exec-head">
      <span class="badge a">待确认</span>
      <span class="dim-note">${esc(pv.expiresInSec)} 秒内有效</span>
    </div>
    <div class="kv" style="margin:8px 0">
      <div><div class="kv-k">操作</div><div class="kv-v">${esc(opLabel)}</div></div>
    </div>
    ${rbDetail}
    <table class="plan-table">
      <thead><tr><th>#</th><th>类型</th><th>目标合约</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="dim-note" style="margin:7px 0">${esc(p.estimatedGasNote)}</div>
    <div style="display:flex;gap:8px">
      <button class="mini solid" data-exec="${esc(pv.confirmToken)}" style="flex:1;padding:9px">确认签名并广播</button>
      <button class="mini" data-cancel="${esc(pv.confirmToken)}" style="padding:9px">取消</button>
    </div>
  </div>`;

  slot.querySelector("[data-cancel]")?.addEventListener("click", async (e) => {
    await api("/api/execute/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: e.target.dataset.cancel }),
    }).catch(() => {});
    slot.innerHTML = `<div class="dim-note">已取消，未签名。</div>`;
  });

  slot.querySelector("[data-exec]")?.addEventListener("click", (e) => {
    runConfirm(e.target.dataset.exec, slot);
  });
}

async function runConfirm(token, slot) {
  const btn = slot.querySelector("[data-exec]") || slot.querySelector("[data-again]");
  if (btn) { btn.disabled = true; btn.textContent = "签名广播中…"; }

  try {
    const res = await api("/api/execute/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

    if (res.ok) {
      const txs = (res.results ?? []).map((x) =>
        `<div class="reason">步骤 ${x.step + 1} 完成${x.txHash ? `：<code title="${esc(x.txHash)}">${esc(String(x.txHash).slice(0, 14))}…</code>` : ""}</div>`
      ).join("");

      // A rebalance withdraw is only half the job: the capital is now sitting in
      // the wallet, uninvested. Prompting for step 2 immediately is what keeps
      // a two-phase operation from silently stopping mid-way.
      if (slot.dataset.kind === "rebalance_withdraw") {
        slot.innerHTML = `<div class="exec-box ready">
          <div class="exec-head">
            <span class="badge warn">第 1/2 步完成</span>
            <span class="dim-note">资金已在钱包，尚未重新投入</span>
          </div>
          ${txs}
          <div class="dim-note" style="margin:8px 0">旧区间已撤出。现在需要在新区间重新建仓，否则资金会以两个稳定币的形式闲置。</div>
          <button class="mini solid" data-next-rebuild="${esc(slot.dataset.positionId)}" style="width:100%;padding:9px">继续第 2 步：在新区间建仓</button>
        </div>`;
        slot.querySelector("[data-next-rebuild]")?.addEventListener("click", async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = "生成 calldata…";
          try { await prepareAction(slot.dataset.positionId, "rebuild", 1, slot); }
          catch (e) { slot.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`; }
        });
        return;
      }

      slot.innerHTML = `<div class="exec-box ready"><div class="exec-head"><span class="badge a">已完成</span></div>${txs}</div>`;
      // refresh so the new event + balances show up
      setTimeout(load, 2500);
      return;
    }

    if (res.needsCliConfirm) {
      // Nothing signed yet — onchainos wants one more explicit confirmation.
      const done = (res.results ?? []).map((x) =>
        `<div class="reason">步骤 ${x.step + 1} 已广播：<code>${esc(String(x.txHash ?? "").slice(0, 14))}…</code></div>`
      ).join("");
      slot.innerHTML = `<div class="exec-box blocked">
        <div class="exec-head">
          <span class="badge warn">待二次确认</span>
          <span class="dim-note">第 ${(res.stepIndex ?? 0) + 1}/${res.totalSteps ?? "?"} 步 · 尚未广播</span>
        </div>
        ${done}
        <div class="dim-note" style="margin:8px 0">${esc(res.cliMessage ?? "")}</div>
        <button class="mini solid" data-again="${esc(token)}" style="width:100%;padding:9px">我已核对，继续签名</button>
      </div>`;
      slot.querySelector("[data-again]")?.addEventListener("click", () => runConfirm(token, slot));
      return;
    }

    const partial = (res.results ?? []).map((x) =>
      `<div class="reason">步骤 ${x.step + 1} ${x.ok ? "成功" : "失败"}${x.error ? "：" + esc(x.error) : ""}</div>`
    ).join("");
    slot.innerHTML = `<div class="exec-box blocked">
      <div class="exec-head"><span class="badge warn">失败</span></div>
      <div class="dim-note">${esc(res.error ?? "")}</div>${partial}
    </div>`;
  } catch (e) {
    slot.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`;
  }
}

function bindActions() {
  for (const btn of $$("[data-act]")) {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const slot = document.querySelector(`[data-slot="${id}"]`);
      if (!slot) return;

      if (act === "withdraw") {
        const ok = confirm("确认全部平仓？这会撤销全部流动性并取回两个代币，不可撤回。");
        if (!ok) return;
        btn.disabled = true;
        try { await prepareAction(id, "withdraw", 1, slot); }
        catch (e) { slot.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`; }
        finally { btn.disabled = false; }
        return;
      }
      if (act === "withdraw-half") {
        btn.disabled = true;
        try { await prepareAction(id, "withdraw", 0.5, slot); }
        catch (e) { slot.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`; }
        finally { btn.disabled = false; }
        return;
      }
      if (act === "collect") {
        btn.disabled = true;
        try { await prepareAction(id, "collect", 1, slot); }
        catch (e) { slot.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`; }
        finally { btn.disabled = false; }
        return;
      }
      if (act === "rebalance") {
        // Ask for the new width up front. The old range is worthless as a
        // default: reusing it would put the position straight back where it was.
        const raw = prompt("新区间宽度（±%，例如 5）", "5");
        if (raw === null) return;
        const half = Number(raw);
        if (!(half > 0 && half <= 50)) { slot.innerHTML = `<div class="exec-box blocked"><div class="dim-note">区间宽度必须在 (0, 50]% 之间</div></div>`; return; }

        const ok = confirm(
          `将把仓位调到以当前价格为中心的 ±${half}% 区间。\n\n这是两步操作：先撤出旧区间，再在新区间建仓。两步都要你确认。`
        );
        if (!ok) return;

        btn.disabled = true;
        try { await prepareAction(id, "rebalance", 1, slot, { halfWidthPct: half }); }
        catch (e) { slot.innerHTML = `<div class="exec-box blocked"><div class="dim-note">${esc(e.message)}</div></div>`; }
        finally { btn.disabled = false; }
      }
    });
  }
}

/* ── boot ──────────────────────────────── */

async function load(sync = true) {
  try {
    const d = await api(`/api/positions${sync ? "" : "?sync=0"}`);
    if (d.error) throw new Error(d.error);
    current = d;
    renderSummary(d);
    // Checks must land before the cards render, or the band appears a beat late.
    await loadChecks();
    renderPositions(d);
  } catch (e) {
    $("#positions").innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
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

  $("#btnLogout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login";
  });

  $("#btnSync")?.addEventListener("click", () => load(true));

  $("#btnMonitorRun")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "检查中…";
    try {
      const r = await api("/api/monitor/run", { method: "POST" });
      await loadChecks();
      await loadAlerts();
      renderPositions(current ?? { positions: [] });
      btn.textContent = r.checked ? `已检查 ${r.checked} 个` : "已检查";
    } catch (e) {
      btn.textContent = "检查失败";
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = "立即检查"; }, 2200);
    }
  });

  $("#btnAckAll")?.addEventListener("click", async () => {
    try {
      await api("/api/alerts/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      await loadAlerts();
    } catch { /* ignore */ }
  });

  $("#btnAutoToggle")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const next = !autoState.enabled;

    // Turning automation ON moves real money without further confirmation, so it
    // gets an explicit confirm. Turning it OFF never does — stopping should
    // always be frictionless.
    if (next && !confirm("开启自动调仓后，满足计划规则的仓位会在无人确认的情况下自动撤出并重建区间，会真实动用资金。\n\n确认开启？")) {
      return;
    }

    btn.disabled = true;
    try {
      await api("/api/auto/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      await loadAuto();
    } catch (e) {
      $("#autoState").textContent = "切换失败";
    } finally {
      btn.disabled = false;
    }
  });

  $("#btnAutoDry")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "演练中…";
    try {
      const r = await api("/api/auto/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      const decisions = r.decisions ?? [];
      const would = decisions.filter((d) => d.action === "rebalance");
      const blocked = decisions.filter((d) => d.action === "blocked");

      $("#autoBody").innerHTML = `
        <div class="auto-note">演练完成，未执行任何链上操作。</div>
        <div class="auto-last">
          ${decisions.length} 个仓位 · 会调仓 ${would.length} 个${blocked.length ? ` · 受阻 ${blocked.length} 个` : ""}
        </div>
        ${decisions.length ? `<div class="auto-decisions">${decisions.map((d) => `
          <div class="auto-decision ${esc(d.action)}">
            <span class="ad-name">${esc(d.poolName || d.positionId)}</span>
            <span class="ad-act">${d.action === "rebalance" ? "将调仓" : d.action === "blocked" ? "受阻" : "跳过"}</span>
            <span class="ad-why">${esc(d.reason)}</span>
          </div>`).join("")}</div>` : ""}`;
    } catch (e) {
      $("#autoBody").innerHTML = `<div class="auto-note">演练失败：${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "演练";
    }
  });

  await load(true);
  await loadAlerts();
  await loadAuto();
}

boot();
