/**
 * The tool catalog advertised over MCP — a verbatim port of the Rust daemon's
 * `tools.rs`. Every tool is executed by the browser extension, so this
 * module owns only the *contract*: the model-facing name, description, and
 * JSON Schema. Keeping the catalog in one table means `tools/list` and the
 * dispatch validation in the MCP layer can never disagree about which names
 * exist.
 *
 * @module dsh-chrome/tools-catalog
 */

import type { Json } from './protocol.ts'

/** One advertised tool. */
export interface ToolSpec {
  /** Raw MCP tool name; the harness exposes it as `mcp__chrome__<name>`. */
  name: string
  /** Model-facing description. */
  description: string
  /** JSON Schema for the tool's arguments. */
  inputSchema: Json
}

/**
 * Shared `session` property description: the single most load-bearing
 * argument, because it is what groups a task's tabs together.
 */
const SESSION_DESC =
  "Task-scoped session name. One task = one session = one Chrome tab group. Pick a name at the task's start and reuse it for every call in that task."

function sessionOnly(): Json {
  return {
    type: 'object',
    properties: { session: { type: 'string', description: SESSION_DESC } },
    required: ['session'],
    additionalProperties: false,
  }
}

function withSession(props: Record<string, Json>, required: string[]): Json {
  return {
    type: 'object',
    properties: { ...props, session: { type: 'string', description: SESSION_DESC } },
    required: [...required, 'session'],
    additionalProperties: false,
  }
}

