# TabSense

**Fifty tabs open, and the one you need is never the one you can find.**

TabSense is a free, open-source Chrome extension that keeps a crowded tab strip under control. It stops duplicate tabs before they pile up, and it suggests named groups for the tabs you already have, all computed on your device and applied only when you approve them.

See TabSense turn a 55-tab mess into named groups:





https://github.com/user-attachments/assets/1727e6df-adf2-4e4e-8b38-5013a6745f87



## What it does

### Duplicates never pile up

Open a page you already have open and TabSense takes you straight to the existing tab and closes the copy. No prompt, no interruption, no decision to make in the middle of something else.

It recognizes the same document hiding behind different links: tracking parameters, share links, a Google Doc opened from Drive and again from an email. It knows the document IDs used by Google Workspace, Drive, Notion, GitHub, Figma, and YouTube, so the copies it catches are real copies. On a 95-case test corpus built for exactly this, its exact-duplicate detection is at 100% precision. It would rather miss a duplicate than close the wrong tab.

Every tab it closes is written to an activity log, and one click on Reopen brings it back.

Already have a mess? The toolbar badge counts the extra copies, and the side panel opens with a plain-language card ("N duplicate tabs can be closed") and a single button that closes them all.

One careful distinction: the same document open in two different views, like a spreadsheet on two different sheet tabs, is never closed automatically. Those are listed as similar documents, and you pick which view to keep.

### Groups, suggested, not imposed

When the tab strip gets crowded, TabSense works out which tabs belong together and puts its suggestions in the side panel inbox. A rules engine in the extension's core does the first pass, grouping by topic across titles, sites, and document identity. Where Chrome's built-in on-device AI (Gemini Nano) is available, it double-checks each suggestion and proposes the group name. If the AI is unavailable or slow, the rules engine carries on by itself, and dedupe never depends on AI at all.

You review each suggestion. Include or exclude individual tabs, file it into a different group, rename it, then accept or dismiss. Accepting creates a real Chrome tab group, and an undo button appears in case you change your mind. Dismissing is remembered, so the same suggestion does not keep coming back.

## How it works

1. Browse as usual. Duplicates are handled the moment they open.
2. When the strip gets crowded, open the side panel. Suggested groups are waiting in the inbox.
3. Review, adjust, accept, or dismiss. Nothing is applied before this step.
4. Accepted suggestions become real Chrome tab groups you can collapse, expand, and rename like any group you made yourself.

## Why TabSense is different

- **On-device by default.** Grouping runs on a bundled rules engine and, where available, Chrome's built-in AI model. Your tabs are never sent to a cloud service to be organized.
- **No account, no server, no telemetry.** There is nothing to sign up for and nothing phoning home.
- **You stay in charge.** TabSense never groups, moves, or renames a tab on its own. Groups you created yourself are never touched, and pinned tabs are left alone.
- **Sensitive sites are off-limits.** Banks, payment services, health portals, and password-manager vaults are on a blocklist by default and are never suggested or grouped. You can edit the list in Settings.
- **Built to stay out of the way.** The heavy work happens off the tab-open path, and the project keeps a written performance budget in the repo (`perf-budgets.json`). Opening a tab should never feel slower because TabSense is installed.
- **Works in managed browsers.** IT can set TabSense policy for managed Chrome, and managed settings override local ones.
- **Open source, MIT.** Every line is here to read, question, and build yourself.

## Honest numbers

TabSense ships with a small public benchmark (in [`benchmarks/`](benchmarks/)) that runs the production grouping pipeline over 12 scripted browsing sessions, 85 tabs in all, and compares it with organizing the same sessions by hand.

- Getting organized took **37 clicks with TabSense vs 64 by hand, 42% fewer**.
- Grouping quality at the current baseline: BCubed F1 80.0%, pairwise F1 48.7%. The misses are published too. The engine is deliberately cautious (a wrong suggestion costs more trust than a missed one), and it struggles where a topic is spread across sites that share few words.

These numbers are the floor. They were measured on the rules engine alone, because the AI judge does not run in CI. The full record is in `benchmarks/results.json`.

## Privacy

Short version: in its default mode, TabSense collects nothing. No account, no server, no analytics, no telemetry. Your tab titles and URLs are processed on your device and are never sent anywhere.

TabSense asks for exactly four permissions (`tabs`, `sidePanel`, `storage`, and `tabGroups`), and each one is justified in writing:

- Full policy: [PRIVACY.md](PRIVACY.md)
- Permission justifications: [docs/permission-justifications.md](docs/permission-justifications.md)

## Try it

TabSense is in active development. Grouping suggests; you always decide. It is not on the Chrome Web Store yet, so for now you build it from source. It takes a couple of minutes, and the compiled Wasm core is committed, so Node is all you need unless you want to rebuild the Rust core.

Prerequisites: Node 20+.

```bash
npm install
npm run build                # production build → .output/chrome-mv3
npm test                     # TypeScript unit tests
(cd core && cargo test)      # Rust unit + golden-corpus tests
```

Load it in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `.output/chrome-mv3` folder
4. Click the TabSense toolbar icon to open the side panel

To rebuild the Rust core (only needed after changing `core/`) you also need:

- Rust via [rustup](https://rustup.rs) with the `wasm32-unknown-unknown` target
  (Homebrew's `rust` formula can't add targets — use `rustup`):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --target wasm32-unknown-unknown
  source "$HOME/.cargo/env"
  ```
- `npm run build:wasm` to rebuild (via `scripts/`)
- `wasm-opt` from [binaryen](https://github.com/WebAssembly/binaryen/releases) on your
  `PATH` (e.g. `brew install binaryen`). Optional, but without it the Wasm ships
  unoptimized (~40% larger) — don't commit a build made without it.

## Layout

- `entrypoints/` — MV3 entry points: background service worker, side panel
- `src/config/branding.ts` — the one place the product name lives
- `src/lib/` — pure TypeScript logic (duplicates, grouping, suggestions, settings)
- `src/wasm/` — loader + generated glue for the Rust core
- `core/` — the Rust crate compiled to WebAssembly
- `benchmarks/` — the public benchmark corpus, runner, and published results
- `perf-budgets.json` — the extension's performance budgets, as code

## License

MIT — see [LICENSE](LICENSE).
