import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
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
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: STATUS_PATH,
		handler: createStatusProxyHandler()
	}));
	ctx.plugin(McpClient, bridgeConfig());
}
//#endregion
export { DAEMON_PORT, apply, bridgeConfig, inject, localBuildHash, name, parseClientFrame, restartDecision };
