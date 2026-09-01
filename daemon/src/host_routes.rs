//! The `/host/*` routes: host capabilities the extension cannot perform itself.
//!
//! Kept deliberately separate from `/chrome/*`:
//!
//!   - `/chrome/mcp` is JSON-RPC for the agent; these are plain REST for the
//!     extension's own settings UI. Sharing a codec would couple two things
//!     that change for unrelated reasons.
//!   - The two have different guards. `/chrome/*` admits a caller with no
//!     `Origin`; `/host/*` must not, because it runs subprocesses. See
//!     [`crate::host_guard`].
//!   - Nothing here touches the control WebSocket. Opening a second connection
//!     to `/chrome/ws` makes the hub fail the extension's in-flight calls and
//!     drop it for tens of seconds, so host operations ride their own HTTP
//!     surface instead.
//!
//! No CORS headers are set anywhere in this module. The extension is exempt
//! from CORS for hosts in its `host_permissions`, so it does not need them, and
//! adding them would hand the same routes to ordinary web pages.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

use crate::build_id;
use crate::host_exec::{self, ExecOutput};
use crate::host_guard;
use crate::host_server_ops::{self as ops, RealSystem, ServerOpError};
use crate::mcp;
use crate::server::AppState;

/// Request bodies are tiny; a cap keeps a hostile local caller from making the
/// daemon buffer megabytes before validation runs.
const BODY_LIMIT: usize = 64 * 1024;

/// Serialized access to the two operations that must not interleave.
///
/// Two concurrent restarts would race to kill and respawn the same port; two
/// concurrent installs would fight over the pnpm store lock.
#[derive(Clone, Default)]
pub struct HostLocks {
    pub restart: Arc<Mutex<()>>,
    pub update: Arc<Mutex<()>>,
}

#[derive(Deserialize)]
struct GitRequest {
    cwd: String,
    args: Vec<String>,
}

#[derive(Deserialize)]
struct PluginRequest {
    action: String,
    #[serde(default)]
    name: Option<String>,
    // Note there is no `profile` field on purpose: the profile names the
    // directory pnpm runs in, so it comes from the daemon's environment. A body
    // that carries one is ignored by serde rather than honoured.
}

/// Mount the host routes.
pub fn router() -> Router<AppState> {
    Router::new()
        // POST, not GET, and not merely for symmetry with the rest.
        //
        // Chrome omits the `Origin` header on a simple GET from an extension
        // page, so an Origin-only guard rejected the extension itself — found
        // by running the real side panel, not by any unit test. POST with
        // `application/json` is a preflighted request, so Chrome always sends
        // Origin, which is also the property the guard depends on. GET is kept
        // as a 405-ing alias rather than removed, so an older extension asking
        // the old way gets a clear method error instead of a confusing 403.
        .route("/host/capabilities", post(capabilities).get(capabilities_get_rejected))
        .route("/host/git", post(git))
        .route("/host/plugin", post(plugin))
        .route("/host/server/version", post(server_version))
        .route("/host/server/restart", post(server_restart))
        .route("/host/server/update", post(server_update))
        .route("/host/disable", post(disable))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
}

fn forbidden(reason: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": reason }))).into_response()
}

fn bad_request(reason: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": reason }))).into_response()
}

/// The gate every route passes through.
///
/// Logs refusals (without echoing a full attacker-controlled header into the
/// log line unbounded) so probing is visible in the daemon's output.
fn admit(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    if let Err(reason) = host_guard::permits(headers) {
        let origin = headers
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .map(|o| o.chars().take(120).collect::<String>())
            .unwrap_or_else(|| "<none>".to_string());
        tracing::warn!(%origin, reason, "refused a /host request");
        return Err(forbidden(reason));
    }
    // Checked after the origin so a disabled proxy does not tell an
    // unauthorized caller anything about the daemon's state.
    if state.host_disabled.load(Ordering::Relaxed) {
        return Err(forbidden("host proxy disabled"));
    }
    if !state.host_loopback {
        // Bound to a routable address: the subprocess surface would be exposed
        // to the network, which no allowlist makes acceptable.
        return Err(forbidden("host proxy disabled: daemon is not bound to loopback"));
    }
    Ok(())
}

/// Render a finished command as the shape every command route returns.
fn exec_response(out: ExecOutput) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            // A non-zero exit is a *successful* HTTP call carrying the tool's
            // own failure: the UI needs git's stderr verbatim, not a 500.
            "exitCode": out.exit_code,
            "stdout": out.stdout,
            "stderr": out.stderr,
            "stdoutTruncated": out.stdout_truncated,
            "stderrTruncated": out.stderr_truncated,
        })),
    )
        .into_response()
}

