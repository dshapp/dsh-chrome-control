//! Restarting and updating `dsh web`, and reporting its version.
//!
//! # Why update targets are restricted
//!
//! Updates accept only latest/next/alpha or strict exact SemVer for the fixed
//! DSH package. Restart takes only an allowlisted port. A "restart" that accepted a pid
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
//! # npm global installs: follow the copy that is running
//!
//! The two-copies hazard above is about updating one copy and launching
//! another, not about pnpm as such. So when the `dsh web` on the managed port
//! runs from an npm global install (`<prefix>/lib/node_modules/@deepseek-ai/dsh`,
//! linked as `<prefix>/bin/dsh`), update and restart both target *that* copy:
//! `npm install --global --prefix <prefix>` and `<prefix>/bin/dsh web`. The
//! install is classified from the running process, never from `PATH`, so the
//! copy updated and the copy relaunched are the same one by construction. A
//! root-owned prefix (the official Node .pkg's `/usr/local`) is escalated
//! through the macOS authorization dialog, exactly as the Mac app does.
//!
//! For the same family of reasons the shim path is used *verbatim* and never
//! canonicalized. The shim `exec`s a content-addressed directory
//! (`global/v11/<hash>/node_modules/...`) whose `<hash>` changes on every
//! reinstall, so a resolved inner path is only valid until the next update —
//! precisely when a restart is most likely to be requested.

include!("host_server_ops_update_tests.rs");

include!("host_server_ops_npm_tests.rs");

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::host_exec::{self, ExecError, ExecOutput};

/// The package this module is allowed to install. Hard-coded, never from a request.
pub const DSH_PACKAGE: &str = "@deepseek-ai/dsh";

/// The registry every dsh install and lookup asks, passed explicitly so a
/// configured mirror that has not yet synced a release cannot fail the install
/// with ETARGET (or report a stale latest).
pub const DSH_REGISTRY: &str = "https://registry.npmjs.org";

/// Default port `dsh web` listens on, overridable by `DSH_WEB_PORT`.
pub const DEFAULT_WEB_PORT: u16 = 3080;

/// How long to wait for the old listener to disappear after SIGTERM.
const STOP_BUDGET: Duration = Duration::from_secs(10);
/// How long to wait for the new server to accept connections.
const START_BUDGET: Duration = Duration::from_secs(20);
/// Budget for `pnpm view`, which reaches the registry.
const VIEW_TIMEOUT: Duration = Duration::from_secs(20);
/// Budget for an install behind the authorization dialog.
///
/// Deliberately not a real limit: expiry kills the child, and a root npm
/// killed after the password is accepted leaves the global install broken
/// (half-extracted package, no bin link) with nothing this user can repair.
/// The clock also starts before the dialog, so it cannot tell a user still
/// typing from an install still running. A dismissed dialog ends it instead.
pub const ADMIN_INSTALL_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

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
    /// The running dsh is an npm global install, but no `npm` can be found.
    NpmMissing,
    /// The running dsh comes from neither a pnpm nor an npm global install
    /// (an npx cache, a project's node_modules, a checkout), so there is no
    /// install this daemon could update without touching some other copy.
    UnsupportedInstall(String),
    /// The npm global root needs root, and this platform has no dialog to ask.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    NpmRootNotWritable { root: String, command: String },
    /// The user dismissed the authorization dialog.
    AuthorizationCancelled,
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
                "dsh is not installed under the pnpm global root; install it with: pnpm add -g {DSH_PACKAGE} --registry {DSH_REGISTRY}"
            ),
            ServerOpError::PnpmMissing => "pnpm was not found on PATH".to_string(),
            ServerOpError::NpmMissing => "dsh is an npm global install, but npm was not found".to_string(),
            ServerOpError::UnsupportedInstall(dir) => format!(
                "the running dsh ({dir}) is not a global npm or pnpm install; install it with: npm install -g {DSH_PACKAGE}"
            ),
            ServerOpError::NpmRootNotWritable { root, command } => {
                format!("the npm global directory {root} is not writable by this user; run: {command}")
            }
            ServerOpError::AuthorizationCancelled => "the administrator authorization was cancelled".to_string(),
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

