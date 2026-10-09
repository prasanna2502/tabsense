# TabSense

Automatic semantic tab groups for Chrome: duplicate tabs are prevented at open time
(silently — focus switches to the tab you already have), and open tabs are grouped by
meaning with on-device AI, presented as one-click suggestions you can accept, reassign,
or turn into a new group.

- Privacy: [PRIVACY.md](PRIVACY.md)
- Permission justifications: [docs/permission-justifications.md](docs/permission-justifications.md)

Status: **M0 — walking skeleton.** The extension loads, lists your open tabs in a side
panel, and counts exact-URL duplicates live. A Rust core compiled to WebAssembly is
wired into the service worker (URL normalization today; the canonicalizer lands in M1).
No duplicate prevention, grouping, or AI yet.

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
