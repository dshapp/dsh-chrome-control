import { createRequire } from "node:module";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { WebSocketServer } from "ws";
import { Worker } from "node:worker_threads";
//#region src/hub.ts
/** A dispatch failure carrying a message written for the model. */
var DispatchError = class extends Error {
	kind;
	name = "DispatchError";
	constructor(kind, message) {
		super(message);
		this.kind = kind;
	}
};
/** Messages naming the concrete recovery step, verbatim from the Rust daemon. */
const FAILURE_MESSAGES = {
	"not-connected": "No Chrome extension is attached. Ask the user to open Chrome, load the DSH Chrome Bridge extension at chrome://extensions (Developer mode -> Load unpacked), and make sure its popup toggle is enabled.",
	timeout: "The Chrome extension did not answer in time. The page may be busy or the tab may have been closed; retry with a narrower selector or a fresh navigate.",
	disconnected: "The Chrome extension disconnected while this call was running. Ask the user to check that Chrome is still open, then retry."
};
function failure(kind) {
	return new DispatchError(kind, FAILURE_MESSAGES[kind]);
}
/** Routes tool calls to the one live extension socket and answers back. */
var Hub = class {
	timeoutMs;
	outbound;
	waiters = /* @__PURE__ */ new Map();
	state = {
		connected: false,
		version: ""
	};
	nextId = 1;
	/**
	* @param timeoutMs - how long one dispatched call may wait for its answer.
	*/
	constructor(timeoutMs) {
		this.timeoutMs = timeoutMs;
	}
	/** Snapshot of the attached extension, for `/chrome/status`. */
	extensionState() {
		return { ...this.state };
	}
	/** Attach a new socket, replacing and failing over any previous one. */
	attach(outbound) {
		const previous = this.outbound;
		this.outbound = outbound;
		if (previous !== void 0) this.failAll(failure("disconnected"));
		this.state.connected = true;
	}
	/** Record the extension's version from its `hello` frame. */
	recordHello(version) {
		this.state = {
			connected: true,
			version
		};
	}
	/**
	* Detach `outbound`'s socket if it is still the live one, failing every call
	* that was waiting on it. A stale socket's detach leaves the live one alone.
	*/
	detach(outbound) {
		if (this.outbound !== outbound) return;
		this.outbound = void 0;
		this.state = {
			connected: false,
			version: ""
		};
		this.failAll(failure("disconnected"));
	}
	/** Deliver an answer to whoever is waiting for `requestId`. */
	resolve(requestId, answer) {
		const waiter = this.waiters.get(requestId);
		if (waiter === void 0) return;
		this.waiters.delete(requestId);
		waiter.settle(answer);
	}
	/**
	* Send one tool call to the extension and await its answer.
	* @param name - raw tool name the extension implements.
	* @param args - the call's JSON arguments.
	* @returns the extension's data answer.
	* @throws DispatchError naming the failure and its recovery step.
	*/
	async dispatch(name, args) {
		const outbound = this.outbound;
		if (outbound === void 0) throw failure("not-connected");
		const requestId = `r${this.nextId++}`;
		const answer = new Promise((settle) => {
			this.waiters.set(requestId, { settle });
		});
		if (!outbound({
			type: "tool_call",
			requestId,
			payload: {
				name,
				args
			}
		})) {
			this.waiters.delete(requestId);
			throw failure("not-connected");
		}
		const timer = setTimeout(() => {
			this.resolve(requestId, failure("timeout"));
		}, this.timeoutMs);
		try {
			const settled = await answer;
			if (settled instanceof DispatchError) throw settled;
			return settled;
		} finally {
			clearTimeout(timer);
		}
	}
	/** Ask the live socket to send a liveness probe. */
	ping() {
		this.outbound?.({ type: "ping" });
	}
	failAll(error) {
		const pending = [...this.waiters.values()];
		this.waiters.clear();
		for (const waiter of pending) waiter.settle(error);
	}
};
//#endregion
//#region src/tools-catalog.ts
/**
* Shared `session` property description: the single most load-bearing
* argument, because it is what groups a task's tabs together.
*/
const SESSION_DESC = "Task-scoped session name. One task = one session = one Chrome tab group. Pick a name at the task's start and reuse it for every call in that task.";
function sessionOnly() {
	return {
		type: "object",
		properties: { session: {
			type: "string",
			description: SESSION_DESC
		} },
		required: ["session"],
		additionalProperties: false
	};
}
function withSession(props, required) {
	return {
		type: "object",
		properties: {
			...props,
			session: {
				type: "string",
				description: SESSION_DESC
			}
		},
		required: [...required, "session"],
		additionalProperties: false
	};
}
/** Every tool the server advertises, in presentation order. */
const TOOLS = [
	{
		name: "navigate",
		description: "Open a URL in the user's real Chrome. The first call in a session creates the session's tab group.",
		inputSchema: withSession({
			url: {
				type: "string",
				description: "Any absolute URL the browser can open — http(s), file:, about:, data:, or an internal scheme like chrome:. Privileged pages (chrome:// and friends) open as real tabs, but page-reading tools cannot attach to them."
			},
			newTab: {
				type: "boolean",
				description: "Open a new tab instead of reusing the session's current tab. Use true when pages must coexist."
			},
			group_title: {
				type: "string",
				description: "Human-readable label for this task's tab group; set it on the first navigate, in the user's language."
			}
		}, ["url"])
	},
	{
		name: "find_tab",
		description: "Re-select a tab as the session's current tab. Pass active:true to borrow the tab the user is currently viewing.",
		inputSchema: withSession({
			url: {
				type: "string",
				description: "Full URL of the tab to select; prefer the exact URL over a bare domain."
			},
			active: {
				type: "boolean",
				description: "Borrow the tab the user is currently viewing instead of searching this session's own tabs."
			}
		}, [])
	},
	{
		name: "list_tabs",
		description: "List every tab in this session's tab group, with ids, URLs, titles, group label, and current:true on the tab the page tools act on. Use find_tab to switch the current tab.",
		inputSchema: sessionOnly()
	},
	{
		name: "close_tab",
		description: "Close the session's current tab.",
		inputSchema: sessionOnly()
	},
	{
		name: "close_session",
		description: "Close every tab in this session's tab group. Call only when the user explicitly asks.",
		inputSchema: sessionOnly()
	},
	{
		name: "snapshot",
		description: "Read the current page as an indented accessibility outline with @e refs, one element per line. Use it to locate elements for click/fill. Defaults to interactive elements plus headings and table cells; pass mode:\"full\" for every node or mode:\"text\" for prose. To read an article, prefer get_text.",
		inputSchema: withSession({
			mode: {
				type: "string",
				enum: [
					"interactive",
					"full",
					"text"
				],
				description: "interactive (default) keeps controls plus headings/cells/images; full keeps every node; text keeps prose and drops refs."
			},
			maxDepth: {
				type: "integer",
				minimum: 0,
				description: "Drop elements nested deeper than this. Omit for no limit."
			},
			diff: {
				type: "boolean",
				description: "Return only what changed since this tab's previous snapshot: [+] added, [~] changed, and a trailing \"# removed:\" line. Unchanged nodes are omitted; the first diff on a tab has no baseline and returns the full tree marked [+]. Refs for the whole current page are still published, so every @e stays usable."
			},
			selector: {
				type: "string",
				description: "Optional @e ref or CSS selector of a container: the outline covers only its subtree. Use it to narrow a huge page to the region you care about. Note: the @e ref table is rebuilt from this subtree, so refs outside it go stale."
			}
		}, [])
	},
	{
		name: "click",
		description: "Click an element with a full synthetic pointer stroke (pointerdown through click). Prefer an @e ref from snapshot over a hand-written CSS selector. If a widget ignores the synthetic stroke, retry with trusted:true for real browser input.",
		inputSchema: withSession({
			selector: {
				type: "string",
				description: "An @e ref from snapshot (preferred) or a CSS selector."
			},
			trusted: {
				type: "boolean",
				description: "Dispatch real (trusted) input at the element's center instead of synthetic events. Works on widgets that check isTrusted or listen outside the DOM event path; costs a tab activation."
			}
		}, ["selector"])
	},
	{
		name: "fill",
		description: "Set the value of an input, textarea, or contenteditable rich editor. Clear-and-insert: existing content is replaced. The result echoes the value read back with verified:true/false, so a framework that rejected or reformatted the text is visible immediately. A readonly dropdown input is refused with a pointer to select.",
		inputSchema: withSession({
			selector: {
				type: "string",
				description: "An @e ref from snapshot (preferred) or a CSS selector."
			},
			value: {
				type: "string",
				description: "Text to insert, replacing any existing content."
			}
		}, ["selector", "value"])
	},
	{
		name: "upload",
		description: "Set local file paths on a page file-upload control through Chrome. The selector may be the <input type=\"file\"> itself or its visible trigger; standard label/ARIA/container relationships are resolved automatically. Prefer an @e ref from snapshot.",
		inputSchema: withSession({
			selector: {
				type: "string",
				description: "An @e ref or CSS selector for a file input or its visible upload trigger."
			},
			paths: {
				type: "array",
				minItems: 1,
				items: { type: "string" },
				description: "Local file paths visible to Chrome. Pass multiple paths only when the input has the multiple attribute."
			}
		}, ["selector", "paths"])
	},
	{
		name: "evaluate",
		description: "Run JavaScript in the page and return its JSON-serializable result. Supports async/await. Wrap declarations in an IIFE to avoid redeclaration errors across calls.",
		inputSchema: withSession({ code: {
			type: "string",
			description: "JavaScript expression or statements to evaluate in the page."
		} }, ["code"])
	},
	{
		name: "screenshot",
		description: "Capture the visible viewport, or one element, as an image the model can see directly.",
		inputSchema: withSession({
			format: {
				type: "string",
				enum: ["png", "jpeg"],
				description: "Image format; defaults to png."
			},
			quality: {
				type: "integer",
				minimum: 0,
				maximum: 100,
				description: "JPEG quality 0-100; ignored for png."
			},
			selector: {
				type: "string",
				description: "Optional @e ref or CSS selector to capture just that element."
			}
		}, [])
	},
	{
		name: "save_as_pdf",
		description: "Render the current page to a PDF file on disk and return its path.",
		inputSchema: withSession({
			paper_format: {
				type: "string",
				enum: [
					"letter",
					"a4",
					"legal",
					"a3",
					"tabloid"
				],
				description: "Paper size; defaults to letter."
			},
			landscape: {
				type: "boolean",
				description: "Landscape orientation; defaults to false."
			},
			scale: {
				type: "number",
				minimum: .1,
				maximum: 2,
				description: "Render scale, 0.1-2.0; defaults to 1.0."
			},
			print_background: {
				type: "boolean",
				description: "Keep background colors; defaults to true."
			},
			path: {
				type: "string",
				description: "Optional output path; parent directories are created and an existing file is overwritten."
			}
		}, [])
	},
	{
		name: "mouse_click",
		description: "Click with a real (trusted) mouse event, at an element's center (selector) or at viewport coordinates. Use when a page ignores synthetic clicks because it checks event.isTrusted. Pass either selector, or both x and y. Activates the tab.",
		inputSchema: withSession({
			selector: {
				type: "string",
				description: "An @e ref from snapshot (preferred) or a CSS selector; it is scrolled into view and its center is clicked."
			},
			x: {
				type: "number",
				description: "Viewport x coordinate in CSS pixels; requires y and no selector."
			},
			y: {
				type: "number",
				description: "Viewport y coordinate in CSS pixels; requires x and no selector."
			},
			button: {
				type: "string",
				enum: [
					"left",
					"middle",
					"right"
				],
				description: "Mouse button; defaults to left."
			},
			clickCount: {
				type: "integer",
				minimum: 1,
				maximum: 3,
				description: "Click count; 2 for a double click."
			}
		}, [])
	},
	{
		name: "key_type",
		description: "Type text into the focused element with real (trusted) key events, character by character.",
		inputSchema: withSession({ text: {
			type: "string",
			description: "Text to type into the currently focused element."
		} }, ["text"])
	},
	{
		name: "send_keys",
		description: "Press one key or chord with real (trusted) key events, e.g. Enter, Escape, Tab, or Control+A. Use this to submit a form when clicking a button is not possible.",
		inputSchema: withSession({ keys: {
			type: "string",
			description: "A key name or chord such as \"Enter\", \"Escape\", or \"Control+A\"."
		} }, ["keys"])
	},
	{
		name: "hover",
		description: "Move the real mouse pointer over an element or viewport point, firing trusted mouseover/mouseenter. Use for menus and tooltips that only appear on hover. Pass either selector, or both x and y — not both forms. Activates the tab, because trusted input only reaches the focused tab.",
		inputSchema: withSession({
			selector: {
				type: "string",
				description: "An @e ref from snapshot (preferred) or a CSS selector; its center is used."
			},
			x: {
				type: "number",
				description: "Viewport x coordinate in CSS pixels; requires y and no selector."
			},
			y: {
				type: "number",
				description: "Viewport y coordinate in CSS pixels; requires x and no selector."
			}
		}, [])
	},
	{
		name: "focus",
		description: "Give an element keyboard focus without clicking it. Follow with key_type or send_keys to type into it.",
		inputSchema: withSession({ selector: {
			type: "string",
			description: "An @e ref from snapshot (preferred) or a CSS selector."
		} }, ["selector"])
	},
	{
		name: "select",
		description: "Choose an option in a dropdown: a native <select>, or any custom control following the ARIA combobox pattern (role=\"combobox\" or aria-haspopup) — it is opened with trusted input, the visible [role=option] items are matched by value, exact text, then substring, and the match is clicked. Use this instead of fill, which cannot drive a dropdown. A control that ignores ARIA gets an error naming the fallback (click with trusted:true). Custom dropdowns activate the tab.",
		inputSchema: withSession({
			selector: {
				type: "string",
				description: "An @e ref or CSS selector for the <select> element or the ARIA combobox control."
			},
			value: {
				type: "string",
				description: "Option value, or its visible text."
			}
		}, ["selector", "value"])
	},
	{
		name: "scroll",
		description: "Scroll the page, or one scrollable element when selector is given. Give either direction (with optional pixels) or an explicit deltaX/deltaY. Defaults to one viewport-height page down. Reports whether the position actually moved, so you can tell when you have hit the end.",
		inputSchema: withSession({
			selector: {
				type: "string",
				description: "Optional @e ref or CSS selector of the element to scroll; omit to scroll the page."
			},
			direction: {
				type: "string",
				enum: [
					"up",
					"down",
					"left",
					"right"
				],
				description: "Scroll direction; defaults to down."
			},
			pixels: {
				type: "number",
				description: "Distance in CSS pixels for direction; defaults to 80% of the viewport."
			},
			deltaX: {
				type: "number",
				description: "Explicit horizontal delta, wheel semantics; overrides direction."
			},
			deltaY: {
				type: "number",
				description: "Explicit vertical delta, positive scrolls down; overrides direction."
			}
		}, [])
	},
	{
		name: "scroll_into_view",
		description: "Scroll an element into the viewport and return its geometry. Use before mouse_click or hover, whose coordinates are only valid for a visible element.",
		inputSchema: withSession({ selector: {
			type: "string",
			description: "An @e ref from snapshot (preferred) or a CSS selector."
		} }, ["selector"])
	},
	{
		name: "find",
		description: "Search the page for the interactive element best matching a plain-language query, and return reusable @e refs with a CSS hint. Cheaper than snapshot when you need one control on a large page; use snapshot when you need the whole structure. Refs are appended, so refs from an earlier snapshot stay valid.",
		inputSchema: withSession({ query: {
			type: "string",
			description: "What to look for, as the user would name it, e.g. \"sign in button\" or \"search box\"."
		} }, ["query"])
	},
	{
		name: "wait",
		description: "Sleep for a fixed number of milliseconds, capped at 3000. Prefer wait_for_selector, which waits on a condition; navigate already waits for load. Use this only when there is no element to wait for, such as a settling animation.",
		inputSchema: withSession({ ms: {
			type: "integer",
			minimum: 0,
			maximum: 3e3,
			description: "Milliseconds to wait; values above 3000 are clamped."
		} }, ["ms"])
	},
	{
		name: "wait_for_selector",
		description: "Poll until an element becomes visible, or disappears when state is hidden. Returns as soon as the condition holds; on timeout the error says how long it waited.",
		inputSchema: withSession({
			selector: {
				type: "string",
				description: "An @e ref or CSS selector to wait for."
			},
			state: {
				type: "string",
				enum: ["visible", "hidden"],
				description: "Condition to wait for; defaults to visible."
			},
			timeout: {
				type: "integer",
				minimum: 0,
				maximum: 3e4,
				description: "Milliseconds before giving up; defaults to 5000, capped at 30000."
			}
		}, ["selector"])
	},
	{
		name: "network",
		description: "List the tab's recent network requests with method, URL, status, and a requestId for network_detail. Only requests made after the tools attached to this tab are recorded.",
		inputSchema: withSession({
			filter: {
				type: "string",
				description: "Keep only requests whose URL contains this substring."
			},
			method: {
				type: "string",
				description: "Keep only this HTTP method, e.g. POST."
			},
			status: {
				type: "integer",
				description: "Keep only this HTTP status code, e.g. 404."
			},
			limit: {
				type: "integer",
				minimum: 1,
				maximum: 200,
				description: "Most recent entries to return; defaults to 50."
			}
		}, [])
	},
	{
		name: "network_detail",
		description: "Full record of one request from network, including request and response headers. Pass body:true to also fetch the response body, which is truncated when large.",
		inputSchema: withSession({
			requestId: {
				type: "string",
				description: "The requestId reported by network."
			},
			body: {
				type: "boolean",
				description: "Also fetch the response body; defaults to false."
			}
		}, ["requestId"])
	},
	{
		name: "dialog",
		description: "Answer a native alert, confirm, beforeunload, or prompt dialog. Call this only once a dialog is actually open: while one is, it blocks every other tool on that tab, so an unanswered dialog is the usual cause of a hung page.",
		inputSchema: withSession({
			action: {
				type: "string",
				enum: ["accept", "dismiss"],
				description: "accept presses OK; dismiss presses Cancel."
			},
			text: {
				type: "string",
				description: "Text to enter, for a prompt dialog being accepted."
			}
		}, ["action"])
	},
	{
		name: "get_text",
		description: "Extract the page's readable text. By default strips navigation, headers, footers, sidebars, and scripts to leave the article; pass raw:true for the whole body's innerText. Prefer this over snapshot when you want to read prose rather than locate controls.",
		inputSchema: withSession({
			raw: {
				type: "boolean",
				description: "Return document.body.innerText verbatim, skipping noise removal."
			},
			maxChars: {
				type: "integer",
				minimum: 1,
				description: "Truncate to this many characters; defaults to 20000."
			}
		}, [])
	}
];
/** Look up whether a raw tool name is advertised. */
function isKnown(name) {
	return TOOLS.some((tool) => tool.name === name);
}
/** Render the catalog as the `tools` array of an MCP `tools/list` result. */
function listPayload() {
	return TOOLS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema
	}));
}
//#endregion
//#region src/mcp.ts
/**
* The MCP layer: JSON-RPC 2.0 over Streamable HTTP — a port of the Rust
* daemon's `mcp.rs`.
*
* Only the subset the harness client actually exercises is implemented:
* `initialize`, `notifications/initialized`, `ping`, `tools/list`, and
* `tools/call`. A tool failure is reported as a *successful* JSON-RPC result
* carrying `isError: true`, per the MCP spec — a JSON-RPC error is reserved
* for protocol-level faults such as an unknown method.
*
* @module dsh-chrome/mcp
*/
/** Protocol version this server implements. */
const PROTOCOL_VERSION = "2025-06-18";
/**
* Server name reported in `initialize` and `/chrome/status`; also how any
* probe recognizes that the endpoint is ours rather than another vendor's.
*/
const SERVER_NAME = "dsh-chrome";
/** Standard JSON-RPC error codes used here. */
const CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602
};
function result(id, value) {
	return {
		jsonrpc: "2.0",
		id,
		result: value
	};
}
function rpcError(id, code, message) {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message
		}
	};
}
/** A JSON-RPC parse failure rendered as the spec's -32700 response. */
function parseFailure(message) {
	return rpcError(null, CODES.PARSE_ERROR, `parse error: ${message}`);
}
/**
* Hard-coded guards against a single oversized extension answer stalling the
* `dsh web` event loop. The classic offender is a `snapshot` mode:"full"
* outline or a `get_text` raw dump: deeply-nested or multi-MB objects that
* keep V8's `JsonStringifier::Serialize_<true>` recursing on the main thread
* for seconds, during which Chrome reconnects pile up into a SYN storm.
*
* Three layers, cheap to expensive:
*   1. `capArray` slices a top-level array past {@link MAX_ARRAY_ELEMENTS} so
*      the serialized output is still legal JSON, just shorter.
*   2. Past the {@link WORKER_OFFLOAD} heuristics, `JSON.stringify` runs on a
*      persistent worker thread so the main loop keeps draining I/O.
*   3. The final text is clipped to {@link MAX_TEXT_BYTES} with a tail marker.
*/
const MAX_TEXT_BYTES = 262144;
const MAX_ARRAY_ELEMENTS = 4e3;
const TRUNCATED_TAIL = "\n…[truncated by dsh-chrome-control]";
/** Slice a top-level array past the cap, leaving objects and primitives alone. */
function capArray(value) {
	if (Array.isArray(value) && value.length > MAX_ARRAY_ELEMENTS) return [...value.slice(0, MAX_ARRAY_ELEMENTS), `…[truncated: ${value.length - MAX_ARRAY_ELEMENTS} more elements omitted by dsh-chrome-control]`];
	return value;
}
/**
* Heuristic: large enough that a synchronous stringify on the main loop is a
* risk. Strings are excluded — they are raw text (never quoted by `toolContent`)
* and a long string is a cheap linear copy, not a recursive stringify.
*/
function shouldOffload(value) {
	if (Array.isArray(value)) return value.length > 256;
	if (value && typeof value === "object") {
		let count = 0;
		for (const _ in value) if (++count > 64) return true;
		return false;
	}
	return false;
}
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', msg => {
  try {
    parentPort.postMessage({ id: msg.id, text: JSON.stringify(msg.value) })
  } catch (error) {
    parentPort.postMessage({ id: msg.id, error: String(error) })
  }
})
`;
let worker;
let workerPending;
let nextWorkerId = 1;
/** Lazily start the stringify worker; returns undefined if worker_threads is unavailable. */
function getWorker() {
	if (worker !== void 0) return worker;
	try {
		const w = new Worker(WORKER_SOURCE, { eval: true });
		const pending = /* @__PURE__ */ new Map();
		workerPending = pending;
		w.on("message", (msg) => {
			const entry = pending.get(msg.id);
			if (entry === void 0) return;
			pending.delete(msg.id);
			if (msg.error !== void 0) entry.reject(new Error(msg.error));
			else entry.resolve(msg.text);
		});
		w.on("error", (error) => {
			for (const entry of pending.values()) entry.reject(error);
			pending.clear();
		});
		w.on("exit", () => {
			for (const entry of pending.values()) entry.reject(/* @__PURE__ */ new Error("serialize worker exited"));
			pending.clear();
			if (worker === w) {
				worker = void 0;
				workerPending = void 0;
			}
		});
		worker = w;
		return w;
	} catch {
		return;
	}
}
function workerStringify(value) {
	const w = getWorker();
	if (w === void 0 || workerPending === void 0) return Promise.resolve(JSON.stringify(value) ?? "null");
	const id = nextWorkerId++;
	const pending = workerPending;
	return new Promise((resolve, reject) => {
		pending.set(id, {
			resolve,
			reject
		});
		w.postMessage({
			id,
			value
		});
	});
}
/** Release the stringify worker; safe to call from plugin unload. */
function disposeSerializeWorker() {
	if (worker !== void 0) {
		worker.terminate().catch(() => {});
		worker = void 0;
		workerPending = void 0;
	}
}
/**
* A tool outcome rendered as MCP content. Async because a large result is
* stringified off the main thread; callers should `await` it.
*/
async function toolContent(value) {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const data = value["__image_base64"];
		const mime = value["__image_mime_type"];
		if (typeof data === "string" && typeof mime === "string") return {
			content: [{
				type: "image",
				data,
				mimeType: mime
			}],
			isError: false
		};
	}
	const capped = capArray(value);
	const text = shouldOffload(capped) ? await workerStringify(capped) : typeof capped === "string" ? capped : JSON.stringify(capped) ?? "null";
	if (text.length > MAX_TEXT_BYTES) return {
		content: [{
			type: "text",
			text: text.slice(0, MAX_TEXT_BYTES) + TRUNCATED_TAIL
		}],
		isError: false
	};
	return {
		content: [{
			type: "text",
			text
		}],
		isError: false
	};
}
function toolFailure(message) {
	return {
		content: [{
			type: "text",
			text: message
		}],
		isError: true
	};
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Handle one parsed JSON-RPC request body. Returns `undefined` for
* notifications, which get an HTTP 202 with no body.
* @param raw - the parsed request body.
* @param hub - the extension hub tool calls dispatch through.
*/
async function handle(raw, hub) {
	if (!isRecord$1(raw)) return rpcError(null, CODES.INVALID_REQUEST, "request must be an object");
	const id = raw.id ?? null;
	if (raw.id === void 0 || raw.id === null) return void 0;
	if (raw.jsonrpc !== "2.0") return rpcError(id, CODES.INVALID_REQUEST, "jsonrpc must be \"2.0\"");
	const method = typeof raw.method === "string" ? raw.method : "";
	const params = isRecord$1(raw.params) ? raw.params : {};
	switch (method) {
		case "initialize": return result(id, {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tools: { listChanged: false } },
			serverInfo: {
				name: SERVER_NAME,
				version: serverVersion()
			}
		});
		case "ping": return result(id, {});
		case "tools/list": return result(id, { tools: listPayload() });
		case "tools/call": {
			const name = typeof params.name === "string" ? params.name : "";
			if (name === "") return rpcError(id, CODES.INVALID_PARAMS, "missing tool name");
			if (!isKnown(name)) return rpcError(id, CODES.INVALID_PARAMS, `unknown tool: ${name}`);
			const args = params.arguments ?? {};
			try {
				return result(id, await toolContent(await hub.dispatch(name, args)));
			} catch (failure) {
				return result(id, toolFailure(failure instanceof DispatchError ? failure.message : String(failure)));
			}
		}
		default: return rpcError(id, CODES.METHOD_NOT_FOUND, `unknown method: ${method}`);
	}
}
let cachedVersion;
/** This package's version, reported as the MCP server version. */
function serverVersion() {
	if (cachedVersion === void 0) try {
		const pkg = createRequire(import.meta.url)("../package.json");
		cachedVersion = typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		cachedVersion = "0.0.0";
	}
	return cachedVersion;
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
/** How long one tool call may wait for the extension. */
const TOOL_TIMEOUT_MS = 3e4;
/** Where the three routes live on the shared server. */
const MCP_PATH = "/chrome/mcp";
const WS_PATH = "/chrome/ws";
const STATUS_PATH = "/chrome/status";
/** Keepalive interval for a silent MV3 service worker. */
const PING_INTERVAL_MS = 3e4;
/**
* Hard cap on a single extension WebSocket frame. An oversized `tool_result`
* (a multi-MB `snapshot` full tree, a `get_text` raw dump) would otherwise be
* buffered and parsed on the main thread, stalling the event loop until Chrome
* reconnects pile up. `ws` closes the socket past this limit and the hub's
* existing disconnect path fails any in-flight calls.
*/
const WS_MAX_PAYLOAD = 8388608;
/**
* Only a browser extension page may open the control socket. Chrome sends
* `Origin: chrome-extension://<id>`; anything else — notably a web page that
* found the endpoint — is refused. A non-browser client (tests, curl) sends no
* Origin at all and is allowed.
*/
function originAllowed(origin) {
	if (origin === void 0) return true;
	return origin.startsWith("chrome-extension://");
}
/**
* The in-box MCP bridge's config, derived from the web server's actual port so
* the URL and the endpoint can never disagree.
*/
function bridgeConfig(port) {
	return {
		serverName: "chrome",
		transport: "streamable-http",
		url: `http://127.0.0.1:${port}${MCP_PATH}`,
		headers: {},
		toolCallTimeoutMs: 35e3,
		failOnStartupError: false
	};
}
/** Read one request body as UTF-8 text. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(text)
	});
	res.end(text);
}
/**
* MCP requests. A notification yields 202 with an empty body; everything else
* answers with `application/json`, which the Streamable HTTP client accepts.
* The client may try to open a server-to-client SSE stream with GET; this
* server never initiates messages, so 405 declines and the client proceeds.
*/
function createMcpHandler(hub) {
	return async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(await readBody(req));
		} catch (failure) {
			sendJson(res, 400, parseFailure(String(failure instanceof Error ? failure.message : failure)));
			return;
		}
		const response = await handle(parsed, hub);
		if (response === void 0) {
			res.writeHead(202);
			res.end();
			return;
		}
		sendJson(res, 200, response);
	};
}
/**
* Liveness and wiring probe: confirms the endpoint is ours and reports whether
* the extension is attached. The shape matches the old daemon's `/status`.
*/
function createStatusHandler(hub, startedAt) {
	return (_req, res) => {
		const extension = hub.extensionState();
		sendJson(res, 200, {
			name: SERVER_NAME,
			version: serverVersion(),
			protocolVersion: PROTOCOL_VERSION,
			running: true,
			extension_connected: extension.connected,
			extension_version: extension.version,
			uptime_seconds: Math.floor((Date.now() - startedAt) / 1e3)
		});
	};
}
/** Pump one extension socket until it closes. */
function serveExtension(socket, hub, log) {
	const outbound = (frame) => {
		if (socket.readyState !== socket.OPEN) return false;
		try {
			socket.send(JSON.stringify(frame));
			return true;
		} catch {
			return false;
		}
	};
	hub.attach(outbound);
	log?.info("chrome extension connected");
	const pinger = setInterval(() => hub.ping(), PING_INTERVAL_MS);
	socket.on("message", (data) => {
		const frame = parseClientFrame(String(data));
		if (frame === void 0) {
			log?.warn("invalid frame from extension");
			return;
		}
		switch (frame.type) {
			case "hello":
				log?.info(`hello from extension ${frame.extensionVersion}`);
				hub.recordHello(frame.extensionVersion);
				outbound({ type: "hello_ack" });
				break;
			case "pong": break;
			case "tool_result": hub.resolve(frame.responseToRequestId, frame.error !== void 0 ? new DispatchError("tool", frame.error) : frame.data ?? null);
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => {
		clearInterval(pinger);
		hub.detach(outbound);
		log?.info("chrome extension disconnected");
	});
}
/**
* Mount the bridge on the shared web server and load the in-box MCP client
* against it.
* @param ctx - plugin context carrying the webServer service.
*/
function apply(ctx) {
	const hub = new Hub(TOOL_TIMEOUT_MS);
	const startedAt = Date.now();
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: WS_MAX_PAYLOAD
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: MCP_PATH,
		handler: createMcpHandler(hub)
	}));
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: STATUS_PATH,
		handler: createStatusHandler(hub, startedAt)
	}));
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: WS_PATH,
		handler: (req, socket, head) => {
			if (!originAllowed(typeof req.headers.origin === "string" ? req.headers.origin : void 0)) {
				ctx.logger?.warn("rejected a websocket upgrade from a disallowed origin");
				socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => serveExtension(ws, hub, ctx.logger));
		}
	}));
	ctx.effect(() => () => {
		for (const client of wss.clients) client.terminate();
		wss.close();
		disposeSerializeWorker();
	});
	ctx.plugin(McpClient, bridgeConfig(ctx.webServer.port));
}
//#endregion
export { MCP_PATH, STATUS_PATH, TOOL_TIMEOUT_MS, WS_PATH, apply, bridgeConfig, inject, name, originAllowed };
