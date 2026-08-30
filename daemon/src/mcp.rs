//! The MCP layer: JSON-RPC 2.0 over Streamable HTTP — a port of the TS `mcp.ts`.
//!
//! Only the subset the harness client actually exercises is implemented:
//! `initialize`, `notifications/initialized`, `ping`, `tools/list`, and
//! `tools/call`. A tool failure is reported as a *successful* JSON-RPC result
//! carrying `isError: true`, per the MCP spec — a JSON-RPC error is reserved
//! for protocol-level faults such as an unknown method.

use serde_json::{json, Value};
use std::time::Instant;

use crate::hub::{DispatchOutcome, Hub};
use crate::tools_catalog::{is_known, list_payload};

/// Protocol version this server implements.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// Server name reported in `initialize` and `/chrome/status`.
pub const SERVER_NAME: &str = "dsh-chrome";

/// Standard JSON-RPC error codes.
const CODE_PARSE_ERROR: i64 = -32700;
const CODE_INVALID_REQUEST: i64 = -32600;
const CODE_METHOD_NOT_FOUND: i64 = -32601;
const CODE_INVALID_PARAMS: i64 = -32602;

fn result(id: &Value, value: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": value })
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A JSON-RPC parse failure rendered as the spec's -32700 response.
pub fn parse_failure(message: &str) -> Value {
    rpc_error(&Value::Null, CODE_PARSE_ERROR, &format!("parse error: {message}"))
}

/// Hard-coded guards against a single oversized extension answer stalling a
/// thread. Three layers:
///   1. `cap_array` slices a top-level array past MAX_ARRAY_ELEMENTS (legal JSON).
///   2. Heavy `serde_json` serialization runs on `spawn_blocking`, off the
///      async worker threads.
///   3. The final text is clipped to MAX_TEXT_BYTES with a tail marker.
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_ARRAY_ELEMENTS: usize = 4000;
const TRUNCATED_TAIL: &str = "\n…[truncated by dsh-chrome-control]";

/// Slice a top-level array past the cap, leaving objects and primitives alone.
fn cap_array(value: &Value) -> Value {
    if let Value::Array(arr) = value {
        if arr.len() > MAX_ARRAY_ELEMENTS {
            let mut capped: Vec<Value> = arr[..MAX_ARRAY_ELEMENTS].to_vec();
            let omitted = arr.len() - MAX_ARRAY_ELEMENTS;
            capped.push(Value::String(format!(
                "…[truncated: {omitted} more elements omitted by dsh-chrome-control]"
            )));
            return Value::Array(capped);
        }
    }
    value.clone()
}

/// Heuristic: large enough that synchronous serialization is a risk on an async
/// worker. Strings are excluded — they are raw text and a long string is a cheap
/// linear copy, not a recursive walk.
fn should_offload(value: &Value) -> bool {
    match value {
        Value::Array(a) => a.len() > 256,
        Value::Object(o) => o.len() > 64,
        _ => false,
    }
}

/// A tool outcome rendered as MCP content. Heavy serialization runs on a
/// blocking thread; callers should `await` it.
pub async fn tool_content(value: Value) -> Value {
    // Image bypass: a base64 image rides the envelope's linear escaping and is
    // handed to the model as a real image block.
    if let Value::Object(o) = &value {
        if let (Some(Value::String(data)), Some(Value::String(mime))) =
            (o.get("__image_base64"), o.get("__image_mime_type"))
        {
            return json!({
                "content": [{ "type": "image", "data": data, "mimeType": mime }],
                "isError": false
            });
        }
    }
    let capped = cap_array(&value);
    let text = match &capped {
        // A string value is raw text: pass it through verbatim, never quoted.
        Value::String(s) => s.clone(),
        _ if should_offload(&capped) => {
            tokio::task::spawn_blocking(move || serde_json::to_string(&capped).unwrap_or_else(|_| "null".into()))
                .await
                .unwrap_or_else(|_| "null".into())
        }
        _ => serde_json::to_string(&capped).unwrap_or_else(|_| "null".into()),
    };
    let text = if text.len() > MAX_TEXT_BYTES {
        let mut t = text.into_bytes()[..MAX_TEXT_BYTES].to_vec();
        t.extend_from_slice(TRUNCATED_TAIL.as_bytes());
        String::from_utf8(t).unwrap_or_else(|_| "null".into())
    } else {
        text
    };
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false
    })
}

