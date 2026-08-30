/**
 * Unit tests for the slimmed-down Node plugin: its exported surface (bridge
 * config, daemon port, binary resolution) and the re-exported frame parser.
 * The hub/MCP/catalog logic now lives in Rust and is covered by `cargo test`.
 */

import { describe, expect, it } from 'vitest'
import { bridgeConfig, DAEMON_PORT, parseClientFrame } from '../src/server.ts'

describe('chrome-server plugin', () => {
  describe('bridgeConfig', () => {
    it('points the MCP client at the daemon on port 37086', () => {
      const cfg = bridgeConfig()
      expect(cfg.serverName).toBe('chrome')
      expect(cfg.transport).toBe('streamable-http')
      expect(cfg.url).toBe(`http://127.0.0.1:${DAEMON_PORT}/chrome/mcp`)
      expect(cfg.failOnStartupError).toBe(false)
    })

    it('allows the hub timeout to win over the bridge timeout', () => {
      const cfg = bridgeConfig()
      expect(cfg.toolCallTimeoutMs).toBeGreaterThan(30_000)
    })
  })

  describe('DAEMON_PORT', () => {
    it('is the fixed 37086', () => {
      expect(DAEMON_PORT).toBe(37086)
    })
  })

  describe('parseClientFrame (re-exported from protocol.ts)', () => {
    it('parses hello with version', () => {
      const f = parseClientFrame('{"type":"hello","payload":{"extensionVersion":"0.3.1"}}')
      expect(f).toEqual({ type: 'hello', extensionVersion: '0.3.1' })
    })

    it('parses pong', () => {
      expect(parseClientFrame('{"type":"pong"}')).toEqual({ type: 'pong' })
    })

    it('parses a tool_result with data', () => {
      const f = parseClientFrame('{"type":"tool_result","responseToRequestId":"r1","payload":{"data":{"ok":true}}}')
      expect(f).toEqual({ type: 'tool_result', responseToRequestId: 'r1', data: { ok: true } })
    })

    it('parses a tool_result with error', () => {
      const f = parseClientFrame('{"type":"tool_result","responseToRequestId":"r2","payload":{"error":"boom"}}')
      expect(f).toEqual({ type: 'tool_result', responseToRequestId: 'r2', error: 'boom' })
    })

    it('returns undefined for invalid JSON', () => {
      expect(parseClientFrame('not json')).toBeUndefined()
    })

    it('returns undefined for an unknown frame type', () => {
      expect(parseClientFrame('{"type":"nope"}')).toBeUndefined()
    })

    it('returns undefined for a tool_result without a request id', () => {
      expect(parseClientFrame('{"type":"tool_result","payload":{"data":1}}')).toBeUndefined()
    })
  })
})
