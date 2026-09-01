//! Running one allowlisted host command, and deciding what is allowlisted.
//!
//! With the guard reduced to an Origin check ([`crate::host_guard`]), the
//! validators in this module are the only thing standing between `/host/*` and
//! arbitrary code execution. They are written to be boring and total: an input
//! is rejected unless it is recognised, never the other way round.
//!
//! Two rules shape everything here:
//!
//!   - **Never build a shell command line.** Every invocation is
//!     `Command::new(program).args(vec)`, so no quoting, `;`, `$(...)` or glob
//!     is ever interpreted. There is no code path through `/bin/sh -c`.
//!   - **Allowlisting the subcommand is not enough; options must be filtered
//!     too.** `git -c core.pager=<anything> log` runs that anything, as do
//!     `--upload-pack` and friends. A validator that only checked `args[0]`
//!     would be a general-purpose executor wearing a git costume.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Ceiling on one command's runtime. Long enough for a `fetch` over a slow
/// link, short enough that a wedged child cannot pin a request forever.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Package installs are legitimately slower than git operations.
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);

/// Per-stream output cap, mirroring `mcp::MAX_TEXT_BYTES`: the same 256 KiB
/// ceiling the MCP layer applies, for the same reason (a huge body is a
/// serialization and transport hazard, not useful output).
pub const MAX_STREAM_BYTES: usize = 256 * 1024;

/// Appended when `log` arrives without an explicit `-n`, so an unbounded
/// history cannot become an unbounded response.
const DEFAULT_LOG_LIMIT: &str = "500";

/// Git subcommands that only read. Safe to run without ceremony.
const GIT_READ_ONLY: &[&str] = &["status", "branch", "worktree", "rev-parse", "diff", "log", "remote", "show"];

/// Git subcommands that change something. Still allowlisted, but the extension
/// confirms them with the user first; the daemon does not second-guess that.
const GIT_WRITE: &[&str] = &["checkout", "fetch", "pull", "push", "branch", "worktree"];

/// The exact options each subcommand may carry.
///
/// This is an **allowlist, not a denylist**, and the difference was not
/// academic. An earlier version enumerated the dangerous flags (`-c`,
/// `--upload-pack`, …) and let everything else through. An end-to-end test then
/// found `git log --output=/tmp/victim`, which git happily used to overwrite a
/// file outside the repository — arbitrary file write, from a flag nobody had
/// thought to ban. git has hundreds of options across its subcommands, several
/// of which write files or run programs, so enumerating the bad ones is a bet
/// that cannot be won. Enumerating the needed ones can be.
///
/// A bare `--` separator and non-option arguments (branch names, paths, commit
/// ranges) are handled separately in [`validate_git`]; only things starting with
/// `-` are matched here.
const GIT_ALLOWED_OPTIONS: &[(&str, &[&str])] = &[
    ("status", &["--porcelain", "--branch", "--short", "--long", "--untracked-files"]),
    ("branch", &["--format", "--list", "--all", "--remotes", "-a", "-r", "-d", "-v", "--verbose"]),
    // `-b` creates the branch along with the worktree. The UI passes an existing
    // branch positionally instead, but both spellings are ordinary usage.
    ("worktree", &["--porcelain", "--force", "-b", "--detach"]),
    ("rev-parse", &["--abbrev-ref", "--short", "--verify", "--git-dir", "--show-toplevel", "--is-inside-work-tree"]),
    ("diff", &["--stat", "--numstat", "--name-only", "--name-status", "--cached", "--staged", "--shortstat"]),
    ("log", &["--oneline", "--pretty", "--format", "--graph", "--decorate", "--stat", "--name-only", "-n", "--max-count", "--abbrev-commit", "--no-color"]),
    ("remote", &["-v", "--verbose", "show", "get-url"]),
    ("show", &["--stat", "--name-only", "--name-status", "--pretty", "--format", "--no-patch", "-s"]),
    ("checkout", &["-b", "--track", "--detach", "--force"]),
    ("fetch", &["--prune", "--all", "--tags", "--no-tags", "--depth"]),
    ("pull", &["--ff-only", "--rebase", "--no-rebase", "--prune"]),
    ("push", &["--set-upstream", "-u", "--tags", "--force-with-lease", "--dry-run", "--delete"]),
];

