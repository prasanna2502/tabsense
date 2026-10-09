//! Canonicalizer v1 (M1): maps a URL to TWO keys.
//!
//! - `exact` — post-normalization identity. Two tabs with the same exact
//!   key are the same document in the same view/state; the duplicate
//!   engine may auto-close the newer one.
//! - `fuzzy` — same document, possibly a different view/state. Fuzzy
//!   matches are NEVER auto-closed; they are the suggestion tier.
//!
//! Precision-first: when a rule is uncertain, the pair must land in
//! fuzzy or distinct, never exact. The TypeScript mirror in
//! `src/lib/canonicalize.ts` implements this exact specification and
//! both are held to bit-for-bit parity by the golden corpus in
//! `tests/corpus/canonical-cases.json` (consumed by `cargo test` and
//! by vitest).
//!
//! Key formats:
//! - generic pages: the rebuilt normalized URL itself
//! - Google Workspace docs: `gdoc:<app>:<fileId>[/rest][#state]`,
//!   fuzzy `gdoc:<app>:<fileId>`
//! - Google Drive files: `gdrive:file:<fileId>` (exact == fuzzy)
//! - Notion pages: `notion:<32-hex page id>` (exact == fuzzy)
//! - Figma files: `figma:<mode>:<fileKey>[?node-id=..&page-id=..]`,
//!   fuzzy `figma:<fileKey>`
//! - YouTube videos: `yt:watch|shorts|live|embed:<videoId>[?list=..&t=..]`,
//!   fuzzy `yt:video:<videoId>`; playlists `yt:playlist:<listId>`
//! - GitHub: the generic rebuilt URL (fragment kept in exact, dropped
//!   in fuzzy together with the `plain`/`ts` view params)
//! - non-http(s) or unparseable input: the trimmed input, unchanged,
//!   for both keys (the engine excludes those schemes anyway)

use url::Url;

/// The two canonical keys for one URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonKeys {
    pub exact: String,
    pub fuzzy: String,
}

fn identity(trimmed: &str) -> CanonKeys {
    CanonKeys {
        exact: trimmed.to_string(),
        fuzzy: trimmed.to_string(),
    }
}

/// Tracking parameters removed from every key. Exact names, matched
/// case-sensitively (the canonical forms are lowercase), plus any name
/// starting with `utm_` (matched case-insensitively).
const TRACKING_PARAMS: &[&str] = &[
    "fbclid",
    "gclid",
    "dclid",
    "gbraid",
    "wbraid",
    "gclsrc",
    "gad_source",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "ref_src",
    "ref_url",
    "igshid",
    "twclid",
    "li_fat_id",
    "s_cid",
    "spm",
    "scm",
    "vero_id",
    "yclid",
    "rb_clickid",
    "s_kwcid",
    "_hsenc",
    "_hsmi",
    "hsa_acc",
    "hsa_cam",
    "hsa_grp",
    "hsa_ad",
    "hsa_src",
    "hsa_tgt",
    "hsa_kw",
    "hsa_mt",
    "hsa_net",
    "hsa_ver",
];

/// Is this query parameter a tracker? `host` is the canonical host:
/// `ref` is stripped everywhere EXCEPT github.com, where it can carry
/// branch state; `si` (YouTube share id) is stripped on YouTube hosts.
fn is_tracking(name: &str, host: &str) -> bool {
    // Byte-wise utm_ prefix check (a &str slice could panic on a
    // multi-byte char boundary in an exotic param name).
    let b = name.as_bytes();
    if b.len() >= 4
        && (b[0] == b'u' || b[0] == b'U')
        && (b[1] == b't' || b[1] == b'T')
        && (b[2] == b'm' || b[2] == b'M')
        && b[3] == b'_'
    {
        return true;
    }
    if TRACKING_PARAMS.contains(&name) {
        return true;
    }
    if name == "ref" && host != "github.com" {
        return true;
    }
    if name == "si" && is_youtube_host(host) {
        return true;
    }
    false
}

