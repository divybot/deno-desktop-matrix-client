// Matrix engine — runs in the Deno process.
//
// Framework-agnostic wrapper around matrix-js-sdk (no Deno.BrowserWindow / no
// webview references), so it can be unit-tested headlessly (see test_matrix.ts)
// and reused by main.ts, which exposes its methods to the webview as bindings
// and forwards its events to the UI over SSE.

// deno-lint-ignore-file no-explicit-any
import * as sdk from "npm:matrix-js-sdk@41.6.0";

export interface Session {
  baseUrl: string;
  accessToken: string;
  userId: string;
  deviceId?: string;
}

export interface RoomSummary {
  roomId: string;
  name: string;
  unread: number;
  avatarUrl: string | null;
  encrypted: boolean;
  lastTs: number;
}

export interface TimelineMsg {
  eventId: string;
  sender: string;
  senderName: string;
  avatarUrl: string | null;
  body: string;
  ts: number;
  type: string;
  msgtype: string;
  mine: boolean;
}

/** Events emitted to the consumer (main.ts forwards these over SSE). */
export type EngineEvent =
  | { kind: "sync"; state: string }
  | { kind: "rooms"; rooms: RoomSummary[] }
  | { kind: "timeline"; roomId: string; roomName: string; msg: TimelineMsg }
  | { kind: "decrypted"; roomId: string; msg: TimelineMsg };

export class MatrixEngine {
  private client: any = null;
  private baseUrl = "";
  private roomsDebounce: ReturnType<typeof setTimeout> | null = null;
  private ready = false; // becomes true once the initial sync (PREPARED) is done
  private cryptoEnabled = false; // end-to-end encryption available this session
  /** Set by the consumer to receive live updates. */
  onEvent: (e: EngineEvent) => void = () => {};

  isLoggedIn(): boolean {
    return !!this.client;
  }

