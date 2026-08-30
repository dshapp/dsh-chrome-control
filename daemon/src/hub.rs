//! The extension hub: owns the single live extension socket, routes tool calls
//! to it, and matches answers back to their waiting callers by `requestId`.
//!
//! Exactly one extension may be attached at a time. A newer connection wins,
//! because the common cause of a second connection is Chrome resurrecting the
//! MV3 service worker after the old socket died silently; refusing the new one
//! would strand the server on a dead peer.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

use crate::protocol::{ServerFrame, ToolCallPayload};

/// Default dispatch timeout (30 s).
pub const TOOL_TIMEOUT_MS: u64 = 30_000;

/// Why a dispatched tool call did not produce a result.
#[derive(Debug)]
pub enum DispatchOutcome {
    Answer(Value),
    Error(String),
    NotConnected,
    Timeout,
    Disconnected,
}

/// Failure messages naming the concrete recovery step.
const NOT_CONNECTED_MSG: &str = "No Chrome extension is attached. Ask the user to open Chrome, load the DSH Chrome Bridge extension at chrome://extensions (Developer mode -> Load unpacked), and make sure its popup toggle is enabled.";
const TIMEOUT_MSG: &str = "The Chrome extension did not answer in time. The page may be busy or the tab may have been closed; retry with a narrower selector or a fresh navigate.";
const DISCONNECTED_MSG: &str = "The Chrome extension disconnected while this call was running. Ask the user to check that Chrome is still open, then retry.";

impl DispatchOutcome {
    pub fn into_message(self) -> String {
        match self {
            DispatchOutcome::Answer(_) => String::new(),
            DispatchOutcome::Error(m) => m,
            DispatchOutcome::NotConnected => NOT_CONNECTED_MSG.into(),
            DispatchOutcome::Timeout => TIMEOUT_MSG.into(),
            DispatchOutcome::Disconnected => DISCONNECTED_MSG.into(),
        }
    }
}

type Outbound = Arc<dyn Fn(&ServerFrame) -> bool + Send + Sync>;

struct Waiter {
    settle: oneshot::Sender<DispatchOutcome>,
}

#[derive(Default)]
struct HubInner {
    outbound: Option<Outbound>,
    waiters: HashMap<String, Waiter>,
    connected: bool,
    extension_version: String,
    next_id: u64,
}

/// Routes tool calls to the one live extension socket and answers back.
#[derive(Clone)]
pub struct Hub {
    inner: Arc<Mutex<HubInner>>,
    timeout_ms: Duration,
}

impl Hub {
    pub fn new(timeout_ms: u64) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HubInner::default())),
            timeout_ms: Duration::from_millis(timeout_ms),
        }
    }

    /// Snapshot of the attached extension, for `/chrome/status`.
    pub async fn extension_state(&self) -> (bool, String) {
        let g = self.inner.lock().await;
        (g.connected, g.extension_version.clone())
    }

    /// Attach a new socket, replacing and failing over any previous one.
    pub async fn attach(&self, outbound: Outbound) {
        let mut g = self.inner.lock().await;
        let previous = g.outbound.take();
        g.outbound = Some(outbound.clone());
        g.connected = true;
        if previous.is_some() {
            fail_all(&mut g);
        }
    }

    /// Record the extension's version from its `hello` frame.
    pub async fn record_hello(&self, version: String) {
        let mut g = self.inner.lock().await;
        g.connected = true;
        g.extension_version = version;
    }

    /// Detach `outbound`'s socket if it is still the live one, failing every
    /// call that was waiting on it. A stale socket's detach leaves the live
    /// one alone.
    pub async fn detach(&self, outbound: &Outbound) {
        let mut g = self.inner.lock().await;
        let is_live = g
            .outbound
            .as_ref()
            .map(|live| ptr_eq(live.as_ref(), outbound.as_ref()))
            .unwrap_or(false);
        if !is_live {
            return;
        }
        g.outbound = None;
        g.connected = false;
        g.extension_version.clear();
        fail_all(&mut g);
    }

    /// Deliver an answer to whoever is waiting for `request_id`.
    pub async fn resolve(&self, request_id: &str, outcome: DispatchOutcome) {
        let waiter = {
            let mut g = self.inner.lock().await;
            g.waiters.remove(request_id)
        };
        if let Some(w) = waiter {
            let _ = w.settle.send(outcome);
        }
    }

    /// Ask the live socket to send a liveness probe.
    pub async fn ping(&self) {
        let g = self.inner.lock().await;
        if let Some(outbound) = &g.outbound {
            outbound(&ServerFrame::Ping);
        }
    }

    /// Send one tool call to the extension and await its answer.
    pub async fn dispatch(&self, name: &str, args: Value) -> DispatchOutcome {
        let (request_id, outbound, rx) = {
            let mut g = self.inner.lock().await;
            let outbound = match g.outbound.as_ref() {
                Some(o) => o.clone(),
                None => return DispatchOutcome::NotConnected,
            };
            g.next_id += 1;
            let request_id = format!("r{}", g.next_id);
            let (tx, rx) = oneshot::channel();
            g.waiters.insert(request_id.clone(), Waiter { settle: tx });
            (request_id, outbound, rx)
        };
        let sent = outbound(&ServerFrame::ToolCall {
            request_id: request_id.clone(),
            payload: ToolCallPayload { name: name.to_string(), args },
        });
        if !sent {
            let mut g = self.inner.lock().await;
            g.waiters.remove(&request_id);
            return DispatchOutcome::NotConnected;
        }
        match timeout(self.timeout_ms, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => DispatchOutcome::Disconnected,
            Err(_) => {
                self.inner.lock().await.waiters.remove(&request_id);
                DispatchOutcome::Timeout
            }
        }
    }
}

