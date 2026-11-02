//! Who may reach the daemon at all: one gate in front of every route.
//!
//! The daemon has exactly two legitimate callers, and they are told apart by
//! headers a browser sets and a web page cannot change:
//!
//! | caller | routes | `Origin` |
//! |---|---|---|
//! | the DSH Chrome extension | `/chrome/ws`, `/host/*` | exactly [`ALLOWED_ORIGIN`] |
//! | `dsh web` (Node)         | everything else        | absent |
//!
//! A browser always attaches `Origin` to a POST, to a cross-site `no-cors`
//! request, to a form submission and to a WebSocket handshake, and a page can
//! neither drop nor forge it. So "no `Origin`" rules out every page, and "this
//! exact extension `Origin`" rules out pages and every other extension.
//!
//! `Host` closes DNS rebinding: a page that rebinds its own name to 127.0.0.1
//! becomes same-origin with us, but its requests still say `Host: evil.com`.
//!
//! Deliberately not covered: another local process running as this user. It
//! can send any header — and it could equally read a token file, so a token
//! would not change that. See `host_guard` for why that is accepted.
//!
//! The policy is default-deny for browsers: a route added later is local-only
//! (no `Origin`) unless it is listed in [`is_extension_route`].

use axum::extract::Request;
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Json, Response};
use serde_json::json;

use crate::host_guard::ALLOWED_ORIGIN;

/// Routes the extension calls. Everything else is for `dsh web` only.
fn is_extension_route(path: &str) -> bool {
    path == "/chrome/ws" || path.starts_with("/host/")
}

/// Whether the `Host` header, when present, names the loopback.
///
/// An absent header passes: every browser sends one, so its absence already
/// means a non-browser caller. The port is not compared — the listener only
/// receives traffic for its own port, and rebinding is about the name.
fn host_allowed(headers: &HeaderMap) -> bool {
    let Some(value) = headers.get("host") else { return true };
    let Ok(host) = value.to_str() else { return false };
    let name = if let Some(rest) = host.strip_prefix('[') {
        // Bracketed IPv6 literal: "[::1]" or "[::1]:37086".
        match rest.split_once(']') {
            Some((addr, tail)) if tail.is_empty() || tail.starts_with(':') => return addr == "::1",
            _ => return false,
        }
    } else {
        host.split(':').next().unwrap_or("")
    };
    name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost")
}

/// The admission decision, separated from the middleware so it is testable
/// without a router.
pub fn check(path: &str, headers: &HeaderMap) -> Result<(), &'static str> {
    if !host_allowed(headers) {
        return Err("host not allowed");
    }
    // A non-ASCII Origin is still an Origin: treat it as present and wrong.
    let origin = headers.get("origin").map(|v| v.to_str().unwrap_or("\u{fffd}"));
    if is_extension_route(path) {
        match origin {
            Some(o) if o == ALLOWED_ORIGIN => Ok(()),
            Some(_) => Err("origin not authorized"),
            None => Err("origin required"),
        }
    } else {
        match origin {
            None => Ok(()),
            Some(_) => Err("browser origin not allowed"),
        }
    }
}

