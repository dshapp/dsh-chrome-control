//! Who may call `/host/*`.
//!
//! These routes execute subprocesses on the user's machine, so they are guarded
//! separately from `/chrome/*` — and deliberately *not* by reusing
//! [`crate::server::origin_allowed`], whose policy is wrong here in two ways:
//!
//!   - it accepts any `chrome-extension://` prefix, which would let *any*
//!     installed extension drive git and the plugin manager;
//!   - it accepts a missing `Origin`, because a non-browser client (curl, the
//!     test suite) legitimately drives the control socket. For `/host/*` the
//!     absent header is the signature of exactly the caller we cannot vouch for.
//!
//! # The security model, stated plainly
//!
//! This is an **Origin-only** guard, by explicit product decision. `Origin` is
//! trustworthy only because a *browser* sets it and refuses to let a page lie;
//! a local process can send whatever it likes. Measured, not assumed:
//!
//! ```text
//! curl -H 'Origin: chrome-extension://<our id>'  -> passes
//! curl with no Origin header                     -> passes the old helper
//! a web page claiming a chrome-extension origin  -> impossible
//! ```
//!
//! So the guard below stops **web pages** and **other extensions**, and does
//! **not** stop another local process running as this user. That is accepted:
//! such a process can already run `git` and `pnpm` directly, so `/host/*` does
//! not widen what it can do — it only saves it the trouble. The compensating
//! controls are what actually matter, and none of them may be relaxed:
//!
//!   1. the subcommand *and option* allowlists in [`crate::host_exec`];
//!   2. the server operations taking no caller-supplied command, pid, or
//!      package name;
//!   3. `POST /host/disable`, the user's kill switch;
//!   4. refusing to serve `/host/*` at all when bound off the loopback.
//!
//! Do not "fix" this file by adding a token without revisiting that decision,
//! and do not loosen it further on the grounds that it is already loose.

use axum::http::HeaderMap;

/// The one extension allowed to drive host operations.
///
/// The id is fixed by the `key` in the extension's manifest, and is the same id
/// the Native Messaging host manifest pins in its `allowed_origins`.
pub const ALLOWED_ORIGIN: &str = "chrome-extension://hjgcllfkbkhmggdopnfhhmaiaedacnpg";

/// Reject anything that is not exactly our extension.
///
/// Compared with `==` rather than a prefix test: `starts_with("chrome-extension://")`
/// would admit every other installed extension.
pub fn permits(headers: &HeaderMap) -> Result<(), &'static str> {
    match headers.get("origin").and_then(|v| v.to_str().ok()) {
        Some(origin) if origin == ALLOWED_ORIGIN => Ok(()),
        Some(_) => Err("origin not authorized"),
        // A browser always sends Origin on a cross-origin fetch. Its absence
        // means the caller is not a browser, which is the one case this guard
        // cannot vouch for at all.
        None => Err("origin required"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with(origin: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("origin", origin.parse().unwrap());
        h
    }

    #[test]
    fn exact_extension_origin_is_allowed() {
        assert!(permits(&headers_with(ALLOWED_ORIGIN)).is_ok());
    }

    #[test]
    fn missing_origin_is_rejected() {
        // Deliberately the opposite of server::origin_allowed, which allows a
        // headerless caller. Asserted so a later "let's unify these" refactor
        // fails loudly instead of silently opening /host/* to every local process.
        assert_eq!(permits(&HeaderMap::new()), Err("origin required"));
    }

    #[test]
    fn web_page_origin_is_rejected() {
        assert_eq!(permits(&headers_with("https://evil.com")), Err("origin not authorized"));
    }

    #[test]
    fn another_extension_is_rejected() {
        // The prefix-matching policy used by /chrome/* would accept this.
        assert_eq!(
            permits(&headers_with("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
            Err("origin not authorized")
        );
    }

    #[test]
    fn a_prefix_of_the_allowed_origin_is_rejected() {
        // Guards against someone reintroducing starts_with in either direction.
        assert!(permits(&headers_with("chrome-extension://hjgcllfkbkhmggdopnfhhmaiaedacnp")).is_err());
        assert!(permits(&headers_with("chrome-extension://hjgcllfkbkhmggdopnfhhmaiaedacnpgX")).is_err());
    }

    #[test]
    fn a_non_ascii_origin_header_is_rejected_not_panicking() {
        let mut h = HeaderMap::new();
        h.insert("origin", axum::http::HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        // to_str() fails -> treated as absent -> rejected.
        assert!(permits(&h).is_err());
    }
}
