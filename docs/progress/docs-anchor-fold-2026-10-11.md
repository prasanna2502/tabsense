# Dogfood fix: Docs/Slides anchors fold + descriptors name the difference — 2026-10-11

Branch: `fix/docs-anchor-fold`

Dogfooding round two: the side panel listed three different Google
Docs under "Similar documents", each shown as "2 views". The sets
were keyed correctly — one document per card, opened twice — but
the second tab of each pair differed only by its heading anchor
(a `#heading=…` deep link), and nothing on the card said so. Two
fixes.

## Fix 1 — anchors are not views

A Docs heading anchor or a Slides slide anchor is a pure scroll
anchor, like a generic page fragment (which the canonicalizer has
always folded). It no longer distinguishes the exact key:

- Same-document tabs that differ only by anchor now share an exact
  key, so an anchored re-open takes the normal exact-duplicate
  path instead of forming a "similar documents" set.
- Sheets is unchanged on purpose: `#gid=` stays in the exact key —
  different sheet tabs are genuinely different views and still
  form fuzzy sets.
- Rust core and TypeScript mirror in bit-for-bit parity; the
  golden corpus now expects the anchor pairs to be exact, with new
  precision cases proving anchors never merge two different
  documents and the fold never merges view modes (`/edit` vs
  `/view` stays fuzzy).

**Deep-link courtesy.** Auto-closing an anchored duplicate would
lose the section jump the user asked for, so the swap now hands
the fragment to the kept tab first: if the closed duplicate's URL
carries a fragment the kept tab lacks, the kept tab is navigated
to it (fragment-only navigation, no reload) before the close.
Best-effort — a failed transfer never blocks the swap.

## Fix 2 — member rows name what differs

The M1.2 descriptor principle ("show what differs, never repeat
titles") is generalized for generic fuzzy sets. A member row now
names the component that actually distinguishes it:

- the differing query parameter, by name only, never its value
  ("Varies by sort") — values are user data;
- the AMP variant, whether marked by query parameter or by the
  `/amp` path suffix ("AMP version");
- the differing trailing path segment, truncated ("Page: intro");
- the strict-prefix base member reads "Another view", not a
  "different" one.

Existing site patterns are untouched (Sheets "Sheet tab {gid}",
YouTube start times, GitHub line links); Slides gains its missing
"Present view" mode label.

## Validation

vitest 336/336, cargo 25 unit tests + golden corpus, tsc clean.
CI outcome: appended when the run of record lands.
