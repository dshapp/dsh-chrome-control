import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
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
/** Where the three routes live on the daemon. */
const MCP_PATH = "/chrome/mcp";
const STATUS_PATH = "/chrome/status";
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
	const here = path.dirname(new URL(".", import.meta.url).pathname);
	return [
		path.resolve(here, "..", "binaries", PLATFORM_ARCH, EXE),
		path.resolve(here, "..", "daemon", "target", "release", EXE),
		path.resolve(process.env.HOME ?? "", ".dsh-chrome", "bin", EXE)
	].find((p) => existsSync(p));
}
/** Probe whether a daemon is already listening (dev-friendly: reuse it). */
function probeRunning() {
	return new Promise((resolve) => {
		const req = http.get({
			host: "127.0.0.1",
			port: DAEMON_PORT,
			path: STATUS_PATH,
			timeout: 800
		}, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode === 200));
		});
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
	});
}
/** Spawn the daemon child, wiring its stdio into the harness logger. */
function startDaemon(log) {
	const bin = resolveBinary();
	if (bin === void 0) {
		log?.error("chrome-daemon binary not found; the agent will not see mcp__chrome__* tools");
		return;
	}
	const child = spawn(bin, [
		"--port",
		String(DAEMON_PORT),
		"--host",
		"127.0.0.1"
	], { stdio: [
		"ignore",
		"pipe",
		"pipe"
	] });
	child.stdout.on("data", (d) => log?.info(`[chrome-daemon] ${d.toString().trimEnd()}`));
	child.stderr.on("data", (d) => log?.warn(`[chrome-daemon] ${d.toString().trimEnd()}`));
	child.on("exit", (code) => {
		log?.info(`chrome-daemon exited code=${code}`);
	});
	log?.info(`chrome-daemon spawned: ${bin} (pid ${child.pid})`);
	return child;
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
* Spawn the daemon, mount the status proxy, and load the in-box MCP client.
* @param ctx - plugin context carrying the webServer service.
*/
function apply(ctx) {
	const log = ctx.logger;
	let child;
	(async () => {
		if (!await probeRunning()) child = startDaemon(log);
		else log?.info("chrome-daemon already running; reusing it");
	})();
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: STATUS_PATH,
		handler: createStatusProxyHandler()
	}));
	ctx.effect(() => () => {
		if (child !== void 0 && !child.killed) child.kill("SIGTERM");
	});
	ctx.plugin(McpClient, bridgeConfig());
}
//#endregion
export { DAEMON_PORT, apply, bridgeConfig, inject, name, parseClientFrame };
