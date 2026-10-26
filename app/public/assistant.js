/* LP Agent — AI 助手 (M0). Plain ES module, no build step. */

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
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-3.5-3.5"/>',
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

/**
 * Minimal markdown for assistant replies.
 *
 * Escape HTML FIRST, then apply formatting to the escaped string. Doing it the
 * other way round would let a model-emitted tag through as live markup. Only
 * bold and inline code are supported — anything more is a rendering engine, and
 * the answer is prose, not a document.
 */
function fmt(text) {
  let out = esc(text);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return out;
}

const usd = (n) => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
};

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}) } });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(data?.error || data?.degradedReason || `${res.status} ${path}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data ?? {};
}

/* ── state ─────────────────────────────── */

const state = {
  sessionId: null,
  sessions: [],
  skills: [],
  integrations: [],
  chain: "x-layer",
  chainLabel: "X Layer",
  sending: false,
  abort: null,
};

const INT_KIND = {
  chain: "链", dex: "DEX", protocol: "协议", data: "数据", tool: "工具",
};
const INT_STATUS = {
  connected: "已连接", available: "可用", error: "异常", unknown: "未知",
};

/* ── sessions ──────────────────────────── */

function renderSessions() {
  const box = $("#sessions");
  if (!state.sessions.length) {
    box.innerHTML = `<div class="as-sess-empty">还没有对话</div>`;
    return;
  }
  box.innerHTML = state.sessions.map((s) => `
    <div class="as-sess ${s.id === state.sessionId ? "on" : ""}" data-id="${esc(s.id)}">
      <span class="as-sess-title" title="${esc(s.title)}">${esc(s.title)}</span>
      <button class="as-sess-del" data-del="${esc(s.id)}" title="删除">✕</button>
    </div>`).join("");

  for (const el of $$(".as-sess")) {
    el.addEventListener("click", (ev) => {
      if (ev.target.dataset.del) return;
      openSession(el.dataset.id);
    });
  }
  for (const el of $$(".as-sess-del")) {
    el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const id = ev.currentTarget.dataset.del;
      if (!confirm("删除这个对话？消息会一并删除，无法恢复。")) return;
      try {
        await api(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (state.sessionId === id) {
          state.sessionId = null;
          $("#messages").innerHTML = "";
          $("#intro").classList.remove("hide");
        }
        await loadSessions();
      } catch (e) { flash(e.message); }
    });
  }
}

async function loadSessions() {
  try {
    const d = await api("/api/chat/sessions");
    state.sessions = d.sessions ?? [];
    renderSessions();
  } catch (e) {
    $("#sessions").innerHTML = `<div class="as-sess-empty">读取失败</div>`;
  }
}

async function newSession() {
  try {
    const d = await api("/api/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    state.sessionId = d.session.id;
    $("#messages").innerHTML = "";
    $("#intro").classList.remove("hide");
    await loadSessions();
    $("#input").focus();
  } catch (e) { flash(e.message); }
}

async function openSession(id) {
  state.sessionId = id;
  renderSessions();
  $("#crumbCur").textContent = "AI 助手";
  try {
    const d = await api(`/api/chat/sessions/${encodeURIComponent(id)}/messages`);
    renderMessages(d.messages ?? []);
  } catch (e) { flash(e.message); }
}

/* ── messages ──────────────────────────── */

function renderMessages(msgs) {
  const box = $("#messages");
  if (!msgs.length) {
    box.innerHTML = "";
    $("#intro").classList.remove("hide");
    return;
  }
  $("#intro").classList.add("hide");
  box.innerHTML = msgs.map(messageHtml).join("");
  scrollBottom();
}

function messageHtml(m) {
  const isUser = m.role === "user";
  const who = isUser ? "你" : "AI 助手";
  const meta = !isUser && m.tokensIn
    ? `<div class="msg-meta">${esc(m.model ?? "")} · ${m.tokensIn}/${m.tokensOut} tok</div>`
    : "";
  const err = m.error ? `<div class="msg-error">${esc(m.error)}</div>` : "";
  const body = m.content
    ? `<div class="msg-text">${isUser ? esc(m.content) : fmt(m.content)}</div>`
    : "";
  return `<div class="msg ${isUser ? "user" : "assistant"}">
    <div class="msg-av">${isUser ? "你" : "L"}</div>
    <div class="msg-body">
      <div class="msg-who">${who}</div>
      ${body}${err}${meta}
    </div>
  </div>`;
}

function scrollBottom() {
  const t = $("#thread");
  requestAnimationFrame(() => { t.scrollTop = t.scrollHeight; });
}

/**
 * Live assistant bubble.
 *
 * Text is accumulated and re-rendered through fmt() on animation frames rather
 * than per delta: providers emit one event per character for Chinese, which at
 * ~5 chars/100ms would mean dozens of innerHTML writes per second.
 */
function beginStream(userText) {
  const box = $("#messages");

  const u = document.createElement("div");
  u.className = "msg user";
  u.innerHTML = `<div class="msg-av">你</div><div class="msg-body">
    <div class="msg-who">你</div><div class="msg-text">${esc(userText)}</div></div>`;
  box.appendChild(u);

  const a = document.createElement("div");
  a.className = "msg assistant";
  a.innerHTML = `<div class="msg-av">L</div><div class="msg-body">
    <div class="msg-who">AI 助手</div>
    <div class="typing"><i></i><i></i><i></i></div>
    <div class="msg-text" hidden></div>
    <div class="msg-error" hidden></div>
    <div class="msg-meta" hidden></div>
  </div>`;
  box.appendChild(a);
  scrollBottom();

  return {
    root: a,
    textEl: a.querySelector(".msg-text"),
    errEl: a.querySelector(".msg-error"),
    metaEl: a.querySelector(".msg-meta"),
    typingEl: a.querySelector(".typing"),
    acc: "",
  };
}

function syncStreamView(view, { thinking } = {}) {
  const { textEl, typingEl } = view;
  if (view.acc) {
    typingEl?.remove();
    textEl.hidden = false;
    textEl.innerHTML = fmt(view.acc);
  } else if (thinking && typingEl) {
    // Reasoning is invisible by design; say what is happening instead of
    // showing the raw deliberation.
    typingEl.innerHTML = `<span class="thinking-label">正在思考…</span>`;
  }
}

async function send(text) {
  const content = String(text ?? "").trim();
  if (!content || state.sending) return;

  $("#intro").classList.add("hide");
  state.sending = true;

  const view = beginStream(content);
  $("#input").value = "";
  resizeInput();
  setComposerMode("streaming");

  const ctl = new AbortController();
  state.abort = ctl;

  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      syncStreamView(view);
      scrollBottom();
    });
  };

  try {
    // A fresh conversation needs creating before the first message can land.
    if (!state.sessionId) {
      const d = await api("/api/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      state.sessionId = d.session.id;
    }

    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, text: content, chain: state.chain }),
      signal: ctl.signal,
    });

    if (!res.ok || !res.body) {
      let msg = `${res.status}`;
      try { msg = (await res.json())?.error ?? msg; } catch { /* keep status */ }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let donePayload = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let sep;
      // Same frame parsing as the server: a chunk may split a frame in half.
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        for (const line of frame.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload) continue;

          let ev;
          try { ev = JSON.parse(payload); } catch { continue; }

          if (ev.type === "delta") {
            view.acc += ev.text ?? "";
            schedule();
          } else if (ev.type === "thinking") {
            syncStreamView(view, { thinking: true });
          } else if (ev.type === "assistant_start") {
            // Server allocated the row; keep the id in case we need to patch.
            view.messageId = ev.messageId;
          } else if (ev.type === "done") {
            donePayload = ev;
          } else if (ev.type === "aborted") {
            // Server already removed the empty placeholder. Mark it so the
            // catch below does not print a failure for a deliberate action.
            view.abortedEmpty = true;
          } else if (ev.type === "error") {
            throw new Error(ev.error ?? "生成失败");
          }
        }
      }
    }

    if (raf) { cancelAnimationFrame(raf); raf = 0; }

    // The done event carries the authoritative text (it may include a
    // truncation note the deltas do not contain).
    if (donePayload?.message) {
      view.acc = donePayload.message.content ?? view.acc;
      view.textEl.hidden = false;
      view.textEl.innerHTML = fmt(view.acc);
      view.typingEl?.remove();

      const m = donePayload.message;
      if (m.error) {
        view.errEl.hidden = false;
        view.errEl.textContent = m.error;
      }
      if (m.tokensIn) {
        view.metaEl.hidden = false;
        view.metaEl.textContent = `${m.model ?? ""} · ${m.tokensIn}/${m.tokensOut} tok · ${((donePayload.tookMs ?? 0) / 1000).toFixed(1)}s`;
      }
    } else {
      syncStreamView(view);
    }

    scrollBottom();
    await loadSessions();
    await loadUsage();
  } catch (e) {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    view.typingEl?.remove();

    if (e.name === "AbortError" || view.abortedEmpty) {
      // Stopping is a normal action, not a failure. Whatever arrived stays on
      // screen and is already persisted server-side; if nothing arrived, the
      // whole bubble goes away rather than leaving a blank reply.
      if (!view.acc) {
        view.root.remove();
      } else {
        view.textEl.hidden = false;
        view.textEl.innerHTML = fmt(view.acc + "\n\n（已停止生成）");
      }
    } else {
      view.errEl.hidden = false;
      view.errEl.textContent = e.message;
      if (view.acc) {
        view.textEl.hidden = false;
        view.textEl.innerHTML = fmt(view.acc);
      }
    }
    scrollBottom();
    loadSessions().catch(() => {});
  } finally {
    state.sending = false;
    state.abort = null;
    setComposerMode("idle");
    $("#input").focus();
  }
}

/** Swap the send button between "send" and "stop" without a second control. */
function setComposerMode(mode) {
  const btn = $("#btnSend");
  if (!btn) return;
  if (mode === "streaming") {
    btn.disabled = false;
    btn.classList.add("stopping");
    btn.title = "停止生成";
    btn.innerHTML = '<span class="stop-square"></span>';
  } else {
    btn.disabled = false;
    btn.classList.remove("stopping");
    btn.title = "发送";
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  }
}

/* ── quick prompts ─────────────────────── */

const QUICK = [
  { t: "我的仓位现在怎么样？", d: "看盈亏、投入与回收" },
  { t: "哪些池子值得做？为什么？", d: "按评分与风险维度解释" },
  { t: "我的交易风格有什么问题？", d: "从复盘数据看行为模式" },
  { t: "现在该不该继续加仓？", d: "结合预算与当前仓位判断" },
];

function renderQuick() {
  $("#quick").innerHTML = QUICK.map((q) => `
    <button class="as-q" data-q="${esc(q.t)}">
      <div class="as-q-t">${esc(q.t)}</div>
      <div class="as-q-d">${esc(q.d)}</div>
    </button>`).join("");
  for (const b of $$(".as-q")) {
    b.addEventListener("click", () => send(b.dataset.q));
  }
}

/* ── right column ──────────────────────── */

async function loadMarket() {
  try {
    const d = await api("/api/market");
    const rows = d.data?.rows ?? [];
    $("#market").innerHTML = rows.map((x) => `
      <div class="mkt-row">
        <div class="mkt-sym">${esc(String(x.symbol).slice(0, 3))}</div>
        <div class="mkt-name">${esc(x.symbol)}<small>${x.confidence ? "conf " + x.confidence : ""}</small></div>
        <div class="mkt-price">${usd(x.price)}</div>
      </div>`).join("") || `<div class="loading">—</div>`;
  } catch {
    $("#market").innerHTML = `<div class="loading">行情不可用</div>`;
  }
}

function renderSkills() {
  const on = state.skills.filter((s) => s.enabled);
  $("#skillCount").textContent = `技能 ${on.length}/${state.skills.length}`;
  $("#skillsPanel").innerHTML = on.length
    ? on.map((s) => `
      <div class="as-skill-row">
        <span class="as-dot on"></span>
        <span class="as-skill-name" title="${esc(s.description)}">${esc(s.name)}</span>
        <span class="as-skill-tag">${esc(s.source)}</span>
      </div>`).join("")
    : `<div class="as-sess-empty">没有启用任何技能</div>`;
}

function renderIntegrations() {
  const list = state.integrations;
  $("#intsPanel").innerHTML = list.length
    ? list.map((i) => {
      const cls = i.status === "connected" ? "on" : i.status === "available" ? "avail" : i.status === "error" ? "err" : "";
      return `<div class="as-int-row-item">
        <span class="as-dot ${cls}"></span>
        <span class="as-int-name">${esc(i.name)}</span>
        <span class="as-int-tag">${esc(INT_KIND[i.kind] ?? i.kind)}</span>
      </div>`;
    }).join("")
    : `<div class="as-sess-empty">还没有接入</div>`;
}

async function loadSkills() {
  try {
    const d = await api("/api/skills");
    state.skills = d.skills ?? [];
    renderSkills();
    renderSkillsModal();
  } catch (e) { flash(e.message); }
}

async function loadIntegrations() {
  try {
    const d = await api("/api/integrations");
    state.integrations = d.integrations ?? [];
    renderIntegrations();
    renderIntsModal();
  } catch (e) { flash(e.message); }
}

async function loadUsage() {
  try {
    const d = await api("/api/budget");
    const pct = d.limitToday ? Math.min(100, (d.usedToday / d.limitToday) * 100) : 0;
    $("#spendDay").textContent = d.day ?? "—";
    $("#budgetLabel").textContent = `${d.usedToday}/${d.limitToday}`;
    $("#usage").innerHTML = `
      <div class="as-use-row"><span>今日调用</span><b>${d.usedToday} / ${d.limitToday}</b></div>
      <div class="as-bar ${pct > 80 ? "warn" : ""}"><i style="width:${pct}%"></i></div>
      <div class="as-use-row"><span>本小时</span><b>${d.usedHour} / ${d.limitHour}</b></div>
      <div class="as-use-row"><span>今日 token</span><b>${Number(d.tokensToday ?? 0).toLocaleString()}</b></div>`;
  } catch { /* budget is cosmetic here */ }
}

/* ── skills modal ──────────────────────── */

function renderSkillsModal() {
  $("#skillsList").innerHTML = state.skills.map((s) => `
    <div class="as-skill-item">
      <div class="as-skill-main">
        <div class="as-skill-title">
          <b>${esc(s.name)}</b>
          <span class="as-skill-id">${esc(s.id)}</span>
        </div>
        <div class="as-skill-desc">${esc(s.description)}</div>
      </div>
      <button class="as-switch ${s.enabled ? "on" : ""}" data-skill="${esc(s.id)}"
              data-on="${s.enabled ? "1" : "0"}" title="启用/停用"></button>
    </div>`).join("") || `<div class="as-empty">没有找到技能</div>`;

  for (const b of $$("[data-skill]")) {
    b.addEventListener("click", async () => {
      const id = b.dataset.skill;
      const next = b.dataset.on !== "1";
      try {
        const d = await api(`/api/skills/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        });
        state.skills = d.skills ?? state.skills;
        renderSkills();
        renderSkillsModal();
      } catch (e) { flash(e.message); }
    });
  }
}

