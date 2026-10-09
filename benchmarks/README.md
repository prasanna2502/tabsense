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