/// Plugin actions, forwarded to `dsh plugin` (itself a pnpm forwarder).
const PLUGIN_READ_ONLY: &[&str] = &["list", "outdated"];
const PLUGIN_WRITE: &[&str] = &["add", "remove", "update"];

/// A finished command. `exit_code` of `None` means killed by a signal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Why a command did not produce output.
#[derive(Debug)]
pub enum ExecError {
    /// The program could not be started (missing binary, bad cwd).
    Spawn(String),
    /// The child outlived its budget and was killed.
    Timeout,
}

impl ExecError {
    pub fn message(&self) -> String {
        match self {
            ExecError::Spawn(e) => format!("cannot run command: {e}"),
            ExecError::Timeout => "command timed out".to_string(),
        }
    }
}

/// Clip a stream to [`MAX_STREAM_BYTES`] on a char boundary, reporting whether
/// anything was dropped.
///
/// Truncating raw bytes can split a multi-byte character, so the cut is walked
/// back to the nearest boundary rather than replacing the tail with U+FFFD.
fn clip(bytes: Vec<u8>) -> (String, bool) {
    if bytes.len() <= MAX_STREAM_BYTES {
        return (String::from_utf8_lossy(&bytes).into_owned(), false);
    }
    let mut end = MAX_STREAM_BYTES;
    while end > 0 && !std::str::from_utf8(&bytes[..end]).is_ok() {
        end -= 1;
    }
    (String::from_utf8_lossy(&bytes[..end]).into_owned(), true)
}

/// Run one already-validated command.
///
/// Callers must pass `args` that came out of a validator in this module;
/// nothing here re-checks them.
pub async fn run(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
) -> Result<ExecOutput, ExecError> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    for (key, value) in env {
        command.env(key, value);
    }
    // Killing the child on drop matters for the timeout path below: without it
    // a timed-out process would keep running unparented.
    command.kill_on_drop(true);

    let mut child = command.spawn().map_err(|e| ExecError::Spawn(e.to_string()))?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    // Drain both pipes while waiting. Waiting first and reading after can
    // deadlock: a child that fills the 64 KiB pipe buffer blocks on write
    // while we block on exit.
    let collect = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let read_out = async {
            if let Some(pipe) = stdout_pipe.as_mut() {
                let _ = pipe.read_to_end(&mut out).await;
            }
            out
        };
        let read_err = async {
            if let Some(pipe) = stderr_pipe.as_mut() {
                let _ = pipe.read_to_end(&mut err).await;
            }
            err
        };
        let (out, err) = tokio::join!(read_out, read_err);
        let status = child.wait().await;
        (out, err, status)
    };

    match tokio::time::timeout(timeout, collect).await {
        Err(_) => Err(ExecError::Timeout),
        Ok((out, err, status)) => {
            let (stdout, stdout_truncated) = clip(out);
            let (stderr, stderr_truncated) = clip(err);
            Ok(ExecOutput {
                exit_code: status.ok().and_then(|s| s.code()),
                stdout,
                stderr,
                stdout_truncated,
                stderr_truncated,
            })
        }
    }
}

/// Reduce an option to the name an allowlist entry would spell.
///
/// git accepts three shapes for the same option, and all must map together or a
/// legitimate call gets refused: `--max-count=5`, `-n 5`, and the attached short
/// form `-n5`. Only single-dash short options may have a value attached; for
/// `--long` forms git always requires `=` or a separate argument, so a leading
/// `--` is left alone apart from the `=` split.
fn option_name(arg: &str) -> &str {
    if let Some((name, _)) = arg.split_once('=') {
        return name;
    }
    if arg.starts_with("--") || !arg.starts_with('-') {
        return arg;
    }
    // A short option: keep the dash and the flag letter, drop an attached value.
    let mut chars = arg.char_indices().skip(1);
    match chars.next() {
        Some((_, _)) => {
            let end = chars.next().map(|(index, _)| index).unwrap_or(arg.len());
            &arg[..end]
        }
        None => arg,
    }
}

