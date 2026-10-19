/**
 * Registers the `com.dsh.chrome` Native Messaging host every time dsh boots
 * with this plugin, so the store-installed extension can:
 *
 *   - start `dsh web` when it is not running;
 *   - obtain the signed browser-session login cookie;
 *   - read the absolute paths on the macOS copy/drag pasteboard (a pasted or
 *     dropped folder is referenced by path; browsers never expose it).
 *
 * Nothing else is installed. The extension comes from the Chrome Web Store;
 * this only lays down what the extension needs on the machine side.
 *
 * Layout under `$DSH_HOME/native-host/`:
 *
 *   dsh-native-host.mjs   the host, copied from this package
 *   dsh-native-host       launcher Chrome executes (absolute node, forwards argv)
 *                         — `dsh-native-host.cmd` on Windows
 *   config.json           how the *running* dsh was launched (node + entry)
 *
 * plus the browser-side registration:
 *
 *   - macOS / Linux: `<browser>/NativeMessagingHosts/com.dsh.chrome.json` for
 *     every Chromium-family browser directory that exists;
 *   - Windows: `$DSH_HOME/native-host/com.dsh.chrome.json`, pointed at by the
 *     default value of `HKCU\Software\<vendor>\NativeMessagingHosts\com.dsh.chrome`.
 *     Windows Chrome never scans a directory for host manifests — it only reads
 *     the registry, which is why a manifest file alone is "host not found".
 *     Google Chrome's key is always written (it is the store extension's home,
 *     and the registry lookup does not depend on where the profile lives);
 *     Chromium, Edge and Brave only when their user-data directory exists.
 *     HKCU needs no elevation.
 *
 * The files are copied rather than pointed at inside `node_modules`, because a
 * plugin update replaces the package directory while Chrome keeps the
 * registered path.
 *
 * Every write is compare-then-atomic-rename, so an unchanged boot touches no
 * file, and a failure never breaks the plugin: it is logged and the rest of
 * the plugin loads normally (Chrome control does not depend on this).
 *
 * macOS, Linux and Windows 10+.
 *
 * @module dsh-chrome/native-host
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The host name the extension passes to `chrome.runtime.sendNativeMessage`. */
export const NATIVE_HOST_NAME = 'com.dsh.chrome'

/**
 * The only extension the host serves: the Chrome Web Store id. Chrome enforces
 * it through `allowed_origins`, and the host re-checks the caller Chrome
 * passes in argv. Tests assert it matches the host file and the daemon.
 */
export const EXTENSION_ID = 'kgjjicancjnedmappjhefngdjaommpop'

/** Minimal logger surface, so tests need no Cordis context. */
export interface Log {
  info(message: string): void
  warn(message: string): void
}

/**
 * The slice of the Windows registry the installer touches: the default value
 * of a key under HKCU. Injected so tests run anywhere; the real one shells out
 * to `reg.exe`, which ships with every Windows and needs no elevation for HKCU.
 */
export interface Registry {
  /** The key's default value, or undefined when the key or value is absent. */
  get(key: string): string | undefined
  /** Create the key if needed and set its default value. Throws on failure. */
  set(key: string, value: string): void
}

export interface InstallOptions {
  /** `$DSH_HOME`; defaults to the env var, then `~/.dsh`. */
  dshHome?: string
  /** OS home, used to find browser directories. */
  home?: string
  /** Platform; `darwin`, `linux` and `win32` install, anything else is skipped. */
  platform?: NodeJS.Platform
  /** Windows: `%LOCALAPPDATA%`, where browsers keep their user data. */
  localAppData?: string
  /** Windows: the registry to register in; defaults to `reg.exe` on HKCU. */
  registry?: Registry
  /** Windows: environment used to shorten paths in the launcher (`%LOCALAPPDATA%\…`). */
  env?: NodeJS.ProcessEnv
  /** Absolute node binary of the running dsh. */
  node?: string
  /** Absolute entry script of the running dsh (`process.argv[1]`). */
  dshEntry?: string
  /** The host source file shipped in this package. */
  hostSource?: string
  log?: Log
}

export interface InstallResult {
  installed: boolean
  reason?: string
  /**
   * Where the host is now registered (whether or not that changed): browser
   * directories on macOS/Linux, HKCU registry keys on Windows.
   */
  browsers: string[]
  /** Files actually rewritten on this run. */
  changed: string[]
}

/** The host file inside this package: `<pkg>/native-host/dsh-native-host.mjs`. */
export function defaultHostSource(): string {
  // lib/server.js and src/native-host.ts both sit one level below the root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'native-host', 'dsh-native-host.mjs')
}

/** Chromium-family user-data directories that own a `NativeMessagingHosts/`. */
export function browserDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'darwin') {
    const s = path.join(home, 'Library', 'Application Support')
    return [
      'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium',
      'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Vivaldi',
    ].map(d => path.join(s, d))
  }
  const c = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return [
    'google-chrome', 'google-chrome-beta', 'chromium', 'microsoft-edge',
    'BraveSoftware/Brave-Browser', 'vivaldi',
  ].map(d => path.join(c, d))
}

