# M3 gate follow-up — throttled p95 pooled percentile (2026-10-11)

Branch: `gate/throttled-pooled-p95` (off main @ 2f57ff4, PR #2
merged). The one red row of the gate-ratification run — throttled
added-latency p95 — was put to the user with the per-round
evidence; **the pooled-percentile statistic was approved on
2026-10-11** and this branch implements it. No budget number
changed; no user-visible behavior changed; no demo accompanies
this branch.

## The change

PR #2's ratification run (38152995111) gated the throttled p95
at a median-of-rounds of **101.07 ms vs the <25 ms budget** —
while the throttled *median* gated at -5.54 ms and every warm
row passed. The per-round throttled p95 deltas were -116.21,
+203.64, +107.91, +5.11, +101.07 ms: each round's delta is a
difference of two tail order statistics over ~39 samples under
4x CPU throttling on a shared runner, and with three of five
rounds drawing > +100 ms, the median inherited the noise.

For the **throttled p95 only**, the gate statistic is now a
pooled percentile:

- All rounds' raw per-sample durations are pooled per condition
  — extension-on samples together, extension-off samples
  together (195 samples per pool at the ratified 5 rounds
  instead of ~39 per round).
- One p95 is computed per pool; the gate is
  pooled-p95(on) − pooled-p95(off) against the **unchanged
  <25 ms** budget.
- The pooling reuses the samples the harness already records
  (`durationsMs` per variant per round) — no extra rounds, no
  material CI-time change.

Everything else is exactly as ratified in PR #2: warm median
and p95 and the throttled median keep median-of-rounds; cold
stays single-shot informational; swap, churn, and idle are
untouched. The evidence trail keeps the noise visible: the
superseded throttled median-of-rounds p95 is reported as an
informational row, the per-round p95 deltas remain in
`measurements.rounds`, and the artifact's
`measurements.throttledP95Pooled` records the pool counts, both
pooled p95s, and the gated delta. The verdict logic is a pure
function (`pooledP95Delta` in `scripts/perf/gates.mjs`),
unit-tested alongside the ratified comparators; the methodology
is also recorded in perf-budgets.json's notes (budget values
verified byte-identical — only the p95 metric text and the
notes changed).

## Validation

- vitest **322/322** (315 before + 7 new pooled-statistic
  tests: pooling correctness, the harness percentile
  convention on pooled sets, divergence from per-round p95
  differencing, delta sign, single-sample and empty/non-finite
  edges), cargo **23/23**, `tsc --noEmit` clean. Permissions
  unchanged — this branch touches no extension source
  (harness, budgets text, tests, docs only).
- Local harness, latency scenario only (this VM —
  informational; CI is the arbiter): the pooled path ran
  end-to-end. 195 on / 195 off samples; pooled p95 on
  1261.3 ms, off 1062.5 ms, delta **+198.8 ms — FAIL
  locally**, as local throttled always does on this loaded
  2-core VM (the superseded median-of-rounds read 53.56 ms
  on the same run; per-round deltas swung -352.48…+395.69 ms
  as the VM's load drifted across the 466 s run). Reported
  as-is; CI decides.

## CI outcome

_Updated when the PR's CI run completes — see the addendum at
the end of this file._
