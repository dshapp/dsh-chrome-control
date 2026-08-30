/**
 * End-to-end proof over a real HTTP server: the plugin mounts its routes on a
 * live `webServer`, the in-box mcp-client bridge discovers the catalog through
 * `/chrome/mcp` and registers `mcp__chrome__*` on the tool runtime, and a
 * WebSocket "extension" completes a whole tool call round trip.
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Server from '../src/server.ts'
import { TOOLS } from '../src/tools-catalog.ts'

const ctx = new Context()
let base = ''

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function rpc(body: unknown): Promise<any> {
  const response = await fetch(`${base}/chrome/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return response.json()
}

beforeAll(async () => {
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  // ToolRuntime wires tool schemas into the system prompt; a recording stub
  // satisfies that inject without dragging the whole prompt stack in.
  ctx.provide('systemPrompt')
  ;(ctx as any).systemPrompt = { tools: () => () => {}, section: () => () => {} }
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Server)
  base = `http://127.0.0.1:${ctx.webServer.port}`
})

afterAll(async () => {
  await (ctx as any).dispose?.()
})

describe('bridge on the shared web server', () => {
  it('answers /chrome/status with our identity', async () => {
    const status = (await (await fetch(`${base}/chrome/status`)).json()) as any
    expect(status.name).toBe('dsh-chrome')
    expect(status.running).toBe(true)
    expect(status.extension_connected).toBe(false)
  })

  it('serves MCP initialize and tools/list on /chrome/mcp', async () => {
    const initialized = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(initialized.result.serverInfo.name).toBe('dsh-chrome')
    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(listed.result.tools).toHaveLength(TOOLS.length)
  })

  it('declines the SSE stream GET, as the daemon did', async () => {
    const response = await fetch(`${base}/chrome/mcp`)
    expect(response.status).toBe(405)
  })

  it('registers the whole catalog as mcp__chrome__* through the in-box bridge', async () => {
    const tools = await until(
      () => ctx.get('tools') as InstanceType<typeof ToolRuntime> | undefined,
      'tool runtime service',
    )
    await until(() => tools!.get('mcp__chrome__navigate'), 'bridge tool registration')
    expect(tools!.get('mcp__chrome__screenshot')).toBeDefined()
    expect(tools!.get('mcp__chrome__get_text')).toBeDefined()
  })

  it('refuses a web page origin on the extension socket', async () => {
    const refused = new WebSocket(`ws://127.0.0.1:${ctx.webServer.port}/chrome/ws`, {
      headers: { origin: 'https://evil.example' },
    })
    const outcome = await new Promise<string>(resolve => {
      refused.once('open', () => resolve('open'))
      refused.once('error', () => resolve('refused'))
    })
    expect(outcome).toBe('refused')
  })

  it('completes a whole tool call round trip through a fake extension', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${ctx.webServer.port}/chrome/ws`, {
      headers: { origin: 'chrome-extension://test' },
    })
    const frames: any[] = []
    socket.on('message', data => frames.push(JSON.parse(String(data))))
    await new Promise(resolve => socket.once('open', resolve))
    socket.send(JSON.stringify({ type: 'hello', payload: { extensionVersion: '9.9.9' } }))

    // hello is acknowledged and the status flips to connected.
    await until(() => frames.find(frame => frame.type === 'hello_ack'), 'hello_ack')
    const status = (await (await fetch(`${base}/chrome/status`)).json()) as any
    expect(status.extension_connected).toBe(true)
    expect(status.extension_version).toBe('9.9.9')

    // The extension answers the dispatched call; MCP returns its data.
    const answered = rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_tabs', arguments: { session: 's' } },
    })
    const call = await until(() => frames.find(frame => frame.type === 'tool_call'), 'tool_call frame')
    expect(call.payload.name).toBe('list_tabs')
    socket.send(
      JSON.stringify({
        type: 'tool_result',
        responseToRequestId: call.requestId,
        payload: { data: { tabs: [] } },
      }),
    )
    const response = await answered
    expect(response.result.isError).toBe(false)
    expect(JSON.parse(response.result.content[0].text)).toEqual({ tabs: [] })

    socket.close()
  })
})
