import { BRANDING } from '../../src/config/branding';
import { parseBlocklist } from '../../src/lib/blocklist';
import {
  countExtraCopies,
  findExactDuplicateSets,
  findFuzzySets,
  type ExactDuplicateSet,
  type FuzzySet,
} from '../../src/lib/duplicates';
import {
  describeMembers,
  diagnosticsLines,
  faviconFallbackLetter,
  groupingStatusLine,
  hostLabel,
  lastUsedLabel,
  pickDefaultKeepTabId,
  pluralize,
  suggestionSourceLabel,
} from '../../src/lib/panel-model';
import {
  ACCEPT_SUGGESTION_MESSAGE,
  CLOSE_ALL_DUPLICATES_MESSAGE,
  CLOSE_DUPLICATE_SET_MESSAGE,
  CLOSE_SIMILAR_SET_MESSAGE,
  DISMISS_SUGGESTION_MESSAGE,
  GET_SNAPSHOT_MESSAGE,
  SET_AUTO_CLOSE_MESSAGE,
  SET_BLOCKLIST_MESSAGE,
  SET_GROUPING_PAUSED_MESSAGE,
  SET_PROVIDER_MESSAGE,
  SNAPSHOT_KEY,
  UNDO_GROUP_ACTION_MESSAGE,
  type Suggestion,
  type TabInfo,
  type TabSnapshot,
} from '../../src/lib/snapshot';

/**
 * Side panel (M1.1 UX reset, M1.2 readability): action-first.
 *
 * Layout, top to bottom: a "Needs attention" card with the one
 * obvious cleanup action, the duplicate cards it refers to
 * (collapsed until expanded), a reserved Suggested groups slot
 * (M2, hidden while empty), then collapsed secondary sections —
 * Similar documents, Recently closed, All tabs, Settings & details.
 * Diagnostics live in Settings & details, never in the default view.
 *
 * Disclosure is progressive at every level (M1.2): opening a
 * section or card shows compact headers only, and member rows are
 * short view descriptors + recency — never repeated titles or raw
 * URLs. Similar-document groups carry the one manual cleanup fuzzy
 * matches get: pick the view to keep, close the others.
 *
 * Rendering is snapshot-driven (the worker owns tab state and
 * pushes via chrome.storage). Small pieces of UI state that must
 * survive a re-render — which sections/cards are open, the search
 * query, keep choices, a close in flight — are kept here and
 * re-applied.
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
const showAllTabsBtn = document.getElementById(
  'show-all-tabs',
) as HTMLButtonElement | null;
const settingsSectionEl = document.getElementById(
  'settings-section',
) as HTMLDetailsElement | null;
const autoCloseEl = document.getElementById(
  'opt-autoclose',
) as HTMLInputElement | null;
const coreStatusEl = document.getElementById('core-status');
const swapStatsEl = document.getElementById('swap-stats');
const perfDiagnosticsEl = document.getElementById('perf-diagnostics');
const suggestedSectionEl = document.getElementById('suggested-groups');
const groupingStatusEl = document.getElementById('grouping-status');
const suggestionListEl = document.getElementById('suggestion-list');
const groupUndoBarEl = document.getElementById('group-undo-bar');
const groupUndoTextEl = document.getElementById('group-undo-text');
const groupUndoBtn = document.getElementById(
  'group-undo-btn',
) as HTMLButtonElement | null;
const groupingPausedEl = document.getElementById(
  'opt-grouping-paused',
) as HTMLInputElement | null;
const providerEl = document.getElementById(
  'opt-provider',
) as HTMLSelectElement | null;
const aiStatusEl = document.getElementById('ai-status');
const groupingStatusSettingsEl = document.getElementById(
  'grouping-status-settings',
);
const blocklistInputEl = document.getElementById(
  'blocklist-input',
) as HTMLTextAreaElement | null;
const blocklistSaveBtn = document.getElementById(
  'blocklist-save',
) as HTMLButtonElement | null;
const blocklistResetBtn = document.getElementById(
  'blocklist-reset',
) as HTMLButtonElement | null;

// -------------------------------------------------------------------
// UI state that survives snapshot re-renders
// -------------------------------------------------------------------

const uiState = {
  openSections: new Set<string>(),
  expandedCards: new Set<string>(),
  /** Similar-document cards the user has opened (by fuzzyKey);
   * all start closed — opening the section shows headers only. */
  expandedFuzzyCards: new Set<string>(),
  /** The user's chosen "view to keep" per fuzzy set (by fuzzyKey).
   * Only written on an explicit radio change, so an untouched
   * group's default keeps tracking the active/most-recent view. */
  similarKeepSelection: new Map<string, number>(),
  /** Fuzzy sets with a close-other-views request in flight. */
  similarCloseInFlight: new Set<string>(),
  searchQuery: '',
  /** All tabs: whether the 40-row preview cap has been lifted. */
  showAllTabs: false,
  closeAllInFlight: false,
  /** Suggestion inbox: per-suggestion tab include/exclude choices
   * (suggestionId → excluded tabIds). Absent = all included. */
  suggestionExcluded: new Map<string, Set<number>>(),
  /** Suggestion inbox: per-suggestion target override — a groupKey,
   * or '__new__'. Absent = the suggestion's own target. */
  suggestionTarget: new Map<string, string>(),
  /** Suggestion inbox: per-suggestion new-group name edits. */
  suggestionNewName: new Map<string, string>(),
  /** Suggestions with an accept/dismiss in flight. */
  suggestionInFlight: new Set<string>(),
  /** The blocklist text last synced from the worker, so re-renders
   * never clobber text the user is editing. */
  blocklistSyncedText: null as string | null,
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

