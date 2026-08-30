//! Wire protocol shared by the WebSocket hub and the MCP layer — a port of the
//! TS `protocol.ts`, which itself was a line-for-line port of the original Rust
//! daemon's `protocol.rs`. The browser extension speaks the exact same frames.
//!
//! The server sends `tool_call` envelopes carrying a `requestId`, and the
//! extension answers with a `tool_result` naming that id in `responseToRequestId`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Lossless JSON value, the only currency crossing the socket.
pub type Json = Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallPayload {
    pub name: String,
    pub args: Json,
}

/// A frame the server sends to the extension. The `type` tag stays snake_case
/// (matching the wire format the extension has always spoken: `tool_call`,
/// `hello_ack`), while struct fields are renamed to camelCase (`requestId`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerFrame {
    Ping,
    HelloAck,
    #[serde(rename = "tool_call")]
    ToolCall {
        #[serde(rename = "requestId")]
        request_id: String,
        payload: ToolCallPayload,
    }
}

/// A parsed frame the extension sends to the server.
#[derive(Debug, Clone)]
pub enum ClientFrame {
    Hello { extension_version: String },
    Pong,
    ToolResult {
        response_to_request_id: String,
        data: Option<Json>,
        error: Option<String>,
    },
}

/// Parse one raw text frame from the extension. Returns `None` when the frame
/// is not one of ours.
pub fn parse_client_frame(text: &str) -> Option<ClientFrame> {
    let raw: Value = serde_json::from_str(text).ok()?;
    let obj = raw.as_object()?;
    match obj.get("type").and_then(|v| v.as_str())? {
        "hello" => {
            let payload = obj.get("payload").and_then(|v| v.as_object());
            let version = payload
                .and_then(|p| p.get("extensionVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(ClientFrame::Hello { extension_version: version })
        }
        "pong" => Some(ClientFrame::Pong),
        "tool_result" => {
            let id = obj.get("responseToRequestId")?.as_str()?.to_string();
            let payload = obj.get("payload").and_then(|v| v.as_object());
            let data = payload.and_then(|p| p.get("data")).filter(|v| !v.is_null()).cloned();
            let error = payload
                .and_then(|p| p.get("error"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            Some(ClientFrame::ToolResult { response_to_request_id: id, data, error })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hello_with_version() {
        let f = parse_client_frame(r#"{"type":"hello","payload":{"extensionVersion":"0.3.1"}}"#).unwrap();
        match f {
            ClientFrame::Hello { extension_version } => assert_eq!(extension_version, "0.3.1"),
            _ => panic!("expected Hello"),
        }
    }

    #[test]
    fn parses_hello_without_payload() {
        let f = parse_client_frame(r#"{"type":"hello"}"#).unwrap();
        match f {
            ClientFrame::Hello { extension_version } => assert_eq!(extension_version, ""),
            _ => panic!("expected Hello"),
        }
    }

    #[test]
    fn parses_pong() {
        assert!(matches!(parse_client_frame(r#"{"type":"pong"}"#), Some(ClientFrame::Pong)));
    }

    #[test]
    fn parses_tool_result_with_data() {
        let f = parse_client_frame(
            r#"{"type":"tool_result","responseToRequestId":"r1","payload":{"data":{"ok":true}}}"#,
        )
        .unwrap();
        match f {
            ClientFrame::ToolResult { response_to_request_id, data, error } => {
                assert_eq!(response_to_request_id, "r1");
                assert_eq!(data, Some(serde_json::json!({"ok": true})));
                assert!(error.is_none());
            }
            _ => panic!("expected ToolResult"),
        }
    }

    #[test]
    fn parses_tool_result_with_error() {
        let f = parse_client_frame(
            r#"{"type":"tool_result","responseToRequestId":"r2","payload":{"error":"boom"}}"#,
        )
        .unwrap();
        match f {
            ClientFrame::ToolResult { error, .. } => assert_eq!(error.as_deref(), Some("boom")),
            _ => panic!("expected ToolResult"),
        }
    }

    #[test]
    fn rejects_invalid_json() {
        assert!(parse_client_frame("not json").is_none());
    }

    #[test]
    fn rejects_unknown_type() {
        assert!(parse_client_frame(r#"{"type":"nope"}"#).is_none());
    }

    #[test]
    fn rejects_tool_result_without_id() {
        assert!(parse_client_frame(r#"{"type":"tool_result","payload":{"data":1}}"#).is_none());
    }

    #[test]
    fn serializes_server_frame_tool_call() {
        let f = ServerFrame::ToolCall {
            request_id: "r1".into(),
            payload: ToolCallPayload { name: "ping".into(), args: serde_json::json!(null) },
        };
        let s = serde_json::to_string(&f).unwrap();
        assert!(s.contains(r#""type":"tool_call""#));
        assert!(s.contains(r#""requestId":"r1""#));
    }

    #[test]
    fn serializes_server_frame_ping() {
        assert_eq!(serde_json::to_string(&ServerFrame::Ping).unwrap(), r#"{"type":"ping"}"#);
    }
}