fn exec_failure(err: host_exec::ExecError) -> Response {
    let status = match err {
        host_exec::ExecError::Timeout => StatusCode::GATEWAY_TIMEOUT,
        host_exec::ExecError::Spawn(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(json!({ "error": err.message() }))).into_response()
}

fn server_op_failure(err: ServerOpError) -> Response {
    let status = if err.is_client_error() { StatusCode::BAD_REQUEST } else { StatusCode::INTERNAL_SERVER_ERROR };
    let body = match &err {
        ServerOpError::DshNotInstalledViaPnpm => {
            json!({ "error": err.message(), "reason": "dsh-not-installed-via-pnpm" })
        }
        _ => json!({ "error": err.message() }),
    };
    (status, Json(body)).into_response()
}

/// What this daemon can do for the extension.
///
/// Guarded like the rest despite being a read: an unguarded GET is exactly the
/// shape that let a page trigger a side effect in an earlier prototype, and
/// leaving one here would invite the same mistake back.
async fn capabilities(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = admit(&state, &headers) {
        return response;
    }
    Json(json!({
        "git": true,
        "plugin": true,
        "server": true,
        "version": mcp::server_version(),
        // Same identity /chrome/status reports, so the extension can tell that
        // the daemon it is talking to has been replaced.
        "build": build_id::build_hash(),
    }))
    .into_response()
}

/// Explain why a GET here cannot work, instead of failing the Origin check.
///
/// A bare GET carries no `Origin` from a Chrome extension page, so this route
/// could never authenticate the caller. Saying so beats a 403 that looks like a
/// permission problem.
async fn capabilities_get_rejected() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(json!({ "error": "use POST /host/capabilities: a GET carries no Origin header" })),
    )
        .into_response()
}

async fn git(State(state): State<AppState>, headers: HeaderMap, body: Option<Json<GitRequest>>) -> Response {
    if let Err(response) = admit(&state, &headers) {
        return response;
    }
    let Json(request) = match body {
        Some(b) => b,
        None => return bad_request("git: invalid request body".to_string()),
    };
    let home = match ops::dirs_home() {
        Some(home) => home,
        None => return bad_request("cannot determine HOME".to_string()),
    };
    let cwd = match host_exec::validate_cwd(&request.cwd, &home) {
        Ok(path) => path,
        Err(reason) => return bad_request(reason),
    };
    let args = match host_exec::validate_git(&request.args) {
        Ok(args) => args,
        Err(reason) => return bad_request(reason),
    };
    match host_exec::run(
        std::path::Path::new("git"),
        &args,
        Some(&cwd),
        &host_exec::git_env(),
        host_exec::DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(out) => exec_response(out),
        Err(err) => exec_failure(err),
    }
}

async fn plugin(State(state): State<AppState>, headers: HeaderMap, body: Option<Json<PluginRequest>>) -> Response {
    if let Err(response) = admit(&state, &headers) {
        return response;
    }
    let Json(request) = match body {
        Some(b) => b,
        None => return bad_request("plugin: invalid request body".to_string()),
    };
    let dsh = match ops::resolve_dsh() {
        Ok(path) => path,
        Err(err) => return server_op_failure(err),
    };
    let args = match host_exec::validate_plugin(&request.action, request.name.as_deref(), &ops::profile()) {
        Ok(args) => args,
        Err(reason) => return bad_request(reason),
    };
    // Installs reach the network and build packages; reads do not.
    let timeout = if request.action == "list" || request.action == "outdated" {
        host_exec::DEFAULT_TIMEOUT
    } else {
        host_exec::INSTALL_TIMEOUT
    };
    match host_exec::run(&dsh, &args, None, &std::collections::HashMap::new(), timeout).await {
        Ok(out) => exec_response(out),
        Err(err) => exec_failure(err),
    }
}

async fn server_version(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = admit(&state, &headers) {
        return response;
    }
    let current = match ops::current_version().await {
        Ok(version) => version,
        Err(err) => return server_op_failure(err),
    };
    // Offline is ordinary, so a missing `latest` is data, not an error.
    let latest = ops::latest_version().await;
    let updatable = latest.as_ref().is_some_and(|l| *l != current);
    Json(json!({ "current": current, "latest": latest, "updatable": updatable })).into_response()
}

