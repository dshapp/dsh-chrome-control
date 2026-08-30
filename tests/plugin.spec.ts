/**
 * Proves this bundle's contract: the patch declares the documented rows, the
 * skills row resolves a real directory containing the skill, and the in-process
 * bridge (hub + MCP layer + catalog) behaves exactly like the Rust daemon it
 * replaced — same frames, same failure messages, same MCP surface.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { DispatchError, Hub } from '../src/hub.ts'
import { handle, toolContent, PROTOCOL_VERSION, SERVER_NAME, serverVersion } from '../src/mcp.ts'
import { parseClientFrame, type ServerFrame } from '../src/protocol.ts'
import { isKnown, listPayload, TOOLS } from '../src/tools-catalog.ts'
import { bridgeConfig, originAllowed, MCP_PATH, TOOL_TIMEOUT_MS } from '../src/server.ts'
import * as Skills from '../src/skills.ts'

interface Row {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

const root = resolve(import.meta.dirname, '..')
const patchFile = resolve(root, 'cordis.patch.yml')

function rows(): Row[] {
  const patches: PatchOptions[] = loadOverlayPatches('chrome-config-test', patchFile)
  expect(patches).toHaveLength(1)
  const insert = patches[0]?.insert
  expect(insert).toHaveLength(2)
  return insert as Row[]
}

describe('dsh-chrome bundle patch', () => {
  it('declares the server and skills rows, and nothing else', () => {
    const [serverRow, skillsRow] = rows()
    expect(serverRow?.id).toBe('chrome-server')
    expect(serverRow?.name).toBe('dsh-chrome-control/server')
    expect(skillsRow?.id).toBe('chrome-skills')
    expect(skillsRow?.name).toBe('dsh-chrome-control/skills')
  })

  it('hardcodes no port anywhere — the web server owns it', () => {
    const source = readFileSync(patchFile, 'utf8')
    expect(source).not.toMatch(/port:\s*\d/)
    expect(source).not.toContain('37086')
  })

  it('embeds no credentials', () => {
    const source = readFileSync(patchFile, 'utf8')
    expect(source).not.toMatch(/api[_-]?key|secret|token|password/i)
  })
})

describe('bridge config', () => {
  it('points the in-box MCP client at our endpoint on the actual port', () => {
    const config = bridgeConfig(3080)
    expect(config).toMatchObject({
      serverName: 'chrome',
      transport: 'streamable-http',
      url: `http://127.0.0.1:3080${MCP_PATH}`,
      failOnStartupError: false,
    })
    expect(bridgeConfig(41234).url).toBe(`http://127.0.0.1:41234${MCP_PATH}`)
  })

  it('names the serverName the harness will prefix onto every tool', () => {
    // The agent-visible names are mcp__chrome__*, which the skill documents.
    expect(bridgeConfig(1).serverName).toBe('chrome')
  })

  it('lets the hub time out before the bridge does, so its message wins', () => {
    expect(bridgeConfig(1).toolCallTimeoutMs).toBeGreaterThan(TOOL_TIMEOUT_MS)
  })
})

describe('websocket origin fence', () => {
  it('only extension origins (or none, for curl/tests) may open the socket', () => {
    expect(originAllowed(undefined)).toBe(true)
    expect(originAllowed('chrome-extension://abc')).toBe(true)
    expect(originAllowed('https://evil.example')).toBe(false)
    expect(originAllowed('http://127.0.0.1:3080')).toBe(false)
  })
})

describe('wire protocol', () => {
  it('parses hello, pong, and both tool_result shapes', () => {
    expect(parseClientFrame('{"type":"hello","payload":{"extensionVersion":"0.1.0"}}')).toEqual({
      type: 'hello',
      extensionVersion: '0.1.0',
    })
    expect(parseClientFrame('{"type":"pong"}')).toEqual({ type: 'pong' })
    expect(
      parseClientFrame('{"type":"tool_result","responseToRequestId":"r1","payload":{"data":{"ok":true}}}'),
    ).toEqual({ type: 'tool_result', responseToRequestId: 'r1', data: { ok: true } })
    expect(
      parseClientFrame('{"type":"tool_result","responseToRequestId":"r2","payload":{"error":"boom"}}'),
    ).toEqual({ type: 'tool_result', responseToRequestId: 'r2', error: 'boom' })
  })

  it('rejects frames that are not ours', () => {
    expect(parseClientFrame('not json')).toBeUndefined()
    expect(parseClientFrame('{"type":"cdp"}')).toBeUndefined()
    expect(parseClientFrame('{"type":"tool_result"}')).toBeUndefined()
  })
})

/** A hub plus a captured outbound frame queue. */
function attachedHub(timeoutMs = 200): { hub: Hub; frames: ServerFrame[]; outbound: (frame: ServerFrame) => boolean } {
  const hub = new Hub(timeoutMs)
  const frames: ServerFrame[] = []
  const outbound = (frame: ServerFrame): boolean => {
    frames.push(frame)
    return true
  }
  hub.attach(outbound)
  return { hub, frames, outbound }
}

