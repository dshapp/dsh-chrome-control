//! Identity of the running binary, used to decide whether a live daemon is
//! stale after a plugin upgrade.
//!
//! Version strings cannot answer that question: the release workflow bumps only
//! `package.json`, never `daemon/Cargo.toml`, so a freshly shipped daemon and the
//! one it replaces routinely report the same `CARGO_PKG_VERSION`. The content
//! hash of the executable is the identity that actually changes when the binary
//! does, so `dsh web` compares that instead.

use std::sync::OnceLock;

use sha2::{Digest, Sha256};

/// Reported when the executable cannot be hashed. Callers treat this as
/// "undecidable" and reuse the daemon rather than restarting it blindly.
pub const UNKNOWN: &str = "unknown";

/// SHA-256 of this process's own executable, as lowercase hex.
///
/// Computed once and cached: the file cannot change identity underneath a
/// running process in a way that matters here, and `/chrome/status` is polled.
pub fn build_hash() -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(|| compute().unwrap_or_else(|| UNKNOWN.to_string()))
}

/// Hash the current executable, or `None` when it cannot be read (for instance
/// when the binary was replaced or deleted while running).
fn compute() -> Option<String> {
    let path = std::env::current_exe().ok()?;
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Some(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_lowercase_hex_or_unknown() {
        let first = build_hash();
        // Cached: a second call is the identical value.
        assert_eq!(first, build_hash());
        if first == UNKNOWN {
            return;
        }
        assert_eq!(first.len(), 64, "sha256 hex is 64 chars");
        assert!(first.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn matches_hashing_the_test_binary_directly() {
        if build_hash() == UNKNOWN {
            return;
        }
        // The contract dsh web relies on: the reported hash is exactly the
        // SHA-256 of the file on disk, so the Node side can reproduce it.
        let path = std::env::current_exe().expect("current_exe");
        let bytes = std::fs::read(&path).expect("read self");
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        assert_eq!(build_hash(), format!("{:x}", hasher.finalize()));
    }
}
