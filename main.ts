// Matrix Client — Deno desktop side.
//
// In this architecture the *Matrix SDK runs here, in the Deno process*
// (see matrix.ts). main.ts:
//   1. serves the UI shell (index.html + app.js + an SSE stream) over Deno.serve,
//   2. opens a Chromium webview window pointed at that server,
//   3. exposes the engine to the webview as bindings (login/getRooms/
//      selectRoom/sendMessage/...),
//   4. pushes live Matrix events to the UI over the SSE route,
//   5. owns the desktop-native chrome (tray icon, dock unread badge, window
//      lifecycle).
//
// The webview (app.js) holds no SDK — it just calls bindings and renders what
// it receives.

import { humanError, MatrixEngine, type Session } from "./matrix.ts";

// Embed the UI assets into the module graph as text. `deno desktop` compiles
// the entry into a self-contained binary, so reading sibling files at runtime
// would fail — importing them with `{ type: "text" }` bundles them in (and
// still hot-reloads from disk under `--hmr`).
import INDEX_HTML from "./index.html" with { type: "text" };
import APP_JS from "./app.js" with { type: "text" };
import STYLES_CSS from "./styles.css" with { type: "text" };

const engine = new MatrixEngine();

// ── Window ────────────────────────────────────────────────────────────────
const win = new Deno.BrowserWindow({
  title: "Matrix",
  width: 1100,
  height: 760,
  resizable: true,
});

// ── SSE: push engine events to the webview ───────────────────────────────────
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();

function broadcast(obj: unknown) {
  const bytes = enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
  for (const c of subscribers) {
    try {
      c.enqueue(bytes);
    } catch { /* dropped subscriber */ }
  }
}

// Notification context, tracked on the Deno side.
let activeRoomId: string | null = null;
let windowFocused = true;
win.addEventListener("focus", () => (windowFocused = true));
win.addEventListener("blur", () => (windowFocused = false));

engine.onEvent = (e) => {
  broadcast(e);
  if (e.kind === "rooms" || e.kind === "timeline") updateBadge();
  if (e.kind === "rooms") refreshTrayMenu();
  if (e.kind === "timeline") maybeNotify(e);
};

// Fire a native notification (from the Deno process) for an incoming message
// in a room the user isn't currently looking at.
let notifReady = false;
async function ensureNotifPermission() {
  if (notifReady || typeof Notification === "undefined") return;
  notifReady = true;
  try {
    if (Notification.permission === "default") await Notification.requestPermission();
  } catch (err) {
    console.error("notification permission:", err);
  }
}

function maybeNotify(e: { roomId: string; roomName: string; msg: any }) {
  const { msg } = e;
  if (msg.mine || msg.type !== "m.room.message") return;
  const seen = e.roomId === activeRoomId && windowFocused;
  if (seen) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    Deno.dock?.bounce(false);
  } catch { /* ignore */ }
  const title = e.roomName && e.roomName !== msg.senderName
    ? `${msg.senderName} (${e.roomName})`
    : msg.senderName;
  try {
    const n = new Notification(title, {
      body: String(msg.body ?? "").slice(0, 200),
      tag: e.roomId,
      icon: msg.avatarUrl ?? undefined,
    });
    n.addEventListener("click", () => {
      win.show();
      win.focus();
      broadcast({ kind: "openRoom", roomId: e.roomId }); // tell the UI to switch
    });
  } catch (err) {
    console.error("notification failed:", err);
  }
}

function updateBadge() {
  const n = engine.totalUnread();
  try {
    Deno.dock?.setBadge(n > 0 ? String(n) : null);
  } catch { /* best-effort */ }
  tray?.setTooltip(
    `Matrix${engine.userId() ? " — " + engine.userId() : ""}${n > 0 ? ` (${n})` : ""}`,
  );
}

// ── Session persistence (Deno side) ──────────────────────────────────────────
// Stored on disk by the Deno process so it survives relaunches (the webview's
// localStorage is ephemeral here) and the access token never reaches the webview.
const SESSION_FILE = (Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || ".") +
  "/.matrix-client-demo.json";

function readSession(): Session | null {
  try {
    const s = JSON.parse(Deno.readTextFileSync(SESSION_FILE));
    return s?.accessToken && s?.userId ? s : null;
  } catch {
    return null;
  }
}
function writeSession(s: Session) {
  try {
    Deno.writeTextFileSync(SESSION_FILE, JSON.stringify(s), { mode: 0o600 });
  } catch (e) {
    console.error("could not persist session:", e);
  }
}
function deleteSession() {
  try {
    Deno.removeSync(SESSION_FILE);
  } catch { /* ignore */ }
}

