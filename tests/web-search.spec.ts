/**
 * The chrome-browser search provider against a fake chrome-daemon MCP endpoint:
 * request URLs per engine, result mapping, tab cleanup, CAPTCHA and failure
 * codes, and registration through the real DSH web service.
 */

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHROME_SEARCH_PROVIDER_ID, ChromeSearchProvider, DaemonClient, ENGINES, type Engine, mapResult, searchUrl,
} from '../src/web-search.ts'

interface Call { name: string; args: Record<string, unknown> }

/** Fake daemon: answers each tool call through `reply`; records every call. */
let calls: Call[]
let reply: (call: Call) => { text: string; isError?: boolean }
let server: http.Server
let url: string

beforeEach(async () => {
  calls = []
  reply = () => ({ text: '{}' })
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } }
      if (message.id === undefined) { res.writeHead(202); res.end(); return }
      let result: unknown = { capabilities: {} }
      if (message.method === 'tools/call') {
        const call = { name: message.params!.name, args: message.params!.arguments }
        calls.push(call)
        const { text, isError } = reply(call)
        result = { content: [{ type: 'text', text }], ...isError === true ? { isError } : {} }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chrome/mcp`
})

afterEach(async () => {
  await new Promise(resolve => server.close(resolve))
})

function provider(engine: { current: Engine } = { current: 'google' }): ChromeSearchProvider {
  return new ChromeSearchProvider({
    engine: { get: () => engine.current },
    resultWaitMs: 1000,
    client: new DaemonClient(url),
    warn: () => {},
  })
}

/** Answer `evaluate` with these page results. */
function page(results: { title: string; url: string; snippet: string }[], captcha = false): void {
  reply = call => ({ text: call.name === 'evaluate' ? JSON.stringify({ type: 'object', value: { captcha, results } }) : '{"success":true}' })
}

describe('searchUrl', () => {
  it('builds each engine result page URL', () => {
    expect(ENGINES.map(engine => searchUrl(engine, 'a b'))).toEqual([
      'https://www.google.com/search?q=a+b',
      'https://www.bing.com/search?q=a+b',
      'https://www.baidu.com/s?wd=a+b',
      'https://www.sogou.com/web?query=a+b',
      'https://so.toutiao.com/search?keyword=a+b',
    ])
  })
})

describe('mapResult', () => {
  it('splits a leading date into publishedAt', () => {
    expect(mapResult({ title: 'T', url: 'https://a.example/', snippet: 'Aug 14, 2026 — Body.Read more' }))
      .toEqual({ title: 'T', url: 'https://a.example/', snippet: 'Body.', publishedAt: '2026-08-14' })
    expect(mapResult({ title: 'T', url: 'https://a.example/', snippet: 'Aug 19, 2026\u00a0· Bing body' }).publishedAt).toBe('2026-08-19')
    expect(mapResult({ title: 'T', url: 'https://a.example/', snippet: '2026年8月3日 — 正文' }).publishedAt).toBe('2026-08-03')
    expect(mapResult({ title: 'T', url: 'https://a.example/', snippet: '3 days ago — x' }).publishedAt).toBe('3 days ago')
    expect(mapResult({ title: 'T', url: 'https://a.example/', snippet: '5天前正文' })).toMatchObject({ snippet: '正文', publishedAt: '5天前' })
  })

  it('collapses line breaks inside titles and snippets', () => {
    expect(mapResult({ title: '黄山 日出\n - 精选笔记', url: 'https://a.example/', snippet: '第一行\n\n第二行' }))
      .toEqual({ title: '黄山 日出 - 精选笔记', url: 'https://a.example/', snippet: '第一行 第二行' })
  })

  it('omits empty optional fields', () => {
    expect(mapResult({ title: '', url: 'https://a.example/', snippet: '' })).toEqual({ url: 'https://a.example/' })
  })
})

describe('ChromeSearchProvider', () => {
  it('opens the selected engine in a fresh session, reads results, and closes the session', async () => {
    page([{ title: 'One', url: 'https://one.example/', snippet: 'first' }])
    const engine = { current: 'bing' as Engine }
    const result = await provider(engine).search({ query: 'dsh' })
    expect(result).toEqual({ sources: [{ title: 'One', url: 'https://one.example/', snippet: 'first' }], truncated: false })
    expect(calls.map(call => call.name)).toEqual(['navigate', 'evaluate', 'close_session'])
    expect(calls[0]!.args).toMatchObject({ url: 'https://www.bing.com/search?q=dsh', newTab: true })
    const session = calls[0]!.args.session
    expect(calls.every(call => call.args.session === session)).toBe(true)
  })

  it('reads the engine again at every search', async () => {
    page([])
    const engine = { current: 'google' as Engine }
    const search = provider(engine)
    await search.search({ query: 'x' })
    engine.current = 'toutiao'
    await search.search({ query: 'x' })
    const navigations = calls.filter(call => call.name === 'navigate').map(call => call.args.url)
    expect(navigations).toEqual(['https://www.google.com/search?q=x', 'https://so.toutiao.com/search?keyword=x'])
  })

  it('retries the extractor while the result page replaces itself', async () => {
    let evaluations = 0
    reply = call => {
      if (call.name !== 'evaluate') return { text: '{}' }
      evaluations++
      return evaluations === 1
        ? { text: 'Debugger is not attached to the tab with id: 1.', isError: true }
        : { text: JSON.stringify({ value: { captcha: false, results: [] } }) }
    }
    await expect(provider().search({ query: 'x' })).resolves.toEqual({ sources: [], truncated: false })
    expect(evaluations).toBe(2)
  })

  it('reports a CAPTCHA and leaves its tab open', async () => {
    page([], true)
    await expect(provider().search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_SEARCH_CAPTCHA' })
    expect(calls.map(call => call.name)).toEqual(['navigate', 'evaluate'])
  })

  it('reports a failed tool call as a provider error and still closes the session', async () => {
    reply = call => call.name === 'navigate' ? { text: 'no Chrome extension is attached', isError: true } : { text: '{}' }
    await expect(provider().search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: expect.stringContaining('no Chrome extension') })
    expect(calls.map(call => call.name)).toEqual(['navigate', 'close_session'])
  })

  it('reports cancellation as WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(provider().search({ query: 'x' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('reports an unreachable daemon as a provider error', async () => {
    await new Promise(resolve => server.close(resolve))
    server = http.createServer()
    await expect(provider().search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })
})

describe('registration on the web service', () => {
  it('serves web search while selected and unregisters with its fiber', async () => {
    page([{ title: 'One', url: 'https://one.example/', snippet: 'first' }])
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: CHROME_SEARCH_PROVIDER_ID })
    const fiber = ctx.plugin({
      name: 'test-chrome-web-search',
      inject: ['web'],
      apply: (child: Context) => { child.web.registerSearchProvider(provider()) },
    })
    await fiber
    await expect(ctx.web.search({ query: 'x', maxResults: 5 })).resolves.toMatchObject({ sources: [{ url: 'https://one.example/' }] })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })
})
