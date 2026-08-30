/**
 * The dsh-chrome server plugin: mounts the extension bridge on the harness's
 * own web server instead of a separate daemon process.
 *
 * Three routes ride the shared `webServer` (the same HTTP service that serves
 * the Web GUI, default port 3080):
 *
 *   - `POST /chrome/mcp`   — the MCP Streamable HTTP endpoint;
 *   - `GET  /chrome/ws`    — the browser extension's WebSocket;
 *   - `GET  /chrome/status` — liveness and wiring probe.
 *
 * The agent-facing tools still come from the in-box
 * `@deepseek-ai/dsh-mcp-client` bridge — loaded here programmatically and
 * pointed at this process's own `/chrome/mcp`, using the web server's *actual*
 * listening port so the two can never disagree.
 *
 * @module dsh-chrome/server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
// Type-only: contributes the `webServer` service augmentation to Context.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WebSocketServer, type WebSocket } from 'ws'

import { DispatchError, Hub } from './hub.ts'
import { handle, disposeSerializeWorker, parseFailure, SERVER_NAME, PROTOCOL_VERSION, serverVersion } from './mcp.ts'
import { parseClientFrame, type Json, type ServerFrame } from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'chrome-server'

/** The bridge cannot mount routes before the web server exists. */
export const inject = ['webServer']

/** How long one tool call may wait for the extension. */
export const TOOL_TIMEOUT_MS = 30_000

/** Where the three routes live on the shared server. */
export const MCP_PATH = '/chrome/mcp'
export const WS_PATH = '/chrome/ws'
export const STATUS_PATH = '/chrome/status'

/** Keepalive interval for a silent MV3 service worker. */
const PING_INTERVAL_MS = 30_000

/**
 * Hard cap on a single extension WebSocket frame. An oversized `tool_result`
 * (a multi-MB `snapshot` full tree, a `get_text` raw dump) would otherwise be
 * buffered and parsed on the main thread, stalling the event loop until Chrome
 * reconnects pile up. `ws` closes the socket past this limit and the hub's
 * existing disconnect path fails any in-flight calls.
 */
const WS_MAX_PAYLOAD = 8 * 1024 * 1024

/**
 * Only a browser extension page may open the control socket. Chrome sends
 * `Origin: chrome-extension://<id>`; anything else — notably a web page that
 * found the endpoint — is refused. A non-browser client (tests, curl) sends no
 * Origin at all and is allowed.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true
  return origin.startsWith('chrome-extension://')
}

/**
 * The in-box MCP bridge's config, derived from the web server's actual port so
 * the URL and the endpoint can never disagree.
 */
export function bridgeConfig(port: number): McpClient.StreamableHttpConfig {
  return {
    serverName: 'chrome',
    transport: 'streamable-http',
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    headers: {},
    // Above the hub's own timeout, so its actionable message wins the race.
    toolCallTimeoutMs: TOOL_TIMEOUT_MS + 5_000,
    // The extension may attach later; a failed first connect must not abort
    // the profile. The bridge's reconnect policy attaches when we answer.
    failOnStartupError: false,
  }
}

/** Read one request body as UTF-8 text. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: Json): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * MCP requests. A notification yields 202 with an empty body; everything else
 * answers with `application/json`, which the Streamable HTTP client accepts.
 * The client may try to open a server-to-client SSE stream with GET; this
 * server never initiates messages, so 405 declines and the client proceeds.
 */
function createMcpHandler(hub: Hub) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(req))
    } catch (failure) {
      sendJson(res, 400, parseFailure(String(failure instanceof Error ? failure.message : failure)))
      return
    }
    const response = await handle(parsed, hub)
    if (response === undefined) {
      res.writeHead(202)
      res.end()
      return
    }
    sendJson(res, 200, response)
  }
}

/**
 * Liveness and wiring probe: confirms the endpoint is ours and reports whether
 * the extension is attached. The shape matches the old daemon's `/status`.
 */
function createStatusHandler(hub: Hub, startedAt: number) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    const extension = hub.extensionState()
    sendJson(res, 200, {
      name: SERVER_NAME,
      version: serverVersion(),
      protocolVersion: PROTOCOL_VERSION,
      running: true,
      extension_connected: extension.connected,
      extension_version: extension.version,
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    })
  }
}

/** Pump one extension socket until it closes. */
function serveExtension(socket: WebSocket, hub: Hub, log: Context['logger']): void {
  const outbound = (frame: ServerFrame): boolean => {
    if (socket.readyState !== socket.OPEN) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }
  hub.attach(outbound)
  log?.info('chrome extension connected')

  // Keepalive: a silent MV3 service worker is indistinguishable from a live
  // one until a probe fails, so probe on an interval.
  const pinger = setInterval(() => hub.ping(), PING_INTERVAL_MS)

  socket.on('message', data => {
    const frame = parseClientFrame(String(data))
    if (frame === undefined) {
      log?.warn('invalid frame from extension')
      return
    }
    switch (frame.type) {
      case 'hello':
        log?.info(`hello from extension ${frame.extensionVersion}`)
        hub.recordHello(frame.extensionVersion)
        outbound({ type: 'hello_ack' })
        break
      case 'pong':
        break
      case 'tool_result':
        hub.resolve(
          frame.responseToRequestId,
          frame.error !== undefined
            ? new DispatchError('tool', frame.error)
            : (frame.data ?? null),
        )
        break
    }
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    clearInterval(pinger)
    hub.detach(outbound)
    log?.info('chrome extension disconnected')
  })
}

/**
 * Mount the bridge on the shared web server and load the in-box MCP client
 * against it.
 * @param ctx - plugin context carrying the webServer service.
 */
export function apply(ctx: Context): void {
  const hub = new Hub(TOOL_TIMEOUT_MS)
  const startedAt = Date.now()
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD })

  ctx.effect(() =>
    ctx.webServer.register({ kind: 'exact', path: MCP_PATH, handler: createMcpHandler(hub) }),
  )
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: createStatusHandler(hub, startedAt),
    }),
  )
  ctx.effect(() =>
    ctx.webServer.registerUpgrade({
      path: WS_PATH,
      handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
        if (!originAllowed(origin)) {
          ctx.logger?.warn('rejected a websocket upgrade from a disallowed origin')
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, ws => serveExtension(ws, hub, ctx.logger))
      },
    }),
  )
  // Sever live sockets when the plugin unloads, so a reload re-attaches cleanly.
  ctx.effect(() => () => {
    for (const client of wss.clients) client.terminate()
    wss.close()
    disposeSerializeWorker()
  })

  // The whole agent-facing tool surface: the in-box MCP bridge, pointed at our
  // own endpoint on the web server's actual listening port.
  ctx.plugin(McpClient, bridgeConfig(ctx.webServer.port))
}