/** One tab row (All tabs list): favicon, title, and a muted host
 * line. Clicking activates the tab and focuses its window. */
function tabRow(tab: TabInfo): HTMLLIElement {
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
  sub.textContent = hostLabel(tab.url);
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
// Compact member rows (M1.2)
//
// Inside a duplicate or similar card the document title and URL
// repeat on every row and tell the reader nothing. A member row is
// instead: a short view descriptor ("Sheet tab 3", "Newest copy"),
// a recency line ("Last used 3:42 PM"), and a Current pill.
// -------------------------------------------------------------------

function memberMain(descriptor: string, tab: TabInfo): HTMLElement {
  const main = document.createElement('span');
  main.className = 'row-main';
  const desc = document.createElement('span');
  desc.className = 'row-title';
  desc.textContent = descriptor;
  main.append(desc);
  const meta = lastUsedLabel(tab);
  if (meta) {
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent = meta;
    main.append(sub);
  }
  return main;
}

function currentPill(): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.textContent = 'Current';
  return pill;
}

/** A compact member row for an exact-duplicate card. Clicking
 * activates the tab and focuses its window. */
function memberRow(tab: TabInfo, descriptor: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'member-row';
  li.append(memberMain(descriptor, tab));
  if (tab.active) li.append(currentPill());
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
  memberList.className = 'member-list';
  // Members arrive newest-first (set.tabIds order). Positional
  // descriptors — no repeated titles, no URLs.
  memberList.replaceChildren(
    ...members.map((m, i) =>
      memberRow(m, i === 0 ? 'Newest copy' : `Copy ${i + 1}`),
    ),
  );
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
// Similar-document cards (M1.2)
//
// Each fuzzy set is its own collapsed card: opening the Similar
// documents section shows one compact header per group, and member
// rows appear only when that group is opened. Inside, the user can
// pick the view to keep and close the others — the one manual
// cleanup fuzzy matches get. They are still never auto-closed.
// -------------------------------------------------------------------

/** The keep selection for a group: the user's stored choice while
 * its tab is still a member, otherwise the default (active member,
 * else most recently accessed, else the set's newest-first order). */
function resolveSimilarKeep(
  set: FuzzySet,
  members: readonly TabInfo[],
): number {
  const stored = uiState.similarKeepSelection.get(set.fuzzyKey);
  if (stored !== undefined) {
    if (members.some((m) => m.id === stored)) return stored;
    uiState.similarKeepSelection.delete(set.fuzzyKey);
  }
  return pickDefaultKeepTabId(members) ?? members[0].id;
}

function similarMemberRow(
  set: FuzzySet,
  tab: TabInfo,
  descriptor: string,
  keepTabId: number,
): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'member-row selectable';
  const label = document.createElement('label');
  label.className = 'member-main';
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = `keep-${encodeURIComponent(set.fuzzyKey)}`;
  radio.checked = tab.id === keepTabId;
  radio.setAttribute('aria-label', `Keep: ${descriptor}`);
  radio.addEventListener('change', () => {
    if (radio.checked) {
      uiState.similarKeepSelection.set(set.fuzzyKey, tab.id);
    }
  });
  label.append(radio, memberMain(descriptor, tab));
  li.append(label);
  if (tab.active) li.append(currentPill());
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'open-btn';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () => activateTab(tab));
  li.append(openBtn);
  // Clicking the row selects it as the view to keep (the label
  // covers most of the row; this catches the rest) rather than
  // navigating away — the Open button is the navigation affordance.
  li.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    radio.checked = true;
    uiState.similarKeepSelection.set(set.fuzzyKey, tab.id);
  });
  return li;
}

