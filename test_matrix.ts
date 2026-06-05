// Headless verification of the Matrix logic that app.js relies on.
//
// Runs with the freshly-built `deno` (npm compat), against a local homeserver.
// It mirrors the exact matrix-js-sdk calls app.js makes — login/register,
// startClient + "sync"=PREPARED, getRooms(), live "Room.timeline" listener,
// sendTextMessage — and asserts send/receive works between two users.
//
//   deno run -A test_matrix.ts <baseUrl>
//
// Exit code 0 = all checks passed.

import * as sdk from "npm:matrix-js-sdk@41.6.0";

const baseUrl = Deno.args[0] ?? "http://localhost:8008";
const stamp = Date.now().toString(36);
const alice = { user: `alice_${stamp}`, password: "test-pw-Aa1!" + stamp };
const bob = { user: `bob_${stamp}`, password: "test-pw-Bb2!" + stamp };

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Register a user through the UIA dummy flow (open registration).
async function register(user: string, password: string) {
  const c = sdk.createClient({ baseUrl });
  try {
    await c.register(user, password, null, { type: "m.login.dummy" } as any);
  } catch (e: any) {
    const session = e?.data?.session;
    if (!session) throw e;
    await c.register(user, password, session, { type: "m.login.dummy", session } as any);
  }
}

async function loginClient(user: string, password: string) {
  const tmp = sdk.createClient({ baseUrl });
  const res = await tmp.login("m.login.password", {
    identifier: { type: "m.id.user", user },
    password,
    initial_device_display_name: "test-harness",
  } as any);
  const client = sdk.createClient({
    baseUrl,
    accessToken: res.access_token,
    userId: res.user_id,
    deviceId: res.device_id,
  });
  return client;
}

function waitForPrepared(client: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sync PREPARED timeout")), 40000);
    client.on("sync", (state: string) => {
      if (state === "PREPARED") { clearTimeout(t); resolve(); }
      if (state === "ERROR") { /* keep waiting; transient */ }
    });
  });
}

console.log(`\n=== Matrix logic verification against ${baseUrl} ===`);
console.log(`users: ${alice.user} / ${bob.user}\n`);

// 1. Registration (exercises the homeserver + SDK register path)
await register(alice.user, alice.password);
await register(bob.user, bob.password);
check("register two users", true);

// 2. Login (same call shape as app.js loginWithPassword)
const a = await loginClient(alice.user, alice.password);
const b = await loginClient(bob.user, bob.password);
check("login both (m.login.password)", !!a.getAccessToken() && !!b.getAccessToken(),
  `${a.getUserId()} / ${b.getUserId()}`);

// 3. Alice creates a room and invites Bob
const { room_id: roomId } = await a.createRoom({
  name: "Verify Room " + stamp,
  topic: "deno desktop matrix client test",
  invite: [b.getUserId()!],
});
check("create room + invite", !!roomId, roomId);

// 4. Start syncing both (app.js: startClient({initialSyncLimit:30}) + sync PREPARED)
await a.startClient({ initialSyncLimit: 30 });
await b.startClient({ initialSyncLimit: 30 });
await Promise.all([waitForPrepared(a), waitForPrepared(b)]);
check("both clients reached sync=PREPARED", true);

// Bob joins the invite
await b.joinRoom(roomId);
await sleep(1500);

// 5. Room list populates (app.js: getRooms() filtered to join)
const aRooms = a.getRooms().filter((r: any) => r.getMyMembership() === "join");
const bRooms = b.getRooms().filter((r: any) => r.getMyMembership() === "join");
check("Alice sees the room in her room list", aRooms.some((r: any) => r.roomId === roomId));
check("Bob sees the room after joining", bRooms.some((r: any) => r.roomId === roomId));

// 6. Live timeline: Bob listens, Alice sends — same listener shape as app.js
const body = "Hello from Alice @ " + new Date().toISOString();
const received = new Promise<any>((resolve) => {
  b.on("Room.timeline", (event: any, room: any, toStart: boolean) => {
    if (toStart) return;
    if (room?.roomId === roomId && event.getType() === "m.room.message" &&
        event.getContent().body === body) {
      resolve(event);
    }
  });
});

await a.sendTextMessage(roomId, body);
const ev = await Promise.race([received, sleep(15000).then(() => null)]);
check("Bob receives Alice's message live (Room.timeline)", !!ev,
  ev ? `from ${ev.getSender()}` : "timed out");

// 7. Timeline history readable (app.js: getLiveTimeline().getEvents())
const bRoom = b.getRoom(roomId);
const msgs = bRoom.getLiveTimeline().getEvents().filter((e: any) => e.getType() === "m.room.message");
check("message is in Bob's timeline history", msgs.some((e: any) => e.getContent().body === body),
  `${msgs.length} message event(s)`);

// 8. Reply back the other direction
const reply = "Hi Alice, got it! @ " + Date.now();
const aGot = new Promise<any>((resolve) => {
  a.on("Room.timeline", (event: any, room: any, toStart: boolean) => {
    if (!toStart && room?.roomId === roomId && event.getContent()?.body === reply) resolve(event);
  });
});
await b.sendTextMessage(roomId, reply);
const ev2 = await Promise.race([aGot, sleep(15000).then(() => null)]);
check("Alice receives Bob's reply live", !!ev2);

a.stopClient();
b.stopClient();

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===\n`);
Deno.exit(failures === 0 ? 0 : 1);