/** Every tool the server advertises, in presentation order. */
export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'navigate',
    description:
      "Open a URL in the user's real Chrome. The first call in a session creates the session's tab group.",
    inputSchema: withSession(
      {
        url: { type: 'string', description: 'Absolute http(s) URL to open.' },
        newTab: {
          type: 'boolean',
          description:
            "Open a new tab instead of reusing the session's current tab. Use true when pages must coexist.",
        },
        group_title: {
          type: 'string',
          description:
            "Human-readable label for this task's tab group; set it on the first navigate, in the user's language.",
        },
      },
      ['url'],
    ),
  },
  {
    name: 'find_tab',
    description:
      "Re-select a tab as the session's current tab. Pass active:true to borrow the tab the user is currently viewing.",
    inputSchema: withSession(
      {
        url: {
          type: 'string',
          description: 'Full URL of the tab to select; prefer the exact URL over a bare domain.',
        },
        active: {
          type: 'boolean',
          description:
            "Borrow the tab the user is currently viewing instead of searching this session's own tabs.",
        },
      },
      [],
    ),
  },
  {
    name: 'list_tabs',
    description:
      "List every tab in this session's tab group, with ids, URLs, titles, group label, and current:true on the tab the page tools act on. Use find_tab to switch the current tab.",
    inputSchema: sessionOnly(),
  },
  {
    name: 'close_tab',
    description: "Close the session's current tab.",
    inputSchema: sessionOnly(),
  },
  {
    name: 'close_session',
    description:
      "Close every tab in this session's tab group. Call only when the user explicitly asks.",
    inputSchema: sessionOnly(),
  },
  {
    name: 'snapshot',
    description:
      'Read the current page as an indented accessibility outline with @e refs, one element per line. Use it to locate elements for click/fill. Defaults to interactive elements plus headings and table cells; pass mode:"full" for every node or mode:"text" for prose. To read an article, prefer get_text.',
    inputSchema: withSession(
      {
        mode: {
          type: 'string',
          enum: ['interactive', 'full', 'text'],
          description:
            'interactive (default) keeps controls plus headings/cells/images; full keeps every node; text keeps prose and drops refs.',
        },
        maxDepth: {
          type: 'integer',
          minimum: 0,
          description: 'Drop elements nested deeper than this. Omit for no limit.',
        },
        diff: {
          type: 'boolean',
          description:
            'Return only what changed since this tab\'s previous snapshot: [+] added, [~] changed, and a trailing "# removed:" line. Unchanged nodes are omitted; the first diff on a tab has no baseline and returns the full tree marked [+]. Refs for the whole current page are still published, so every @e stays usable.',
        },
        selector: {
          type: 'string',
          description:
            'Optional @e ref or CSS selector of a container: the outline covers only its subtree. Use it to narrow a huge page to the region you care about. Note: the @e ref table is rebuilt from this subtree, so refs outside it go stale.',
        },
      },
      [],
    ),
  },
  {
    name: 'click',
    description:
      'Click an element with a full synthetic pointer stroke (pointerdown through click). Prefer an @e ref from snapshot over a hand-written CSS selector. If a widget ignores the synthetic stroke, retry with trusted:true for real browser input.',
    inputSchema: withSession(
      {
        selector: {
          type: 'string',
          description: 'An @e ref from snapshot (preferred) or a CSS selector.',
        },
        trusted: {
          type: 'boolean',
          description:
            "Dispatch real (trusted) input at the element's center instead of synthetic events. Works on widgets that check isTrusted or listen outside the DOM event path; costs a tab activation.",
        },
      },
      ['selector'],
    ),
  },
  {
    name: 'fill',
    description:
      'Set the value of an input, textarea, or contenteditable rich editor. Clear-and-insert: existing content is replaced. The result echoes the value read back with verified:true/false, so a framework that rejected or reformatted the text is visible immediately. A readonly dropdown input is refused with a pointer to select.',
    inputSchema: withSession(
      {
        selector: {
          type: 'string',
          description: 'An @e ref from snapshot (preferred) or a CSS selector.',
        },
        value: { type: 'string', description: 'Text to insert, replacing any existing content.' },
      },
      ['selector', 'value'],
    ),
  },
  {
    name: 'upload',
    description:
      'Set local file paths on a page file-upload control through Chrome. The selector may be the <input type="file"> itself or its visible trigger; standard label/ARIA/container relationships are resolved automatically. Prefer an @e ref from snapshot.',
    inputSchema: withSession(
      {
        selector: {
          type: 'string',
          description: 'An @e ref or CSS selector for a file input or its visible upload trigger.',
        },
        paths: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description: 'Local file paths visible to Chrome. Pass multiple paths only when the input has the multiple attribute.',
        },
      },
      ['selector', 'paths'],
    ),
  },
  {
    name: 'evaluate',
    description:
      'Run JavaScript in the page and return its JSON-serializable result. Supports async/await. Wrap declarations in an IIFE to avoid redeclaration errors across calls.',
    inputSchema: withSession(
      {
        code: {
          type: 'string',
          description: 'JavaScript expression or statements to evaluate in the page.',
        },
      },
      ['code'],
    ),
  },
  {
    name: 'screenshot',
    description:
      'Capture the visible viewport, or one element, as an image the model can see directly.',
    inputSchema: withSession(
      {
        format: {
          type: 'string',
          enum: ['png', 'jpeg'],
          description: 'Image format; defaults to png.',
        },
        quality: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'JPEG quality 0-100; ignored for png.',
        },
        selector: {
          type: 'string',
          description: 'Optional @e ref or CSS selector to capture just that element.',
        },
      },
      [],
    ),
  },
  {
    name: 'save_as_pdf',
    description: 'Render the current page to a PDF file on disk and return its path.',
    inputSchema: withSession(
      {
        paper_format: {
          type: 'string',
          enum: ['letter', 'a4', 'legal', 'a3', 'tabloid'],
          description: 'Paper size; defaults to letter.',
        },
        landscape: { type: 'boolean', description: 'Landscape orientation; defaults to false.' },
        scale: {
          type: 'number',
          minimum: 0.1,
          maximum: 2.0,
          description: 'Render scale, 0.1-2.0; defaults to 1.0.',
        },
        print_background: {
          type: 'boolean',
          description: 'Keep background colors; defaults to true.',
        },
        path: {
          type: 'string',
          description:
            'Optional output path; parent directories are created and an existing file is overwritten.',
        },
      },
      [],
    ),
  },
  {
    name: 'mouse_click',
    description:
      "Click with a real (trusted) mouse event, at an element's center (selector) or at viewport coordinates. Use when a page ignores synthetic clicks because it checks event.isTrusted. Pass either selector, or both x and y. Activates the tab.",
    inputSchema: withSession(
      {
        selector: {
          type: 'string',
          description:
            'An @e ref from snapshot (preferred) or a CSS selector; it is scrolled into view and its center is clicked.',
        },
        x: {
          type: 'number',
          description: 'Viewport x coordinate in CSS pixels; requires y and no selector.',
        },
        y: {
          type: 'number',
          description: 'Viewport y coordinate in CSS pixels; requires x and no selector.',
        },
        button: {
          type: 'string',
          enum: ['left', 'middle', 'right'],
          description: 'Mouse button; defaults to left.',
        },
        clickCount: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: 'Click count; 2 for a double click.',
        },
      },
      [],
    ),
  },
  {
    name: 'key_type',
    description:
      'Type text into the focused element with real (trusted) key events, character by character.',
    inputSchema: withSession(
      {
        text: { type: 'string', description: 'Text to type into the currently focused element.' },
      },
      ['text'],
    ),
  },
  {
    name: 'send_keys',
    description:
      'Press one key or chord with real (trusted) key events, e.g. Enter, Escape, Tab, or Control+A. Use this to submit a form when clicking a button is not possible.',
    inputSchema: withSession(
      {
        keys: {
          type: 'string',
          description: 'A key name or chord such as "Enter", "Escape", or "Control+A".',
        },
      },
      ['keys'],
    ),
  },
  {
    name: 'hover',
    description:
      'Move the real mouse pointer over an element or viewport point, firing trusted mouseover/mouseenter. Use for menus and tooltips that only appear on hover. Pass either selector, or both x and y — not both forms. Activates the tab, because trusted input only reaches the focused tab.',
    inputSchema: withSession(
      {
        selector: {
          type: 'string',
          description: 'An @e ref from snapshot (preferred) or a CSS selector; its center is used.',
        },
        x: {
          type: 'number',
          description: 'Viewport x coordinate in CSS pixels; requires y and no selector.',
        },
        y: {
          type: 'number',
          description: 'Viewport y coordinate in CSS pixels; requires x and no selector.',
        },
      },
      [],
    ),
  },
  {
    name: 'focus',
    description:
      'Give an element keyboard focus without clicking it. Follow with key_type or send_keys to type into it.',
    inputSchema: withSession(
      {
        selector: {
          type: 'string',
          description: 'An @e ref from snapshot (preferred) or a CSS selector.',
        },
      },
      ['selector'],
    ),
  },
  {
    name: 'select',
    description:
      'Choose an option in a dropdown: a native <select>, or any custom control following the ARIA combobox pattern (role="combobox" or aria-haspopup) — it is opened with trusted input, the visible [role=option] items are matched by value, exact text, then substring, and the match is clicked. Use this instead of fill, which cannot drive a dropdown. A control that ignores ARIA gets an error naming the fallback (click with trusted:true). Custom dropdowns activate the tab.',
    inputSchema: withSession(
      {
        selector: {
          type: 'string',
          description:
            'An @e ref or CSS selector for the <select> element or the ARIA combobox control.',
        },
        value: { type: 'string', description: 'Option value, or its visible text.' },
      },
      ['selector', 'value'],
    ),
  },
  {
    name: 'scroll',
    description:
      'Scroll the page, or one scrollable element when selector is given. Give either direction (with optional pixels) or an explicit deltaX/deltaY. Defaults to one viewport-height page down. Reports whether the position actually moved, so you can tell when you have hit the end.',
    inputSchema: withSession(
      {
        selector: {
          type: 'string',
          description:
            'Optional @e ref or CSS selector of the element to scroll; omit to scroll the page.',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Scroll direction; defaults to down.',
        },
        pixels: {
          type: 'number',
          description: 'Distance in CSS pixels for direction; defaults to 80% of the viewport.',
        },
        deltaX: {
          type: 'number',
          description: 'Explicit horizontal delta, wheel semantics; overrides direction.',
        },
        deltaY: {
          type: 'number',
          description: 'Explicit vertical delta, positive scrolls down; overrides direction.',
        },
      },
      [],
    ),
  },
  {
    name: 'scroll_into_view',
    description:
      'Scroll an element into the viewport and return its geometry. Use before mouse_click or hover, whose coordinates are only valid for a visible element.',
    inputSchema: withSession(
      {
        selector: {
          type: 'string',
          description: 'An @e ref from snapshot (preferred) or a CSS selector.',
        },
      },
      ['selector'],
    ),
  },
  {
    name: 'find',
    description:
      'Search the page for the interactive element best matching a plain-language query, and return reusable @e refs with a CSS hint. Cheaper than snapshot when you need one control on a large page; use snapshot when you need the whole structure. Refs are appended, so refs from an earlier snapshot stay valid.',
    inputSchema: withSession(
      {
        query: {
          type: 'string',
          description:
            'What to look for, as the user would name it, e.g. "sign in button" or "search box".',
        },
      },
      ['query'],
    ),
  },
  {
    name: 'wait',
    description:
      'Sleep for a fixed number of milliseconds, capped at 3000. Prefer wait_for_selector, which waits on a condition; navigate already waits for load. Use this only when there is no element to wait for, such as a settling animation.',
    inputSchema: withSession(
      {
        ms: {
          type: 'integer',
          minimum: 0,
          maximum: 3000,
          description: 'Milliseconds to wait; values above 3000 are clamped.',
        },
      },
      ['ms'],
    ),
  },
  {
    name: 'wait_for_selector',
    description:
      'Poll until an element becomes visible, or disappears when state is hidden. Returns as soon as the condition holds; on timeout the error says how long it waited.',
    inputSchema: withSession(
      {
        selector: { type: 'string', description: 'An @e ref or CSS selector to wait for.' },
        state: {
          type: 'string',
          enum: ['visible', 'hidden'],
          description: 'Condition to wait for; defaults to visible.',
        },
        timeout: {
          type: 'integer',
          minimum: 0,
          maximum: 30000,
          description: 'Milliseconds before giving up; defaults to 5000, capped at 30000.',
        },
      },
      ['selector'],
    ),
  },
  {
    name: 'network',
    description:
      "List the tab's recent network requests with method, URL, status, and a requestId for network_detail. Only requests made after the tools attached to this tab are recorded.",
    inputSchema: withSession(
      {
        filter: {
          type: 'string',
          description: 'Keep only requests whose URL contains this substring.',
        },
        method: { type: 'string', description: 'Keep only this HTTP method, e.g. POST.' },
        status: { type: 'integer', description: 'Keep only this HTTP status code, e.g. 404.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Most recent entries to return; defaults to 50.',
        },
      },
      [],
    ),
  },
  {
    name: 'network_detail',
    description:
      'Full record of one request from network, including request and response headers. Pass body:true to also fetch the response body, which is truncated when large.',
    inputSchema: withSession(
      {
        requestId: { type: 'string', description: 'The requestId reported by network.' },
        body: { type: 'boolean', description: 'Also fetch the response body; defaults to false.' },
      },
      ['requestId'],
    ),
  },
  {
    name: 'dialog',
    description:
      'Answer a native alert, confirm, beforeunload, or prompt dialog. Call this only once a dialog is actually open: while one is, it blocks every other tool on that tab, so an unanswered dialog is the usual cause of a hung page.',
    inputSchema: withSession(
      {
        action: {
          type: 'string',
          enum: ['accept', 'dismiss'],
          description: 'accept presses OK; dismiss presses Cancel.',
        },
        text: { type: 'string', description: 'Text to enter, for a prompt dialog being accepted.' },
      },
      ['action'],
    ),
  },
  {
    name: 'get_text',
    description:
      "Extract the page's readable text. By default strips navigation, headers, footers, sidebars, and scripts to leave the article; pass raw:true for the whole body's innerText. Prefer this over snapshot when you want to read prose rather than locate controls.",
    inputSchema: withSession(
      {
        raw: {
          type: 'boolean',
          description: 'Return document.body.innerText verbatim, skipping noise removal.',
        },
        maxChars: {
          type: 'integer',
          minimum: 1,
          description: 'Truncate to this many characters; defaults to 20000.',
        },
      },
      [],
    ),
  },
]

/** Look up whether a raw tool name is advertised. */
export function isKnown(name: string): boolean {
  return TOOLS.some(tool => tool.name === name)
}

/** Render the catalog as the `tools` array of an MCP `tools/list` result. */
export function listPayload(): Json[] {
  return TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}
