//! Heuristic scorer / clusterer (M2) — the "router" of the grouping
//! pipeline (execution plan E4): it scores tabs against existing
//! groups and clusters ungrouped tabs, emitting a small set of
//! candidate groupings. The Nano judge (where available) confirms or
//! rejects candidates downstream; this module never applies anything.
//!
//! Mirrored by `src/lib/scorer.ts`; both implementations share the
//! same tokenization, weights, and thresholds, and the same fixture
//! cases run in `cargo test` and in vitest (1e-6 tolerance — the
//! arithmetic is identical f64 ops in the same order).
//!
//! Features per tab: title tokens, host, path-segment tokens, and
//! the M1 canonicalizer keys. Pair score:
//!
//!   0.25 · same-host + 0.60 · title-token containment
//!   + 0.10 · path-token overlap + 0.25 · same-fuzzy-key (clamped ≤ 1)
//!
//! Title containment is |A∩B| / min(|A|, |B|) — a short title that is
//! fully contained in a longer one scores 1. It is damped by half
//! only when the shorter title has ≤2 tokens and the titles share
//! fewer than 2: a one-word title ("Recipe") must not match
//! everything containing that word. Longer titles sharing a single
//! topic word keep the plain containment — that is the normal
//! cross-site case (three pages about "sourdough").

use std::collections::{BTreeMap, BTreeSet};

/// Minimum score for "add this tab to that group" candidates.
pub const ADD_THRESHOLD: f64 = 0.45;
/// Minimum mean affinity for a tab to join a forming cluster.
pub const CLUSTER_THRESHOLD: f64 = 0.36;
/// Maximum candidate groups returned per tab (the router contract).
pub const TOP_K: usize = 5;

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "com", "for", "from",
    "get", "how", "html", "http", "https", "i", "in", "into", "is", "it",
    "its", "me", "my", "new", "of", "on", "or", "our", "page", "that",
    "the", "this", "to", "was", "we", "were", "what", "when", "where",
    "why", "with", "www", "you", "your",
];

#[derive(Debug, Clone)]
pub struct TabInput {
    pub id: i64,
    pub title: String,
    pub url: String,
    pub exact_key: Option<String>,
    pub fuzzy_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GroupInput {
    pub group_key: String,
    pub name: String,
    pub exemplars: Vec<TabInput>,
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub group_key: String,
    pub score: f64,
}

#[derive(Debug, Clone)]
pub struct Cluster {
    pub tab_ids: Vec<i64>,
    pub name_seed: String,
    pub cohesion: f64,
}

#[derive(Debug, Clone)]
struct Features {
    id: i64,
    host: String,
    title_tokens: BTreeSet<String>,
    path_tokens: BTreeSet<String>,
    fuzzy_key: Option<String>,
}

fn tokenize(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, out: &mut BTreeSet<String>| {
        if cur.len() >= 2 && !STOPWORDS.contains(&cur.as_str()) {
            out.insert(std::mem::take(cur));
        } else {
            cur.clear();
        }
    };
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            cur.extend(ch.to_lowercase());
        } else {
            flush(&mut cur, &mut out);
        }
    }
    flush(&mut cur, &mut out);
    out
}

fn features(tab: &TabInput) -> Features {
    let (host, path_tokens) = match url::Url::parse(&tab.url) {
        Ok(parsed) => {
            let host = parsed
                .host_str()
                .unwrap_or("")
                .to_lowercase()
                .trim_start_matches("www.")
                .to_string();
            let mut tokens = BTreeSet::new();
            for segment in parsed.path().split('/') {
                for tok in tokenize(segment) {
                    tokens.insert(tok);
                }
            }
            (host, tokens)
        }
        Err(_) => (String::new(), BTreeSet::new()),
    };
    Features {
        id: tab.id,
        host,
        title_tokens: tokenize(&tab.title),
        path_tokens,
        fuzzy_key: tab.fuzzy_key.clone(),
    }
}

