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

## CI outcome — PR #3, run 38158520765 (2026-10-11)

Extension job PASS, Rust job PASS. Perf gate job: **FAIL by one
row** (52m12s — pooling added no material CI time vs PR #2's
58m16s; churn remains dominant at ~36.5 min). Row by row
against perf-budgets.json v2:

| Check | Measured | Budget | Result |
| --- | --- | --- | --- |
| Warm added latency, median (median of 5 rounds) | 2.65 ms | < 10 ms | PASS |
| Warm added latency, p95 (median of 5 rounds) | 3.43 ms | < 25 ms | PASS |
| **Throttled added latency, median (median of 5 rounds)** | **21.61 ms** | **< 10 ms** | **FAIL** |
| **Throttled added latency, p95 (pooled, 193 on / 190 off)** | **-37.7 ms** | **< 25 ms** | **PASS** |
| Throttled p95, median of rounds (superseded, informational) | -9.84 ms | < 25 ms | PASS |
| Cold added latency, median / p95 (informational) | 4.04 / 18.96 ms | < 10 / < 25 ms | PASS |
| Swap landed + closed, all rounds | 3 of 3 rounds | — | PASS |
| Slowest focus-swap (counted samples) | 19 ms | < 150 ms | PASS |
| Marginal memory per tab | 0.478 KB | < 20 KB | PASS |
| Worker heap at 500 tabs (and after restore) | 3.38 / 3.48 MB | < 50 MB | PASS |
| Index rebuild, 500-tab restore | 31.4 ms | < 100 ms | PASS |
| Restored tabs auto-closed | 0 | = 0 | PASS |
| Restore storm: 300/300 restored, 0 auto-closed | — | — | PASS |
| Churn leak slope (ratified) | 0.018 KB/cycle | <= 0.03 KB/cycle | PASS |
| Churn total growth (ratified) | 0.099 MB | < 2 MB | PASS |
| Idle: worker network requests / CPU in 15 s | 0 / 0.001 s | = 0 | PASS |

**The pooled statistic did its job.** The throttled p95 gated
at **-37.7 ms** (pooled p95: 894.1 ms extension-on vs
931.8 ms extension-off over 193/190 pooled samples) — a clear
pass, where PR #2's median-of-rounds read +101.07 ms. The
per-round p95 deltas this run were -9.84, +78.22, +48.61,
-131.11, -117.13 ms; the superseded median-of-rounds statistic
would also have passed (-9.84 ms, reported informationally).

**The run is nevertheless NOT fully green, and the M3 exit
clock has NOT started.** A different row failed: the throttled
added-latency **median** (median-of-rounds, unchanged by this
branch) gated at **21.61 ms vs <10 ms**. Its per-round deltas
were +86.92, -4.10, +43.37, +21.61, +11.16 ms — positive in
four of five rounds, where PR #2's run gated this row at
-5.54 ms. Readings: under 4x throttling a tab-open takes
~600–900 ms in this environment, so deltas of ±10–90 ms are
1–10% of the absolute times, and each round measures baseline
and extension sequentially, so runner-load drift between the
two runs lands in the delta with a sign that flips run to run
(the same row swung from -5.54 to +21.61 with no code change
in between). Nothing in this branch touched that statistic,
and no further tuning is applied here: whether the throttled
median needs the same treatment, a different comparison
shape, or is showing something real at the median is a fresh
decision — deliberately not made in this branch.
