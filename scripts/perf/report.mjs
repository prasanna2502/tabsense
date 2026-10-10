/**
 * Perf report rendering: a measured-vs-budget table for stdout plus
 * perf-report.json / perf-report.md written to <repo>/.perf-results/
 * (CI artifact location — never /tmp).
 */

export function allGateRows(results) {
  const rows = [];
  for (const result of results) {
    for (const g of result.gates) {
      rows.push({ scenario: result.id, ...g });
    }
  }
  return rows;
}

export function anyGateFailed(results) {
  return results.some(
    (r) => r.status === 'error' || r.gates.some((g) => g.gate && !g.pass),
  );
}

function fmt(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  }
  return String(value);
}

export function renderStdoutTable(results) {
  const lines = [];
  lines.push('');
  lines.push('=== TabSense perf: measured vs budget ===');
  for (const r of results) {
    lines.push('');
    lines.push(`[${r.id}] ${r.title} — ${r.status.toUpperCase()} (${(r.durationMs / 1000).toFixed(1)} s)`);
    if (r.gates.length === 0) lines.push('  (no gates evaluated)');
    for (const g of r.gates) {
      const verdict = g.pass ? 'PASS' : g.gate ? 'FAIL' : 'INFO-FAIL';
      lines.push(
        `  ${verdict.padEnd(9)} ${g.label}: measured ${fmt(g.measured)} ${g.unit} vs budget ${g.comparison} ${fmt(g.budget)} ${g.unit} [${g.budgetId}]${g.gate ? '' : ' (informational)'}`,
      );
    }
    for (const note of r.notes) lines.push(`  note: ${note}`);
    if (r.error) lines.push(`  error: ${r.error}`);
  }
  lines.push('');
  lines.push(anyGateFailed(results) ? 'RESULT: FAIL (one or more gates failed)' : 'RESULT: PASS');
  return lines.join('\n');
}

export function renderMarkdown({ generatedAt, environment, budgetsVersion, results, totalDurationMs }) {
  const lines = [];
  lines.push('# TabSense perf report');
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push('| Key | Value |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(environment)) {
    lines.push(`| ${k} | ${v ?? '—'} |`);
  }
  lines.push(`| Budgets file version | ${budgetsVersion} |`);
  lines.push(`| Total wall-clock | ${(totalDurationMs / 1000).toFixed(1)} s |`);
  lines.push(`| Overall | ${anyGateFailed(results) ? '**FAIL**' : '**PASS**'} |`);
  lines.push('');
  lines.push('## Measured vs budget');
  lines.push('');
  lines.push('| Scenario | Check | Measured | Budget | Result |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const row of allGateRows(results)) {
    const verdict = row.pass ? 'PASS' : row.gate ? 'FAIL' : 'INFO-FAIL (informational)';
    lines.push(
      `| ${row.scenario} | ${row.label} [${row.budgetId}] | ${fmt(row.measured)} ${row.unit} | ${row.comparison} ${fmt(row.budget)} ${row.unit} | ${verdict} |`,
    );
  }
  lines.push('');
  for (const r of results) {
    lines.push(`## Scenario: ${r.id} — ${r.title}`);
    lines.push('');
    lines.push(`Status: **${r.status}** · duration ${(r.durationMs / 1000).toFixed(1)} s`);
    lines.push('');
    if (r.error) {
      lines.push(`Error: \`${r.error}\``);
      lines.push('');
    }
    for (const note of r.notes) {
      lines.push(`- ${note}`);
    }
    if (r.notes.length) lines.push('');
    lines.push('<details><summary>Raw measurements</summary>');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(r.measurements, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  return lines.join('\n');
}

export function buildJsonReport({ generatedAt, environment, budgetsVersion, results, totalDurationMs }) {
  return {
    generatedAt,
    environment,
    budgetsVersion,
    totalDurationMs,
    overallPass: !anyGateFailed(results),
    scenarios: results,
  };
}
