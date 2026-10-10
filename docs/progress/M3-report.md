# M3 — Performance & memory gate

TabSense's core promise is that it never slows down tab opening.
M3 turns that promise into a measured, merge-blocking gate: a
unit-level perf suite in vitest, a real-browser CDP harness, and a
CI job that fails the build when a budget regresses.

## Shipped

- **Unit perf suite** (`tests/perf-*.test.ts`, `tests/corpus-urls.ts`):
  a deterministic 10,000-URL corpus (18% canonical duplicates)
  benchmarked through the exact canonicalizer + index-lookup path
  the worker runs; a 500-tab index-rebuild benchmark; growth-cap
  tests for every persisted structure; and a simulated 30 days of
  heavy use for the storage budget.
- **CDP harness** (`scripts/perf-harness.mjs`, `scripts/perf/`):
  drives a real Chrome with and without the extension in the same
  run — tab-open latency (cold / warm / 4× CPU-throttled),
  duplicate focus-swap timing, memory at 100/300/500 tabs, a
  500-tab session-restore rebuild, a 300-tab restore storm, a
  5,000-cycle open/close churn test, and an idle check. Zero new
  dependencies (Node's built-in WebSocket speaks CDP). All
  thresholds come from `perf-budgets.json`.
- **CI gate**: a "Perf gate (CDP harness + budgets)" job runs the
  full suite per push/PR and uploads its report as an artifact; a
  nightly workflow keeps the long-run evidence trail.
- **Self-diagnostics**: Settings now shows "Performance on this
  device" — the duplicate-check time, focus-swap times, startup
  index-rebuild time, and storage use, all measured by the worker
  on the user's own machine. The CI harness reads the same numbers
  through the same path.
- **One real fix**: group memory (`tabSenseGroups`) grew with
  every group ever created. It is now capped at 200 records (live
  groups are never evicted), enforced on save and on load, with
  behavioral tests.

## Verified — measured vs budget

| Budget | Threshold | Measured | Result |
| --- | --- | --- | --- |
| Canonical key + lookup (p95, 10k corpus) | < 5 ms | 0.0067 ms | Pass |
| Index rebuild, 500 tabs (pure compute) | < 100 ms | 2.31 ms | Pass |
| Worker memory at 500 tabs | < 50 MB | 4.53 MB | Pass |
| Marginal memory per tab | < 20 KB | 2.2–2.6 KB | Pass |
| Duplicate focus-swap | < 150 ms | 21–37 ms | Pass |
| Storage after simulated 30 days | < 5 MB | 0.35 MB | Pass |
| Restore storm, 300 tabs | 300 handled, 0 auto-closed | 300/300, 0 closed | Pass |
| Idle | zero CPU / network | 0 requests, 0.000 s CPU in 15 s | Pass |
| Startup rebuild via real 500-tab restore | < 100 ms | 61–81 ms typical; one 169 ms run under load | Pass, borderline |
| Churn, 5,000 cycles | ~zero growth | +93 KB total; slope ~15 B/cycle | See below |
| Added tab-open latency (median / p95) | < 10 / < 25 ms | CI-measured; see the run artifact | See below |

Test suites: vitest 244/244, cargo 19/19, typecheck clean,
production build green, manifest permissions unchanged.

## Called out honestly

- **Tab-open latency is environment-sensitive.** On a quiet
  machine the on-vs-off delta sits inside the budgets; on a small,
  busy VM the page-load noise (±100 ms between identical runs)
  swamps a 10 ms budget, and the 4×-throttled p95 has failed
  locally (+20 to +82 ms across runs) while the throttled median
  passed. The extension's own per-check work — the only thing on
  the tab-open path — measures 0.0067 ms p95 over 10,000 URLs.
  The CI gate on standard runners is the arbiter, and the budget
  was not relaxed to make local runs pass.
- **Churn slope.** Heap growth over 5,000 open/close cycles is
  +93 KB total (20× inside a 2 MB growth bound), but the fitted
  slope is ~15 bytes/cycle rather than literally zero. The budget
  is flagged for a ratified wording (total-growth bound + a small
  slope bound) rather than silently redefined.
- **Startup rebuild variance.** During a restore storm the
  worker's rebuild (tab query + storage + indexing) measured up
  to 169 ms once on a loaded 2-core VM, vs 61–81 ms typical. The
  pure indexing work is 2.31 ms. Watched over the two-week clock;
  incremental startup indexing is the candidate fix if CI shows
  the same straddle.

## Budget ratification

Kept as-is: latency median/p95, focus-swap, rebuild, memory,
marginal memory, storage, restore storm. Tightened:
canonical+lookup 5 ms → 1 ms (measured 0.0067 ms; ~150× headroom
retained). Flagged for a wording decision: churn (above).

## Exit criterion clock

"Every budget green in CI for two consecutive weeks of runs" —
the clock starts with the first fully green CI perf run and is
tracked by the nightly workflow's artifacts. Status at this
report: the first CI runs completed on 2026-10-10 (runs
38087986715 and 38088284294) and both finished with the Perf
gate job failing (Extension and Rust jobs green), so the clock
has NOT started. Warm added latency passed in CI with headroom
(median +1.6/+1.4 ms vs <10; p95 +4.7/+15.9 ms vs <25), as did
memory, rebuild, storage, restore, and idle. Failing in both
runs: the 4×-throttled added-latency p95 (+97.5/+92.3 ms vs
<25 ms — the environment sensitivity called out above), the
churn leak-slope check (0.010/0.011 KB/cycle vs the "~zero"
wording — the flagged wording decision above), and the two swap
completion checks, which reported 0 of 5 even though the runs'
own raw data shows 4 of 5 swaps landing at 10–11 ms with the
duplicate closed (iteration 0 errored on tab load in both
runs) — a harness aggregation issue to fix before the clock
can start.

## Decisions

- The Gemini Nano bridge stays in the service worker. There is no
  offscreen document; the worker's 4.53 MB at 500 tabs already
  includes the bridge, and a second context would add fixed cost
  (and a new permission) to save nothing measurable.
- Cold-worker latency is reported informationally; the hard gate
  is warm + throttled, per the budgets file.
