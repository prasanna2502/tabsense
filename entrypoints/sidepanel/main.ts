import { BRANDING } from '../../src/config/branding';
import {
  findExactDuplicateSets,
  findFuzzySets,
} from '../../src/lib/duplicates';
import {
  CLOSE_DUPLICATE_SET_MESSAGE,
  GET_SNAPSHOT_MESSAGE,
  SET_AUTO_CLOSE_MESSAGE,
  SNAPSHOT_KEY,
  type TabInfo,
  type TabSnapshot,
} from '../../src/lib/snapshot';

/**
 * Side panel: renders the snapshot the background worker maintains.
 * Updates arrive via chrome.storage.onChanged; clicking a tab
 * activates it.
 *
 * M1 additions: canonical duplicate sets with a bulk "keep newest,
 * close the rest" action (worker re-validates), fuzzy sets ("same
 * document, different view" — display only, no bulk close), the
 * activity log of closed duplicates with one-click Reopen, the
 * auto-close settings toggle, and a stats footer (swap timings,
 * engine, core state).
 */

document.title = BRANDING.productName;
const productNameEl = document.getElementById('product-name');
if (productNameEl) productNameEl.textContent = BRANDING.productName;
const taglineEl = document.getElementById('tagline');
if (taglineEl) taglineEl.textContent = BRANDING.tagline;

const totalEl = document.getElementById('stat-total');
const dupEl = document.getElementById('stat-duplicates');
const engineEl = document.getElementById('stat-engine');
const tabListEl = document.getElementById('tab-list');
const statusEl = document.getElementById('status');
const swapStatsEl = document.getElementById('swap-stats');
const autoCloseEl = document.getElementById(
  'opt-autoclose',
) as HTMLInputElement | null;
const autoCloseNoteEl = document.getElementById('autoclose-note');
const dupSetsSectionEl = document.getElementById('dup-sets');
const setListEl = document.getElementById('set-list');
const fuzzySectionEl = document.getElementById('fuzzy-sets');
const fuzzyListEl = document.getElementById('fuzzy-list');
const activitySectionEl = document.getElementById('activity-section');
const activityListEl = document.getElementById('activity-list');

function fmtMs(ms: number | null): string {
  return ms === null ? '–' : `${Math.round(ms)} ms`;
}

function tabLine(tab: TabInfo): HTMLLIElement {
  const li = document.createElement('li');
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = tab.title || '(untitled)';
  const url = document.createElement('span');
  url.className = 'tab-url';
  url.textContent = tab.url;
  li.append(title, url);
  return li;
}

