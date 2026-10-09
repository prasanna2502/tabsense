import { BRANDING } from '../../src/config/branding';
import {
  countExtraCopies,
  findExactDuplicateSets,
  findFuzzySets,
  type ExactDuplicateSet,
} from '../../src/lib/duplicates';
import {
  faviconFallbackLetter,
  hostLabel,
  hostPathLabel,
  pluralize,
} from '../../src/lib/panel-model';
import {
  CLOSE_ALL_DUPLICATES_MESSAGE,
  CLOSE_DUPLICATE_SET_MESSAGE,
  GET_SNAPSHOT_MESSAGE,
  SET_AUTO_CLOSE_MESSAGE,
  SNAPSHOT_KEY,
  type TabInfo,
  type TabSnapshot,
} from '../../src/lib/snapshot';

/**
 * Side panel (M1.1 UX reset): action-first.
 *
 * Layout, top to bottom: a "Needs attention" card with the one
 * obvious cleanup action, the duplicate cards it refers to
 * (collapsed until expanded), a reserved Suggested groups slot
 * (M2, hidden while empty), then collapsed secondary sections —
 * Similar documents, Recently closed, All tabs, Settings & details.
 * Diagnostics live in Settings & details, never in the default view.
 *
 * Rendering is snapshot-driven (the worker owns tab state and
 * pushes via chrome.storage). Small pieces of UI state that must
 * survive a re-render — which sections/cards are open, the search
 * query, a close in flight — are kept here and re-applied.
 */

document.title = BRANDING.productName;
const productNameEl = document.getElementById('product-name');
if (productNameEl) productNameEl.textContent = BRANDING.productName;
const taglineEl = document.getElementById('tagline');
if (taglineEl) taglineEl.textContent = BRANDING.tagline;

const warningEl = document.getElementById('core-warning');
const attentionTitleEl = document.getElementById('attention-title');
const attentionSubtitleEl = document.getElementById('attention-subtitle');
const attentionStatusEl = document.getElementById('attention-status');
const attentionActionsEl = document.getElementById('attention-actions');
const closeAllBtn = document.getElementById(
  'close-all-btn',
) as HTMLButtonElement | null;
const reviewBtn = document.getElementById(
  'review-btn',
) as HTMLButtonElement | null;
const setListEl = document.getElementById('set-list');
const similarSectionEl = document.getElementById(
  'similar-section',
) as HTMLDetailsElement | null;
const similarCountEl = document.getElementById('similar-count');
const fuzzyListEl = document.getElementById('fuzzy-list');
const activitySectionEl = document.getElementById(
  'activity-section',
) as HTMLDetailsElement | null;
const activityCountEl = document.getElementById('activity-count');
const activityListEl = document.getElementById('activity-list');
const allTabsSectionEl = document.getElementById(
  'all-tabs-section',
) as HTMLDetailsElement | null;
const tabsCountEl = document.getElementById('tabs-count');
const tabSearchEl = document.getElementById(
  'tab-search',
) as HTMLInputElement | null;
const tabListEl = document.getElementById('tab-list');
const noTabMatchesEl = document.getElementById('no-tab-matches');
const settingsSectionEl = document.getElementById(
  'settings-section',
) as HTMLDetailsElement | null;
const autoCloseEl = document.getElementById(
  'opt-autoclose',
) as HTMLInputElement | null;
const coreStatusEl = document.getElementById('core-status');
const swapStatsEl = document.getElementById('swap-stats');

// -------------------------------------------------------------------
// UI state that survives snapshot re-renders
// -------------------------------------------------------------------

const uiState = {
  openSections: new Set<string>(),
  expandedCards: new Set<string>(),
  searchQuery: '',
  closeAllInFlight: false,
};

let lastSnapshot: TabSnapshot | null = null;
let lastExactSets: ExactDuplicateSet[] = [];

for (const section of [similarSectionEl, activitySectionEl, allTabsSectionEl, settingsSectionEl]) {
  if (!section) continue;
  section.addEventListener('toggle', () => {
    if (section.open) uiState.openSections.add(section.id);
    else uiState.openSections.delete(section.id);
  });
}

function applySectionState(section: HTMLDetailsElement | null): void {
  if (section) section.open = uiState.openSections.has(section.id);
}

// -------------------------------------------------------------------
// Small builders
// -------------------------------------------------------------------

