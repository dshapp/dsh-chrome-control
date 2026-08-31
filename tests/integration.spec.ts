/**
 * End-to-end proof over the spawned Rust daemon: `tools/list` returns the
 * catalog, `/chrome/status` reports wiring, and a WebSocket "extension"
 * completes a whole tool-call round trip through the daemon's own ports.
 *
 * Requires the release binary at `daemon/target/release/chrome-daemon`.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Resolve the daemon binary the same way the plugin does: the shipped
// per-platform copy under binaries/ first, then a dev cargo build. On the
// release job the binaries/ dir is populated from the matrix artifacts; on
// PR-checks and dev the cargo build is used. Skip the suite if neither is
// present (e.g. a job that only validates packaging without building).
const EXE = process.platform === 'win32' ? 'chrome-daemon.exe' : 'chrome-daemon'
const PLATFORM_ARCH = `${process.platform}-${process.arch}`
const BINARY_CANDIDATES = [
  path.resolve(import.meta.dirname, '..', 'binaries', PLATFORM_ARCH, EXE),
  path.resolve(import.meta.dirname, '..', 'daemon', 'target', 'release', EXE),
]
const BIN = BINARY_CANDIDATES.find(p => existsSync(p))
const PORT = 37187 // ephemeral test port, avoids clashing with a running daemon
const BASE = `http://127.0.0.1:${PORT}`

let child: ReturnType<typeof spawn> | undefined

async function untilReady(): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const r = await fetch(`${BASE}/chrome/status`)
      if (r.ok) return
    } catch {}
    if (Date.now() > deadline) throw new Error('chrome-daemon did not start in time')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function rpc(body: unknown): Promise<any> {
  const response = await fetch(`${BASE}/chrome/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return response.json()
}

// Skip the whole suite when no binary is available (e.g. a job that only
// validates packaging without building Rust). On the release job the binaries/
// dir is populated from the matrix artifacts; on PR-checks a cargo build runs.
const HAS_BINARY = BIN !== undefined

beforeAll(async () => {
  if (!HAS_BINARY) return
  // artifact upload/download drops the executable bit on non-Windows
  if (process.platform !== 'win32') chmodSync(BIN!, 0o755)
  child = spawn(BIN!, ['--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' })
  await untilReady()
}, 30_000)

afterAll(() => {
  if (child !== undefined && !child.killed) child.kill('SIGTERM')
})

const describe_e2e = HAS_BINARY ? describe : describe.skip
describe_e2e('chrome-daemon (end-to-end)', () => {
  it('GET /chrome/status reports the wiring', async () => {
    const r = await fetch(`${BASE}/chrome/status`)
    expect(r.status).toBe(200)
    const v = await r.json() as any
    expect(v.name).toBe('dsh-chrome')
    expect(v.running).toBe(true)
    expect(v.extension_connected).toBe(false)
  })

  // The contract dsh web's upgrade check depends on: the daemon reports the
  // SHA-256 of its own executable, so the Node side can reproduce it from the
  // binary on disk and detect a daemon left over from an older build.
  it('GET /chrome/status reports the executable content hash as `build`', async () => {
    const r = await fetch(`${BASE}/chrome/status`)
    const v = await r.json() as any
    expect(v.build).toMatch(/^[0-9a-f]{64}$/)
    const expected = createHash('sha256').update(readFileSync(BIN!)).digest('hex')
    expect(v.build).toBe(expected)
  })

  it('initialize', async () => {
    const v = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(v.result.serverInfo.name).toBe('dsh-chrome')
    expect(v.result.protocolVersion).toBe('2025-06-18')
  })

  it('tools/list advertises 27 tools', async () => {
    const v = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(v.result.tools.length).toBe(27)
    expect(v.result.tools[0].name).toBe('navigate')
  })

  it('tools/call without an extension is an isError result', async () => {
    const v = await rpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'snapshot', arguments: { session: 's' } },
    })
    expect(v.error).toBeUndefined()
    expect(v.result.isError).toBe(true)
    expect(v.result.content[0].text).toContain('chrome://extensions')
  })

  it('unknown tool is an invalid-params error', async () => {
    const v = await rpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'cdp', arguments: {} },
    })
    expect(v.error.code).toBe(-32602)
  })

  it('completes a whole tool-call round trip through a WebSocket extension', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/chrome/ws`)
    const opened = new Promise<void>(resolve => ws.on('open', resolve))
    await opened

    // The daemon sends nothing until a tool is dispatched; send hello to record version.
    ws.send(JSON.stringify({ type: 'hello', payload: { extensionVersion: '0.3.1-test' } }))

    // Kick off a tool call; the daemon will deliver a tool_call frame to us.
    const call = rpc({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'list_tabs', arguments: { session: 's' } },
    })

    // Receive the tool_call frame, skipping hello_ack/ping frames the daemon
    // may send first.
    const frame: any = await new Promise(resolve => {
      ws.on('message', d => {
        const f = JSON.parse(d.toString())
        if (f.type === 'tool_call') resolve(f)
      })
    })
    expect(frame.type).toBe('tool_call')
    expect(frame.payload.name).toBe('list_tabs')
    expect(frame.requestId).toMatch(/^r\d+$/)
    ws.send(JSON.stringify({
      type: 'tool_result',
      responseToRequestId: frame.requestId,
      payload: { data: { tabs: [{ id: 1, url: 'https://example.com' }] } },
    }))

    // The MCP call resolves with the extension's answer.
    const v = await call
    expect(v.result.isError).toBe(false)
    expect(v.result.content[0].type).toBe('text')
    const parsed = JSON.parse(v.result.content[0].text)
    expect(parsed.tabs[0].url).toBe('https://example.com')

    ws.close()
  })

  it('reports the extension connected after a hello', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/chrome/ws`)
    await new Promise<void>(resolve => ws.on('open', resolve))
    ws.send(JSON.stringify({ type: 'hello', payload: { extensionVersion: '9.9.9' } }))
    // give the daemon a beat to record hello
    await new Promise(resolve => setTimeout(resolve, 100))
    const r = await fetch(`${BASE}/chrome/status`)
    const v = await r.json() as any
    expect(v.extension_connected).toBe(true)
    expect(v.extension_version).toBe('9.9.9')
    ws.close()
  })
})

// POST /chrome/shutdown is how an upgraded dsh web retires a daemon it does
// not own. These run against their own throwaway daemon on a separate port,
// because a successful shutdown ends the process under test.
describe_e2e('chrome-daemon shutdown endpoint', () => {
  const SPORT = 37188
  const SBASE = `http://127.0.0.1:${SPORT}`
  let victim: ReturnType<typeof spawn> | undefined

  async function untilUp(): Promise<void> {
    const deadline = Date.now() + 10_000
    for (;;) {
      try { if ((await fetch(`${SBASE}/chrome/status`)).ok) return } catch {}
      if (Date.now() > deadline) throw new Error('victim daemon did not start')
      await new Promise(r => setTimeout(r, 100))
    }
  }

  async function isDown(): Promise<boolean> {
    try { await fetch(`${SBASE}/chrome/status`); return false } catch { return true }
  }

  beforeAll(async () => {
    victim = spawn(BIN!, ['--port', String(SPORT), '--host', '127.0.0.1'], { stdio: 'ignore' })
    await untilUp()
  }, 30_000)

  afterAll(() => {
    if (victim !== undefined && !victim.killed) victim.kill('SIGTERM')
  })

  it('refuses a shutdown from a web page origin, and keeps running', async () => {
    const r = await fetch(`${SBASE}/chrome/shutdown`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    expect(r.status).toBe(403)
    // Still alive: a hostile page must not be able to stop the daemon.
    await new Promise(r => setTimeout(r, 200))
    expect(await isDown()).toBe(false)
  })

  it('accepts a local shutdown and exits, releasing the port', async () => {
    const r = await fetch(`${SBASE}/chrome/shutdown`, { method: 'POST' })
    expect(r.status).toBe(202)

    const deadline = Date.now() + 5_000
    for (;;) {
      if (await isDown()) break
      if (Date.now() > deadline) throw new Error('daemon did not shut down')
      await new Promise(r => setTimeout(r, 100))
    }
    expect(await isDown()).toBe(true)

    // The port is genuinely free: a fresh daemon can bind it immediately.
    const successor = spawn(BIN!, ['--port', String(SPORT), '--host', '127.0.0.1'], { stdio: 'ignore' })
    try {
      await untilUp()
      expect((await fetch(`${SBASE}/chrome/status`)).status).toBe(200)
    } finally {
      successor.kill('SIGTERM')
    }
  }, 30_000)
})
