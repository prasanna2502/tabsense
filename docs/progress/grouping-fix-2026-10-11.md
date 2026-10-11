# Grouping fix: semantic guardrails, intentional duplicates, judge partitions — 2026-10-11

Branch: `fix/semantic-grouping-guardrails`

Dogfooding found that every Google Doc landed in one bucket: the
on-device model had never downloaded, grouping silently ran on the
heuristics fallback, and the fallback's scorer treated the shared
platform (suffix tokens like "Google Docs" plus the same-host term)
as topic overlap. Three phases fix the layers involved.

## Shipped

**Phase 1 — scorer guardrails + model-state UX**
- Platform title suffixes are stripped before tokenization, and tab
  pairs on the same multi-document platform host (Google
  Docs/Drive, Notion, Figma) earn no host credit: they cluster
  only on genuine cleaned-title overlap. Rust core and TypeScript
  mirror in exact parity.
- Settings now surfaces a missing on-device model prominently —
  "Chrome has the model registered but not downloaded — it
  downloads the first time it's used" — with a one-click download
  (progress shown; state flips to "Grouping: on-device AI" when
  ready). Availability is checked proactively at worker start and
  panel open. While grouping runs on a fallback rung, the panel
  names the active engine; degraded quality is never silent.
- Benchmark-Lite gained a same-domain/different-topic suite
  (Google Docs/Sheets/Slides, Notion) plus same-topic positive
  controls.

**Phase 2 — intentional-duplicate exemption**
- A tab created exactly the way the browser's Duplicate command
  creates it (same canonical page, opened from that tab, landing
  immediately to its right, source active) is never auto-closed
  and never focus-stolen; the keep is written to the activity log.
  The exemption is per tab at one canonical URL and ends on
  navigation away or close. New setting "Keep tabs I duplicate on
  purpose" (default on) follows the usual local/managed
  precedence; off restores the previous behavior exactly.

**Phase 3 — engine-change invalidation, name rejection, judge partitions**
- Pending suggestions are stamped with the engine that produced
  them (provider + rung, persisted). A pass under a different
  engine discards the previous engine's pending suggestions —
  logged as "Discarded N suggestions from the previous grouping
  engine" — and regenerates. Acted-on suggestions are untouched.
- A proposed group name that is just a platform/domain name
  ("Google", "Google Docs", "docs.google.com", "Notion", …) is
  invalid output for the judge and the heuristics alike.
- The Nano judge gained a `split` verdict: a strictly validated
  partition (sub-groups + explicit ungrouped list, every tab
  accounted for exactly once). Cluster drafts are routed to
  partition evaluation when they exceed 8 tabs, share one
  multi-doc platform host with low title cohesion, or carry a
  name whose token appears in under 60% of member titles.
  Same-platform mega-cluster drafts are capped at 8 on non-judge
  rungs. Partition-derived suggestions are marked as such
  ("On-device AI · split by topic"). New benchmark session
  `kestrel-docs`: 20 synthetic same-domain work docs, five latent
  topics, decoy singletons.

## Verified

- vitest 301/301, cargo test 23/23, `tsc --noEmit` clean; Wasm
  rebuilt. Manifest permissions unchanged; perf budgets untouched.
- Benchmark-Lite (heuristics floor — Nano does not run here):
  - Same-domain suite, before → after (this corpus, pre-fix
    scorer): the negative suites collapsed into one bucket each
    (pairwise precision 0.0%); after the fix they score perfectly
    and the positive controls cluster fully. Extended-corpus
    aggregate: P 43.5% → 77.3%, F1 43.3% → 52.3%, BCubed F1
    74.7% → 83.0%.
  - Honest regression: on the original 12 sessions, F1 moves
    48.7% → 44.6%, entirely in `work-docs`, whose perfect score
    was itself produced by the bug (a roadmap doc grouped only
    via platform-suffix tokens; ground truth there is
    intent-based). Precision is unchanged everywhere.
  - With `kestrel-docs` (17 sessions / 125 tabs): P 77.6% ·
    R 46.4% · F1 58.1%; BCubed F1 84.7%; clicks 47 vs 91. The
    Kestrel session itself scores P 78.6% · R 100% on heuristics
    (a decoy chains in; an unrelated pair forms) — a corpus judge
    test verifies the partition path resolves the same blob into
    the five topic groups with decoys ungrouped.

## Decisions

- Platform-pair scoring: host term withheld, content terms
  renormalized, title containment undamped — the minimum change
  that lets genuine same-topic docs cluster while disjoint docs
  cannot.
- Split indices are 1-based (as listed to the judge) and a valid
  partition must account for every tab exactly once.
- The forced-split thresholds (8 tabs; cohesion < 0.36; name
  token in < 60% of titles) are new, documented, and tunable.

## Next

- Re-dogfood the fixed build; watch for the M3 exit-gate decisions
  (churn wording, throttled-p95 methodology), which this branch
  does not touch.
