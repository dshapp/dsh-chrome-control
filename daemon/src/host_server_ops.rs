//! Restarting and updating `dsh web`, and reporting its version.
//!
//! # Why these operations take no arguments
//!
//! Each entry point below is deliberately parameterless (restart takes only a
//! port, and that port must be allowlisted). A "restart" that accepted a pid
//! would be `kill`; an "update" that accepted a package name would be
//! `pnpm add -g <anything>`. Since the guard is Origin-only
//! ([`crate::host_guard`]), the shape of these functions *is* the security
//! boundary, and widening their inputs would quietly remove it.
//!
//! # Why everything resolves through the pnpm shim
//!
//! `dsh` is managed with pnpm, and this module always invokes
//! `<pnpm_home>/dsh` rather than whatever `dsh` happens to be first on `PATH`.
//! That is not pedantry — it was measured. A machine can carry two installs at
//! once (an npm-global copy and a pnpm-global copy), with the npm one earlier
//! on `PATH`. Updating with pnpm while launching via `PATH` would then update
//! one copy and keep running the other: the version never changes and the
//! update looks like it worked.
//!
//! For the same family of reasons the shim path is used *verbatim* and never
//! canonicalized. The shim `exec`s a content-addressed directory
//! (`global/v11/<hash>/node_modules/...`) whose `<hash>` changes on every
//! reinstall, so a resolved inner path is only valid until the next update —
//! precisely when a restart is most likely to be requested.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use crate::host_exec::{self, ExecError, ExecOutput};

/// The package this module is allowed to install. Hard-coded, never from a request.
pub const DSH_PACKAGE: &str = "@deepseek-ai/dsh";

/// Default port `dsh web` listens on, overridable by `DSH_WEB_PORT`.
pub const DEFAULT_WEB_PORT: u16 = 3080;

/// How long to wait for the old listener to disappear after SIGTERM.
const STOP_BUDGET: Duration = Duration::from_secs(10);
/// How long to wait for the new server to accept connections.
const START_BUDGET: Duration = Duration::from_secs(20);
/// Budget for `pnpm view`, which reaches the registry.
const VIEW_TIMEOUT: Duration = Duration::from_secs(20);

/// Why a server operation could not be attempted.
#[derive(Debug, PartialEq, Eq)]
pub enum ServerOpError {
    /// `dsh` is not installed under the pnpm global root.
    ///
    /// Reported instead of silently falling back to some other `dsh` on
    /// `PATH`: that fallback is what produces an update which appears to
    /// succeed while changing nothing.
    DshNotInstalledViaPnpm,
    /// `pnpm` itself is not on `PATH`.
    PnpmMissing,
    /// The requested port is not one we manage.
    PortNotAllowed(u16),
    /// Nothing is listening, so there is nothing to restart.
    NotRunning(u16),
    /// Something is listening, but it is not `dsh web`.
    ///
    /// The refusal that keeps "restart" from being a general-purpose kill.
    NotDshWeb { pid: u32, command: String },
    /// A helper command failed.
    Failed(String),
}

impl ServerOpError {
    pub fn message(&self) -> String {
        match self {
            ServerOpError::DshNotInstalledViaPnpm => format!(
                "dsh is not installed under the pnpm global root; install it with: pnpm add -g {DSH_PACKAGE}"
            ),
            ServerOpError::PnpmMissing => "pnpm was not found on PATH".to_string(),
            ServerOpError::PortNotAllowed(p) => format!("port {p} is not managed by this daemon"),
            ServerOpError::NotRunning(p) => format!("nothing is listening on port {p}"),
            ServerOpError::NotDshWeb { pid, command } => {
                format!("the process on that port (pid {pid}) is not dsh web: {command}")
            }
            ServerOpError::Failed(e) => e.clone(),
        }
    }

    /// True when the caller asked for something impossible (a 400), as opposed
    /// to an operation that failed while running (a 500).
    pub fn is_client_error(&self) -> bool {
        !matches!(self, ServerOpError::Failed(_))
    }
}

