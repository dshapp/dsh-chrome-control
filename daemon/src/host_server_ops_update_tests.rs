// Pure tests: no installer, signals or real daemon execution.
#[cfg(test)]
mod update_channel_tests {
    use super::*;
    use std::cmp::Ordering::*;
    #[test]
    fn update_targets_are_strict_and_fixed_package() {
        for target in ["latest", "next", "alpha", "1.2.3", "1.2.3-alpha.10+build.01"] {
            assert_eq!(update_target_args(target).unwrap(), vec!["add", "-g", "--registry", "https://registry.npmjs.org", &format!("@deepseek-ai/dsh@{target}")]);
        }
        for target in ["", "beta", "*", "^1.2.3", "~1.2.3", "1", "1.2", "v1.2.3", "01.2.3", "1.2.3-01", "1.2.3-", "1.2.3+", "1.2.3-a..b", "1.2.3+build..x", "1.2.3 extra", " latest", "latest\n", "@evil/pkg", "latest; touch /tmp/pwn", "--version", "file:/tmp/pkg", "https://evil/pkg"] {
            assert!(update_target_args(target).is_err(), "{target}");
        }
        assert_eq!(update_args(), vec!["add", "-g", "--registry", "https://registry.npmjs.org", "@deepseek-ai/dsh@latest"]);
    }
    #[test]
    fn semver_precedence_and_precision() {
        let ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
        for pair in ordered.windows(2) { assert_eq!(compare_versions(pair[0], pair[1]), Some(Less)); assert_eq!(compare_versions(pair[1], pair[0]), Some(Greater)); }
        assert_eq!(compare_versions("0.9.0", "0.10.0"), Some(Less));
        assert_eq!(compare_versions("1.2.3+aaa", "1.2.3+bbb"), Some(Equal));
        assert_eq!(compare_versions("1.2.3-alpha.9007199254740992", "1.2.3-alpha.9007199254740993"), Some(Less));
        assert_eq!(compare_versions("1.2.3 junk", "1.2.4"), None);
    }
    #[test]
    fn registry_tags_are_filtered_not_sorted_or_substituted() {
        assert_eq!(dist_tag_args(), vec!["view", "--registry", "https://registry.npmjs.org", "@deepseek-ai/dsh", "dist-tags", "--json"]);
        let tags = parse_dist_tags(r#"{"latest":"1.0.0","next":"1.1.0-rc.2","alpha":"2.0.0-alpha.10","evil":"99.0.0","bad":"junk"}"#).unwrap();
        assert_eq!(tags.len(), 3);
        assert_eq!(select_target_version("next", &tags), Some("1.1.0-rc.2".into()));
        assert_eq!(select_target_version("latest", &tags), Some("1.0.0".into()));
        assert_eq!(select_target_version("alpha", &HashMap::new()), None);
        assert_eq!(select_target_version("0.1.0-beta.1", &tags), Some("0.1.0-beta.1".into()));
        assert!(parse_dist_tags("offline error").is_none());
        assert!(parse_dist_tags("[]").is_none());
        assert!(parse_dist_tags(r#"{"latest":"1.2","next":false,"alpha":"1.2.3-01"}"#).unwrap().is_empty());
    }
}
