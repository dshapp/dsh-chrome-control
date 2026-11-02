// npm global installs: classification, argv, privileged command. No installer,
// signals or network; the only filesystem use is a throwaway npm-like prefix.
#[cfg(all(test, unix))]
mod npm_install_tests {
    use super::*;

    struct Probe(Option<String>);
    impl SystemProbe for Probe {
        fn pid_on_port(&self, _port: u16) -> Option<u32> { self.0.as_ref().map(|_| 7) }
        fn command_of(&self, _pid: u32) -> Option<String> { self.0.clone() }
    }

    /// `<root>/lib/node_modules/@deepseek-ai/dsh` plus `bin/dsh` and `bin/npm`, the
    /// layout `npm install -g` produces. Returns the canonical prefix.
    fn npm_prefix(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("dsh-npm-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let package = root.join("lib/node_modules/@deepseek-ai/dsh");
        std::fs::create_dir_all(package.join("lib")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(package.join("package.json"), r#"{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.2"}"#).unwrap();
        std::fs::write(package.join("lib/bin.js"), "").unwrap();
        std::os::unix::fs::symlink("../lib/node_modules/@deepseek-ai/dsh/lib/bin.js", root.join("bin/dsh")).unwrap();
        std::fs::write(root.join("bin/npm"), "").unwrap();
        std::fs::canonicalize(root).unwrap()
    }

    #[test]
    fn npm_prefix_is_read_only_from_a_global_layout() {
        for (dir, prefix) in [
            ("/usr/local/lib/node_modules/@deepseek-ai/dsh", "/usr/local"),
            ("/opt/homebrew/lib/node_modules/@deepseek-ai/dsh", "/opt/homebrew"),
            ("/Users/u/.nvm/versions/node/v22.19.0/lib/node_modules/@deepseek-ai/dsh", "/Users/u/.nvm/versions/node/v22.19.0"),
        ] {
            assert_eq!(npm_prefix_of(Path::new(dir)), Some(PathBuf::from(prefix)), "{dir}");
        }
        for dir in [
            // pnpm's global store, in both of its spellings.
            "/Users/u/Library/pnpm/global/v11/lib/node_modules/@deepseek-ai/dsh",
            "/Users/u/Library/pnpm/global/5/node_modules/.pnpm/@deepseek-ai+dsh@0.2.1/node_modules/@deepseek-ai/dsh",
            // npx cache and a project's own dependency: not global installs.
            "/Users/u/.npm/_npx/0123abcd/node_modules/@deepseek-ai/dsh",
            "/Users/u/src/app/node_modules/@deepseek-ai/dsh",
            // Another package entirely.
            "/usr/local/lib/node_modules/@deepseek-ai/dsh-web",
            "/usr/local/lib/node_modules/npm",
        ] {
            assert_eq!(npm_prefix_of(Path::new(dir)), None, "{dir}");
        }
    }

    #[test]
    fn npm_update_argv_is_fixed_and_pinned_to_the_prefix() {
        assert_eq!(
            npm_update_args(Path::new("/usr/local"), "0.2.1-rc.3").unwrap(),
            vec!["install", "--global", "--no-fund", "--no-audit", "--prefix", "/usr/local", "--registry", "https://registry.npmjs.org", "@deepseek-ai/dsh@0.2.1-rc.3"]
        );
        for target in ["", "beta", "^1.2.3", "latest; rm -rf /", "@evil/pkg", "file:/tmp/x", "1.2.3 extra"] {
            assert!(npm_update_args(Path::new("/usr/local"), target).is_err(), "{target}");
        }
    }

    #[test]
    fn privileged_command_quotes_every_word() {
        let args = npm_update_args(Path::new("/opt/it's here"), "1.2.3").unwrap();
        let command = privileged_command(Path::new("/opt/it's here/bin/npm"), &args, "/a b:/usr/bin");
        assert_eq!(
            command,
            "'/usr/bin/env' 'PATH=/a b:/usr/bin' '/opt/it'\\''s here/bin/npm' 'install' '--global' '--no-fund' '--no-audit' \
             '--prefix' '/opt/it'\\''s here' '--registry' 'https://registry.npmjs.org' '@deepseek-ai/dsh@1.2.3'"
        );
        // A root run never touches the user's ~/.npm.
        let privileged = privileged_args(&args);
        assert_eq!(&privileged[..args.len()], &args[..]);
        assert_eq!(privileged[args.len()], "--cache");
        assert!(!privileged[args.len() + 1].contains(".npm"));
        // Quotes and backslashes are escaped for the AppleScript string literal.
        assert_eq!(admin_apple_script(r#"a "b" \c"#), r#"do shell script "a \"b\" \\c" with administrator privileges"#);
    }

    #[test]
    fn npm_path_puts_the_servers_node_first_without_duplicates() {
        let path = npm_search_path(Path::new("/usr/local"), Some(Path::new("/usr/local/bin")), Some("/usr/bin:/usr/local/bin".into()));
        assert_eq!(path, "/usr/local/bin:/usr/bin");
        let path = npm_search_path(Path::new("/p"), Some(Path::new("/n")), None);
        assert_eq!(path, "/n:/p/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    }

    #[test]
    fn a_server_running_from_an_npm_prefix_resolves_to_that_prefix() {
        let prefix = npm_prefix("ok");
        // Both launch spellings: through the bin link, and straight at bin.js.
        for command in [
            format!("node {} web --no-open --host 127.0.0.1 --port 3080", prefix.join("bin/dsh").display()),
            format!("node {} web --port 3080", prefix.join("lib/node_modules/@deepseek-ai/dsh/lib/bin.js").display()),
        ] {
            let install = resolve_install(&Probe(Some(command.clone())), managed_port()).unwrap();
            assert_eq!(install, DshInstall::Npm { prefix: prefix.clone(), npm: prefix.join("bin/npm"), node_dir: None }, "{command}");
            assert_eq!(install.launcher(), prefix.join("bin/dsh"));
            assert!(install.env()["PATH"].starts_with(&prefix.join("bin").to_string_lossy().into_owned()));
        }
        std::fs::remove_dir_all(prefix).unwrap();
    }

    #[test]
    fn a_bin_link_to_another_copy_is_refused() {
        // `<prefix>/bin/dsh` names a different package than the one running, so
        // updating the prefix would leave the running copy untouched.
        let prefix = npm_prefix("stray");
        std::fs::remove_file(prefix.join("bin/dsh")).unwrap();
        std::fs::write(prefix.join("bin/dsh"), "").unwrap();
        let command = format!("node {} web", prefix.join("lib/node_modules/@deepseek-ai/dsh/lib/bin.js").display());
        assert!(matches!(resolve_install(&Probe(Some(command)), managed_port()), Err(ServerOpError::UnsupportedInstall(_))));
        std::fs::remove_dir_all(prefix).unwrap();
    }

    #[test]
    fn a_non_global_copy_is_refused_rather_than_updating_another() {
        let root = std::env::temp_dir().join(format!("dsh-npx-{}", std::process::id()));
        let package = root.join("_npx/abcd/node_modules/@deepseek-ai/dsh");
        std::fs::create_dir_all(package.join("lib")).unwrap();
        std::fs::write(package.join("lib/bin.js"), "").unwrap();
        let command = format!("node {} web", package.join("lib/bin.js").display());
        assert!(matches!(resolve_install(&Probe(Some(command)), managed_port()), Err(ServerOpError::UnsupportedInstall(_))));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn without_an_npm_server_the_pnpm_resolution_is_unchanged() {
        let expected = resolve_dsh().map(|dsh| DshInstall::Pnpm { dsh });
        for command in [None, Some("/usr/sbin/httpd".to_string())] {
            assert_eq!(resolve_install(&Probe(command), managed_port()), expected);
        }
    }

    #[tokio::test]
    async fn npm_launch_version_comes_from_the_prefix_manifest() {
        let prefix = npm_prefix("version");
        let install = DshInstall::Npm { prefix: prefix.clone(), npm: prefix.join("bin/npm"), node_dir: None };
        assert_eq!(launch_version(&install).await, Some("0.2.1-rc.2".into()));
        std::fs::remove_dir_all(prefix).unwrap();
    }

    #[test]
    fn admin_is_needed_only_for_a_prefix_this_user_cannot_write() {
        let prefix = npm_prefix("writable");
        assert!(!npm_root_requires_admin(&prefix));
        std::fs::remove_dir_all(prefix).unwrap();
        if unsafe { libc::geteuid() } != 0 {
            // `/usr/bin` is root-owned on every Unix this runs on.
            assert!(npm_root_requires_admin(Path::new("/usr")));
        }
    }

    #[test]
    fn cancelled_authorization_is_a_client_error() {
        assert!(ServerOpError::AuthorizationCancelled.is_client_error());
        assert!(ServerOpError::UnsupportedInstall("/x".into()).message().contains("npm install -g @deepseek-ai/dsh"));
    }
}