// ── Bindings the webview calls ───────────────────────────────────────────────
win.bind("login", async (opts) => {
  const o = (opts ?? {}) as Record<string, string>;
  try {
    const session: Session = o.token
      ? await engine.loginToken(o.homeserver, o.token)
      : await engine.loginPassword(o.homeserver, o.username, o.password);
    // Don't block the UI on the (possibly slow) initial sync — rooms stream in.
    await engine.start(session, { waitForPrepared: false });
    writeSession(session);
    updateBadge();
    ensureNotifPermission();
    return { ok: true, userId: session.userId };
  } catch (e) {
    return { ok: false, error: humanError(e) };
  }
});

// Called on startup: resume a persisted session, if any.
win.bind("autoStart", async () => {
  const session = readSession();
  if (!session) return { ok: false };
  try {
    await engine.start(session, { waitForPrepared: false });
    updateBadge();
    ensureNotifPermission();
    return { ok: true, userId: engine.userId() };
  } catch (e) {
    deleteSession(); // token invalid/expired → forget it
    return { ok: false, error: humanError(e) };
  }
});

win.bind("getRooms", async () => engine.getRooms() as unknown as Record<string, unknown>[]);

win.bind("selectRoom", async (roomId) => {
  const id = String(roomId);
  const info = engine.roomInfo(id);
  const messages = engine.getTimeline(id);
  engine.markRead(id);
  return { ok: true, ...info, messages };
});

win.bind("sendMessage", async (roomId, body) => {
  try {
    await engine.send(String(roomId), String(body));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: humanError(e) };
  }
});

win.bind("markRead", async (roomId) => {
  engine.markRead(String(roomId));
  updateBadge();
  return true;
});

win.bind("logout", async () => {
  await engine.logout();
  deleteSession();
  activeRoomId = null;
  updateBadge();
  refreshTrayMenu();
  return true;
});

// The webview tells us which room is open so notifications can be suppressed
// for messages the user is already looking at.
win.bind("setActiveRoom", async (roomId) => {
  activeRoomId = roomId == null ? null : String(roomId);
  return true;
});

win.bind("log", async (level, ...parts) => {
  console.log(
    `[webview:${String(level)}]`,
    ...parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))),
  );
  return true;
});

// ── Tray icon ───────────────────────────────────────────────────────────────
// The tray is a quick glance at + jump into unread conversations without
// focusing the window: it lists your unread rooms (click to open), shows the
// total, and offers Mark-All-Read / New DM. Rebuilt whenever rooms change.
let tray: Deno.Tray | null = null;

function trayMenuItems(): Deno.MenuItem[] {
  const items: Deno.MenuItem[] = [];
  const signedIn = engine.isLoggedIn();
  const rooms = signedIn ? engine.getRooms() : [];
  const total = rooms.reduce((n, r) => n + r.unread, 0);
  const unread = rooms.filter((r) => r.unread > 0).slice(0, 6);

  items.push({
    item: {
      label: !signedIn
        ? "Not signed in"
        : total > 0
        ? `${total} unread message${total === 1 ? "" : "s"}`
        : "No unread messages",
      id: "tray-status",
      enabled: false,
    },
  });

  if (unread.length) {
    items.push("separator");
    for (const r of unread) {
      const name = r.name.length > 28 ? r.name.slice(0, 27) + "…" : r.name;
      items.push({ item: { label: `${name} (${r.unread})`, id: `room:${r.roomId}`, enabled: true } });
    }
  }

  items.push("separator");
  if (signedIn) {
    items.push({ item: { label: "Mark All as Read", id: "tray-mark-all", enabled: total > 0 } });
    items.push({ item: { label: "New Direct Message…", id: "tray-new-dm", enabled: true } });
    items.push("separator");
  }
  items.push({ item: { label: "Show Window", id: "show", enabled: true } });
  items.push({ item: { label: "Quit Matrix", id: "quit", enabled: true } });
  return items;
}

function refreshTrayMenu() {
  try {
    tray?.setMenu(trayMenuItems());
  } catch { /* ignore */ }
}