fn is_youtube_host(host: &str) -> bool {
    matches!(
        host,
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtu.be"
    )
}

/// Filter tracking params and sort by (name, value) — byte order, which
/// matches the TS mirror's comparison for the ASCII names/values the
/// corpus uses. Duplicate names are kept.
fn clean_pairs(pairs: &[(String, String)], host: &str) -> Vec<(String, String)> {
    let mut kept: Vec<(String, String)> = pairs
        .iter()
        .filter(|(name, _)| !is_tracking(name, host))
        .cloned()
        .collect();
    kept.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    kept
}

fn encode_pairs(pairs: &[(String, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.extend_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    serializer.finish()
}

/// Remove a single trailing slash from a path longer than "/".
fn norm_path(path: &str) -> String {
    if path.len() > 1 && path.ends_with('/') {
        path[..path.len() - 1].to_string()
    } else if path.is_empty() {
        "/".to_string()
    } else {
        path.to_string()
    }
}

fn build_url(
    scheme: &str,
    auth: &str,
    host: &str,
    port: Option<u16>,
    path: &str,
    pairs: &[(String, String)],
    fragment: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str(scheme);
    out.push_str("://");
    out.push_str(auth);
    out.push_str(host);
    if let Some(p) = port {
        out.push(':');
        out.push_str(&p.to_string());
    }
    out.push_str(path);
    if !pairs.is_empty() {
        out.push('?');
        out.push_str(&encode_pairs(pairs));
    }
    if let Some(frag) = fragment {
        if !frag.is_empty() {
            out.push('#');
            out.push_str(frag);
        }
    }
    out
}

/// Fuzzy-tier host: strip one leading `www`, `m`, `mobile`, or `amp`
/// label (mobile/AMP host variants of the same document).
fn fuzzy_host(host: &str) -> String {
    for label in ["www.", "mobile.", "amp.", "m."] {
        if let Some(rest) = host.strip_prefix(label) {
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    host.to_string()
}

/// Fuzzy-tier path: drop a trailing `/amp` segment (AMP variant).
fn fuzzy_path(path: &str) -> String {
    if let Some(rest) = path.strip_suffix("/amp") {
        if rest.is_empty() {
            return "/".to_string();
        }
        return rest.to_string();
    }
    path.to_string()
}

/// Fuzzy-tier params: drop AMP markers (`amp` param, `output=amp`).
fn fuzzy_pairs(pairs: &[(String, String)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .filter(|(name, value)| name != "amp" && !(name == "output" && value == "amp"))
        .cloned()
        .collect()
}

struct Parts {
    scheme: String,
    auth: String,
    host: String,
    port: Option<u16>,
    path: String,
    pairs: Vec<(String, String)>,
    fragment: Option<String>,
}

impl Parts {
    /// Path split into non-empty segments.
    fn segments(&self) -> Vec<&str> {
        self.path.split('/').filter(|s| !s.is_empty()).collect()
    }
    fn param(&self, name: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// The canonicalizer entry point (internal; the Wasm export wraps it).
pub fn canonical_keys(raw: &str) -> CanonKeys {
    let trimmed = raw.trim();
    // Only http(s) URLs get canonical treatment. Everything else
    // (chrome://, about:, data:, unparseable text) is its own key —
    // identical behavior to normalize_url's "return trimmed" rule, and
    // the engine excludes those schemes before deciding anything.
    let scheme_end = match trimmed.find(':') {
        Some(i) => i,
        None => return identity(trimmed),
    };
    let scheme_probe = trimmed[..scheme_end].to_ascii_lowercase();
    if scheme_probe != "http" && scheme_probe != "https" {
        return identity(trimmed);
    }
    let url = match Url::parse(trimmed) {
        Ok(u) => u,
        Err(_) => return identity(trimmed),
    };
    let host = url.host_str().unwrap_or("").to_string();
    let auth = if url.username().is_empty() {
        String::new()
    } else {
        match url.password() {
            Some(pw) => format!("{}:{}@", url.username(), pw),
            None => format!("{}@", url.username()),
        }
    };
    let parts = Parts {
        scheme: url.scheme().to_string(),
        auth,
        host,
        port: url.port(),
        path: url.path().to_string(),
        pairs: url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect(),
        fragment: url.fragment().map(|f| f.to_string()),
    };

    // Host used for app matching: bare domain (no leading www.).
    let bare_host = parts
        .host
        .strip_prefix("www.")
        .unwrap_or(&parts.host)
        .to_string();

    if bare_host == "docs.google.com" {
        if let Some(keys) = google_docs(&parts) {
            return keys;
        }
    } else if bare_host == "drive.google.com" {
        if let Some(keys) = google_drive(&parts) {
            return keys;
        }
    } else if is_notion_host(&parts.host) {
        if let Some(keys) = notion(&parts) {
            return keys;
        }
    } else if bare_host == "github.com" {
        return github(&parts);
    } else if bare_host == "figma.com" {
        if let Some(keys) = figma(&parts) {
            return keys;
        }
    } else if is_youtube_host(&parts.host) {
        if let Some(keys) = youtube(&parts) {
            return keys;
        }
    }
    generic(&parts)
}

/// Generic pages: exact is the rebuilt normalized URL (tracking params
/// stripped, remaining params sorted, fragment dropped — a section
/// anchor is the same document). Fuzzy additionally collapses
/// www/m/mobile/amp host variants, `/amp` path variants, and AMP
/// query markers.
fn generic(parts: &Parts) -> CanonKeys {
    let host = &parts.host;
    let pairs = clean_pairs(&parts.pairs, host);
    let path = norm_path(&parts.path);
    let exact = build_url(
        &parts.scheme,
        &parts.auth,
        host,
        parts.port,
        &path,
        &pairs,
        None,
    );
    let fuzzy = build_url(
        &parts.scheme,
        &parts.auth,
        &fuzzy_host(host),
        parts.port,
        &fuzzy_path(&path),
        &fuzzy_pairs(&pairs),
        None,
    );
    CanonKeys { exact, fuzzy }
}

/// GitHub: like generic, but the fragment carries application state
/// (line anchors `#L12`, diff anchors), so it stays in the exact key
/// and drops out of fuzzy; the `plain`/`ts` view params also drop out
/// of fuzzy. A `.git` suffix on the repo segment is normalized away.
fn github(parts: &Parts) -> CanonKeys {
    let pairs = clean_pairs(&parts.pairs, "github.com");
    let mut path = norm_path(&parts.path);
    let segs: Vec<&str> = path.split('/').collect();
    // segs[0] is "" (leading slash); repo name is segs[2].
    if segs.len() > 2 {
        if let Some(repo) = segs[2].strip_suffix(".git") {
            let mut owned: Vec<String> = segs.iter().map(|s| s.to_string()).collect();
            owned[2] = repo.to_string();
            path = owned.join("/");
        }
    }
    let exact = build_url(
        &parts.scheme,
        &parts.auth,
        "github.com",
        parts.port,
        &path,
        &pairs,
        parts.fragment.as_deref(),
    );
    let fuzzy_pairs: Vec<(String, String)> = pairs
        .iter()
        .filter(|(n, _)| n != "plain" && n != "ts")
        .cloned()
        .collect();
    let fuzzy = build_url(
        &parts.scheme,
        &parts.auth,
        "github.com",
        parts.port,
        &path,
        &fuzzy_pairs,
        None,
    );
    CanonKeys { exact, fuzzy }
}

/// Google Workspace (Docs / Sheets / Slides): key on the file ID.
/// View state — the path tail after the ID (`/edit`, `/view`), a Docs/
/// Slides fragment (heading / slide anchor), a Sheets `gid` — makes
/// exact keys differ but never the fuzzy key. Sharing/source params
/// (usp, ouid, …) never enter either key.
fn google_docs(parts: &Parts) -> Option<CanonKeys> {
    let segs = parts.segments();
    let app = *segs.first()?;
    if !matches!(app, "document" | "spreadsheets" | "presentation") {
        return None;
    }
    // Path shape: /<app>/[u/<n>/]d/<id>[/<rest>...]
    let d_idx = segs.iter().position(|s| *s == "d")?;
    if d_idx == 0 {
        return None;
    }
    let id = segs.get(d_idx + 1)?;
    if id.is_empty() {
        return None;
    }
    let rest = &segs[d_idx + 2..];
    let mut exact = format!("gdoc:{app}:{id}");
    if !rest.is_empty() {
        exact.push('/');
        exact.push_str(&rest.join("/"));
    }
    match app {
        "spreadsheets" => {
            if let Some(gid) = sheets_gid(parts) {
                exact.push_str("#gid=");
                exact.push_str(&gid);
            }
        }
        _ => {
            if let Some(frag) = &parts.fragment {
                if !frag.is_empty() {
                    exact.push('#');
                    exact.push_str(frag);
                }
            }
        }
    }
    Some(CanonKeys {
        exact,
        fuzzy: format!("gdoc:{app}:{id}"),
    })
}

/// A Sheets `gid` lives in the fragment (`#gid=123&range=A1:B2`) and is
/// sometimes mirrored in the query. The fragment wins. The `range`
/// (a cell selection, like scroll position) is deliberately NOT part
/// of either key.
fn sheets_gid(parts: &Parts) -> Option<String> {
    if let Some(frag) = &parts.fragment {
        for pair in frag.split('&') {
            if let Some(v) = pair.strip_prefix("gid=") {
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    parts.param("gid").map(|v| v.to_string())
}

/// Google Drive file pages key on the file ID alone — `/view`,
/// `/preview`, and the `/open?id=` form are the same file. Exact and
/// fuzzy are identical here.
fn google_drive(parts: &Parts) -> Option<CanonKeys> {
    let segs = parts.segments();
    if segs.len() >= 3 && segs[0] == "file" && segs[1] == "d" && !segs[2].is_empty() {
        let key = format!("gdrive:file:{}", segs[2]);
        return Some(CanonKeys {
            exact: key.clone(),
            fuzzy: key,
        });
    }
    if parts.path == "/open" {
        if let Some(id) = parts.param("id") {
            if !id.is_empty() {
                let key = format!("gdrive:file:{id}");
                return Some(CanonKeys {
                    exact: key.clone(),
                    fuzzy: key,
                });
            }
        }
    }
    None
}

fn is_notion_host(host: &str) -> bool {
    host == "notion.so"
        || host.ends_with(".notion.so")
        || host == "notion.site"
        || host.ends_with(".notion.site")
}

/// Notion pages embed a 32-hex page ID in the last path segment
/// (`Some-Title-<32hex>`, a bare `<32hex>`, or a dashed UUID). Key on
/// the ID, lowercased, dashes removed. Title slugs and query params
/// (`pvs`, …) are not identity.
fn notion(parts: &Parts) -> Option<CanonKeys> {
    let segs = parts.segments();
    let last = *segs.last()?;
    let id = extract_notion_id(last)?;
    let key = format!("notion:{id}");
    Some(CanonKeys {
        exact: key.clone(),
        fuzzy: key,
    })
}

fn extract_notion_id(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    // Dashed UUID anywhere in the segment: 8-4-4-4-12 hex groups.
    if segment.len() >= 36 {
        for start in 0..=(segment.len() - 36) {
            let cand = &segment[start..start + 36];
            let cb = cand.as_bytes();
            if cb[8] == b'-'
                && cb[13] == b'-'
                && cb[18] == b'-'
                && cb[23] == b'-'
                && cand
                    .chars()
                    .enumerate()
                    .all(|(i, c)| [8, 13, 18, 23].contains(&i) || c.is_ascii_hexdigit())
            {
                return Some(cand.replace('-', "").to_lowercase());
            }
        }
    }
    // Trailing run of exactly 32 hex chars (whole segment, or after '-').
    if segment.len() >= 32 {
        let tail = &segment[segment.len() - 32..];
        if tail.chars().all(|c| c.is_ascii_hexdigit()) {
            let before_ok = segment.len() == 32 || bytes[segment.len() - 33] == b'-';
            if before_ok {
                return Some(tail.to_lowercase());
            }
        }
    }
    None
}

/// Figma files: key on the file key. The mode segment (`design`,
/// `file`, `proto`, `board`, `slides`) and the selection state
/// (`node-id`, `page-id`) are exact-tier only; every other param is
/// dropped (`t` is a share timestamp, `type` duplicates the mode).
fn figma(parts: &Parts) -> Option<CanonKeys> {
    let segs = parts.segments();
    let mode = *segs.first()?;
    if !matches!(mode, "design" | "file" | "proto" | "board" | "slides") {
        return None;
    }
    let key = segs.get(1)?;
    if key.is_empty() {
        return None;
    }
    let mut state: Vec<(String, String)> = ["node-id", "page-id"]
        .iter()
        .filter_map(|name| parts.param(name).map(|v| (name.to_string(), v.to_string())))
        .collect();
    state.sort();
    let mut exact = format!("figma:{mode}:{key}");
    if !state.is_empty() {
        exact.push('?');
        exact.push_str(&encode_pairs(&state));
    }
    Some(CanonKeys {
        exact,
        fuzzy: format!("figma:{key}"),
    })
}

/// YouTube: `v=` is the video identity. `t=` / `start=` (playback
/// position) and `list=` (playlist context) are view state — exact
/// tier only. `t` is normalized to whole seconds so `1m30s`, `90s`,
/// and `90` agree. Shorts/live/embed are the same video in a different
/// UI: same fuzzy key, different exact key.
fn youtube(parts: &Parts) -> Option<CanonKeys> {
    if parts.host == "youtu.be" {
        let segs = parts.segments();
        if segs.len() == 1 && !segs[0].is_empty() {
            return Some(youtube_watch(segs[0], parts));
        }
        return None;
    }
    let segs = parts.segments();
    match segs.first().copied() {
        Some("watch") if segs.len() == 1 => {
            let vid = parts.param("v")?;
            if vid.is_empty() {
                return None;
            }
            Some(youtube_watch(vid, parts))
        }
        Some(kind @ ("shorts" | "live" | "embed")) if segs.len() == 2 && !segs[1].is_empty() => {
            Some(CanonKeys {
                exact: format!("yt:{kind}:{}", segs[1]),
                fuzzy: format!("yt:video:{}", segs[1]),
            })
        }
        Some("playlist") if segs.len() == 1 => {
            let list = parts.param("list")?;
            if list.is_empty() {
                return None;
            }
            let key = format!("yt:playlist:{list}");
            Some(CanonKeys {
                exact: key.clone(),
                fuzzy: key,
            })
        }
        _ => None,
    }
}

fn youtube_watch(vid: &str, parts: &Parts) -> CanonKeys {
    let mut state: Vec<(String, String)> = Vec::new();
    if let Some(list) = parts.param("list") {
        if !list.is_empty() {
            state.push(("list".to_string(), list.to_string()));
        }
    }
    for name in ["start", "t"] {
        if let Some(v) = parts.param(name) {
            if !v.is_empty() {
                state.push((name.to_string(), normalize_timestamp(v)));
            }
        }
    }
    state.sort();
    let mut exact = format!("yt:watch:{vid}");
    if !state.is_empty() {
        exact.push('?');
        exact.push_str(&encode_pairs(&state));
    }
    CanonKeys {
        exact,
        fuzzy: format!("yt:video:{vid}"),
    }
}

/// Normalize a YouTube timestamp to whole seconds: `90`, `90s`,
/// `1m30s`, `1h2m3s`, `1m30`. Unparseable values pass through
/// unchanged (the TS mirror implements this identical algorithm).
fn normalize_timestamp(raw: &str) -> String {
    if !raw.is_empty() && raw.chars().all(|c| c.is_ascii_digit()) {
        let t = raw.trim_start_matches('0');
        return if t.is_empty() {
            "0".to_string()
        } else {
            t.to_string()
        };
    }
    let mut total: u64 = 0;
    let mut num: u64 = 0;
    let mut seen_num = false;
    let mut seen_unit = false;
    for c in raw.chars() {
        if c.is_ascii_digit() {
            num = num.saturating_mul(10).saturating_add(c as u64 - '0' as u64);
            seen_num = true;
        } else {
            let mult: u64 = match c {
                'h' => 3600,
                'm' => 60,
                's' => 1,
                _ => return raw.to_string(),
            };
            if !seen_num {
                return raw.to_string();
            }
            total = total.saturating_add(num.saturating_mul(mult));
            num = 0;
            seen_num = false;
            seen_unit = true;
        }
    }
    if !seen_unit {
        return raw.to_string();
    }
    if seen_num {
        total = total.saturating_add(num); // trailing bare seconds, e.g. "1m30"
    }
    total.to_string()
}

/// Minimal JSON string escaping (keys are URL-shaped, but identity
/// keys for unparseable input can contain anything).
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

/// Serialize keys as `{"exact":"...","fuzzy":"..."}` for the Wasm
/// boundary (the TS side parses this; the TS fallback builds the same
/// shape natively).
pub fn keys_json(raw: &str) -> String {
    let keys = canonical_keys(raw);
    format!(
        "{{\"exact\":\"{}\",\"fuzzy\":\"{}\"}}",
        json_escape(&keys.exact),
        json_escape(&keys.fuzzy)
    )
}

#[cfg(test)]
mod tests {
    use super::canonical_keys;

    fn keys(raw: &str) -> (String, String) {
        let k = canonical_keys(raw);
        (k.exact, k.fuzzy)
    }

    #[test]
    fn gdoc_same_doc_sharing_params_are_exact() {
        let (e1, f1) = keys("https://docs.google.com/document/d/ABC123/edit?usp=sharing");
        let (e2, f2) = keys("https://docs.google.com/document/d/ABC123/edit");
        assert_eq!(e1, "gdoc:document:ABC123/edit");
        assert_eq!(e1, e2);
        assert_eq!(f1, f2);
    }

    #[test]
    fn gdoc_heading_anchor_is_fuzzy_not_exact() {
        let (e1, f1) = keys("https://docs.google.com/document/d/ABC123/edit#heading=h.xyz");
        let (e2, f2) = keys("https://docs.google.com/document/d/ABC123/edit");
        assert_ne!(e1, e2);
        assert_eq!(f1, f2);
    }

    #[test]
    fn sheets_gid_is_fuzzy_not_exact() {
        let (e1, f1) = keys("https://docs.google.com/spreadsheets/d/S1/edit#gid=0");
        let (e2, f2) = keys("https://docs.google.com/spreadsheets/d/S1/edit#gid=42");
        assert_ne!(e1, e2);
        assert_eq!(f1, f2);
        assert_eq!(f1, "gdoc:spreadsheets:S1");
    }

    #[test]
    fn search_queries_are_distinct() {
        let (e1, f1) = keys("https://www.google.com/search?q=cats");
        let (e2, f2) = keys("https://www.google.com/search?q=dogs");
        assert_ne!(e1, e2);
        assert_ne!(f1, f2);
    }

    #[test]
    fn youtube_timestamp_formats_agree() {
        let (e1, _) = keys("https://www.youtube.com/watch?v=V1&t=1m30s");
        let (e2, _) = keys("https://www.youtube.com/watch?v=V1&t=90");
        assert_eq!(e1, e2);
        assert_eq!(e1, "yt:watch:V1?t=90");
    }

    #[test]
    fn notion_keys_on_page_id() {
        let (e1, _) = keys(
            "https://www.notion.so/My-Page-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?pvs=4",
        );
        assert_eq!(e1, "notion:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d");
    }
}