/** A Windows browser's registration key under HKCU and its user-data directory. */
export interface WindowsBrowser {
  /** `HKCU\Software\…\NativeMessagingHosts\com.dsh.chrome`. */
  key: string
  /** User-data directory whose presence says the browser is installed. */
  dataDir: string
  /** Register even when `dataDir` is missing. */
  always: boolean
}

/**
 * Chromium-family browsers on Windows. Chrome Beta/Dev/Canary share Google
 * Chrome's key; Vivaldi and other forks that read Chrome's key are covered by it.
 */
export function windowsBrowsers(localAppData: string): WindowsBrowser[] {
  const hkcu = (vendor: string): string => `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
  // Native `path`: on Windows that is win32; elsewhere only tests get here.
  const data = (...dirs: string[]): string => path.join(localAppData, ...dirs, 'User Data')
  return [
    { key: hkcu('Google\\Chrome'), dataDir: data('Google', 'Chrome'), always: true },
    { key: hkcu('Chromium'), dataDir: data('Chromium'), always: false },
    { key: hkcu('Microsoft\\Edge'), dataDir: data('Microsoft', 'Edge'), always: false },
    { key: hkcu('BraveSoftware\\Brave-Browser'), dataDir: data('BraveSoftware', 'Brave-Browser'), always: false },
  ]
}

/** `%SystemRoot%\System32\<exe>`, absolute so a planted `reg.exe` in cwd/PATH is never picked. */
function system32(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', exe)
}

/** The default value's data in `reg query <key> /ve` output, or undefined. */
export function parseRegDefault(output: string): string | undefined {
  return /\bREG_(?:EXPAND_)?SZ[ \t]+(.*?)[ \t]*\r?$/m.exec(output)?.[1]
}

/**
 * The real registry, through `reg.exe`. `reg query` labels the default value
 * in the UI language (`(Default)`, `(默认)`…), so the value is located by its
 * type column instead. A value that does not read back exactly (an OEM code
 * page mangling a non-ASCII profile path) only costs a redundant `reg add`.
 */
export function regExeRegistry(env: NodeJS.ProcessEnv = process.env): Registry {
  const reg = system32('reg.exe', env)
  const run = (args: string[]): string => execFileSync(reg, args, {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    get(key) {
      try {
        return parseRegDefault(run(['query', key, '/ve']))
      } catch {
        return undefined
      }
    },
    set(key, value) {
      run(['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'])
    },
  }
}

/** Escape literal text for a batch file: only `%` is special inside `set "…"` and `"…"`. */
function batchLiteral(value: string): string {
  return value.replace(/%/g, '%%')
}

/**
 * Write `file` for a batch script, expressing a leading user directory through
 * its environment variable. cmd decodes a batch file in the OEM code page, so a
 * non-ASCII profile (`C:\Users\张三\…`) written literally would not round-trip;
 * `%LOCALAPPDATA%` expands inside cmd in UTF-16 and does.
 */
function batchPath(file: string, env: NodeJS.ProcessEnv): string {
  const lower = file.toLowerCase()
  for (const name of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ProgramFiles']) {
    const dir = env[name]?.replace(/[\\/]+$/, '')
    if (!dir) continue
    const prefix = dir.toLowerCase()
    if (lower === prefix || lower.startsWith(prefix + '\\')) {
      return `%${name}%${batchLiteral(file.slice(dir.length))}`
    }
  }
  return batchLiteral(file)
}

/**
 * The Windows launcher. Chrome runs it as `cmd.exe /d /s /c "<launcher>" <origin>
 * --parent-window=<hwnd>`, so a `.cmd` file is a valid host executable.
 *
 * Everything the launcher needs from its own location comes from `%~dp0`
 * (cmd expands it natively, so any characters survive): the host sits beside
 * it and `$DSH_HOME` is its parent. node is tried as recorded, then the
 * official installer location, then PATH. `%*` is load-bearing exactly like
 * `"$@"` in the POSIX launcher.
 *
 * Nothing is echoed: stdout is the Native Messaging channel.
 */
export function windowsLauncherScript(node: string, env: NodeJS.ProcessEnv = process.env): string {
  const nodeRef = batchPath(node, env)
  // Still non-ASCII after shortening: switch cmd to UTF-8 before the line that
  // carries it. chcp's own message goes to nul, never to the channel.
  const needsUtf8 = /[^\x00-\x7f]/.test(nodeRef)
  return [
    '@echo off',
    'rem Written by dsh-chrome-control on every dsh boot; edits are overwritten.',
    ...(needsUtf8 ? ['chcp 65001 >nul 2>nul'] : []),
    'setlocal',
    'for %%I in ("%~dp0..") do set "DSH_HOME=%%~fI"',
    `set "NODE=${nodeRef}"`,
    'if not exist "%NODE%" set "NODE=%ProgramFiles%\\nodejs\\node.exe"',
    'if not exist "%NODE%" set "NODE=node"',
    '"%NODE%" "%~dp0dsh-native-host.mjs" %*',
    '',
  ].join('\r\n')
}

/** Single-quote a string for bash. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The launcher Chrome executes. Chrome starts it with a minimal PATH, so node
 * is absolute: the running dsh's node first, then the usual stable symlinks
 * (a Homebrew upgrade deletes the versioned Cellar path recorded earlier).
 *
 * `"$@"` is load-bearing: Chrome passes the caller's origin as the first
 * argument, and the host refuses every caller it cannot see.
 */
export function launcherScript(node: string, hostFile: string, dshHome: string): string {
  return [
    '#!/bin/bash',
    '# Written by dsh-chrome-control on every dsh boot; edits are overwritten.',
    `export DSH_HOME=${sh(dshHome)}`,
    `HOST=${sh(hostFile)}`,
    `for NODE in ${sh(node)} /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do`,
    '  [ -x "$NODE" ] && exec "$NODE" "$HOST" "$@"',
    'done',
    'echo "dsh-native-host: node not found" >&2',
    'exit 127',
    '',
  ].join('\n')
}

/** The browser-side registration. */
export function hostManifest(launcher: string): string {
  return JSON.stringify({
    name: NATIVE_HOST_NAME,
    description: 'Starts dsh web and provides the login cookie for the Deepseek Harness APP extension.',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  }, null, 2) + '\n'
}

/** Write only when the content differs, via a same-directory rename. */
function writeIfChanged(file: string, content: string, mode: number, changed: string[]): void {
  let current: string | undefined
  try { current = readFileSync(file, 'utf8') } catch {}
  if (current === content) {
    // Content matches; still repair a lost exec bit.
    chmodSync(file, mode)
    return
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, file)
  changed.push(file)
}

/**
 * Windows: host + `.cmd` launcher + manifest in `dir`, then one HKCU key per
 * browser pointing at the manifest. Registry writes are compare-then-set too.
 */
function installWindows(options: InstallOptions, home: string, dir: string, node: string, result: InstallResult): void {
  const env = options.env ?? process.env
  const localAppData = options.localAppData ?? (env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
  const registry = options.registry ?? regExeRegistry(env)
  const launcher = path.join(dir, 'dsh-native-host.cmd')
  const manifestFile = path.join(dir, `${NATIVE_HOST_NAME}.json`)

  writeIfChanged(launcher, windowsLauncherScript(node, env), 0o755, result.changed)
  writeIfChanged(manifestFile, hostManifest(launcher), 0o644, result.changed)

  for (const browser of windowsBrowsers(localAppData)) {
    if (!browser.always && !existsSync(browser.dataDir)) continue
    if (registry.get(browser.key) !== manifestFile) {
      registry.set(browser.key, manifestFile)
      result.changed.push(browser.key)
    }
    result.browsers.push(browser.key)
  }
}

/**
 * Lay down the host and register it. Idempotent and synchronous (a handful of
 * small files, a few `reg.exe` calls on Windows); never throws.
 */
export function installNativeHost(options: InstallOptions = {}): InstallResult {
  const platform = options.platform ?? process.platform
  const result: InstallResult = { installed: false, browsers: [], changed: [] }
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    result.reason = `unsupported platform ${platform}`
    options.log?.info(`native host not registered: ${result.reason}`)
    return result
  }
  try {
    const home = options.home ?? homedir()
    const dshHome = options.dshHome ?? (process.env.DSH_HOME || path.join(home, '.dsh'))
    const node = options.node ?? process.execPath
    const dshEntry = options.dshEntry ?? process.argv[1] ?? ''
    const source = options.hostSource ?? defaultHostSource()

    const dir = path.join(dshHome, 'native-host')
    const hostFile = path.join(dir, 'dsh-native-host.mjs')

    writeIfChanged(hostFile, readFileSync(source, 'utf8'), 0o644, result.changed)
    writeIfChanged(path.join(dir, 'config.json'), JSON.stringify({ node, dshEntry }, null, 2) + '\n', 0o644, result.changed)

    if (platform === 'win32') {
      installWindows(options, home, dir, node, result)
    } else {
      const launcher = path.join(dir, 'dsh-native-host')
      writeIfChanged(launcher, launcherScript(node, hostFile, dshHome), 0o755, result.changed)
      const manifest = hostManifest(launcher)
      for (const browser of browserDirs(platform, home)) {
        if (!existsSync(browser)) continue
        writeIfChanged(path.join(browser, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`), manifest, 0o644, result.changed)
        result.browsers.push(browser)
      }
    }

    result.installed = true
    if (result.browsers.length === 0) {
      options.log?.warn('native host files written, but no Chromium-family browser directory was found')
    } else if (result.changed.length > 0) {
      options.log?.info(`native host ${NATIVE_HOST_NAME} registered for ${result.browsers.length} browser(s)`)
    }
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error)
    options.log?.warn(`native host registration failed: ${result.reason}`)
  }
  return result
}
