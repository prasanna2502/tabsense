//! TabSense Rust core.
//!
//! Exposes `normalize_url` (M0 base normalization) and
//! `canonicalize_url` (M1 canonicalizer v1, see `canon.rs`), both
//! mirrored bit-for-bit by TypeScript fallbacks (`src/lib/normalize.ts`,
//! `src/lib/canonicalize.ts`) that cover the window while this module
//! is still instantiating, per proposal §5 / §10.1 rule 4.

mod canon;

use wasm_bindgen::prelude::*;

/// Normalize a URL string:
///
/// - trims surrounding whitespace
/// - lowercases the scheme and host
/// - drops the default port (80 for http, 443 for https)
/// - uses "/" when the path is empty
/// - preserves path case, query string, and fragment
/// - returns the trimmed input unchanged when it does not parse as a URL
#[wasm_bindgen]
pub fn normalize_url(raw: &str) -> String {
    let trimmed = raw.trim();
    match url::Url::parse(trimmed) {
        Ok(parsed) => parsed.to_string(),
        Err(_) => trimmed.to_string(),
    }
}

/// Canonicalize a URL to its two M1 dedupe keys, returned as a JSON
/// string `{"exact":"...","fuzzy":"..."}`:
///
/// - `exact` — same document, same view/state (auto-close eligible)
/// - `fuzzy` — same document, possibly different view/state
///   (suggestion tier only, never auto-closed)
#[wasm_bindgen]
pub fn canonicalize_url(raw: &str) -> String {
    canon::keys_json(raw)
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    // These cases mirror tests/normalize.test.ts — both implementations
    // must agree bit-for-bit.
    #[test]
    fn lowercases_scheme_and_host_preserves_path_case() {
        assert_eq!(
            normalize_url("HTTPS://Docs.Example.COM/Some/Path"),
            "https://docs.example.com/Some/Path"
        );
    }

    #[test]
    fn drops_default_ports_keeps_others() {
        assert_eq!(normalize_url("https://example.com:443/a"), "https://example.com/a");
        assert_eq!(normalize_url("http://example.com:80/a"), "http://example.com/a");
        assert_eq!(
            normalize_url("http://example.com:8080/a"),
            "http://example.com:8080/a"
        );
    }

    #[test]
    fn empty_path_becomes_slash() {
        assert_eq!(normalize_url("https://example.com"), "https://example.com/");
        assert_eq!(
            normalize_url("https://example.com?q=1"),
            "https://example.com/?q=1"
        );
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(
            normalize_url("  https://example.com/a  "),
            "https://example.com/a"
        );
    }

    #[test]
    fn preserves_query_and_fragment() {
        assert_eq!(
            normalize_url("https://example.com/a?b=2&a=1#frag"),
            "https://example.com/a?b=2&a=1#frag"
        );
    }

    #[test]
    fn unparseable_input_returned_trimmed() {
        assert_eq!(normalize_url("not a url"), "not a url");
    }
}
