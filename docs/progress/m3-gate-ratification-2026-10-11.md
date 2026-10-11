# M3 gate ratification — 2026-10-11

Branch: `gate/m3-ratification` (off main @ 6bbcc3f). The two M3
exit-gate decisions flagged in the M3 report were put to the user
with the CI evidence in front of him; **both recommendations were
adopted on 2026-10-11**. This branch implements them. No
user-visible behavior changed; no demo accompanies this branch.

## Decision 1 — churn budget ratified as two explicit bounds

The old entry (`memory-growth-5000-cycles`, budget 0, comparison
`~`, "no positive leak slope") failed by construction: the
measured slope was 0.010–0.011 KB/cycle in CI and ~0.015 KB/cycle
(15 B/cycle) locally — never literally zero — while total growth
(+93 KB local, ~60 KB CI) sat ~20x inside the 2 MB bound the
harness already evaluated implicitly.

perf-budgets.json is now **v2**. The `~` entry is replaced by:

| New budget id | Bound | Unit |
| --- | --- | --- |
| `memory-growth-5000-cycles-total` | total growth < 2 | MB |
| `memory-growth-5000-cycles-slope` | leak slope <= 0.03 | KB/cycle |

The slope bound is **2x the worst observed value** (0.015
KB/cycle). The ratification — date, decision-maker, and the
observed values it was calibrated on — is recorded in the file's
`notes`, and the harness churn gates now read these entries
through a unit-tested comparator (`scripts/perf/gates.mjs`).

## Decision 2 — latency methodology: median of rounds, budgets untouched

The <10 ms median / <25 ms p95 budgets are **unchanged**. What
changed is how a verdict is produced, because single-shot on/off
deltas on shared CI runners were measuring the runner: the
throttled p95 went +97.5 / +92.3 ms (fail) on main's runs and
-43 ms (pass) on PR #1's run with equivalent code, and the warm
median flickered to 10.351 ms against its <10 ms line.

- Warm and 4x-throttled profiles now run **5 rounds** of
  extension-on vs extension-off. Each round yields an added
  median and p95; the gate statistic is the **median across
  rounds**. All rounds run and every round's raw values are in
  the uploaded report artifact — the median decides; there are
  no retries-until-pass.
- Every round keeps the existing first-tab warm-up discard.
- Cold stays single-shot and informational.
- The swap completion checks — the other single-shot checks,
  which reported 0-of-5 in both first CI runs while their own raw
  data showed 4-of-5 swaps landing — now run **3 rounds of 5
  iterations**, with iteration 0 of rounds 2–3 recorded as a
  discarded round warm-up. A round counts only if every counted
  iteration lands and closes its duplicate; the timing gate is
  the slowest counted sample across rounds.
- CI-time cost: the latency scenario grows from ~1 minute to
  ~4 minutes locally (measured 244 s); the swap scenario is
  unchanged in practice (~11 s). The perf job's 75-minute timeout
  is unaffected in kind — churn remains the dominant scenario.

## Validation

- vitest 315/315 (301 before + 14 new gate-logic tests), cargo
  23/23, `tsc --noEmit` clean. Permissions unchanged (no manifest
  or source changes at all — harness, budgets, and docs only).
- Local harness (this VM — informational; CI is the arbiter):
  - Swap: **PASS** — 3/3 rounds fully landed and closed; slowest
    counted sample 47 ms vs <150 ms.
  - Warm latency: median-of-rounds Δmedian 2.56 ms, Δp95 7.5 ms
    — PASS against <10 / <25.
  - Throttled latency on this loaded 2-core VM: Δmedian
    14.25 ms, Δp95 54.64 ms — FAIL locally (round 5 alone was
    -14.25 / -38.79 ms; local throttled figures have swung
    +20…+82 ms across past runs). Reported as-is; CI decides.
  - Churn code path exercised on a reduced 1,000-cycle run
    (informational gates): both ratified entries evaluated with
    correct ids, units, and comparisons.

## CI outcome

_Updated when the PR's CI run completes — see the addendum at the
end of this file._

## CI outcome — PR #2, run 38152995111 (2026-10-11)

Extension job PASS, Rust job PASS. Perf gate job: **FAIL by one
row** (58m16s). Row by row against perf-budgets.json v2:

| Check | Measured | Budget | Result |
| --- | --- | --- | --- |
| Warm added latency, median (median of 5 rounds) | 1.59 ms | < 10 ms | PASS |
| Warm added latency, p95 (median of 5 rounds) | 3.61 ms | < 25 ms | PASS |
| Throttled added latency, median (median of 5 rounds) | -5.54 ms | < 10 ms | PASS |
| **Throttled added latency, p95 (median of 5 rounds)** | **101.07 ms** | **< 25 ms** | **FAIL** |
| Cold added latency, median / p95 (informational) | 0.57 / -3.81 ms | < 10 / < 25 ms | PASS |
| Swap landed, all rounds | 3 of 3 rounds | — | PASS |
| Swap duplicate closed, all rounds | 3 of 3 rounds | — | PASS |
| Slowest focus-swap (counted samples) | 14 ms | < 150 ms | PASS |
| Marginal memory per tab | 0.525 KB | < 20 KB | PASS |
| Worker heap at 500 tabs (and after restore) | 3.41 / 3.36 MB | < 50 MB | PASS |
| Index rebuild, 500-tab restore | 19.7 ms | < 100 ms | PASS |
| Restored tabs auto-closed | 0 | = 0 | PASS |
| Restore storm: 300/300 restored, 0 auto-closed | — | — | PASS |
| **Churn leak slope (ratified)** | **0.011 KB/cycle** | **<= 0.03 KB/cycle** | **PASS** |
| **Churn total growth (ratified)** | **0.057 MB** | **< 2 MB** | **PASS** |
| Idle: worker network requests / CPU in 15 s | 0 / 0.002 s | = 0 | PASS |

**The M3 exit clock has NOT started** — the criterion is every
budget green, and the throttled p95 row is red.

Reading the failure: the per-round throttled p95 deltas were
-116.21, +203.64, +107.91, +5.11, +101.07 ms (median 101.07),
while the throttled *median* deltas were small or negative in 4
of 5 rounds and the warm p95 deltas clustered tightly
(-1.75…+5.86 ms). Each round's throttled p95 delta is a
difference of two tail order statistics over ~39 samples under
4x CPU throttling on a shared runner; the extension's own
per-tab work measures 0.0067 ms p95 in the unit corpus and the
warm profile — same code path — shows no such tail. The pattern
implicates the statistic (p95-of-small-samples differencing
under throttling), not extension code. No further tuning was
applied in this branch; what to do about this row is a fresh
decision (larger throttled batches, a pooled-percentile
statistic, or a throttled-specific budget shape) — deliberately
not made here.
