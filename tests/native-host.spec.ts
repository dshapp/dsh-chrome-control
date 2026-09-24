/**
 * The Native Messaging host and its boot-time registration.
 *
 * The host is exercised as a real process (it is a process boundary: argv from
 * Chrome, framed stdio), and the installer against a throwaway home so no
 * real browser directory is touched.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXTENSION_ID, NATIVE_HOST_NAME, browserDirs, defaultHostSource, installNativeHost, launcherScript,
} from '../src/native-host.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const HOST = path.join(ROOT, 'native-host', 'dsh-native-host.mjs')
const CALLER = `chrome-extension://${EXTENSION_ID}/`
const OLD_DEV_ID = 'hjgcllfkbkhmggdopnfhhmaiaedacnpg'
const REFUSED = { ok: false, reason: 'caller-not-allowed' }

function frame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

interface HostReply { code: number | null; body: any; stderr: string }

/** Run a command the way Chrome does: argv, one frame in, one frame out. */
function run(command: string, args: string[], payload: Buffer, env: NodeJS.ProcessEnv = process.env): Promise<HostReply> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
    let out = Buffer.alloc(0)
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { out = Buffer.concat([out, c]) })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    // A refused caller exits without reading stdin; EPIPE is expected then.
    child.stdin.on('error', () => {})
    child.on('close', code => {
      const body = out.length >= 4 ? JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString('utf8')) : null
      resolve({ code, body, stderr })
    })
    child.stdin.end(payload)
  })
}

const host = (args: string[], message: unknown = { cmd: 'status' }) =>
  run(process.execPath, [HOST, ...args], frame(JSON.stringify(message)))

describe('native host: caller check', () => {
  it('serves the store extension, with or without the trailing slash', async () => {
    for (const caller of [CALLER, `chrome-extension://${EXTENSION_ID}`]) {
      const r = await host([caller])
      expect(r.code).toBe(0)
      expect(r.body?.ok).toBe(true)
      expect(r.body?.host).toBe(NATIVE_HOST_NAME)
    }
  })

  it('accepts the Windows form, where --parent-window follows the origin', async () => {
    expect((await host([CALLER, '--parent-window=12345'])).body?.ok).toBe(true)
  })

  it('refuses a missing caller (a launcher that drops argv, or a manual run)', async () => {
    const r = await host([])
    expect(r.code).toBe(0)
    expect(r.body).toEqual(REFUSED)
  })

  it('refuses other extensions, the old dev id, and look-alikes', async () => {
    const callers = [
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
      `chrome-extension://${OLD_DEV_ID}/`,
      `chrome-extension://${EXTENSION_ID}x/`,
      `chrome-extension://${EXTENSION_ID.slice(0, -1)}/`,
      `chrome-extension://${EXTENSION_ID}/extra`,
      `https://${EXTENSION_ID}/`,
      `CHROME-EXTENSION://${EXTENSION_ID}/`,
      EXTENSION_ID,
      '',
      '--parent-window=1',
    ]
    for (const caller of callers) expect((await host([caller])).body, caller).toEqual(REFUSED)
    // The origin only counts as the first argument.
    expect((await host(['--parent-window=1', CALLER])).body).toEqual(REFUSED)
  })

  it('gives a refused caller neither a cookie nor a started server', async () => {
    const other = ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']
    expect((await host(other, { cmd: 'cookie', host: '127.0.0.1', port: 3080 })).body).toEqual(REFUSED)
    expect((await host(other, { cmd: 'start', target: 'web', port: 1 })).body).toEqual(REFUSED)
  })
})

describe('native host: protocol', () => {
  it('answers a malformed frame with bad-message instead of crashing', async () => {
    const r = await run(process.execPath, [HOST, CALLER], frame('{not json'))
    expect(r.code).toBe(0)
    expect(r.body).toEqual({ ok: false, reason: 'bad-message' })
    expect(r.stderr).toBe('')
    expect((await run(process.execPath, [HOST, CALLER], frame('123'))).body).toEqual({ ok: false, reason: 'bad-message' })
  })

  it('answers an unknown command with unknown-cmd', async () => {
    expect((await host([CALLER], { cmd: 'nope' })).body).toEqual({ ok: false, reason: 'unknown-cmd' })
  })

  it('will not start dsh on a non-loopback host', async () => {
    const r = await host([CALLER], { cmd: 'start', target: 'web', host: '0.0.0.0', port: 3080 })
    expect(r.body).toMatchObject({ ok: false, reason: 'host-not-loopback' })
  })
})

