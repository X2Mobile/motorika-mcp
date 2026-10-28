// Merge agent result files of one round that ran in separate sessions into one file for report.mjs. Round 2 ran
// the six headless tools on 2026-10-26 and the two real-Chrome tools on 2026-10-27.
// Usage: node bench/merge-agent.mjs <out.json> <a.json> <b.json> [...]
// Runs, skips, voids and warm-ups are concatenated. Each tool must come from exactly one input, and every input
// must share the model and the hard timeout, or the merge refuses. Date, start, end and plan keep every part,
// labelled with its date and tools.
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeIds } from './report.mjs';

const toolsOf = (part) => [...new Set(part.runs.map((r) => r.contender))].sort();

export function mergeAgent(input) {
  if (input.length < 2) throw new Error('merge needs at least two agent files');
  // Legacy ids first (x2-browser is motorika), so a file from before the rename cannot add a second motorika.
  const parts = input.map(normalizeIds);
  const [first] = parts;
  const owner = new Map();
  for (const p of parts) {
    if (p.kind !== 'agent') throw new Error(`not an agent result file (date ${p.date})`);
    if (p.model !== first.model) throw new Error(`model differs: ${first.model} vs ${p.model}`);
    if (p.timeout_min !== first.timeout_min) throw new Error(`hard timeout differs: ${first.timeout_min} vs ${p.timeout_min} min`);
    for (const id of toolsOf(p)) {
      if (owner.has(id)) throw new Error(`${id} has runs in two inputs (${owner.get(id)} and ${p.date})`);
      owner.set(id, p.date);
    }
  }
  const label = (p) => `${p.date.slice(0, 10)} (${toolsOf(p).join(', ')})`;
  const runs = parts.flatMap((p) => p.runs);
  return {
    kind: 'agent',
    date: parts.map((p) => p.date.slice(0, 10)).join(' + '),
    model: first.model,
    timeout_min: first.timeout_min,
    merged_from: parts.map(label),
    plan: { parts: parts.map((p) => p.plan ?? null) },
    start: { uptime: parts.map((p) => `${label(p)}: ${p.start?.uptime ?? 'n/a'}`).join('; ') },
    end: { uptime: parts.map((p) => `${label(p)}: ${p.end?.uptime ?? 'n/a'}`).join('; ') },
    resumed_at: parts.flatMap((p) => p.resumed_at ?? []),
    warmups: parts.flatMap((p) => p.warmups ?? []),
    skipped: parts.flatMap((p) => p.skipped ?? []),
    voided: parts.flatMap((p) => p.voided ?? []),
    total_cost_usd: runs.reduce((n, r) => n + (r.total_cost_usd ?? 0), 0),
    runs,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [out, ...inputs] = process.argv.slice(2);
  if (!out || inputs.length < 2) {
    process.stderr.write('usage: node bench/merge-agent.mjs <out.json> <a.json> <b.json> [...]\n');
    process.exit(2);
  }
  const merged = mergeAgent(inputs.map((f) => JSON.parse(readFileSync(f, 'utf8'))));
  writeFileSync(out, JSON.stringify(merged, null, 2));
  process.stderr.write(`wrote ${out}: ${merged.runs.length} runs from ${merged.merged_from.join('; ')}\n`);
}
