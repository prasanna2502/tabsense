# M3 gate design change — interleaved ABBA latency measurement (2026-10-11)

Branch: `gate/latency-interleaved-design` (off main @ f991ad6,
PR #3 merged). PR #4. Harness-only: no extension source changed,
no budget number changed, no user-visible behavior changed; no
demo accompanies this branch.

## Why

PR #3's run (38158520765) passed the pooled throttled p95
(-37.7 ms) but failed the throttled added-latency *median* at
21.61 ms vs the <10 ms budget — a row that read -5.54 ms in
PR #2's run with no extension change in between. A
performance-engineering review (user-approved 2026-10-11)
concluded the sequential block design itself was the flaw: each
round ran a full baseline browser batch, then a full extension
browser batch, minutes apart, so shared-runner drift between the
blocks signed the delta — the design's run-to-run swing
(~±30 ms) exceeded the budget it enforces. The methodology was
pre-registered in `perf-budgets.json` (ratification-style note)
before this branch's CI run.

## The change

- **Interleaved ABBA blocks.** Each warm / 4x-throttled round now
  runs a baseline and an extension browser side by side,
  alternating blocks of 5 tab-opens in ABBA order (off, on, on,
  off). Both conditions sample the same minutes of runner
  weather; within each ABBA quartet the two conditions' time
  centroids coincide, so linear drift cancels in the paired
  difference.
- **The added-latency median (warm and throttled) gates on the
  median of the paired block differences** — per-quartet paired
  deltas pooled across rounds (`pairedBlockMedianDelta` in
  `scripts/perf/gates.mjs`). The warm p95 keeps the ratified
  median-of-rounds; the throttled p95 keeps PR #3's pooled
  percentile over the interleaved samples. The superseded
  median-of-rounds statistics remain as informational rows.
- **Unique-only latency batches.** Duplicate opens (previously
  25% of each batch) resolve by detach in the extension
  condition but by full load in the baseline, contaminating the
  added-latency estimand; the duplicate path keeps its own
  duplicate-focus-swap budget and scenario.
- **Warm-up**: one unmeasured block per browser per round
  replaces the per-batch first-tab discard for the interleaved
  profiles (cold keeps its discard; cold stays single-shot
  informational). Measurement convention unchanged
  (`Target.createTarget` → `Page.loadEventFired`, timeouts
  excluded).

Validation: vitest 332/332 (10 new pairing tests, including a
crafted drifting series the sequential design reads as +60 ms
while the paired statistic recovers the true +20 ms), cargo
23/23, `tsc --noEmit` clean. Local latency exercise (330 s,
noise-dominated VM): all four gated rows passed (warm median
paired 2.33 ms; warm p95 -1.5 ms; throttled median paired
-2.38 ms; throttled p95 pooled -44.4 ms; 30 + 20 pairs, 0
dropped blocks). CI is the arbiter.

## CI (PR #4, run 38168302003) — NOT fully green

Extension PASS, Rust PASS, Perf gate FAIL (two red rows):

- **Warm median (paired): 1.177 ms vs <10 PASS.** The 30 paired
  differences are tight (every one within ±6.31 ms) — the
  interleaved design resolved warm added latency to ~1 ms.
- **Warm p95: -2.2 ms vs <25 PASS.**
- **Throttled median (paired): 37.485 ms vs <10 FAIL.** 14 of 20
  paired differences are positive; rounds 4 and 5 are uniformly
  positive (+18.46 … +266.06 ms). The superseded
  median-of-rounds statistic independently reads 33.4 ms. Under
  a design that cancels drift — and that just resolved the warm
  effect to ~1 ms on the same run — the throttled median now
  reads as **real signal, not runner noise**. Per the user's
  stop rule, no further tuning was applied; attributing this
  cost is a separate decision.
- **Throttled p95 (pooled): -38.5 ms vs <25 PASS** (196 on /
  193 off samples; pooled p95s 1889.9 / 1928.4 ms — absolute
  loads ran ~2x slower than PR #3's run; this runner was
  heavily loaded).
- **Swap completion rows: FAIL (2 of 3 rounds).** In round 3's
  last counted iteration the *original* tab did not load within
  15 s, so that round's completeness checks fail. Every swap
  that ran landed in 10–15 ms and the timing gate passed
  (slowest 15 ms vs <150 ms). This branch does not touch the
  swap scenario or the extension; the same checks passed 3/3
  in PRs #2 and #3. Reported as-is: it is a red row in this
  run regardless of cause.
- Churn (ratified bounds): slope 0.011 <= 0.03 KB/cycle PASS;
  total 0.058 MB < 2 MB PASS. Memory, restore-storm (300/300,
  0 auto-closes), and idle all PASS.

**Exit clock: still NOT started** — the criterion is every
budget green in CI for two consecutive weeks, and this run is
not fully green. PR #4 is left open; merging is the user's
call. A docs-only commit after this run retriggered CI on the
PR; the code-bearing run of record is 38168302003.