fn tool_failure(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

fn is_record(value: &Value) -> bool {
    value.is_object()
}

/// This daemon's version, reported as the MCP server version.
pub fn server_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Handle one parsed JSON-RPC request body. Returns `None` for notifications.
pub async fn handle(raw: &Value, hub: &Hub) -> Option<Value> {
    if !is_record(raw) {
        return Some(rpc_error(&Value::Null, CODE_INVALID_REQUEST, "request must be an object"));
    }
    let id = raw.get("id").cloned().unwrap_or(Value::Null);
    // Notifications carry no id (null) and never get a reply.
    if id == Value::Null {
        return None;
    }
    if raw.get("jsonrpc").and_then(|v| v.as_str()) != Some("2.0") {
        return Some(rpc_error(&id, CODE_INVALID_REQUEST, "jsonrpc must be \"2.0\""));
    }
    let method = raw.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = if is_record(raw.get("params").unwrap_or(&Value::Null)) {
        raw.get("params").unwrap()
    } else {
        &Value::Object(serde_json::Map::new())
    };

    match method {
        "initialize" => Some(result(&id, json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": SERVER_NAME, "version": server_version() }
        }))),
        "ping" => Some(result(&id, json!({}))),
        "tools/list" => Some(result(&id, list_payload())),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                return Some(rpc_error(&id, CODE_INVALID_PARAMS, "missing tool name"));
            }
            if !is_known(name) {
                return Some(rpc_error(&id, CODE_INVALID_PARAMS, &format!("unknown tool: {name}")));
            }
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let outcome = hub.dispatch(name, args).await;
            match outcome {
                DispatchOutcome::Answer(v) => Some(result(&id, tool_content(v).await)),
                DispatchOutcome::Error(_)
                | DispatchOutcome::NotConnected
                | DispatchOutcome::Timeout
                | DispatchOutcome::Disconnected => {
                    let message = outcome.into_message();
                    Some(result(&id, tool_failure(&message)))
                }
            }
        }
        _ => Some(rpc_error(&id, CODE_METHOD_NOT_FOUND, &format!("unknown method: {method}"))),
    }
}

/// Timestamp the daemon started, for `/chrome/status` uptime.
pub fn started_at() -> Instant {
    Instant::now()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::{Hub, TOOL_TIMEOUT_MS};

    #[tokio::test]
    async fn initialize() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        let r = handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize"}), &hub).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(r["result"]["serverInfo"]["name"], SERVER_NAME);
    }

    #[tokio::test]
    async fn tools_list_has_27() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        let r = handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), &hub).await.unwrap();
        assert_eq!(r["result"]["tools"].as_array().unwrap().len(), 27);
    }

    #[tokio::test]
    async fn ping_returns_empty() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        let r = handle(&json!({"jsonrpc":"2.0","id":3,"method":"ping"}), &hub).await.unwrap();
        assert_eq!(r["result"], json!({}));
    }

    #[tokio::test]
    async fn unknown_method() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        let r = handle(&json!({"jsonrpc":"2.0","id":4,"method":"cdp"}), &hub).await.unwrap();
        assert_eq!(r["error"]["code"], CODE_METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn unknown_tool() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        let r = handle(&json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"cdp"}}), &hub).await.unwrap();
        assert_eq!(r["error"]["code"], CODE_INVALID_PARAMS);
    }

    #[tokio::test]
    async fn not_connected_is_error_result() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        let r = handle(&json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"snapshot","arguments":{"session":"s"}}}), &hub).await.unwrap();
        assert!(r["error"].is_null());
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("chrome://extensions"));
    }

    #[tokio::test]
    async fn tool_content_compact_object() {
        let r = tool_content(json!({"url":"https://example.com","tabId":7})).await;
        assert_eq!(r["content"][0]["type"], "text");
        let text = r["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with('{'));
        assert!(text.contains("https://example.com"));
        assert!(!text.contains('\n'));
    }

    #[tokio::test]
    async fn tool_content_image_bypass() {
        let r = tool_content(json!({"__image_base64":"Zm9v","__image_mime_type":"image/png"})).await;
        assert_eq!(r["content"][0]["type"], "image");
        assert_eq!(r["content"][0]["data"], "Zm9v");
        assert_eq!(r["content"][0]["mimeType"], "image/png");
    }

    #[tokio::test]
    async fn tool_content_caps_large_array() {
        let big: Vec<Value> = (0..50000).map(|i| json!(format!("item-{i}"))).collect();
        let r = tool_content(Value::Array(big)).await;
        let text = r["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        let arr = parsed.as_array().unwrap();
        assert_eq!(arr.len(), 4001);
        assert_eq!(arr[0], "item-0");
        assert!(arr[4000].as_str().unwrap().contains("truncated"));
    }

    #[tokio::test]
    async fn tool_content_truncates_huge_string() {
        let huge = "x".repeat(2 * 1024 * 1024);
        let r = tool_content(Value::String(huge)).await;
        let text = r["content"][0]["text"].as_str().unwrap();
        assert_eq!(text.len(), MAX_TEXT_BYTES + TRUNCATED_TAIL.len());
        assert!(text.ends_with(TRUNCATED_TAIL));
        assert_eq!(&text[..10], "xxxxxxxxxx");
    }
}
