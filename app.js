// Matrix Client — webview side (thin UI).
//
// Holds NO Matrix SDK. The SDK runs in the Deno process (see matrix.ts);
// this file just:
//   - calls bindings (globalThis.bindings.*) exposed by main.ts:
//       login / restore / getRooms / selectRoom / sendMessage / markRead / logout
//   - listens to the SSE stream at /events for live updates (sync, rooms, timeline)
//   - renders the UI and fires native web Notifications
//
// Session (homeserver + access token) is persisted here in localStorage so a
// relaunch skips re-login.

const $ = (id) => document.getElementById(id);

// ── Binding bridge (waits for injection) ────────────────────────────────────
async function call(name, ...args) {
  for (let i = 0; i < 60; i++) {
    const fn = globalThis.bindings && globalThis.bindings[name];
    if (typeof fn === "function") return await fn(...args);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`binding '${name}' is not available`);
}
function log(...parts) {
  console.log("[matrix]", ...parts);
  try {
    globalThis.bindings?.log?.("info", ...parts.map((p) => (typeof p === "string" ? p : safe(p))));
  } catch { /* ignore */ }
}
const safe = (v) => {
  try { return JSON.stringify(v); } catch { return String(v); }
};

// ── State ────────────────────────────────────────────────────────────────────
let myUserId = null;
let currentRoomId = null;
let windowFocused = document.hasFocus();
const roomEls = new Map();
let rooms = [];

window.addEventListener("focus", () => {
  windowFocused = true;
  if (currentRoomId) call("markRead", currentRoomId).catch(() => {});
});
window.addEventListener("blur", () => { windowFocused = false; });

// ── Boot ─────────────────────────────────────────────────────────────────────
init().catch((e) => showLoginError(e));

async function init() {
  wireLoginForm();
  connectEvents();
  try {
    const r = await call("autoStart"); // resumes a session persisted on the Deno side
    if (r?.ok) {
      myUserId = r.userId;
      await enterApp();
      return;
    }
    if (r?.error) log("autoStart:", r.error);
  } catch (e) {
    log("autoStart threw:", String(e));
  }
  showScreen("login");
}

// ── Login ──────────────────────────────────────────────────────────────────
function wireLoginForm() {
  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("login-btn");
    hideLoginError();
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      const opts = {
        homeserver: $("homeserver").value.trim() || "https://matrix.org",
        username: $("username").value.trim(),
        password: $("password").value,
        token: $("token").value.trim(),
      };
      const r = await call("login", opts);
      if (!r?.ok) throw new Error(r?.error || "Login failed.");
      myUserId = r.userId;
      await enterApp();
    } catch (e) {
      showLoginError(e);
    } finally {
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });
}

async function enterApp() {
  showScreen("app");
  renderMe(myUserId);
  $("me-status").textContent = "syncing…"; // 'sync' SSE events flip this to "online"
  rooms = await call("getRooms"); // may be empty until the first sync; 'rooms' fills it in
  renderRoomList();
}

// ── SSE: live updates from the Deno process ─────────────────────────────────
function connectEvents() {
  try {
    const es = new EventSource("/events");
    es.onmessage = (ev) => {
      let e;
      try { e = JSON.parse(ev.data); } catch { return; }
      handleEvent(e);
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
  } catch (e) {
    log("EventSource unavailable:", String(e));
  }
}

function handleEvent(e) {
  switch (e.kind) {
    case "sync":
      if (e.state === "ERROR") $("me-status").textContent = "connection error";
      else if (e.state === "PREPARED" || e.state === "SYNCING") $("me-status").textContent = "online";
      break;
    case "rooms":
      rooms = e.rooms || [];
      renderRoomList();
      break;
    case "timeline":
      onTimeline(e);
      break;
    case "openRoom": // a notification was clicked on the Deno side
      selectRoom(e.roomId);
      break;
  }
}

function onTimeline(e) {
  const { roomId, msg } = e;
  if (roomId === currentRoomId) {
    const tl = $("timeline");
    tl.querySelector(".empty-hint")?.remove();
    const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
    tl.appendChild(renderMsg(msg, false));
    if (nearBottom || msg.mine) scrollToBottom();
    if (windowFocused) call("markRead", roomId).catch(() => {});
  }
  // Notifications are fired on the Deno side (see main.ts maybeNotify).
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function renderRoomList() {
  const list = $("room-list");
  list.innerHTML = "";
  roomEls.clear();
  for (const room of rooms) {
    const el = document.createElement("div");
    el.className = "room" + (room.roomId === currentRoomId ? " active" : "");
    const unread = room.roomId === currentRoomId ? 0 : room.unread;
    if (unread > 0) el.classList.add("unread");
    el.appendChild(avatarFor(room.name, room.avatarUrl));
    const name = document.createElement("div");
    name.className = "room-name";
    name.textContent = room.name;
    el.appendChild(name);
    if (unread > 0) {
      const badge = document.createElement("div");
      badge.className = "badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      el.appendChild(badge);
    }
    el.addEventListener("click", () => selectRoom(room.roomId));
    list.appendChild(el);
    roomEls.set(room.roomId, el);
  }
}

// ── Open a room ────────────────────────────────────────────────────────────
async function selectRoom(roomId) {
  currentRoomId = roomId;
  call("setActiveRoom", roomId).catch(() => {}); // suppress notifications for this room
  for (const [id, el] of roomEls) el.classList.toggle("active", id === roomId);
  roomEls.get(roomId)?.classList.remove("unread");
  roomEls.get(roomId)?.querySelector(".badge")?.remove();

  let res;
  try {
    res = await call("selectRoom", roomId);
  } catch (e) {
    log("selectRoom failed:", String(e));
    return;
  }
  if (roomId !== currentRoomId) return; // user switched while loading

  $("room-title").textContent = res.name || roomId;
  $("room-topic").textContent = res.topic || "";
  renderTimeline(res.messages || []);
  setupComposer(roomId, res.encrypted, res.name);
}

function renderTimeline(messages) {
  const tl = $("timeline");
  tl.innerHTML = "";
  let lastSender = null;
  let lastDay = null;
  for (const msg of messages) {
    const day = new Date(msg.ts).toDateString();
    if (day !== lastDay) {
      const d = document.createElement("div");
      d.className = "day-divider";
      d.textContent = dayLabel(msg.ts);
      tl.appendChild(d);
      lastDay = day;
      lastSender = null;
    }
    tl.appendChild(renderMsg(msg, msg.sender === lastSender));
    lastSender = msg.sender;
  }
  if (!tl.children.length) {
    const e = document.createElement("div");
    e.className = "empty-hint";
    e.textContent = "No messages yet — say hello!";
    tl.appendChild(e);
  }
  scrollToBottom();
}

// ── Composer ─────────────────────────────────────────────────────────────────
function setupComposer(roomId, encrypted, name) {
  const form = $("composer");
  const input = $("composer-input");
  form.hidden = false;
  form.classList.toggle("disabled", encrypted);
  input.disabled = encrypted;
  input.placeholder = encrypted
    ? "🔒 Encrypted room — sending is disabled in this demo"
    : `Message ${name || ""}`.trim() + "…";

  input.oninput = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body || encrypted) return;
    input.value = "";
    input.style.height = "auto";
    const r = await call("sendMessage", roomId, body).catch((err) => ({ ok: false, error: String(err) }));
    if (!r?.ok) {
      input.value = body; // restore
      flashError(r?.error || "send failed");
    }
    // The echo arrives via the SSE 'timeline' event and renders itself.
  };
}