/// Validate a `git` argument vector.
///
/// Returns the vector to execute, which may differ from the input: `log` gains
/// a row limit when the caller did not set one.
pub fn validate_git(args: &[String]) -> Result<Vec<String>, String> {
    let subcommand = args.first().ok_or_else(|| "git: no subcommand".to_string())?;

    // The subcommand must come first. Anything before it is a global option,
    // and global options are exactly the injection surface: `git -c x=y status`
    // would otherwise pass a check that only looked at "is 'status' in here".
    if subcommand.starts_with('-') {
        return Err(format!("git: options before the subcommand are not allowed: {subcommand}"));
    }
    if !GIT_READ_ONLY.contains(&subcommand.as_str()) && !GIT_WRITE.contains(&subcommand.as_str()) {
        return Err(format!("git: subcommand not allowed: {subcommand}"));
    }

    let allowed: &[&str] = GIT_ALLOWED_OPTIONS
        .iter()
        .find(|(name, _)| *name == subcommand.as_str())
        .map(|(_, options)| *options)
        .unwrap_or(&[]);

    // Everything after a bare `--` is a pathspec by git's own convention, never
    // an option, so it is checked only for NUL.
    let mut operands_only = false;
    for arg in args.iter().skip(1) {
        if arg.contains('\0') {
            return Err("git: argument contains NUL".to_string());
        }
        if operands_only {
            continue;
        }
        if arg == "--" {
            operands_only = true;
            continue;
        }
        if !arg.starts_with('-') {
            // A branch name, path, or commit range. Cannot introduce behaviour
            // on its own; the subcommand allowlist already bounds what runs.
            continue;
        }
        if !allowed.contains(&option_name(arg)) {
            return Err(format!("git: option not allowed for {subcommand}: {arg}"));
        }
    }

    let mut out = args.to_vec();
    if subcommand == "log" && !args.iter().any(|a| a == "-n" || a.starts_with("-n") || a.starts_with("--max-count")) {
        out.push("-n".to_string());
        out.push(DEFAULT_LOG_LIMIT.to_string());
    }
    Ok(out)
}

/// Validate a plugin package name.
///
/// Rejects every spec form that would make pnpm fetch from somewhere other than
/// the registry — `file:`, `link:`, `git+`, `github:` — because those install
/// from a caller-chosen location *and* run the package's `prepare` script.
fn validate_plugin_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("plugin: empty package name".to_string());
    }
    if name.len() > 128 {
        return Err("plugin: package name too long".to_string());
    }
    let lowered = name.to_ascii_lowercase();
    for prefix in ["file:", "link:", "git+", "github:", "http:", "https:", "workspace:", "portal:"] {
        if lowered.starts_with(prefix) {
            return Err(format!("plugin: package spec not allowed: {name}"));
        }
    }
    if name.contains("..") || name.contains('/') && name.starts_with('.') {
        return Err(format!("plugin: package spec not allowed: {name}"));
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphanumeric() || first == '@') {
        return Err(format!("plugin: package name must start with a letter, digit or @: {name}"));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '-' | '/')) {
        return Err(format!("plugin: package name has invalid characters: {name}"));
    }
    Ok(())
}

/// Build the `dsh plugin` argument vector for one action.
///
/// `profile` is supplied by the daemon, never by the caller: `--profile` names
/// the directory pnpm runs in, so accepting it from a request would turn this
/// into "install anything anywhere".
pub fn validate_plugin(action: &str, name: Option<&str>, profile: &str) -> Result<Vec<String>, String> {
    let known = PLUGIN_READ_ONLY.contains(&action) || PLUGIN_WRITE.contains(&action);
    if !known {
        return Err(format!("plugin: action not allowed: {action}"));
    }
    let needs_name = PLUGIN_WRITE.contains(&action);
    match (needs_name, name) {
        (true, None) => return Err(format!("plugin: {action} needs a package name")),
        (false, Some(_)) => return Err(format!("plugin: {action} takes no package name")),
        (true, Some(n)) => validate_plugin_name(n)?,
        (false, None) => {}
    }

    let mut args = vec!["plugin".to_string(), "--profile".to_string(), profile.to_string(), action.to_string()];
    if let Some(n) = name {
        args.push(n.to_string());
    }
    Ok(args)
}

