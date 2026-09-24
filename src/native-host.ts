/**
 * Registers the `com.dsh.chrome` Native Messaging host every time dsh boots
 * with this plugin, so the store-installed extension can:
 *
 *   - start `dsh web` when it is not running;
 *   - obtain the signed browser-session login cookie.
 *
 * Nothing else is installed. The extension comes from the Chrome Web Store;
 * this only lays down what the extension needs on the machine side.
 *
 * Layout under `$DSH_HOME/native-host/`:
 *
 *   dsh-native-host.mjs   the host, copied from this package
 *   dsh-native-host       launcher Chrome executes (absolute node, forwards argv)
 *   config.json           how the *running* dsh was launched (node + entry)
 *
 * plus `<browser>/NativeMessagingHosts/com.dsh.chrome.json` for every
 * Chromium-family browser directory that exists. The files are copied rather
 * than pointed at inside `node_modules`, because a plugin update replaces the
 * package directory while Chrome keeps the registered path.
 *
 * Every write is compare-then-atomic-rename, so an unchanged boot touches no
 * file, and a failure never breaks the plugin: it is logged and the rest of
 * the plugin loads normally (Chrome control does not depend on this).
 *
 * macOS and Linux only; on Windows the registration lives in the registry and
 * is not attempted.
 *
 * @module dsh-chrome/native-host
 */

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

export interface InstallOptions {
  /** `$DSH_HOME`; defaults to the env var, then `~/.dsh`. */
  dshHome?: string
  /** OS home, used to find browser directories. */
  home?: string
  /** Platform; only `darwin` and `linux` install anything. */
  platform?: NodeJS.Platform
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
  /** Browser manifests now registered (whether or not they changed). */
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
 * Lay down the host and register it. Idempotent and synchronous (a handful of
 * small files); never throws.
 */
export function installNativeHost(options: InstallOptions = {}): InstallResult {
  const platform = options.platform ?? process.platform
  const result: InstallResult = { installed: false, browsers: [], changed: [] }
  if (platform !== 'darwin' && platform !== 'linux') {
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
    const launcher = path.join(dir, 'dsh-native-host')

    writeIfChanged(hostFile, readFileSync(source, 'utf8'), 0o644, result.changed)
    writeIfChanged(launcher, launcherScript(node, hostFile, dshHome), 0o755, result.changed)
    writeIfChanged(path.join(dir, 'config.json'), JSON.stringify({ node, dshEntry }, null, 2) + '\n', 0o644, result.changed)

    const manifest = hostManifest(launcher)
    for (const browser of browserDirs(platform, home)) {
      if (!existsSync(browser)) continue
      writeIfChanged(path.join(browser, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`), manifest, 0o644, result.changed)
      result.browsers.push(browser)
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
