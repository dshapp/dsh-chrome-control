/**
 * Unit tests for the slimmed-down Node plugin: its exported surface (bridge
 * config, daemon port, binary resolution) and the re-exported frame parser.
 * The hub/MCP/catalog logic now lives in Rust and is covered by `cargo test`.
 */

import { describe, expect, it } from 'vitest'
import { bridgeConfig, DAEMON_PORT, localBuildHash, parseClientFrame, restartDecision } from '../src/server.ts'

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
  // The upgrade path: a detached daemon outlives dsh web, so after an upgrade
  // the previous build is still listening. Version strings cannot detect that
  // (releases bump package.json but never daemon/Cargo.toml), so the decision
  // is made on the executable's content hash.
  describe('restartDecision', () => {
    const A = 'a'.repeat(64)
    const B = 'b'.repeat(64)

    it('reuses a daemon running the shipped build', () => {
      expect(restartDecision(A, A)).toEqual({ restart: false, reason: 'match' })
    })

    it('restarts when the running build differs from the shipped one', () => {
      expect(restartDecision(A, B)).toEqual({ restart: true, reason: 'changed' })
    })

    it('reuses when the running daemon reports no build id', () => {
      // A daemon older than this plugin: it has no /chrome/shutdown either, so
      // restarting it is not possible and must not be attempted.
      expect(restartDecision(undefined, A)).toEqual({ restart: false, reason: 'unknown-running' })
    })

    it('reuses when the local binary cannot be hashed', () => {
      expect(restartDecision(A, undefined)).toEqual({ restart: false, reason: 'unknown-local' })
    })

    it('never restarts on a double unknown', () => {
      expect(restartDecision(undefined, undefined).restart) .toBe(false)
    })
  })

  describe('localBuildHash', () => {
    it('returns undefined for a missing file rather than throwing', () => {
      expect(localBuildHash('/nonexistent/chrome-daemon')).toBeUndefined()
    })

    it('is a lowercase 64-char sha256 of the file', async () => {
      const { createHash } = await import('node:crypto')
      const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const pathMod = await import('node:path')
      const file = pathMod.join(mkdtempSync(pathMod.join(tmpdir(), 'dsh-hash-')), 'bin')
      writeFileSync(file, 'daemon bytes')
      const expected = createHash('sha256').update(readFileSync(file)).digest('hex')
      expect(localBuildHash(file)).toBe(expected)
      expect(localBuildHash(file)).toMatch(/^[0-9a-f]{64}$/)
    })
  })
})