describe('extension id has one value everywhere', () => {
  it('matches the host file and the daemon guard', () => {
    const pinned = /^const ALLOWED_EXTENSION_ID = "([a-p]{32})";$/m.exec(readFileSync(HOST, 'utf8'))?.[1]
    expect(pinned).toBe(EXTENSION_ID)
    const guard = readFileSync(path.join(ROOT, 'daemon', 'src', 'host_guard.rs'), 'utf8')
    expect(guard).toContain(`pub const ALLOWED_ORIGIN: &str = "chrome-extension://${EXTENSION_ID}";`)
  })
})

describe('installNativeHost', () => {
  function sandbox() {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-nmh-'))
    const dshHome = path.join(home, '.dsh')
    // One browser present, the others absent.
    const chrome = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    mkdirSync(chrome, { recursive: true })
    const dshEntry = path.join(home, 'fake-dsh', 'bin.js')
    mkdirSync(path.dirname(dshEntry), { recursive: true })
    writeFileSync(dshEntry, '')
    const opts = { home, dshHome, platform: 'darwin' as const, node: process.execPath, dshEntry }
    return { home, dshHome, chrome, dshEntry, opts }
  }

  it('lays down host, launcher, config, and a manifest for each present browser', () => {
    const { dshHome, chrome, dshEntry, opts } = sandbox()
    const r = installNativeHost(opts)
    expect(r.installed).toBe(true)
    expect(r.browsers).toEqual([chrome])

    const dir = path.join(dshHome, 'native-host')
    expect(readFileSync(path.join(dir, 'dsh-native-host.mjs'), 'utf8')).toBe(readFileSync(HOST, 'utf8'))
    expect(statSync(path.join(dir, 'dsh-native-host')).mode & 0o111).not.toBe(0)
    expect(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({ node: process.execPath, dshEntry })

    const manifest = JSON.parse(readFileSync(path.join(chrome, 'NativeMessagingHosts', 'com.dsh.chrome.json'), 'utf8'))
    expect(manifest).toMatchObject({
      name: 'com.dsh.chrome',
      type: 'stdio',
      path: path.join(dir, 'dsh-native-host'),
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    })
    // Absent browsers get nothing created for them.
    expect(existsSync(path.join(opts.home, 'Library', 'Application Support', 'Microsoft Edge'))).toBe(false)
  })

  it('is idempotent: a second boot rewrites nothing', () => {
    const { opts } = sandbox()
    expect(installNativeHost(opts).changed.length).toBeGreaterThan(0)
    expect(installNativeHost(opts).changed).toEqual([])
  })

  it('rewrites the config when dsh is launched from a different install', () => {
    const { opts, home } = sandbox()
    installNativeHost(opts)
    const other = path.join(home, 'other', 'bin.js')
    const r = installNativeHost({ ...opts, dshEntry: other })
    expect(r.changed).toEqual([path.join(opts.dshHome, 'native-host', 'config.json')])
  })

  it('installs a launcher Chrome can actually run, and that forwards the caller', async () => {
    const { dshHome, opts } = sandbox()
    installNativeHost(opts)
    const launcher = path.join(dshHome, 'native-host', 'dsh-native-host')
    const ok = await run(launcher, [CALLER], frame(JSON.stringify({ cmd: 'status' })), { PATH: '/usr/bin:/bin' })
    expect(ok.body?.ok).toBe(true)
    // Recorded launch is reported: node + the entry this dsh booted from.
    expect(ok.body?.dsh).toBe(`${process.execPath} ${opts.dshEntry}`)
    const refused = await run(launcher, [`chrome-extension://${OLD_DEV_ID}/`], frame('{"cmd":"status"}'), { PATH: '/usr/bin:/bin' })
    expect(refused.body).toEqual(REFUSED)
  })

  it('quotes paths with spaces and quotes in the launcher', () => {
    const script = launcherScript("/opt/my node/it's/node", '/h/x.mjs', '/h')
    expect(script).toContain(`'/opt/my node/it'\\''s/node'`)
    expect(script).toMatch(/exec "\$NODE" "\$HOST" "\$@"/)
  })

  it('does nothing on Windows and never throws on failure', () => {
    expect(installNativeHost({ platform: 'win32' })).toMatchObject({ installed: false })
    const { opts } = sandbox()
    const r = installNativeHost({ ...opts, hostSource: '/nonexistent/host.mjs' })
    expect(r.installed).toBe(false)
    expect(r.reason).toBeTruthy()
  })

  it('ships the host where the built plugin looks for it', () => {
    expect(existsSync(defaultHostSource())).toBe(true)
    expect(browserDirs('linux', '/h')[0]).toMatch(/google-chrome$/)
  })
})
