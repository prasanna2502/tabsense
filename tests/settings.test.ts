import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKLIST } from '../src/lib/blocklist';
import {
  GROUPING_SETTINGS_KEY,
  loadEffectiveSettings,
  type SettingsStorageArea,
} from '../src/lib/settings';
import { SETTINGS_KEY } from '../src/lib/snapshot';

function area(values: Record<string, unknown>): SettingsStorageArea {
  return {
    get: (keys: string[]) =>
      Promise.resolve(
        Object.fromEntries(
          keys.filter((k) => k in values).map((k) => [k, values[k]]),
        ),
      ),
  };
}

const EMPTY = area({});

describe('loadEffectiveSettings', () => {
  it('falls back to defaults with local provenance', async () => {
    const eff = await loadEffectiveSettings(EMPTY, null);
    expect(eff.autoCloseEnabled).toBe(true);
    expect(eff.groupingPaused).toBe(false);
    expect(eff.provider).toBe('nano');
    expect(eff.blocklist).toEqual([...DEFAULT_BLOCKLIST]);
    expect(eff.managedKeys).toEqual([]);
    expect(eff.sources.provider).toBe('local');
  });

  it('honors local values, including an empty user blocklist', async () => {
    const local = area({
      [SETTINGS_KEY]: false,
      [GROUPING_SETTINGS_KEY]: {
        groupingPaused: true,
        provider: 'heuristics',
        blocklist: [],
      },
    });
    const eff = await loadEffectiveSettings(local, null);
    expect(eff.autoCloseEnabled).toBe(false);
    expect(eff.groupingPaused).toBe(true);
    expect(eff.provider).toBe('heuristics');
    expect(eff.blocklist).toEqual([]);
  });

  it('managed values override local ones field by field', async () => {
    const local = area({
      [GROUPING_SETTINGS_KEY]: {
        groupingPaused: false,
        provider: 'nano',
        blocklist: ['example.com'],
      },
    });
    const managed = area({
      [GROUPING_SETTINGS_KEY]: { provider: 'heuristics' },
    });
    const eff = await loadEffectiveSettings(local, managed);
    // Managed field wins; untouched fields stay local.
    expect(eff.provider).toBe('heuristics');
    expect(eff.sources.provider).toBe('managed');
    expect(eff.groupingPaused).toBe(false);
    expect(eff.sources.groupingPaused).toBe('local');
    expect(eff.blocklist).toEqual(['example.com']);
    expect(eff.managedKeys).toEqual(['provider']);
  });

  it('a managed blocklist replaces both the default and local lists', async () => {
    const managed = area({
      [GROUPING_SETTINGS_KEY]: { blocklist: ['corp.internal'] },
    });
    const eff = await loadEffectiveSettings(EMPTY, managed);
    expect(eff.blocklist).toEqual(['corp.internal']);
    expect(eff.sources.blocklist).toBe('managed');
  });

  it('a managed autoCloseEnabled=false overrides a local true', async () => {
    const local = area({ [SETTINGS_KEY]: true });
    const managed = area({ [SETTINGS_KEY]: false });
    const eff = await loadEffectiveSettings(local, managed);
    expect(eff.autoCloseEnabled).toBe(false);
    expect(eff.sources.autoCloseEnabled).toBe('managed');
  });

  it('ignores malformed managed and local values', async () => {
    const local = area({
      [GROUPING_SETTINGS_KEY]: { provider: 'gibberish', groupingPaused: 'yes' },
    });
    const managed = area({ [GROUPING_SETTINGS_KEY]: 'not-an-object' });
    const eff = await loadEffectiveSettings(local, managed);
    expect(eff.provider).toBe('nano');
    expect(eff.groupingPaused).toBe(false);
    expect(eff.managedKeys).toEqual([]);
  });

  it('treats a rejecting managed area as empty (unmanaged browser)', async () => {
    const broken: SettingsStorageArea = {
      get: () => Promise.reject(new Error('no managed storage')),
    };
    const eff = await loadEffectiveSettings(EMPTY, broken);
    expect(eff.provider).toBe('nano');
    expect(eff.managedKeys).toEqual([]);
  });
});