fn title_score(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    let min = a.len().min(b.len());
    if min == 0 {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f64;
    let containment = inter / min as f64;
    if inter < 2.0 && min <= 2 {
        containment * (inter / 2.0)
    } else {
        containment
    }
}

fn overlap_coeff(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    let min = a.len().min(b.len());
    if min == 0 {
        return 0.0;
    }
    a.intersection(b).count() as f64 / min as f64
}

/// Pairwise affinity between two tabs (see module weights).
pub fn pair_score(a: &Features, b: &Features) -> f64 {
    let mut score = 0.0;
    if !a.host.is_empty() && a.host == b.host {
        score += 0.25;
    }
    score += 0.60 * title_score(&a.title_tokens, &b.title_tokens);
    score += 0.10 * overlap_coeff(&a.path_tokens, &b.path_tokens);
    if let (Some(x), Some(y)) = (&a.fuzzy_key, &b.fuzzy_key) {
        if !x.is_empty() && x == y {
            score += 0.25;
        }
    }
    score.min(1.0)
}

/// Score one tab against one group: the best exemplar pair score,
/// plus a small bonus per additional exemplar that clears 0.40.
fn group_score(tab: &Features, exemplars: &[Features]) -> f64 {
    let mut best = 0.0f64;
    let mut supporters = 0usize;
    for ex in exemplars {
        let s = pair_score(tab, ex);
        if s > best {
            best = s;
        }
        if s >= 0.40 {
            supporters += 1;
        }
    }
    if supporters > 1 {
        best = (best + 0.05 * (supporters - 1) as f64).min(1.0);
    }
    best
}

/// Top-K (≤5) candidate groups for one tab, best first, at or above
/// ADD_THRESHOLD. Ties break on group_key so output is deterministic.
pub fn score_candidates(tab: &TabInput, groups: &[GroupInput]) -> Vec<Candidate> {
    let tf = features(tab);
    let mut out: Vec<Candidate> = groups
        .iter()
        .map(|g| Candidate {
            group_key: g.group_key.clone(),
            score: group_score(&tf, &g.exemplars.iter().map(features).collect::<Vec<_>>()),
        })
        .filter(|c| c.score >= ADD_THRESHOLD)
        .collect();
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.group_key.cmp(&b.group_key))
    });
    out.truncate(TOP_K);
    out
}

fn mean_affinity(tab: &Features, members: &[Features]) -> f64 {
    if members.is_empty() {
        return 0.0;
    }
    members.iter().map(|m| pair_score(tab, m)).sum::<f64>() / members.len() as f64
}

fn name_seed(members: &[Features]) -> String {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for m in members {
        for tok in &m.title_tokens {
            *counts.entry(tok.clone()).or_default() += 1;
        }
    }
    let best = counts
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)));
    if let Some((tok, _)) = best {
        return tok.clone();
    }
    members
        .first()
        .map(|m| m.host.split('.').next().unwrap_or("").to_string())
        .unwrap_or_default()
}

/// Greedy deterministic clustering of ungrouped tabs: in id order,
/// each tab joins the forming cluster with the highest mean affinity
/// at or above CLUSTER_THRESHOLD, else starts a new cluster. Only
/// clusters of 2+ are returned, in first-tab id order.
pub fn cluster_tabs(tabs: &[TabInput]) -> Vec<Cluster> {
    let mut ordered: Vec<&TabInput> = tabs.iter().collect();
    ordered.sort_by_key(|t| t.id);
    let feats: Vec<Features> = ordered.iter().map(|t| features(t)).collect();

    let mut clusters: Vec<Vec<Features>> = Vec::new();
    for f in feats {
        let mut best_idx: Option<usize> = None;
        let mut best_aff = 0.0f64;
        for (i, members) in clusters.iter().enumerate() {
            let aff = mean_affinity(&f, members);
            if aff >= CLUSTER_THRESHOLD && aff > best_aff {
                best_aff = aff;
                best_idx = Some(i);
            }
        }
        match best_idx {
            Some(i) => clusters[i].push(f),
            None => clusters.push(vec![f]),
        }
    }

    clusters
        .into_iter()
        .filter(|members| members.len() >= 2)
        .map(|members| {
            let n = members.len();
            let mut sum = 0.0;
            let mut pairs = 0usize;
            for i in 0..n {
                for j in (i + 1)..n {
                    sum += pair_score(&members[i], &members[j]);
                    pairs += 1;
                }
            }
            Cluster {
                tab_ids: members.iter().map(|m| m.id).collect(),
                name_seed: name_seed(&members),
                cohesion: if pairs > 0 { sum / pairs as f64 } else { 0.0 },
            }
        })
        .collect()
}

