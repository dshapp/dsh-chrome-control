import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { homedir } from "node:os";
//#region src/native-host.ts
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
* Lay down the host and register it. Idempotent and synchronous (a handful of
* small files); never throws.
*/
function installNativeHost(options = {}) {
	const platform = options.platform ?? process.platform;
	const result = {
		installed: false,
		browsers: [],
		changed: []
	};
	if (platform !== "darwin" && platform !== "linux") {
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
		const launcher = path.join(dir, "dsh-native-host");
		writeIfChanged(hostFile, readFileSync(source, "utf8"), 420, result.changed);
		writeIfChanged(launcher, launcherScript(node, hostFile, dshHome), 493, result.changed);
		writeIfChanged(path.join(dir, "config.json"), JSON.stringify({
			node,
			dshEntry
		}, null, 2) + "\n", 420, result.changed);
		const manifest = hostManifest(launcher);
		for (const browser of browserDirs(platform, home)) {
			if (!existsSync(browser)) continue;
			writeIfChanged(path.join(browser, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`), manifest, 420, result.changed);
			result.browsers.push(browser);
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
		path.resolve(process.env.HOME ?? "", ".dsh-chrome", "bin", EXE)
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
/**
* Spawn the detached daemon, wiring its stdio into the harness logger for as
* long as this process lives. The child handle is intentionally not returned:
* nothing here owns the daemon's lifetime.
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
	const child = spawn(bin, [
		"--port",
		String(DAEMON_PORT),
		"--host",
		"127.0.0.1"
	], {
		detached: true,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	child.stdout.on("data", (d) => log?.info(`[chrome-daemon] ${d.toString().trimEnd()}`));
	child.stderr.on("data", (d) => log?.warn(`[chrome-daemon] ${d.toString().trimEnd()}`));
	child.on("exit", (code) => {
		log?.info(`chrome-daemon exited code=${code}`);
	});
	log?.info(`chrome-daemon spawned: ${bin} (pid ${child.pid})`);
	child.unref();
	for (const stream of [child.stdout, child.stderr]) stream.unref?.();
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
export { DAEMON_PORT, apply, bridgeConfig, inject, localBuildHash, name, parseClientFrame, restartDecision };