function lastToolCall(frames: ServerFrame[]): Extract<ServerFrame, { type: 'tool_call' }> {
  const frame = frames.at(-1)
  if (frame?.type !== 'tool_call') throw new Error('expected a tool_call frame')
  return frame
}

describe('extension hub', () => {
  it('reports not-connected with the actionable message when no extension is attached', async () => {
    const hub = new Hub(200)
    expect(hub.extensionState().connected).toBe(false)
    await expect(hub.dispatch('snapshot', null)).rejects.toThrow(/chrome:\/\/extensions/)
  })

  it('resolves a dispatched call with the extension answer', async () => {
    const { hub, frames } = attachedHub()
    const call = hub.dispatch('evaluate', { code: '1' })
    const frame = lastToolCall(frames)
    expect(frame.payload.name).toBe('evaluate')
    hub.resolve(frame.requestId, { value: 1 })
    await expect(call).resolves.toEqual({ value: 1 })
  })

  it('surfaces a tool error from the extension verbatim', async () => {
    const { hub, frames } = attachedHub()
    const call = hub.dispatch('click', null)
    hub.resolve(lastToolCall(frames).requestId, new DispatchError('tool', 'no such element'))
    await expect(call).rejects.toThrow('no such element')
  })

  it('times out an unanswered call and stops waiting', async () => {
    vi.useFakeTimers()
    try {
      const { hub } = attachedHub(50)
      const call = hub.dispatch('snapshot', null)
      const settled = expect(call).rejects.toThrow(/did not answer in time/)
      await vi.advanceTimersByTimeAsync(60)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails calls that were in flight when the socket detaches', async () => {
    const { hub, outbound } = attachedHub()
    const call = hub.dispatch('snapshot', null)
    hub.detach(outbound)
    await expect(call).rejects.toThrow(/disconnected/)
    expect(hub.extensionState().connected).toBe(false)
  })

  it('lets a newer connection replace the previous one', () => {
    const hub = new Hub(200)
    const first = () => true
    hub.attach(first)
    hub.attach(() => true)
    // Detaching the stale socket must not clear the live one's state.
    hub.detach(first)
    expect(hub.extensionState().connected).toBe(true)
  })

  it('records the extension version from hello', () => {
    const { hub } = attachedHub()
    hub.recordHello('0.2.5')
    expect(hub.extensionState()).toEqual({ connected: true, version: '0.2.5' })
  })
})

describe('mcp layer', () => {
  const hub = () => new Hub(100)

  it('initialize reports the protocol and server identity', async () => {
    const response = (await handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      hub(),
    )) as Record<string, any>
    expect(response.result.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(response.result.serverInfo.name).toBe(SERVER_NAME)
    expect(response.result.serverInfo.version).toBe(serverVersion())
    expect(response.result.capabilities.tools).toBeTypeOf('object')
  })

  it('tools/list advertises the whole catalog', async () => {
    const response = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, hub())) as any
    expect(response.result.tools).toHaveLength(TOOLS.length)
  })

  it('a notification gets no response', async () => {
    await expect(
      handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, hub()),
    ).resolves.toBeUndefined()
  })

  it('an unknown method is a jsonrpc error', async () => {
    const response = (await handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, hub())) as any
    expect(response.error.code).toBe(-32601)
  })

  it('an unknown tool is rejected before dispatch', async () => {
    const response = (await handle(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cdp', arguments: {} } },
      hub(),
    )) as any
    expect(response.error.code).toBe(-32602)
    expect(response.error.message).toContain('cdp')
  })

  it('a call without an extension is an isError result, not a fault', async () => {
    const response = (await handle(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'snapshot', arguments: { session: 's' } } },
      hub(),
    )) as any
    // A JSON-RPC *result*, so the model can read and act on the message.
    expect(response.error).toBeUndefined()
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('chrome://extensions')
  })

  it('renders ordinary tool results as compact JSON', async () => {
    const rendered = (await toolContent({ url: 'https://example.com', tabId: 7 })) as any
    expect(rendered.content[0].type).toBe('text')
    const text: string = rendered.content[0].text
    expect(text.startsWith('{')).toBe(true)
    expect(text).toContain('https://example.com')
    // Compact, so a large snapshot is not inflated by indentation.
    expect(text).not.toContain('\n')
  })

  it('caps a top-level array past the element limit and keeps legal JSON', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `item-${i}`)
    const rendered = (await toolContent(big as any)) as any
    const text: string = rendered.content[0].text
    const parsed = JSON.parse(text) as unknown[]
    expect(parsed.length).toBe(4001)
    expect(parsed[0]).toBe('item-0')
    expect(parsed[3999]).toBe('item-3999')
    expect(typeof parsed[4000]).toBe('string')
    expect(parsed[4000]).toContain('truncated')
  })

  it('truncates oversized text output and marks the tail', async () => {
    const huge = 'x'.repeat(300 * 1024)
    const rendered = (await toolContent(huge as any)) as any
    const text: string = rendered.content[0].text
    expect(text.length).toBe(256 * 1024 + '\n…[truncated by dsh-chrome-control]'.length)
    expect(text.endsWith('…[truncated by dsh-chrome-control]')).toBe(true)
  })

  it('renders an image answer as an image block without stringify', async () => {
    const rendered = (await toolContent({
      __image_base64: 'Zm9v',
      __image_mime_type: 'image/png',
    } as any)) as any
    expect(rendered.content[0].type).toBe('image')
    expect(rendered.content[0].data).toBe('Zm9v')
    expect(rendered.content[0].mimeType).toBe('image/png')
  })

  it('serializes a moderately large object through the worker path', async () => {
    // Large enough to trigger the offload heuristic; correctness is the only
    // assertion — we do not couple to whether a worker is actually spun up.
    const value = Array.from({ length: 512 }, (_, i) => ({ i, label: `row-${i}` }))
    const rendered = (await toolContent(value as any)) as any
    const parsed = JSON.parse(rendered.content[0].text) as Array<{ i: number }>
    expect(parsed.length).toBe(512)
    expect(parsed[511]!.i).toBe(511)
  })
})

