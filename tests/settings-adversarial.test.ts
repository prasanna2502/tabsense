/**
 * Settings & managed-policy adversarial tests (test-hardening
 * commission, method 7): the full precedence matrix for every
 * field, corrupt payloads in either store, a managed area that
 * rejects (unmanaged-browser quirk), and policy appearing /
 * disappearing between loads. The store fakes implement exactly
 * the SettingsStorageArea surface; `local` also carries the
 * top-level auto-close flag (SETTINGS_KEY).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKLIST } from '../src/lib/blocklist';
import {
  GROUPING_SETTINGS_KEY,
  loadEffectiveSettings,
  type SettingsStorageArea,
} from '../src/lib/settings';
import { SETTINGS_KEY } from '../src/lib/snapshot';

function area(payload: Record<string, unknown>): SettingsStorageArea {
  return { get: async () => payload };
}
function rejectingArea(): SettingsStorageArea {
  return {
    get: async () => {
      throw new Error('storage unavailable');
    },
  };
}
const EMPTY = area({});
const localWith = (
  grouping: unknown,
  autoClose?: unknown,
): SettingsStorageArea =>
  area({
    [GROUPING_SETTINGS_KEY]: grouping,
    ...(autoClose !== undefined ? { [SETTINGS_KEY]: autoClose } : {}),
  });
const managedWith = (grouping: unknown, autoClose?: unknown) =>
  localWith(grouping, autoClose);

describe('defaults and local-only behavior', () => {
  it('empty stores yield the documented defaults, all sourced local', async () => {
    const eff = await loadEffectiveSettings(EMPTY, null);
    expect(eff).toEqual({
      autoCloseEnabled: true,
      groupingPaused: false,
      provider: 'nano',
      blocklist: [...DEFAULT_BLOCKLIST],
      keepIntentionalDuplicates: true,
      sources: {
        autoCloseEnabled: 'local',
        groupingPaused: 'local',
        provider: 'local',
        blocklist: 'local',
        keepIntentionalDuplicates: 'local',
      },
      managedKeys: [],
    });
  });

  it('no managed area at all (null) is the unmanaged browser', async () => {
    const eff = await loadEffectiveSettings(
      localWith({ groupingPaused: true, provider: 'heuristics' }),
      null,
    );
    expect(eff.groupingPaused).toBe(true);
    expect(eff.provider).toBe('heuristics');
    expect(eff.managedKeys).toEqual([]);
  });

  it('local values are honored field by field', async () => {
    const eff = await loadEffectiveSettings(
      localWith(
        {
          groupingPaused: true,
          provider: 'heuristics',
          blocklist: ['bank.example'],
          keepIntentionalDuplicates: false,
        },
        false,
      ),
      null,
    );
    expect(eff.autoCloseEnabled).toBe(false);
    expect(eff.groupingPaused).toBe(true);
    expect(eff.provider).toBe('heuristics');
    expect(eff.blocklist).toEqual(['bank.example']);
    expect(eff.keepIntentionalDuplicates).toBe(false);
  });

  it('a local empty blocklist is honored (user removed every default)', async () => {
    const eff = await loadEffectiveSettings(localWith({ blocklist: [] }), null);
    expect(eff.blocklist).toEqual([]);
    expect(eff.sources.blocklist).toBe('local');
  });

  it('local autoClose: only a strict boolean false disables (M1 fail-open by design)', async () => {
    for (const v of ['false', 0, null, {}, []] as unknown[]) {
      const eff = await loadEffectiveSettings(localWith({}, v), null);
      expect(eff.autoCloseEnabled).toBe(true);
    }
    const eff = await loadEffectiveSettings(localWith({}, false), null);
    expect(eff.autoCloseEnabled).toBe(false);
  });
});

describe('managed precedence — the full matrix', () => {
  it('managed overrides every grouping field and the auto-close flag, labeled per field', async () => {
    const eff = await loadEffectiveSettings(
      localWith(
        {
          groupingPaused: false,
          provider: 'nano',
          blocklist: ['local.example'],
          keepIntentionalDuplicates: true,
        },
        true,
      ),
      managedWith(
        {
          groupingPaused: true,
          provider: 'heuristics',
          blocklist: ['managed.example'],
          keepIntentionalDuplicates: false,
        },
        false,
      ),
    );
    expect(eff.autoCloseEnabled).toBe(false);
    expect(eff.groupingPaused).toBe(true);
    expect(eff.provider).toBe('heuristics');
    expect(eff.blocklist).toEqual(['managed.example']);
    expect(eff.keepIntentionalDuplicates).toBe(false);
    expect(eff.sources).toEqual({
      autoCloseEnabled: 'managed',
      groupingPaused: 'managed',
      provider: 'managed',
      blocklist: 'managed',
      keepIntentionalDuplicates: 'managed',
    });
    expect(eff.managedKeys.sort()).toEqual(
      [
        'autoCloseEnabled',
        'blocklist',
        'groupingPaused',
        'keepIntentionalDuplicates',
        'provider',
      ].sort(),
    );
  });

  it('managed overrides are per-field: untouched fields stay local', async () => {
    const eff = await loadEffectiveSettings(
      localWith({ provider: 'heuristics', groupingPaused: true }),
      managedWith({ provider: 'nano' }),
    );
    expect(eff.provider).toBe('nano');
    expect(eff.sources.provider).toBe('managed');
    expect(eff.groupingPaused).toBe(true);
    expect(eff.sources.groupingPaused).toBe('local');
    expect(eff.managedKeys).toEqual(['provider']);
  });

  it('managed blocklist null means "the default list", NOT "no opinion": it overrides a local list and resolves to defaults', async () => {
    const eff = await loadEffectiveSettings(
      localWith({ blocklist: ['local.example'] }),
      managedWith({ blocklist: null }),
    );
    expect(eff.blocklist).toEqual([...DEFAULT_BLOCKLIST]);
    expect(eff.sources.blocklist).toBe('managed');
  });

  it('managed blocklist [] is honored as an empty list', async () => {
    const eff = await loadEffectiveSettings(
      localWith({ blocklist: ['local.example'] }),
      managedWith({ blocklist: [] }),
    );
    expect(eff.blocklist).toEqual([]);
    expect(eff.sources.blocklist).toBe('managed');
  });

  it('managed autoClose overrides only as a boolean; a corrupt managed flag leaves local in force', async () => {
    const eff = await loadEffectiveSettings(
      localWith({}, false),
      managedWith({}, 'yes'),
    );
    expect(eff.autoCloseEnabled).toBe(false);
    expect(eff.sources.autoCloseEnabled).toBe('local');
    expect(eff.managedKeys).not.toContain('autoCloseEnabled');
  });
});

describe('corrupt payloads', () => {
  it('wrong-typed grouping fields are dropped individually, not wholesale', async () => {
    const eff = await loadEffectiveSettings(
      localWith({
        groupingPaused: 'yes',
        provider: 'gpt',
        blocklist: 'not-an-array',
        keepIntentionalDuplicates: 1,
      }),
      null,
    );
    expect(eff.groupingPaused).toBe(false);
    expect(eff.provider).toBe('nano');
    expect(eff.blocklist).toEqual([...DEFAULT_BLOCKLIST]);
    expect(eff.keepIntentionalDuplicates).toBe(true);
  });

  it('one non-string element poisons the whole blocklist (falls back to defaults, never a partial list)', async () => {
    const eff = await loadEffectiveSettings(
      localWith({ blocklist: ['ok.example', 42, 'also-ok.example'] }),
      null,
    );
    expect(eff.blocklist).toEqual([...DEFAULT_BLOCKLIST]);
  });

  it('a corrupt managed blocklist does NOT override a valid local one', async () => {
    const eff = await loadEffectiveSettings(
      localWith({ blocklist: ['local.example'] }),
      managedWith({ blocklist: ['ok.example', null] }),
    );
    expect(eff.blocklist).toEqual(['local.example']);
    expect(eff.sources.blocklist).toBe('local');
  });

  it('non-object grouping payloads (string, array, number) are ignored in both stores', async () => {
    for (const bad of ['junk', [1, 2], 42, true] as unknown[]) {
      const eff = await loadEffectiveSettings(localWith(bad), managedWith(bad));
      expect(eff.provider).toBe('nano');
      expect(eff.groupingPaused).toBe(false);
      expect(eff.managedKeys).toEqual([]);
    }
  });

  it('rejecting storage areas are treated as empty — load never throws', async () => {
    const eff = await loadEffectiveSettings(rejectingArea(), rejectingArea());
    expect(eff.provider).toBe('nano');
    const eff2 = await loadEffectiveSettings(
      localWith({ provider: 'heuristics' }),
      rejectingArea(),
    );
    expect(eff2.provider).toBe('heuristics');
    expect(eff2.sources.provider).toBe('local');
  });
});

describe('policy appearing and disappearing between loads', () => {
  it('a policy that appears takes over on the next load; when it disappears, local values return', async () => {
    const local = localWith({ provider: 'heuristics' });
    const before = await loadEffectiveSettings(local, EMPTY);
    expect(before.provider).toBe('heuristics');
    expect(before.sources.provider).toBe('local');

    const during = await loadEffectiveSettings(
      local,
      managedWith({ provider: 'nano' }),
    );
    expect(during.provider).toBe('nano');
    expect(during.sources.provider).toBe('managed');

    const after = await loadEffectiveSettings(local, EMPTY);
    expect(after.provider).toBe('heuristics');
    expect(after.sources.provider).toBe('local');
    expect(after.managedKeys).toEqual([]);
  });
});
