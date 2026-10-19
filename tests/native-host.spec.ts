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
  parseRegDefault, windowsBrowsers, windowsLauncherScript, type Registry,
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
function run(command: string, args: string[], payload: Buffer, env: NodeJS.ProcessEnv = process.env, verbatim = false): Promise<HostReply> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsVerbatimArguments: verbatim })
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

  it('reads file paths only from the general or drag pasteboard', async () => {
    expect((await host([CALLER], { cmd: 'filePaths', board: 'find' })).body).toEqual({ ok: false, reason: 'bad-board' })
    expect((await host([CALLER], { cmd: 'filePaths' })).body).toEqual({ ok: false, reason: 'bad-board' })
    expect((await host(['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], { cmd: 'filePaths', board: 'general' })).body).toEqual(REFUSED)
  })

  it.runIf(process.platform === 'darwin')('answers filePaths with absolute paths on macOS (read-only)', async () => {
    // 读 drag 板而不是 general:测试不去碰用户的剪贴板,内容是什么都行,只核形状。
    const r = await host([CALLER], { cmd: 'filePaths', board: 'drag' })
    expect(r.body?.ok).toBe(true)
    expect(Array.isArray(r.body?.paths)).toBe(true)
    for (const p of r.body.paths) expect(p.startsWith('/')).toBe(true)
  })

  describe.runIf(process.platform === 'linux')('Linux clipboard', () => {
    /** A bin dir holding fake clipboard tools, each a sh script. */
    function fakeTools(scripts: Record<string, string>): string {
      const dir = mkdtempSync(path.join(tmpdir(), 'dsh-clip-'))
      for (const [name, body] of Object.entries(scripts)) {
        writeFileSync(path.join(dir, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
      }
      return dir
    }
    const clip = (bin: string, env: NodeJS.ProcessEnv, board = 'general') =>
      run(process.execPath, [HOST, CALLER], frame(JSON.stringify({ cmd: 'filePaths', board })), { PATH: bin, HOME: tmpdir(), ...env })
    // What Nautilus/Dolphin put on the clipboard: CRLF uri-list, percent-encoded.
    const URIS = "printf 'file:///tmp/a%%20b/\\r\\n# comment\\r\\nfile:///home/u/%%E4%%B8%%AD\\r\\nhttps://example.com/x\\r\\nfile://remote/share\\r\\n'"

    it('reads text/uri-list through wl-paste on Wayland', async () => {
      const bin = fakeTools({ 'wl-paste': '[ "$2 $3" = "--type text/uri-list" ] || exit 9\n' + URIS })
      expect((await clip(bin, { WAYLAND_DISPLAY: 'wayland-0' })).body).toEqual({ ok: true, paths: ['/tmp/a b/', '/home/u/中'] })
    })

    it('reads it through xclip on X11, and falls back to it when wl-paste fails', async () => {
      const bin = fakeTools({ xclip: URIS, 'wl-paste': 'echo "Failed to connect to a Wayland server" >&2; exit 1' })
      const expected = { ok: true, paths: ['/tmp/a b/', '/home/u/中'] }
      expect((await clip(bin, { DISPLAY: ':0' })).body).toEqual(expected)
      expect((await clip(bin, { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' })).body).toEqual(expected)
    })

    it('treats a clipboard without file URIs (copied text) as no paths, not a failure', async () => {
      const bin = fakeTools({ 'wl-paste': 'echo "No suitable type of content copied" >&2; exit 1' })
      expect((await clip(bin, { WAYLAND_DISPLAY: 'wayland-0' })).body).toEqual({ ok: true, paths: [] })
      const x = fakeTools({ xclip: 'echo "Error: target text/uri-list not available" >&2; exit 1' })
      expect((await clip(x, { DISPLAY: ':0' })).body).toEqual({ ok: true, paths: [] })
    })

    it('says why it cannot read: no display session, or no clipboard tool installed', async () => {
      const empty = fakeTools({})
      expect((await clip(empty, {})).body).toEqual({ ok: false, reason: 'no-display' })
      // Only meaningful when the machine itself has no wl-paste in the system dirs.
      if (!['/usr/bin', '/usr/local/bin', '/bin'].some(d => existsSync(path.join(d, 'wl-paste')))) {
        expect((await clip(empty, { WAYLAND_DISPLAY: 'wayland-0' })).body).toEqual({ ok: false, reason: 'clipboard-tool-missing' })
      }
    })

    it('refuses the drag board, which Linux does not keep', async () => {
      expect((await clip(fakeTools({}), { DISPLAY: ':0' }, 'drag')).body).toEqual({ ok: false, reason: 'unsupported-board' })
    })
  })

  it.runIf(process.platform === 'win32')('reads the Windows clipboard, and refuses the drag board Windows does not keep', async () => {
    expect((await host([CALLER], { cmd: 'filePaths', board: 'drag' })).body).toEqual({ ok: false, reason: 'unsupported-board' })
    const r = await host([CALLER], { cmd: 'filePaths', board: 'general' })
    expect(r.body?.ok).toBe(true)
    for (const p of r.body.paths) expect(path.isAbsolute(p)).toBe(true)
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

  // POSIX layout (an exec bit, a bash launcher): checked where it can run.
  it.skipIf(process.platform === 'win32')('lays down host, launcher, config, and a manifest for each present browser', () => {
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

  it.skipIf(process.platform === 'win32')('installs a launcher Chrome can actually run, and that forwards the caller', async () => {
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

  it('skips unsupported platforms and never throws on failure', () => {
    expect(installNativeHost({ platform: 'freebsd' })).toMatchObject({ installed: false })
    const { opts } = sandbox()
    const r = installNativeHost({ ...opts, hostSource: '/nonexistent/host.mjs' })
    expect(r.installed).toBe(false)
    expect(r.reason).toBeTruthy()
  })

  it('registers on Linux under $XDG_CONFIG_HOME for each browser present', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-nmh-linux-'))
    const config = path.join(home, 'xdg')
    mkdirSync(path.join(config, 'google-chrome'), { recursive: true })
    mkdirSync(path.join(config, 'microsoft-edge'), { recursive: true })
    const r = installNativeHost({
      home, dshHome: path.join(home, '.dsh'), platform: 'linux', node: process.execPath, dshEntry: '/x/bin.js',
      env: { XDG_CONFIG_HOME: config },
    })
    expect(r.browsers).toEqual([path.join(config, 'google-chrome'), path.join(config, 'microsoft-edge')])
    const manifest = JSON.parse(readFileSync(path.join(config, 'google-chrome', 'NativeMessagingHosts', 'com.dsh.chrome.json'), 'utf8'))
    expect(manifest.path).toBe(path.join(home, '.dsh', 'native-host', 'dsh-native-host'))
    expect(existsSync(path.join(home, '.config'))).toBe(false)
    expect(browserDirs('linux', '/h', {})).toContain(path.join('/h', '.config', 'google-chrome-unstable'))
  })

  it('writes a POSIX sh launcher that falls back to node on PATH', () => {
    const script = launcherScript('/gone/node', '/h/x.mjs', '/h')
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain('/home/linuxbrew/.linuxbrew/bin/node')
    expect(script).toContain('NODE=$(command -v node 2>/dev/null) && [ -x "$NODE" ] && exec "$NODE" "$HOST" "$@"')
  })

  it.skipIf(process.platform === 'win32')('the launcher still starts when the recorded node is gone, via PATH', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-nmh-path-'))
    const launcher = path.join(dir, 'launcher')
    writeFileSync(launcher, launcherScript('/gone/node', HOST, dir), { mode: 0o755 })
    // Only the running node's directory on PATH: none of the fixed candidates is assumed to exist.
    const r = await run(launcher, [CALLER], frame('{"cmd":"status"}'), { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin' })
    expect(r.body?.ok).toBe(true)
  })

  it('ships the host where the built plugin looks for it', () => {
    expect(existsSync(defaultHostSource())).toBe(true)
    expect(browserDirs('linux', '/h')[0]).toMatch(/google-chrome$/)
  })
})

describe('installNativeHost on Windows', () => {
  /** An in-memory HKCU that records every write. */
  function fakeRegistry(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial))
    const writes: string[] = []
    const registry: Registry = {
      get: key => values.get(key),
      set: (key, value) => { values.set(key, value); writes.push(key) },
    }
    return { registry, values, writes }
  }

  function sandbox(initial: Record<string, string> = {}) {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-nmh-win-'))
    const dshHome = path.join(home, '.dsh')
    const localAppData = path.join(home, 'AppData', 'Local')
    // Edge present; Chrome's user data deliberately absent (its key is written anyway).
    mkdirSync(path.join(localAppData, 'Microsoft', 'Edge', 'User Data'), { recursive: true })
    const reg = fakeRegistry(initial)
    const opts = {
      home, dshHome, localAppData, platform: 'win32' as const, registry: reg.registry,
      node: 'C:\\Program Files\\nodejs\\node.exe', dshEntry: 'C:\\dsh\\bin.js',
      env: { ProgramFiles: 'C:\\Program Files' },
    }
    return { home, dshHome, localAppData, opts, ...reg }
  }

  const CHROME_KEY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + NATIVE_HOST_NAME
  const EDGE_KEY = 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + NATIVE_HOST_NAME

  it('writes host, .cmd launcher and manifest, and points HKCU at the manifest', () => {
    const { dshHome, opts, values } = sandbox()
    const r = installNativeHost(opts)
    expect(r.installed).toBe(true)
    // Chrome always; Edge because its user data exists; Chromium/Brave absent.
    expect(r.browsers).toEqual([CHROME_KEY, EDGE_KEY])

    const dir = path.join(dshHome, 'native-host')
    const manifestFile = path.join(dir, NATIVE_HOST_NAME + '.json')
    expect(values.get(CHROME_KEY)).toBe(manifestFile)
    expect(values.get(EDGE_KEY)).toBe(manifestFile)
    expect(values.size).toBe(2)

    expect(readFileSync(path.join(dir, 'dsh-native-host.mjs'), 'utf8')).toBe(readFileSync(HOST, 'utf8'))
    expect(readFileSync(path.join(dir, 'dsh-native-host.cmd'), 'utf8')).toContain('%~dp0dsh-native-host.mjs')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    expect(manifest).toMatchObject({
      name: NATIVE_HOST_NAME,
      type: 'stdio',
      path: path.join(dir, 'dsh-native-host.cmd'),
      allowed_origins: ['chrome-extension://' + EXTENSION_ID + '/'],
    })
    // No POSIX launcher on Windows.
    expect(existsSync(path.join(dir, 'dsh-native-host'))).toBe(false)
  })

  it('is idempotent: a second boot rewrites no file and no registry value', () => {
    const { opts, writes } = sandbox()
    installNativeHost(opts)
    const before = writes.length
    const again = installNativeHost(opts)
    expect(again.changed).toEqual([])
    expect(writes.length).toBe(before)
  })

  it('repairs a key that points somewhere else (an older or a hand-made install)', () => {
    const { opts, writes } = sandbox({ [CHROME_KEY]: 'C:\\old\\com.dsh.chrome.json' })
    const r = installNativeHost(opts)
    expect(r.changed).toContain(CHROME_KEY)
    expect(writes).toContain(CHROME_KEY)
  })

  it('reports a registry failure without throwing', () => {
    const { opts } = sandbox()
    const registry: Registry = { get: () => undefined, set: () => { throw new Error('reg.exe: access denied') } }
    const r = installNativeHost({ ...opts, registry })
    expect(r.installed).toBe(false)
    expect(r.reason).toContain('access denied')
  })

  it.runIf(process.platform === 'win32')('installs a launcher cmd.exe runs the way Chrome starts it, forwarding the caller', async () => {
    const { home, dshHome, opts } = sandbox()
    // A real entry file: the host only trusts a recorded launch whose files exist.
    const dshEntry = path.join(home, 'fake-dsh', 'bin.js')
    mkdirSync(path.dirname(dshEntry), { recursive: true })
    writeFileSync(dshEntry, '')
    installNativeHost({ ...opts, node: process.execPath, dshEntry, env: process.env })
    const launcher = path.join(dshHome, 'native-host', 'dsh-native-host.cmd')
    // Chrome: cmd.exe /d /s /c ""<launcher>" <origin> --parent-window=<hwnd>"
    const viaChrome = (caller: string) => run(process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', '""' + launcher + '" ' + caller + ' --parent-window=0"'],
      frame(JSON.stringify({ cmd: 'status' })), process.env, true)
    const ok = await viaChrome(CALLER)
    expect(ok.body?.ok).toBe(true)
    expect(ok.body?.dsh).toBe(process.execPath + ' ' + dshEntry)
    // DSH_HOME came from the launcher's own directory.
    expect(ok.body?.logDir.toLowerCase()).toBe(path.join(dshHome, 'logs', 'chrome-native-host').toLowerCase())
    expect((await viaChrome('chrome-extension://' + OLD_DEV_ID + '/')).body).toEqual(REFUSED)
  })

  it("knows each browser's key and user-data directory", () => {
    const local = path.join('C:', 'Users', 'u', 'AppData', 'Local')
    const browsers = windowsBrowsers(local)
    expect(browsers.filter(b => b.always).map(b => b.key)).toEqual([CHROME_KEY])
    expect(browsers.map(b => b.dataDir)).toContain(path.join(local, 'Microsoft', 'Edge', 'User Data'))
    expect(browsers.map(b => b.key)).toEqual(['Google\\Chrome', 'Chromium', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser']
      .map(vendor => 'HKCU\\Software\\' + vendor + '\\NativeMessagingHosts\\com.dsh.chrome'))
  })
})

describe('windowsLauncherScript', () => {
  it('forwards the caller, finds everything else from its own directory, and never echoes', () => {
    const script = windowsLauncherScript('C:\\Program Files\\nodejs\\node.exe', { ProgramFiles: 'C:\\Program Files' })
    const lines = script.split('\r\n')
    expect(lines[0]).toBe('@echo off')
    // CRLF throughout: no bare LF a strict cmd parse could trip on.
    expect(script.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(script).toContain('set "NODE=%ProgramFiles%\\nodejs\\node.exe"')
    expect(script).toContain('for %%I in ("%~dp0..") do set "DSH_HOME=%%~fI"')
    expect(lines).toContain('"%NODE%" "%~dp0dsh-native-host.mjs" %*')
    // Fallbacks when the recorded node is gone.
    expect(script).toContain('if not exist "%NODE%" set "NODE=node"')
    expect(script).not.toMatch(/^echo /m)
    expect(script).not.toContain('chcp')
  })

  it('writes a non-ASCII profile through its environment variable instead of literally', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\张三\\AppData\\Local', USERPROFILE: 'C:\\Users\\张三' }
    const script = windowsLauncherScript('C:\\Users\\张三\\AppData\\Local\\Volta\\bin\\node.exe', env)
    expect(script).toContain('set "NODE=%LOCALAPPDATA%\\Volta\\bin\\node.exe"')
    expect(script).not.toContain('张三')
    expect(script).not.toContain('chcp')
  })

  it('switches cmd to UTF-8 only when a non-ASCII path cannot be shortened', () => {
    const lines = windowsLauncherScript('D:\\工具\\node\\node.exe', {}).split('\r\n')
    const chcp = lines.indexOf('chcp 65001 >nul 2>nul')
    expect(chcp).toBeGreaterThan(0)
    expect(chcp).toBeLessThan(lines.findIndex(l => l.startsWith('set "NODE=')))
  })

  it('escapes % so a literal path is not expanded as a variable', () => {
    expect(windowsLauncherScript('C:\\100%\\node.exe', {})).toContain('set "NODE=C:\\100%%\\node.exe"')
  })
})

describe('parseRegDefault', () => {
  it('reads the default value in any UI language', () => {
    const key = 'HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dsh.chrome'
    expect(parseRegDefault('\r\n' + key + '\r\n    (Default)    REG_SZ    C:\\Users\\u\\.dsh\\native-host\\com.dsh.chrome.json\r\n\r\n'))
      .toBe('C:\\Users\\u\\.dsh\\native-host\\com.dsh.chrome.json')
    expect(parseRegDefault('\r\n' + key + '\r\n    (默认)    REG_SZ    C:\\My Files\\com.dsh.chrome.json\r\n'))
      .toBe('C:\\My Files\\com.dsh.chrome.json')
    expect(parseRegDefault('')).toBeUndefined()
  })
})
