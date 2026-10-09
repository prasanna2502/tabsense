# M1 Report — Dedupe that can be trusted

Date: 2026-10-08 · Milestone: M1 · Status: build complete and verified; exit sign-off stays open pending the in-Chrome load check and the dogfood week (both manual, user's)

## 1. Shipped
- **Canonicalizer v1** in the Rust core (`core/src/canon.rs`), exposed as `canonicalize_url`
  returning two keys per URL — `exactKey` (same document, same view/state; auto-close
  eligible) and `fuzzyKey` (same document, different view/state; never auto-closed) — with a
  bit-for-bit TypeScript mirror (`src/lib/canonicalize.ts`) behind the same engine-selection
  wrapper (`src/wasm/load.ts`, which now also exposes the core lifecycle state).
  Rules: tracking-parameter stripping (utm_*, fbclid, gclid, msclkid, mc_*, ref/ref_src
  off-GitHub, HubSpot hsa_*, YouTube `si`, ~35 named params); scheme/host case, default-port,
  trailing-slash, and empty-path normalization; query-param sorting; generic fragments
  dropped (pure anchors). Document-ID rules for Google Workspace (file ID keyed; Sheets
  `gid` and Docs/Slides anchors are exact-tier state; sharing params ignored; `range`
  ignored), Google Drive (file ID, `/open?id=` unified), Notion (32-hex page ID from the
  slug, dashed-UUID and case normalized), GitHub (`.git`/trailing-slash normalized; line
  anchors and `plain` are fuzzy-tier), Figma (file key; mode and node/page selection are
  exact-tier), and YouTube (`v=` identity; `t=` normalized to seconds and `list=` are
  exact-tier; shorts/live/embed share the watch fuzzy key). Search-engine `q=` differences
  are always distinct documents. AMP/mobile variants (m./mobile./amp hosts, `/amp` path,
  `amp`/`output=amp` params) collapse only at the fuzzy tier.
- **Golden corpus**: `tests/corpus/canonical-cases.json`, 95 URL pairs labeled
  exact / fuzzy / distinct, consumed by BOTH `cargo test` (core/tests/corpus.rs) and
  vitest (tests/canonicalize.test.ts) — the parity proof for the two implementations.
- **Duplicate engine** in the service worker: in-memory exactKey index over live tabs,
  event-driven (onCreated / onUpdated / onRemoved / onAttached / onReplaced). On an
  exact-key collision for a tab whose creation or settled navigation this worker instance
  observed: activate the existing tab (plus focus its window — dedupe is global across
  windows), close the duplicate, and append a recoverable activity-log entry
  (chrome.storage.local, capped at 100, writes chained and trailing the close).
  Swap timings (event → activation completion) are recorded in a persisted 100-sample
  ring, each flagged cold (event queued during core instantiation) or warm.
- **Side panel**: canonical duplicate sets with a bulk "keep newest, close the rest"
  action (the worker re-validates the set against its live index before closing);
  fuzzy sets in a separate section labeled "Same document, different view" with no
  bulk-close; activity log with one-click Reopen per entry; an auto-close settings
  toggle (with the escape-hatch semantics from the product decisions); and a stats
  footer — swap count with cold/warm split, median/p95, active engine, core state.
- No new permissions (manifest still exactly `tabs`, `sidePanel`, `storage`); PRIVACY.md
  unchanged (dedupe is fully local).

## 2. Verified
- `cargo test`: 12 unit + 1 corpus integration test — all 95 corpus cases classify as
  labeled. `npm test` (vitest): 121/121 — the same 95 corpus cases against the TS
  fallback, plus set-builder/swap-stats/exclusion unit tests and all pre-existing suites.
- **Corpus arithmetic**: 49 exact / 25 fuzzy / 21 distinct pairs. Exact tier: 49 predicted
  exact, 49 truly exact → **precision 100%**, recall 100%. Fuzzy tier 25/25. Overall
  duplicate detection (exact ∪ fuzzy): 74/74 → precision and recall 100% on the corpus.
  Precision-critical negatives hold: different Google Docs (distinct), same Sheet
  different `gid` (fuzzy, not exact), different search queries (distinct), GitHub line
  anchors (fuzzy), Figma node-id differences (fuzzy).
- `npm run compile` (tsc) clean; `npm run build` succeeds (valid MV3 manifest, permissions
  unchanged).
- GitHub Actions run **37874597010**: **success** — Rust core job (cargo test + wasm build,
  40s) and Extension job (typecheck, unit tests, production build, 22s) both green, on the
  branch-protected `main`.
- Wasm core rebuilt with the new export: 246,601 bytes (up from the M0 stub; canonicalizer
  + URL machinery).

## 3. Decisions
- **Drive `/preview` vs `/view` are exact, not fuzzy**: Drive keys on the file ID alone,
  so preview and view share both keys. (The alternative — mode in the exact key — was
  rejected: both are the same viewer state for dedupe purposes, and the file ID is the
  documented identity.)
- **Sheets `gid` absent vs `gid=0` is fuzzy, not exact**: an absent gid renders the
  first sheet, which is usually but not provably gid 0 — precision-safe classification.
- **YouTube timestamps normalize to whole seconds**, so `t=1m30s`, `t=90s`, and `t=90`
  are exact-equal (same video at the same position).
- **`ref` is stripped everywhere except github.com**, where it can carry branch state;
  a GitHub `?ref=` difference is classified distinct (precision-safe).
- **Notion IDs are only recognized in the canonical trailing position** of the last path
  segment (or as a full dashed UUID); an ID embedded mid-slug is not guessed at.
- **Navigation evaluations wait for settle** (`status === 'complete'`): evaluating on
  every intermediate URL could close a tab mid-redirect (e.g. passing through an SSO
  URL that is open elsewhere). The settled URL is the document the user landed on.
- **Startup events are not "observed"**: tabs seen during worker init (session-restore
  storms, worker restarts) are indexed but never auto-closed; they become eligible only
  on a later observed navigation. Restored duplicate sets surface in the panel for
  manual bulk-close instead.

## 4. Blockers & escalations
- None. (Environment note carried from M0: `build:wasm` needs `~/.cargo/bin` on PATH for
  wasm-pack in this sandbox; CI is unaffected.)

## 5. Remaining
- **In-Chrome load check (user, ~2 min)** — still open from M0: load `.output/chrome-mv3`
  unpacked, confirm the panel renders with zero console errors.
- **Dogfood week (user)** — M1's exit criterion: run the build on the real browser and
  watch the activity log / swap stats. Exit sign-off stays open until then.
- Known limitations, accepted for M1: `firstSeenAt` resets on worker restart (affects
  only "keep newest" tie-breaking and which same-key tab is the focus target); swap
  medians start empty on a fresh profile and fill as swaps happen.

## 6. Next
M2 — Suggest-mode grouping: heuristics route candidate groups, Gemini Nano judges/names
them (with the degradation ladder), side-panel suggestion inbox. First public release
follows M2 per the release-scope decision.
