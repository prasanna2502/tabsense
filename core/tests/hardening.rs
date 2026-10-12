//! Rust-core hardening tests (test-hardening commission).
//!
//! Property and boundary tests for the core's public surface:
//!  - canonicalizer idempotence over a generated corpus (an exact
//!    key fed back in must reproduce itself — the worker
//!    re-canonicalizes on core-ready reindex),
//!  - timestamp normalization at the u64 saturation boundary (the
//!    spec the TS mirror is held to; see defect D4),
//!  - doc-ID extraction edges asserted as absolute expectations,
//!  - the scorer JSON boundary: malformed payloads degrade to
//!    `[]`, never a panic (the Wasm boundary must not throw into
//!    the worker).

use tabsense_core::{canonicalize_url, cluster_tabs, normalize_url, score_candidates};

fn keys(url: &str) -> (String, String) {
    let value: serde_json::Value =
        serde_json::from_str(&canonicalize_url(url)).expect("keys JSON");
    (
        value["exact"].as_str().unwrap().to_string(),
        value["fuzzy"].as_str().unwrap().to_string(),
    )
}

/// Tiny deterministic LCG (Numerical Recipes constants) — no
/// external crates, same corpus on every run.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[(self.next() % items.len() as u64) as usize]
    }
    fn id(&mut self, len: usize) -> String {
        const ALPHABET: &[u8] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
        (0..len)
            .map(|_| ALPHABET[(self.next() % 64) as usize] as char)
            .collect()
    }
}

fn generated_urls(count: usize) -> Vec<String> {
    let mut r = Lcg(0x5eed_2026_1011);
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let url = match r.below(7) {
            0 => format!(
                "https://{}example.com/{}{}",
                r.pick(&["", "www.", "m.", "mobile."]),
                r.pick(&["post", "a/b/c", "story/amp", "Article/Case", ""]),
                r.pick(&["", "?utm_source=x&id=3", "?b=2&a=1", "?q=cats&dogs=1", "#frag"]),
            ),
            1 => {
                let app = r.pick(&["document", "spreadsheets", "presentation"]);
                let frag = if app == "spreadsheets" {
                    format!("#gid={}", r.below(1000))
                } else {
                    r.pick(&["", "#heading=h.z", "#slide=id.p"]).to_string()
                };
                format!(
                    "https://docs.google.com/{app}/d/{}/edit{frag}",
                    r.id(28)
                )
            }
            2 => {
                let suffix = match r.below(3) {
                    0 => format!("/file/d/{}/view?usp=sharing", r.id(24)),
                    1 => format!("/open?id={}", r.id(24)),
                    _ => format!("/drive/folders/{}", r.id(24)),
                };
                format!("https://drive.google.com{suffix}")
            }
            3 => {
                let hex: String = (0..32)
                    .map(|_| "0123456789abcdef".chars().nth((r.next() % 16) as usize).unwrap())
                    .collect();
                format!(
                    "https://{}/{}{}",
                    r.pick(&["www.notion.so", "acme.notion.site", "notion.so"]),
                    r.pick(&["Page-", "Notes-", ""]),
                    hex
                )
            }
            4 => format!(
                "https://github.com/user{}/repo{}{}",
                r.below(50),
                r.pick(&["", ".git"]),
                r.pick(&["", "/issues/3", "/blob/main/a.ts#L9", "?plain=1"])
            ),
            5 => format!(
                "https://www.figma.com/{}/{}{}",
                r.pick(&["design", "file", "proto", "board", "slides"]),
                r.id(22),
                r.pick(&["", "?node-id=1-2", "?page-id=0%3A1&node-id=3-4", "?t=zzz"])
            ),
            _ => format!(
                "https://www.youtube.com/watch?v={}{}",
                r.id(11),
                r.pick(&["", "&t=90", "&t=1m30s", "&t=1h2m3s", "&list=PL123"])
            ),
        };
        out.push(url);
    }
    out
}

#[test]
fn canonicalizer_idempotence_over_generated_corpus() {
    for url in generated_urls(1500) {
        let (exact, fuzzy) = keys(&url);
        let (exact2, _) = keys(&exact);
        assert_eq!(exact2, exact, "exact key not a fixed point for {url}");
        // Fuzzy keys are fixed points of the fuzzy tier too: the
        // fuzzy key of the fuzzy key (when it is still a URL) must
        // be itself.
        if fuzzy.starts_with("http") {
            let (_, fuzzy2) = keys(&fuzzy);
            assert_eq!(fuzzy2, fuzzy, "fuzzy key drifts for {url}");
        }
    }
}

#[test]
fn timestamp_normalization_saturates_at_u64() {
    // Spec for the unit form: saturate, never wrap, never float.
    // (The TS mirror's f64 accumulation is defect D4.)
    let (exact, _) = keys("https://www.youtube.com/watch?v=V&t=99999999999999999999h");
    assert_eq!(exact, "yt:watch:V?t=18446744073709551615");
    let (exact, _) = keys("https://www.youtube.com/watch?v=V&t=9007199254740993s");
    assert_eq!(exact, "yt:watch:V?t=9007199254740993");
    // The digits-only form passes through verbatim (no arithmetic),
    // however long it is.
    let (exact, _) = keys("https://www.youtube.com/watch?v=V&t=99999999999999999999999999");
    assert_eq!(exact, "yt:watch:V?t=99999999999999999999999999");
    // Leading zeros collapse in the digits-only form.
    let (exact, _) = keys("https://www.youtube.com/watch?v=V&t=000090");
    assert_eq!(exact, "yt:watch:V?t=90");
}

