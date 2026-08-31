/**
 * The dsh-chrome server plugin: spawns the standalone Rust `chrome-daemon`
 * process and points the in-box MCP bridge at it. The bridge no longer runs
 * in-process — all WebSocket pumping, tool dispatch, and serialization live
 * in the daemon (serde_json on real OS threads, no GC, no shared event loop).
 *
 * dsh web stays responsible for two things:
 *   1. spawning the daemon as a detached, persistent process (it survives dsh
 *      web exiting, and a later start re-adopts it via probeRunning());
 *   2. registering the in-box `@deepseek-ai/dsh-mcp-client` against the
 *      daemon's own `/chrome/mcp` (port 37086), so the agent sees
 *      `mcp__chrome__*` tools.
 *
 * A `/chrome/status` proxy is mounted on the shared web server so the GUI's
 * liveness probe still works on port 3080 without reaching across ports.
 *
 * @module dsh-chrome/server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
// Type-only: contributes the `webServer` service augmentation to Context.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'chrome-server'

/** The bridge cannot mount routes before the web server exists. */
export const inject = ['webServer']

/** The daemon's fixed port. The extension's `dsh_chrome_url` default matches. */
export const DAEMON_PORT = 37086

/** Where the daemon's routes live. */
const MCP_PATH = '/chrome/mcp'
const STATUS_PATH = '/chrome/status'
const SHUTDOWN_PATH = '/chrome/shutdown'

/** How long to wait for a retiring daemon to release the port. */
const PORT_FREE_TIMEOUT_MS = 5_000
/** Poll interval while waiting for that release. */
const PORT_FREE_POLL_MS = 100

/**
 * The in-box MCP bridge's config, pointed at the daemon's own port. The URL
 * and the endpoint can never disagree — both are the daemon's fixed port.
 */
export function bridgeConfig(): McpClient.StreamableHttpConfig {
  return {
    serverName: 'chrome',
    transport: 'streamable-http',
    url: `http://127.0.0.1:${DAEMON_PORT}${MCP_PATH}`,
    headers: {},
    // Above the hub's own 30 s timeout, so its actionable message wins the race.
    toolCallTimeoutMs: 35_000,
    // The daemon may still be starting up; a failed first connect must not abort
    // the profile. The bridge's reconnect policy attaches when we answer.
    failOnStartupError: false,
  }
}

/** Per-platform binary name: Windows needs the `.exe` suffix. */
const EXE = process.platform === 'win32' ? 'chrome-daemon.exe' : 'chrome-daemon'
/** Platform-arch tuple matching the CI matrix output layout under `binaries/`. */
const PLATFORM_ARCH = `${process.platform}-${process.arch}`

/**
 * Resolve the chrome-daemon binary: the shipped per-platform copy first, then
 * a dev build beside the plugin, then the legacy install dir.
 */
function resolveBinary(): string | undefined {
  // `fileURLToPath(new URL('.', import.meta.url))` yields the directory of
  // this module with a trailing slash handled correctly. `path.dirname` on
  // the raw pathname would strip the trailing "lib/" and return the package
  // root one level too high.
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    // shipped: the CI matrix drops each platform's binary under binaries/<platform>-<arch>/
    path.resolve(here, '..', 'binaries', PLATFORM_ARCH, EXE),
    // dev: built beside the plugin
    path.resolve(here, '..', 'daemon', 'target', 'release', EXE),
    // legacy install dir
    path.resolve(process.env.HOME ?? '', '.dsh-chrome', 'bin', EXE),
  ]
  return candidates.find(p => existsSync(p))
}

/** What a live daemon reports about itself. */
export interface DaemonStatus {
  /** True when something answered `/chrome/status` with 200. */
  running: boolean
  /**
   * The running executable's content hash. Absent when the daemon predates the
   * field (an upgrade from an older build) or could not hash itself.
   */
  build?: string
}

/**
 * Probe the daemon: whether one is listening, and which build it is.
 *
 * A malformed or field-less body still counts as running — reuse must not hinge
 * on parsing, only the restart decision does.
 */
