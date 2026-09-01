# dsh-chrome

A DeepSeek Harness bundle that gives the agent control of the user's **real
Chrome** — their profile, their logins, their open tabs — as `mcp__chrome__*`
tools. Pure TypeScript: no separate daemon process, no binaries.

## How it fits together

```
agent ──MCP──▶ dsh web (shared HTTP server, default :3080)
                 ├─ POST /chrome/mcp     MCP Streamable HTTP endpoint
                 ├─ GET  /chrome/ws  ────WebSocket──▶ extension ──CDP──▶ page
                 └─ GET  /chrome/status  liveness probe
```

The bundle's patch contributes two rows:

| Row | Job |
|---|---|
| `chrome-server` | Mounts the three routes above on the harness's own `webServer`, and loads the in-box `@deepseek-ai/dsh-mcp-client` bridge against `/chrome/mcp` — using the web server's **actual** listening port, so no port is configured anywhere. The bridge publishes the catalog as `mcp__chrome__*`. |
| `chrome-skills` | Registers the bundled skill that teaches the agent how to drive those tools. |

## Install

```bash
dsh plugin --profile web add dsh-chrome-control     # or a link: dependency for local dev
```

Then **install the browser extension yourself** — loading an unpacked extension
is a decision only the browser's owner can make, so nothing does it for you.
Point the extension's *DSH server* address at the same `dsh web` URL (default
`http://127.0.0.1:3080`); it derives the bridge socket `ws(s)://…/chrome/ws`
from it. Until it is connected, every tool returns a message saying exactly
that.

## Behaviour worth knowing

- **No port configuration.** The routes live on whatever port `dsh web`
  listens on; the internal MCP bridge reads that port at load time. Change the
  web port and everything follows.
- **Startup order does not matter.** The bridge is loaded with
  `failOnStartupError: false` and its own reconnect policy; the extension may
  attach at any time.
- **This plugin needs the `webServer` service** (the Web composition). In a
  profile without it, the row stays pending and nothing breaks.
- **Migrating from the daemon versions:** the old standalone `chrome-daemon`
  (port 37086) is no longer used. If one is still running, stop it with
  `~/.dsh-chrome/bin/chrome-daemon stop` and delete `~/.dsh-chrome`; this
  plugin never kills processes it does not own.
- **Response size guards.** Text tool results are capped at 256 KiB (with a
  trailing `[truncated]` marker) and top-level arrays past 4000 elements are
  sliced; the extension WebSocket frame limit is 8 MiB. These keep a giant
  `snapshot` full outline or `get_text` dump from stalling the shared `dsh web`
  event loop. For very large pages, narrow `snapshot` to a subtree (or pass a
  container ref), or prefer `get_text`.

## Tools

`navigate`, `find_tab`, `list_tabs`, `close_tab`, `close_session`,
`snapshot`, `click`, `fill`, `upload`, `evaluate`, `screenshot`, `save_as_pdf`,
`mouse_click`, `key_type`, `send_keys`, `hover`, `focus`, `select`,
`scroll`, `scroll_into_view`, `find`, `wait`, `wait_for_selector`,
`network`, `network_detail`, `dialog`, `get_text` — each prefixed
`mcp__chrome__`.

`upload` forwards local paths to Chrome. Its selector may be a file input or a visible upload trigger; the extension resolves standard label, ARIA and unique-container relationships without framework-specific selectors.

These are distinct from the harness's built-in `browser_*` tools, which drive a
separate WebKit panel sharing no cookies or logins with Chrome. The bundled
skill tells the agent when to use which.

## Security

While the extension is connected the agent acts with **your logged-in
sessions**, `upload` may expose explicitly named local files to the page, and `mouse_click`/`key_type` send *trusted* input that pages cannot
distinguish from your own. The extension popup has an **Allow agent control**
toggle that severs this immediately. The WebSocket endpoint only accepts
upgrades whose `Origin` is a `chrome-extension://` page (or none, for local
probes); a web page that finds the endpoint cannot attach. Everything binds to
whatever interface `dsh web` itself is configured for, and sends no telemetry.

## Host operations (`/host/*`)

Alongside the Chrome bridge, the daemon exposes a small REST surface the
extension's settings UI uses for things an extension cannot do itself, because
it cannot start a process:

```
POST /host/capabilities    { }
POST /host/git             { cwd, args[] }
POST /host/plugin          { action, name? }
POST /host/server/version  { }
POST /host/server/restart  { }
POST /host/server/update   { }
POST /host/disable         { }
```

These are **not** MCP and share no codec with `/chrome/mcp`; nothing here goes
near the control WebSocket, since a second connection to `/chrome/ws` makes the
hub fail the extension's in-flight calls and drop it for tens of seconds.

Every route is a POST, including the capability probe, and that is load-bearing
rather than stylistic: Chrome sends **no `Origin` header** on a simple `GET`
from an extension page, so an Origin-only guard cannot authenticate one. An
earlier revision exposed `GET /host/capabilities` and the side panel's own probe
was refused, which made the whole Git tab report "this deployment does not offer
host operations". `POST` with `application/json` is a preflighted request, so
the header is always present. `GET` now answers 405 naming the right method.

A non-zero subprocess exit is returned as HTTP 200 with an `exitCode`, because
the UI needs git's own stderr rather than a generic 500.

### dsh is resolved through pnpm, by shim path

`/host/server/*` runs `$PNPM_HOME/dsh`, never whatever `dsh` is first on
`PATH`, and never the path that shim resolves to. Both rules exist because of
measured failure modes:

- A machine can carry two installs (say an npm-global copy earlier on `PATH`
  plus the pnpm one). Updating with pnpm while launching from `PATH` updates one
  copy and keeps running the other, so the version never changes and the update
  looks like it worked.
- The pnpm shim `exec`s a content-addressed directory whose hash changes on
  every reinstall. A resolved inner path is therefore valid only until the next
  update — exactly when a restart tends to be requested.

When dsh is not a pnpm install, these routes return 400 with
`reason: "dsh-not-installed-via-pnpm"` rather than falling back.

### The guard, and what it does not cover

`/host/*` requires `Origin` to equal the one authorized extension exactly, and
is served only when the daemon is bound to loopback. That stops web pages
(browsers will not let a page forge an extension origin) and other extensions
(compared with `==`, not `starts_with` — the `/chrome/*` helper's prefix policy
would admit any extension and also allows a missing `Origin`, so it is
deliberately not reused).

It does **not** stop another local process running as the same user: such a
process can set any `Origin`, and loopback TCP exposes no peer pid or uid. This
is an accepted trade-off, on the grounds that the same process can already run
`git` and `pnpm` directly. What limits it instead, and must not be relaxed:

1. subcommand **and option** allowlists (`-c`, `--upload-pack` and friends are
   refused, since they make git run arbitrary programs);
2. registry-only package specs (`file:`, `link:`, `git+`, `github:` refused);
3. the server operations taking no caller-supplied command, pid or package name
   — restart proves the process on the port really is `dsh web` before
   signalling it;
4. `POST /host/disable`, which withdraws the whole surface until restart while
   leaving `/chrome/*` untouched;
5. refusing to serve `/host/*` at all when bound off the loopback.

## Tests

```bash
pnpm run check   # typecheck + build + unit and end-to-end tests
cd daemon && cargo test
```

The end-to-end suite boots a real `webServer` on an ephemeral port, lets the
in-box bridge discover the catalog through `/chrome/mcp`, attaches a fake
extension over the real WebSocket, and completes a whole tool call round trip.