/* ── integrations modal ────────────────── */

function renderIntsModal() {
  $("#intsList").innerHTML = state.integrations.map((i) => `
    <div class="as-int-item">
      <span class="as-dot ${i.status === "connected" ? "on" : i.status === "available" ? "avail" : ""}"></span>
      <div class="as-int-info">
        <div class="as-int-line">
          <b>${esc(i.name)}</b>
          <span class="as-int-kind">${esc(INT_KIND[i.kind] ?? i.kind)}</span>
        </div>
        ${i.url ? `<a class="as-int-link" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.url)}</a>` : ""}
      </div>
      <span class="as-int-status ${esc(i.status)}">${esc(INT_STATUS[i.status] ?? i.status)}</span>
      <button class="as-int-del" data-int="${esc(i.id)}" title="移除">✕</button>
    </div>`).join("") || `<div class="as-empty">还没有接入</div>`;

  for (const b of $$("[data-int]")) {
    b.addEventListener("click", async () => {
      const id = b.dataset.int;
      if (!confirm("移除这个接入？历史对话不受影响。")) return;
      try {
        const d = await api(`/api/integrations/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.integrations = d.integrations ?? [];
        renderIntegrations();
        renderIntsModal();
      } catch (e) { flash(e.message); }
    });
  }
}

async function addIntegration() {
  const name = $("#intName").value.trim();
  if (!name) { flash("名称不能为空"); return; }
  const url = $("#intUrl").value.trim();
  if (url && !/^https?:\/\//i.test(url)) { flash("链接需要以 http:// 或 https:// 开头"); return; }
  try {
    const d = await api("/api/integrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name, kind: $("#intKind").value, url: url || undefined,
        status: $("#intStatus").value,
      }),
    });
    state.integrations = d.integrations ?? [];
    $("#intName").value = "";
    $("#intUrl").value = "";
    renderIntegrations();
    renderIntsModal();
    flash(`已保存 ${name}`);
  } catch (e) { flash(e.message); }
}

/* ── modals plumbing ───────────────────── */

function openModal(which) {
  $("#modalScrim").classList.add("on");
  $(which).classList.add("on");
}
function closeModals() {
  $("#modalScrim").classList.remove("on");
  for (const m of $$(".as-modal")) m.classList.remove("on");
}

/* ── misc ──────────────────────────────── */

let flashTimer = null;
function flash(text) {
  const h = $("#hint");
  h.textContent = text;
  h.style.color = "var(--amber)";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    h.textContent = "回答基于当前系统中的仓位、计划与推荐数据";
    h.style.color = "";
  }, 3200);
}

function resizeInput() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(160, t.scrollHeight) + "px";
}

async function loadChain() {
  try {
    const d = await api("/api/positions?sync=0");
    state.chain = d.chain ?? "x-layer";
    state.chainLabel = d.chainLabel ?? "X Layer";
    $("#chainChips").innerHTML = `<span class="as-chip on">${esc(state.chainLabel)}</span>`;
  } catch {
    $("#chainChips").innerHTML = `<span class="as-chip on">X Layer</span>`;
  }
}

async function boot() {
  mountIcons();
  renderQuick();

  $("#btnNewChat")?.addEventListener("click", newSession);
  $("#btnLogout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login";
  });

  // One button, two jobs: send while idle, stop while streaming. A separate
  // stop control would compete with the send affordance in the same corner.
  $("#btnSend")?.addEventListener("click", () => {
    if (state.sending) {
      state.abort?.abort();
      return;
    }
    send($("#input").value);
  });

  const input = $("#input");
  input?.addEventListener("input", resizeInput);
  input?.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter is a newline. IME composition must not send —
    // Chinese input fires Enter to commit candidates and would swallow the text.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });

  $("#btnStart")?.addEventListener("click", () => {
    const budget = $("#seedBudget").value.trim() || "500";
    const focus = $("#seedFocus").value;
    send(`我的计划预算大约是 ${budget} 美元，关注重点：${focus}。请先介绍我的现状，再给下一步建议。`);
  });

  $("#btnSkills")?.addEventListener("click", () => openModal("#skillsModal"));
  $("#btnManageSkills")?.addEventListener("click", () => openModal("#skillsModal"));
  $("#btnManageInts")?.addEventListener("click", () => openModal("#intsModal"));
  $("#btnAddInt")?.addEventListener("click", addIntegration);
  $("#modalScrim")?.addEventListener("click", closeModals);
  for (const x of $$("[data-close]")) x.addEventListener("click", closeModals);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });

  $("#btnToggleSessions")?.addEventListener("click", (e) => {
    const box = $("#sessions");
    box.classList.toggle("hidden");
    e.currentTarget.textContent = box.classList.contains("hidden") ? "+" : "−";
  });

  await Promise.all([loadSessions(), loadSkills(), loadIntegrations(), loadUsage(), loadMarket(), loadChain()]);

  // Deep link from a pool drawer: /assistant?session=<id>
  //
  // Without this the "在 AI 助手里继续这个对话" link landed on the assistant's
  // landing page and the conversation the user had just started was nowhere in
  // sight — a link that promises continuity and delivers a blank slate.
  const wanted = new URLSearchParams(location.search).get("session");
  if (wanted) {
    const exists = state.sessions.some((x) => x.id === wanted);
    if (exists) {
      try {
        await openSession(wanted);
      } catch {
        flash("这个对话已不存在");
      }
    } else {
      flash("这个对话已不存在");
    }
  }

  input?.focus();
}

boot();