async fn server_restart(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = admit(&state, &headers) {
        return response;
    }
    let locks = state.host_locks.clone();
    let Ok(_guard) = locks.restart.try_lock() else {
        return (StatusCode::CONFLICT, Json(json!({ "error": "a restart is already running" }))).into_response();
    };

    let dsh = match ops::resolve_dsh() {
        Ok(path) => path,
        Err(err) => return server_op_failure(err),
    };
    let port = ops::managed_port();
    let pid = match ops::verify_target(&RealSystem, port) {
        Ok(pid) => pid,
        Err(err) => return server_op_failure(err),
    };

    // Ask first, insist second: SIGTERM lets the server close its sessions.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
    let mut stopped = ops::wait_for_port(port, false, ops::stop_budget()).await;
    if !stopped {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
        stopped = ops::wait_for_port(port, false, std::time::Duration::from_secs(3)).await;
    }

    let log_path = ops::web_log_path();
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).ok();

    // Detached, with stdio pointed at a file: the new server must outlive this
    // request, and must not die when the daemon's pipes go away.
    let mut command = std::process::Command::new(&dsh);
    command.args(ops::web_args("127.0.0.1", port)).stdin(std::process::Stdio::null());
    match log {
        Some(file) => {
            let err_file = match file.try_clone() {
                Ok(clone) => clone,
                Err(_) => {
                    command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
                    let spawned = command.spawn();
                    return restart_reply(spawned, stopped, port, &log_path).await;
                }
            };
            command.stdout(file).stderr(err_file);
        }
        None => {
            command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        }
    }
    let spawned = command.spawn();
    restart_reply(spawned, stopped, port, &log_path).await
}

/// Wait for the replacement to answer, then report what happened.
async fn restart_reply(
    spawned: std::io::Result<std::process::Child>,
    stopped: bool,
    port: u16,
    log_path: &std::path::Path,
) -> Response {
    match spawned {
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("cannot start dsh web: {e}"), "stopped": stopped })),
        )
            .into_response(),
        Ok(child) => {
            let pid = child.id();
            let started = ops::wait_for_port(port, true, ops::start_budget()).await;
            Json(json!({
                "stopped": stopped,
                "started": started,
                "pid": pid,
                "port": port,
                "log": log_path.to_string_lossy(),
            }))
            .into_response()
        }
    }
}

async fn server_update(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = admit(&state, &headers) {
        return response;
    }
    let locks = state.host_locks.clone();
    let Ok(_guard) = locks.update.try_lock() else {
        return (StatusCode::CONFLICT, Json(json!({ "error": "an update is already running" }))).into_response();
    };
    // Intentionally does not restart afterwards: a restart drops the user's
    // live session, so the UI asks first.
    match ops::update().await {
        Ok(out) => exec_response(out),
        Err(err) => server_op_failure(err),
    }
}

/// Turn the whole host surface off until the daemon restarts.
///
/// The user's kill switch, and the reason it must exist: with an Origin-only
/// guard there is otherwise no way to withdraw this capability without stopping
/// Chrome control too. `/chrome/*` is unaffected.
async fn disable(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = admit(&state, &headers) {
        return response;
    }
    state.host_disabled.store(true, Ordering::Relaxed);
    tracing::info!("host proxy disabled by request");
    Json(json!({ "ok": true })).into_response()
}

#[cfg(test)]
mod tests {
    use crate::host_guard::ALLOWED_ORIGIN;
    use crate::server::{router, router_non_loopback};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::Value;
    use tower::ServiceExt;

    /// Build a request to `path`, optionally with an Origin header.
    fn request(method: &str, path: &str, origin: Option<&str>, body: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(path);
        if let Some(origin) = origin {
            builder = builder.header("origin", origin);
        }
        match body {
            Some(json) => builder.header("content-type", "application/json").body(Body::from(json.to_string())).unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        }
    }

    async fn status_of(app: axum::Router, req: Request<Body>) -> StatusCode {
        app.oneshot(req).await.unwrap().status()
    }