// ── Rendering primitives ───────────────────────────────────────────────────
function renderMsg(msg, continuation) {
  const wrap = document.createElement("div");
  wrap.className = "msg" + (continuation ? " cont" : "");
  wrap.appendChild(avatarFor(msg.senderName, msg.avatarUrl));

  const body = document.createElement("div");
  body.className = "msg-body";
  if (!continuation) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const s = document.createElement("span");
    s.className = "msg-sender";
    s.textContent = msg.senderName;
    s.style.color = colorFor(msg.sender);
    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = timeLabel(msg.ts);
    meta.append(s, time);
    body.appendChild(meta);
  }
  const text = document.createElement("div");
  const encrypted = msg.type === "m.room.encrypted";
  text.className = "msg-text" +
    (encrypted ? " encrypted" : msg.msgtype === "m.notice" ? " notice" : msg.msgtype === "m.emote" ? " emote" : "");
  text.textContent = msg.body;
  body.appendChild(text);
  wrap.appendChild(body);
  return wrap;
}

function avatarFor(name, url) {
  const el = document.createElement("div");
  el.className = "avatar";
  el.style.background = colorFor(name);
  const span = document.createElement("span");
  span.textContent = (name || "?").replace(/^[@#!]/, "").trim().charAt(0).toUpperCase() || "?";
  el.appendChild(span);
  if (url) {
    const img = document.createElement("img"); // overlays the initial; clipped to the circle
    img.alt = "";
    img.onerror = () => img.remove(); // broken / unauthorized media → show the initial
    img.src = url;
    el.appendChild(img);
  }
  return el;
}

const COLORS = ["#0dbd8b", "#368bd6", "#ac3ba8", "#e64f7a", "#ff812d", "#2dc2c5", "#5c56f5", "#74d12c"];
function colorFor(key) {
  let h = 0;
  for (let i = 0; i < (key || "").length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ── Misc UI ────────────────────────────────────────────────────────────────
function renderMe(userId) {
  $("me-name").textContent = userId || "…";
  const av = $("me-avatar");
  av.textContent = (userId || "?").replace(/^@/, "").charAt(0).toUpperCase();
  av.style.background = colorFor(userId);
}
function scrollToBottom() {
  const tl = $("timeline");
  requestAnimationFrame(() => { tl.scrollTop = tl.scrollHeight; });
}
function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}
function showScreen(which) {
  $("login").hidden = which !== "login";
  $("app").hidden = which !== "app";
}
function showLoginError(e) {
  showScreen("login");
  const el = $("login-error");
  el.hidden = false;
  el.textContent = String(e?.message || e);
  log("login error:", String(e));
}
function hideLoginError() { $("login-error").hidden = true; }
function flashError(msg) {
  $("me-status").textContent = "⚠ " + String(msg).slice(0, 60);
  setTimeout(() => { $("me-status").textContent = "online"; }, 4000);
}

// Session is persisted on the Deno side (see main.ts); logout clears it there.
$("logout-btn").addEventListener("click", async () => {
  await call("logout").catch(() => {});
  currentRoomId = null;
  location.reload();
});
