//! axum router: mounts the three routes the bridge exposes.
//!
//!   - `POST /chrome/mcp`   — the MCP Streamable HTTP endpoint;
//!   - `GET  /chrome/ws`    — the browser extension's WebSocket;
//!   - `GET  /chrome/status` — liveness and wiring probe;
//!   - `POST /chrome/shutdown` — cooperative stop, so an upgraded `dsh web`
//!     can retire a stale daemon it does not own (it has no PID for an orphan
//!     left behind by an earlier session).

use std::sync::Arc;
use std::time::Instant;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio::time::{interval, Duration};

use crate::build_id;
use crate::hub::{Hub, TOOL_TIMEOUT_MS};
use crate::mcp;
use crate::protocol::{parse_client_frame, ServerFrame};

/// Keepalive interval for a silent MV3 service worker.
const PING_INTERVAL_MS: u64 = 30_000;
/// WebSocket max message size (8 MiB), mirroring the Node fix.
const WS_MAX_MESSAGE: usize = 8 * 1024 * 1024;

/// Shared state threaded through the router.
#[derive(Clone)]
pub struct AppState {
    pub hub: Hub,
    pub started_at: Instant,
    /// Notified by `/chrome/shutdown`; awaited by the graceful-shutdown future.
    pub shutdown: Arc<Notify>,
}

/// Build the router, self-contained. Used by tests, where no one drives the
/// shutdown signal.
#[cfg(test)]
pub fn router() -> Router {
    router_with_shutdown(Arc::new(Notify::new()))
}

/// Build the router, sharing `shutdown` with the caller so a `/chrome/shutdown`
/// request can stop the server.
pub fn router_with_shutdown(shutdown: Arc<Notify>) -> Router {
    let state = AppState {
        hub: Hub::new(TOOL_TIMEOUT_MS),
        started_at: Instant::now(),
        shutdown,
    };
    Router::new()
        .route("/chrome/mcp", post(mcp_handler))
        .route("/chrome/ws", get(ws_handler))
        .route("/chrome/status", get(status_handler))
        .route("/chrome/shutdown", post(shutdown_handler))
        .with_state(state)
}

/// Only a browser extension page may open the control socket. Chrome sends
/// `Origin: chrome-extension://<id>`; anything else is refused. A non-browser
/// client (tests, curl) sends no Origin and is allowed.
fn origin_allowed(headers: &HeaderMap) -> bool {
    match headers.get("origin") {
        None => true,
        Some(v) => v.to_str().map(|s| s.starts_with("chrome-extension://")).unwrap_or(false),
    }
}

/// MCP requests. A notification yields 202 with an empty body; everything else
/// answers with `application/json`. GET declines (405).
async fn mcp_handler(State(state): State<AppState>, body: String) -> Response {
    let raw: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(mcp::parse_failure(&e.to_string()))).into_response();
        }
    };
    let response = match mcp::handle(&raw, &state.hub).await {
        Some(v) => (StatusCode::OK, Json(v)).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    };
    response
}

/// Liveness and wiring probe.
async fn status_handler(State(state): State<AppState>) -> Json<Value> {
    let (connected, version) = state.hub.extension_state().await;
    Json(json!({
        "name": mcp::SERVER_NAME,
        "version": mcp::server_version(),
        // Content hash of this process's executable. dsh web compares it with
        // the binary on disk to detect a daemon left over from an older build;
        // the version string cannot, because releases do not bump Cargo.toml.
        "build": build_id::build_hash(),
        "protocolVersion": mcp::PROTOCOL_VERSION,
        "running": true,
        "extension_connected": connected,
        "extension_version": version,
        "uptime_seconds": state.started_at.elapsed().as_secs()
    }))
}

