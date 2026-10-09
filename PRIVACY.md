# Privacy — TabSense

*Draft for the Chrome Web Store listing and the GitHub Pages privacy page.
Last updated: M0 (walking skeleton).*

## The short version

**In its default mode, TabSense collects nothing.** There is no account,
no server, no analytics, and no telemetry. Nothing about your browsing
leaves your device.

## What TabSense does on your device

To organize your tabs, TabSense needs to see the titles and URLs of the
tabs you have open — the same information already visible in Chrome's own
tab strip. That information is processed **locally, in your browser**,
by the extension's bundled code (including its on-device AI and rules
engines in later versions).

TabSense stores its working state — for example your tab-group memory
and settings — in Chrome's local extension storage on your device
(`chrome.storage.local`). It is not transmitted anywhere, and removing
the extension removes it.

## What TabSense never does

- It does not send your tab titles, URLs, or page content to any server.
- It does not sell, rent, or share data with anyone. There is no data to sell.
- It does not use analytics, advertising, or tracking SDKs.
- It does not read your browsing history (`history` permission is not requested).

## Optional features that change this picture

None of these exist yet, and none will ever be enabled silently; if and
when they ship, this page will describe them before they do:

- **Bring-your-own-key AI (future, opt-in):** if you configure your own
  cloud AI provider, tab titles/URLs are sent to *that provider, chosen
  by you*, for inference only.
- **TabSense Companion (future, opt-in, paid):** if you subscribe and
  sign in, a compact profile of how you like tabs organized can sync
  across your machines, end-to-end encrypted. Your browsing history
  itself is not synced.
- **Managed/enterprise deployments (future):** an organization that
  installs TabSense on a managed browser can configure its own AI
  endpoint; your organization controls where that endpoint sends data.

## Contact

Questions: open an issue on the project's GitHub repository.
