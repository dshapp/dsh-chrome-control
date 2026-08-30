/**
 * The dsh-chrome server plugin: spawns the standalone Rust `chrome-daemon`
 * process and points the in-box MCP bridge at it. The bridge no longer runs
 * in-process — all WebSocket pumping, tool dispatch, and serialization live
 * in the daemon (serde_json on real OS threads, no GC, no shared event loop).
 *
 * dsh web stays responsible for two things:
 *   1. spawning the daemon child and killing it on unload;
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
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
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

/** Where the three routes live on the daemon. */
const MCP_PATH = '/chrome/mcp'
const STATUS_PATH = '/chrome/status'

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
  const here = path.dirname(new URL('.', import.meta.url).pathname)
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

/** Probe whether a daemon is already listening (dev-friendly: reuse it). */
function probeRunning(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(
      { host: '127.0.0.1', port: DAEMON_PORT, path: STATUS_PATH, timeout: 800 },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)) },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/** Spawn the daemon child, wiring its stdio into the harness logger. */
function startDaemon(log: Context['logger']): ChildProcess | undefined {
  const bin = resolveBinary()
  if (bin === undefined) {
    log?.error('chrome-daemon binary not found; the agent will not see mcp__chrome__* tools')
    return undefined
  }
  const child = spawn(bin, ['--port', String(DAEMON_PORT), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', d => log?.info(`[chrome-daemon] ${d.toString().trimEnd()}`))
  child.stderr.on('data', d => log?.warn(`[chrome-daemon] ${d.toString().trimEnd()}`))
  child.on('exit', code => { log?.info(`chrome-daemon exited code=${code}`) })
  log?.info(`chrome-daemon spawned: ${bin} (pid ${child.pid})`)
  return child
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
 * Spawn the daemon, mount the status proxy, and load the in-box MCP client.
 * @param ctx - plugin context carrying the webServer service.
 */
export function apply(ctx: Context): void {
  const log = ctx.logger
  let child: ChildProcess | undefined

  void (async () => {
    const running = await probeRunning()
    if (!running) child = startDaemon(log)
    else log?.info('chrome-daemon already running; reusing it')
  })()

  ctx.effect(() =>
    ctx.webServer.register({ kind: 'exact', path: STATUS_PATH, handler: createStatusProxyHandler() }),
  )

  // Sever the child and live sockets when the plugin unloads.
  ctx.effect(() => () => {
    if (child !== undefined && !child.killed) {
      child.kill('SIGTERM')
    }
  })

  // The whole agent-facing tool surface: the in-box MCP bridge, pointed at the
  // daemon's own endpoint on its fixed port.
  ctx.plugin(McpClient, bridgeConfig())
}

// Re-exported so the test suite can parse frames the way the daemon does.
export { parseClientFrame } from './protocol.ts'
