/**
 * The MCP layer: JSON-RPC 2.0 over Streamable HTTP — a port of the Rust
 * daemon's `mcp.rs`.
 *
 * Only the subset the harness client actually exercises is implemented:
 * `initialize`, `notifications/initialized`, `ping`, `tools/list`, and
 * `tools/call`. A tool failure is reported as a *successful* JSON-RPC result
 * carrying `isError: true`, per the MCP spec — a JSON-RPC error is reserved
 * for protocol-level faults such as an unknown method.
 *
 * @module dsh-chrome/mcp
 */

import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'

import { DispatchError, type Hub } from './hub.ts'
import type { Json } from './protocol.ts'
import { isKnown, listPayload } from './tools-catalog.ts'

/** Protocol version this server implements. */
export const PROTOCOL_VERSION = '2025-06-18'

/**
 * Server name reported in `initialize` and `/chrome/status`; also how any
 * probe recognizes that the endpoint is ours rather than another vendor's.
 */
export const SERVER_NAME = 'dsh-chrome'

/** Standard JSON-RPC error codes used here. */
const CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
} as const

function result(id: Json, value: Json): Json {
  return { jsonrpc: '2.0', id, result: value }
}

function rpcError(id: Json, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** A JSON-RPC parse failure rendered as the spec's -32700 response. */
export function parseFailure(message: string): Json {
  return rpcError(null, CODES.PARSE_ERROR, `parse error: ${message}`)
}

/**
 * Hard-coded guards against a single oversized extension answer stalling the
 * `dsh web` event loop. The classic offender is a `snapshot` mode:"full"
 * outline or a `get_text` raw dump: deeply-nested or multi-MB objects that
 * keep V8's `JsonStringifier::Serialize_<true>` recursing on the main thread
 * for seconds, during which Chrome reconnects pile up into a SYN storm.
 *
 * Three layers, cheap to expensive:
 *   1. `capArray` slices a top-level array past {@link MAX_ARRAY_ELEMENTS} so
 *      the serialized output is still legal JSON, just shorter.
 *   2. Past the {@link WORKER_OFFLOAD} heuristics, `JSON.stringify` runs on a
 *      persistent worker thread so the main loop keeps draining I/O.
 *   3. The final text is clipped to {@link MAX_TEXT_BYTES} with a tail marker.
 */
const MAX_TEXT_BYTES = 256 * 1024
const MAX_ARRAY_ELEMENTS = 4000
const TRUNCATED_TAIL = '\n…[truncated by dsh-chrome-control]'

/** Slice a top-level array past the cap, leaving objects and primitives alone. */
function capArray(value: Json): Json {
  if (Array.isArray(value) && value.length > MAX_ARRAY_ELEMENTS) {
    return [
      ...value.slice(0, MAX_ARRAY_ELEMENTS),
      `…[truncated: ${value.length - MAX_ARRAY_ELEMENTS} more elements omitted by dsh-chrome-control]`,
    ] as Json
  }
  return value
}

/**
 * Heuristic: large enough that a synchronous stringify on the main loop is a
 * risk. Strings are excluded — they are raw text (never quoted by `toolContent`)
 * and a long string is a cheap linear copy, not a recursive stringify.
 */
function shouldOffload(value: Json): boolean {
  if (Array.isArray(value)) return value.length > 256
  if (value && typeof value === 'object') {
    let count = 0
    for (const _ in value) if (++count > 64) return true
    return false
  }
  return false
}

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', msg => {
  try {
    parentPort.postMessage({ id: msg.id, text: JSON.stringify(msg.value) })
  } catch (error) {
    parentPort.postMessage({ id: msg.id, error: String(error) })
  }
})
`

interface Pending {
  resolve: (text: string) => void
  reject: (error: unknown) => void
}

let worker: Worker | undefined
let workerPending: Map<number, Pending> | undefined
let nextWorkerId = 1

/** Lazily start the stringify worker; returns undefined if worker_threads is unavailable. */
function getWorker(): Worker | undefined {
  if (worker !== undefined) return worker
  try {
    const w = new Worker(WORKER_SOURCE, { eval: true })
    const pending = new Map<number, Pending>()
    workerPending = pending
    w.on('message', msg => {
      const entry = pending.get(msg.id)
      if (entry === undefined) return
      pending.delete(msg.id)
      if (msg.error !== undefined) entry.reject(new Error(msg.error))
      else entry.resolve(msg.text as string)
    })
    w.on('error', error => {
      for (const entry of pending.values()) entry.reject(error)
      pending.clear()
    })
    w.on('exit', () => {
      for (const entry of pending.values()) entry.reject(new Error('serialize worker exited'))
      pending.clear()
      if (worker === w) {
        worker = undefined
        workerPending = undefined
      }
    })
    worker = w
    return w
  } catch {
    // worker_threads unavailable: callers fall back to inline stringify.
    return undefined
  }
}

function workerStringify(value: Json): Promise<string> {
  const w = getWorker()
  if (w === undefined || workerPending === undefined) {
    return Promise.resolve(JSON.stringify(value) ?? 'null')
  }
  const id = nextWorkerId++
  const pending = workerPending
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, value })
  })
}

/** Release the stringify worker; safe to call from plugin unload. */
export function disposeSerializeWorker(): void {
  if (worker !== undefined) {
    void worker.terminate().catch(() => {})
    worker = undefined
    workerPending = undefined
  }
}

/**
 * A tool outcome rendered as MCP content. Async because a large result is
 * stringified off the main thread; callers should `await` it.
 */
export async function toolContent(value: Json): Promise<Json> {
  // An image answer from the extension is handed to the model as a real
  // image block; the base64 stays a string and only rides the envelope's
  // linear escaping, so it does not need the worker path below.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const data = value['__image_base64']
    const mime = value['__image_mime_type']
    if (typeof data === 'string' && typeof mime === 'string') {
      return { content: [{ type: 'image', data, mimeType: mime }], isError: false }
    }
  }
  const capped = capArray(value)
  const text = shouldOffload(capped)
    ? await workerStringify(capped)
    : typeof capped === 'string'
      ? capped
      : (JSON.stringify(capped) ?? 'null')
  if (text.length > MAX_TEXT_BYTES) {
    return {
      content: [
        {
          type: 'text',
          text: text.slice(0, MAX_TEXT_BYTES) + TRUNCATED_TAIL,
        },
      ],
      isError: false,
    }
  }
  return { content: [{ type: 'text', text }], isError: false }
}

function toolFailure(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Handle one parsed JSON-RPC request body. Returns `undefined` for
 * notifications, which get an HTTP 202 with no body.
 * @param raw - the parsed request body.
 * @param hub - the extension hub tool calls dispatch through.
 */
export async function handle(raw: unknown, hub: Hub): Promise<Json | undefined> {
  if (!isRecord(raw)) return rpcError(null, CODES.INVALID_REQUEST, 'request must be an object')
  const id = (raw.id ?? null) as Json
  // Notifications carry no id and never get a reply.
  if (raw.id === undefined || raw.id === null) return undefined

  if (raw.jsonrpc !== '2.0') return rpcError(id, CODES.INVALID_REQUEST, 'jsonrpc must be "2.0"')
  const method = typeof raw.method === 'string' ? raw.method : ''
  const params = isRecord(raw.params) ? raw.params : {}

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: serverVersion() },
      })
    case 'ping':
      return result(id, {})
    case 'tools/list':
      return result(id, { tools: listPayload() })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (name === '') return rpcError(id, CODES.INVALID_PARAMS, 'missing tool name')
      if (!isKnown(name)) return rpcError(id, CODES.INVALID_PARAMS, `unknown tool: ${name}`)
      const args = (params.arguments ?? {}) as Json
      try {
        return result(id, await toolContent(await hub.dispatch(name, args)))
      } catch (failure) {
        // Every dispatch failure is a tool-level outcome, so the model sees an
        // actionable message instead of a transport fault it cannot interpret.
        const message =
          failure instanceof DispatchError ? failure.message : String(failure)
        return result(id, toolFailure(message))
      }
    }
    default:
      return rpcError(id, CODES.METHOD_NOT_FOUND, `unknown method: ${method}`)
  }
}

let cachedVersion: string | undefined

/** This package's version, reported as the MCP server version. */
export function serverVersion(): string {
  if (cachedVersion === undefined) {
    try {
      const require = createRequire(import.meta.url)
      const pkg = require('../package.json') as { version?: unknown }
      cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
    } catch {
      cachedVersion = '0.0.0'
    }
  }
  return cachedVersion
}