function fmtMs(ms: number | null): string {
  return ms === null ? '–' : `${Math.round(ms)} ms`;
}

/** Favicon image, or a neutral letter tile when the tab has no
 * favicon or it fails to load (no broken-image artifacts). */
function faviconEl(tab: { favIconUrl: string; title: string; url: string }): HTMLElement {
  const fallback = document.createElement('span');
  fallback.className = 'favicon-fallback';
  fallback.textContent = faviconFallbackLetter(tab.title, tab.url);
  fallback.setAttribute('aria-hidden', 'true');
  if (!tab.favIconUrl) return fallback;
  const img = document.createElement('img');
  img.className = 'favicon';
  img.src = tab.favIconUrl;
  img.alt = '';
  img.width = 16;
  img.height = 16;
  img.addEventListener('error', () => img.replaceWith(fallback), {
    once: true,
  });
  return img;
}

function activateTab(tab: TabInfo): void {
  void chrome.tabs.update(tab.id, { active: true });
  void chrome.windows.update(tab.windowId, { focused: true });
}

/** One tab row: favicon, title, and a muted host (or host/path) line.
 * Clicking activates the tab and focuses its window. */
function tabRow(tab: TabInfo, sublabel: 'host' | 'hostPath'): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'tab-row';
  if (tab.active) li.classList.add('active');
  const main = document.createElement('span');
  main.className = 'row-main';
  const title = document.createElement('span');
  title.className = 'row-title';
  title.textContent = tab.title || '(untitled)';
  const sub = document.createElement('span');
  sub.className = 'row-sub';
  sub.textContent =
    sublabel === 'host' ? hostLabel(tab.url) : hostPathLabel(tab.url);
  main.append(title, sub);
  li.append(faviconEl(tab), main);
  if (tab.active) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = 'Current';
    li.append(pill);
  }
  li.addEventListener('click', () => activateTab(tab));
  return li;
}

// -------------------------------------------------------------------
// Duplicate cards
// -------------------------------------------------------------------

function duplicateCard(
  set: ExactDuplicateSet,
  byId: Map<number, TabInfo>,
): HTMLLIElement {
  const members = set.tabIds
    .map((id) => byId.get(id))
    .filter((t): t is TabInfo => t !== undefined);
  const rep = members[0];
  const li = document.createElement('li');
  const details = document.createElement('details');
  details.className = 'set-card';
  details.dataset.key = set.exactKey;
  details.open = uiState.expandedCards.has(set.exactKey);
  details.addEventListener('toggle', () => {
    if (details.open) uiState.expandedCards.add(set.exactKey);
    else uiState.expandedCards.delete(set.exactKey);
  });

  const summary = document.createElement('summary');
  summary.className = 'set-summary';
  const main = document.createElement('span');
  main.className = 'row-main';
  const title = document.createElement('span');
  title.className = 'row-title';
  title.textContent = rep?.title || '(untitled)';
  const sub = document.createElement('span');
  sub.className = 'row-sub';
  sub.textContent = rep
    ? `${hostLabel(rep.url)} · ${pluralize(set.tabIds.length, 'copy', 'copies')} · ${pluralize(set.tabIds.length - 1, 'extra')}`
    : '';
  main.append(title, sub);
  summary.append(
    rep
      ? faviconEl(rep)
      : faviconEl({ favIconUrl: '', title: '', url: '' }),
    main,
  );

  const body = document.createElement('div');
  body.className = 'set-body';
  const memberList = document.createElement('ul');
  memberList.replaceChildren(...members.map((m) => tabRow(m, 'hostPath')));
  const actionRow = document.createElement('div');
  actionRow.className = 'set-actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `Keep newest, close ${pluralize(set.tabIds.length - 1, 'other')}`;
  button.addEventListener('click', () => {
    button.disabled = true;
    void chrome.runtime.sendMessage({
      type: CLOSE_DUPLICATE_SET_MESSAGE,
      exactKey: set.exactKey,
      keepTabId: set.newestTabId,
    });
  });
  actionRow.append(button);
  body.append(memberList, actionRow);

  details.append(summary, body);
  li.append(details);
  return li;
}

// -------------------------------------------------------------------
// Render
// -------------------------------------------------------------------

