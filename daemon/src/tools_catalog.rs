//! The tool catalog advertised over MCP — a port of the TS `tools-catalog.ts`
//! (itself a verbatim port of the original Rust daemon's `tools.rs`). Every
//! tool is executed by the browser extension, so this module owns only the
//! *contract*: the model-facing name, description, and JSON Schema.

use serde_json::{json, Value};
use std::sync::LazyLock;

/// One advertised tool.
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}

/// Shared `session` property description: the single most load-bearing argument.
const SESSION_DESC: &str = "Task-scoped session name. One task = one session = one Chrome tab group. Pick a name at the task's start and reuse it for every call in that task.";

fn session_prop() -> Value {
    json!({ "type": "string", "description": SESSION_DESC })
}

fn session_only() -> Value {
    json!({
        "type": "object",
        "properties": { "session": session_prop() },
        "required": ["session"],
        "additionalProperties": false
    })
}

fn with_session(props: Value, required: &[&str]) -> Value {
    let mut properties = match props {
        Value::Object(m) => m,
        _ => unreachable!("with_session props must be an object"),
    };
    properties.insert("session".to_string(), session_prop());
    let mut req: Vec<Value> = required.iter().map(|s| json!(s)).collect();
    req.push(json!("session"));
    json!({
        "type": "object",
        "properties": Value::Object(properties),
        "required": req,
        "additionalProperties": false
    })
}