function probeStatus(): Promise<DaemonStatus> {
  return new Promise(resolve => {
    const req = http.get(
      { host: '127.0.0.1', port: DAEMON_PORT, path: STATUS_PATH, timeout: 800 },
      res => {
        if (res.statusCode !== 200) { res.resume(); res.on('end', () => resolve({ running: false })); return }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(body)
            const build = (parsed as { build?: unknown })?.build
            // Omit the key entirely when absent: exactOptionalPropertyTypes
            // distinguishes a missing property from an explicit undefined.
            resolve(typeof build === 'string' && build !== '' ? { running: true, build } : { running: true })
          } catch {
            resolve({ running: true })
          }
        })
      },
    )
    req.on('error', () => resolve({ running: false }))
    req.on('timeout', () => { req.destroy(); resolve({ running: false }) })
  })
}

/**
 * Decide what to do about a daemon that is already listening.
 *
 * Restarting is reserved for the one case we can prove: both hashes are known
 * and differ. Anything undecidable reuses the daemon — a needless restart drops
 * the extension's socket, so the bar for it is evidence, not suspicion.
 *
 * @param running - the build hash reported by the live daemon, if any.
 * @param local - the hash of the binary this install would spawn, if readable.
 */
export function restartDecision(
  running: string | undefined,
  local: string | undefined,
): { restart: boolean; reason: 'match' | 'changed' | 'unknown-running' | 'unknown-local' } {
  if (local === undefined) return { restart: false, reason: 'unknown-local' }
  if (running === undefined) return { restart: false, reason: 'unknown-running' }
  return running === local ? { restart: false, reason: 'match' } : { restart: true, reason: 'changed' }
}

/**
 * SHA-256 of the binary this install would spawn — the same identity the daemon
 * reports for itself, so the two are directly comparable.
 */
export function localBuildHash(bin: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(bin)).digest('hex')
  } catch {
    return undefined
  }
}

/** Ask a live daemon to retire itself. Resolves false when it will not. */
function requestShutdown(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.request(
      { host: '127.0.0.1', port: DAEMON_PORT, path: SHUTDOWN_PATH, method: 'POST', timeout: 2000 },
      res => {
        res.resume()
        // 202 is the daemon accepting. A 404 means it predates this endpoint.
        res.on('end', () => resolve(res.statusCode === 202))
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

/** Poll until nothing answers on the port, or the timeout expires. */
async function waitForPortFree(): Promise<boolean> {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS
  for (;;) {
    if (!(await probeStatus()).running) return true
    if (Date.now() >= deadline) return false
    await new Promise(r => setTimeout(r, PORT_FREE_POLL_MS))
  }
}

/**
 * Spawn the detached daemon, wiring its stdio into the harness logger for as
 * long as this process lives. The child handle is intentionally not returned:
 * nothing here owns the daemon's lifetime.
 */
function startDaemon(log: Context['logger']): void {
  const bin = resolveBinary()
  if (bin === undefined) {
    log?.error('chrome-daemon binary not found; the agent will not see mcp__chrome__* tools')
    return
  }
  // npm tarball extraction can drop the executable bit on non-Windows.
  if (process.platform !== 'win32') {
    try { chmodSync(bin, 0o755) } catch { /* may already be executable / readonly */ }
  }
  const child = spawn(bin, ['--port', String(DAEMON_PORT), '--host', '127.0.0.1'], {
    // Own process group: a group-wide signal to `dsh web` (Ctrl-C, SIGHUP) must
    // not reach the daemon, and it outlives the parent as an orphan (PPID 1).
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', d => log?.info(`[chrome-daemon] ${d.toString().trimEnd()}`))
  child.stderr.on('data', d => log?.warn(`[chrome-daemon] ${d.toString().trimEnd()}`))
  child.on('exit', code => { log?.info(`chrome-daemon exited code=${code}`) })
  log?.info(`chrome-daemon spawned: ${bin} (pid ${child.pid})`)
  // `child.unref()` alone is not enough: the two stdio pipes hold their own
  // event-loop references, which would still pin this process at exit. Unref
  // all three. The 'data' listeners above keep working while dsh web lives;
  // once it exits the daemon's writes get EPIPE, which it ignores by design.
  //
  // The streams are typed `Readable`, but with `stdio: 'pipe'` Node backs them
  // with a libuv handle exposing `unref`. Probe for it instead of asserting, so
  // a stream without one is simply skipped rather than throwing.
  child.unref()
  for (const stream of [child.stdout, child.stderr]) {
    const maybe = stream as Readable & { unref?: () => void }
    maybe.unref?.()
  }
}

/** Proxy `/chrome/status` on the shared web server to the daemon. */
function createStatusProxyHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (_req, res) => {
    const proxy = http.request(
      { host: '127.0.0.1', port: DAEMON_PORT, path: STATUS_PATH, method: 'GET', timeout: 3000 },
      upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers)
        upstream.pipe(res)
      },
    )
    proxy.on('error', () => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'dsh-chrome', running: false, extension_connected: false }))
    })
    proxy.on('timeout', () => { proxy.destroy(); res.writeHead(504); res.end() })
    proxy.end()
  }
}

