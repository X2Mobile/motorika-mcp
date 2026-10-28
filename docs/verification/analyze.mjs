// Summarise a `claude -p --output-format stream-json --verbose` run:
// tool calls in order (name, input, result size, error flag), final answer, and the H1 oracle check.
import { readFileSync } from 'node:fs';

const [, , file] = process.argv;
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const calls = new Map();
const order = [];
let final = null;
let resultMeta = null;
for (const line of lines) {
  let m;
  try { m = JSON.parse(line); } catch { continue; }
  if (m.type === 'assistant') {
    for (const c of m.message?.content ?? []) {
      if (c.type === 'tool_use') {
        calls.set(c.id, { name: c.name, input: c.input, chars: 0, isError: false });
        order.push(c.id);
      }
    }
  } else if (m.type === 'user') {
    for (const c of m.message?.content ?? []) {
      if (c.type === 'tool_result' && calls.has(c.tool_use_id)) {
        const rec = calls.get(c.tool_use_id);
        const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content ?? '') }];
        rec.chars = parts.reduce((n, p) => n + (p.type === 'text' ? (p.text ?? '').length : 0), 0);
        rec.images = parts.filter((p) => p.type === 'image').length;
        rec.isError = Boolean(c.is_error);
      }
    }
  } else if (m.type === 'result') {
    final = m.result ?? null;
    resultMeta = { duration_ms: m.duration_ms, num_turns: m.num_turns, is_error: m.is_error, cost: m.total_cost_usd };
  }
}
console.log(`tool calls: ${order.length}`);
for (const id of order) {
  const r = calls.get(id);
  console.log(`- ${r.name} ${JSON.stringify(r.input).slice(0, 160)} -> ${r.chars} chars${r.images ? ` + ${r.images} img` : ''}${r.isError ? ' ERROR' : ''}`);
}
console.log('meta', JSON.stringify(resultMeta));
console.log('--- final answer ---\n' + final);
const expected = ['Ann H1', '+1 555 0100', 'h1@example.com', 'medium', 'bacon', 'onion', '19:30', 'x2-browser H1 check'];
const missing = expected.filter((v) => !(final ?? '').includes(v));
console.log(missing.length ? `ORACLE MISSING: ${JSON.stringify(missing)}` : 'ORACLE: all echoed values present');