/// Every tool the server advertises, in presentation order. Built once at
/// first use; `json!()`/`with_session` are not const, so this needs `LazyLock`.
pub static TOOLS: LazyLock<Vec<ToolSpec>> = LazyLock::new(|| vec![
    ToolSpec {
        name: "navigate",
        description: "Open a URL in the user's real Chrome. The first call in a session creates the session's tab group.",
        input_schema: with_session(json!({
            "url": { "type": "string", "description": "Any absolute URL the browser can open — http(s), file:, about:, data:, or an internal scheme like chrome:. Privileged pages (chrome:// and friends) open as real tabs, but page-reading tools cannot attach to them." },
            "newTab": { "type": "boolean", "description": "Open a new tab instead of reusing the session's current tab. Use true when pages must coexist." },
            "group_title": { "type": "string", "description": "Human-readable label for this task's tab group; set it on the first navigate, in the user's language." }
        }), &["url"]),
    },
    ToolSpec {
        name: "find_tab",
        description: "Re-select a tab as the session's current tab. Pass active:true to borrow the tab the user is currently viewing.",
        input_schema: with_session(json!({
            "url": { "type": "string", "description": "Full URL of the tab to select; prefer the exact URL over a bare domain." },
            "active": { "type": "boolean", "description": "Borrow the tab the user is currently viewing instead of searching this session's own tabs." }
        }), &[]),
    },
    ToolSpec {
        name: "list_tabs",
        description: "List every tab in this session's tab group, with ids, URLs, titles, group label, and current:true on the tab the page tools act on. Use find_tab to switch the current tab.",
        input_schema: session_only(),
    },
    ToolSpec {
        name: "close_tab",
        description: "Close the session's current tab.",
        input_schema: session_only(),
    },
    ToolSpec {
        name: "close_session",
        description: "Close every tab in this session's tab group. Call only when the user explicitly asks.",
        input_schema: session_only(),
    },
    ToolSpec {
        name: "snapshot",
        description: "Read the current page as an indented accessibility outline with @e refs, one element per line. Use it to locate elements for click/fill. Defaults to interactive elements plus headings and table cells; pass mode:\"full\" for every node or mode:\"text\" for prose. To read an article, prefer get_text. The result also reports platform, the operating system Chrome is running on (\"mac\", \"win\", \"linux\", or null when unknown), so keyboard shortcuts can be aimed at the right modifier — select-all is Meta+A on mac and Control+A elsewhere.",
        input_schema: with_session(json!({
            "mode": { "type": "string", "enum": ["interactive", "full", "text"], "description": "interactive (default) keeps controls plus headings/cells/images; full keeps every node; text keeps prose and drops refs." },
            "maxDepth": { "type": "integer", "minimum": 0, "description": "Drop elements nested deeper than this. Omit for no limit." },
            "diff": { "type": "boolean", "description": "Return only what changed since this tab's previous snapshot: [+] added, [~] changed, and a trailing \"# removed:\" line. Unchanged nodes are omitted; the first diff on a tab has no baseline and returns the full tree marked [+]. Refs for the whole current page are still published, so every @e stays usable." },
            "selector": { "type": "string", "description": "Optional @e ref or CSS selector of a container: the outline covers only its subtree. Use it to narrow a huge page to the region you care about. Note: the @e ref table is rebuilt from this subtree, so refs outside it go stale." }
        }), &[]),
    },
    ToolSpec {
        name: "click",
        description: "Click an element with a full synthetic pointer stroke (pointerdown through click). Prefer an @e ref from snapshot over a hand-written CSS selector. If a widget ignores the synthetic stroke, retry with trusted:true for real browser input.",
        input_schema: with_session(json!({
            "selector": { "type": "string", "description": "An @e ref from snapshot (preferred) or a CSS selector." },
            "trusted": { "type": "boolean", "description": "Dispatch real (trusted) input at the element's center instead of synthetic events. Works on widgets that check isTrusted or listen outside the DOM event path. Runs on a background tab without bringing it to the foreground." }
        }), &["selector"]),
    },
    ToolSpec {
        name: "fill",
        description: "Set the value of an input, textarea, or contenteditable rich editor. Clear-and-insert: existing content is replaced. The result echoes the value read back with verified:true/false, so a framework that rejected or reformatted the text is visible immediately. A readonly dropdown input is refused with a pointer to select.",
        input_schema: with_session(json!({
            "selector": { "type": "string", "description": "An @e ref from snapshot (preferred) or a CSS selector." },
            "value": { "type": "string", "description": "Text to insert, replacing any existing content." }
        }), &["selector", "value"]),
    },
    ToolSpec {
        name: "upload",
        description: "Set local file paths on a page file-upload control through Chrome. The selector may be the <input type=\"file\"> itself or its visible trigger; standard label/ARIA/container relationships are resolved automatically. Prefer an @e ref from snapshot.",
        input_schema: with_session(json!({
            "selector": { "type": "string", "description": "An @e ref or CSS selector for a file input or its visible upload trigger." },
            "paths": { "type": "array", "minItems": 1, "items": { "type": "string" }, "description": "Local file paths visible to Chrome. Pass multiple paths only when the input has the multiple attribute." }
        }), &["selector", "paths"]),
    },
    ToolSpec {
        name: "evaluate",
        description: "Run JavaScript in the page and return its JSON-serializable result. Supports async/await. Wrap declarations in an IIFE to avoid redeclaration errors across calls.",
        input_schema: with_session(json!({
            "code": { "type": "string", "description": "JavaScript expression or statements to evaluate in the page." }
        }), &["code"]),
    },
    ToolSpec {
        name: "screenshot",
        description: "Capture the visible viewport, or one element, as an image the model can see directly.",
        input_schema: with_session(json!({
            "format": { "type": "string", "enum": ["png", "jpeg"], "description": "Image format; defaults to png." },
            "quality": { "type": "integer", "minimum": 0, "maximum": 100, "description": "JPEG quality 0-100; ignored for png." },
            "selector": { "type": "string", "description": "Optional @e ref or CSS selector to capture just that element." }
        }), &[]),
    },
    ToolSpec {
        name: "save_as_pdf",
        description: "Render the current page to a PDF file on disk and return its path.",
        input_schema: with_session(json!({
            "paper_format": { "type": "string", "enum": ["letter", "a4", "legal", "a3", "tabloid"], "description": "Paper size; defaults to letter." },
            "landscape": { "type": "boolean", "description": "Landscape orientation; defaults to false." },
            "scale": { "type": "number", "minimum": 0.1, "maximum": 2.0, "description": "Render scale, 0.1-2.0; defaults to 1.0." },
            "print_background": { "type": "boolean", "description": "Keep background colors; defaults to true." },
            "path": { "type": "string", "description": "Optional output path; parent directories are created and an existing file is overwritten." }
        }), &[]),
    },
    ToolSpec {
        name: "mouse_click",
        description: "Click with a real (trusted) mouse event, at an element's center (selector) or at viewport coordinates. Use when a page ignores synthetic clicks because it checks event.isTrusted. Pass either selector, or both x and y. Runs on a background tab without stealing the foreground, and reports received:false when the press never reached the page.",
        input_schema: with_session(json!({
            "selector": { "type": "string", "description": "An @e ref from snapshot (preferred) or a CSS selector; it is scrolled into view and its center is clicked." },
            "x": { "type": "number", "description": "Viewport x coordinate in CSS pixels; requires y and no selector." },
            "y": { "type": "number", "description": "Viewport y coordinate in CSS pixels; requires x and no selector." },
            "button": { "type": "string", "enum": ["left", "middle", "right"], "description": "Mouse button; defaults to left." },
            "clickCount": { "type": "integer", "minimum": 1, "maximum": 3, "description": "Click count; 2 for a double click." }
        }), &[]),
    },
    ToolSpec {
        name: "key_type",
        description: "Type text into the focused element with real (trusted) key events. The result reports verified:true/false by reading the page back, so text the page rejected or rewrote is visible on the first call instead of looking like a success. When verified is false, read the returned value to see what the page actually holds and change approach rather than typing it again.",
        input_schema: with_session(json!({
            "text": { "type": "string", "description": "Text to type into the currently focused element." }
        }), &["text"]),
    },
    ToolSpec {
        name: "send_keys",
        description: "Press one key or chord with real (trusted) key events, e.g. Enter, Escape, Tab, or Control+A. Use this to submit a form when clicking a button is not possible. Pass count to repeat the key in a single call instead of one call per press. The result reports changed:true/false so a key the page never applied is visible immediately. Modifier names are passed through literally and shortcuts differ by operating system, so match the modifier to the platform snapshot reports. Editing chords work: select-all, copy, cut, paste, undo/redo, Enter-to-submit and Delete are dispatched with the editing command the platform needs, in native inputs, textareas and contenteditable alike. The result reports selectionChanged plus the clipboard/submit events observed, so a select-all (which changes no text) is distinguishable from a keystroke that did nothing; when a known editing chord turns out inert, hint says what to check. A browser-level chord (Cmd/Ctrl+T, +W, +L, +R and friends) is refused outright, because Chrome consumes it before the renderer sees it and CDP input enters at the renderer — use navigate or close_tab for those.",
        input_schema: with_session(json!({
            "keys": { "type": "string", "description": "A key name or chord such as \"Enter\", \"Escape\", or \"Control+A\". Modifier names are taken literally; shortcuts differ by operating system, so check the platform reported by snapshot." },
            "count": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Times to repeat the key in this call; defaults to 1, capped at 200." },
            "commands": { "type": "array", "items": { "type": "string" }, "description": "Advanced, rarely needed: explicit macOS editing commands to perform instead of the ones derived from the chord, such as moveToBeginningOfLine. Standard editing chords already work without this." }
        }), &["keys"]),
    },
    ToolSpec {
        name: "hover",
        description: "Move the real mouse pointer over an element or viewport point, firing trusted mouseover/mouseenter. Use for menus and tooltips that only appear on hover. Pass either selector, or both x and y — not both forms. Runs on a background tab without stealing the foreground.",
        input_schema: with_session(json!({
            "selector": { "type": "string", "description": "An @e ref from snapshot (preferred) or a CSS selector; its center is used." },
            "x": { "type": "number", "description": "Viewport x coordinate in CSS pixels; requires y and no selector." },
            "y": { "type": "number", "description": "Viewport y coordinate in CSS pixels; requires x and no selector." }
        }), &[]),
    },
    ToolSpec {
        name: "focus",
        description: "Give an element keyboard focus without clicking it. Follow with key_type or send_keys to type into it.",
        input_schema: with_session(json!({
            "selector": { "type": "string", "description": "An @e ref from snapshot (preferred) or a CSS selector." }
        }), &["selector"]),
    },
    ToolSpec {
        name: "select",
        description: "Choose an option in a dropdown: a native <select>, or any custom control following the ARIA combobox pattern (role=\"combobox\" or aria-haspopup) — it is opened with trusted input, the visible [role=option] items are matched by value, exact text, then substring, and the match is clicked. Use this instead of fill, which cannot drive a dropdown. A control that ignores ARIA gets an error naming the fallback (click with trusted:true). Custom dropdowns activate the tab.",
        input_schema: with_session(json!({
            "selector": { "type": "string", "description": "An @e ref or CSS selector for the <select> element or the ARIA combobox control." },
            "value": { "type": "string", "description": "Option value, or its visible text." }
        }), &["selector", "value"]),
    },
    ToolSpec {
        name: "scroll",
        description: "Scroll the page, or one scrollable element when selector is given. Give either direction (with optional pixels) or an explicit deltaX/deltaY. Defaults to one viewport-height page down. Reports whether the position actually moved, so you can tell when you have hit the end.",
        input_schema: with_session(json!({
            "selector": { "type": "string", "description": "Optional @e ref or CSS selector of the element to scroll; omit to scroll the page." },
            "direction": { "type": "string", "enum": ["up", "down", "left", "right"], "description": "Scroll direction; defaults to down." },
            "pixels": { "type": "number", "description": "Distance in CSS pixels for direction; defaults to 80% of the viewport." },
            "deltaX": { "type": "number", "description": "Explicit horizontal delta, wheel semantics; overrides direction." },
            "deltaY": { "type": "number", "description": "Explicit vertical delta, positive scrolls down; overrides direction." }
        }), &[]),
    },
    ToolSpec {
        name: "scroll_into_view",
        description: "Scroll an element into the viewport and return its geometry. Use before mouse_click or hover, whose coordinates are only valid for a visible element.",
        input_schema: with_session(json!({
            "selector": { "type": "string", "description": "An @e ref from snapshot (preferred) or a CSS selector." }
        }), &["selector"]),
    },
    ToolSpec {
        name: "find",
        description: "Search the page for the interactive element best matching a plain-language query, and return reusable @e refs with a CSS hint. Cheaper than snapshot when you need one control on a large page; use snapshot when you need the whole structure. Refs are appended, so refs from an earlier snapshot stay valid.",
        input_schema: with_session(json!({
            "query": { "type": "string", "description": "What to look for, as the user would name it, e.g. \"sign in button\" or \"search box\"." }
        }), &["query"]),
    },
    ToolSpec {
        name: "wait",
        description: "Sleep for a fixed number of milliseconds, capped at 3000. Prefer wait_for_selector, which waits on a condition; navigate already waits for load. Use this only when there is no element to wait for, such as a settling animation.",
        input_schema: with_session(json!({
            "ms": { "type": "integer", "minimum": 0, "maximum": 3000, "description": "Milliseconds to wait; values above 3000 are clamped." }
        }), &["ms"]),
    },
    ToolSpec {
        name: "wait_for_selector",
        description: "Poll until an element becomes visible, or disappears when state is hidden. Returns as soon as the condition holds; on timeout the error says how long it waited.",
        input_schema: with_session(json!({
            "selector": { "type": "string", "description": "An @e ref or CSS selector to wait for." },
            "state": { "type": "string", "enum": ["visible", "hidden"], "description": "Condition to wait for; defaults to visible." },
            "timeout": { "type": "integer", "minimum": 0, "maximum": 30000, "description": "Milliseconds before giving up; defaults to 5000, capped at 30000." }
        }), &["selector"]),
    },
    ToolSpec {
        name: "network",
        description: "List the tab's recent network requests with method, URL, status, and a requestId for network_detail. Only requests made after the tools attached to this tab are recorded.",
        input_schema: with_session(json!({
            "filter": { "type": "string", "description": "Keep only requests whose URL contains this substring." },
            "method": { "type": "string", "description": "Keep only this HTTP method, e.g. POST." },
            "status": { "type": "integer", "description": "Keep only this HTTP status code, e.g. 404." },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Most recent entries to return; defaults to 50." }
        }), &[]),
    },
    ToolSpec {
        name: "network_detail",
        description: "Full record of one request from network, including request and response headers. Pass body:true to also fetch the response body, which is truncated when large.",
        input_schema: with_session(json!({
            "requestId": { "type": "string", "description": "The requestId reported by network." },
            "body": { "type": "boolean", "description": "Also fetch the response body; defaults to false." }
        }), &["requestId"]),
    },
    ToolSpec {
        name: "dialog",
        description: "Answer a native alert, confirm, beforeunload, or prompt dialog. Call this only once a dialog is actually open: while one is, it blocks every other tool on that tab, so an unanswered dialog is the usual cause of a hung page.",
        input_schema: with_session(json!({
            "action": { "type": "string", "enum": ["accept", "dismiss"], "description": "accept presses OK; dismiss presses Cancel." },
            "text": { "type": "string", "description": "Text to enter, for a prompt dialog being accepted." }
        }), &["action"]),
    },
    ToolSpec {
        name: "get_text",
        description: "Extract the page's readable text. By default strips navigation, headers, footers, sidebars, and scripts to leave the article; pass raw:true for the whole body's innerText. Prefer this over snapshot when you want to read prose rather than locate controls.",
        input_schema: with_session(json!({
            "raw": { "type": "boolean", "description": "Return document.body.innerText verbatim, skipping noise removal." },
            "maxChars": { "type": "integer", "minimum": 1, "description": "Truncate to this many characters; defaults to 20000." }
        }), &[]),
    },
]);

