/**
 * Resilience ladder + circuit breaker (proposal §11, v1 for M2).
 *
 * Grouping quality degrades down a ladder — never browsing:
 *
 *   nano → heuristics → domain-only → paused
 *
 * The breaker watches the current rung's health signals. Consecutive
 * failures trip it one rung down for a cooldown; after the cooldown
 * a single probe call tests the higher rung, and its outcome either
 * restores that rung (success) or re-trips the breaker (failure).
 * Dedupe never consults this module and is unaffected in every
 * state, including `paused`.
 */

export type LadderRung = 'nano' | 'heuristics' | 'domain-only' | 'paused';

export const LADDER: readonly LadderRung[] = [
  'nano',
  'heuristics',
  'domain-only',
  'paused',
];

export interface BreakerOptions {
  /** Consecutive failures that trip the breaker one rung down. */
  failureThreshold?: number;
  /** How long a tripped rung stays down before a probe is allowed. */
  cooldownMs?: number;
  /** Rung to start on (provider "heuristics" starts one rung down:
   * Nano is never attempted). */
  startRung?: LadderRung;
}

export class CircuitBreaker {
  private rungIndex: number;
  private failures = 0;
  private cooldownUntil: number | null = null;
  private probing = false;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options: BreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000;
    const start = options.startRung ?? 'nano';
    this.rungIndex = Math.max(0, LADDER.indexOf(start));
  }

  /** The rung the next grouping decision should use. Higher than
   * the resting rung only while a post-cooldown probe is in play. */
  currentRung(now: number): LadderRung {
    if (
      this.cooldownUntil !== null &&
      now >= this.cooldownUntil &&
      this.rungIndex > 0
    ) {
      this.probing = true;
      return LADDER[this.rungIndex - 1];
    }
    return LADDER[this.rungIndex];
  }

  /** True while the current rung is a recovery probe (its next
   * outcome decides whether the higher rung is restored). */
  isProbing(): boolean {
    return this.probing;
  }

  recordSuccess(): void {
    this.failures = 0;
    if (this.probing) {
      // Probe passed: restore the higher rung for good.
      this.rungIndex = Math.max(0, this.rungIndex - 1);
      this.probing = false;
      this.cooldownUntil = null;
    }
  }

  recordFailure(now: number): void {
    if (this.probing) {
      // Probe failed: stay on the lower rung, cool down again.
      this.probing = false;
      this.cooldownUntil = now + this.cooldownMs;
      this.failures = 0;
      return;
    }
    this.failures++;
    if (
      this.failures >= this.failureThreshold &&
      this.rungIndex < LADDER.length - 1
    ) {
      this.rungIndex++;
      this.failures = 0;
      this.cooldownUntil = now + this.cooldownMs;
    }
  }

  /** Hard-set the resting rung (provider change, user pause). The
   * breaker never fights an explicit setting. */
  setStartRung(rung: LadderRung): void {
    this.rungIndex = Math.max(0, LADDER.indexOf(rung));
    this.failures = 0;
    this.probing = false;
    this.cooldownUntil = null;
  }
}