/// How the dsh behind the managed port is installed: which tool updates it,
/// and which executable starts it again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DshInstall {
    /// A pnpm global install, launched through the `$PNPM_HOME/dsh` shim.
    Pnpm { dsh: PathBuf },
    /// An npm global install under `prefix`.
    Npm {
        prefix: PathBuf,
        /// The npm that installs into `prefix` (`<prefix>/bin/npm` when present).
        npm: PathBuf,
        /// Directory of the `node` the running server uses, put first on `PATH`
        /// so the env-node launchers of npm and dsh pick the same Node.
        node_dir: Option<PathBuf>,
    },
}

impl DshInstall {
    /// The executable that starts `dsh web`: the pnpm shim, or the npm bin link.
    /// Never canonicalized, for the same reason as the pnpm shim: it must keep
    /// naming the right copy after an update rewrites what it points at.
    pub fn launcher(&self) -> PathBuf {
        match self {
            DshInstall::Pnpm { dsh } => dsh.clone(),
            DshInstall::Npm { prefix, .. } => prefix.join("bin/dsh"),
        }
    }

    /// Extra environment for anything run against this install.
    ///
    /// npm and the dsh bin link are `#!/usr/bin/env node` scripts, and a daemon
    /// started from a GUI has a minimal `PATH`, so the running server's Node and
    /// the prefix's bin go first. pnpm keeps the inherited environment, as before.
    pub fn env(&self) -> HashMap<String, String> {
        let mut env = HashMap::new();
        if let DshInstall::Npm { prefix, node_dir, .. } = self {
            env.insert("PATH".to_string(), npm_search_path(prefix, node_dir.as_deref(), std::env::var_os("PATH")));
        }
        env
    }
}

/// `PATH` for an npm install: the server's Node, the prefix's bin, then the rest.
pub fn npm_search_path(prefix: &Path, node_dir: Option<&Path>, inherited: Option<std::ffi::OsString>) -> String {
    let mut dirs: Vec<PathBuf> = Vec::new();
    dirs.extend(node_dir.map(Path::to_path_buf));
    dirs.push(prefix.join("bin"));
    match inherited {
        Some(path) => dirs.extend(std::env::split_paths(&path)),
        None => dirs.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from)),
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    std::env::join_paths(dirs).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Whether a package directory lives in pnpm's store rather than an npm prefix.
fn is_pnpm_store_path(dir: &Path) -> bool {
    let names: Vec<&std::ffi::OsStr> = dir.iter().collect();
    names.iter().any(|name| *name == ".pnpm")
        || names.windows(2).any(|pair| pair[0] == "pnpm" && pair[1] == "global")
}

/// The npm prefix that owns `package_dir`, if it is an npm *global* install.
///
/// npm's global layout on Unix is `<prefix>/lib/node_modules/<package>`. Anything
/// else — pnpm's store, an npx cache (`_npx/<hash>/node_modules`), a project's
/// own node_modules — is not a global install and yields `None`. The caller
/// still proves the prefix links this package as `bin/dsh` before trusting it.
pub fn npm_prefix_of(package_dir: &Path) -> Option<PathBuf> {
    if !package_dir.ends_with(Path::new("node_modules").join(DSH_PACKAGE)) || is_pnpm_store_path(package_dir) {
        return None;
    }
    let node_modules = package_dir.parent()?.parent()?;
    let lib = node_modules.parent()?;
    if lib.file_name()? != "lib" {
        return None;
    }
    lib.parent().map(Path::to_path_buf)
}

