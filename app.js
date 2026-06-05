// Matrix Client — webview side.
//
// Runs in the Chromium webview that `deno desktop` opens. Imports matrix-js-sdk
// from a CDN, drives login/sync/timeline/sending, and fires native web
// Notifications. Talks to the Deno process through `globalThis.bindings.*`
// (exposed by `win.bind(...)` in main.ts) for the desktop-native bits: dock
// unread badge, tray tooltip, and focusing the window.

import * as sdk from "https://esm.sh/matrix-js-sdk@41.6.0?target=es2022";

// ── Tiny helpers ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const SESSION_KEY = "matrix-client.session.v1";

// Call a Deno-side binding, waiting briefly for injection to complete.
async function call(name, ...args) {
  for (let i = 0; i < 40; i++) {
    const b = globalThis.bindings && globalThis.bindings[name];
    if (typeof b === "function") {
      try {
        return await b(...args);
      } catch (e) {
        console.warn(`binding ${name} threw`, e);
        return undefined;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // Binding never appeared — fine, desktop chrome is best-effort.
}

// Log to both the webview console and the Deno terminal (great for headless runs).
function log(...parts) {
  console.log("[matrix]", ...parts);
  call("log", "info", ...parts.map((p) => (typeof p === "string" ? p : safe(p))));
}
function safe(v) { try { return JSON.stringify(v); } catch { return String(v); } }

// ── App state ────────────────────────────────────────────────────────────────
let client = null;
let currentRoomId = null;
let windowFocused = document.hasFocus();
const roomEls = new Map(); // roomId -> sidebar element

window.addEventListener("focus", () => { windowFocused = true; if (currentRoomId) clearRoomUnread(currentRoomId); });
window.addEventListener("blur", () => { windowFocused = false; });

// ── Boot ─────────────────────────────────────────────────────────────────────
init().catch((e) => showLoginError(e));

async function init() {
  wireLoginForm();
  const saved = loadSession();
  if (saved) {
    log("Found saved session for", saved.userId);
    try {
      await startMatrix(saved);
      return;
    } catch (e) {
      log("Saved session failed, showing login:", String(e));
      clearSession();
    }
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
      const baseUrl = $("homeserver").value.trim().replace(/\/+$/, "") || "https://matrix.org";
      const token = $("token").value.trim();
      const session = token
        ? await loginWithToken(baseUrl, token)
        : await loginWithPassword(baseUrl, $("username").value.trim(), $("password").value);
      saveSession(session);
      await startMatrix(session);
    } catch (e) {
      showLoginError(e);
    } finally {
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });
}

async function loginWithPassword(baseUrl, username, password) {
  if (!username || !password) throw new Error("Enter a username and password.");
  const tmp = sdk.createClient({ baseUrl });
  const res = await tmp.login("m.login.password", {
    identifier: { type: "m.id.user", user: username },
    password,
    initial_device_display_name: "Matrix Client (deno desktop)",
  });
  return {
    baseUrl,
    accessToken: res.access_token,
    userId: res.user_id,
    deviceId: res.device_id,
  };
}

async function loginWithToken(baseUrl, accessToken) {
  const tmp = sdk.createClient({ baseUrl, accessToken });
  const who = await tmp.whoami(); // { user_id, device_id? }
  return { baseUrl, accessToken, userId: who.user_id, deviceId: who.device_id };
}

// ── Start the client & sync ──────────────────────────────────────────────────
async function startMatrix(session) {
  client = sdk.createClient({
    baseUrl: session.baseUrl,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
    // No crypto store in this demo — encrypted rooms are shown read-only.
  });

  showScreen("app");
  renderMe(session.userId);
  $("me-status").textContent = "syncing…";
  call("setTrayTooltip", `Matrix — ${session.userId}`);

  client.on("sync", (state, prev) => {
    log("sync:", prev, "→", state);
    if (state === "PREPARED") {
      $("me-status").textContent = "online";
      renderRoomList();
      renderMe(session.userId);
    } else if (state === "ERROR") {
      $("me-status").textContent = "connection error";
    } else if (state === "SYNCING") {
      $("me-status").textContent = "online";
    }
  });

  // Live timeline updates.
  client.on("Room.timeline", (event, room, toStartOfTimeline, removed, data) => {
    if (toStartOfTimeline) return;           // back-pagination, not new
    if (data && data.liveEvent === false) return;
    onLiveEvent(event, room);
  });

  // Things that should refresh the sidebar.
  client.on("Room", () => renderRoomList());
  client.on("Room.name", () => renderRoomList());
  client.on("RoomState.events", () => scheduleRoomListRender());
  client.on("Room.receipt", () => updateUnreadTotal());

  await client.startClient({ initialSyncLimit: 30 });
}

// ── Sidebar / room list ──────────────────────────────────────────────────────
let roomListTimer = null;
function scheduleRoomListRender() {
  clearTimeout(roomListTimer);
  roomListTimer = setTimeout(renderRoomList, 250);
}

function sortedRooms() {
  if (!client) return [];
  return client.getRooms()
    .filter((r) => r.getMyMembership() === "join")
    .sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp());
}

function unreadCount(room) {
  try {
    const n = room.getUnreadNotificationCount?.("total");
    if (typeof n === "number") return n;
  } catch { /* fall through */ }
  try { return room.getUnreadNotificationCount?.() ?? 0; } catch { return 0; }
}

function renderRoomList() {
  const list = $("room-list");
  const rooms = sortedRooms();
  list.innerHTML = "";
  roomEls.clear();
  for (const room of rooms) {
    const el = document.createElement("div");
    el.className = "room" + (room.roomId === currentRoomId ? " active" : "");
    const unread = unreadCount(room);
    if (unread > 0 && room.roomId !== currentRoomId) el.classList.add("unread");
    el.appendChild(avatarFor(room.name || "?", roomAvatarUrl(room)));
    const name = document.createElement("div");
    name.className = "room-name";
    name.textContent = room.name || room.roomId;
    el.appendChild(name);
    if (unread > 0 && room.roomId !== currentRoomId) {
      const badge = document.createElement("div");
      badge.className = "badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      el.appendChild(badge);
    }
    el.addEventListener("click", () => selectRoom(room.roomId));
    list.appendChild(el);
    roomEls.set(room.roomId, el);
  }
  updateUnreadTotal();
}

function updateUnreadTotal() {
  let total = 0;
  for (const room of sortedRooms()) {
    if (room.roomId === currentRoomId && windowFocused) continue;
    total += unreadCount(room);
  }
  call("setUnread", total);
}

// ── Open a room & render its timeline ─────────────────────────────────────────
function selectRoom(roomId) {
  currentRoomId = roomId;
  const room = client.getRoom(roomId);
  if (!room) return;
  for (const [id, el] of roomEls) el.classList.toggle("active", id === roomId);
  clearRoomUnread(roomId);

  $("room-title").textContent = room.name || roomId;
  const topic = roomTopic(room);
  $("room-topic").textContent = topic || "";

  renderTimeline(room);
  setupComposer(room);
  renderRoomList();
}

function renderTimeline(room) {
  const tl = $("timeline");
  tl.innerHTML = "";
  const events = room.getLiveTimeline().getEvents();
  let lastSender = null;
  let lastDay = null;
  for (const event of events) {
    if (!isRenderable(event)) continue;
    const day = new Date(event.getTs()).toDateString();
    if (day !== lastDay) {
      const d = document.createElement("div");
      d.className = "day-divider";
      d.textContent = dayLabel(event.getTs());
      tl.appendChild(d);
      lastDay = day;
      lastSender = null;
    }
    tl.appendChild(renderEvent(room, event, event.getSender() === lastSender));
    lastSender = event.getSender();
  }
  if (!tl.children.length) {
    const e = document.createElement("div");
    e.className = "empty-hint";
    e.textContent = "No messages yet — say hello!";
    tl.appendChild(e);
  }
  scrollToBottom();
}

function onLiveEvent(event, room) {
  // Keep the sidebar fresh.
  scheduleRoomListRender();

  const isMine = event.getSender() === client.getUserId();
  const renderable = isRenderable(event);

  // Append to the open room's timeline.
  if (room.roomId === currentRoomId && renderable) {
    const tl = $("timeline");
    const hint = tl.querySelector(".empty-hint");
    if (hint) hint.remove();
    const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
    tl.appendChild(renderEvent(room, event, false));
    if (nearBottom || isMine) scrollToBottom();
    if (windowFocused) clearRoomUnread(room.roomId);
  }

  // Notify for messages from others that you can't currently see.
  const unseen = room.roomId !== currentRoomId || !windowFocused;
  if (renderable && !isMine && unseen && event.getType() === "m.room.message") {
    notify(room, event);
  }
  updateUnreadTotal();
}

// ── Composer / sending ─────────────────────────────────────────────────────────
function setupComposer(room) {
  const form = $("composer");
  const input = $("composer-input");
  form.hidden = false;

  const encrypted = isEncrypted(room);
  form.classList.toggle("disabled", encrypted);
  input.disabled = encrypted;
  input.placeholder = encrypted
    ? "🔒 Encrypted room — sending is disabled in this demo"
    : `Message ${room.name || ""}`.trim() + "…";

  // (Re)bind handlers fresh for the current room.
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
    try {
      await client.sendTextMessage(room.roomId, body);
      // The echo arrives via Room.timeline and renders itself.
    } catch (err) {
      log("send failed:", String(err));
      input.value = body; // restore so the user doesn't lose it
      flashError(String(err));
    }
  };
}

