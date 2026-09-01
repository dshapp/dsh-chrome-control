//! Entry point: parse `--port`/`--host`, build a multi-threaded tokio runtime,
//! and serve the axum router. Isolation from the `dsh web` Node process is the
//! whole point — heavy serialization runs here on real OS threads, never on a
//! shared event loop.
//!
//! The daemon is spawned detached and outlives `dsh web`: it is not reaped by a
//! parent, so it owns its own shutdown path (SIGINT/SIGTERM below) and must
//! survive its stdio pipes being closed when the parent goes away (SIGPIPE).

mod build_id;
mod host_exec;
mod host_guard;
mod host_routes;
mod host_server_ops;
mod hub;
mod mcp;
mod protocol;
mod server;
mod tools_catalog;

use std::net::SocketAddr;

const DEFAULT_PORT: u16 = 37086;
const DEFAULT_HOST: &str = "127.0.0.1";

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("chrome_daemon=info".parse().unwrap()))
        .init();

    let port = parse_port().unwrap_or(DEFAULT_PORT);
    let host = parse_host().unwrap_or(DEFAULT_HOST.to_string());
    let addr: SocketAddr = format!("{host}:{port}").parse().expect("invalid --host/--port");

    // The parent's stdio pipe read ends close when dsh web exits. Without this,
    // the next log write raises SIGPIPE, whose default action is termination —
    // which would defeat running detached. Ignoring it degrades those writes to
    // ordinary EPIPE errors that tracing discards.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    // The /host/* routes execute subprocesses, and their only caller check is
    // an Origin header. That is defensible for a loopback listener, where the
    // caller is already a local process that could run those commands itself;
    // it is not defensible on a routable address. So the surface is withdrawn
    // rather than served with a weaker guarantee than it appears to have.
    let host_loopback = addr.ip().is_loopback();
    if !host_loopback {
        tracing::warn!(
            %addr,
            "not bound to loopback: /host/* is disabled (Chrome control is unaffected)"
        );
    }

    // Shared with the router so POST /chrome/shutdown can stop this server.
    let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
    let app = server::router_with_options(shutdown.clone(), host_loopback);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("chrome-daemon: cannot bind {addr}: {e}"));
    let bound = listener.local_addr().unwrap_or(addr);
    tracing::info!(%bound, "chrome-daemon listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown))
        .await
        .expect("server failed");

    tracing::info!("chrome-daemon shut down");
}

/// Resolve on SIGINT, SIGTERM, or a `POST /chrome/shutdown` request, so both an
/// operator with `kill` and an upgrading `dsh web` can stop the persistent
/// daemon and have in-flight requests finish first.
async fn shutdown_signal(shutdown: std::sync::Arc<tokio::sync::Notify>) {
    // Register the waiter *before* select! starts polling: notify_waiters()
    // only wakes waiters that already exist, so a request arriving in the gap
    // would otherwise be missed.
    let requested = shutdown.notified();
    tokio::pin!(requested);

    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            // Without a SIGTERM handler, fall back to SIGINT alone rather than
            // resolving immediately (which would shut the server down at once).
            Err(e) => {
                tracing::warn!(%e, "cannot install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("SIGINT received; shutting down"),
        _ = terminate => tracing::info!("SIGTERM received; shutting down"),
        _ = requested => tracing::info!("HTTP shutdown request; shutting down"),
    }
}

fn parse_port() -> Option<u16> {
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        if arg == "--port" {
            return it.next().and_then(|v| v.parse().ok());
        }
        if let Some(v) = arg.strip_prefix("--port=") {
            return v.parse().ok();
        }
    }
    None
}

fn parse_host() -> Option<String> {
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        if arg == "--host" {
            return it.next();
        }
        if let Some(v) = arg.strip_prefix("--host=") {
            return Some(v.to_string());
        }
    }
    None
}