/// The Node directory of a running command line, when it names node by path.
fn node_dir_of(command: &str) -> Option<PathBuf> {
    let first = PathBuf::from(command.split_whitespace().next()?);
    let is_node = first.file_name().and_then(|n| n.to_str()).is_some_and(|n| n == "node" || n.starts_with("node."));
    (first.is_absolute() && is_node && first.is_file()).then(|| first.parent().map(Path::to_path_buf)).flatten()
}

/// The first `name` on `PATH`.
fn find_on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|p| p.is_file())
}

/// Classify the install behind the `dsh web` on `port`.
///
/// A server running from an npm global prefix is that prefix's npm install.
/// Everything else keeps the original pnpm resolution — including no server at
/// all, so a machine without a running server behaves exactly as before.
pub fn resolve_install<P: SystemProbe>(probe: &P, port: u16) -> Result<DshInstall, ServerOpError> {
    if let Some(command) = probe.pid_on_port(port).and_then(|pid| probe.command_of(pid)).filter(|c| is_dsh_web_command(c)) {
        if let Some(dir) = dsh_package_dir(&command).and_then(|d| std::fs::canonicalize(d).ok()) {
            if let Some(prefix) = npm_prefix_of(&dir) {
                // The bin link must point at the package that is running; otherwise
                // updating this prefix would not update the running copy.
                let linked = std::fs::canonicalize(prefix.join("bin/dsh")).ok();
                if linked.as_deref() != Some(dir.join("lib/bin.js").as_path()) {
                    return Err(ServerOpError::UnsupportedInstall(dir.to_string_lossy().into_owned()));
                }
                let npm = Some(prefix.join("bin/npm")).filter(|p| p.is_file())
                    .or_else(|| find_on_path("npm"))
                    .ok_or(ServerOpError::NpmMissing)?;
                return Ok(DshInstall::Npm { prefix, npm, node_dir: node_dir_of(&command) });
            }
            if !is_pnpm_store_path(&dir) {
                return Err(ServerOpError::UnsupportedInstall(dir.to_string_lossy().into_owned()));
            }
        }
    }
    Ok(DshInstall::Pnpm { dsh: resolve_dsh()? })
}

/// npm's arguments for installing `target` into exactly `prefix`.
///
/// `--prefix` pins the install to the running copy even when the npm found is
/// another Node's, whose own global prefix would be somewhere else.
pub fn npm_update_args(prefix: &Path, target: &str) -> Result<Vec<String>, String> {
    validate_update_target(target)?;
    Ok(vec![
        "install".into(), "--global".into(), "--no-fund".into(), "--no-audit".into(),
        "--prefix".into(), prefix.to_string_lossy().into_owned(),
        "--registry".into(), DSH_REGISTRY.into(), format!("{DSH_PACKAGE}@{target}"),
    ])
}