// ── Notifications ──────────────────────────────────────────────────────────────
let notifAsked = false;
async function ensureNotifPermission() {
  if (notifAsked) return;
  notifAsked = true;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch (e) {
    log("notification permission error:", String(e));
  }
}

function notify(room, event) {
  call("attention");
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const sender = displayName(room, event.getSender());
  const title = room.name && room.name !== sender ? `${sender} (${room.name})` : sender;
  try {
    const n = new Notification(title, {
      body: messageText(event).slice(0, 200),
      tag: room.roomId,
      icon: roomAvatarUrl(room) || undefined,
    });
    n.onclick = () => {
      call("focusWindow");
      selectRoom(room.roomId);
    };
  } catch (e) {
    log("notification failed:", String(e));
  }
}

// ── Rendering primitives ───────────────────────────────────────────────────────
function isRenderable(event) {
  const t = event.getType();
  return t === "m.room.message" || t === "m.room.encrypted";
}

function renderEvent(room, event, continuation) {
  const wrap = document.createElement("div");
  wrap.className = "msg" + (continuation ? " cont" : "");

  const sender = displayName(room, event.getSender());
  wrap.appendChild(avatarFor(sender, senderAvatarUrl(room, event.getSender())));

  const bodyEl = document.createElement("div");
  bodyEl.className = "msg-body";

  if (!continuation) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const s = document.createElement("span");
    s.className = "msg-sender";
    s.textContent = sender;
    s.style.color = colorFor(event.getSender());
    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = timeLabel(event.getTs());
    meta.append(s, time);
    bodyEl.appendChild(meta);
  }

  const text = document.createElement("div");
  const content = event.getContent();
  if (event.getType() === "m.room.encrypted") {
    text.className = "msg-text encrypted";
    text.textContent = "🔒 Encrypted message (decryption is disabled in this demo)";
  } else {
    const msgtype = content.msgtype || "m.text";
    text.className = "msg-text" +
      (msgtype === "m.notice" ? " notice" : msgtype === "m.emote" ? " emote" : "");
    text.textContent = messageText(event);
  }
  bodyEl.appendChild(text);
  wrap.appendChild(bodyEl);
  return wrap;
}

