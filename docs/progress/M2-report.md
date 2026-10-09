# M2 — Suggest-mode semantic grouping

**Status: shipped.** TabSense now suggests tab groups in the side
panel. Nothing is ever applied automatically: every suggestion is
reviewed, edited, accepted, or dismissed by the user.

## What shipped

- **Heuristic router (Rust core, compiled to Wasm)** — scores tabs
  against existing groups (top-K ≤ 5 candidates) and clusters
  ungrouped tabs using title tokens, host, path segments, and the
  canonical/fuzzy document keys from M1. A TypeScript mirror with
  shared fixtures keeps behavior identical when Wasm is warming up.
- **Gemini Nano judge** — when Chrome's built-in on-device model is
  available, it confirms/rejects each candidate or declares a new
  topic, and proposes group names. Every AI output passes strict
  schema validation; a malformed answer gets one retry with a
  simpler prompt, then the suggestion falls back to heuristics at
  reduced confidence. Unvalidated output is never applied.
- **Suggestion inbox** in the side panel's Suggested groups slot:
  create a new named group or add tabs to an existing TabSense
  group, with per-tab include/exclude toggles, a "File into"
  retarget option, accept / dismiss, and undo. Accepting applies
  real Chrome tab groups. Every accept and dismiss is recorded in
  the activity log.
- **Hands-off rules** — tabs in groups you created yourself are
  never suggested, moved, or renamed; pinned tabs are excluded;
  grouping is per-window; group identity is name + exemplar
  signature, never the session-scoped Chrome group ID.
- **Blocklist** — a small default list of sensitive sites (banks,
  payment services, health portals, password managers) is never
  suggested or grouped; the list is editable in Settings.
- **Resilience ladder** — Nano → heuristics → domain-only →
  grouping paused, with a circuit breaker, a hard 10-second
  per-call timeout, and per-suggestion isolation. A passive status
  line in the panel ("Grouping: on-device AI / heuristics /
  paused") is the only surface. Dedupe never touches AI and is
  unchanged.
- **Settings for grouping** — pause toggle, provider choice, AI
  status, blocklist editor. The settings model supports
  `chrome.storage.managed` precedence from day one: a managed value
  overrides the local one per field, locks its control, and is
  labeled "Managed by your organization". (Full enterprise policy
  arrives in M6.)
- Grouping runs debounced (~1.5 s) and off the tab-open path;
  M2 adds nothing to what M1 already does when a tab opens.

## Permissions

The manifest now requests `tabs`, `sidePanel`, `storage`, and
**`tabGroups`** (new in M2 — required to create and name real
Chrome tab groups when you accept a suggestion). Nothing else was
added. See `docs/permission-justifications.md` and `PRIVACY.md`.

## Benchmark-Lite — first baseline

`benchmarks/` contains 12 scripted sessions (85 tabs) with
human-labeled expected groups and a runner (`npm run bench`) that
executes the production grouping pipeline end-to-end.

Heuristics rung only — Gemini Nano is not available in CI, so
these numbers are the floor the AI judge is expected to raise:

| Metric | Result |
| --- | --- |
| Pairwise precision | 73.7% |
| Pairwise recall | 36.4% |
| Pairwise F1 | 48.7% |
| BCubed F1 | 80.0% |
| Clicks-to-organized | 37 vs 64 manual (−42%) |

The router is deliberately precision-leaning: a wrong suggestion
costs more trust than a missed one. Misses concentrate where a
lexical engine should miss — cross-site groups whose titles share
a single topic word, and semantic equivalence with no shared
tokens (a desk sold as "UPLIFT V2" vs "Jarvis"). Targets are set
from this baseline and gated from M3 onward. Full record:
`benchmarks/results.json`.

## Verification

- 218 unit tests passing (157 pre-existing + 61 new: suggestion
  engine incl. the hands-off rules, settings precedence incl.
  managed override, circuit breaker, Nano validation/retry with a
  mocked model, blocklist, group identity), plus 19 Rust tests.
- Golden-corpus dedupe metrics unchanged (exact-tier precision
  and recall 100%).
- TypeScript clean; production build succeeds; built manifest
  permissions verified to be exactly the four listed above.
- CI green on both jobs (extension + Rust core).

## Notes

- The on-device model is not available in the sandbox or CI, so
  the Nano path is covered by mocked-model unit tests here; live
  verification happens during dogfooding on a Chrome that has it.
- The Nano bridge ships as a context-agnostic module hosted by
  the service worker. The original plan placed it in an offscreen
  document, but that requires an additional manifest permission
  that M2 deliberately does not take; the module can move without
  changes if that ever changes.