function render(snapshot: TabSnapshot): void {
  if (totalEl) totalEl.textContent = String(snapshot.duplicates.totalTabs);
  if (dupEl) dupEl.textContent = String(snapshot.duplicates.duplicateTabs);
  if (engineEl) {
    engineEl.textContent = snapshot.normalizedSample
      ? snapshot.normalizedSample.engine
      : snapshot.wasmReady
        ? 'wasm'
        : 'fallback';
  }

  const byId = new Map(snapshot.tabs.map((t) => [t.id, t]));

  // Auto-close toggle + core-state note.
  if (autoCloseEl) {
    autoCloseEl.checked = snapshot.autoCloseEnabled;
    autoCloseEl.disabled = snapshot.coreState === 'failed';
  }
  if (autoCloseNoteEl) {
    if (snapshot.coreState === 'failed') {
      autoCloseNoteEl.hidden = false;
      autoCloseNoteEl.textContent =
        'The on-device core failed to load, so auto-close is off. Duplicates are still listed below.';
    } else if (snapshot.coreState === 'pending') {
      autoCloseNoteEl.hidden = false;
      autoCloseNoteEl.textContent =
        'Core is still loading — duplicates opened now are checked once it is ready.';
    } else {
      autoCloseNoteEl.hidden = true;
    }
  }

  // Exact duplicate sets with bulk close.
  const exactSets = findExactDuplicateSets(snapshot.tabs);
  if (dupSetsSectionEl && setListEl) {
    dupSetsSectionEl.hidden = exactSets.length === 0;
    setListEl.replaceChildren(
      ...exactSets.map((set) => {
        const li = document.createElement('li');
        li.className = 'set';
        const members = set.tabIds
          .map((id) => byId.get(id))
          .filter((t): t is TabInfo => t !== undefined);
        const head = document.createElement('div');
        head.className = 'set-head';
        const label = document.createElement('span');
        label.textContent = `${set.tabIds.length}× ${members[0]?.title || '(untitled)'}`;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `Keep newest, close ${set.tabIds.length - 1}`;
        button.addEventListener('click', () => {
          button.disabled = true;
          void chrome.runtime.sendMessage({
            type: CLOSE_DUPLICATE_SET_MESSAGE,
            exactKey: set.exactKey,
            keepTabId: set.newestTabId,
          });
        });
        head.append(label, button);
        const memberList = document.createElement('ul');
        memberList.className = 'set-members';
        memberList.replaceChildren(...members.map(tabLine));
        li.append(head, memberList);
        return li;
      }),
    );
  }

  // Fuzzy sets: same document, different view — display only.
  const fuzzySets = findFuzzySets(snapshot.tabs);
  if (fuzzySectionEl && fuzzyListEl) {
    fuzzySectionEl.hidden = fuzzySets.length === 0;
    fuzzyListEl.replaceChildren(
      ...fuzzySets.map((set) => {
        const li = document.createElement('li');
        li.className = 'set';
        const members = set.tabIds
          .map((id) => byId.get(id))
          .filter((t): t is TabInfo => t !== undefined);
        const head = document.createElement('div');
        head.className = 'set-head';
        const label = document.createElement('span');
        label.textContent = `${set.tabIds.length} views — ${members[0]?.title || '(untitled)'}`;
        head.append(label);
        const memberList = document.createElement('ul');
        memberList.className = 'set-members';
        memberList.replaceChildren(...members.map(tabLine));
        li.append(head, memberList);
        return li;
      }),
    );
  }

  // Activity log with Reopen.
  if (activitySectionEl && activityListEl) {
    activitySectionEl.hidden = snapshot.activity.length === 0;
    activityListEl.replaceChildren(
      ...snapshot.activity.map((entry) => {
        const li = document.createElement('li');
        li.className = 'activity-entry';
        const text = document.createElement('span');
        const when = new Date(entry.closedAt).toLocaleTimeString();
        text.textContent = `${when} — ${entry.title || entry.url}`;
        text.title = entry.url;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Reopen';
        button.addEventListener('click', () => {
          void chrome.tabs.create({ url: entry.url });
        });
        li.append(text, button);
        return li;
      }),
    );
  }

  // All tabs (M0 behavior, with the canonical duplicate badge).
  if (tabListEl) {
    const dupUrls = new Set(snapshot.duplicates.groups.map((g) => g.url));
    tabListEl.replaceChildren(
      ...snapshot.tabs.map((tab) => {
        const li = tabLine(tab);
        if (tab.active) li.className = 'active';
        if (dupUrls.has(tab.url)) {
          const badge = document.createElement('span');
          badge.className = 'dup-badge';
          badge.textContent = ' duplicate';
          li.querySelector('.tab-title')?.append(badge);
        }
        li.addEventListener('click', () => {
          void chrome.tabs.update(tab.id, { active: true });
          void chrome.windows.update(tab.windowId, { focused: true });
        });
        return li;
      }),
    );
  }

  if (swapStatsEl) {
    const s = snapshot.swaps;
    swapStatsEl.textContent =
      `Focus swaps: ${s.count} (cold ${s.coldCount} · warm ${s.warmCount})` +
      ` · median ${fmtMs(s.medianMs)} · p95 ${fmtMs(s.p95Ms)}` +
      ` · core: ${snapshot.coreState} · auto-close: ${snapshot.autoCloseEnabled ? 'on' : 'off'}`;
  }

  if (statusEl) {
    statusEl.textContent = snapshot.normalizedSample
      ? `Core sample (${snapshot.normalizedSample.engine}): ${snapshot.normalizedSample.normalized}`
      : 'Waiting for tab data…';
  }
}

if (autoCloseEl) {
  autoCloseEl.addEventListener('change', () => {
    void chrome.runtime.sendMessage({
      type: SET_AUTO_CLOSE_MESSAGE,
      enabled: autoCloseEl.checked,
    });
  });
}

async function loadInitial(): Promise<void> {
  // Ask the worker for a fresh snapshot; fall back to the stored one
  // (or an empty render) if the worker cannot answer.
  try {
    const snapshot = (await chrome.runtime.sendMessage({
      type: GET_SNAPSHOT_MESSAGE,
    })) as TabSnapshot | undefined;
    if (snapshot) {
      render(snapshot);
      return;
    }
  } catch {
    // fall through to storage
  }
  const stored = await chrome.storage.local.get(SNAPSHOT_KEY);
  const snapshot = stored[SNAPSHOT_KEY] as TabSnapshot | undefined;
  if (snapshot) render(snapshot);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SNAPSHOT_KEY]?.newValue) {
    render(changes[SNAPSHOT_KEY].newValue as TabSnapshot);
  }
});

void loadInitial();