function similarCard(
  set: FuzzySet,
  byId: Map<number, TabInfo>,
): HTMLLIElement {
  const members = set.tabIds
    .map((id) => byId.get(id))
    .filter((t): t is TabInfo => t !== undefined);
  const rep = members[0];
  const li = document.createElement('li');
  const details = document.createElement('details');
  details.className = 'set-card';
  details.dataset.key = set.fuzzyKey;
  details.open = uiState.expandedFuzzyCards.has(set.fuzzyKey);
  details.addEventListener('toggle', () => {
    if (details.open) uiState.expandedFuzzyCards.add(set.fuzzyKey);
    else uiState.expandedFuzzyCards.delete(set.fuzzyKey);
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
    ? `${hostLabel(rep.url)} · ${pluralize(members.length, 'view')}`
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
  if (members.length > 0) {
    const hint = document.createElement('p');
    hint.className = 'note set-hint';
    hint.textContent =
      "Choose the view to keep. Closing a view doesn't delete the document — closed views appear in Recently closed, where you can reopen them.";
    const keepTabId = resolveSimilarKeep(set, members);
    const descriptors = describeMembers(members.map((m) => m.url));
    const memberList = document.createElement('ul');
    memberList.className = 'member-list';
    memberList.replaceChildren(
      ...members.map((m, i) =>
        similarMemberRow(set, m, descriptors[i], keepTabId),
      ),
    );
    const actionRow = document.createElement('div');
    actionRow.className = 'set-actions';
    const inFlight = uiState.similarCloseInFlight.has(set.fuzzyKey);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.disabled = inFlight;
    closeBtn.textContent = inFlight
      ? 'Closing…'
      : `Close other ${pluralize(members.length - 1, 'view')}`;
    closeBtn.addEventListener('click', () => {
      if (uiState.similarCloseInFlight.has(set.fuzzyKey)) return;
      uiState.similarCloseInFlight.add(set.fuzzyKey);
      if (lastSnapshot) render(lastSnapshot);
      void chrome.runtime
        .sendMessage({
          type: CLOSE_SIMILAR_SET_MESSAGE,
          fuzzyKey: set.fuzzyKey,
          keepTabId,
        })
        .catch(() => undefined)
        .finally(() => {
          uiState.similarCloseInFlight.delete(set.fuzzyKey);
          void loadInitial();
        });
    });
    actionRow.append(closeBtn);
    body.append(hint, memberList, actionRow);
  }

  details.append(summary, body);
  li.append(details);
  return li;
}

// -------------------------------------------------------------------
// Suggestion inbox (M2)
//
// Suggest mode: a suggestion is a proposal, never an action. Each
// card shows what would be filed where, lets the user uncheck tabs,
// retarget (another group, or a new group with an editable name),
// then Accept or Dismiss. Accepting is the only path that groups a
// tab, and the worker re-validates everything at click time.
// -------------------------------------------------------------------

const NEW_GROUP_TARGET = '__new__';

function suggestionIncludedIds(suggestion: Suggestion): number[] {
  const excluded = uiState.suggestionExcluded.get(suggestion.id);
  return suggestion.tabIds.filter((id) => !excluded?.has(id));
}

function suggestionCard(suggestion: Suggestion, snapshot: TabSnapshot): HTMLLIElement {
  const li = document.createElement('li');
  const card = document.createElement('div');
  card.className = 'suggestion-card';

  const title = document.createElement('p');
  title.className = 'suggestion-title';
  title.textContent =
    suggestion.kind === 'new-group'
      ? `New group “${suggestion.proposedName ?? 'New group'}”`
      : `Add to “${suggestion.targetGroupName ?? 'group'}”`;
  const sub = document.createElement('p');
  sub.className = 'row-sub';
  sub.textContent = `${suggestionSourceLabel(suggestion.source, suggestion.nanoFallback)} · ${pluralize(suggestion.tabIds.length, 'tab')}`;
  card.append(title, sub);

  // Member rows with include/exclude toggles.
  const memberList = document.createElement('ul');
  memberList.className = 'member-list';
  const byId = new Map(snapshot.tabs.map((t) => [t.id, t]));
  for (const ref of suggestion.tabs) {
    const row = document.createElement('li');
    row.className = 'member-row selectable';
    const label = document.createElement('label');
    label.className = 'member-main';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !uiState.suggestionExcluded
      .get(suggestion.id)
      ?.has(ref.tabId);
    checkbox.setAttribute('aria-label', `Include: ${ref.title}`);
    checkbox.addEventListener('change', () => {
      const set =
        uiState.suggestionExcluded.get(suggestion.id) ?? new Set<number>();
      if (checkbox.checked) set.delete(ref.tabId);
      else set.add(ref.tabId);
      uiState.suggestionExcluded.set(suggestion.id, set);
      if (lastSnapshot) render(lastSnapshot);
    });
    const tab = byId.get(ref.tabId);
    const main = document.createElement('span');
    main.className = 'row-main';
    const titleEl = document.createElement('span');
    titleEl.className = 'row-title';
    titleEl.textContent = ref.title || '(untitled)';
    const hostEl = document.createElement('span');
    hostEl.className = 'row-sub';
    hostEl.textContent = hostLabel(ref.url);
    main.append(titleEl, hostEl);
    label.append(checkbox, main);
    row.append(label);
    if (tab?.active) row.append(currentPill());
    memberList.append(row);
  }
  card.append(memberList);

  // Retarget: file into another TabSense group, or a new group
  // (with an editable name). Manual groups are never offered —
  // they are hands-off by design.
  const targetRow = document.createElement('div');
  targetRow.className = 'suggestion-target';
  const targetLabel = document.createElement('label');
  targetLabel.textContent = 'File into ';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'File into');
  const ownValue =
    suggestion.kind === 'new-group'
      ? NEW_GROUP_TARGET
      : (suggestion.targetGroupKey ?? NEW_GROUP_TARGET);
  const options: { value: string; label: string }[] = [];
  if (suggestion.kind === 'add-to-group' && suggestion.targetGroupKey) {
    options.push({
      value: suggestion.targetGroupKey,
      label: suggestion.targetGroupName ?? 'Group',
    });
  }
  options.push({
    value: NEW_GROUP_TARGET,
    label:
      suggestion.kind === 'new-group'
        ? `New group “${suggestion.proposedName ?? 'New group'}”`
        : 'New group…',
  });
  for (const g of snapshot.groupOptions) {
    if (g.windowId !== suggestion.windowId) continue;
    if (g.groupKey === suggestion.targetGroupKey) continue;
    options.push({ value: g.groupKey, label: g.name });
  }
  for (const opt of options) {
    const optionEl = document.createElement('option');
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    select.append(optionEl);
  }
  select.value = uiState.suggestionTarget.get(suggestion.id) ?? ownValue;
  select.addEventListener('change', () => {
    uiState.suggestionTarget.set(suggestion.id, select.value);
    if (lastSnapshot) render(lastSnapshot);
  });
  targetLabel.append(select);
  targetRow.append(targetLabel);

  const chosenTarget = uiState.suggestionTarget.get(suggestion.id) ?? ownValue;
  if (chosenTarget === NEW_GROUP_TARGET) {
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'group-name-input';
    nameInput.placeholder = 'Group name';
    nameInput.maxLength = 60;
    nameInput.value =
      uiState.suggestionNewName.get(suggestion.id) ??
      suggestion.proposedName ??
      '';
    nameInput.setAttribute('aria-label', 'New group name');
    nameInput.addEventListener('input', () => {
      uiState.suggestionNewName.set(suggestion.id, nameInput.value);
    });
    targetRow.append(nameInput);
  }
  card.append(targetRow);

  // Actions.
  const included = suggestionIncludedIds(suggestion);
  const inFlight = uiState.suggestionInFlight.has(suggestion.id);
  const actions = document.createElement('div');
  actions.className = 'set-actions';
  const acceptBtn = document.createElement('button');
  acceptBtn.type = 'button';
  acceptBtn.className = 'primary';
  acceptBtn.disabled = inFlight || included.length === 0;
  acceptBtn.textContent = inFlight
    ? 'Filing…'
    : chosenTarget === NEW_GROUP_TARGET
      ? 'Create group'
      : 'Add tabs';
  acceptBtn.addEventListener('click', () => {
    if (uiState.suggestionInFlight.has(suggestion.id)) return;
    uiState.suggestionInFlight.add(suggestion.id);
    const target =
      chosenTarget === NEW_GROUP_TARGET
        ? {
            kind: 'new' as const,
            name:
              uiState.suggestionNewName.get(suggestion.id) ??
              suggestion.proposedName ??
              'New group',
          }
        : { kind: 'group' as const, groupKey: chosenTarget };
    void chrome.runtime
      .sendMessage({
        type: ACCEPT_SUGGESTION_MESSAGE,
        suggestionId: suggestion.id,
        tabIds: included,
        target,
      })
      .catch(() => undefined)
      .finally(() => {
        uiState.suggestionInFlight.delete(suggestion.id);
        uiState.suggestionExcluded.delete(suggestion.id);
        uiState.suggestionTarget.delete(suggestion.id);
        uiState.suggestionNewName.delete(suggestion.id);
        void loadInitial();
      });
    if (lastSnapshot) render(lastSnapshot);
  });
  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.disabled = inFlight;
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    if (uiState.suggestionInFlight.has(suggestion.id)) return;
    uiState.suggestionInFlight.add(suggestion.id);
    void chrome.runtime
      .sendMessage({
        type: DISMISS_SUGGESTION_MESSAGE,
        suggestionId: suggestion.id,
      })
      .catch(() => undefined)
      .finally(() => {
        uiState.suggestionInFlight.delete(suggestion.id);
        uiState.suggestionExcluded.delete(suggestion.id);
        uiState.suggestionTarget.delete(suggestion.id);
        uiState.suggestionNewName.delete(suggestion.id);
        void loadInitial();
      });
    if (lastSnapshot) render(lastSnapshot);
  });
  actions.append(acceptBtn, dismissBtn);
  card.append(actions);

  li.append(card);
  return li;
}

