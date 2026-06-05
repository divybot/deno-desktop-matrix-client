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

| Side | File | Responsibility |
| ---- | ---- | -------------- |
| Deno process | `matrix.ts` | `MatrixEngine`: all `matrix-js-sdk` logic (login, sync, rooms, timeline, send). Framework-agnostic — no webview references — so it's unit-testable headlessly. |
| Deno process | `main.ts` | Serve the UI + an SSE stream over `Deno.serve`, open the `Deno.BrowserWindow`, expose the engine as `bind()` handlers, forward engine events to the UI, own the tray / dock badge / window lifecycle. |
| Webview (Chromium) | `app.js` | **No SDK.** Calls bindings, subscribes to the SSE stream, renders, and fires web `Notification`s. |
| UI | `index.html`, `styles.css` | Static shell served by `main.ts`. |

`matrix-js-sdk` is pinned to **41.6.0** via `npm:matrix-js-sdk@41.6.0`, imported
in `matrix.ts` and bundled into the app by `deno desktop`.

**Webview → Deno** (bindings exposed via `win.bind(name, fn)`):
`login`, `restore`, `getRooms`, `selectRoom`, `sendMessage`, `markRead`,
`logout`, plus desktop helpers `focusWindow`, `attention` (`Deno.dock.bounce`),
and `log` (prints webview logs in the Deno terminal).

**Deno → Webview** (Server-Sent Events on `GET /events`): the engine pushes
`{kind:"sync"|"rooms"|"timeline", …}` messages as Matrix events arrive, so the
sidebar and open timeline update live. The dock unread badge
(`Deno.dock.setBadge`) is computed in Deno from the engine's unread totals.

Session (homeserver + access token) is persisted in the webview's
`localStorage`; on relaunch `app.js` calls `restore(session)` to skip login.

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
deno desktop --hmr --allow-net --allow-read --allow-env main.ts

# Plain run:
deno desktop --allow-net --allow-read --allow-env main.ts
```

Or via the `deno.json` tasks: `deno task dev` / `deno task start`.

> On a headless Linux box the webview needs a display. Run it under a virtual
> framebuffer, e.g. `xvfb-run -s "-screen 0 1280x900x24" deno desktop … main.ts`.

### Build a distributable bundle

```bash
deno desktop --output MatrixClient --icon icon.png \
  --allow-net --allow-read --allow-env main.ts
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
   session is persisted to `localStorage`, so a relaunch skips re-login.
2. **Room list** — joined rooms appear in the sidebar with avatars and an unread
   badge; click one to open it.
3. **Timeline** — recent history loads and updates live as events arrive.
4. **Send** — type in the composer and press **Enter** (Shift+Enter for a newline).

### Desktop features

- **Tray icon** with a tooltip and a *Show Window* / *Quit* menu; clicking the
  icon shows/focuses the window. Closing the window hides it to the tray — use
  the tray’s **Quit** to exit.
- **Unread badge** — the total unread count is pushed to `Deno.dock.setBadge()`.
- **Notifications** — a native notification fires for a new message in a room
  that isn’t currently focused; clicking it focuses the window and opens that room.

## Verifying the Matrix logic headlessly

The desktop GUI needs a display, but the Matrix integration (login, sync, room
list, **live send/receive**, history) can be verified headlessly with
`test_matrix.ts`, which drives the **real `MatrixEngine` from `matrix.ts`** (the
same code `main.ts` runs) against any homeserver:

```bash
# Against a local homeserver (e.g. a dev Synapse with open registration):
deno run -A test_matrix.ts http://localhost:8008
```

It registers two users, logs in, has user A create/​invite, syncs both to
`PREPARED`, then asserts B receives A's message live and vice-versa. Exit code 0
means all checks passed.

## Limitations

- **No end-to-end encryption.** This demo does not initialize a crypto store, so
  end-to-end-encrypted rooms are read-only: their messages render as
  *“🔒 Encrypted message”* and the composer is disabled for them. Unencrypted
  rooms work fully. (Adding E2EE means calling `client.initRustCrypto()` with a
  persistent store.)
- Uses the in-memory store, so each launch performs a fresh initial sync.

## Security

No credentials are committed. The access token / user id / device id are stored
only in the webview’s `localStorage` on your machine. *Sign out* (the ⏻ button)
calls `/logout` and clears it.
