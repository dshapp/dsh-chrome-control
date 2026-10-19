import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
//#region src/native-host.ts
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
/** The host name the extension passes to `chrome.runtime.sendNativeMessage`. */
const NATIVE_HOST_NAME = "com.dsh.chrome";
/**
* The only extension the host serves: the Chrome Web Store id. Chrome enforces
* it through `allowed_origins`, and the host re-checks the caller Chrome
* passes in argv. Tests assert it matches the host file and the daemon.
*/
const EXTENSION_ID = "kgjjicancjnedmappjhefngdjaommpop";
/** The host file inside this package: `<pkg>/native-host/dsh-native-host.mjs`. */
function defaultHostSource() {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "native-host", "dsh-native-host.mjs");
}
/** Chromium-family user-data directories that own a `NativeMessagingHosts/`. */
function browserDirs(platform, home) {
	if (platform === "darwin") {
		const s = path.join(home, "Library", "Application Support");
		return [
			"Google/Chrome",
			"Google/Chrome Beta",
			"Google/Chrome Canary",
			"Chromium",
			"Microsoft Edge",
			"BraveSoftware/Brave-Browser",
			"Vivaldi"
		].map((d) => path.join(s, d));
	}
	const c = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
	return [
		"google-chrome",
		"google-chrome-beta",
		"chromium",
		"microsoft-edge",
		"BraveSoftware/Brave-Browser",
		"vivaldi"
	].map((d) => path.join(c, d));
}
/**
* Chromium-family browsers on Windows. Chrome Beta/Dev/Canary share Google
* Chrome's key; Vivaldi and other forks that read Chrome's key are covered by it.
*/
function windowsBrowsers(localAppData) {
	const hkcu = (vendor) => `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
	const data = (...dirs) => path.join(localAppData, ...dirs, "User Data");
	return [
		{
			key: hkcu("Google\\Chrome"),
			dataDir: data("Google", "Chrome"),
			always: true
		},
		{
			key: hkcu("Chromium"),
			dataDir: data("Chromium"),
			always: false
		},
		{
			key: hkcu("Microsoft\\Edge"),
			dataDir: data("Microsoft", "Edge"),
			always: false
		},
		{
			key: hkcu("BraveSoftware\\Brave-Browser"),
			dataDir: data("BraveSoftware", "Brave-Browser"),
			always: false
		}
	];
}
/** `%SystemRoot%\System32\<exe>`, absolute so a planted `reg.exe` in cwd/PATH is never picked. */
function system32(exe, env = process.env) {
	return path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", exe);
}
/** The default value's data in `reg query <key> /ve` output, or undefined. */
function parseRegDefault(output) {
	return /\bREG_(?:EXPAND_)?SZ[ \t]+(.*?)[ \t]*\r?$/m.exec(output)?.[1];
}
/**
* The real registry, through `reg.exe`. `reg query` labels the default value
* in the UI language (`(Default)`, `(默认)`…), so the value is located by its
* type column instead. A value that does not read back exactly (an OEM code
* page mangling a non-ASCII profile path) only costs a redundant `reg add`.
*/
function regExeRegistry(env = process.env) {
	const reg = system32("reg.exe", env);
	const run = (args) => execFileSync(reg, args, {
		encoding: "utf8",
		windowsHide: true,
		timeout: 1e4,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	return {
		get(key) {
			try {
				return parseRegDefault(run([
					"query",
					key,
					"/ve"
				]));
			} catch {
				return;
			}
		},
		set(key, value) {
			run([
				"add",
				key,
				"/ve",
				"/t",
				"REG_SZ",
				"/d",
				value,
				"/f"
			]);
		}
	};
}
/** Escape literal text for a batch file: only `%` is special inside `set "…"` and `"…"`. */
function batchLiteral(value) {
	return value.replace(/%/g, "%%");
}
/**
* Write `file` for a batch script, expressing a leading user directory through
* its environment variable. cmd decodes a batch file in the OEM code page, so a
* non-ASCII profile (`C:\Users\张三\…`) written literally would not round-trip;
* `%LOCALAPPDATA%` expands inside cmd in UTF-16 and does.
*/
function batchPath(file, env) {
	const lower = file.toLowerCase();
	for (const name of [
		"LOCALAPPDATA",
		"APPDATA",
		"USERPROFILE",
		"ProgramFiles"
	]) {
		const dir = env[name]?.replace(/[\\/]+$/, "");
		if (!dir) continue;
		const prefix = dir.toLowerCase();
		if (lower === prefix || lower.startsWith(prefix + "\\")) return `%${name}%${batchLiteral(file.slice(dir.length))}`;
	}
	return batchLiteral(file);
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
function windowsLauncherScript(node, env = process.env) {
	const nodeRef = batchPath(node, env);
	return [
		"@echo off",
		"rem Written by dsh-chrome-control on every dsh boot; edits are overwritten.",
		.../[^\x00-\x7f]/.test(nodeRef) ? ["chcp 65001 >nul 2>nul"] : [],
		"setlocal",
		"for %%I in (\"%~dp0..\") do set \"DSH_HOME=%%~fI\"",
		`set "NODE=${nodeRef}"`,
		"if not exist \"%NODE%\" set \"NODE=%ProgramFiles%\\nodejs\\node.exe\"",
		"if not exist \"%NODE%\" set \"NODE=node\"",
		"\"%NODE%\" \"%~dp0dsh-native-host.mjs\" %*",
		""
	].join("\r\n");
}
/** Single-quote a string for bash. */
function sh(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
/**
* The launcher Chrome executes. Chrome starts it with a minimal PATH, so node
* is absolute: the running dsh's node first, then the usual stable symlinks
* (a Homebrew upgrade deletes the versioned Cellar path recorded earlier).
*
* `"$@"` is load-bearing: Chrome passes the caller's origin as the first
* argument, and the host refuses every caller it cannot see.
*/
function launcherScript(node, hostFile, dshHome) {
	return [
		"#!/bin/bash",
		"# Written by dsh-chrome-control on every dsh boot; edits are overwritten.",
		`export DSH_HOME=${sh(dshHome)}`,
		`HOST=${sh(hostFile)}`,
		`for NODE in ${sh(node)} /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do`,
		"  [ -x \"$NODE\" ] && exec \"$NODE\" \"$HOST\" \"$@\"",
		"done",
		"echo \"dsh-native-host: node not found\" >&2",
		"exit 127",
		""
	].join("\n");
}
/** The browser-side registration. */
function hostManifest(launcher) {
	return JSON.stringify({
		name: NATIVE_HOST_NAME,
		description: "Starts dsh web and provides the login cookie for the Deepseek Harness APP extension.",
		path: launcher,
		type: "stdio",
		allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
	}, null, 2) + "\n";
}
/** Write only when the content differs, via a same-directory rename. */
function writeIfChanged(file, content, mode, changed) {
	let current;
	try {
		current = readFileSync(file, "utf8");
	} catch {}
	if (current === content) {
		chmodSync(file, mode);
		return;
	}
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, content, { mode });
	chmodSync(tmp, mode);
	renameSync(tmp, file);
	changed.push(file);
}
/**
* Windows: host + `.cmd` launcher + manifest in `dir`, then one HKCU key per
* browser pointing at the manifest. Registry writes are compare-then-set too.
*/
function installWindows(options, home, dir, node, result) {
	const env = options.env ?? process.env;
	const localAppData = options.localAppData ?? (env.LOCALAPPDATA || path.join(home, "AppData", "Local"));
	const registry = options.registry ?? regExeRegistry(env);
	const launcher = path.join(dir, "dsh-native-host.cmd");
	const manifestFile = path.join(dir, `${NATIVE_HOST_NAME}.json`);
	writeIfChanged(launcher, windowsLauncherScript(node, env), 493, result.changed);
	writeIfChanged(manifestFile, hostManifest(launcher), 420, result.changed);
	for (const browser of windowsBrowsers(localAppData)) {
		if (!browser.always && !existsSync(browser.dataDir)) continue;
		if (registry.get(browser.key) !== manifestFile) {
			registry.set(browser.key, manifestFile);
			result.changed.push(browser.key);
		}
		result.browsers.push(browser.key);
	}
}
/**
* Lay down the host and register it. Idempotent and synchronous (a handful of
* small files, a few `reg.exe` calls on Windows); never throws.
*/
function installNativeHost(options = {}) {
	const platform = options.platform ?? process.platform;
	const result = {
		installed: false,
		browsers: [],
		changed: []
	};
	if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
		result.reason = `unsupported platform ${platform}`;
		options.log?.info(`native host not registered: ${result.reason}`);
		return result;
	}
	try {
		const home = options.home ?? homedir();
		const dshHome = options.dshHome ?? (process.env.DSH_HOME || path.join(home, ".dsh"));
		const node = options.node ?? process.execPath;
		const dshEntry = options.dshEntry ?? process.argv[1] ?? "";
		const source = options.hostSource ?? defaultHostSource();
		const dir = path.join(dshHome, "native-host");
		const hostFile = path.join(dir, "dsh-native-host.mjs");
		writeIfChanged(hostFile, readFileSync(source, "utf8"), 420, result.changed);
		writeIfChanged(path.join(dir, "config.json"), JSON.stringify({
			node,
			dshEntry
		}, null, 2) + "\n", 420, result.changed);
		if (platform === "win32") installWindows(options, home, dir, node, result);
		else {
			const launcher = path.join(dir, "dsh-native-host");
			writeIfChanged(launcher, launcherScript(node, hostFile, dshHome), 493, result.changed);
			const manifest = hostManifest(launcher);
			for (const browser of browserDirs(platform, home)) {
				if (!existsSync(browser)) continue;
				writeIfChanged(path.join(browser, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`), manifest, 420, result.changed);
				result.browsers.push(browser);
			}
		}
		result.installed = true;
		if (result.browsers.length === 0) options.log?.warn("native host files written, but no Chromium-family browser directory was found");
		else if (result.changed.length > 0) options.log?.info(`native host ${NATIVE_HOST_NAME} registered for ${result.browsers.length} browser(s)`);
	} catch (error) {
		result.reason = error instanceof Error ? error.message : String(error);
		options.log?.warn(`native host registration failed: ${result.reason}`);
	}
	return result;
}
//#endregion
//#region src/protocol.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Parse one raw text frame from the extension.
* @param text - the socket message body.
* @returns the typed frame, or `undefined` when the frame is not one of ours.
*/
function parseClientFrame(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return;
	}
	if (!isRecord(raw)) return void 0;
	switch (raw.type) {
		case "hello": {
			const payload = isRecord(raw.payload) ? raw.payload : {};
			return {
				type: "hello",
				extensionVersion: typeof payload.extensionVersion === "string" ? payload.extensionVersion : ""
			};
		}
		case "pong": return { type: "pong" };
		case "tool_result": {
			if (typeof raw.responseToRequestId !== "string") return void 0;
			const payload = isRecord(raw.payload) ? raw.payload : {};
			const frame = {
				type: "tool_result",
				responseToRequestId: raw.responseToRequestId
			};
			if ("data" in payload && payload.data !== void 0) frame.data = payload.data;
			if (typeof payload.error === "string") frame.error = payload.error;
			return frame;
		}
		default: return;
	}
}
//#endregion
//#region src/server.ts
/** Stable Cordis plugin name. */
const name = "chrome-server";
/** The bridge cannot mount routes before the web server exists. */
const inject = ["webServer"];
/** The daemon's fixed port. The extension's `dsh_chrome_url` default matches. */
const DAEMON_PORT = 37086;
/** Where the daemon's routes live. */
const MCP_PATH = "/chrome/mcp";
const STATUS_PATH = "/chrome/status";
const SHUTDOWN_PATH = "/chrome/shutdown";
/** How long to wait for a retiring daemon to release the port. */
const PORT_FREE_TIMEOUT_MS = 5e3;
/** Poll interval while waiting for that release. */
const PORT_FREE_POLL_MS = 100;
/**
* The in-box MCP bridge's config, pointed at the daemon's own port. The URL
* and the endpoint can never disagree — both are the daemon's fixed port.
*/
function bridgeConfig() {
	return {
		serverName: "chrome",
		transport: "streamable-http",
		url: `http://127.0.0.1:${DAEMON_PORT}${MCP_PATH}`,
		headers: {},
		toolCallTimeoutMs: 35e3,
		failOnStartupError: false
	};
}
/** Per-platform binary name: Windows needs the `.exe` suffix. */
const EXE = process.platform === "win32" ? "chrome-daemon.exe" : "chrome-daemon";
/** Platform-arch tuple matching the CI matrix output layout under `binaries/`. */
const PLATFORM_ARCH = `${process.platform}-${process.arch}`;
/**
* Resolve the chrome-daemon binary: the shipped per-platform copy first, then
* a dev build beside the plugin, then the legacy install dir.
*/
function resolveBinary() {
	const here = fileURLToPath(new URL(".", import.meta.url));
	return [
		path.resolve(here, "..", "binaries", PLATFORM_ARCH, EXE),
		path.resolve(here, "..", "daemon", "target", "release", EXE),
		path.resolve(homedir(), ".dsh-chrome", "bin", EXE)
	].find((p) => existsSync(p));
}
/**
* Probe the daemon: whether one is listening, and which build it is.
*
* A malformed or field-less body still counts as running — reuse must not hinge
* on parsing, only the restart decision does.
*/
function probeStatus() {
	return new Promise((resolve) => {
		const req = http.get({
			host: "127.0.0.1",
			port: DAEMON_PORT,
			path: STATUS_PATH,
			timeout: 800
		}, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				res.on("end", () => resolve({ running: false }));
				return;
			}
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => {
				try {
					const build = JSON.parse(body)?.build;
					resolve(typeof build === "string" && build !== "" ? {
						running: true,
						build
					} : { running: true });
				} catch {
					resolve({ running: true });
				}
			});
		});
		req.on("error", () => resolve({ running: false }));
		req.on("timeout", () => {
			req.destroy();
			resolve({ running: false });
		});
	});
}
/**
* Decide what to do about a daemon that is already listening.
*
* Restarting is reserved for the one case we can prove: both hashes are known
* and differ. Anything undecidable reuses the daemon — a needless restart drops
* the extension's socket, so the bar for it is evidence, not suspicion.
*
* @param running - the build hash reported by the live daemon, if any.
* @param local - the hash of the binary this install would spawn, if readable.
*/
function restartDecision(running, local) {
	if (local === void 0) return {
		restart: false,
		reason: "unknown-local"
	};
	if (running === void 0) return {
		restart: false,
		reason: "unknown-running"
	};
	return running === local ? {
		restart: false,
		reason: "match"
	} : {
		restart: true,
		reason: "changed"
	};
}
/**
* SHA-256 of the binary this install would spawn — the same identity the daemon
* reports for itself, so the two are directly comparable.
*/
function localBuildHash(bin) {
	try {
		return createHash("sha256").update(readFileSync(bin)).digest("hex");
	} catch {
		return;
	}
}
/** Ask a live daemon to retire itself. Resolves false when it will not. */
function requestShutdown() {
	return new Promise((resolve) => {
		const req = http.request({
			host: "127.0.0.1",
			port: DAEMON_PORT,
			path: SHUTDOWN_PATH,
			method: "POST",
			timeout: 2e3
		}, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode === 202));
		});
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}
/** Poll until nothing answers on the port, or the timeout expires. */
async function waitForPortFree() {
	const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
	for (;;) {
		if (!(await probeStatus()).running) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, PORT_FREE_POLL_MS));
	}
}
/** Rotate the daemon log once it passes this size, at the next spawn. */
const DAEMON_LOG_MAX_BYTES = 5242880;
/**
* Open the file the detached daemon writes its stdout/stderr to:
* `$DSH_HOME/logs/chrome-daemon.log`, appended, with one `.1` generation kept
* once it outgrows `maxBytes`.
*
* Why a file and not pipes into this process's logger: the daemon outlives
* `dsh web`, and a pipe dies with its reader. From then on every daemon log
* write failed, and a failed log write once panicked the task serving the
* extension socket — the extension looked disconnected and every
* `mcp__chrome__*` call timed out until someone killed the daemon by hand. A
* file has no reader to lose. (The daemon now also survives a dead log
* destination on its own; this keeps its logs readable as well.)
*
* Never throws: on any failure the daemon simply gets no log (`'ignore'`).
*
* @returns the descriptor to hand to `spawn` (the caller closes its copy),
*   or `'ignore'`, plus the path for the harness log.
*/
function openDaemonLog(options = {}) {
	const dshHome = options.dshHome ?? (process.env.DSH_HOME || path.join(homedir(), ".dsh"));
	const file = path.join(dshHome, "logs", "chrome-daemon.log");
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		try {
			if (statSync(file).size > (options.maxBytes ?? DAEMON_LOG_MAX_BYTES)) renameSync(file, `${file}.1`);
		} catch {}
		return {
			fd: openSync(file, "a"),
			file
		};
	} catch {
		return { fd: "ignore" };
	}
}
/**
* Spawn the detached daemon with its output going to `openDaemonLog()`'s file.
* The child handle is intentionally not returned: nothing here owns the
* daemon's lifetime.
*/
function startDaemon(log) {
	const bin = resolveBinary();
	if (bin === void 0) {
		log?.error("chrome-daemon binary not found; the agent will not see mcp__chrome__* tools");
		return;
	}
	if (process.platform !== "win32") try {
		chmodSync(bin, 493);
	} catch {}
	const output = openDaemonLog();
	let child;
	try {
		child = spawn(bin, [
			"--port",
			String(DAEMON_PORT),
			"--host",
			"127.0.0.1"
		], {
			detached: true,
			windowsHide: true,
			stdio: [
				"ignore",
				output.fd,
				output.fd
			]
		});
	} finally {
		if (typeof output.fd === "number") try {
			closeSync(output.fd);
		} catch {}
	}
	child.on("exit", (code) => {
		log?.info(`chrome-daemon exited code=${code}`);
	});
	log?.info(`chrome-daemon spawned: ${bin} (pid ${child.pid}); log: ${output.file ?? "none"}`);
	child.unref();
}
/** Proxy `/chrome/status` on the shared web server to the daemon. */
function createStatusProxyHandler() {
	return async (_req, res) => {
		const proxy = http.request({
			host: "127.0.0.1",
			port: DAEMON_PORT,
			path: STATUS_PATH,
			method: "GET",
			timeout: 3e3
		}, (upstream) => {
			res.writeHead(upstream.statusCode ?? 502, upstream.headers);
			upstream.pipe(res);
		});
		proxy.on("error", () => {
			res.writeHead(503, { "content-type": "application/json" });
			res.end(JSON.stringify({
				name: "dsh-chrome",
				running: false,
				extension_connected: false
			}));
		});
		proxy.on("timeout", () => {
			proxy.destroy();
			res.writeHead(504);
			res.end();
		});
		proxy.end();
	};
}
/**
* Bring the right daemon up: spawn one when the port is idle, reuse a matching
* one, and retire a stale one left behind by an older install.
*
* The stale case is why this exists. The daemon is detached and outlives
* `dsh web`, so after an upgrade the previous build is still listening and this
* process holds no handle to it — it can only be retired by asking it to stop.
*/
async function ensureDaemon(log) {
	const status = await probeStatus();
	if (!status.running) {
		startDaemon(log);
		return;
	}
	const bin = resolveBinary();
	const local = bin === void 0 ? void 0 : localBuildHash(bin);
	const { restart, reason } = restartDecision(status.build, local);
	if (!restart) {
		if (reason === "unknown-running") log?.warn("chrome-daemon is running but reports no build id (older than this plugin); reusing it. To adopt the shipped binary, stop it once: kill the chrome-daemon process.");
		else if (reason === "unknown-local") log?.warn("cannot hash the local chrome-daemon binary; reusing the running one");
		else log?.info("chrome-daemon already running with a matching build; reusing it");
		return;
	}
	const short = (h) => h?.slice(0, 12) ?? "unknown";
	log?.info(`chrome-daemon build changed (running ${short(status.build)} \u2192 shipped ${short(local)}); restarting`);
	if (!await requestShutdown()) {
		log?.warn("the running chrome-daemon refused the shutdown request; keeping it. Stop it manually to pick up the new build.");
		return;
	}
	if (!await waitForPortFree()) log?.error(`port ${DAEMON_PORT} still busy after shutdown; starting the new daemon anyway`);
	startDaemon(log);
}
/**
* Spawn the daemon, mount the status proxy, and load the in-box MCP client.
* @param ctx - plugin context carrying the webServer service.
*/
function apply(ctx) {
	const log = ctx.logger;
	ensureDaemon(log);
	installNativeHost({ log });
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: STATUS_PATH,
		handler: createStatusProxyHandler()
	}));
	ctx.plugin(McpClient, bridgeConfig());
}
//#endregion
export { DAEMON_PORT, apply, bridgeConfig, inject, localBuildHash, name, openDaemonLog, parseClientFrame, restartDecision };
