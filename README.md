# TabSense

Automatic semantic tab groups for Chrome: duplicate tabs are prevented at open time
(silently — focus switches to the tab you already have), and open tabs are grouped by
meaning with on-device AI, presented as one-click suggestions you can accept, reassign,
or turn into a new group.

See TabSense turn a 35-tab mess into named groups:





https://github.com/user-attachments/assets/e993927a-e41e-492d-af03-75e1cabf777a




- Privacy: [PRIVACY.md](PRIVACY.md)
- Permission justifications: [docs/permission-justifications.md](docs/permission-justifications.md)

Status: **M2 — semantic grouping as suggestions (Suggest mode).** Everything from
M1.2 (below the fold of this status), plus: open tabs are clustered by a heuristic
router in the Rust core — title tokens, host, path segments, and the canonical
document keys — and, when Chrome's built-in on-device model (Gemini Nano) is
available, an AI judge confirms or rejects each candidate and names the group.
Suggestions land in the side panel's Suggested groups inbox: create a new named
group or file tabs into an existing one, with per-tab toggles, retargeting,
dismiss, and undo; accepting applies real Chrome tab groups. Tabs in groups you
created yourself are never touched, pinned tabs are excluded, sensitive sites are
blocklisted by default, and a circuit breaker degrades Nano → heuristics →
domain-only → paused without ever affecting dedupe. Grouping settings (pause,
provider, blocklist) support chrome.storage.managed overrides labeled "Managed
by your organization". Benchmark-Lite (in `benchmarks/`) records the first
honest grouping baseline: pairwise F1 48.7% on the heuristics rung, with
clicks-to-organized 42% below the manual baseline. The dedupe foundation is
unchanged: every tab's URL is canonicalized into an *exact* key (same document,
same view/state) and a *fuzzy* key (same document, different view/state); exact
duplicates are silently focus-swapped and closed with a recoverable activity-log
entry, fuzzy matches are never auto-closed but offer a manual keep-one cleanup,
and pre-existing duplicates surface as a toolbar badge plus a "Needs attention"
card. A 95-case golden corpus holds exact-tier precision at 100%.

## Build & try it

Prerequisites: Node 20+. That alone is enough to build and test the extension — the
compiled Wasm core is committed under `src/wasm/`.

To rebuild the Rust core (only needed after changing `core/`) you also need:

- Rust via [rustup](https://rustup.rs) with the `wasm32-unknown-unknown` target
  (Homebrew's `rust` formula can't add targets — use `rustup`):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --target wasm32-unknown-unknown
  source "$HOME/.cargo/env"
  ```
- `wasm-pack`: `cargo install wasm-pack --locked`
- `wasm-opt` from [binaryen](https://github.com/WebAssembly/binaryen/releases) on your
  `PATH` (e.g. `brew install binaryen`). Optional, but without it the Wasm ships
  unoptimized (~40% larger) — don't commit a build made without it.

```bash
npm install
npm run build:wasm           # rebuild the Rust core (only needed after changing core/)
npm run build                # production build → .output/chrome-mv3
npm test                     # TypeScript unit tests
(cd core && cargo test)      # Rust unit + golden-corpus tests
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