/// JSON in/out for the Wasm boundary, via serde_json::Value (no
/// derive — the shipped core stays lean, matching canon.rs's
/// hand-built JSON). Wire keys are camelCase, as the TS side emits.

fn tab_from_json(v: &serde_json::Value) -> Option<TabInput> {
    Some(TabInput {
        id: v.get("id")?.as_i64()?,
        title: v.get("title")?.as_str()?.to_string(),
        url: v.get("url")?.as_str()?.to_string(),
        exact_key: v
            .get("exactKey")
            .and_then(|k| k.as_str())
            .map(|s| s.to_string()),
        fuzzy_key: v
            .get("fuzzyKey")
            .and_then(|k| k.as_str())
            .map(|s| s.to_string()),
    })
}

fn group_from_json(v: &serde_json::Value) -> Option<GroupInput> {
    let exemplars = v
        .get("exemplars")?
        .as_array()?
        .iter()
        .map(tab_from_json)
        .collect::<Option<Vec<_>>>()?;
    Some(GroupInput {
        group_key: v.get("groupKey")?.as_str()?.to_string(),
        name: v.get("name")?.as_str()?.to_string(),
        exemplars,
    })
}

/// `score_candidates` over a JSON payload:
/// `{"tab": TabInput, "groups": [GroupInput]}` → JSON `[Candidate]`.
/// Malformed payloads yield `[]`, never a panic.
pub fn score_candidates_json(payload: &str) -> String {
    let parsed: serde_json::Value =
        serde_json::from_str(payload).unwrap_or(serde_json::Value::Null);
    let (tab, groups) = match (
        parsed.get("tab").and_then(tab_from_json),
        parsed.get("groups").and_then(|g| g.as_array()),
    ) {
        (Some(tab), Some(raw_groups)) => {
            let groups: Vec<GroupInput> =
                raw_groups.iter().filter_map(group_from_json).collect();
            (tab, groups)
        }
        _ => return "[]".to_string(),
    };
    let out: Vec<serde_json::Value> = score_candidates(&tab, &groups)
        .iter()
        .map(|c| serde_json::json!({"groupKey": c.group_key, "score": c.score}))
        .collect();
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
}