function renderSuggestions(snapshot: TabSnapshot): void {
  if (!suggestedSectionEl || !suggestionListEl) return;
  const paused = snapshot.grouping.pausedByUser;
  suggestedSectionEl.hidden = snapshot.suggestions.length === 0 && !paused;
  if (groupingStatusEl) {
    groupingStatusEl.textContent = groupingStatusLine(snapshot.grouping);
  }
  suggestionListEl.replaceChildren(
    ...snapshot.suggestions.map((sug) => suggestionCard(sug, snapshot)),
  );
  // Undo bar for the most recent accepted action.
  if (groupUndoBarEl && groupUndoTextEl && groupUndoBtn) {
    const action = snapshot.lastGroupAction;
    groupUndoBarEl.hidden = action === null;
    if (action) {
      groupUndoTextEl.textContent = `${action.description}.`;
      groupUndoBtn.disabled = false;
    }
  }
  // Drop per-suggestion UI state for suggestions that are gone.
  const liveIds = new Set(snapshot.suggestions.map((s) => s.id));
  for (const map of [
    uiState.suggestionExcluded,
    uiState.suggestionTarget,
    uiState.suggestionNewName,
  ]) {
    for (const key of [...map.keys()]) {
      if (!liveIds.has(key)) map.delete(key);
    }
  }
}

