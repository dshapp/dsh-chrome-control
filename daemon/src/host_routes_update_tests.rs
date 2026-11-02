#[cfg(test)]
mod update_protocol_tests {
    use super::*;
    use crate::host_guard::ALLOWED_ORIGIN;
    use crate::server::router;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;
    #[test]
    fn old_empty_requests_default_to_latest() {
        assert_eq!(server_target(b"").unwrap(), "latest");
        assert_eq!(server_target(b"{}").unwrap(), "latest");
        for target in ["latest", "next", "alpha", "1.2.3-beta.10+build.01"] {
            let body = format!(r#"{{"target":"{target}"}}"#);
            assert_eq!(server_target(body.as_bytes()).unwrap(), target);
        }
    }
    #[tokio::test]
    async fn invalid_requests_fail_before_any_subprocess_or_lock() {
        for path in ["/host/server/version", "/host/server/update"] {
            for body in [r#"{"target":"^1.2.3"}"#, r#"{"target":"1.2.3; echo pwn"}"#, r#"{"target":"latest","package":"evil"}"#, r#"{"command":"pnpm add -g evil"}"#, r#"{"target":null}"#, r#"{"target":42}"#, r#"[]"#, r#"null"#, r#"{broken"#] {
                let req = Request::builder().method("POST").uri(path).header("origin", ALLOWED_ORIGIN).header("content-type", "application/json").body(Body::from(body)).unwrap();
                let resp = router().oneshot(req).await.unwrap();
                assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{path} {body}");
                let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
                let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert!(value["error"].is_string());
            }
        }
    }
    #[tokio::test]
    async fn new_target_requests_keep_origin_guard() {
        for path in ["/host/server/version", "/host/server/update"] {
            for origin in [None, Some("https://evil.test"), Some("chrome-extension://not-authorized")] {
                let mut req = Request::builder().method("POST").uri(path).header("content-type", "application/json");
                if let Some(origin) = origin { req = req.header("origin", origin); }
                let resp = router().oneshot(req.body(Body::from(r#"{"target":"next"}"#)).unwrap()).await.unwrap();
                assert_eq!(resp.status(), StatusCode::FORBIDDEN);
            }
        }
    }
}
