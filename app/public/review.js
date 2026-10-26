/* LP Agent — 复盘 (M4). Plain ES module, no build step. */

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

const usd = (n, d = 2) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(d)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${n.toFixed(d)}`;
  if (a === 0) return "$0";
  return `$${n.toFixed(Math.min(6, d + 4))}`;
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const ts = (ms) => {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

const VERDICT = {
  good: { text: "做对了", cls: "good" },
  bad: { text: "做错了", cls: "bad" },
  neutral: { text: "中性", cls: "neutral" },
  mixed: { text: "对错参半", cls: "mixed" },
};

/* ── renderers ─────────────────────────── */

function claimSection(title, items, cls = "") {
  if (!items?.length) return "";
  const rows = items.map((c) => `
    <div class="rv-claim">
      <span>${esc(c.text)}${c.refs?.length ? `<span class="refs">${c.refs.map(esc).join(" · ")}</span>` : ""}</span>
    </div>`).join("");
  return `<div class="rv-sec ${cls}">
    <div class="rv-sec-title">${esc(title)}</div>
    ${rows}
  </div>`;
}

function factsGrid(facts, keys) {
  const rows = keys
    .filter((k) => facts[k] !== null && facts[k] !== undefined && facts[k] !== "")
    .map((k) => {
      const v = facts[k];
      const isPnl = /盈亏|胜率/.test(k);
      let cls = "";
      if (isPnl) {
        const num = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
        if (Number.isFinite(num)) cls = num > 0 ? "up" : num < 0 ? "down" : "";
      }
      return `<div><div class="fk">${esc(k)}</div><div class="fv ${cls}">${esc(v)}</div></div>`;
    }).join("");
  return `<div class="rv-facts">${rows}</div>`;
}

function degradedNote(d) {
  if (!d) return "";
  return `<div class="rv-degraded">这份报告未通过校验，只展示可验证的事实层${d ? `：${esc(d)}` : ""}。改写过的模型输出不会被展示。</div>`;
}

function reviewCard(res, factKeys) {
  const r = res.report;
  const v = VERDICT[r?.verdict] ?? { text: r?.verdict ?? "—", cls: "" };
  const facts = res.facts?.facts ?? {};
  // Union of both: the facts layer declares what is unknowable, the report may
  // add its own. Showing only the report's list lets the model quietly drop the
  // reliability warning.
  const gaps = [...new Set([...(res.facts?.gaps ?? []), ...(r?.gaps ?? [])])];

  const meta = [
    res.cached ? "缓存" : "新生成",
    res.tokensIn ? `${res.tokensIn}/${res.tokensOut} tok` : "",
    res.tookMs ? `${(res.tookMs / 1000).toFixed(1)}s` : "",
  ].filter(Boolean).join(" · ");

  return `<article class="rv-card">
    <div class="rv-head">
      <div style="display:flex;flex-direction:column;gap:7px;flex:1 1 auto">
        <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
          <span class="rv-verdict ${v.cls}">${esc(v.text)}</span>
          <span class="mono-dim">${esc(res.subjectLabel ?? "")}</span>
        </div>
        <div class="rv-headline">${esc(r?.headline ?? "（无结论）")}</div>
      </div>
      <div class="rv-meta">${esc(meta)}</div>
    </div>

    ${factsGrid(facts, factKeys)}
    ${degradedNote(res.degraded ? (res.degradeReason ?? "") : "")}

    ${claimSection("哪里做对了", r?.whatWorked, "good")}
    ${claimSection("哪里做错了", r?.whatDidnt, "warn")}
    ${claimSection("钱去哪了", r?.costAnalysis)}
    ${claimSection("可复用的教训", r?.lesson)}
    ${claimSection("下次怎么做", r?.nextTime)}

    ${gaps?.length ? `<div class="rv-gaps">
      <div class="gk">这次复盘看不到什么</div>
      <ul>${gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>
    </div>` : ""}
  </article>`;
}

const POS_KEYS = ["池子", "状态", "持有小时", "投入成本", "已回收", "未投入现金", "盈亏", "盈亏比", "调仓次数", "计划评分", "计划等级", "计划预期净收益"];
const PERIOD_KEYS = ["统计区间", "天数", "仓位总数", "已平仓", "持有中", "投入成本合计", "已回收合计", "盈亏合计", "盈亏比", "盈利笔数", "亏损笔数", "胜率", "调仓总次数", "平均每仓调仓"];
const STYLE_KEYS = ["结论可靠", "不可靠原因", "观察仓位", "已平仓", "风险偏好", "持有中位数小时", "平均每仓调仓", "胜率", "平均盈亏比", "偏好代币", "回避代币"];

function busy(text) {
  return `<div class="rv-busy"><span class="spin"></span><span>${esc(text)}</span></div>`;
}

/* ── style banner ──────────────────────── */

async function loadStyleBar() {
  try {
    const d = await api("/api/style");
    const el = $("#styleBar");
    if (!d.profile) {
      el.className = "rv-stylebar off";
      el.innerHTML = `<span class="sb-icon">○</span><div>还没有交易风格档案。生成一次风格总结后，复盘结论才会开始影响推荐排序。</div>`;
      return;
    }
    const p = d.profile;
    if (d.appliedToScoring) {
      el.className = "rv-stylebar live";
      el.innerHTML = `<span class="sb-icon">●</span><div>
        <b>复盘正在影响推荐</b> · 风险偏好 <b>${esc(p.riskAppetite === 1 ? "保守" : p.riskAppetite === 3 ? "激进" : "平衡")}</b>
        ${p.preferSymbols?.length ? ` · 偏好 ${esc(p.preferSymbols.join(", "))}` : ""}
        ${p.avoidSymbols?.length ? ` · 回避 ${esc(p.avoidSymbols.join(", "))}` : ""}
        <div class="sb-note">基于 ${p.positionsObserved} 个仓位、观察窗口 ${p.observedSpanHours} 小时</div>
      </div>`;
    } else {
      el.className = "rv-stylebar off";
      el.innerHTML = `<span class="sb-icon">○</span><div>
        <b>复盘暂未影响推荐</b>
        <div class="sb-note">${esc(d.applyBlockedReason ?? "风格结论不可靠")}。样本不足时用风格去调评分，只会把噪音当成结论。</div>
      </div>`;
    }
  } catch (e) {
    $("#styleBar").className = "rv-stylebar off";
    $("#styleBar").innerHTML = `<span class="sb-icon">!</span><div>风格状态读取失败：${esc(e.message)}</div>`;
  }
}

/* ── position ──────────────────────────── */

let positionsLoaded = false;

async function loadPositions() {
  const sel = $("#posSelect");
  try {
    const d = await api("/api/positions?sync=0");
    const list = (d.positions ?? []);
    if (!list.length) {
      sel.innerHTML = `<option value="">还没有仓位</option>`;
      return;
    }
    sel.innerHTML = list.map((p) => {
      const tag = p.status === "open" ? "持有中" : "已平仓";
      const pnl = p.pnlPct == null ? "" : ` ${p.pnlPct > 0 ? "+" : ""}${p.pnlPct.toFixed(2)}%`;
      return `<option value="${esc(p.id)}">${esc(p.pool_name ?? "—")} · ${tag} · ${esc(usd(p.value_usd, 4))}${esc(pnl)}</option>`;
    }).join("");
    positionsLoaded = true;
  } catch (e) {
    sel.innerHTML = `<option value="">仓位读取失败</option>`;
  }
}

async function runPositionReview() {
  const id = $("#posSelect").value;
  const out = $("#posOut");
  if (!id) { out.innerHTML = `<div class="rv-empty">先选一个仓位</div>`; return; }
  out.innerHTML = busy("复盘生成中，需要 3-10 秒…");
  try {
    const res = await api(`/api/review/position/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    out.innerHTML = reviewCard(res, POS_KEYS);
    loadHistory();
    loadStyleBar();
  } catch (e) {
    out.innerHTML = `<div class="rv-empty">生成失败：${esc(e.message)}</div>`;
  }
}

