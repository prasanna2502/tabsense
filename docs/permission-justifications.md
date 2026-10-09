# Permission justifications (for Chrome Web Store review)

TabSense requests exactly four permissions. Each one maps directly to
the extension's single purpose — automatic tab organization — as required
by the Web Store's single-purpose policy. This document is the source
for the per-permission justification text entered in the Developer
Dashboard at submission time (M5); keep it in sync with `wxt.config.ts`.

## `tabs`

**Why:** Tab organization is impossible without knowing what tabs exist.
The extension reads each open tab's title and URL to (a) detect when a
newly opened tab duplicates one that is already open, and (b) decide
which group a tab belongs to. It also activates (focuses) an existing
tab when a duplicate is opened, and the side panel activates a tab when
the user clicks it.

**Scope notes:** The extension does not request `history`, does not
read page content, and does not monitor navigation for any purpose
other than organizing the currently open tabs. All processing happens
locally; tab titles/URLs are never transmitted off the device in the
default configuration.

## `sidePanel`

**Why:** The extension's entire user interface — grouping suggestions,
the duplicates view, and settings — lives in Chrome's side panel. The
permission is required to declare the panel and to open it when the
user clicks the toolbar action.

**Scope notes:** The panel displays only information the extension
already has from the `tabs` permission (open tab titles/URLs and
duplicate counts). It loads no remote content.

## `storage`

**Why:** The extension persists its own working state on the device:
the current tab snapshot used by the side panel, user settings (such as
mode and blocked domains), and — in later versions — local group memory
and an activity log so automatic actions can be undone.

**Scope notes:** Only `chrome.storage.local` is used. Nothing is synced
off the device by this permission; the extension has no server and no
accounts. State is removed when the extension is uninstalled.

## `tabGroups`

**Why:** Since M2, TabSense files tabs into named Chrome tab groups —
but only when the user explicitly accepts a grouping suggestion in
the side panel. Creating a group with a name requires updating the
group's title, which is what this permission grants. (Reading which
group a tab belongs to comes from the `tabs` permission.)

**Scope notes:** The permission is used to create and name groups on
user-confirmed actions, and to ungroup tabs when the user undoes one.
TabSense never moves, renames, or dissolves groups the user created
themselves.

## Explicitly NOT requested

- `history` — organization works from currently open tabs only.
- Host permissions / `scripting` — page content is not read. Rich page
  signals are a future opt-in and will request access at runtime only
  if the user enables them.
- `webRequest`, `cookies`, `downloads`, etc. — unrelated to the purpose.

## Content Security Policy note

The manifest declares `'wasm-unsafe-eval'` in the `extension_pages`
CSP. This is required to instantiate the extension's own bundled
WebAssembly module (a Rust core that performs URL normalization and,
later, scoring). It applies only to code packaged in the extension;
no remote code is fetched or executed, and no `eval()` of strings is
used anywhere.
