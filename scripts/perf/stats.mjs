/**
 * Small statistics helpers for the perf harness.
 *
 * Percentile convention matches the extension's own swap stats
 * (src/lib/snapshot.ts summarizeSwaps): p95 is the nearest-rank value
 * at index ceil(0.95 * n) - 1 of the ascending sort, and the median is
 * the middle value (average of the two middle values for even n).
 */

export function sortedCopy(values) {
  return [...values].sort((a, b) => a - b);
}

export function median(values) {
  if (values.length === 0) return null;
  const s = sortedCopy(values);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function p95(values) {
  if (values.length === 0) return null;
  const s = sortedCopy(values);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function summarize(values) {
  return {
    count: values.length,
    median: median(values),
    p95: p95(values),
    mean: mean(values),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

/**
 * Least-squares fit y = slope * x + intercept over paired samples.
 * Returns slope in y-units per x-unit. Degenerate inputs (fewer than
 * two points, or all x identical) yield slope 0.
 */
export function leastSquaresSlope(points) {
  if (points.length < 2) return 0;
  const n = points.length;
  const meanX = points.reduce((a, p) => a + p.x, 0) / n;
  const meanY = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) * (p.x - meanX);
  }
  return den === 0 ? 0 : num / den;
}

/** Round to `digits` decimals for reporting (null-safe). */
export function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