function messageText(event) {
  const c = event.getContent() || {};
  const sender = event.getSender();
  switch (c.msgtype) {
    case "m.emote": return `* ${event.sender?.name || sender} ${c.body || ""}`;
    case "m.image": return `🖼 ${c.body || "image"}`;
    case "m.file": return `📎 ${c.body || "file"}`;
    case "m.audio": return `🔊 ${c.body || "audio"}`;
    case "m.video": return `🎬 ${c.body || "video"}`;
    default: return c.body || "";
  }
}

// ── Avatars / names / colors ─────────────────────────────────────────────────
function avatarFor(name, url) {
  const el = document.createElement("div");
  el.className = "avatar";
  if (url) {
    el.style.backgroundImage = `url("${url}")`;
  } else {
    el.textContent = (name || "?").trim().charAt(0) || "?";
    el.style.background = colorFor(name);
  }
  return el;
}

function roomAvatarUrl(room) {
  try {
    const mxc = room.getMxcAvatarUrl?.();
    return mxc ? client.mxcUrlToHttp(mxc, 64, 64, "crop", true) : null;
  } catch { return null; }
}
function senderAvatarUrl(room, userId) {
  try {
    const m = room.getMember(userId);
    const mxc = m && m.getMxcAvatarUrl && m.getMxcAvatarUrl();
    return mxc ? client.mxcUrlToHttp(mxc, 64, 64, "crop", true) : null;
  } catch { return null; }
}
function displayName(room, userId) {
  try {
    const m = room.getMember(userId);
    if (m && m.name) return m.name;
  } catch { /* ignore */ }
  return userId;
}
function roomTopic(room) {
  try {
    const ev = room.currentState.getStateEvents("m.room.topic", "");
    return ev?.getContent()?.topic || "";
  } catch { return ""; }
}
function isEncrypted(room) {
  try {
    if (typeof room.hasEncryptionStateEvent === "function") return room.hasEncryptionStateEvent();
    return client.isRoomEncrypted?.(room.roomId) ?? false;
  } catch { return false; }
}