/// Locate the pnpm global bin directory.
///
/// Three sources, in order, because none is reliable alone: `PNPM_HOME` is
/// canonical but frequently unset in a daemon's inherited environment (measured
/// empty on the development machine while the directory was nonetheless on
/// `PATH`), the `PATH` scan covers that case, and the macOS default covers a
/// daemon started with a minimal environment.
pub fn resolve_pnpm_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("PNPM_HOME") {
        let path = PathBuf::from(home);
        if path.is_dir() {
            return Some(path);
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            // Match the bin directory pnpm puts on PATH, not the store root.
            if entry.ends_with("pnpm/bin") || entry.file_name().is_some_and(|n| n == "pnpm") {
                if entry.is_dir() {
                    return Some(entry);
                }
            }
        }
    }
    let fallback = dirs_home()?.join("Library/pnpm");
    fallback.is_dir().then_some(fallback)
}

/// `$HOME`, or `None` when the environment does not say.
pub fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// The `dsh` executable to run: the pnpm shim, by path, unresolved.
pub fn resolve_dsh() -> Result<PathBuf, ServerOpError> {
    let home = resolve_pnpm_home().ok_or(ServerOpError::DshNotInstalledViaPnpm)?;
    // The shim may sit directly in PNPM_HOME or in its bin/ subdirectory.
    for candidate in [home.join("dsh"), home.join("bin/dsh")] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(ServerOpError::DshNotInstalledViaPnpm)
}

