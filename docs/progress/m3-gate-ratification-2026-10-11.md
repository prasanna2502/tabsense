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
