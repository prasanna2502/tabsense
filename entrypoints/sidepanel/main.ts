import { BRANDING } from '../../src/config/branding';
import {
  GET_SNAPSHOT_MESSAGE,
  SNAPSHOT_KEY,
  type TabSnapshot,
} from '../../src/lib/snapshot';

/**
 * Side panel (M0): renders the snapshot the background worker maintains —
 * the live tab list (title + URL) and the exact-URL duplicate count.
 * Updates arrive via chrome.storage.onChanged; clicking a tab activates it.
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
const dupSectionEl = document.getElementById('dup-groups');
const dupListEl = document.getElementById('dup-list');
const statusEl = document.getElementById('status');

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

  if (dupSectionEl && dupListEl) {
    dupSectionEl.hidden = snapshot.duplicates.groups.length === 0;
    dupListEl.replaceChildren(
      ...snapshot.duplicates.groups.map((group) => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `${group.count}× `;
        const url = document.createElement('span');
        url.className = 'dup-url';
        url.textContent = group.url;
        li.append(label, url);
        return li;
      }),
    );
  }

  if (tabListEl) {
    const dupUrls = new Set(snapshot.duplicates.groups.map((g) => g.url));
    tabListEl.replaceChildren(
      ...snapshot.tabs.map((tab) => {
        const li = document.createElement('li');
        if (tab.active) li.className = 'active';
        const title = document.createElement('span');
        title.className = 'tab-title';
        title.textContent = tab.title || '(untitled)';
        if (dupUrls.has(tab.url)) {
          const badge = document.createElement('span');
          badge.className = 'dup-badge';
          badge.textContent = ' duplicate';
          title.append(badge);
        }
        const url = document.createElement('span');
        url.className = 'tab-url';
        url.textContent = tab.url;
        li.append(title, url);
        li.addEventListener('click', () => {
          void chrome.tabs.update(tab.id, { active: true });
          void chrome.windows.update(tab.windowId, { focused: true });
        });
        return li;
      }),
    );
  }

  if (statusEl) {
    statusEl.textContent = snapshot.normalizedSample
      ? `Core sample (${snapshot.normalizedSample.engine}): ${snapshot.normalizedSample.normalized}`
      : 'Waiting for tab data…';
  }
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
