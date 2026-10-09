# TabSense

Automatic semantic tab groups for Chrome: duplicate tabs are prevented at open time
(silently — focus switches to the tab you already have), and open tabs are grouped by
meaning with on-device AI, presented as one-click suggestions you can accept, reassign,
or turn into a new group.

- Privacy: [PRIVACY.md](PRIVACY.md)
- Permission justifications: [docs/permission-justifications.md](docs/permission-justifications.md)

Status: **M1 — dedupe that can be trusted.** The extension canonicalizes every tab's
URL in the Rust/Wasm core (with a bit-for-bit TypeScript fallback) into two keys:
an *exact* key (same document, same view/state) and a *fuzzy* key (same document,
different view/state). Opening a tab whose exact key is already open silently focuses
the existing tab and closes the duplicate, with a recoverable entry in the panel's
activity log; fuzzy matches are shown in the panel as "same document, different
view" and are never auto-closed. A 95-case golden corpus, consumed by both the Rust
and TypeScript test suites, holds exact-tier precision at 100%. Grouping and AI land
in M2.

## Build & try it

Prerequisites: Node 20+, and (for the Wasm core) Rust with the
`wasm32-unknown-unknown` target plus `wasm-pack`.

```bash
npm install
npm run build:wasm   # rebuild the Rust core (only needed after changing core/)
npm run build        # production build → .output/chrome-mv3
npm test             # TypeScript unit tests (cargo test covers the Rust core)
```

Load it in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `.output/chrome-mv3` folder
4. Click the TabSense toolbar icon to open the side panel

## Layout

- `entrypoints/` — MV3 entry points: background service worker, side panel
- `src/config/branding.ts` — the one place the product name lives
- `src/lib/` — pure TypeScript logic (duplicate counting, URL fallback, snapshot types)
- `src/wasm/` — loader + generated glue for the Rust core
- `core/` — the Rust crate compiled to WebAssembly
- `scripts/` — Wasm build script, perf-harness (stub at M0)
- `perf-budgets.json` — the extension's performance budgets, as code

License: MIT — see [LICENSE](LICENSE).
