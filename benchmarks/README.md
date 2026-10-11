# Benchmark-Lite

A small, reproducible grouping benchmark that ships with the repo
(the M2 baseline; the full competitive suite is a later milestone).

## Run it

```sh
npm run bench
```

This compiles the production grouping pipeline (`src/lib/`) with
`tsc` into `benchmarks/.build/`, runs it over the corpus, prints a
per-session table, and writes `benchmarks/results.json`.

## Corpus

`sessions.json` — 12 scripted sessions, 85 tabs total. Each session
is a realistic open-tab set (title + URL as Chrome reports them)
with **human-labeled expected groups**: the groups a person
organizing by hand would file the tabs into. Tabs in no expected
group are expected to stay ungrouped. Ground truth is labeled by
intent, not by what the engine can reach — the corpus deliberately
includes hard cases: lexically diverse headlines about one story,
same-host template titles (YouTube) that must *not* merge music
into woodworking, product pages for one item sold under different
brand names, and a bank tab that the default blocklist must keep
out of every suggestion.

## Metrics

- **Pairwise precision / recall / F1** over all tab pairs
  (micro-averaged for the aggregate): a pair is positive when both
  tabs land in the same predicted cluster / expected group.
- **BCubed precision / recall / F1** (item-weighted mean): the
  per-tab view of the same partition quality.
- **Clicks-to-organized**: a simulated user works the suggestion
  inbox — accept a correct suggestion (1 click), toggle off a
  wrong member (1 click each), dismiss a wrong suggestion (1
  click), then manually file whatever the engine missed (1 action
  per tab). Compared against the manual baseline: create each
  expected group by hand (1 click) and drag every member tab (1
  each).

## What is NOT measured here

Gemini Nano does not run in this benchmark — it is unavailable in
CI and in headless sandboxes. The numbers are the **heuristics
rung only**: the honest floor. The Nano judge (semantic
confirm/reject + naming) and per-user learning are expected to
raise recall substantially; that claim gets tested when a Nano
harness exists, not asserted here.

## Baseline (M2, 2026-10-09)

See `results.json` for the full record. Headline: pairwise
P 73.7% · R 36.4% · F1 48.7%; BCubed F1 80.0%; clicks-to-organized
37 vs a 64-click manual baseline (−42%). The router is
precision-leaning by design — a wrong suggestion costs more trust
than a missed one — and its misses concentrate exactly where a
lexical engine should miss: cross-site groups whose titles share
a single topic word, and semantic equivalence with no lexical
overlap ("UPLIFT Desk V2" vs "Jarvis Bamboo"). Its one precision
failure is same-host template titles absorbing unrelated videos.
Targets are set from this baseline and gated from M3 onward.

## Current record (semantic-grouping guardrails, 2026-10-11)

The corpus grew a "same-domain, different-topic" suite: Google
Docs/Sheets/Slides and Notion sets with disjoint topics that must
not cluster, plus same-topic positive controls on the same
platforms (16 sessions, 105 tabs). On this corpus the pre-fix
scorer collapsed — pairwise P 43.5% · R 43.0% · F1 43.3%; BCubed
F1 74.7% — because each negative suite landed in a single bucket
(pairwise precision 0.0% on both). Post-fix: **pairwise P 77.3% ·
R 39.5% · F1 52.3%; BCubed F1 83.0%; clicks-to-organized 40 vs
73** — both negative suites score perfectly (zero false clusters)
and both positive controls cluster fully.

On the original 12 sessions alone, the fix costs recall:
P 71.4% · R 32.5% · F1 44.6%; BCubed F1 79.0% (was P 73.7% ·
R 36.4% · F1 48.7%; BCubed 80.0%). The entire delta is one
session, `work-docs`, whose perfect score was itself a symptom
of the bug: "Product Roadmap 2027" grouped with the Q4 docs only
through the stripped platform-suffix tokens. Ground truth groups
it by project intent, which title tokens cannot recover; the
Nano judge is the intended recovery path in production. Every
other original session is unchanged, and precision is unchanged
everywhere.

## Phase 3 addition (judge partitions, 2026-10-11)

The corpus gained `kestrel-docs`: 20 synthetic docs.google.com
tabs (invented codenames only) across five latent topics — a
project's RFCs and team syncs, two learning series, a ramp plan —
plus decoy singletons (a different product's status doc, an
onsite agenda that lexically shadows the learning series). On
the heuristics rung it scores P 78.6% · R 100% · F1 88.0%:
recall is perfect, but the onsite decoy chains into the learning
group and two unrelated "renewal" docs pair up. That is exactly
the failure the Nano judge's new `split` verdict exists to
correct in production: over-merged candidates are routed to a
partition evaluation, and a corpus test drives the full blob
through verdict validation into per-topic suggestions with the
decoys left ungrouped. The benchmark itself still measures the
heuristics floor only. Corpus totals are now 17 sessions /
125 tabs: **pairwise P 77.6% · R 46.4% · F1 58.1%; BCubed
F1 84.7%; clicks-to-organized 47 vs 91**.
