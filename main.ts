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

// The tray popover ("menu" shown on left-click). A tiny self-contained page
// loaded into the attached panel window; it talks to Deno via panel bindings
// and re-renders live off the shared /events SSE stream.
const TRAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;font-family:-apple-system,system-ui,sans-serif;background:#1b2027;color:#e7ecf2;font-size:13px}
  body{display:flex;flex-direction:column;padding:8px;box-sizing:border-box}
  .hdr{font-size:11px;color:#8b97a7;padding:4px 8px 8px;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
  .list{flex:1;overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:1px}
  button.item{display:flex;width:100%;align-items:center;gap:9px;background:transparent;border:0;color:inherit;text-align:left;padding:7px 8px;border-radius:8px;cursor:pointer;font-size:13px}
  button.item:hover{background:#222933}
  .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{background:#0dbd8b;color:#04150f;border-radius:10px;padding:0 7px;font-size:11px;font-weight:700}
  .dot{width:26px;height:26px;border-radius:50%;color:#04150f;display:grid;place-items:center;font-weight:700;text-transform:uppercase;flex:0 0 auto}
  .sep{height:1px;background:#2c343f;margin:6px 4px}
  .muted{color:#8b97a7;padding:12px 8px}
</style></head><body>
  <div class="hdr" id="hdr">Matrix</div>
  <div class="list" id="list"></div>
  <div class="sep"></div>
  <div id="actions"></div>
<script>
  const $=id=>document.getElementById(id);
  async function call(n,...a){for(let i=0;i<40;i++){const f=globalThis.bindings&&globalThis.bindings[n];if(typeof f==="function")return await f(...a);await new Promise(r=>setTimeout(r,50));}}
  function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e;}
  function colorFor(k){let h=0;for(let i=0;i<(k||"").length;i++)h=(h*31+k.charCodeAt(i))>>>0;const c=["#0dbd8b","#368bd6","#ac3ba8","#e64f7a","#ff812d","#2dc2c5","#5c56f5","#74d12c"];return c[h%c.length];}
  async function render(){
    const d=await call("trayData"); if(!d)return;
    $("hdr").textContent=!d.signedIn?"Not signed in":(d.total>0?d.total+" unread":"No unread messages");
    const list=$("list"); list.innerHTML="";
    if(d.signedIn&&d.rooms.length){
      for(const r of d.rooms){
        const b=el("button","item");
        const av=el("div","dot",(r.name||"?").replace(/^[@#!]/,"").charAt(0)); av.style.background=colorFor(r.name); b.appendChild(av);
        b.appendChild(el("div","name",r.name));
        b.appendChild(el("div","badge",String(r.unread)));
        b.onclick=()=>call("trayOpen",r.roomId);
        list.appendChild(b);
      }
    } else { list.appendChild(el("div","muted",d.signedIn?"You are all caught up.":"Open the window to sign in.")); }
    const acts=$("actions"); acts.innerHTML="";
    const add=(label,fn,en)=>{const b=el("button","item",label);if(en===false)b.style.opacity=.5;else b.onclick=fn;acts.appendChild(b);};
    if(d.signedIn){ add("✓   Mark all as read",()=>call("trayMarkAll"),d.total>0); add("✎   New Direct Message…",()=>call("trayNewDm")); }
    add("⤢   Show Window",()=>call("trayShow"));
    add("⏻   Quit",()=>call("trayQuit"));
  }
  try{const es=new EventSource("/events");es.onmessage=e=>{try{const d=JSON.parse(e.data);if(d.kind==="rooms"||d.kind==="sync")render();}catch(_){}};}catch(_){}
  render();
</script></body></html>`;

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
  if (msg.mine) return;
  if (msg.type !== "m.room.message" && msg.type !== "m.room.encrypted") return;
  const seen = e.roomId === activeRoomId && windowFocused;
  if (seen) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    Deno.dock?.bounce(false);
  } catch { /* ignore */ }
  const title = e.roomName && e.roomName !== msg.senderName
    ? `${msg.senderName} (${e.roomName})`
    : msg.senderName;
  // For an encrypted event we likely don't have clear text yet at notify time;
  // show a neutral body rather than the "Decrypting…" placeholder.
  const body = msg.type === "m.room.encrypted"
    ? "🔒 New message"
    : String(msg.body ?? "").slice(0, 200);
  try {
    const n = new Notification(title, {
      body,
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
    Deno.dock?.setBadge(n > 0 ? String(n) : ""); // "" clears; null can render as "null"
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

let trayPanel: Deno.TrayPanel | null = null;

try {
  tray = new Deno.Tray();
  tray.setIcon(makeTrayIconPng(32));
  tray.setTooltip("Matrix");
  // Right-click still opens the native menu (just-wef reserves right-click for
  // it); left-click toggles the popover panel attached after the server starts.
  tray.setMenu(trayMenuItems());
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

const httpServer = Deno.serve((req) => {
  const url = new URL(req.url);
  switch (url.pathname) {
    case "/tray":
      return text(TRAY_HTML, "text/html; charset=utf-8");
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

// ── Tray popover (left-click "menu") ─────────────────────────────────────────
// just-wef reserves right-click for the native menu, so the click-to-open
// "menu" is a frameless popover anchored under the icon (the documented
// menu-bar-app pattern). It reuses the same SSE stream to stay live.
if (tray) {
  try {
    const panelUrl = `http://127.0.0.1:${(httpServer.addr as Deno.NetAddr).port}/tray`;
    trayPanel = tray.attachPanel({ url: panelUrl, width: 300, height: 380, hideOnBlur: true });
    const panel = trayPanel.window;

    panel.bind("trayData", async () => {
      const rooms = engine.isLoggedIn() ? engine.getRooms() : [];
      return {
        signedIn: engine.isLoggedIn(),
        total: rooms.reduce((n, r) => n + r.unread, 0),
        rooms: rooms.filter((r) => r.unread > 0).slice(0, 8).map((r) => ({
          roomId: r.roomId,
          name: r.name,
          unread: r.unread,
        })),
      };
    });
    panel.bind("trayOpen", async (roomId) => {
      trayPanel?.hide();
      win.show();
      win.focus();
      broadcast({ kind: "openRoom", roomId: String(roomId) });
      return true;
    });
    panel.bind("trayMarkAll", async () => {
      engine.markAllRead();
      updateBadge();
      return true;
    });
    panel.bind("trayNewDm", async () => {
      trayPanel?.hide();
      win.show();
      win.focus();
      await newDirectMessage();
      return true;
    });
    panel.bind("trayShow", async () => {
      trayPanel?.hide();
      win.show();
      win.focus();
      return true;
    });
    panel.bind("trayQuit", async () => {
      quit();
      return true;
    });
  } catch (e) {
    console.error("Tray panel unavailable:", e);
  }
}

console.log("Matrix Client running. Window id:", win.windowId);

// ── Tray icon PNG (generated in-code so nothing is read from disk) ───────────
function makeTrayIconPng(size: number): Uint8Array {
  const rowLen = 1 + size * 4;
  const raw = new Uint8Array(rowLen * size);
  const S = size;

  // A chat speech bubble: rounded-rect body + a tail, with three dots cut out.
  // Drawn in solid black on transparent so macOS renders it as a template image
  // (auto-adapts to light/dark menu bars).
  const inRoundRect = (px: number, py: number, x0: number, y0: number, x1: number, y1: number, rad: number) => {
    const qx = Math.max(x0 + rad, Math.min(px, x1 - rad));
    const qy = Math.max(y0 + rad, Math.min(py, y1 - rad));
    return (px - qx) ** 2 + (py - qy) ** 2 <= rad * rad;
  };
  const inTri = (px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
    const s = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
      (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
    const d1 = s(px, py, ax, ay, bx, by);
    const d2 = s(px, py, bx, by, cx, cy);
    const d3 = s(px, py, cx, cy, ax, ay);
    return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)));
  };
  const inBubble = (px: number, py: number) => {
    let on = inRoundRect(px, py, 0.12 * S, 0.10 * S, 0.88 * S, 0.62 * S, 0.17 * S) ||
      inTri(px, py, 0.30 * S, 0.57 * S, 0.30 * S, 0.86 * S, 0.55 * S, 0.57 * S);
    if (on) {
      const cy = 0.36 * S, rr = 0.052 * S;
      for (const cx of [0.34 * S, 0.50 * S, 0.66 * S]) {
        if ((px - cx) ** 2 + (py - cy) ** 2 <= rr * rr) {
          on = false;
          break;
        }
      }
    }
    return on;
  };

  for (let y = 0; y < S; y++) {
    const o = y * rowLen;
    raw[o] = 0; // filter: none
    for (let x = 0; x < S; x++) {
      // 3×3 supersample for smooth edges
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          if (inBubble(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits++;
        }
      }
      const p = o + 1 + x * 4;
      raw[p] = 0x00;
      raw[p + 1] = 0x00;
      raw[p + 2] = 0x00;
      raw[p + 3] = Math.round((hits / 9) * 255);
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