/// Middleware wrapping the whole router.
pub async fn guard(request: Request, next: Next) -> Response {
    if let Err(reason) = check(request.uri().path(), request.headers()) {
        // Attacker-controlled values: bounded before they reach the log.
        let bounded = |name: &str| -> String {
            request
                .headers()
                .get(name)
                .map(|v| v.to_str().unwrap_or("<non-ascii>").chars().take(120).collect())
                .unwrap_or_else(|| "<none>".to_string())
        };
        let (origin, host) = (bounded("origin"), bounded("host"));
        let path: String = request.uri().path().chars().take(120).collect();
        tracing::warn!(%path, %origin, %host, reason, "refused a request");
        return (StatusCode::FORBIDDEN, Json(json!({ "error": reason }))).into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::router;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    const OLD_DEV_ORIGIN: &str = "chrome-extension://hjgcllfkbkhmggdopnfhhmaiaedacnpg";

    fn req(method: &str, path: &str, origin: Option<&str>, host: Option<&str>, body: &str) -> Request<Body> {
        let mut b = Request::builder().method(method).uri(path);
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        if let Some(h) = host {
            b = b.header("host", h);
        }
        b.header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()
    }

    async fn status(r: Request<Body>) -> StatusCode {
        router().oneshot(r).await.unwrap().status()
    }

    const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;

    #[tokio::test]
    async fn mcp_admits_a_local_caller_without_origin() {
        assert_eq!(status(req("POST", "/chrome/mcp", None, Some("127.0.0.1:37086"), INIT)).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn mcp_refuses_every_browser_origin_including_ours() {
        for origin in ["https://evil.com", "null", ALLOWED_ORIGIN, OLD_DEV_ORIGIN] {
            assert_eq!(
                status(req("POST", "/chrome/mcp", Some(origin), Some("127.0.0.1:37086"), INIT)).await,
                StatusCode::FORBIDDEN,
                "origin {origin} must not reach /chrome/mcp"
            );
        }
    }

    #[tokio::test]
    async fn status_accepts_loopback_hosts_only() {
        for host in ["127.0.0.1:37086", "localhost:37086", "LOCALHOST", "[::1]:37086", "[::1]"] {
            assert_eq!(status(req("GET", "/chrome/status", None, Some(host), "")).await, StatusCode::OK, "host {host}");
        }
        for host in ["evil.com:37086", "evil.com", "127.0.0.1.evil.com:37086", "[::2]:37086", "[::1]x", "0.0.0.0:37086"] {
            assert_eq!(
                status(req("GET", "/chrome/status", None, Some(host), "")).await,
                StatusCode::FORBIDDEN,
                "host {host} must be refused (DNS rebinding)"
            );
        }
    }

    #[tokio::test]
    async fn shutdown_from_a_web_page_is_refused_before_it_fires() {
        let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
        let app = crate::server::router_with_shutdown(shutdown.clone());
        let fired = shutdown.notified();
        tokio::pin!(fired);
        // Register the waiter before sending, so a notify would be observed.
        fired.as_mut().enable();
        let resp = app.oneshot(req("POST", "/chrome/shutdown", Some("https://evil.com"), None, "")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let woke = tokio::time::timeout(std::time::Duration::from_millis(50), fired).await;
        assert!(woke.is_err(), "a refused shutdown must not notify");
    }

    #[tokio::test]
    async fn ws_requires_exactly_our_extension() {
        for origin in [None, Some("https://evil.com"), Some("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), Some(OLD_DEV_ORIGIN)] {
            assert_eq!(
                status(req("GET", "/chrome/ws", origin, Some("127.0.0.1:37086"), "")).await,
                StatusCode::FORBIDDEN,
                "origin {origin:?} must not open the control socket"
            );
        }
    }

    #[test]
    fn ws_admits_our_extension() {
        let mut h = HeaderMap::new();
        h.insert("origin", ALLOWED_ORIGIN.parse().unwrap());
        h.insert("host", "127.0.0.1:37086".parse().unwrap());
        assert_eq!(check("/chrome/ws", &h), Ok(()));
    }

    #[tokio::test]
    async fn host_routes_admit_the_new_id_and_refuse_the_old_one() {
        assert_eq!(status(req("POST", "/host/capabilities", Some(ALLOWED_ORIGIN), None, "{}")).await, StatusCode::OK);
        assert_eq!(
            status(req("POST", "/host/capabilities", Some(OLD_DEV_ORIGIN), None, "{}")).await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn unknown_routes_default_to_local_only() {
        assert_eq!(status(req("GET", "/nope", None, None, "")).await, StatusCode::NOT_FOUND);
        assert_eq!(status(req("GET", "/nope", Some("https://evil.com"), None, "")).await, StatusCode::FORBIDDEN);
        // A path that merely resembles an extension route stays local-only.
        assert_eq!(status(req("GET", "/chrome/wsx", Some(ALLOWED_ORIGIN), None, "")).await, StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_non_ascii_origin_is_present_and_wrong() {
        let mut h = HeaderMap::new();
        h.insert("origin", axum::http::HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        assert!(check("/chrome/mcp", &h).is_err());
        assert!(check("/chrome/ws", &h).is_err());
    }

    #[test]
    fn a_non_ascii_host_is_refused() {
        let mut h = HeaderMap::new();
        h.insert("host", axum::http::HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        assert_eq!(check("/chrome/status", &h), Err("host not allowed"));
    }
}
