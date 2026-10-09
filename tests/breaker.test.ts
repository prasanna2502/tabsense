import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/lib/breaker';

const T0 = 1_000_000;

describe('CircuitBreaker', () => {
  it('starts on the configured rung', () => {
    expect(new CircuitBreaker().currentRung(T0)).toBe('nano');
    expect(
      new CircuitBreaker({ startRung: 'heuristics' }).currentRung(T0),
    ).toBe('heuristics');
  });

  it('trips one rung down after the failure threshold', () => {
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    b.recordFailure(T0);
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('nano');
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('heuristics');
  });

  it('a success resets the consecutive-failure count', () => {
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    b.recordFailure(T0);
    b.recordSuccess();
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('nano');
  });

  it('after cooldown, one probe tests the higher rung and success restores it', () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('heuristics');
    // Still cooling down: no probe yet.
    expect(b.currentRung(T0 + 999)).toBe('heuristics');
    // Cooldown elapsed: the next decision probes nano.
    expect(b.currentRung(T0 + 1000)).toBe('nano');
    expect(b.isProbing()).toBe(true);
    b.recordSuccess();
    expect(b.isProbing()).toBe(false);
    expect(b.currentRung(T0 + 1001)).toBe('nano');
  });

  it('a failed probe re-trips the breaker for another cooldown', () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure(T0);
    expect(b.currentRung(T0 + 1000)).toBe('nano'); // probe
    b.recordFailure(T0 + 1000);
    expect(b.currentRung(T0 + 1001)).toBe('heuristics');
    expect(b.currentRung(T0 + 2000)).toBe('nano'); // next probe
  });

  it('walks the whole ladder and stops at paused', () => {
    // Failures recorded while a rung is actively serving (including
    // during the cooldown of the rung above) walk the ladder down.
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    expect(b.currentRung(T0)).toBe('nano');
    b.recordFailure(T0);
    b.recordFailure(T0); // trip → heuristics
    expect(b.currentRung(T0 + 100)).toBe('heuristics');
    b.recordFailure(T0 + 100);
    b.recordFailure(T0 + 100); // trip → domain-only
    expect(b.currentRung(T0 + 200)).toBe('domain-only');
    b.recordFailure(T0 + 200);
    b.recordFailure(T0 + 200); // trip → paused
    expect(b.currentRung(T0 + 300)).toBe('paused');
    // Further failures keep it paused (never below the last rung).
    b.recordFailure(T0 + 400);
    b.recordFailure(T0 + 400);
    expect(b.currentRung(T0 + 500)).toBe('paused');
  });

  it('setStartRung hard-sets the resting rung (provider change)', () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure(T0);
    expect(b.currentRung(T0)).toBe('heuristics');
    b.setStartRung('nano');
    expect(b.currentRung(T0)).toBe('nano');
    b.setStartRung('heuristics');
    expect(b.currentRung(T0)).toBe('heuristics');
  });
});