function renderTabRows(): void {
  if (!tabListEl || !lastSnapshot) return;
  const query = uiState.searchQuery.trim().toLowerCase();
  const tabs = lastSnapshot.tabs.filter((tab) => {
    if (!query) return true;
    return (
      tab.title.toLowerCase().includes(query) ||
      hostLabel(tab.url).toLowerCase().includes(query) ||
      tab.url.toLowerCase().includes(query)
    );
  });
  tabListEl.replaceChildren(...tabs.map((tab) => tabRow(tab, 'host')));
  if (noTabMatchesEl) noTabMatchesEl.hidden = tabs.length !== 0;
}

function render(snapshot: TabSnapshot): void {
  lastSnapshot = snapshot;
  const byId = new Map(snapshot.tabs.map((t) => [t.id, t]));

  // Core-state messaging: a clear warning on failure, a subtle
  // "getting ready" note while the core is still starting.
  if (warningEl) {
    warningEl.hidden = snapshot.coreState !== 'failed';
    if (snapshot.coreState === 'failed') {
      warningEl.textContent =
        "Automatic duplicate closing is off because the on-device core couldn't start. You can still review and close duplicates manually below.";
    }
  }
  if (attentionStatusEl) {
    attentionStatusEl.hidden = snapshot.coreState !== 'pending';
    if (snapshot.coreState === 'pending') {
      attentionStatusEl.textContent = 'Getting ready…';
    }
  }

  // Needs attention: the one obvious action, or a calm tidy state.
  const exactSets = findExactDuplicateSets(snapshot.tabs);
  lastExactSets = exactSets;
  const extraCount = countExtraCopies(exactSets);
  if (attentionTitleEl && attentionSubtitleEl && attentionActionsEl) {
    if (extraCount > 0) {
      attentionTitleEl.textContent =
        extraCount === 1
          ? '1 duplicate tab can be closed'
          : `${extraCount} duplicate tabs can be closed`;
      attentionSubtitleEl.textContent =
        exactSets.length === 1
          ? '1 document is open more than once.'
          : `${exactSets.length} documents are open more than once.`;
      attentionActionsEl.hidden = false;
    } else {
      attentionTitleEl.textContent = 'Everything is tidy';
      attentionSubtitleEl.textContent =
        "TabSense will keep new duplicates from piling up — open a page that's already open and it takes you to the existing tab instead.";
      attentionActionsEl.hidden = true;
    }
  }
  if (closeAllBtn) {
    closeAllBtn.disabled = uiState.closeAllInFlight;
    closeAllBtn.textContent = uiState.closeAllInFlight
      ? 'Closing…'
      : 'Close all extra copies';
  }

  // Duplicate cards (collapsed by default; members inside).
  if (setListEl) {
    setListEl.replaceChildren(
      ...exactSets.map((set) => duplicateCard(set, byId)),
    );
  }

  // Similar documents (fuzzy sets): display only, never bulk-closed.
  const fuzzySets = findFuzzySets(snapshot.tabs);
  if (similarSectionEl && fuzzyListEl) {
    similarSectionEl.hidden = fuzzySets.length === 0;
    applySectionState(similarSectionEl);
    if (similarCountEl) {
      similarCountEl.textContent = `(${fuzzySets.length})`;
    }
    fuzzyListEl.replaceChildren(
      ...fuzzySets.map((set) => {
        const members = set.tabIds
          .map((id) => byId.get(id))
          .filter((t): t is TabInfo => t !== undefined);
        const rep = members[0];
        const li = document.createElement('li');
        li.className = 'fuzzy-set';
        const head = document.createElement('div');
        head.className = 'fuzzy-head';
        const main = document.createElement('span');
        main.className = 'row-main';
        const title = document.createElement('span');
        title.className = 'row-title';
        title.textContent = rep?.title || '(untitled)';
        const sub = document.createElement('span');
        sub.className = 'row-sub';
        sub.textContent = rep
          ? `${hostLabel(rep.url)} · ${pluralize(set.tabIds.length, 'view')}`
          : '';
        main.append(title, sub);
        head.append(
          rep
            ? faviconEl(rep)
            : faviconEl({ favIconUrl: '', title: '', url: '' }),
          main,
        );
        const memberList = document.createElement('ul');
        memberList.className = 'fuzzy-members';
        memberList.replaceChildren(
          ...members.map((m) => tabRow(m, 'hostPath')),
        );
        li.append(head, memberList);
        return li;
      }),
    );
  }

  // Recently closed (activity log) with Reopen.
  if (activitySectionEl && activityListEl) {
    activitySectionEl.hidden = snapshot.activity.length === 0;
    applySectionState(activitySectionEl);
    if (activityCountEl) {
      activityCountEl.textContent = `(${snapshot.activity.length})`;
    }
    activityListEl.replaceChildren(
      ...snapshot.activity.map((entry) => {
        const li = document.createElement('li');
        li.className = 'activity-entry';
        const main = document.createElement('span');
        main.className = 'row-main';
        const title = document.createElement('span');
        title.className = 'row-title';
        title.textContent = entry.title || entry.url;
        const sub = document.createElement('span');
        sub.className = 'row-sub';
        const when = new Date(entry.closedAt).toLocaleTimeString();
        sub.textContent = `${when} · ${hostLabel(entry.url)}`;
        main.append(title, sub);
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Reopen';
        button.addEventListener('click', () => {
          void chrome.tabs.create({ url: entry.url });
        });
        li.append(
          faviconEl({ favIconUrl: '', title: entry.title, url: entry.url }),
          main,
          button,
        );
        return li;
      }),
    );
  }

  // All tabs (searchable; rows rendered separately so typing in the
  // search field never loses focus to a full re-render).
  applySectionState(allTabsSectionEl);
  if (tabsCountEl) tabsCountEl.textContent = `(${snapshot.tabs.length})`;
  renderTabRows();

  // Settings & details: the toggle, plain-language core status, and
  // swap timings only when there is data (never in the default view).
  applySectionState(settingsSectionEl);
  if (autoCloseEl) {
    autoCloseEl.checked = snapshot.autoCloseEnabled;
    autoCloseEl.disabled = snapshot.coreState === 'failed';
  }
  if (coreStatusEl) {
    coreStatusEl.textContent =
      snapshot.coreState === 'ready'
        ? 'On-device core: ready.'
        : snapshot.coreState === 'pending'
          ? 'On-device core: still loading — new duplicates are checked once it is ready.'
          : "On-device core: couldn't start — automatic closing is off, but manual cleanup above still works.";
  }
  if (swapStatsEl) {
    const s = snapshot.swaps;
    swapStatsEl.hidden = s.count === 0;
    if (s.count > 0) {
      swapStatsEl.textContent =
        `Focus swaps so far: ${s.count} · median ${fmtMs(s.medianMs)} · p95 ${fmtMs(s.p95Ms)}` +
        ` (${s.coldCount} while the core was starting, ${s.warmCount} after)`;
    }
  }
}

