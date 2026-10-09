//! TabSense Rust core (M0 stub).
//!
//! Today this exposes a single real function, `normalize_url`, whose
//! behavior is mirrored bit-for-bit by the TypeScript fallback in
//! `src/lib/normalize.ts` (the fallback covers the window while this
//! module is still instantiating, per proposal §5 / §10.1 rule 4).
//! The full canonicalizer (tracking-parameter stripping, per-app
//! document IDs) lands in M1.

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