#[test]
fn doc_id_extraction_edges() {
    // The FIRST 'd' segment anchors the id.
    let (exact, _) = keys("https://docs.google.com/document/d/FIRSTID/edit");
    assert_eq!(exact, "gdoc:document:FIRSTID/edit");
    // An id that is itself the letter 'd'.
    let (exact, _) = keys("https://docs.google.com/document/d/d/edit");
    assert_eq!(exact, "gdoc:document:d/edit");
    // Empty id segment: segments() drops empty segments, so the
    // mode word lands in the id slot — 'gdoc:document:edit'. Both
    // engines share this (the TS mirror filters identically);
    // Google never mints such a URL, so the collision class is
    // theoretical. Characterized here, not filed as a defect.
    let (exact, _) = keys("https://docs.google.com/document/d//edit");
    assert_eq!(exact, "gdoc:document:edit");
    // The same shape without the double slash keys identically.
    let (exact2, _) = keys("https://docs.google.com/document/d/edit");
    assert_eq!(exact2, "gdoc:document:edit");
    // App segment missing its id entirely.
    let (exact, _) = keys("https://docs.google.com/document/d");
    assert_eq!(exact, "https://docs.google.com/document/d");
    // Export is a rest segment (a view), not a separate document.
    let (exact, fuzzy) = keys("https://docs.google.com/document/d/ABC/export?format=pdf");
    assert_eq!(exact, "gdoc:document:ABC/export");
    assert_eq!(fuzzy, "gdoc:document:ABC");
    // A URL-shaped string whose scheme probe has uppercase.
    let (exact, _) = keys("HTTPS://DOCS.GOOGLE.COM/document/d/ABC/edit");
    assert_eq!(exact, "gdoc:document:ABC/edit");
    // Whitespace inside the input is not trimmed away mid-string.
    let (exact, _) = keys("https://example.com/a b");
    assert_eq!(exact, "https://example.com/a%20b");
}

#[test]
fn normalize_url_edges() {
    assert_eq!(normalize_url(""), "");
    assert_eq!(normalize_url("   "), "");
    assert_eq!(
        normalize_url("https://example.com:443"),
        "https://example.com/"
    );
    // IDN host normalizes to punycode (UTS-46, non-transitional).
    assert_eq!(normalize_url("https://faß.de/"), "https://xn--fa-hia.de/");
}

#[test]
fn scorer_json_boundary_never_panics_and_degrades_to_empty() {
    for payload in [
        "",
        "not json",
        "{}",
        "[]",
        "null",
        "{\"tab\":null,\"groups\":[]}",
        "{\"tab\":{\"id\":\"x\",\"title\":1},\"groups\":[]}",
        "{\"tab\":{\"id\":1,\"title\":\"t\",\"url\":\"u\"},\"groups\":[{\"groupKey\":1}]}",
        "{\"tab\":{\"id\":1,\"title\":\"t\",\"url\":\"u\"},\"groups\":null}",
    ] {
        let out = score_candidates(payload);
        let parsed: serde_json::Value =
            serde_json::from_str(&out).expect("score_candidates must return JSON");
        assert!(parsed.is_array(), "payload {payload} → {out}");
    }
    for payload in [
        "",
        "not json",
        "{}",
        "null",
        "[{\"id\":1}]",
        "[{\"id\":1,\"title\":\"t\"}]",
        "[{\"id\":\"x\",\"title\":\"t\",\"url\":\"u\"}]",
        "[{\"id\":1,\"title\":\"t\",\"url\":\"u\"},{\"bad\":true}]",
    ] {
        let out = cluster_tabs(payload);
        let parsed: serde_json::Value =
            serde_json::from_str(&out).expect("cluster_tabs must return JSON");
        assert!(parsed.is_array(), "payload {payload} → {out}");
    }
    // A tab missing optional keys still clusters with its twin.
    let tabs = serde_json::json!([
        {"id": 1, "title": "Chicken soup recipe", "url": "https://r.example/soup"},
        {"id": 2, "title": "Chicken stew recipe", "url": "https://r.example/stew"}
    ]);
    let out = cluster_tabs(&tabs.to_string());
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 1);
}

#[test]
fn scorer_json_handles_extreme_inputs() {
    // A pathological tab count stays bounded and fast enough for
    // a unit test — the greedy clusterer is O(n² · cluster), and
    // 300 same-host tabs must not blow up the worker.
    let tabs: Vec<serde_json::Value> = (0..300)
        .map(|i| {
            serde_json::json!({
                "id": i,
                "title": format!("Report section {i} summary"),
                "url": format!("https://reports.example.com/q{i}"),
            })
        })
        .collect();
    let out = cluster_tabs(&serde_json::Value::Array(tabs).to_string());
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(parsed.is_array());
    // Absurdly long title / URL strings parse and score.
    let big_title = "x".repeat(100_000);
    let payload = serde_json::json!({
        "tab": {"id": 1, "title": big_title, "url": "https://e.example/a"},
        "groups": []
    });
    assert_eq!(score_candidates(&payload.to_string()), "[]");
}