    async fn json_of(app: axum::Router, req: Request<Body>) -> Value {
        let resp = app.oneshot(req).await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    // ------------------------------------------------------------- the guard

    #[tokio::test]
    async fn capabilities_needs_the_right_origin() {
        let status = status_of(router(), request("POST", "/host/capabilities", Some(ALLOWED_ORIGIN), Some("{}"))).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn capabilities_is_guarded_even_though_it_is_a_get() {
        // A read with a side-effect-free body is still refused: an unguarded GET
        // is how a page reached an earlier prototype's executor.
        for origin in [None, Some("https://evil.com"), Some("chrome-extension://someotherextension")] {
            let status = status_of(router(), request("POST", "/host/capabilities", origin, Some("{}"))).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "origin {origin:?} must be refused");
        }
    }

    #[tokio::test]
    async fn git_refuses_a_missing_origin() {
        // The opposite of /chrome/*, deliberately. Asserted so a later attempt
        // to share one origin helper between the two fails here.
        let body = r#"{"cwd":"/tmp","args":["status"]}"#;
        let status = status_of(router(), request("POST", "/host/git", None, Some(body))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn git_refuses_a_web_page_origin() {
        let body = r#"{"cwd":"/tmp","args":["status"]}"#;
        let status = status_of(router(), request("POST", "/host/git", Some("https://evil.com"), Some(body))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn chrome_status_still_allows_a_headerless_caller() {
        // Proof the stricter host policy did not leak into the control routes,
        // which curl and dsh web legitimately call without an Origin.
        let status = status_of(router(), request("GET", "/chrome/status", None, None)).await;
        assert_eq!(status, StatusCode::OK);
    }

    // ------------------------------------------------------- validation path

    #[tokio::test]
    async fn git_rejects_a_forbidden_option() {
        let body = r#"{"cwd":"/tmp","args":["-c","core.pager=id","log"]}"#;
        let status = status_of(router(), request("POST", "/host/git", Some(ALLOWED_ORIGIN), Some(body))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn git_rejects_a_cwd_outside_home() {
        let body = r#"{"cwd":"/usr","args":["status"]}"#;
        let status = status_of(router(), request("POST", "/host/git", Some(ALLOWED_ORIGIN), Some(body))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn git_rejects_a_relative_cwd() {
        let body = r#"{"cwd":"repo","args":["status"]}"#;
        let status = status_of(router(), request("POST", "/host/git", Some(ALLOWED_ORIGIN), Some(body))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn plugin_rejects_an_unknown_action() {
        let body = r#"{"action":"publish"}"#;
        let resp = status_of(router(), request("POST", "/host/plugin", Some(ALLOWED_ORIGIN), Some(body))).await;
        // Either the action is refused (400) or dsh is not pnpm-installed on
        // this machine (also 400) — both are client errors, never a 5xx.
        assert_eq!(resp, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn plugin_ignores_a_profile_supplied_by_the_caller() {
        // `profile` chooses the directory pnpm runs in, so honouring it from a
        // request would mean "install anything anywhere". The field is simply
        // not part of the deserialized shape.
        let body = r#"{"action":"list","profile":"/tmp/evil"}"#;
        let status = status_of(router(), request("POST", "/host/plugin", Some(ALLOWED_ORIGIN), Some(body))).await;
        assert_ne!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn a_malformed_body_is_a_client_error() {
        let status = status_of(router(), request("POST", "/host/git", Some(ALLOWED_ORIGIN), Some("not json"))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    // ------------------------------------------------------- kill switch etc

    #[tokio::test]
    async fn disable_turns_off_every_host_route_but_leaves_chrome_alone() {
        // One router instance for the whole test: the flag lives in its state.
        let app = router();

        assert_eq!(
            status_of(app.clone(), request("POST", "/host/disable", Some(ALLOWED_ORIGIN), Some("{}"))).await,
            StatusCode::OK
        );

        for (method, path, body) in [
            ("POST", "/host/capabilities", Some("{}")),
            ("POST", "/host/git", Some(r#"{"cwd":"/tmp","args":["status"]}"#)),
            ("POST", "/host/plugin", Some(r#"{"action":"list"}"#)),
            ("POST", "/host/server/version", Some("{}")),
        ] {
            let status = status_of(app.clone(), request(method, path, Some(ALLOWED_ORIGIN), body)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{path} must be disabled");
        }

        // Chrome control is a separate capability and must survive.
        assert_eq!(
            status_of(app.clone(), request("GET", "/chrome/status", None, None)).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn a_non_loopback_listener_serves_no_host_routes() {
        let app = router_non_loopback();
        assert_eq!(
            status_of(app.clone(), request("POST", "/host/capabilities", Some(ALLOWED_ORIGIN), Some("{}"))).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status_of(app.clone(), request("GET", "/chrome/status", None, None)).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn capabilities_rejects_get_with_a_method_error_not_a_403() {
        // Chrome sends no Origin on a simple GET from an extension page, so this
        // route can never authenticate a GET caller. Measured in a real side
        // panel: the pane fell back to "unsupported" because its own probe was
        // refused. A 405 naming the right method beats a 403 that reads like a
        // permission problem.
        let resp = router()
            .oneshot(request("GET", "/host/capabilities", Some(ALLOWED_ORIGIN), None))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["error"].as_str().unwrap().contains("POST"));
    }

    #[tokio::test]
    async fn capabilities_reports_the_same_build_as_chrome_status() {
        // The extension uses this to notice it is talking to a replaced daemon,
        // so the two must not drift apart.
        let caps = json_of(router(), request("POST", "/host/capabilities", Some(ALLOWED_ORIGIN), Some("{}"))).await;
        let status = json_of(router(), request("GET", "/chrome/status", None, None)).await;
        assert_eq!(caps["build"], status["build"]);
        assert_eq!(caps["git"], true);
        assert_eq!(caps["plugin"], true);
        assert_eq!(caps["server"], true);
    }
}