  userId(): string | null {
    return this.client?.getUserId() ?? null;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  async loginPassword(
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<Session> {
    if (!username || !password) throw new Error("Enter a username and password.");
    baseUrl = normalizeBase(baseUrl);
    const tmp = sdk.createClient({ baseUrl });
    const res = await tmp.login("m.login.password", {
      identifier: { type: "m.id.user", user: username },
      password,
      initial_device_display_name: "Matrix Client (deno desktop)",
    } as any);
    return {
      baseUrl,
      accessToken: res.access_token,
      userId: res.user_id,
      deviceId: res.device_id,
    };
  }

  async loginToken(baseUrl: string, accessToken: string): Promise<Session> {
    baseUrl = normalizeBase(baseUrl);
    const tmp = sdk.createClient({ baseUrl, accessToken });
    const who = await tmp.whoami();
    return { baseUrl, accessToken, userId: who.user_id, deviceId: who.device_id };
  }

  // ── Start syncing ───────────────────────────────────────────────────────────
  // By default returns once the initial sync completes (handy for tests). Pass
  // { waitForPrepared: false } to return as soon as the sync loop starts, so the
  // UI isn't blocked on a slow initial sync — rooms stream in via onEvent.
  async start(session: Session, opts: { waitForPrepared?: boolean } = {}): Promise<void> {
    this.baseUrl = session.baseUrl;
    this.client = sdk.createClient({
      baseUrl: session.baseUrl,
      accessToken: session.accessToken,
      userId: session.userId,
      deviceId: session.deviceId,
    });

    this.ready = false;
    this.cryptoEnabled = false;
    const c = this.client;

    // End-to-end encryption via the Rust crypto stack (WASM). Uses an
    // in-memory store (no IndexedDB in Deno), so keys live for the session:
    // messages sent/received while running decrypt, but history from before
    // launch may be undecryptable. Sending to all devices (we don't block on
    // verification). Degrades gracefully to read-only if init fails.
    try {
      await c.initRustCrypto({ useIndexedDB: false });
      // Default policy sends to all devices (we don't gate on verification),
      // which is what we want for this demo.
      this.cryptoEnabled = true;
    } catch (e) {
      console.error("crypto init failed (encrypted rooms will be read-only):", e);
    }

    // Live (and backlog) decryption: an encrypted event renders a placeholder,
    // then updates here once the clear text is available.
    c.on("Event.decrypted", (event: any) => {
      if (!this.ready) return; // backlog decrypts are picked up when a room opens
      const room = this.client.getRoom(event.getRoomId());
      if (!room || !isRenderable(event)) return;
      this.onEvent({ kind: "decrypted", roomId: room.roomId, msg: this.mapEvent(room, event) });
    });
    c.on("sync", (state: string) => {
      this.onEvent({ kind: "sync", state });
      if (state === "PREPARED") {
        this.ready = true;
        this.emitRooms();
      }
    });
    c.on("Room.timeline", (event: any, room: any, toStart: boolean, _r: boolean, data: any) => {
      if (toStart) return;
      if (data && data.liveEvent === false) return;
      if (!isRenderable(event)) return;
      // Suppress the initial-sync backlog: matrix-js-sdk replays each room's
      // recent history as timeline events before PREPARED — those are not new,
      // so don't render-append or notify for them.
      if (!this.ready) return;
      this.onEvent({
        kind: "timeline",
        roomId: room.roomId,
        roomName: room.name || room.roomId,
        msg: this.mapEvent(room, event),
      });
      this.emitRoomsDebounced();
    });
    c.on("Room", () => this.emitRoomsDebounced());
    c.on("Room.name", () => this.emitRoomsDebounced());
    c.on("Room.receipt", () => this.emitRoomsDebounced());

    await c.startClient({ initialSyncLimit: 30 });
    if (opts.waitForPrepared !== false) await this.waitPrepared(45000);
  }

  private waitPrepared(timeoutMs: number): Promise<void> {
    const c = this.client;
    if (c.getSyncState() === "PREPARED") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sync timed out")), timeoutMs);
      c.on("sync", (state: string) => {
        if (state === "PREPARED") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  async logout(): Promise<void> {
    try {
      await this.client?.logout(true);
    } catch { /* ignore */ }
    try {
      this.client?.stopClient();
    } catch { /* ignore */ }
    this.client = null;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────
  getRooms(): RoomSummary[] {
    if (!this.client) return [];
    return this.client.getRooms()
      .filter((r: any) => r.getMyMembership() === "join")
      .map((r: any) => this.summary(r))
      .sort((a: RoomSummary, b: RoomSummary) => b.lastTs - a.lastTs);
  }

  getTimeline(roomId: string): TimelineMsg[] {
    const room = this.client?.getRoom(roomId);
    if (!room) return [];
    return room.getLiveTimeline().getEvents()
      .filter(isRenderable)
      .map((e: any) => this.mapEvent(room, e));
  }

  roomInfo(
    roomId: string,
  ): { name: string; topic: string; encrypted: boolean; canSend: boolean } {
    const room = this.client?.getRoom(roomId);
    if (!room) return { name: roomId, topic: "", encrypted: false, canSend: false };
    const encrypted = this.isEncrypted(room);
    return {
      name: room.name || roomId,
      topic: this.topic(room),
      encrypted,
      canSend: !encrypted || this.cryptoEnabled,
    };
  }

  cryptoReady(): boolean {
    return this.cryptoEnabled;
  }

  totalUnread(): number {
    return this.getRooms().reduce((n, r) => n + r.unread, 0);
  }

  // ── Writes ──────────────────────────────────────────────────────────────────
  async send(roomId: string, body: string): Promise<void> {
    const room = this.client?.getRoom(roomId);
    if (this.isEncrypted(room) && !this.cryptoEnabled) {
      throw new Error("Encryption isn't available this session; can't send to this room.");
    }
    await this.client.sendTextMessage(roomId, body); // SDK encrypts automatically when needed
  }

  markRead(roomId: string): void {
    const room = this.client?.getRoom(roomId);
    this.sendReceipt(room);
  }

  /** Mark every joined room as read (used by the menu bar / tray). */
  markAllRead(): void {
    if (!this.client) return;
    for (const r of this.client.getRooms()) {
      if (r.getMyMembership?.() === "join" && unreadCount(r) > 0) this.sendReceipt(r);
    }
  }

  private sendReceipt(room: any): void {
    if (!room) return;
    try {
      const events = room.getLiveTimeline().getEvents();
      const last = events[events.length - 1];
      if (last) this.client.sendReadReceipt(last).catch(() => {});
    } catch { /* ignore */ }
  }

  /** Create (or reuse) a direct-message room with a user and return its id. */
  async startDirectMessage(userId: string): Promise<string> {
    if (!this.client) throw new Error("Not signed in.");
    if (!/^@[^:]+:.+/.test(userId)) {
      throw new Error("Enter a full user ID like @alice:matrix.org");
    }
    const { room_id } = await this.client.createRoom({
      is_direct: true,
      invite: [userId],
      preset: "trusted_private_chat",
    });
    return room_id;
  }

  // Thin passthroughs (used by tests / future UI).
  async createRoom(opts: any): Promise<string> {
    const { room_id } = await this.client.createRoom(opts);
    return room_id;
  }
  async joinRoom(roomId: string): Promise<void> {
    await this.client.joinRoom(roomId);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  private emitRooms() {
    this.onEvent({ kind: "rooms", rooms: this.getRooms() });
  }
  private emitRoomsDebounced() {
    if (this.roomsDebounce != null) clearTimeout(this.roomsDebounce);
    this.roomsDebounce = setTimeout(() => this.emitRooms(), 200);
  }

  private summary(room: any): RoomSummary {
    return {
      roomId: room.roomId,
      name: room.name || room.roomId,
      unread: unreadCount(room),
      avatarUrl: this.roomAvatar(room),
      encrypted: this.isEncrypted(room),
      lastTs: room.getLastActiveTimestamp() || 0,
    };
  }

  private mapEvent(room: any, event: any): TimelineMsg {
    const sender = event.getSender();
    return {
      eventId: event.getId(),
      sender,
      senderName: this.memberName(room, sender),
      avatarUrl: this.memberAvatar(room, sender),
      body: messageText(event, this.cryptoEnabled),
      ts: event.getTs(),
      type: event.getType(),
      msgtype: event.getContent()?.msgtype || "m.text",
      mine: sender === this.client.getUserId(),
    };
  }

  // Avatars are served through the local /media proxy (see main.ts), which
  // fetches with the access token — homeservers now require auth for media, so
  // a bare <img src=mxc> would 401 and fall back to the placeholder.
  private mediaPath(mxc: string | null | undefined): string | null {
    return mxc ? `/media?mxc=${encodeURIComponent(mxc)}&size=64` : null;
  }
  private roomAvatar(room: any): string | null {
    try {
      return this.mediaPath(room.getMxcAvatarUrl?.());
    } catch {
      return null;
    }
  }
  private memberAvatar(room: any, userId: string): string | null {
    try {
      return this.mediaPath(room.getMember?.(userId)?.getMxcAvatarUrl?.());
    } catch {
      return null;
    }
  }

  /** Fetch an authenticated media thumbnail (used by the /media route). */
  async fetchThumbnail(
    mxc: string,
    size: number,
  ): Promise<{ contentType: string; body: ArrayBuffer } | null> {
    if (!this.client || !mxc) return null;
    const url = this.client.mxcUrlToHttp(mxc, size, size, "crop", false, true, true);
    if (!url) return null;
    const token = this.client.getAccessToken();
    const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    if (!res.ok) return null;
    return {
      contentType: res.headers.get("content-type") || "image/png",
      body: await res.arrayBuffer(),
    };
  }
  private memberName(room: any, userId: string): string {
    try {
      return room.getMember?.(userId)?.name || userId;
    } catch {
      return userId;
    }
  }
  private topic(room: any): string {
    try {
      return room.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic || "";
    } catch {
      return "";
    }
  }
  private isEncrypted(room: any): boolean {
    if (!room) return false;
    try {
      if (typeof room.hasEncryptionStateEvent === "function") {
        return room.hasEncryptionStateEvent();
      }
      return this.client?.isRoomEncrypted?.(room.roomId) ?? false;
    } catch {
      return false;
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────
function normalizeBase(url: string): string {
  return (url || "https://matrix.org").trim().replace(/\/+$/, "");
}

function isRenderable(event: any): boolean {
  const t = event.getType();
  return t === "m.room.message" || t === "m.room.encrypted";
}

function unreadCount(room: any): number {
  try {
    const n = room.getUnreadNotificationCount?.("total");
    if (typeof n === "number") return n;
  } catch { /* fall through */ }
  try {
    return room.getUnreadNotificationCount?.() ?? 0;
  } catch {
    return 0;
  }
}

function messageText(event: any, cryptoEnabled: boolean): string {
  if (event.isDecryptionFailure?.()) return "🔒 Unable to decrypt this message";
  if (event.getType() === "m.room.encrypted") {
    // Still ciphertext: pending decryption if crypto is on, otherwise we just
    // can't read it this session.
    return cryptoEnabled ? "🔒 Decrypting…" : "🔒 Encrypted message";
  }
  const c = event.getContent() || {};
  switch (c.msgtype) {
    case "m.emote":
      return `* ${c.body || ""}`;
    case "m.image":
      return `🖼 ${c.body || "image"}`;
    case "m.file":
      return `📎 ${c.body || "file"}`;
    case "m.audio":
      return `🔊 ${c.body || "audio"}`;
    case "m.video":
      return `🎬 ${c.body || "video"}`;
    default:
      return c.body || "";
  }
}

/** Map an SDK / network error to a friendly message. */
export function humanError(e: any): string {
  const m = String(e?.message || e || "");
  if (e?.errcode === "M_FORBIDDEN" || /M_FORBIDDEN|Invalid password/i.test(m)) {
    return "Login failed: wrong username or password.";
  }
  if (/fetch|network|Failed to|ENOTFOUND|ECONN/i.test(m)) {
    return "Network error reaching the homeserver. " + m;
  }
  return "Error: " + m;
}
