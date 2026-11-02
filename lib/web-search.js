import { t as DAEMON_MCP_URL } from "./daemon-CesHvm8J.js";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
//#region src/web-search.ts
/**
* The chrome web-search plugin: registers the `chrome-browser` search provider
* on the DSH web service (`ctx.web`). The provider answers the built-in
* `web_search` tool by running each query on a search engine's result page in
* the user's real Chrome, through the chrome-daemon's MCP endpoint, instead of
* calling a search API.
*
* The provider is used only while `web.searchProvider` is `chrome-browser`;
* the shipped composition selects another provider, so the feature is off until
* that selection changes. `engine` is a live setting: a change applies to the
* next search without a reload.
*
* @module dsh-chrome/web-search
*/
/** Stable Cordis plugin name. */
const name = "chrome-web-search";
/** The web service this provider registers into. */
const inject = ["web"];
/** Provider id; `web.searchProvider: chrome-browser` turns the feature on. */
const CHROME_SEARCH_PROVIDER_ID = "chrome-browser";
/** Search engines whose result pages the provider can read. */
const ENGINES = [
	"google",
	"bing",
	"baidu",
	"sogou",
	"toutiao"
];
/** Result-page readers, keyed by engine. */
const ENGINE_SPECS = {
	google: {
		searchUrl: "https://www.google.com/search",
		queryParam: "q",
		item: "#search .MjjYud, #search div.g",
		title: "a:has(h3)",
		titleText: "h3",
		snippet: "[data-sncf], .VwiC3b, [style*=\"-webkit-line-clamp\"]"
	},
	bing: {
		searchUrl: "https://www.bing.com/search",
		queryParam: "q",
		item: "#b_results > li.b_algo",
		title: "h2 a",
		snippet: ".b_caption p, .b_lineclamp2, .b_lineclamp3, .b_algoSlug"
	},
	baidu: {
		searchUrl: "https://www.baidu.com/s",
		queryParam: "wd",
		item: "#content_left > .c-container, #content_left > .result, #content_left > .result-op",
		title: "h3 a",
		snippet: "[data-module=\"abstract\"], .c-abstract, [class*=\"content-right\"]",
		urlAttribute: "mu"
	},
	sogou: {
		searchUrl: "https://www.sogou.com/web",
		queryParam: "query",
		item: ".vrwrap, .rb",
		title: "h3 a",
		snippet: "[id^=\"cacheresult_summary\"], .space-txt, .str_info, .text-layout p",
		urlDataSelector: "[data-url]"
	},
	toutiao: {
		searchUrl: "https://so.toutiao.com/search",
		queryParam: "keyword",
		item: ".result-content",
		title: "a.l-card-title, .l-header a"
	}
};
const Config = z.object({
	engine: z.union(ENGINES).default("google").volatile().description("Search engine opened in Chrome for web_search while web.searchProvider is chrome-browser."),
	resultWaitMs: z.natural().min(1e3).default(1e4).description("Milliseconds to wait for a result page to render before reading it.")
});
/**
* Runs inside the result page (serialized with `toString()`, so it must not
* reference anything outside its own body). Waits up to `waitMs` for results
* or a CAPTCHA, then reads organic results with `spec`.
*/
async function extractResults(spec, waitMs) {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const isCaptcha = () => /captcha|antispider|\/sorry\/|wappass\.baidu/i.test(location.href) || document.querySelector("#captcha-form, #captcha_container, #b_captcha, iframe[src*=\"captcha\"]") !== null;
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (isCaptcha()) return {
			captcha: true,
			results: []
		};
		if (document.querySelector(spec.item) !== null) {
			await sleep(300);
			break;
		}
		if (Date.now() >= deadline) break;
		await sleep(200);
	}
	const unwrap = (raw) => {
		let current = raw;
		for (let depth = 0; depth < 3; depth++) {
			let url;
			try {
				url = new URL(current, location.href);
			} catch {
				return current;
			}
			const host = url.hostname;
			let next = null;
			if (/(^|\.)google\./.test(host) && url.pathname === "/url") next = url.searchParams.get("q") ?? url.searchParams.get("url");
			else if (/(^|\.)bing\.com$/.test(host) && url.pathname === "/ck/a") {
				const u = url.searchParams.get("u");
				if (u !== null && u.startsWith("a1")) try {
					next = atob(u.slice(2).replace(/-/g, "+").replace(/_/g, "/"));
				} catch {
					next = null;
				}
			} else if (host === "so.toutiao.com" && url.pathname === "/search/jump") next = url.searchParams.get("url");
			else if (host === "article.zlink.toutiao.com") next = url.searchParams.get("h5_url");
			if (next === null || next === "") return url.href;
			current = next;
		}
		return current;
	};
	const results = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of document.querySelectorAll(spec.item)) {
		const link = item.querySelector(spec.title);
		if (link === null) continue;
		const title = (spec.titleText === void 0 ? link : link.querySelector(spec.titleText) ?? link).innerText.trim();
		let url = unwrap(link.href);
		const attribute = spec.urlAttribute === void 0 ? null : item.getAttribute(spec.urlAttribute);
		const data = spec.urlDataSelector === void 0 ? void 0 : item.querySelector(spec.urlDataSelector)?.dataset.url;
		const direct = attribute ?? data;
		if (direct !== void 0 && direct !== null && /^https?:\/\//.test(direct)) url = direct;
		if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
		try {
			const target = new URL(url);
			if (target.hostname === location.hostname && target.pathname === location.pathname) continue;
		} catch {
			continue;
		}
		seen.add(url);
		let snippet = spec.snippet === void 0 ? "" : item.querySelector(spec.snippet)?.innerText.trim() ?? "";
		if (snippet === "") snippet = item.innerText.split("\n").map((line) => line.trim()).filter((line) => line !== title).reduce((longest, line) => line.length > longest.length ? line : longest, "");
		results.push({
			title,
			url,
			snippet
		});
	}
	return {
		captcha: false,
		results
	};
}
/**
* The page script for one engine.
* @param engine - the engine whose reader to serialize.
* @param waitMs - render wait passed to the reader.
* @returns JavaScript source for the daemon's `evaluate` tool.
*/
function extractionScript(engine, waitMs) {
	return `(${extractResults.toString()})(${JSON.stringify(ENGINE_SPECS[engine])}, ${waitMs})`;
}
/**
* The result page URL for one query.
* @param engine - the engine to search.
* @param query - the query text.
* @returns the absolute result page URL.
*/
function searchUrl(engine, query) {
	const spec = ENGINE_SPECS[engine];
	const url = new URL(spec.searchUrl);
	url.searchParams.set(spec.queryParam, query);
	return url.href;
}
/** A leading date the engines print before a snippet. */
const SNIPPET_DATE = /^(?:((?:[A-Z][a-z]{2} \d{1,2}, \d{4})|(?:\d+ (?:minutes?|hours?|days?|weeks?) ago))\s*[—·-]\s*|((?:\d{4}年\d{1,2}月\d{1,2}日)|(?:\d+\s*(?:分钟|小时|天|周)前))\s*[—·-]?\s*)/;
/** Absolute dates become `YYYY-MM-DD`; relative ones stay as printed. */
function normalizeDate(text) {
	const cjk = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(text);
	if (cjk !== null) return `${cjk[1]}-${cjk[2].padStart(2, "0")}-${cjk[3].padStart(2, "0")}`;
	const parsed = Date.parse(`${text} UTC`);
	return Number.isNaN(parsed) ? text : new Date(parsed).toISOString().slice(0, 10);
}
/**
* Normalize one extracted result into a web search source: whitespace runs
* (including line breaks) collapse to one space, a leading date becomes
* `publishedAt`, a trailing "Read more" is dropped, and empty optional fields
* are omitted.
* @param raw - one result read from the page.
* @returns the source.
*/
function mapResult(raw) {
	const title = raw.title.replace(/\s+/g, " ").trim();
	let snippet = raw.snippet.replace(/\s+/g, " ").replace(/\s*Read more$/, "").trim();
	let publishedAt;
	const date = SNIPPET_DATE.exec(snippet);
	if (date !== null) {
		snippet = snippet.slice(date[0].length);
		publishedAt = normalizeDate(date[1] ?? date[2]);
	}
	return {
		url: raw.url,
		...title.length > 0 ? { title } : {},
		...snippet.length > 0 ? { snippet } : {},
		...publishedAt !== void 0 ? { publishedAt } : {}
	};
}
/** True for a fetch / AbortSignal abort or timeout. */
function isAbortError(error) {
	return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
/** Minimal MCP client for the daemon's stateless JSON endpoint. */
var DaemonClient = class {
	url;
	initializing;
	nextId = 1;
	constructor(url) {
		this.url = url;
	}
	/**
	* Call one daemon tool and return its parsed JSON text payload.
	* @param tool - daemon tool name, e.g. `navigate`.
	* @param args - the tool arguments.
	* @param signal - cancellation for this call.
	* @returns the tool's text payload parsed as JSON, or the raw text.
	*/
	async callTool(tool, args, signal) {
		const sessionId = await this.initialize(signal);
		const { message } = await this.post({
			jsonrpc: "2.0",
			id: this.nextId++,
			method: "tools/call",
			params: {
				name: tool,
				arguments: args
			}
		}, sessionId, signal);
		if (message?.error !== void 0) {
			this.initializing = void 0;
			throw new WebError(`Chrome ${tool} failed: ${message.error.message}`, "WEB_PROVIDER_ERROR");
		}
		const text = (message?.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
		if (message?.result?.isError === true) throw new WebError(`Chrome ${tool} failed: ${text || "unknown error"}`, "WEB_PROVIDER_ERROR");
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	/** Run the MCP handshake once; a failed handshake is retried by the next call. */
	initialize(signal) {
		this.initializing ??= (async () => {
			const { sessionId } = await this.post({
				jsonrpc: "2.0",
				id: this.nextId++,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: {
						name: "dsh-chrome-web-search",
						version: "1"
					}
				}
			}, void 0, signal);
			await this.post({
				jsonrpc: "2.0",
				method: "notifications/initialized"
			}, sessionId, signal);
			return sessionId;
		})();
		this.initializing.catch(() => {
			this.initializing = void 0;
		});
		return this.initializing;
	}
	/** POST one JSON-RPC message; accepts a JSON or a single-event SSE body. */
	async post(body, sessionId, signal) {
		let response;
		let text;
		try {
			response = await fetch(this.url, {
				method: "POST",
				redirect: "error",
				headers: {
					"content-type": "application/json",
					"accept": "application/json, text/event-stream",
					...sessionId !== void 0 ? { "mcp-session-id": sessionId } : {}
				},
				body: JSON.stringify(body),
				...signal !== void 0 ? { signal } : {}
			});
			text = await response.text();
		} catch (error) {
			if (isAbortError(error)) throw new WebError("web search in Chrome was cancelled", "WEB_ABORTED", { cause: error });
			throw new WebError(`cannot reach chrome-daemon at ${this.url}: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (response.status === 404 && sessionId !== void 0) this.initializing = void 0;
		if (!response.ok) throw new WebError(`chrome-daemon answered HTTP ${response.status}`, "WEB_PROVIDER_ERROR");
		const nextSession = response.headers.get("mcp-session-id") ?? sessionId;
		if (text === "") return {
			sessionId: nextSession,
			message: void 0
		};
		const json = (response.headers.get("content-type") ?? "").includes("text/event-stream") ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).at(-1) ?? "" : text;
		try {
			return {
				sessionId: nextSession,
				message: JSON.parse(json)
			};
		} catch (error) {
			throw new WebError(`chrome-daemon returned an unparsable body: ${text.slice(0, 200)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
};
/** Errors from a page that navigated while the extractor was attaching or running. */
const TRANSIENT_PAGE_ERROR = /Debugger is not attached|Execution context was destroyed|Cannot find context|Inspected target navigated/i;
/** Extractor attempts per search, counting the first. */
const EVALUATE_ATTEMPTS = 3;
/**
* Search provider that opens one Chrome tab per query in its own tab-group
* session, reads the result page, and closes the session's tabs. A CAPTCHA
* leaves its tab open so the user can solve it.
*/
var ChromeSearchProvider = class {
	options;
	id = CHROME_SEARCH_PROVIDER_ID;
	constructor(options) {
		this.options = options;
	}
	available() {
		return true;
	}
	async search(request, signal) {
		const engine = this.options.engine.get();
		const session = `web-search-${randomUUID().slice(0, 8)}`;
		const { client } = this.options;
		let keepTab = false;
		try {
			await client.callTool("navigate", {
				session,
				url: searchUrl(engine, request.query),
				newTab: true,
				group_title: "web_search"
			}, signal);
			const page = (await this.evaluate(session, extractionScript(engine, this.options.resultWaitMs), signal))?.value;
			if (page === void 0 || !Array.isArray(page.results)) throw new WebError(`could not read the ${engine} result page`, "WEB_PROVIDER_ERROR");
			if (page.captcha) {
				keepTab = true;
				throw new WebError(`${engine} is showing a CAPTCHA in Chrome; the tab was left open. Solve it there, then search again.`, "WEB_SEARCH_CAPTCHA");
			}
			return {
				sources: page.results.map(mapResult),
				truncated: false
			};
		} finally {
			if (!keepTab) await this.close(session);
		}
	}
	/**
	* Run the extractor, retrying while the page is replacing itself: some result
	* pages navigate again right after load, which detaches the debugger or
	* destroys the execution context of the first attempt.
	*/
	async evaluate(session, code, signal) {
		for (let attempt = 1;; attempt++) try {
			return await this.options.client.callTool("evaluate", {
				session,
				code
			}, signal);
		} catch (error) {
			if (attempt >= EVALUATE_ATTEMPTS || !TRANSIENT_PAGE_ERROR.test(String(error))) throw error;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	/** Close the query's tabs; a failure only leaves a tab open, so it is logged. */
	async close(session) {
		try {
			await this.options.client.callTool("close_session", { session }, AbortSignal.timeout(5e3));
		} catch (error) {
			this.options.warn(`could not close Chrome session ${session}: ${String(error)}`);
		}
	}
};
/**
* Register the `chrome-browser` search provider.
* @param ctx - plugin context carrying the web service.
* @param config - the validated plugin config.
*/
function apply(ctx, config) {
	ctx.web.registerSearchProvider(new ChromeSearchProvider({
		engine: config.engine,
		resultWaitMs: config.resultWaitMs,
		client: new DaemonClient(DAEMON_MCP_URL),
		warn: (message) => ctx.logger.warn(message)
	}));
}
//#endregion
export { CHROME_SEARCH_PROVIDER_ID, ChromeSearchProvider, Config, DaemonClient, ENGINES, ENGINE_SPECS, apply, extractionScript, inject, mapResult, name, searchUrl };