fn fail_all(inner: &mut HubInner) {
    let waiters = std::mem::take(&mut inner.waiters);
    for (_, w) in waiters {
        let _ = w.settle.send(DispatchOutcome::Disconnected);
    }
}

/// Compare two `Outbound` closures by pointer. `Arc<dyn Fn>` has no Eq, so we
/// compare the raw pointer of the trait object.
fn ptr_eq(a: &dyn Fn(&ServerFrame) -> bool, b: &dyn Fn(&ServerFrame) -> bool) -> bool {
    std::ptr::eq(a as *const _ as *const (), b as *const _ as *const ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn outbound_sink() -> (Outbound, Arc<std::sync::Mutex<Vec<ServerFrame>>>) {
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log2 = log.clone();
        let f: Outbound = Arc::new(move |frame: &ServerFrame| {
            log2.lock().unwrap().push(frame.clone());
            true
        });
        (f, log)
    }

    fn outbound_failing() -> Outbound {
        Arc::new(|_frame: &ServerFrame| false)
    }

    #[tokio::test]
    async fn not_connected_when_unattached() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        match hub.dispatch("snapshot", Value::Null).await {
            DispatchOutcome::NotConnected => {}
            o => panic!("expected NotConnected, got {:?}", o),
        }
    }

    #[tokio::test]
    async fn not_connected_when_send_fails() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        hub.attach(outbound_failing()).await;
        match hub.dispatch("snapshot", Value::Null).await {
            DispatchOutcome::NotConnected => {}
            o => panic!("expected NotConnected, got {:?}", o),
        }
    }

    #[tokio::test]
    async fn resolves_an_answer() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        let (outbound, log) = outbound_sink();
        hub.attach(outbound).await;
        let h = hub.clone();
        let task = tokio::spawn(async move { h.dispatch("snapshot", Value::Null).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let sent = log.lock().unwrap();
        assert_eq!(sent.len(), 1);
        let request_id = match &sent[0] {
            ServerFrame::ToolCall { request_id, .. } => request_id.clone(),
            _ => panic!("expected ToolCall"),
        };
        drop(sent);
        hub.resolve(&request_id, DispatchOutcome::Answer(json!({"ok": true})))
            .await;
        match task.await.unwrap() {
            DispatchOutcome::Answer(v) => assert_eq!(v, json!({"ok": true})),
            o => panic!("expected Answer, got {:?}", o),
        }
    }

    #[tokio::test]
    async fn resolves_a_tool_error() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        let (outbound, log) = outbound_sink();
        hub.attach(outbound).await;
        let h = hub.clone();
        let task = tokio::spawn(async move { h.dispatch("snapshot", Value::Null).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let request_id = match &log.lock().unwrap()[0] {
            ServerFrame::ToolCall { request_id, .. } => request_id.clone(),
            _ => panic!(),
        };
        hub.resolve(&request_id, DispatchOutcome::Error("boom".into())).await;
        match task.await.unwrap() {
            DispatchOutcome::Error(m) => assert_eq!(m, "boom"),
            o => panic!("expected Error, got {:?}", o),
        }
    }

    #[tokio::test]
    async fn times_out_when_no_answer() {
        let hub = Hub::new(50);
        let (outbound, _) = outbound_sink();
        hub.attach(outbound).await;
        let start = std::time::Instant::now();
        match hub.dispatch("snapshot", Value::Null).await {
            DispatchOutcome::Timeout => {}
            o => panic!("expected Timeout, got {:?}", o),
        }
        assert!(start.elapsed() >= Duration::from_millis(45));
    }

    #[tokio::test]
    async fn newer_connection_fails_over_in_flight() {
        let hub = Hub::new(TOOL_TIMEOUT_MS);
        let (outbound1, _) = outbound_sink();
        let (outbound2, _log2) = outbound_sink();
        hub.attach(outbound1).await;
        let h = hub.clone();
        let task = tokio::spawn(async move { h.dispatch("snapshot", Value::Null).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        // A second attach should fail the in-flight call with Disconnected.
        hub.attach(outbound2).await;
        match task.await.unwrap() {
            DispatchOutcome::Disconnected => {}
            o => panic!("expected Disconnected, got {:?}", o),
        }
    }
}