/// Validate a working directory for a git command.
///
/// Must be an existing directory, spelled absolutely, with no `..` component,
/// and must still live under `$HOME` *after* symlink resolution — checking
/// before resolution would let `$HOME/link-to-elsewhere` escape.
pub fn validate_cwd(raw: &str, home: &Path) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("cwd must be an absolute path: {raw}"));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("cwd must not contain '..': {raw}"));
    }
    let resolved = path.canonicalize().map_err(|_| format!("cwd does not exist: {raw}"))?;
    if !resolved.is_dir() {
        return Err(format!("cwd is not a directory: {raw}"));
    }
    let home_resolved = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    if !resolved.starts_with(&home_resolved) {
        return Err(format!("cwd must be inside {}: {raw}", home_resolved.display()));
    }
    Ok(resolved)
}

/// Environment for git: never prompt.
///
/// Without these, `push` or `fetch` against a repo needing credentials blocks
/// on a terminal prompt that no one can answer, and the request hangs until the
/// timeout instead of failing with a usable message.
pub fn git_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("GIT_TERMINAL_PROMPT".to_string(), "0".to_string());
    env.insert("GIT_ASKPASS".to_string(), String::new());
    env.insert("SSH_ASKPASS".to_string(), String::new());
    env.insert("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string());
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    // ---------------------------------------------------------------- git

    #[test]
    fn read_only_subcommand_passes() {
        assert_eq!(validate_git(&v(&["status", "--porcelain=v2"])).unwrap(), v(&["status", "--porcelain=v2"]));
    }

    #[test]
    fn write_subcommand_passes() {
        assert!(validate_git(&v(&["push", "origin", "main"])).is_ok());
    }

    #[test]
    fn unknown_subcommand_is_rejected() {
        assert!(validate_git(&v(&["gc"])).is_err());
        assert!(validate_git(&v(&["reset", "--hard"])).is_err());
    }

    #[test]
    fn empty_args_are_rejected() {
        assert!(validate_git(&[]).is_err());
    }

    #[test]
    fn dash_c_config_injection_is_rejected() {
        // The headline case: -c core.pager=<program> executes that program.
        assert!(validate_git(&v(&["-c", "core.pager=id", "log"])).is_err());
        assert!(validate_git(&v(&["log", "-c", "core.pager=id"])).is_err());
        assert!(validate_git(&v(&["log", "-c=core.pager=id"])).is_err());
    }

    #[test]
    fn options_before_the_subcommand_are_rejected() {
        // Even a harmless-looking global option, because allowing any means
        // re-litigating which globals are safe on every git release.
        assert!(validate_git(&v(&["--no-pager", "log"])).is_err());
    }

    #[test]
    fn upload_pack_family_is_rejected() {
        for bad in [
            v(&["fetch", "--upload-pack=id"]),
            v(&["push", "--receive-pack=id"]),
            v(&["fetch", "--upload-pack", "id"]),
            v(&["show", "--exec-path=/tmp"]),
            v(&["log", "--config-env=core.pager=X"]),
        ] {
            assert!(validate_git(&bad).is_err(), "expected rejection: {bad:?}");
        }
    }

    #[test]
    fn file_writing_options_are_rejected() {
        // Regression. An end-to-end run found `git log --output=/tmp/victim`
        // overwriting a file outside the repository: arbitrary file write from a
        // flag the old denylist had never heard of. These stay rejected because
        // the option list is now an allowlist per subcommand.
        for bad in [
            v(&["log", "--output=/tmp/e2e-victim.txt"]),
            v(&["log", "--output", "/tmp/e2e-victim.txt"]),
            v(&["diff", "--output=/tmp/x"]),
            v(&["show", "--output=/tmp/x"]),
        ] {
            assert!(validate_git(&bad).is_err(), "must reject file-writing option: {bad:?}");
        }
    }

    #[test]
    fn unknown_options_are_rejected_even_when_harmless_looking() {
        // The point of an allowlist: an option nobody considered is refused by
        // default rather than passed through to git.
        assert!(validate_git(&v(&["status", "--ignore-submodules"])).is_err());
        assert!(validate_git(&v(&["log", "--author=x"])).is_err());
    }

    #[test]
    fn the_options_the_ui_actually_sends_are_accepted() {
        // Every command git-service.js issues must survive validation, or the
        // hardening would silently break the feature it protects.
        for good in [
            v(&["status", "--porcelain=v2", "--branch"]),
            v(&["branch", "--format=%(HEAD)%09%(refname:short)%09%(upstream:short)"]),
            v(&["worktree", "list", "--porcelain"]),
            v(&["log", "--pretty=format:%H%x1f%h", "-n", "20"]),
            v(&["checkout", "main"]),
            v(&["fetch", "--prune"]),
            v(&["pull", "--ff-only"]),
            v(&["push"]),
            v(&["branch", "-d", "feat/x"]),
            v(&["worktree", "remove", "/tmp/wt"]),
            // Exactly what git-service.js:worktreeAdd emits, verified end to end.
            v(&["worktree", "add", "/tmp/wt", "some-branch"]),
            v(&["worktree", "add", "/tmp/wt", "-b", "new-branch"]),
        ] {
            assert!(validate_git(&good).is_ok(), "must accept: {good:?} -> {:?}", validate_git(&good));
        }
    }

    #[test]
    fn pathspecs_after_a_double_dash_are_operands_not_options() {
        // `git log -- --output=x` means the *path* named "--output=x".
        assert!(validate_git(&v(&["log", "--", "--output=x"])).is_ok());
    }

    #[test]
    fn nul_in_argument_is_rejected() {
        assert!(validate_git(&[String::from("log"), String::from("a\0b")]).is_err());
    }

    #[test]
    fn log_gains_a_row_limit() {
        let out = validate_git(&v(&["log", "--oneline"])).unwrap();
        assert_eq!(out, v(&["log", "--oneline", "-n", "500"]));
    }

    #[test]
    fn log_keeps_an_explicit_limit() {
        for given in [v(&["log", "-n", "5"]), v(&["log", "-n5"]), v(&["log", "--max-count=5"])] {
            let out = validate_git(&given).unwrap();
            assert_eq!(out, given, "must not append a second limit to {given:?}");
        }
    }

    #[test]
    fn non_log_subcommands_get_no_limit() {
        assert_eq!(validate_git(&v(&["status"])).unwrap(), v(&["status"]));
    }

    // ------------------------------------------------------------- plugin

    #[test]
    fn plugin_read_only_actions_pass() {
        assert_eq!(
            validate_plugin("list", None, "web").unwrap(),
            v(&["plugin", "--profile", "web", "list"])
        );
    }

    #[test]
    fn plugin_write_actions_pass_with_a_name() {
        assert_eq!(
            validate_plugin("add", Some("@scope/pkg"), "web").unwrap(),
            v(&["plugin", "--profile", "web", "add", "@scope/pkg"])
        );
    }

    #[test]
    fn plugin_unknown_action_is_rejected() {
        assert!(validate_plugin("publish", None, "web").is_err());
    }

    #[test]
    fn plugin_write_without_a_name_is_rejected() {
        assert!(validate_plugin("add", None, "web").is_err());
    }

    #[test]
    fn plugin_read_only_with_a_name_is_rejected() {
        assert!(validate_plugin("list", Some("pkg"), "web").is_err());
    }

    #[test]
    fn plugin_non_registry_specs_are_rejected() {
        for spec in ["file:../evil", "link:/tmp/x", "git+ssh://host/x.git", "github:o/r", "https://x/y.tgz", "../evil", "a/../../b"] {
            assert!(validate_plugin("add", Some(spec), "web").is_err(), "expected rejection: {spec}");
        }
    }

    #[test]
    fn plugin_odd_characters_are_rejected() {
        for spec in ["pkg;id", "pkg name", "pkg$(id)", "-flag"] {
            assert!(validate_plugin("add", Some(spec), "web").is_err(), "expected rejection: {spec}");
        }
    }

    #[test]
    fn plugin_profile_comes_from_the_daemon() {
        // The caller cannot influence it; it is a plain parameter here and the
        // route supplies it from the environment.
        let args = validate_plugin("update", Some("pkg"), "headless").unwrap();
        assert_eq!(args[1], "--profile");
        assert_eq!(args[2], "headless");
    }

    // ---------------------------------------------------------------- cwd

    #[test]
    fn cwd_must_be_absolute() {
        let home = std::env::temp_dir();
        assert!(validate_cwd("relative/path", &home).is_err());
    }

    #[test]
    fn cwd_rejects_parent_components() {
        let home = std::env::temp_dir();
        let raw = format!("{}/../etc", home.display());
        assert!(validate_cwd(&raw, &home).is_err());
    }

    #[test]
    fn cwd_rejects_paths_outside_home() {
        let home = std::env::temp_dir().join("dsh-host-exec-home");
        std::fs::create_dir_all(&home).unwrap();
        assert!(validate_cwd("/usr", &home).is_err());
    }

    #[test]
    fn cwd_rejects_a_file() {
        let dir = std::env::temp_dir().join("dsh-host-exec-file");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_cwd(file.to_str().unwrap(), &dir).is_err());
    }

    #[test]
    fn cwd_accepts_a_directory_inside_home() {
        let home = std::env::temp_dir().join("dsh-host-exec-ok");
        let inner = home.join("repo");
        std::fs::create_dir_all(&inner).unwrap();
        let got = validate_cwd(inner.to_str().unwrap(), &home).unwrap();
        assert_eq!(got, inner.canonicalize().unwrap());
    }

    #[test]
    fn cwd_rejects_a_missing_directory() {
        let home = std::env::temp_dir();
        assert!(validate_cwd("/definitely/not/here/at/all", &home).is_err());
    }

    // --------------------------------------------------------------- run

    #[tokio::test]
    async fn run_captures_output_and_exit_code() {
        let out = run(Path::new("/bin/sh"), &v(&["-c", "printf hi; printf oops >&2; exit 3"]), None, &HashMap::new(), DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(out.exit_code, Some(3));
        assert_eq!(out.stdout, "hi");
        assert_eq!(out.stderr, "oops");
        assert!(!out.stdout_truncated);
    }

    #[tokio::test]
    async fn run_truncates_a_large_stream() {
        // Larger than MAX_STREAM_BYTES, and produced faster than the pipe
        // buffer can hold — which is also the deadlock case being guarded.
        let script = format!("for i in $(seq 1 {}); do printf 'xxxxxxxxxx'; done", MAX_STREAM_BYTES / 10 + 1000);
        let out = run(Path::new("/bin/sh"), &v(&["-c", &script]), None, &HashMap::new(), DEFAULT_TIMEOUT).await.unwrap();
        assert!(out.stdout_truncated);
        assert!(out.stdout.len() <= MAX_STREAM_BYTES);
    }

    #[tokio::test]
    async fn run_times_out() {
        let err = run(Path::new("/bin/sh"), &v(&["-c", "sleep 5"]), None, &HashMap::new(), Duration::from_millis(150))
            .await
            .expect_err("should time out");
        assert!(matches!(err, ExecError::Timeout));
    }

    #[tokio::test]
    async fn run_reports_a_missing_program() {
        let err = run(Path::new("/nonexistent/program"), &[], None, &HashMap::new(), DEFAULT_TIMEOUT)
            .await
            .expect_err("should fail to spawn");
        assert!(matches!(err, ExecError::Spawn(_)));
    }

    #[tokio::test]
    async fn run_passes_env() {
        let mut env = HashMap::new();
        env.insert("DSH_TEST_VAR".to_string(), "present".to_string());
        let out = run(Path::new("/bin/sh"), &v(&["-c", "printf %s \"$DSH_TEST_VAR\""]), None, &env, DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(out.stdout, "present");
    }

    #[test]
    fn git_env_disables_prompts() {
        let env = git_env();
        assert_eq!(env.get("GIT_TERMINAL_PROMPT").map(String::as_str), Some("0"));
        assert_eq!(env.get("GIT_ASKPASS").map(String::as_str), Some(""));
    }

    #[test]
    fn clip_does_not_split_a_multibyte_char() {
        // A boundary landing mid-character must walk back, not corrupt.
        let mut bytes = vec![b'a'; MAX_STREAM_BYTES - 1];
        bytes.extend_from_slice("中".as_bytes());
        let (text, truncated) = clip(bytes);
        assert!(truncated);
        assert!(text.chars().all(|c| c == 'a'));
    }
}
