# M0 Report — Walking skeleton & rails

Date: 2026-10-08 · Milestone: M0 · Status: complete except the in-Chrome load check (manual, pending)

## 1. Shipped
- WXT 0.20 + TypeScript MV3 extension at repo root. Permissions exactly `tabs`, `sidePanel`,
  `storage`. Product name lives in exactly one code location (`src/config/branding.ts`); the
  manifest name and panel UI both read from it.
- Background service worker tracks tabs event-driven (no polling), keeps a live snapshot in
  `chrome.storage.local`; the side panel lists open tabs (title + URL, click to activate),
  shows the exact-URL duplicate count and duplicate groups, and which normalization engine
  answered, updating live via `storage.onChanged`. The toolbar action opens the panel.
- Rust core compiled to WebAssembly (`core/`, cargo/rustc 1.99.0 + `wasm32-unknown-unknown`,
  wasm-pack 0.13.1): a real `normalize_url` invoked from the service worker at warm-up, with a
  bit-for-bit TypeScript fallback answering until the Wasm is ready or if it fails.
- CI (`.github/workflows/ci.yml`): extension job (install, typecheck, unit tests, perf stub,
  production build) + Rust-core job (cargo test + wasm rebuild). `perf-budgets.json` carries
  all 10 §10.2 budgets; `scripts/perf-harness.mjs` is the stub that loads and prints them.
- Draft docs: `PRIVACY.md`, `docs/permission-justifications.md`, MIT `LICENSE`, README with
  build steps and load-unpacked instructions.
- GitHub: public repo `github.com/prasanna2502/tabsense`; all commits pushed; `main` protected
  with both CI jobs as required status checks, force pushes and branch deletion disallowed.

## 2. Verified
- Local: production build succeeds (`.output/chrome-mv3/`, valid MV3 manifest incl. the
  `wasm-unsafe-eval` CSP); `tsc` clean; vitest 11/11; `cargo test` 6/6 on the same
  normalization cases (Rust/TS parity); the built Wasm instantiated in Node and normalized
  `HTTPS://Docs.Example.COM:443/Some/Path` → `https://docs.example.com/Some/Path`.
- GitHub Actions run 37868779075 (first push): **success** — both jobs green, including unit
  tests, the perf-budget stub, and the production build from a fresh checkout.

## 3. Decisions
All four user decisions settled on 2026-10-08: (1) execution plan approved, M0 started;
(2) repository public from day one; (3) no dedupe-only v0.1 — first public release waits until
semantic grouping is ready (after M2); (4) Suggest is the default mode, with a one-click offer
to graduate to Auto once a user's accept rate has earned it (trust on-ramp).

## 4. Blockers & escalations
- Resolved during M0: the first push was rejected because the gh OAuth token lacked the
  `workflow` scope required to push `.github/workflows/`; the user approved a scope refresh
  (device flow) and the push then succeeded.
- Environment note: wasm-pack's built-in wasm-opt step fails in Dobby's environment (its
  binaryen download errors); workaround in place — wasm-opt disabled in `core/Cargo.toml`,
  wasm-opt 117 installed locally, `scripts/build-wasm.mjs` uses it when present.

## 5. Remaining
- **In-Chrome load check (user, ~2 min):** the "loads with zero console errors" half of the M0
  exit criteria needs a human at a real Chrome — load `.output/chrome-mv3` via
  `chrome://extensions` → Developer mode → Load unpacked, open the panel, confirm the tab list
  and duplicate count render and the footer shows the wasm engine. Everything else in the exit
  criteria is verified (including the fresh-clone CI build).
- The Wasm bundle is 201 KB (mostly the `url` crate's IDNA tables) — acceptable for M0; the
  lever, if §10 budgets bite later, is a hand-rolled parser.
- M0 checklist: 5/5 work items done; 1 verification item (load check) outstanding.

## 6. Next
M1 — dedupe that can be trusted: canonicalizer v1 (tracking-param strip, anchor normalization,
doc-ID rules for Google Workspace / Notion / GitHub / Figma), two-tier keys (exact → silent
auto-focus + close; fuzzy → suggestion only), duplicates view + activity log with one-click
reopen, golden-corpus parity tests, cold/warm swap-latency measurement, and a dogfood week.