/// Cooperative shutdown, so an upgraded `dsh web` can retire a stale daemon.
///
/// Guarded by the same origin check as the control socket: a web page cannot
/// stop the daemon, while a local caller without an `Origin` header (dsh web,
/// curl) may. The reply is sent before the server winds down.
async fn shutdown_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    tracing::info!("shutdown requested over HTTP");
    state.shutdown.notify_waiters();
    (StatusCode::ACCEPTED, "shutting down").into_response()
}

/// WebSocket upgrade handler for the extension.
async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    ws.max_message_size(WS_MAX_MESSAGE)
        .on_upgrade(move |socket| serve_extension(socket, state))
}

/// Pump one extension socket until it closes.
async fn serve_extension(socket: WebSocket, state: AppState) {
    // One channel + writer task: frames handed to `outbound` land on the socket.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let tx = Arc::new(tx);
    let outbound: Arc<dyn Fn(&ServerFrame) -> bool + Send + Sync> = {
        let tx = tx.clone();
        Arc::new(move |frame: &ServerFrame| {
            let text = serde_json::to_string(frame).unwrap_or_default();
            tx.send(Message::Text(text.into())).is_ok()
        })
    };

    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    state.hub.attach(outbound.clone()).await;
    tracing::info!("chrome extension connected");

    let hub = state.hub.clone();
    let pinger = tokio::spawn({
        let hub = hub.clone();
        async move {
            let mut tick = interval(Duration::from_millis(PING_INTERVAL_MS));
            tick.tick().await; // first immediate
            loop {
                tick.tick().await;
                hub.ping().await;
            }
        }
    });

    // Drive incoming messages.
    loop {
        match stream.next().await {
            Some(Ok(msg)) => {
                if let Message::Text(text) = msg {
                    if let Some(frame) = parse_client_frame(text.as_str()) {
                        match frame {
                            crate::protocol::ClientFrame::Hello { extension_version } => {
                                tracing::info!("hello from extension {extension_version}");
                                hub.record_hello(extension_version).await;
                                let _ = outbound(&ServerFrame::HelloAck);
                            }
                            crate::protocol::ClientFrame::Pong => {}
                            crate::protocol::ClientFrame::ToolResult { response_to_request_id, data, error } => {
                                let outcome = match error {
                                    Some(e) => crate::hub::DispatchOutcome::Error(e),
                                    None => crate::hub::DispatchOutcome::Answer(data.unwrap_or(Value::Null)),
                                };
                                hub.resolve(&response_to_request_id, outcome).await;
                            }
                        }
                    } else {
                        tracing::warn!("invalid frame from extension");
                    }
                }
            }
            _ => break,
        }
    }

    pinger.abort();
    hub.detach(&outbound).await;
    tracing::info!("chrome extension disconnected");
    let _ = writer.await;
    let _ = tx; // keep the sender alive until the writer drains
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn status_is_json() {
        let app = router();
        let resp = app
            .oneshot(Request::builder().uri("/chrome/status").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["name"], "dsh-chrome");
        assert_eq!(v["running"], true);
    }

    #[tokio::test]
    async fn mcp_initialize() {
        let app = router();
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/chrome/mcp")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["result"]["serverInfo"]["name"], "dsh-chrome");
    }

    #[tokio::test]
    async fn mcp_tools_list() {
        let app = router();
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/chrome/mcp")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["result"]["tools"].as_array().unwrap().len(), 27);
    }

    #[tokio::test]
    async fn mcp_parse_error() {
        let app = router();
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/chrome/mcp")
                    .header("content-type", "application/json")
                    .body(Body::from("not json"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn origin_allowed_chrome_extension() {
        let mut h = HeaderMap::new();
        h.insert("origin", "chrome-extension://abc".parse().unwrap());
        assert!(origin_allowed(&h));
    }

    #[test]
    fn origin_blocked_web_page() {
        let mut h = HeaderMap::new();
        h.insert("origin", "https://evil.com".parse().unwrap());
        assert!(!origin_allowed(&h));
    }

    #[test]
    fn origin_allowed_when_absent() {
        let h = HeaderMap::new();
        assert!(origin_allowed(&h));
    }
}
