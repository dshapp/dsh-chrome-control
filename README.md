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

## Tests

```bash
pnpm run check   # typecheck + build + unit and end-to-end tests
```

The end-to-end suite boots a real `webServer` on an ephemeral port, lets the
in-box bridge discover the catalog through `/chrome/mcp`, attaches a fake
extension over the real WebSocket, and completes a whole tool call round trip.
