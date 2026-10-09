/**
 * Settings model (M2) with managed-precedence hooks from day one.
 *
 * One model serves individual users and managed browsers:
 * `chrome.storage.managed` values (pushed by an organization's IT
 * admin) override local values **per field** and are reported with
 * their provenance so the UI can label them "Managed by your
 * organization" and lock the control (proposal §12). The full policy
 * schema and enterprise pack are M6 — what lands here is the data
 * model, the precedence rule, and the labeling contract, so M6 is an
 * addition, not a rewrite.
 *
 * Local layout (back-compatible with M1):
 *  - `autoCloseEnabled` (boolean) — the M1 key, unchanged.
 *  - `groupingSettings` (object) — { groupingPaused, provider,
 *    blocklist }. `blocklist: null` means "use the default list";
 *    an array (even empty) is the user's own list.
 */

import { DEFAULT_BLOCKLIST } from './blocklist';
import { SETTINGS_KEY } from './snapshot';

export const GROUPING_SETTINGS_KEY = 'groupingSettings';

export type ProviderChoice = 'nano' | 'heuristics';

export interface GroupingSettings {
  groupingPaused: boolean;
  provider: ProviderChoice;
  /** null = default blocklist; otherwise the user's list verbatim. */
  blocklist: string[] | null;
}

export type SettingSource = 'local' | 'managed';

export interface EffectiveSettings {
  autoCloseEnabled: boolean;
  groupingPaused: boolean;
  provider: ProviderChoice;
  /** The blocklist in force (default list resolved). */
  blocklist: string[];
  /** Where each effective value came from. */
  sources: {
    autoCloseEnabled: SettingSource;
    groupingPaused: SettingSource;
    provider: SettingSource;
    blocklist: SettingSource;
  };
  /** Field names currently forced by policy (for UI labeling). */
  managedKeys: string[];
}

/** The storage surface this module needs — the worker passes the
 * real chrome.storage areas; tests pass fakes. A managed area that
 * rejects (unmanaged browser quirk) is treated as empty. */
export interface SettingsStorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
}

const DEFAULTS: GroupingSettings = {
  groupingPaused: false,
  provider: 'nano',
  blocklist: null,
};

function sanitizeGrouping(raw: unknown): Partial<GroupingSettings> {
  if (typeof raw !== 'object' || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const out: Partial<GroupingSettings> = {};
  if (typeof obj.groupingPaused === 'boolean') {
    out.groupingPaused = obj.groupingPaused;
  }
  if (obj.provider === 'nano' || obj.provider === 'heuristics') {
    out.provider = obj.provider;
  }
  if (
    obj.blocklist === null ||
    (Array.isArray(obj.blocklist) &&
      obj.blocklist.every((e) => typeof e === 'string'))
  ) {
    out.blocklist = obj.blocklist as string[] | null;
  }
  return out;
}

/**
 * Load effective settings: local values first, then any managed
 * value overrides its local counterpart field by field. `managed`
 * may be null (no managed area available at all).
 */
export async function loadEffectiveSettings(
  local: SettingsStorageArea,
  managed: SettingsStorageArea | null,
): Promise<EffectiveSettings> {
  const keys = [SETTINGS_KEY, GROUPING_SETTINGS_KEY];
  const localRaw = await local.get(keys).catch((): Record<string, unknown> => ({}));
  const managedRaw = managed
    ? await managed.get(keys).catch((): Record<string, unknown> => ({}))
    : {};

  const localGroup = sanitizeGrouping(localRaw[GROUPING_SETTINGS_KEY]);
  const managedGroup = sanitizeGrouping(managedRaw[GROUPING_SETTINGS_KEY]);

  const sources: EffectiveSettings['sources'] = {
    autoCloseEnabled: 'local',
    groupingPaused: 'local',
    provider: 'local',
    blocklist: 'local',
  };
  const managedKeys: string[] = [];

  let autoCloseEnabled = localRaw[SETTINGS_KEY] !== false;
  if (typeof managedRaw[SETTINGS_KEY] === 'boolean') {
    autoCloseEnabled = managedRaw[SETTINGS_KEY];
    sources.autoCloseEnabled = 'managed';
    managedKeys.push('autoCloseEnabled');
  }

  const merged: GroupingSettings = {
    groupingPaused:
      managedGroup.groupingPaused ??
      localGroup.groupingPaused ??
      DEFAULTS.groupingPaused,
    provider:
      managedGroup.provider ?? localGroup.provider ?? DEFAULTS.provider,
    blocklist:
      managedGroup.blocklist !== undefined
        ? managedGroup.blocklist
        : localGroup.blocklist !== undefined
          ? localGroup.blocklist
          : DEFAULTS.blocklist,
  };
  if (managedGroup.groupingPaused !== undefined) {
    sources.groupingPaused = 'managed';
    managedKeys.push('groupingPaused');
  }
  if (managedGroup.provider !== undefined) {
    sources.provider = 'managed';
    managedKeys.push('provider');
  }
  if (managedGroup.blocklist !== undefined) {
    sources.blocklist = 'managed';
    managedKeys.push('blocklist');
  }

  return {
    autoCloseEnabled,
    groupingPaused: merged.groupingPaused,
    provider: merged.provider,
    blocklist: merged.blocklist ?? [...DEFAULT_BLOCKLIST],
    sources,
    managedKeys,
  };
}