/// `pnpm` itself, for `view` and `add -g`.
pub fn resolve_pnpm() -> Result<PathBuf, ServerOpError> {
    if let Some(home) = resolve_pnpm_home() {
        for candidate in [home.join("pnpm"), home.join("bin/pnpm")] {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            let candidate = entry.join("pnpm");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(ServerOpError::PnpmMissing)
}

/// The profile `dsh plugin` operates on.
pub fn profile() -> String {
    std::env::var("DSH_PROFILE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "web".to_string())
}

/// The single `dsh web` port this daemon will restart.
pub fn managed_port() -> u16 {
    std::env::var("DSH_WEB_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_WEB_PORT)
}

/// Reject any port other than the managed one.
pub fn check_port(port: u16) -> Result<(), ServerOpError> {
    if port == managed_port() {
        Ok(())
    } else {
        Err(ServerOpError::PortNotAllowed(port))
    }
}

/// Whether a process command line is a `dsh web` server.
///
/// Split out from the pid lookup so the decision is testable without spawning
/// anything: the refusal below must be provable, not merely plausible.
///
/// Matching is looser than "contains the package path" because a real launcher
/// does not use one. All three spellings below are the same server, and were
/// observed on one machine within minutes of each other:
///
///   node .../node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1
///   node /opt/homebrew/bin/dsh --profile web --no-open --host 127.0.0.1
///   node /Users/u/Library/pnpm/bin/dsh web --no-open --host 127.0.0.1
///
/// Only the first carries `@deepseek-ai/dsh`; the others reach it through a bin
/// shim. Requiring the package path refused to restart the very server this is
/// meant to manage, so the test is instead "some argument is a dsh executable
/// or its package, *and* the web profile is selected".
pub fn is_dsh_web_command(command: &str) -> bool {
    let tokens: Vec<&str> = command.split_whitespace().collect();
    let looks_like_dsh = tokens.iter().any(|token| {
        token.contains(DSH_PACKAGE)
            // A bin shim: the executable's file name is exactly `dsh`.
            || std::path::Path::new(token).file_name().is_some_and(|name| name == "dsh")
    });
    if !looks_like_dsh {
        return false;
    }
    // A subcommand disqualifies the process outright: `dsh plugin --profile web
    // list` names the web profile but is an installer, not the server, and
    // killing it mid-install would corrupt the profile. Checked before the
    // profile match, which that command line would otherwise satisfy.
    const SUBCOMMANDS: &[&str] = &["plugin", "install", "add", "remove", "update"];
    if tokens.iter().any(|token| SUBCOMMANDS.contains(token)) {
        return false;
    }
    // The web profile, spelled either as the `web` subcommand or as
    // `--profile web`. A headless or tui run must not be mistaken for it.
    tokens.windows(2).any(|pair| pair[0] == "--profile" && pair[1] == "web")
        || tokens.iter().any(|token| *token == "web")
}

/// The argument vector for updating dsh. Always pnpm, always this package.
pub fn update_args() -> Vec<String> {
    vec!["add".to_string(), "-g".to_string(), format!("{DSH_PACKAGE}@latest")]
}

/// The argument vector that starts `dsh web`.
pub fn web_args(host: &str, port: u16) -> Vec<String> {
    vec![
        "web".to_string(),
        "--no-open".to_string(),
        "--host".to_string(),
        host.to_string(),
        "--port".to_string(),
        port.to_string(),
    ]
}

/// Read the installed dsh version, from the copy that will actually be started.
pub async fn current_version() -> Result<String, ServerOpError> {
    let dsh = resolve_dsh()?;
    let out = host_exec::run(&dsh, &["--version".to_string()], None, &HashMap::new(), VIEW_TIMEOUT)
        .await
        .map_err(|e: ExecError| ServerOpError::Failed(e.message()))?;
    let text = out.stdout.trim();
    if text.is_empty() {
        return Err(ServerOpError::Failed("dsh --version printed nothing".to_string()));
    }
    // `dsh --version` prints a bare version; take the last whitespace-separated
    // token so a future "dsh x.y.z" prefix does not break this.
    Ok(text.split_whitespace().last().unwrap_or(text).to_string())
}

/// Ask the registry for the newest published version.
///
/// A failure is not an error for the caller: being offline is ordinary, and the
/// UI shows "cannot check" rather than an alarming message.
pub async fn latest_version() -> Option<String> {
    let pnpm = resolve_pnpm().ok()?;
    let args = vec!["view".to_string(), DSH_PACKAGE.to_string(), "version".to_string()];
    let out = host_exec::run(&pnpm, &args, None, &HashMap::new(), VIEW_TIMEOUT).await.ok()?;
    if out.exit_code != Some(0) {
        return None;
    }
    let text = out.stdout.trim();
    text.is_empty().then_some(None).unwrap_or_else(|| Some(text.split_whitespace().last().unwrap_or(text).to_string()))
}

/// Install the newest dsh with pnpm.
pub async fn update() -> Result<ExecOutput, ServerOpError> {
    let pnpm = resolve_pnpm()?;
    // Confirm dsh is a pnpm-managed install *before* touching anything, so we
    // never "successfully" update a copy that is not the one being launched.
    resolve_dsh()?;
    host_exec::run(&pnpm, &update_args(), None, &HashMap::new(), host_exec::INSTALL_TIMEOUT)
        .await
        .map_err(|e| ServerOpError::Failed(e.message()))
}

/// Everything the restart needs from the operating system.
///
/// Injected as a trait so the refusal paths can be tested without killing real
/// processes: a test that had to spawn and signal a live `dsh web` would be the
/// kind of test people delete.
pub trait SystemProbe {
    fn pid_on_port(&self, port: u16) -> Option<u32>;
    fn command_of(&self, pid: u32) -> Option<String>;
}

/// Stop whatever `dsh web` owns `port`, after proving that is what it is.
pub fn verify_target<P: SystemProbe>(probe: &P, port: u16) -> Result<u32, ServerOpError> {
    check_port(port)?;
    let pid = probe.pid_on_port(port).ok_or(ServerOpError::NotRunning(port))?;
    let command = probe.command_of(pid).unwrap_or_default();
    if !is_dsh_web_command(&command) {
        return Err(ServerOpError::NotDshWeb { pid, command });
    }
    Ok(pid)
}

/// The log file a restarted server writes to.
pub fn web_log_path() -> PathBuf {
    let home = dirs_home().unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".dsh-chrome/logs/dsh-web.log")
}

/// Budgets, exposed so the route can report them and tests can assert them.
pub fn stop_budget() -> Duration {
    STOP_BUDGET
}
pub fn start_budget() -> Duration {
    START_BUDGET
}

/// Whether `port` on loopback accepts a connection.
pub async fn port_is_open(port: u16) -> bool {
    tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok()
}

/// Poll until `port` reaches `want_open`, or the budget runs out.
pub async fn wait_for_port(port: u16, want_open: bool, budget: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if port_is_open(port).await == want_open {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Look up the listener's pid with `lsof`, and read a pid's command with `ps`.
///
/// Both work unprivileged for processes owned by this user, which is the only
/// case that matters here.
pub struct RealSystem;

impl SystemProbe for RealSystem {
    fn pid_on_port(&self, port: u16) -> Option<u32> {
        let out = std::process::Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).split_whitespace().next()?.parse().ok()
    }

    fn command_of(&self, pid: u32) -> Option<String> {
        let out = std::process::Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!text.is_empty()).then_some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeSystem {
        pid: Option<u32>,
        command: Option<String>,
    }

    impl SystemProbe for FakeSystem {
        fn pid_on_port(&self, _port: u16) -> Option<u32> {
            self.pid
        }
        fn command_of(&self, _pid: u32) -> Option<String> {
            self.command.clone()
        }
    }

    /// Launch form A: run straight from the package.
    const REAL_DSH_WEB: &str =
        "/opt/homebrew/Cellar/node/26.7.0/bin/node /Users/u/Library/pnpm/global/v11/x/node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3080 --no-open";

    /// Launch form B: a bin shim with the profile named by flag.
    ///
     /// Copied verbatim from `ps` on a live machine. An earlier version of the
    /// check required the `@deepseek-ai/dsh` package path, which this form does
    /// not contain — so `/host/server/restart` refused to restart the very
    /// server it exists to manage, and only an end-to-end attempt revealed it.
    const SHIM_PROFILE_WEB: &str =
        "node /opt/homebrew/bin/dsh --profile web --no-open --host 127.0.0.1 --port 3080";

    /// Launch form C: the pnpm shim this daemon itself starts.
    const PNPM_SHIM_WEB: &str =
        "node /Users/u/Library/pnpm/bin/dsh web --no-open --host 127.0.0.1 --port 3080";

    #[test]
    fn update_command_is_pnpm_and_fixed() {
        // The whole argument vector, asserted literally: no caller input reaches
        // it, and it must never become npm.
        assert_eq!(update_args(), vec!["add", "-g", "@deepseek-ai/dsh@latest"]);
        assert!(!update_args().iter().any(|a| a.contains("npm ")));
    }

    #[test]
    fn dsh_package_is_not_configurable() {
        assert_eq!(DSH_PACKAGE, "@deepseek-ai/dsh");
    }

    #[test]
    fn recognises_every_real_dsh_web_launch_form() {
        // All three were seen on one machine. An end-to-end restart failed
        // because only the first was accepted, so each is pinned here.
        for command in [REAL_DSH_WEB, SHIM_PROFILE_WEB, PNPM_SHIM_WEB] {
            assert!(is_dsh_web_command(command), "must accept: {command}");
        }
    }

    #[test]
    fn a_shim_running_another_profile_is_not_dsh_web() {
        // The looser executable match must not make every dsh process a target.
        for command in [
            "node /opt/homebrew/bin/dsh --profile headless \"do a task\"",
            "node /Users/u/Library/pnpm/bin/dsh --profile tui",
            "node /opt/homebrew/bin/dsh plugin --profile web list",
        ] {
            assert!(!is_dsh_web_command(command), "must not accept: {command}");
        }
    }

    #[test]
    fn rejects_other_processes() {
        for command in [
            "/usr/sbin/httpd -D FOREGROUND",
            "node /some/other/app/server.js web",
            "/Users/u/.dsh/profiles/web/node_modules/dsh-chrome-control/binaries/darwin-arm64/chrome-daemon --port 37086",
            "",
        ] {
            assert!(!is_dsh_web_command(command), "must not accept: {command}");
        }
    }

    #[test]
    fn rejects_dsh_that_is_not_the_web_command() {
        // The daemon must not kill a headless run just because it is dsh.
        assert!(!is_dsh_web_command(
            "node /x/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless \"do a task\""
        ));
    }

    #[test]
    fn verify_target_accepts_dsh_web() {
        let probe = FakeSystem { pid: Some(4242), command: Some(REAL_DSH_WEB.to_string()) };
        assert_eq!(verify_target(&probe, managed_port()).unwrap(), 4242);
    }

    #[test]
    fn verify_target_refuses_a_foreign_process_without_signalling() {
        // verify_target is pure: reaching this error proves no kill happened,
        // because sending the signal is the caller's separate step.
        let probe = FakeSystem { pid: Some(99), command: Some("/usr/sbin/httpd".to_string()) };
        match verify_target(&probe, managed_port()) {
            Err(ServerOpError::NotDshWeb { pid, .. }) => assert_eq!(pid, 99),
            other => panic!("expected NotDshWeb, got {other:?}"),
        }
    }

    #[test]
    fn verify_target_refuses_an_unmanaged_port() {
        let probe = FakeSystem { pid: Some(1), command: Some(REAL_DSH_WEB.to_string()) };
        let unmanaged = managed_port().wrapping_add(1);
        assert_eq!(verify_target(&probe, unmanaged), Err(ServerOpError::PortNotAllowed(unmanaged)));
    }

    #[test]
    fn verify_target_reports_nothing_listening() {
        let probe = FakeSystem { pid: None, command: None };
        assert_eq!(verify_target(&probe, managed_port()), Err(ServerOpError::NotRunning(managed_port())));
    }

    #[test]
    fn web_args_are_loopback_and_headless() {
        let args = web_args("127.0.0.1", 3080);
        assert_eq!(args, vec!["web", "--no-open", "--host", "127.0.0.1", "--port", "3080"]);
    }

    #[test]
    fn resolved_dsh_is_the_shim_path_not_a_hashed_inner_path() {
        // The invariant that keeps restart working straight after an update:
        // the launch path must not embed pnpm's content hash.
        if let Ok(path) = resolve_dsh() {
            let text = path.to_string_lossy();
            assert!(text.ends_with("/dsh"), "expected a shim path, got {text}");
            assert!(!text.contains("global/v11"), "must not resolve into the pnpm store: {text}");
            assert!(!text.contains("node_modules"), "must not resolve into node_modules: {text}");
        }
    }

    #[test]
    fn missing_pnpm_home_is_a_client_error_with_guidance() {
        let err = ServerOpError::DshNotInstalledViaPnpm;
        assert!(err.is_client_error());
        assert!(err.message().contains("pnpm add -g @deepseek-ai/dsh"));
    }

    #[test]
    fn a_failed_command_is_not_a_client_error() {
        assert!(!ServerOpError::Failed("boom".into()).is_client_error());
    }

    #[test]
    fn profile_defaults_to_web() {
        // Only meaningful when the ambient environment does not override it.
        if std::env::var_os("DSH_PROFILE").is_none() {
            assert_eq!(profile(), "web");
        }
    }

    #[tokio::test]
    async fn wait_for_port_gives_up_within_its_budget() {
        // Port 1 is never open for us; the call must return false promptly
        // rather than hanging the request.
        let started = std::time::Instant::now();
        let ok = wait_for_port(1, true, Duration::from_millis(400)).await;
        assert!(!ok);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn wait_for_port_returns_immediately_when_already_satisfied() {
        assert!(wait_for_port(1, false, Duration::from_millis(500)).await);
    }
}