try {
  tray = new Deno.Tray();
  tray.setIcon(makeTrayIconPng(32));
  tray.setTooltip("Matrix");
  tray.setMenu(trayMenuItems());
  tray.addEventListener("click", () => {
    win.show();
    win.focus();
  });
  tray.addEventListener("menuclick", async (e) => {
    const id = (e as CustomEvent<{ id: string }>).detail.id;
    if (id === "show") {
      win.show();
      win.focus();
    } else if (id === "quit") {
      quit();
    } else if (id === "tray-mark-all") {
      engine.markAllRead();
      updateBadge();
    } else if (id === "tray-new-dm") {
      win.show();
      win.focus();
      await newDirectMessage();
    } else if (id.startsWith("room:")) {
      win.show();
      win.focus();
      broadcast({ kind: "openRoom", roomId: id.slice(5) });
    }
  });
} catch (e) {
  console.error("Tray unavailable:", e);
}

// ── Native application menu (macOS menu bar / window menu) ────────────────────
win.setApplicationMenu([
  // macOS turns the first submenu into the app menu.
  {
    submenu: {
      label: "Matrix",
      items: [
        { item: { label: "About Matrix Client", id: "about", enabled: true } },
        "separator",
        { role: { role: "hide" } },
        { role: { role: "quit" } },
      ],
    },
  },
  {
    submenu: {
      label: "File",
      items: [
        { item: { label: "New Direct Message…", id: "new-dm", accelerator: "CmdOrCtrl+N", enabled: true } },
        "separator",
        { item: { label: "Sign Out", id: "sign-out", enabled: true } },
      ],
    },
  },
  {
    submenu: {
      label: "Edit",
      items: [
        { role: { role: "undo" } },
        { role: { role: "redo" } },
        "separator",
        { role: { role: "cut" } },
        { role: { role: "copy" } },
        { role: { role: "paste" } },
        { role: { role: "selectAll" } },
      ],
    },
  },
  {
    submenu: {
      label: "View",
      items: [
        { item: { label: "Next Room", id: "next-room", accelerator: "CmdOrCtrl+]", enabled: true } },
        { item: { label: "Previous Room", id: "prev-room", accelerator: "CmdOrCtrl+[", enabled: true } },
        "separator",
        { item: { label: "Mark All as Read", id: "mark-all-read", accelerator: "Shift+CmdOrCtrl+A", enabled: true } },
        "separator",
        { item: { label: "Reload", id: "reload", accelerator: "CmdOrCtrl+R", enabled: true } },
        { item: { label: "Toggle Developer Tools", id: "devtools", accelerator: "Alt+CmdOrCtrl+I", enabled: true } },
      ],
    },
  },
  {
    submenu: {
      label: "Help",
      items: [
        { item: { label: "Project Repository…", id: "help-repo", enabled: true } },
      ],
    },
  },
]);

win.addEventListener("menuclick", async (e) => {
  const id = (e as CustomEvent<{ id: string }>).detail.id;
  switch (id) {
    case "about":
      safeAlert(
        "Matrix Client\nA deno desktop demo using matrix-js-sdk." +
          (engine.userId() ? `\n\nSigned in as ${engine.userId()}` : ""),
      );
      break;
    case "new-dm":
      await newDirectMessage();
      break;
    case "sign-out":
      await signOut();
      break;
    case "next-room":
      broadcast({ kind: "nav", dir: "next" });
      break;
    case "prev-room":
      broadcast({ kind: "nav", dir: "prev" });
      break;
    case "mark-all-read":
      engine.markAllRead();
      updateBadge();
      break;
    case "reload":
      win.reload();
      break;
    case "devtools":
      win.openDevtools();
      break;
    case "help-repo":
      safeAlert("https://github.com/divybot/deno-desktop-matrix-client");
      break;
  }
});

// Prompt for a user id (native dialog) and open a DM with them.
async function newDirectMessage() {
  if (!engine.isLoggedIn()) return safeAlert("Sign in first.");
  let uid: string | null = null;
  try {
    uid = typeof prompt === "function"
      ? prompt("Start a direct message with (e.g. @alice:matrix.org):")
      : null;
  } catch { /* dialog unavailable */ }
  uid = uid?.trim() ?? "";
  if (!uid) return;
  try {
    const roomId = await engine.startDirectMessage(uid);
    win.show();
    win.focus();
    broadcast({ kind: "openRoom", roomId });
  } catch (e) {
    safeAlert("Could not start DM: " + humanError(e));
  }
}

