//! Golden-corpus test for the Rust canonicalizer (M1).
//!
//! Consumes the SAME corpus the TypeScript fallback is tested
//! against (tests/corpus/canonical-cases.json, repo root) — this is
//! what proves bit-for-bit parity between the Wasm core and the TS
//! mirror. Each case pairs two URLs and the expected relationship of
//! their keys:
//!   exact    — same exactKey (same fuzzyKey too)
//!   fuzzy    — different exactKey, same fuzzyKey
//!   distinct — both keys differ
//!
//! Precision bar: a case labeled fuzzy or distinct must NEVER be
//! classified exact — that would mean the engine could auto-close a
//! tab the user still needs.

use std::fs;
use std::path::PathBuf;

fn keys(url: &str) -> (String, String) {
    let json = tabsense_core::canonicalize_url(url);
    let value: serde_json::Value =
        serde_json::from_str(&json).expect("canonicalize_url must return JSON");
    (
        value["exact"].as_str().expect("exact key").to_string(),
        value["fuzzy"].as_str().expect("fuzzy key").to_string(),
    )
}

fn classify(a: &str, b: &str) -> &'static str {
    let (exact_a, fuzzy_a) = keys(a);
    let (exact_b, fuzzy_b) = keys(b);
    if exact_a == exact_b {
        "exact"
    } else if fuzzy_a == fuzzy_b {
        "fuzzy"
    } else {
        "distinct"
    }
}

#[test]
fn golden_corpus_parity() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/corpus/canonical-cases.json");
    let data = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read corpus {}: {e}", path.display()));
    let corpus: serde_json::Value =
        serde_json::from_str(&data).expect("corpus must be valid JSON");
    let cases = corpus["cases"].as_array().expect("corpus.cases array");
    assert!(
        cases.len() >= 80,
        "corpus must hold at least 80 cases, has {}",
        cases.len()
    );

    let mut failures: Vec<String> = Vec::new();
    for case in cases {
        let id = case["id"].as_str().unwrap_or("?");
        let a = case["a"].as_str().expect("case.a");
        let b = case["b"].as_str().expect("case.b");
        let expect = case["expect"].as_str().expect("case.expect");
        let got = classify(a, b);
        if got != expect {
            let (ea, fa) = keys(a);
            let (eb, fb) = keys(b);
            failures.push(format!(
                "{id}: expected {expect}, got {got}\n  a: {a}\n  b: {b}\n  exact: {ea} vs {eb}\n  fuzzy: {fa} vs {fb}"
            ));
        }
        // Invariants beyond the label: an exact pair must share the
        // fuzzy key too; a distinct pair must not share the fuzzy key
        // (that would make it fuzzy by definition — guarded above, but
        // asserted here for the precision report).
        if expect == "exact" {
            let (_, fa) = keys(a);
            let (_, fb) = keys(b);
            assert_eq!(fa, fb, "{id}: exact pair must share fuzzyKey");
        }
    }
    assert!(
        failures.is_empty(),
        "{} corpus case(s) failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
