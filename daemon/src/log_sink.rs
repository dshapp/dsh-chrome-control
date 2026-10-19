//! Logging that cannot hurt the daemon.
//!
//! The daemon runs detached and outlives the `dsh web` that spawned it. When an
//! older plugin spawned it with piped stdio, the parent's exit leaves those pipes
//! without a reader, and every log write fails with EPIPE from then on.
//!
//! Ignoring SIGPIPE (see `main`) only turns that into an error *value*.
//! tracing-subscriber's fmt layer then reports the failed write itself, with
//! `eprintln!` to stderr — the same dead pipe — and `eprintln!` panics when it
//! cannot write. The panic lands in whichever task logged: for the extension
//! socket that was the line right after the socket attached to the hub, so the
//! hub kept dispatching tool calls to a connection whose reader had died. No
//! hello, pong or tool_result was ever read again, the extension looked
//! disconnected, and every `mcp__chrome__*` call timed out.
//!
//! So logging is made infallible at both levels: the writer swallows its own
//! errors, and the subscriber is told not to report internal errors (see
//! `main`). A dead log destination costs log lines and nothing else.

use std::io::{self, Write};

/// A writer whose writes always succeed, whatever the inner writer says.
pub struct LossyWriter<W: Write>(pub W);

impl<W: Write> Write for LossyWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = self.0.write_all(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let _ = self.0.flush();
        Ok(())
    }
}

/// The daemon's log destination: stdout, made lossy. Passed to
/// `tracing_subscriber::fmt().with_writer(...)` as a `MakeWriter`.
pub fn stdout() -> LossyWriter<io::Stdout> {
    LossyWriter(io::stdout())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Behaves like a pipe whose reader is gone.
    struct BrokenPipe;

    impl Write for BrokenPipe {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }
    }

    #[test]
    fn swallows_a_broken_pipe() {
        let mut w = LossyWriter(BrokenPipe);
        assert_eq!(w.write(b"hello").unwrap(), 5);
        w.write_all(b"chrome extension connected\n").unwrap();
        w.flush().unwrap();
    }

    #[test]
    fn passes_bytes_through_when_healthy() {
        let mut w = LossyWriter(Vec::new());
        w.write_all(b"listening").unwrap();
        assert_eq!(w.0, b"listening");
    }

    /// The whole chain, as `main` builds it: a failing destination must not
    /// make logging panic (it used to, through tracing's eprintln! fallback).
    #[test]
    fn logging_into_a_dead_destination_does_not_panic() {
        let subscriber = tracing_subscriber::fmt()
            .with_writer(|| LossyWriter(BrokenPipe))
            .log_internal_errors(false)
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("chrome extension connected");
            tracing::warn!("still alive");
        });
    }
}