/// Whether npm needs root to write `prefix`: the package's scope directory,
/// node_modules and bin must all be writable by this user.
#[cfg(unix)]
pub fn npm_root_requires_admin(prefix: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let node_modules = prefix.join("lib/node_modules");
    let scope = node_modules.join(DSH_PACKAGE).parent().map(Path::to_path_buf).unwrap_or_else(|| node_modules.clone());
    [scope, node_modules, prefix.join("bin")].iter().filter(|dir| dir.exists()).any(|dir| {
        let Ok(path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else { return true };
        unsafe { libc::access(path.as_ptr(), libc::W_OK) != 0 }
    })
}
#[cfg(not(unix))]
pub fn npm_root_requires_admin(_prefix: &Path) -> bool { false }

/// Single-quote one argument for `/bin/sh`.
pub fn shell_quoted(argument: &str) -> String {
    format!("'{}'", argument.replace('\'', "'\\''"))
}

/// The one shell command line this module ever builds: the privileged npm
/// install. `do shell script` takes only a string, so the no-shell rule of
/// [`crate::host_exec`] cannot hold here; instead every word is a fixed string,
/// a path read from the filesystem, or a target that passed
/// [`validate_update_target`], and each is single-quoted. `PATH` is fixed
/// rather than inherited, so root resolves `node` the same way the user did.
pub fn privileged_command(npm: &Path, args: &[String], path_env: &str) -> String {
    ["/usr/bin/env".to_string(), format!("PATH={path_env}"), npm.to_string_lossy().into_owned()]
        .iter().chain(args).map(|word| shell_quoted(word)).collect::<Vec<_>>().join(" ")
}

/// The install arguments for a run as root, with a cache of its own.
///
/// npm as root writes root-owned entries into the user's `~/.npm`, after which
/// every ordinary npm command of that user fails with EACCES ("sudo chown -R
/// … ~/.npm"). A separate cache keeps the escalation from breaking the user's npm.
pub fn privileged_args(args: &[String]) -> Vec<String> {
    let cache = std::env::temp_dir().join("dsh-chrome-npm-admin-cache");
    let mut out = args.to_vec();
    out.extend(["--cache".to_string(), cache.to_string_lossy().into_owned()]);
    out
}

/// `osascript` source running `command` through the authorization dialog.
pub fn admin_apple_script(command: &str) -> String {
    let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
    format!("do shell script \"{escaped}\" with administrator privileges")
}

/// Read a package's version from its manifest, without running it.
fn manifest_version(package_dir: &Path) -> Option<String> {
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(package_dir.join("package.json")).ok()?).ok()?;
    if manifest["name"] != DSH_PACKAGE {
        return None;
    }
    manifest["version"].as_str().filter(|v| is_exact_version(v)).map(str::to_string)
}

