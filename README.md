# Matrix Client — a `deno desktop` demo

A small native desktop **Matrix chat client**: a Chromium webview UI driven by a
Deno process, using the official [`matrix-js-sdk`](https://github.com/matrix-org/matrix-js-sdk).

It demonstrates the core chat flow (login → room list → live timeline → send)
plus the desktop-native chrome that `deno desktop` exposes: a **tray icon**, a
**dock/taskbar unread badge**, and native **notifications**.

![layout: sidebar room list + timeline + composer]

## Architecture

The **Matrix SDK runs in the Deno process** (not the webview). The webview is a
thin renderer that calls bindings and listens to a live event stream:

| Side               | File                       | Responsibility                                                                                                                                                                                        |
|--------------------|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Deno process       | `matrix.ts`                | `MatrixEngine`: all `matrix-js-sdk` logic (login, sync, rooms, timeline, send). Framework-agnostic — no webview references — so it's unit-testable headlessly.                                        |
| Deno process       | `main.ts`                  | Serve the UI + an SSE stream over `Deno.serve`, open the `Deno.BrowserWindow`, expose the engine as `bind()` handlers, forward engine events to the UI, own the tray / dock badge / window lifecycle. |
| Webview (Chromium) | `app.js`                   | **No SDK.** Calls bindings, subscribes to the SSE stream, and renders. (Notifications are fired on the Deno side.)                                                                                    |
| UI                 | `index.html`, `styles.css` | Static shell served by `main.ts`.                                                                                                                                                                     |

`matrix-js-sdk` is pinned to **41.6.0** via `npm:matrix-js-sdk@41.6.0`, imported
in `matrix.ts` and bundled into the app by `deno desktop`.

**Webview → Deno** (bindings exposed via `win.bind(name, fn)`):
`login`, `autoStart` (resume a persisted session), `getRooms`, `selectRoom`,
`sendMessage`, `markRead`, `logout`, `setActiveRoom` (so notifications are
suppressed for the open room), and `log` (prints webview logs in the Deno terminal).

**Deno → Webview** (Server-Sent Events on `GET /events`): the engine pushes
`{kind:"sync"|"rooms"|"timeline", …}` messages as Matrix events arrive, so the
sidebar and open timeline update live, plus `{kind:"openRoom"}` when a
notification is clicked.

Everything desktop-native lives on the Deno side: the dock unread badge
(`Deno.dock.setBadge`, computed from the engine's unread totals), the tray, and
**native notifications** — `main.ts` fires a `Notification` for an incoming
message in a room that isn't focused/open (tracking window focus via the
window's `focus`/`blur` events and the open room via `setActiveRoom`); clicking
it shows/focuses the window and opens that room.

Session (homeserver + access token + device id) is persisted **on disk by the
Deno process** (`~/.matrix-client-demo.json`, mode `0600`) — the webview's
`localStorage` is ephemeral here, and this keeps the token out of the webview.
On relaunch `app.js` calls `autoStart`, which resumes the saved session.

## Prerequisites

This app requires the **`deno desktop`** binary, which only exists on the
in-development branch `desktop-framework-hmr` of `https://github.com/crowlkats/deno`.
It is **not** in any released Deno. Build it from source:

```bash
git clone --recurse-submodules --branch desktop-framework-hmr \
  https://github.com/crowlkats/deno.git deno-desktop
cd deno-desktop
# Also needed: a sibling `libsui` checkout (path dep `../sui`, version 0.13.0):
#   git clone https://github.com/denoland/sui ../sui   (check out the 0.13.0 commit)
cargo build --bin deno          # debug build is fine
export PATH="$PWD/target/debug:$PATH"
deno desktop --help             # verify the subcommand exists
```

Build prerequisites: Rust stable toolchain, a C/C++ compiler, `cmake`, and
`protoc`. The first `deno desktop` run downloads a prebuilt **WEF** UI backend
archive (checksum-verified) — it needs network access the first time.

> **Building `deno desktop` from source needs `libdenort`.** `deno desktop`
> assembles your app into a `.so` that is appended to a `libdenort.{so,dylib,dll}`
> base (the embedded Deno runtime). A released `deno` downloads a matching
> prebuilt `libdenort` from `dl.deno.land`; a *from-source* build has no
> published artifact for its dev version, so build it yourself and point
> `deno desktop` at it:
>
> ```bash
> cargo build -p denort_desktop          # produces target/<profile>/libdenort.so
> # deno desktop finds it next to the deno binary, or set DENORT_DESKTOP_BIN=/path/to/libdenort.so
> ```
>
> On Linux this cdylib link requires a `rusty_v8` built with
> `-DV8_TLS_USED_IN_LIBRARY` (shared-library-safe TLS). If the prebuilt v8
> archive for the pinned version lacks it, the link fails with
> `relocation R_X86_64_TPOFF32 ... cannot be used with -shared`; in that case
> build v8 from source (`V8_FROM_SOURCE=1`, heavy).

## Run

From this directory (`matrix-client/`):

```bash
# Dev, with hot reload (reloads the window on save):
deno desktop --hmr --conditions=matrix-org:wasm-esm --allow-net --allow-read --allow-write --allow-env main.ts

# Plain run:
deno desktop --conditions=matrix-org:wasm-esm --allow-net --allow-read --allow-write --allow-env main.ts
```

Or via the `deno.json` tasks: `deno task dev` / `deno task start`.

> On a headless Linux box the webview needs a display. Run it under a virtual
> framebuffer, e.g. `xvfb-run -s "-screen 0 1280x900x24" deno desktop … main.ts`.

### Build a distributable bundle

```bash
deno desktop --output MatrixClient --icon icon.png \
  --conditions=matrix-org:wasm-esm --allow-net --allow-read --allow-write --allow-env main.ts
```

This produces a platform bundle (`.app` on macOS, an app dir / `.AppImage` on
Linux, a dir / `.exe` on Windows).

> `deno desktop` compiles the entry into a self-contained binary, so the UI
> assets (`index.html`, `app.js`, `styles.css`) are **embedded** into the module
> graph via `import … with { type: "text" }` in `main.ts` — they're served from
> memory at runtime (and still hot-reload from disk under `--hmr`). The tray
> icon is generated in-code; `icon.png` is only used at build time for the app
> icon (`--icon` / `desktop.app.icons`).

## Using it

1. **Login** — the homeserver defaults to `https://matrix.org`. Enter a username
   (local part like `alice` or the full `@alice:matrix.org`) and password, or
   expand *“sign in with an access token”* and paste an access token. The
   session is persisted on disk by the Deno process, so a relaunch skips re-login.
2. **Room list** — joined rooms appear in the sidebar with avatars and an unread
   badge; click one to open it.
3. **Timeline** — recent history loads and updates live as events arrive.
4. **Send** — type in the composer and press **Enter** (Shift+Enter for a newline).
   **Markdown** is supported: it's rendered to HTML on send (`marked`) and sent
   as a Matrix `formatted_body`, so `**bold**`, `*italic*`, `` `code` ``, lists,
   quotes, and links show formatted here and in other clients.

Incoming messages with an HTML `formatted_body` are rendered too — through an
allowlist sanitizer (the Matrix HTML subset only; scripts/unknown tags/unsafe
URLs are stripped, and links don't navigate the app away).

### Desktop features

- **Tray icon — quick access to unread chats.** A speech-bubble status-bar icon
  (a macOS template image, so it adapts to light/dark). **Left-click opens a
  popover "menu"** (a frameless `Tray.attachPanel` window) that shows the total
  unread count, lists your **unread rooms** (click one to open it), and offers
  **Mark All as Read**, **New Direct Message…**, **Show Window**, and **Quit** —
  it re-renders live off the same `/events` SSE stream. The **right-click**
  native menu (`Tray.setMenu`) offers the same actions. Closing the window hides
  it to the tray.

  > Why a popover for left-click? `just-wef` reserves **right-click** for the
  > native tray menu and routes **left-click** to the `click` handler — there's
  > no API to pop the native menu on left-click — so the click-menu is built with
  > `attachPanel`, the documented menu-bar-app pattern.
- **Native menu bar** (`win.setApplicationMenu`), with working actions and
  accelerators:
  - **File** — *New Direct Message…* (`⌘N`, prompts for a user id and opens the
    DM), *Sign Out*.
  - **Edit** — *Undo / Redo / Cut / Copy / Paste / Select All* (system roles, for
    the composer).
  - **View** — *Next / Previous Room* (`⌘]` / `⌘[`), *Mark All as Read*
    (`⇧⌘A`), *Reload* (`⌘R`), *Toggle Developer Tools*.
  - **Help** — *Project Repository*. (macOS app menu: *About*, *Hide*, *Quit*.)

  Menu clicks arrive in `main.ts` as `menuclick` events; actions either run on
  the engine (mark-all-read, new DM, sign out) or are pushed to the UI over SSE
  (`nav`, `openRoom`, `loggedOut`).
- **Unread badge** — the total unread count is pushed to `Deno.dock.setBadge()`.
- **Notifications** — fired from the Deno process for a new message in a room
  that isn’t focused/open; clicking it focuses the window and opens that room.

## Verifying the Matrix logic headlessly

The desktop GUI needs a display, but the Matrix integration (login, sync, room
list, **live send/receive**, history) can be verified headlessly with
`test_matrix.ts`, which drives the **real `MatrixEngine` from `matrix.ts`** (the
same code `main.ts` runs) against any homeserver:

```bash
# Against a local homeserver (e.g. a dev Synapse with open registration):
deno run -A test_matrix.ts http://localhost:8008
```

It registers two users, logs in, syncs both to `PREPARED`, checks live
send/receive in a plain room, **and verifies end-to-end encryption** (creates an
encrypted room and asserts the other user decrypts the message). Exit code 0
means all checks passed.

## Encryption (E2EE)

The engine initializes the Rust crypto stack (`client.initRustCrypto()`), so
**encrypted rooms work**: incoming messages are decrypted (rendering a
*“🔒 Decrypting…”* placeholder that's replaced in place once the clear text
arrives, via an `Event.decrypted` → SSE `decrypted` update), and you can send to
encrypted rooms (the SDK encrypts with Megolm automatically). The composer is
only locked if crypto failed to initialize.

It uses an **in-memory** crypto store (Deno has no IndexedDB), so keys live for
the session: messages exchanged while running decrypt, but history from *before*
launch — and rooms whose keys you never received — may show
*“🔒 Unable to decrypt”* (and if crypto fails to initialize, encrypted messages
just show *“🔒 Encrypted message”* and their composer is locked). Device
verification / cross-signing isn't implemented (messages are sent to all of a
user's devices).

> **Status of E2EE under `deno desktop` (a branch bug).** `@matrix-org/matrix-sdk-crypto-wasm`
> ships several entrypoints. Under Deno's default `node` condition it loads its
> `.wasm` via `fs.readFile`, which throws `NotSupported` for files embedded in a
> compiled app — so crypto falls back to read-only there. The fix is the
> `matrix-org:wasm-esm` condition, which selects the entry that `import()`s the
> `.wasm` as an ES module (deno-compile embeds it, no fs read). The `deno.json`
> tasks pass `--conditions=matrix-org:wasm-esm`, and **`deno run` honors it**
> (crypto + E2EE verified headlessly via `test_matrix.ts`). But **`deno desktop`
> currently drops `--conditions` on its compile path**, so the compiled app still
> resolves the `node` entry and encrypted rooms stay read-only. Once `deno desktop`
> threads `--conditions` into the compile (it carries the rest of `flags`), E2EE
> works in the GUI too — no app change needed. Two underlying `deno` issues:
> (1) `deno compile`/`deno desktop` not applying custom export conditions;
> (2) node `fs.readFile`/`readFileSync` of embedded files returning `NotSupported`.

## Limitations

- In-memory store (sync + crypto), so each launch performs a fresh initial sync
  and can't decrypt pre-launch encrypted history.
- No device verification / cross-signing UI.

## Security

No credentials are committed. The access token / user id / device id are stored
only on your machine, in `~/.matrix-client-demo.json` (mode `0600`), written by
the Deno process. *Sign out* (the ⏻ button) calls `/logout` and deletes the file.
