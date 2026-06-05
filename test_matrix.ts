// Headless verification of the real Matrix engine (matrix.ts) — the same code
// main.ts runs in the Deno process. Exercises login, sync, room list, live
// timeline (via the engine's onEvent callback), and sending, between two users
// on a local homeserver.
//
//   deno run -A test_matrix.ts <baseUrl>
//
// Exit code 0 = all checks passed.

import * as sdk from "npm:matrix-js-sdk@41.6.0";
import { MatrixEngine } from "./matrix.ts";

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

// Register through the UIA dummy flow (open registration).
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

console.log(`\n=== Matrix engine verification against ${baseUrl} ===`);
console.log(`users: ${alice.user} / ${bob.user}\n`);

await register(alice.user, alice.password);
await register(bob.user, bob.password);
check("register two users", true);

// Drive the engine exactly as main.ts does.
const aliceEngine = new MatrixEngine();
const bobEngine = new MatrixEngine();

const aSession = await aliceEngine.loginPassword(baseUrl, alice.user, alice.password);
const bSession = await bobEngine.loginPassword(baseUrl, bob.user, bob.password);
check("MatrixEngine.loginPassword for both", !!aSession.accessToken && !!bSession.accessToken,
  `${aSession.userId} / ${bSession.userId}`);

// Collect Bob's live timeline events through the same onEvent path SSE uses.
const bobTimeline: any[] = [];
bobEngine.onEvent = (e) => { if (e.kind === "timeline") bobTimeline.push(e); };
const aliceTimeline: any[] = [];
aliceEngine.onEvent = (e) => { if (e.kind === "timeline") aliceTimeline.push(e); };

await aliceEngine.start(aSession);
await bobEngine.start(bSession);
check("both engines started + reached PREPARED", aliceEngine.isLoggedIn() && bobEngine.isLoggedIn());

// Alice creates a room and invites Bob (use raw client just for setup).
const aClient = sdk.createClient({
  baseUrl, accessToken: aSession.accessToken, userId: aSession.userId, deviceId: aSession.deviceId,
});
const { room_id: roomId } = await aClient.createRoom({
  name: "Engine Test " + stamp,
  topic: "deno desktop matrix client engine test",
  invite: [bSession.userId],
});
const bClient = sdk.createClient({
  baseUrl, accessToken: bSession.accessToken, userId: bSession.userId, deviceId: bSession.deviceId,
});
await bClient.joinRoom(roomId);
await sleep(2000);

// getRooms() — same call the getRooms binding makes.
check("Alice's engine.getRooms() lists the room",
  aliceEngine.getRooms().some((r) => r.roomId === roomId));
check("Bob's engine.getRooms() lists the room after joining",
  bobEngine.getRooms().some((r) => r.roomId === roomId));

// Live send/receive via engine.send() + onEvent('timeline').
const body = "Hello from Alice @ " + new Date().toISOString();
await aliceEngine.send(roomId, body);
await sleep(4000);
check("Bob's engine emitted a 'timeline' event for the message",
  bobTimeline.some((e) => e.roomId === roomId && e.msg.body === body),
  `from ${bobTimeline.at(-1)?.msg?.senderName ?? "?"}`);

// getTimeline() history — same call selectRoom binding makes.
check("engine.getTimeline() returns the message",
  bobEngine.getTimeline(roomId).some((m) => m.body === body),
  `${bobEngine.getTimeline(roomId).length} message(s)`);

// Reply back.
const reply = "Hi Alice! @ " + Date.now();
await bobEngine.send(roomId, reply);
await sleep(4000);
check("Alice's engine received Bob's reply",
  aliceTimeline.some((e) => e.msg.body === reply));

// Unread accounting feeds the dock badge in main.ts.
check("engine.totalUnread() is a number", typeof bobEngine.totalUnread() === "number",
  `total=${bobEngine.totalUnread()}`);

await aliceEngine.logout();
await bobEngine.logout();

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===\n`);
Deno.exit(failures === 0 ? 0 : 1);
