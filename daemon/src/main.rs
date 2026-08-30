//! Entry point: parse `--port`/`--host`, build a multi-threaded tokio runtime,
//! and serve the axum router. Isolation from the `dsh web` Node process is the
//! whole point — heavy serialization runs here on real OS threads, never on a
//! shared event loop.

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

    let app = server::router();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("chrome-daemon: cannot bind {addr}: {e}"));
    let bound = listener.local_addr().unwrap_or(addr);
    tracing::info!(%bound, "chrome-daemon listening");

    axum::serve(listener, app).await.expect("server failed");
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
