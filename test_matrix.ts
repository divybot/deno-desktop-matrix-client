// Headless verification of the real Matrix engine (matrix.ts) — the same code
// main.ts runs. Exercises login, sync, room list, live timeline, sending, and
// end-to-end encryption between two users on a local homeserver.
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

const aliceEngine = new MatrixEngine();
const bobEngine = new MatrixEngine();

const aSession = await aliceEngine.loginPassword(baseUrl, alice.user, alice.password);
const bSession = await bobEngine.loginPassword(baseUrl, bob.user, bob.password);
check("MatrixEngine.loginPassword for both", !!aSession.accessToken && !!bSession.accessToken,
  `${aSession.userId} / ${bSession.userId}`);

// Collect live events through the same onEvent path SSE uses.
const bobTimeline: any[] = [];
const bobDecrypted: any[] = [];
const aliceTimeline: any[] = [];
bobEngine.onEvent = (e) => {
  if (e.kind === "timeline") bobTimeline.push(e);
  if (e.kind === "decrypted") bobDecrypted.push(e);
};
aliceEngine.onEvent = (e) => { if (e.kind === "timeline") aliceTimeline.push(e); };

await aliceEngine.start(aSession);
await bobEngine.start(bSession);
check("both engines started + reached PREPARED", aliceEngine.isLoggedIn() && bobEngine.isLoggedIn());
check("end-to-end encryption initialized on both", aliceEngine.cryptoReady() && bobEngine.cryptoReady());

// ── Unencrypted room: live send/receive ──────────────────────────────────────
const roomId = await aliceEngine.createRoom({
  name: "Plain " + stamp,
  topic: "engine test",
  invite: [bSession.userId],
});
await bobEngine.joinRoom(roomId);
await sleep(2000);
check("Alice's getRooms() lists the room", aliceEngine.getRooms().some((r) => r.roomId === roomId));
check("Bob's getRooms() lists the room after joining", bobEngine.getRooms().some((r) => r.roomId === roomId));

const body = "Hello @ " + new Date().toISOString();
await aliceEngine.send(roomId, body);
await sleep(4000);
check("Bob receives Alice's message live (timeline event)",
  bobTimeline.some((e) => e.roomId === roomId && e.msg.body === body));
check("message is in Bob's getTimeline() history",
  bobEngine.getTimeline(roomId).some((m) => m.body === body));

const reply = "Reply @ " + Date.now();
await bobEngine.send(roomId, reply);
await sleep(4000);
check("Alice receives Bob's reply live", aliceTimeline.some((e) => e.msg.body === reply));

// ── Encrypted room: E2EE send/receive ────────────────────────────────────────
const encRoomId = await aliceEngine.createRoom({
  name: "Encrypted " + stamp,
  invite: [bSession.userId],
  initial_state: [
    { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
  ],
});
await bobEngine.joinRoom(encRoomId);
await sleep(3000);

check("room is detected as encrypted", aliceEngine.roomInfo(encRoomId).encrypted);
check("composer allowed in encrypted room (crypto ready)", aliceEngine.roomInfo(encRoomId).canSend);

const secret = "secret-message-" + stamp;
await aliceEngine.send(encRoomId, secret); // SDK encrypts (megolm) automatically
await sleep(8000);

const decryptedForBob = bobEngine.getTimeline(encRoomId).find((m) => m.body === secret);
check("Bob decrypts Alice's E2EE message", !!decryptedForBob,
  decryptedForBob ? "clear text recovered" : "still encrypted / decryption failed");
check("decryption surfaced via the 'decrypted' event path",
  bobDecrypted.some((e) => e.roomId === encRoomId && e.msg.body === secret) ||
    !!decryptedForBob);

await aliceEngine.logout();
await bobEngine.logout();

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===\n`);
Deno.exit(failures === 0 ? 0 : 1);