async function signOut() {
  await engine.logout();
  deleteSession();
  activeRoomId = null;
  updateBadge();
  refreshTrayMenu();
  broadcast({ kind: "loggedOut" });
}

function safeAlert(msg: string) {
  try {
    if (typeof alert === "function") alert(msg);
    else console.log(msg);
  } catch {
    console.log(msg);
  }
}

// ── Window lifecycle ─────────────────────────────────────────────────────────
// Closing hides to the tray (classic chat-app behavior); tray ▸ Quit exits.
let quitting = false;
win.addEventListener("close", () => {
  if (quitting) return;
  console.log("Window close → hiding to tray (use tray ▸ Quit to exit)");
  try {
    win.hide();
  } catch {
    quit();
  }
});
try {
  Deno.dock?.addEventListener("reopen", () => {
    win.show();
    win.focus();
  });
} catch { /* no dock on this platform */ }

function quit() {
  quitting = true;
  try {
    engine.logout();
  } catch { /* ignore */ }
  try {
    tray?.destroy();
  } catch { /* ignore */ }
  try {
    win.close();
  } catch { /* ignore */ }
  Deno.exit(0);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const text = (body: string, type: string) =>
  new Response(body, { headers: { "content-type": type } });

Deno.serve((req) => {
  const url = new URL(req.url);
  switch (url.pathname) {
    case "/events": {
      // Server-Sent Events: stream live Matrix events to the webview.
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          ctrl = controller;
          subscribers.add(controller);
          controller.enqueue(enc.encode(": connected\n\n"));
        },
        cancel() {
          subscribers.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
    case "/app.js":
      return text(APP_JS, "application/javascript; charset=utf-8");
    case "/styles.css":
      return text(STYLES_CSS, "text/css; charset=utf-8");
    default:
      return text(INDEX_HTML, "text/html; charset=utf-8");
  }
});

// Heartbeat so the SSE connection (and any proxies) stay alive.
setInterval(() => broadcast({ kind: "ping" }), 25000);

console.log("Matrix Client running. Window id:", win.windowId);

// ── Tray icon PNG (generated in-code so nothing is read from disk) ───────────
function makeTrayIconPng(size: number): Uint8Array {
  const rowLen = 1 + size * 4;
  const raw = new Uint8Array(rowLen * size);
  const c = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    const o = y * rowLen;
    raw[o] = 0;
    for (let x = 0; x < size; x++) {
      const inside = (x - c) ** 2 + (y - c) ** 2 <= r * r;
      const p = o + 1 + x * 4;
      raw[p] = 0x0d;
      raw[p + 1] = 0xbd;
      raw[p + 2] = 0x8b;
      raw[p + 3] = inside ? 0xff : 0x00;
    }
  }
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let v = n;
    for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    table[n] = v >>> 0;
  }
  const crc32 = (d: Uint8Array) => {
    let v = 0xffffffff;
    for (let i = 0; i < d.length; i++) v = table[(v ^ d[i]) & 0xff] ^ (v >>> 8);
    return (v ^ 0xffffffff) >>> 0;
  };
  const len = raw.length;
  const zlib = new Uint8Array(2 + 5 + len + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib[2] = 0x01;
  zlib[3] = len & 0xff;
  zlib[4] = (len >> 8) & 0xff;
  const nlen = ~len & 0xffff;
  zlib[5] = nlen & 0xff;
  zlib[6] = (nlen >> 8) & 0xff;
  zlib.set(raw, 7);
  let a = 1, b = 0;
  for (let i = 0; i < len; i++) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  const ao = 7 + len;
  zlib[ao] = (adler >>> 24) & 0xff;
  zlib[ao + 1] = (adler >>> 16) & 0xff;
  zlib[ao + 2] = (adler >>> 8) & 0xff;
  zlib[ao + 3] = adler & 0xff;
  const chunk = (type: string, data: Uint8Array) => {
    const tb = new TextEncoder().encode(type);
    const body = new Uint8Array(tb.length + data.length);
    body.set(tb, 0);
    body.set(data, tb.length);
    const out = new Uint8Array(4 + body.length + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(body, 4);
    dv.setUint32(4 + body.length, crc32(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, size);
  idv.setUint32(4, size);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", zlib), chunk("IEND", new Uint8Array(0))];
  let total = 0;
  for (const p of parts) total += p.length;
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}