describe('tool catalog', () => {
  it('every tool requires a session and declares a closed object schema', () => {
    for (const tool of TOOLS) {
      const schema = tool.inputSchema as any
      expect(schema.type, tool.name).toBe('object')
      expect(schema.properties.session, tool.name).toBeTypeOf('object')
      expect(schema.required, tool.name).toContain('session')
      expect(schema.additionalProperties, tool.name).toBe(false)
    }
  })

  it('catalog names are unique and recognized', () => {
    const names = TOOLS.map(tool => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const known of ['navigate', 'send_keys', 'get_text', 'network_detail', 'wait_for_selector']) {
      expect(isKnown(known), known).toBe(true)
    }
    expect(isKnown('upload')).toBe(true)
    expect(isKnown('cdp')).toBe(false)
  })

  it('advertises every tool the extension implements', () => {
    // Guards against adding a spec without updating the extension, or vice versa.
    expect(TOOLS).toHaveLength(27)
  })

  it('enum-constrained arguments list their allowed values', () => {
    const byName = (name: string) =>
      (TOOLS.find(tool => tool.name === name)?.inputSchema as any).properties
    expect(byName('dialog').action.enum).toEqual(['accept', 'dismiss'])
    expect(byName('wait_for_selector').state.enum).toEqual(['visible', 'hidden'])
    expect(byName('scroll').direction.enum).toEqual(['up', 'down', 'left', 'right'])
  })

  it('advertises the generic interaction upgrades', () => {
    const byName = (name: string) =>
      TOOLS.find(tool => tool.name === name)?.inputSchema as any
    expect(byName('click').properties.trusted).toBeTypeOf('object')
    expect(byName('mouse_click').properties.selector).toBeTypeOf('object')
    expect(byName('mouse_click').required).not.toContain('x')
    expect(byName('snapshot').properties.selector).toBeTypeOf('object')
    expect(byName('upload').properties.paths.items.type).toBe('string')
    expect(byName('upload').required).toEqual(expect.arrayContaining(['selector', 'paths', 'session']))
    expect(TOOLS.find(tool => tool.name === 'select')?.description).toContain('ARIA combobox')
  })

  it('list payload matches the catalog', () => {
    const entries = listPayload() as any[]
    expect(entries).toHaveLength(TOOLS.length)
    for (const entry of entries) {
      expect(entry.name).toBeTypeOf('string')
      expect(entry.description).toBeTypeOf('string')
      expect(entry.inputSchema).toBeTypeOf('object')
    }
  })
})

describe('bundled skill', () => {
  it('resolves a directory that really contains the skill', () => {
    const dir = Skills.resolveBundledSkillsDir()
    const skill = readFileSync(resolve(dir, 'chrome', 'SKILL.md'), 'utf8')
    expect(skill).toMatch(/^---/)
    expect(skill).toContain('name: chrome')
    // The skill must teach the real tool prefix.
    expect(skill).toContain('mcp__chrome__')
  })

  it('registers under its own provider name', () => {
    expect(Skills.SKILL_PROVIDER_NAME).toBe('chrome')
    expect(Skills.name).toBe('chrome-skills')
  })

  it('documents the tools that need judgement, not just their names', () => {
    const dir = Skills.resolveBundledSkillsDir()
    const skill = readFileSync(resolve(dir, 'chrome', 'SKILL.md'), 'utf8')
    // Each of these carries a trap or a choice the tool's own schema cannot
    // express, so the skill going quiet about one is a documentation bug.
    for (const section of ['Waiting', 'Scrolling', 'Reading page text', 'Network and dialogs']) {
      expect(skill).toContain(`## ${section}`)
    }
    for (const tool of ['wait_for_selector', 'get_text', 'network_detail', 'dialog', 'select', 'find', 'hover']) {
      expect(skill).toContain(tool)
    }
    // The two failure modes that most often strand a run.
    expect(skill).toContain('blocks every other tool on that tab')
    expect(skill).toMatch(/only recorded from the moment|Network history starts at attach/)
  })
})