/// `cluster_tabs` over a JSON payload: `[TabInput]` → JSON `[Cluster]`.
pub fn cluster_tabs_json(payload: &str) -> String {
    let parsed: serde_json::Value =
        serde_json::from_str(payload).unwrap_or(serde_json::Value::Null);
    let tabs: Vec<TabInput> = parsed
        .as_array()
        .map(|arr| arr.iter().filter_map(tab_from_json).collect())
        .unwrap_or_default();
    let out: Vec<serde_json::Value> = cluster_tabs(&tabs)
        .iter()
        .map(|c| {
            serde_json::json!({
                "tabIds": c.tab_ids,
                "nameSeed": c.name_seed,
                "cohesion": c.cohesion,
            })
        })
        .collect();
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: i64, title: &str, url: &str) -> TabInput {
        TabInput {
            id,
            title: title.to_string(),
            url: url.to_string(),
            exact_key: None,
            fuzzy_key: None,
        }
    }

    fn recipe_tabs() -> Vec<TabInput> {
        vec![
            tab(1, "Best Chicken Tikka Masala Recipe", "https://www.allrecipes.com/recipe/228293/chicken-tikka-masala"),
            tab(2, "Chicken Parmesan Recipe", "https://www.seriouseats.com/chicken-parmesan-recipe"),
            tab(3, "Easy Chicken Soup Recipe", "https://www.bbcgoodfood.com/recipes/chicken-soup"),
            tab(4, "Seattle Weather Forecast", "https://weather.com/weather/today/seattle"),
        ]
    }

    #[test]
    fn clusters_recipes_together_not_weather() {
        let clusters = cluster_tabs(&recipe_tabs());
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].tab_ids, vec![1, 2, 3]);
        assert_eq!(clusters[0].name_seed, "chicken");
        assert!(clusters[0].cohesion >= CLUSTER_THRESHOLD);
    }

    #[test]
    fn same_host_weak_titles_do_not_cluster() {
        let tabs = vec![
            tab(1, "Quarterly earnings call notes", "https://example.com/a"),
            tab(2, "Totally unrelated opinion piece", "https://example.com/b"),
        ];
        assert!(cluster_tabs(&tabs).is_empty());
    }

    #[test]
    fn candidates_rank_matching_group_first_and_cap_at_five() {
        let groups: Vec<GroupInput> = (0..7)
            .map(|i| GroupInput {
                group_key: format!("g{i}"),
                name: format!("Group {i}"),
                exemplars: vec![tab(
                    100 + i,
                    "Chicken soup recipe",
                    "https://recipes.example.com/soup",
                )],
            })
            .collect();
        let t = tab(1, "Chicken soup recipe easy", "https://recipes.example.com/soup2");
        let cands = score_candidates(&t, &groups);
        assert_eq!(cands.len(), TOP_K);
        assert!(cands.windows(2).all(|w| w[0].score >= w[1].score));
    }

    #[test]
    fn unrelated_tab_gets_no_candidates() {
        let groups = vec![GroupInput {
            group_key: "g0".to_string(),
            name: "Recipes".to_string(),
            exemplars: vec![tab(9, "Chicken soup recipe", "https://recipes.example.com/soup")],
        }];
        let t = tab(1, "Rust async runtime internals", "https://rust-lang.org/blog/async");
        assert!(score_candidates(&t, &groups).is_empty());
    }

    #[test]
    fn fuzzy_key_match_boosts_score() {
        let mut a = tab(1, "Document", "https://docs.google.com/document/d/abc/edit");
        a.fuzzy_key = Some("doc:abc".to_string());
        let mut b = tab(2, "Document", "https://docs.google.com/document/d/abc/view");
        b.fuzzy_key = Some("doc:abc".to_string());
        let score = pair_score(&features(&a), &features(&b));
        assert!(score > 0.8, "score was {score}");
    }

    #[test]
    fn json_round_trips() {
        let payload = serde_json::json!({
            "tab": {"id": 1, "title": "Chicken soup recipe", "url": "https://recipes.example.com/soup", "exactKey": null, "fuzzyKey": null},
            "groups": []
        });
        // Note: wire format uses camelCase keys from the TS side.
        let out = score_candidates_json(&payload.to_string());
        assert_eq!(out, "[]");
        let tabs = serde_json::json!([
            {"id": 1, "title": "Chicken soup recipe", "url": "https://recipes.example.com/soup"},
            {"id": 2, "title": "Chicken stew recipe", "url": "https://recipes.example.com/stew"}
        ]);
        let clusters: serde_json::Value =
            serde_json::from_str(&cluster_tabs_json(&tabs.to_string())).unwrap();
        assert_eq!(clusters.as_array().unwrap().len(), 1);
    }
}