function renderManagedNote(
  elementId: string,
  snapshot: TabSnapshot,
  key: string,
): void {
  const el = document.getElementById(elementId);
  if (el) el.hidden = !snapshot.settingsView.managedKeys.includes(key);
}

/** Plain-language on-device AI status for Settings (the detailed
 * counterpart of the passive status line). */
function aiStatusText(snapshot: TabSnapshot): string {
  if (snapshot.settingsView.provider === 'heuristics') {
    return 'On-device AI: off by choice — grouping uses local rules.';
  }
  switch (snapshot.grouping.nanoAvailability) {
    case 'available':
      return 'On-device AI: available on this device.';
    case 'downloadable':
      return 'On-device AI: the model is not downloaded yet — grouping uses local rules meanwhile.';
    case 'downloading':
      return 'On-device AI: model downloading — grouping uses local rules meanwhile.';
    case 'unavailable':
      return 'On-device AI: not available on this device — grouping uses local rules.';
    default:
      return 'On-device AI: status not checked yet.';
  }
}

// -------------------------------------------------------------------
// Render
// -------------------------------------------------------------------

/** How many All-tabs rows render before the "Show all" button —
 * enough to scan, short enough to stay readable (M1.2). A search
 * always shows every match, uncapped. */
const ALL_TABS_PREVIEW_LIMIT = 40;

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
  const capped =
    query === '' && !uiState.showAllTabs && tabs.length > ALL_TABS_PREVIEW_LIMIT;
  const visible = capped ? tabs.slice(0, ALL_TABS_PREVIEW_LIMIT) : tabs;
  tabListEl.replaceChildren(...visible.map((tab) => tabRow(tab)));
  if (showAllTabsBtn) {
    showAllTabsBtn.hidden = !capped;
    showAllTabsBtn.textContent = `Show all ${pluralize(tabs.length, 'tab')}`;
  }
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
  const fuzzySets = findFuzzySets(snapshot.tabs);
  const extraCount = countExtraCopies(exactSets);
  // Drop keep choices for groups that no longer exist.
  for (const key of [...uiState.similarKeepSelection.keys()]) {
    if (!fuzzySets.some((s) => s.fuzzyKey === key)) {
      uiState.similarKeepSelection.delete(key);
    }
  }
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
    } else if (fuzzySets.length > 0) {
      // Not "tidy" — there is an optional review waiting below.
      attentionTitleEl.textContent = 'No exact duplicates';
      attentionSubtitleEl.textContent =
        "New duplicates will be handled automatically. Some documents below are open in more than one view — you can review those separately if you'd like.";
      attentionActionsEl.hidden = true;
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

  // Suggestion inbox (M2) — in the slot reserved by the M1.1 layout.
  renderSuggestions(snapshot);

  // Similar documents (fuzzy sets): one collapsed card per group —
  // opening the section shows headers only. Manual cleanup lives
  // inside each card; fuzzy views are never auto-closed.
  if (similarSectionEl && fuzzyListEl) {
    similarSectionEl.hidden = fuzzySets.length === 0;
    applySectionState(similarSectionEl);
    if (similarCountEl) {
      similarCountEl.textContent = `(${fuzzySets.length})`;
    }
    fuzzyListEl.replaceChildren(
      ...fuzzySets.map((set) => similarCard(set, byId)),
    );
  }

  // Recently closed (activity log) with Reopen. Grouping entries
  // (group-accept / group-dismiss / group-undo) share the persisted
  // log but are not closed tabs — they never appear here.
  const closeActivity = snapshot.activity.filter(
    (e) => e.reason === 'auto-close' || e.reason === 'bulk-close',
  );
  if (activitySectionEl && activityListEl) {
    activitySectionEl.hidden = closeActivity.length === 0;
    applySectionState(activitySectionEl);
    if (activityCountEl) {
      activityCountEl.textContent = `(${closeActivity.length})`;
    }
    activityListEl.replaceChildren(
      ...closeActivity.map((entry) => {
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
    autoCloseEl.disabled =
      snapshot.coreState === 'failed' ||
      snapshot.settingsView.managedKeys.includes('autoCloseEnabled');
  }
  renderManagedNote('managed-autoclose', snapshot, 'autoCloseEnabled');

  // Grouping settings (M2): pause toggle, provider, AI status,
  // blocklist editor — all with managed-precedence labeling.
  const sv = snapshot.settingsView;
  if (groupingPausedEl) {
    groupingPausedEl.checked = sv.groupingPaused;
    groupingPausedEl.disabled = sv.managedKeys.includes('groupingPaused');
  }
  renderManagedNote('managed-grouping-paused', snapshot, 'groupingPaused');
  if (providerEl) {
    providerEl.value = sv.provider;
    providerEl.disabled = sv.managedKeys.includes('provider');
  }
  renderManagedNote('managed-provider', snapshot, 'provider');
  if (aiStatusEl) {
    aiStatusEl.textContent = aiStatusText(snapshot);
  }
  if (groupingStatusSettingsEl) {
    groupingStatusSettingsEl.textContent = groupingStatusLine(
      snapshot.grouping,
    );
  }
  renderManagedNote('managed-blocklist', snapshot, 'blocklist');
  if (blocklistInputEl) {
    const text = sv.blocklist.join('\n');
    // Never clobber an edit in progress: sync only when the field
    // is untouched or the worker's list actually changed under us.
    if (
      document.activeElement !== blocklistInputEl ||
      uiState.blocklistSyncedText === null
    ) {
      if (blocklistInputEl.value !== text) {
        blocklistInputEl.value = text;
      }
      uiState.blocklistSyncedText = text;
    }
    const managed = sv.managedKeys.includes('blocklist');
    blocklistInputEl.disabled = managed;
    if (blocklistSaveBtn) blocklistSaveBtn.disabled = managed;
    if (blocklistResetBtn) blocklistResetBtn.disabled = managed;
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
  if (perfDiagnosticsEl) {
    // M3 self-diagnostics. Snapshots persisted before M3 have no
    // diagnostics block — render nothing extra in that case.
    perfDiagnosticsEl.replaceChildren();
    if (snapshot.diagnostics) {
      for (const line of diagnosticsLines(snapshot.diagnostics)) {
        const p = document.createElement('p');
        p.textContent = line;
        perfDiagnosticsEl.appendChild(p);
      }
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

if (showAllTabsBtn) {
  showAllTabsBtn.addEventListener('click', () => {
    uiState.showAllTabs = true;
    renderTabRows();
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

if (groupUndoBtn) {
  groupUndoBtn.addEventListener('click', () => {
    groupUndoBtn.disabled = true;
    void chrome.runtime
      .sendMessage({ type: UNDO_GROUP_ACTION_MESSAGE })
      .catch(() => undefined)
      .finally(() => void loadInitial());
  });
}

if (groupingPausedEl) {
  groupingPausedEl.addEventListener('change', () => {
    void chrome.runtime
      .sendMessage({
        type: SET_GROUPING_PAUSED_MESSAGE,
        paused: groupingPausedEl.checked,
      })
      .catch(() => undefined)
      .finally(() => void loadInitial());
  });
}

if (providerEl) {
  providerEl.addEventListener('change', () => {
    void chrome.runtime
      .sendMessage({
        type: SET_PROVIDER_MESSAGE,
        provider: providerEl.value,
      })
      .catch(() => undefined)
      .finally(() => void loadInitial());
  });
}

if (blocklistSaveBtn && blocklistInputEl) {
  blocklistSaveBtn.addEventListener('click', () => {
    const parsed = parseBlocklist(blocklistInputEl.value);
    uiState.blocklistSyncedText = null; // force resync from worker
    void chrome.runtime
      .sendMessage({ type: SET_BLOCKLIST_MESSAGE, blocklist: parsed })
      .catch(() => undefined)
      .finally(() => void loadInitial());
  });
}

if (blocklistResetBtn) {
  blocklistResetBtn.addEventListener('click', () => {
    uiState.blocklistSyncedText = null;
    void chrome.runtime
      .sendMessage({ type: SET_BLOCKLIST_MESSAGE, blocklist: null })
      .catch(() => undefined)
      .finally(() => void loadInitial());
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