/* ── period ────────────────────────────── */

async function runPeriodReview() {
  const days = Number($("#periodSel").value);
  const out = $("#periodOut");
  out.innerHTML = busy("汇总区间数据，生成中…");
  try {
    const res = await api("/api/review/period", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days, force: true }),
    });
    out.innerHTML = reviewCard(res, PERIOD_KEYS);
    loadHistory();
  } catch (e) {
    out.innerHTML = `<div class="rv-empty">生成失败：${esc(e.message)}</div>`;
  }
}

/* ── style ─────────────────────────────── */

async function runStyleReview(force = false) {
  const out = $("#styleOut");
  out.innerHTML = busy("正在归纳交易风格…");
  try {
    const res = await api("/api/review/style", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });
    out.innerHTML = reviewCard(res, STYLE_KEYS);
    loadHistory();
    loadStyleBar();
  } catch (e) {
    out.innerHTML = `<div class="rv-empty">生成失败：${esc(e.message)}</div>`;
  }
}

/* ── history ───────────────────────────── */

const KIND_LABEL = { position: "单笔", period: "阶段", style: "风格" };

async function loadHistory() {
  try {
    const d = await api("/api/reviews");
    const rows = d.reviews ?? [];
    $("#histCount").textContent = rows.length ? `(${rows.length})` : "";
    if (!rows.length) {
      $("#history").innerHTML = `<div class="rv-empty">还没有复盘记录</div>`;
      return;
    }
    $("#history").innerHTML = `<div class="rv-hist">${rows.map((r) => `
      <div class="rv-hist-row" data-id="${esc(r.id)}" data-kind="${esc(r.kind)}" data-subject="${esc(r.subjectId)}">
        <span class="hk">${esc(KIND_LABEL[r.kind] ?? r.kind)}</span>
        <span class="ht">${esc(r.report?.headline ?? r.subjectId)}</span>
        <span class="hs ${r.status !== "ok" ? "bad" : ""}">${esc(ts(r.createdAt))}${r.status !== "ok" ? " · 降级" : ""}</span>
      </div>`).join("")}</div>`;

    for (const row of $$(".rv-hist-row")) {
      row.addEventListener("click", () => {
        const { kind, subject } = row.dataset;
        const tab = kind === "position" ? "position" : kind === "period" ? "period" : "style";
        switchTab(tab);
        if (kind === "position") {
          $("#posSelect").value = subject;
          runPositionReview();
        } else if (kind === "period") {
          runPeriodReview();
        } else {
          runStyleReview(false);
        }
      });
    }
  } catch (e) {
    $("#history").innerHTML = `<div class="rv-empty">历史读取失败：${esc(e.message)}</div>`;
  }
}

/* ── tabs + boot ───────────────────────── */

function switchTab(name) {
  for (const t of $$(".rv-tab")) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of $$(".rv-pane")) p.classList.toggle("active", p.dataset.pane === name);
  if (name === "style" && !$("#styleOut").innerHTML.trim()) runStyleReview(false);
}

async function boot() {
  mountIcons();
  for (const t of $$(".rv-tab")) {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  }
  $("#btnPosReview")?.addEventListener("click", runPositionReview);
  $("#btnPeriodReview")?.addEventListener("click", runPeriodReview);
  $("#btnStyle")?.addEventListener("click", () => runStyleReview(true));

  $("#btnLogout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login";
  });

  await loadStyleBar();
  await loadPositions();
  await loadHistory();
}

boot();