const COLORS = ["#0dbd8b","#368bd6","#ac3ba8","#e64f7a","#ff812d","#2dc2c5","#5c56f5","#74d12c"];
function colorFor(key) {
  let h = 0;
  for (let i = 0; i < (key || "").length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ── Misc UI ────────────────────────────────────────────────────────────────────
function renderMe(userId) {
  const room = currentRoomId ? client?.getRoom(currentRoomId) : null;
  let name = userId;
  try {
    const u = client?.getUser?.(userId);
    if (u?.displayName) name = u.displayName;
  } catch { /* ignore */ }
  $("me-name").textContent = name;
  const av = $("me-avatar");
  av.textContent = (name || "?").replace(/^@/, "").charAt(0).toUpperCase();
  av.style.background = colorFor(userId);
}

function clearRoomUnread(roomId) {
  const room = client?.getRoom(roomId);
  if (!room) return;
  try {
    const events = room.getLiveTimeline().getEvents();
    const last = events[events.length - 1];
    if (last) client.sendReadReceipt(last).catch(() => {});
  } catch { /* ignore */ }
  const el = roomEls.get(roomId);
  if (el) { el.classList.remove("unread"); el.querySelector(".badge")?.remove(); }
  updateUnreadTotal();
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
  if (which === "app") ensureNotifPermission();
}
function showLoginError(e) {
  showScreen("login");
  const el = $("login-error");
  el.hidden = false;
  el.textContent = humanError(e);
  log("login error:", String(e?.stack || e));
}
function hideLoginError() { $("login-error").hidden = true; }
function flashError(msg) {
  $("me-status").textContent = "⚠ " + msg.slice(0, 60);
  setTimeout(() => { if (client) $("me-status").textContent = "online"; }, 4000);
}
function humanError(e) {
  const m = String(e?.message || e || "");
  if (e?.errcode === "M_FORBIDDEN" || /M_FORBIDDEN|Invalid password/i.test(m)) {
    return "Login failed: wrong username or password.";
  }
  if (/fetch|network|Failed to/i.test(m)) return "Network error reaching the homeserver.\n" + m;
  return "Login failed: " + m;
}

// ── Session persistence ────────────────────────────────────────────────────────
function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const s = raw && JSON.parse(raw);
    return s && s.accessToken && s.userId ? s : null;
  } catch { return null; }
}
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }

// Logout button.
$("logout-btn").addEventListener("click", async () => {
  try { await client?.logout(true); } catch { /* ignore */ }
  try { client?.stopClient(); } catch { /* ignore */ }
  clearSession();
  client = null;
  currentRoomId = null;
  call("setUnread", 0);
  location.reload();
});
