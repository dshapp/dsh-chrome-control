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

/** A tool outcome rendered as MCP content. */
export function toolContent(value: Json): Json {
  // An image answer from the extension is handed to the model as a real
  // image block; everything else travels as compact JSON text.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const data = value['__image_base64']
    const mime = value['__image_mime_type']
    if (typeof data === 'string' && typeof mime === 'string') {
      return { content: [{ type: 'image', data, mimeType: mime }], isError: false }
    }
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null'
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
        return result(id, toolContent(await hub.dispatch(name, args)))
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

import { createRequire } from 'node:module'

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
