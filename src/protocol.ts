/**
 * Wire protocol shared by the WebSocket hub and the MCP layer — a line-for-line
 * port of the Rust daemon's `protocol.rs`, so the browser extension speaks the
 * exact same frames it always has: the server sends `tool_call` envelopes
 * carrying a `requestId`, and the extension answers with a `tool_result`
 * naming that id in `responseToRequestId`.
 *
 * @module dsh-chrome/protocol
 */

/** Lossless JSON value, the only currency crossing the socket. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** A frame the server sends to the extension. */
export type ServerFrame =
  /** Liveness probe; the extension answers with `{ type: 'pong' }`. */
  | { type: 'ping' }
  /** Acknowledges the extension's `hello`. */
  | { type: 'hello_ack' }
  /** Asks the extension to run one tool. */
  | { type: 'tool_call'; requestId: string; payload: { name: string; args: Json } }

/** A parsed frame the extension sends to the server. */
export type ClientFrame =
  /** First frame after the socket opens; carries the extension's version. */
  | { type: 'hello'; extensionVersion: string }
  /** Answer to a ping. */
  | { type: 'pong' }
  /**
   * Result of a previously dispatched tool call. Exactly one of `data` /
   * `error` is meaningful, matching the extension's convention.
   */
  | { type: 'tool_result'; responseToRequestId: string; data?: Json; error?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse one raw text frame from the extension.
 * @param text - the socket message body.
 * @returns the typed frame, or `undefined` when the frame is not one of ours.
 */
export function parseClientFrame(text: string): ClientFrame | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  switch (raw.type) {
    case 'hello': {
      const payload = isRecord(raw.payload) ? raw.payload : {}
      const version = typeof payload.extensionVersion === 'string' ? payload.extensionVersion : ''
      return { type: 'hello', extensionVersion: version }
    }
    case 'pong':
      return { type: 'pong' }
    case 'tool_result': {
      if (typeof raw.responseToRequestId !== 'string') return undefined
      const payload = isRecord(raw.payload) ? raw.payload : {}
      const frame: ClientFrame = { type: 'tool_result', responseToRequestId: raw.responseToRequestId }
      if ('data' in payload && payload.data !== undefined) frame.data = payload.data as Json
      if (typeof payload.error === 'string') frame.error = payload.error
      return frame
    }
    default:
      return undefined
  }
}