/// The version `install` will launch, read just before launching it.
pub async fn launch_version(install: &DshInstall) -> Option<String> {
    match install {
        DshInstall::Pnpm { .. } => installed_version().await.ok(),
        DshInstall::Npm { prefix, .. } => manifest_version(&prefix.join("lib/node_modules").join(DSH_PACKAGE)),
    }
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

/// Strict SemVer parser. Decimal strings avoid overflow and build metadata is ignored.
#[derive(Debug)]
struct SemVersion<'a> { main: Vec<&'a str>, pre: Option<Vec<&'a str>> }
fn numeric(s: &str) -> bool { !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) }
fn identifiers(s: &str, prerelease: bool) -> bool {
    s.split('.').all(|part| !part.is_empty()
        && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !(prerelease && numeric(part) && part.len() > 1 && part.starts_with('0')))
}
fn sem_version(value: &str) -> Option<SemVersion<'_>> {
    if value.len() > 256 { return None; }
    let (version, build) = value.split_once('+').map_or((value, None), |(v,b)| (v,Some(b)));
    if build.is_some_and(|b| !identifiers(b, false)) { return None; }
    let (main, pre) = version.split_once('-').map_or((version, None), |(v,p)| (v,Some(p)));
    let main: Vec<_> = main.split('.').collect();
    if main.len() != 3 || main.iter().any(|p| !numeric(p) || (p.len() > 1 && p.starts_with('0'))) { return None; }
    if pre.is_some_and(|p| !identifiers(p, true)) { return None; }
    Some(SemVersion { main, pre: pre.map(|p| p.split('.').collect()) })
}
pub fn is_exact_version(value: &str) -> bool { sem_version(value).is_some() }
fn decimal(a: &str, b: &str) -> std::cmp::Ordering { a.len().cmp(&b.len()).then_with(|| a.cmp(b)) }
pub fn compare_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering::*;
    let a = sem_version(left)?; let b = sem_version(right)?;
    for (x,y) in a.main.iter().zip(&b.main) { let c = decimal(x,y); if c != Equal { return Some(c); } }
    match (a.pre, b.pre) {
        (None,None) => Some(Equal), (None,Some(_)) => Some(Greater), (Some(_),None) => Some(Less),
        (Some(a),Some(b)) => {
            for (x,y) in a.iter().zip(&b) {
                let c = match (numeric(x),numeric(y)) { (true,true) => decimal(x,y), (true,false) => Less, (false,true) => Greater, _ => x.cmp(y) };
                if c != Equal { return Some(c); }
            }
            Some(a.len().cmp(&b.len()))
        }
    }
}
/// Only these tags, or an exact version, can ever enter fixed-package argv.
pub fn validate_update_target(target: &str) -> Result<&str, String> {
    if ["latest", "next", "alpha"].contains(&target) || is_exact_version(target) { Ok(target) }
    else { Err("DSH update target must be latest, next, alpha or an exact semantic version".to_string()) }
}
pub fn update_target_args(target: &str) -> Result<Vec<String>, String> {
    validate_update_target(target)?;
    Ok(vec!["add".into(), "-g".into(), "--registry".into(), DSH_REGISTRY.into(), format!("{DSH_PACKAGE}@{target}")])
}
/// The argument vector for updating dsh. Always pnpm, always this package.
pub fn update_args() -> Vec<String> {
    update_target_args("latest").expect("latest is allowlisted")
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

/// The version of the dsh the user is actually talking to.
///
/// The running `dsh web` comes first: after an update without a restart the
/// installed copy is already new while the server is still the old one, and
/// reporting the installed version would make the update look applied. Only
/// when no server can be read does this fall back to the installed copy.
pub async fn current_version(launched: Option<Launched>) -> Result<String, ServerOpError> {
    if let Some(version) = running_version(&RealSystem, managed_port(), launched) {
        return Ok(version);
    }
    installed_version().await
}

/// The pid and version of a `dsh web` this daemon started, recorded at launch.
pub type Launched = (u32, String);

/// The version of the `dsh web` listening on `port`.
///
/// A server this daemon started reports the version recorded when it was
/// launched: an in-place install (npm global) rewrites the package on disk, so
/// only the launch-time record still names the code the process loaded.
/// Otherwise the version is read from the package its command line runs
/// (`…/@deepseek-ai/dsh/lib/bin.js`).
///
/// `dsh web` publishes no version over HTTP, so the process is the source. A
/// pnpm install runs a content-addressed directory, so that path keeps naming
/// the version the process loaded even after an update installs another one.
/// A bin link (`node /opt/homebrew/bin/dsh web`) is resolved to the package it
/// points at; that is what is installed *now*, the best left once no launch
/// record exists.
pub fn running_version<P: SystemProbe>(probe: &P, port: u16, launched: Option<Launched>) -> Option<String> {
    let pid = probe.pid_on_port(port)?;
    if let Some((launched_pid, version)) = launched {
        if launched_pid == pid {
            return Some(version);
        }
    }
    let command = probe.command_of(pid)?;
    if !is_dsh_web_command(&command) {
        return None;
    }
    manifest_version(&dsh_package_dir(&command)?)
}

/// The package directory of the `…/lib/bin.js` entry in a command line,
/// following a `dsh` bin link to the entry it names.
fn dsh_package_dir(command: &str) -> Option<PathBuf> {
    command.split_whitespace().find_map(|token| {
        let mut entry = PathBuf::from(token);
        if entry.file_name().is_some_and(|name| name == "dsh") {
            entry = std::fs::canonicalize(&entry).ok()?;
        }
        if entry.ends_with("lib/bin.js") { entry.parent()?.parent().map(PathBuf::from) } else { None }
    })
}

/// Read the installed dsh version, from the copy that will actually be started.
pub async fn installed_version() -> Result<String, ServerOpError> {
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
pub fn dist_tag_args() -> Vec<String> {
    vec!["view".into(), "--registry".into(), DSH_REGISTRY.into(), DSH_PACKAGE.into(), "dist-tags".into(), "--json".into()]
}
pub fn parse_dist_tags(text: &str) -> Option<HashMap<String, String>> {
    let values: serde_json::Value = serde_json::from_str(text).ok()?;
    let object = values.as_object()?;
    Some(object.iter().filter_map(|(tag, value)| {
        let version = value.as_str()?;
        (["latest", "next", "alpha"].contains(&tag.as_str()) && is_exact_version(version))
            .then(|| (tag.clone(), version.to_string()))
    }).collect())
}
pub async fn dist_tags() -> Option<HashMap<String, String>> {
    let pnpm = resolve_pnpm().ok()?;
    let out = host_exec::run(&pnpm, &dist_tag_args(), None, &HashMap::new(), VIEW_TIMEOUT).await.ok()?;
    if out.exit_code != Some(0) { return None; }
    parse_dist_tags(&out.stdout)
}
pub fn select_target_version(target: &str, tags: &HashMap<String, String>) -> Option<String> {
    if is_exact_version(target) { Some(target.to_string()) }
    else { tags.get(target).filter(|v| is_exact_version(v)).cloned() }
}
/// Verify exact versions exist in this fixed package; unavailable/offline is null.
pub async fn exact_version(target: &str) -> Option<String> {
    if !is_exact_version(target) { return None; }
    let pnpm = resolve_pnpm().ok()?;
    let args = vec!["view".into(), "--registry".into(), DSH_REGISTRY.into(), format!("{DSH_PACKAGE}@{target}"), "version".into(), "--json".into()];
    let out = host_exec::run(&pnpm, &args, None, &HashMap::new(), VIEW_TIMEOUT).await.ok()?;
    if out.exit_code != Some(0) { return None; }
    let version: String = serde_json::from_str(&out.stdout).ok()?;
    (version == target).then_some(version)
}

/// Install `target` into the install `resolve_install` classified.
pub async fn update(install: &DshInstall, target: &str) -> Result<ExecOutput, ServerOpError> {
    match install {
        DshInstall::Pnpm { .. } => {
            let args = if target == "latest" { update_args() } else { update_target_args(target).map_err(ServerOpError::Failed)? };
            let pnpm = resolve_pnpm()?;
            // Confirm dsh is a pnpm-managed install *before* touching anything, so we
            // never "successfully" update a copy that is not the one being launched.
            resolve_dsh()?;
            host_exec::run(&pnpm, &args, None, &HashMap::new(), host_exec::INSTALL_TIMEOUT)
                .await
                .map_err(|e| ServerOpError::Failed(e.message()))
        }
        DshInstall::Npm { prefix, npm, .. } => {
            let args = npm_update_args(prefix, target).map_err(ServerOpError::Failed)?;
            let env = install.env();
            if !npm_root_requires_admin(prefix) {
                return host_exec::run(npm, &args, None, &env, host_exec::INSTALL_TIMEOUT)
                    .await
                    .map_err(|e| ServerOpError::Failed(e.message()));
            }
            let path_env = env.get("PATH").cloned().unwrap_or_default();
            update_as_admin(prefix, npm, &args, &path_env).await
        }
    }
}

/// The privileged npm install, through the macOS authorization dialog.
#[cfg(target_os = "macos")]
async fn update_as_admin(_prefix: &Path, npm: &Path, args: &[String], path_env: &str) -> Result<ExecOutput, ServerOpError> {
    let script = admin_apple_script(&privileged_command(npm, &privileged_args(args), path_env));
    let out = host_exec::run(Path::new("/usr/bin/osascript"), &["-e".to_string(), script], None, &HashMap::new(), ADMIN_INSTALL_TIMEOUT)
        .await
        .map_err(|e| ServerOpError::Failed(e.message()))?;
    // osascript reports a dismissed dialog as "User canceled. (-128)".
    if out.exit_code != Some(0) && out.stderr.contains("(-128)") {
        return Err(ServerOpError::AuthorizationCancelled);
    }
    Ok(out)
}

/// Elsewhere there is no dialog to ask with: say what to run instead.
#[cfg(not(target_os = "macos"))]
async fn update_as_admin(prefix: &Path, npm: &Path, args: &[String], _path_env: &str) -> Result<ExecOutput, ServerOpError> {
    let command = std::iter::once(format!("sudo {}", shell_quoted(&npm.to_string_lossy())))
        .chain(args.iter().map(|a| shell_quoted(a))).collect::<Vec<_>>().join(" ");
    Err(ServerOpError::NpmRootNotWritable { root: prefix.join("lib/node_modules").to_string_lossy().into_owned(), command })
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

/// Ask process `pid` to exit, letting it run its shutdown path.
///
/// `libc` is a `cfg(unix)` dependency, so its signal calls cannot appear in
/// code compiled for Windows. Both platforms make a best-effort request: there
/// is no reply to check, and the caller settles the peer's fate by polling the
/// port rather than by trusting this call.
#[cfg(unix)]
pub fn terminate(pid: u32) {
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

/// Force process `pid` to exit immediately.
#[cfg(unix)]
pub fn kill(pid: u32) {
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

/// Windows has no signals; `taskkill` without `/F` asks a process to close.
#[cfg(windows)]
pub fn terminate(pid: u32) {
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string()]).output();
}

/// `/F` is the Windows counterpart to SIGKILL, and `/T` takes the child tree
/// with it, matching how a spawned server is torn down on Unix.
#[cfg(windows)]
pub fn kill(pid: u32) {
    let _ = std::process::Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output();
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
        assert_eq!(update_args(), vec!["add", "-g", "--registry", "https://registry.npmjs.org", "@deepseek-ai/dsh@latest"]);
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
    fn running_version_reads_the_package_the_process_runs() {
        let root = std::env::temp_dir().join(format!("dsh-running-version-{}", std::process::id()));
        let dir = root.join("node_modules/@deepseek-ai/dsh");
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"name":"@deepseek-ai/dsh","version":"0.2.1-alpha.2"}"#).unwrap();
        let command = format!("/usr/local/bin/node {} web --host 127.0.0.1 --port 3080", dir.join("lib/bin.js").display());
        assert_eq!(dsh_package_dir(&command), Some(dir.clone()));
        let probe = FakeSystem { pid: Some(7), command: Some(command) };
        assert_eq!(running_version(&probe, managed_port(), None), Some("0.2.1-alpha.2".into()));
        // A server this daemon launched keeps its launch-time version, even if the
        // package on disk has since been rewritten; another pid does not.
        assert_eq!(running_version(&probe, managed_port(), Some((7, "0.1.0".into()))), Some("0.1.0".into()));
        assert_eq!(running_version(&probe, managed_port(), Some((8, "0.1.0".into()))), Some("0.2.1-alpha.2".into()));
        // Not running, not dsh web, or launched through a shim: no running version.
        for command in [None, Some("/usr/sbin/httpd".to_string()), Some(PNPM_SHIM_WEB.to_string())] {
            let probe = FakeSystem { pid: Some(7), command };
            assert_eq!(running_version(&probe, managed_port(), None), None);
        }
        assert_eq!(running_version(&FakeSystem { pid: None, command: None }, managed_port(), Some((7, "0.1.0".into()))), None);
        // A bin link resolves to the package it points at.
        #[cfg(unix)]
        {
            std::fs::write(dir.join("lib/bin.js"), "").unwrap();
            std::fs::create_dir_all(root.join("bin")).unwrap();
            std::os::unix::fs::symlink(dir.join("lib/bin.js"), root.join("bin/dsh")).unwrap();
            let command = format!("node {} --profile web --no-open", root.join("bin/dsh").display());
            let probe = FakeSystem { pid: Some(7), command: Some(command) };
            assert_eq!(running_version(&probe, managed_port(), None), Some("0.2.1-alpha.2".into()));
        }
        std::fs::remove_dir_all(root).unwrap();
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
