/**
 * Circuit-breaker adversarial tests (test-hardening commission,
 * method 5's state machine): trip thresholds at their exact
 * boundaries, cooldown/probe (half-open) transitions, failure
 * counting at the ladder's bottom rung, and the interaction
 * between explicit rung sets and in-flight breaker state.
 * Time is injected (`now` parameters) — no real clocks.
 */

import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/lib/breaker';

const T0 = 1_000_000;
const COOL = 60_000;

function breaker(opts = {}): CircuitBreaker {
  return new CircuitBreaker({ failureThreshold: 3, cooldownMs: COOL, ...opts });
}

function trip(b: CircuitBreaker, now: number): void {
  b.recordFailure(now);
  b.recordFailure(now);
  b.recordFailure(now);
}

describe('trip threshold', () => {
  it('trips exactly at the threshold — not before', () => {
    const b = breaker();
    expect(b.currentRung(T0)).toBe('nano');
    b.recordFailure(T0);
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('nano');
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('heuristics');
  });

  it('a success resets the consecutive count', () => {
    const b = breaker();
    b.recordFailure(T0);
    b.recordFailure(T0);
    b.recordSuccess();
    b.recordFailure(T0);
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('nano');
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('heuristics');
  });

  it('threshold of 1 trips on the first failure', () => {
    const b = breaker({ failureThreshold: 1 });
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('heuristics');
  });

  it('repeated trips walk the whole ladder to paused (worker order: read rung, then record the outcome)', () => {
    const b = breaker();
    trip(b, T0); // nano → heuristics, cooling until T0+COOL
    expect(b.currentRung(T0)).toBe('heuristics');
    // After cooldown the pass reads the probe rung (nano); the
    // probe fails, so the breaker re-cools on heuristics.
    expect(b.currentRung(T0 + COOL)).toBe('nano');
    b.recordFailure(T0 + COOL);
    expect(b.currentRung(T0 + COOL)).toBe('heuristics');
    // Three fresh failures on heuristics trip to domain-only.
    trip(b, T0 + COOL);
    expect(b.currentRung(T0 + COOL)).toBe('domain-only');
    // Probe of heuristics fails; three more failures trip to paused.
    expect(b.currentRung(T0 + 2 * COOL)).toBe('heuristics');
    b.recordFailure(T0 + 2 * COOL);
    trip(b, T0 + 2 * COOL);
    expect(b.currentRung(T0 + 2 * COOL)).toBe('paused');
  });
});

describe('cooldown and probe (half-open)', () => {
  it('during cooldown the lower rung serves; at expiry the next read probes the higher rung', () => {
    const b = breaker();
    trip(b, T0);
    expect(b.currentRung(T0 + COOL - 1)).toBe('heuristics');
    expect(b.isProbing()).toBe(false);
    expect(b.currentRung(T0 + COOL)).toBe('nano');
    expect(b.isProbing()).toBe(true);
    // Reading again while probing keeps returning the probe rung.
    expect(b.currentRung(T0 + COOL + 1)).toBe('nano');
  });

  it('a successful probe restores the higher rung permanently', () => {
    const b = breaker();
    trip(b, T0);
    expect(b.currentRung(T0 + COOL)).toBe('nano');
    b.recordSuccess();
    expect(b.isProbing()).toBe(false);
    expect(b.currentRung(T0 + COOL)).toBe('nano');
    // And the failure count starts fresh on the restored rung.
    b.recordFailure(T0 + COOL);
    b.recordFailure(T0 + COOL);
    expect(b.currentRung(T0 + COOL)).toBe('nano');
  });

  it('a failed probe re-cools on the lower rung with a fresh count', () => {
    const b = breaker();
    trip(b, T0);
    expect(b.currentRung(T0 + COOL)).toBe('nano');
    b.recordFailure(T0 + COOL);
    expect(b.isProbing()).toBe(false);
    expect(b.currentRung(T0 + COOL + 1)).toBe('heuristics');
    expect(b.currentRung(T0 + 2 * COOL - 1)).toBe('heuristics');
    expect(b.currentRung(T0 + 2 * COOL)).toBe('nano');
  });

  it('cooldown of 0 makes the probe eligible immediately', () => {
    const b = breaker({ cooldownMs: 0 });
    trip(b, T0);
    expect(b.currentRung(T0)).toBe('nano');
    expect(b.isProbing()).toBe(true);
  });

  it('characterization: a success recorded while NOT probing does not clear a running cooldown', () => {
    const b = breaker();
    trip(b, T0);
    b.recordSuccess(); // stray success mid-cooldown
    expect(b.currentRung(T0 + COOL - 1)).toBe('heuristics');
    expect(b.currentRung(T0 + COOL)).toBe('nano');
    expect(b.isProbing()).toBe(true);
  });
});

describe('the bottom rung and explicit sets', () => {
  it('failures at paused accumulate without effect and without overflow of the ladder', () => {
    const b = breaker({ startRung: 'paused' });
    for (let i = 0; i < 10; i++) b.recordFailure(T0 + i);
    expect(b.currentRung(T0 + 100)).toBe('paused');
  });

  it('setStartRung resets failures, probing, and cooldown', () => {
    const b = breaker();
    trip(b, T0);
    expect(b.currentRung(T0 + COOL)).toBe('nano'); // probing
    b.setStartRung('heuristics');
    expect(b.isProbing()).toBe(false);
    expect(b.currentRung(T0)).toBe('heuristics');
    // Two failures do not trip: the count was reset.
    b.recordFailure(T0);
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('heuristics');
  });

  it('a heuristics-started breaker never probes nano: the probe is always the rung directly above the resting rung', () => {
    const b = breaker({ startRung: 'heuristics' });
    trip(b, T0); // heuristics → domain-only
    expect(b.currentRung(T0)).toBe('domain-only');
    // The probe targets heuristics — the rung above the resting
    // rung — not the ladder top.
    expect(b.currentRung(T0 + COOL)).toBe('heuristics');
    // A successful probe restores heuristics with NO cooldown
    // left: it rests there, it does not cascade up to nano.
    b.recordSuccess();
    expect(b.currentRung(T0 + COOL)).toBe('heuristics');
    expect(b.currentRung(T0 + 100 * COOL)).toBe('heuristics');
  });
});