/**
 * Bring the right daemon up: spawn one when the port is idle, reuse a matching
 * one, and retire a stale one left behind by an older install.
 *
 * The stale case is why this exists. The daemon is detached and outlives
 * `dsh web`, so after an upgrade the previous build is still listening and this
 * process holds no handle to it — it can only be retired by asking it to stop.
 */
async function ensureDaemon(log: Context['logger']): Promise<void> {
  const status = await probeStatus()
  if (!status.running) { startDaemon(log); return }

  const bin = resolveBinary()
  const local = bin === undefined ? undefined : localBuildHash(bin)
  const { restart, reason } = restartDecision(status.build, local)

  if (!restart) {
    if (reason === 'unknown-running') {
      log?.warn(
        'chrome-daemon is running but reports no build id (older than this plugin); ' +
        'reusing it. To adopt the shipped binary, stop it once: kill the chrome-daemon process.',
      )
    } else if (reason === 'unknown-local') {
      log?.warn('cannot hash the local chrome-daemon binary; reusing the running one')
    } else {
      log?.info('chrome-daemon already running with a matching build; reusing it')
    }
    return
  }

  const short = (h: string | undefined): string => h?.slice(0, 12) ?? 'unknown'
  log?.info(`chrome-daemon build changed (running ${short(status.build)} \u2192 shipped ${short(local)}); restarting`)

  if (!(await requestShutdown())) {
    log?.warn(
      'the running chrome-daemon refused the shutdown request; keeping it. ' +
      'Stop it manually to pick up the new build.',
    )
    return
  }
  if (!(await waitForPortFree())) {
    // Start anyway: a daemon that cannot bind fails loudly rather than leaving
    // the port silently half-owned.
    log?.error(`port ${DAEMON_PORT} still busy after shutdown; starting the new daemon anyway`)
  }
  startDaemon(log)
}

/**
 * Spawn the daemon, mount the status proxy, and load the in-box MCP client.
 * @param ctx - plugin context carrying the webServer service.
 */
export function apply(ctx: Context): void {
  const log = ctx.logger

  void ensureDaemon(log)

  ctx.effect(() =>
    ctx.webServer.register({ kind: 'exact', path: STATUS_PATH, handler: createStatusProxyHandler() }),
  )

  // Deliberately no unload hook: the daemon is a persistent service that
  // outlives this plugin and this dsh web process. The next start re-adopts it
  // via ensureDaemon(); stopping it is `kill -TERM <pid>` or POST /chrome/shutdown.

  // The whole agent-facing tool surface: the in-box MCP bridge, pointed at the
  // daemon's own endpoint on its fixed port.
  ctx.plugin(McpClient, bridgeConfig())
}

// Re-exported so the test suite can parse frames the way the daemon does.
export { parseClientFrame } from './protocol.ts'
