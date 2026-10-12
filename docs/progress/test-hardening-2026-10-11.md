# Test hardening — adversarial suites + four defect fixes (2026-10-11)

An exhaustive adversarial pass over the whole extension, ordered after
three dogfood bugs in two days were each found within minutes of real
use. The existing suite tested what was built; this pass tested what
can go wrong. Tests: **vitest 322 → 657, cargo 23 → 30**; TS coverage
93.4% → 95.7% statements / 89.3% → 94.3% branches; Rust core line
coverage 92.0% → 94.3%.

## Defects found and fixed

- **P0 — a duplicate pair could close BOTH tabs.** Two duplicates that
  became ready together (created while the Wasm core was starting, or
  in the same event batch) could each pick the other as "the existing
  tab" and both close, leaving no copy of the page. Fixed with
  key-arrival seniority: a tab only ever closes in favor of a tab that
  held the same canonical URL before it did. Navigating onto an open
  page still closes the navigator, as before.
- **P1 — the toolbar badge and panel snapshot went stale after
  startup.** The coalesced refresh timer re-armed itself instead of
  refreshing, so no event-driven update ever landed after init. One-line
  fix; regression tests drive the real worker through a fake chrome
  surface and watch the badge move on tab events alone.
- **P1 — a stalled on-device model create could wedge grouping
  forever.** The judge's 10 s hard timeout covered the prompt call but
  not session creation. The whole attempt is now bounded, and a session
  that arrives after the deadline is destroyed on arrival.
- **P2 — group-name guard evasions.** A judge-proposed name like
  `google.com.` (trailing dot) or the same with a fullwidth dot slipped
  past the platform-name rejection. The check now also runs on a
  normalized form.

## Defects documented with failing tests (not fixed here)

These live in the canonicalizer, which a parallel branch is actively
editing; each has a marked failing repro (`it.fails`) that turns red
the moment it is fixed, so the markers cannot rot:

- Duplicate query-param values that straddle the Unicode surrogate
  boundary sort differently in the TS fallback and the Rust core, so
  one URL can key two ways across the engine warmup boundary.
- Absurd YouTube timestamps (≥ 2^53 in unit form) normalize
  differently (float rounding vs saturating integer).
- A U+FEFF-prefixed URL parses in the TS fallback but not in the core
  (different whitespace definitions).
- `drive.google.com/open/?id=…` (trailing slash) is not recognized as
  the file it names, in both engines.
- CJK-only titles produce no tokens in either scorer, so identical
  CJK titles never group — a shared tokenizer limitation whose fix
  changes scoring semantics and benchmark baselines, so it is reported
  rather than slipped in.

One suspected cosmetic defect (a lone-surrogate favicon letter for
astral-plane titles) was tested and **refuted**; a regression test
pins the correct behavior.

## What the suites cover

- Canonicalizer property tests: 1,200 generated URLs + ~90 aimed
  probes checked bit-for-bit between the TS fallback and the real
  Wasm core; idempotence on both engines (plus a 1,500-URL Rust-side
  corpus); the shared golden corpus grew 95 → 115 cases.
- The background worker driven end-to-end through a fake chrome
  surface: cold-start queue drains, restore storms, the
  intentional-duplicate rule at each of its four boundaries, the
  100-entry activity log cap, the badge at 120 extra copies.
- Grouping: same-domain/different-topic at 30+ tabs, decoy chaining,
  mega-cluster caps, split-evaluation boundaries, a hands-off matrix
  (pinned/grouped/excluded/blocklisted × every engine rung), and
  TS↔Wasm partition parity over generated tab sets.
- The Nano judge as untrusted input: malformed and split verdicts
  fuzzed on every shape axis, retry/timeout semantics, and the
  invariant that unvalidated output is never applied, tested
  end-to-end.
- Settings precedence (managed vs local for every field), corrupt
  storage payloads, group-memory eviction at the 200-record cap,
  circuit-breaker state machine boundaries, and panel display
  helpers under 45-member sets.

Synthetic fixtures only throughout. No user-visible behavior change
beyond the four fixes — the product now keeps promises it already
made — so there is no demo video with this one.

## Merge + rebase outcome (2026-10-12)

PR #5 (anchor fold + descriptors) merged to main first — merge
commit `ad2d59a` — on the strength of its fully green run of
record 38198907148 (the user ruled on the red docs-triggered
re-run: its only diff from the green head was this progress doc,
and the two red rows are the documented noisy throttled pair).

This branch was then rebased onto the new main
(`eb0bdcc` → `94f191f`). One textual conflict (the shared golden
corpus) and two semantic ones, all resolved preserving both
branches' intent:

- Corpus: union of the anchor-fold set (99 cases, with
  `gdoc-heading` / `gdoc-two-headings` / `slides-anchor` flipped
  fuzzy→exact) and the hardening h01–h20 additions = **119
  cases**, consumed by both engines' corpus tests.
- `tests/canon-parity.test.ts`: the "docs heading anchor" variant
  pair now expects `exact` — the fold's behavior change, not a
  regression.
- `tests/panel-stress.test.ts`: generic-descriptor expectations
  updated to PR #5's name-the-difference scheme (`Varies by id`,
  `Page: other`); the precedence assertions are unchanged.

Post-rebase repro recheck: **none of D3/D4/D5/D10 was healed by
the anchor work** — all four `it.fails` repros still fail as
pinned, so no promotions. D9 (CJK tokenization) remains open,
awaiting a product call.

Suites on the rebased branch: **vitest 671/671** (29 files;
657 hardening + 14 from PR #5), **cargo 33/33** (25 unit +
1 corpus over 119 cases + 7 hardening integration), **tsc
clean**. No test or budget was relaxed by the rebase.

CI outcome: appended below once the run of record lands.

CI run of record 38275552431 (rebased head): Extension PASS,
Rust PASS, Perf FAIL on two rows — throttled p95 (pooled)
43 ms vs <25 (the known-noisy tail row; the same data under
the superseded statistic reads 19.63) and churn slope
0.058 KB/cycle vs ≤0.03, a row that passed every prior run at
0.010–0.018 with total growth still ~7× inside its cap. The
churn slope is flagged for attribution, not tuned away. Every
other row passed, including the throttled median at 8.63 ms.
(A docs-only commit appending this outcome triggers one more
CI run; it changes no code.)
