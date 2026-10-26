/* LP Agent — 通知收件箱. Plain ES module, no build step. */

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

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}) } });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(data?.error || `${res.status}`);
  return data ?? {};
}

const state = { items: [], filter: "all" };

const LEVEL_ICON = { danger: "!", warn: "▲", info: "i", success: "✓" };
const KIND_LABEL = {
  alert: "监控告警",
  auto_rebalance: "自动调仓",
  auto_skip: "自动跳过",
  digest: "每日总结",
  system: "系统",
};

function dayLabel(ms) {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay) return "今天";
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function timeLabel(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function visible() {
  const f = state.filter;
  if (f === "unread") return state.items.filter((n) => !n.readAt);
  if (f === "danger") return state.items.filter((n) => n.level === "danger");
  if (f === "auto") return state.items.filter((n) => n.kind === "auto_rebalance" || n.kind === "auto_skip");
  return state.items;
}

function render() {
  const list = visible();
  const unread = state.items.filter((n) => !n.readAt).length;

  $("#ntCount").textContent = unread
    ? `${unread} 条未读 · 共 ${state.items.length} 条`
    : `全部已读 · 共 ${state.items.length} 条`;

  const dot = $("#navDot");
  if (dot) dot.hidden = unread === 0;

  for (const b of $$(".nt-tab")) {
    b.classList.toggle("on", b.dataset.f === state.filter);
  }

  if (!list.length) {
    $("#ntList").innerHTML = `<div class="nt-empty">这个分类下没有通知</div>`;
    return;
  }

  // Group by day so the list reads like a timeline rather than a flat dump.
  const groups = new Map();
  for (const n of list) {
    const k = dayLabel(n.createdAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }

  $("#ntList").innerHTML = [...groups.entries()].map(([day, items]) => `
    <div class="nt-group">${esc(day)}</div>
    ${items.map(row).join("")}
  `).join("");

  for (const el of $$(".nt-row")) {
    el.addEventListener("click", async (ev) => {
      if (ev.target.closest("a,button")) return;
      const id = el.dataset.id;
      const item = state.items.find((n) => n.id === id);
      if (!item) return;
      if (!item.readAt) {
        try {
          await api("/api/notifications/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id }),
          });
          item.readAt = Date.now();
          render();
        } catch { /* a failed read-mark is not worth interrupting the user */ }
      }
    });
  }
}

function row(n) {
  const unread = !n.readAt;
  const src = n.source ? `<span class="nt-src">${esc(n.source)}</span>` : "";
  return `<div class="nt-row ${esc(n.level)} ${unread ? "" : "read"}" data-id="${esc(n.id)}">
    <div class="nt-icon">${LEVEL_ICON[n.level] ?? "·"}</div>
    <div class="nt-body">
      <div class="nt-title">${esc(n.title)}</div>
      ${n.body ? `<div class="nt-text">${esc(n.body)}</div>` : ""}
      <div class="nt-meta-line">
        ${src}
        <span>${esc(KIND_LABEL[n.kind] ?? n.kind)}</span>
      </div>
    </div>
    <div class="nt-side">
      ${unread ? `<span class="nt-unread-dot"></span>` : ""}
      <span class="nt-time">${timeLabel(n.createdAt)}</span>
      ${n.href ? `<a class="nt-go" href="${esc(n.href)}" target="_self">查看</a>` : ""}
    </div>
  </div>`;
}

async function load() {
  try {
    const d = await api("/api/notifications?limit=200");
    state.items = d.notifications ?? [];
    render();
  } catch (e) {
    $("#ntList").innerHTML = `<div class="nt-empty">加载失败：${esc(e.message)}</div>`;
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

  $("#btnMarkAll")?.addEventListener("click", async () => {
    try {
      await api("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      for (const n of state.items) n.readAt = n.readAt ?? Date.now();
      render();
    } catch { /* ignore */ }
  });

  for (const b of $$(".nt-tab")) {
    b.addEventListener("click", () => {
      state.filter = b.dataset.f;
      render();
    });
  }

  await load();
}

boot();