// -------------------------------------------------------------------
// Actions
// -------------------------------------------------------------------

if (closeAllBtn) {
  closeAllBtn.addEventListener('click', () => {
    if (uiState.closeAllInFlight) return;
    uiState.closeAllInFlight = true;
    if (lastSnapshot) render(lastSnapshot);
    void chrome.runtime
      .sendMessage({ type: CLOSE_ALL_DUPLICATES_MESSAGE })
      .catch(() => undefined)
      .finally(() => {
        uiState.closeAllInFlight = false;
        void loadInitial();
      });
  });
}

if (reviewBtn) {
  reviewBtn.addEventListener('click', () => {
    const first = lastExactSets[0];
    if (!first || !lastSnapshot) return;
    uiState.expandedCards.add(first.exactKey);
    render(lastSnapshot);
    const card = [...document.querySelectorAll<HTMLElement>('.set-card')].find(
      (el) => el.dataset.key === first.exactKey,
    );
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card?.querySelector('summary')?.focus({ preventScroll: true });
  });
}

if (tabSearchEl) {
  if (tabSearchEl.value !== uiState.searchQuery) {
    tabSearchEl.value = uiState.searchQuery;
  }
  tabSearchEl.addEventListener('input', () => {
    uiState.searchQuery = tabSearchEl.value;
    renderTabRows();
  });
}

if (autoCloseEl) {
  autoCloseEl.addEventListener('change', () => {
    void chrome.runtime.sendMessage({
      type: SET_AUTO_CLOSE_MESSAGE,
      enabled: autoCloseEl.checked,
    });
  });
}

// -------------------------------------------------------------------
// Snapshot plumbing (unchanged contract: ask the worker, fall back
// to the stored snapshot, then live-update on storage changes)
// -------------------------------------------------------------------

async function loadInitial(): Promise<void> {
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
