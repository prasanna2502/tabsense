import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOCKLIST,
  isBlocklisted,
  normalizeBlocklistEntry,
  parseBlocklist,
} from '../src/lib/blocklist';

describe('isBlocklisted', () => {
  it('matches the host and its subdomains', () => {
    expect(isBlocklisted('https://www.chase.com/accounts', DEFAULT_BLOCKLIST)).toBe(true);
    expect(isBlocklisted('https://secure07.chase.com/login', DEFAULT_BLOCKLIST)).toBe(true);
    expect(isBlocklisted('https://accounts.google.com/signin', DEFAULT_BLOCKLIST)).toBe(true);
  });

  it('does not match lookalike hosts or unrelated sites', () => {
    expect(isBlocklisted('https://notchase.com/', DEFAULT_BLOCKLIST)).toBe(false);
    expect(isBlocklisted('https://chase.com.evil.example/', DEFAULT_BLOCKLIST)).toBe(false);
    expect(isBlocklisted('https://www.allrecipes.com/recipe/1', DEFAULT_BLOCKLIST)).toBe(false);
  });

  it('an empty user list blocks nothing (a legitimate choice)', () => {
    expect(isBlocklisted('https://www.chase.com/', [])).toBe(false);
  });
});

describe('parseBlocklist / normalizeBlocklistEntry', () => {
  it('accepts URLs, bare hosts, and sloppy input', () => {
    expect(
      parseBlocklist('https://www.Chase.com/login\nbank.example.com, foo\nhttps://kp.org'),
    ).toEqual(['bank.example.com', 'chase.com', 'kp.org']);
  });

  it('dedupes and sorts', () => {
    expect(parseBlocklist('b.com\na.com\nb.com')).toEqual(['a.com', 'b.com']);
  });

  it('drops entries that are not hosts', () => {
    expect(normalizeBlocklistEntry('not a host')).toBe('');
    expect(normalizeBlocklistEntry('localhost')).toBe('');
    expect(normalizeBlocklistEntry('')).toBe('');
  });
});