/// Look up whether a raw tool name is advertised.
pub fn is_known(name: &str) -> bool {
    TOOLS.iter().any(|t| t.name == name)
}

/// Render the catalog as the `tools` array of an MCP `tools/list` result.
pub fn list_payload() -> Value {
    let tools: Vec<Value> = TOOLS
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.input_schema.clone(),
            })
        })
        .collect();
    json!({ "tools": tools })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertises_27_tools() {
        assert_eq!(TOOLS.len(), 27, "catalog must list 27 tools");
    }

    #[test]
    fn snapshot_reports_platform() {
        let spec = TOOLS.iter().find(|t| t.name == "snapshot").expect("snapshot is advertised");
        // Callers only know to read the field if the contract names it.
        assert!(spec.description.contains("platform"));
    }

    #[test]
    fn send_keys_does_not_presume_an_operating_system() {
        let spec = TOOLS.iter().find(|t| t.name == "send_keys").expect("send_keys is advertised");
        // Modifier names are passed through literally, so the description must
        // point at the reported platform instead of hardcoding one platform's
        // shortcut as the advice.
        assert!(spec.description.contains("platform"));
        assert!(
            !spec.description.contains("Meta+A on macOS"),
            "send_keys must not prescribe one platform's shortcut",
        );
    }

    #[test]
    fn send_keys_accepts_a_bounded_repeat_count() {
        let spec = TOOLS.iter().find(|t| t.name == "send_keys").expect("send_keys is advertised");
        let count = &spec.input_schema["properties"]["count"];
        assert_eq!(count["type"], "integer");
        assert_eq!(count["minimum"], 1);
        // Must match SEND_KEYS_MAX_COUNT in the extension.
        assert_eq!(count["maximum"], 200);
        let required = spec.input_schema["required"].as_array().unwrap();
        assert!(!required.iter().any(|v| v == "count"), "count must be optional");
    }

    #[test]
    fn knows_navigate() {
        assert!(is_known("navigate"));
        assert!(is_known("get_text"));
        assert!(!is_known("cdp"));
    }

    #[test]
    fn list_payload_shape() {
        let p = list_payload();
        let tools = p.get("tools").unwrap().as_array().unwrap();
        assert_eq!(tools.len(), 27);
        assert_eq!(tools[0]["name"], "navigate");
        assert!(tools[0]["description"].as_str().unwrap().contains("Chrome"));
    }

    #[test]
    fn session_only_schema() {
        let s = session_only();
        assert_eq!(s["type"], "object");
        assert!(s["properties"]["session"]["type"].is_string());
        assert_eq!(s["required"][0], "session");
        assert_eq!(s["additionalProperties"], false);
    }

    #[test]
    fn navigate_requires_url_and_session() {
        let s = &TOOLS[0].input_schema;
        let required = s["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "url"));
        assert!(required.iter().any(|v| v == "session"));
    }

    #[test]
    fn every_schema_is_object_with_session() {
        for t in TOOLS.iter() {
            assert_eq!(t.input_schema["type"], "object", "{} has wrong type", t.name);
            assert!(t.input_schema["properties"]["session"].is_object(), "{} missing session prop", t.name);
            let req = t.input_schema["required"].as_array().unwrap();
            assert!(req.iter().any(|v| v == "session"), "{} missing session required", t.name);
            assert_eq!(t.input_schema["additionalProperties"], false, "{} not closed", t.name);
        }
    }
}
