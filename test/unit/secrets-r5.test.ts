// Fix round 5 (page), items 5 and 6: scrubbing stays linear on backslash runs. Oracle: the review's
// measurement (100k backslashes took 2.1 s against an all-backslash remembered password) and the AC
// "linear". Red-first: MOTORIKA_TEST_SRC=<old checkout>/src runs the same tests against another source tree.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { beforeEach, describe, test } from 'node:test';

const SRC = process.env.MOTORIKA_TEST_SRC ?? new URL('../../src', import.meta.url).pathname;
const m = (await import(`${SRC}/util/secrets.ts`)) as typeof import('../../src/util/secrets.ts');

function timed(text: string): { ms: number; out: string } {
  const t0 = performance.now();
  const out = m.scrubSecrets(text);
  return { ms: performance.now() - t0, out };
}

describe('round 5, item 5: an all-backslash remembered password', () => {
  beforeEach(() => m.resetSecretsForTest());
  test('100k backslashes scrub in linear time (was 2.1 s)', () => {
    m.rememberSecret('\\'.repeat(6));
    const { ms, out } = timed('\\'.repeat(100_000));
    assert.ok(out.includes(m.REDACTED), 'the run holds the secret');
    // Generous bound for a loaded machine: linear is a few ms, the quadratic scan seconds.
    assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
  });
  test('doubling the input does not quadruple the time', () => {
    m.rememberSecret('\\'.repeat(6));
    timed('\\'.repeat(10_000)); // warm up
    const a = Math.min(...[0, 1, 2].map(() => timed('\\'.repeat(40_000)).ms));
    const b = Math.min(...[0, 1, 2].map(() => timed('\\'.repeat(80_000)).ms));
    assert.ok(b < Math.max(4 * a, 50), `40k: ${a.toFixed(1)} ms, 80k: ${b.toFixed(1)} ms`);
  });
  test('escape handling is unchanged around backslash runs', () => {
    m.rememberSecret('Hunter2!x');
    // An escaped character right before the secret (odd run): `\n` ends an escape, so the secret is a token.
    assert.equal(m.scrubSecrets('line\\nHunter2!x'), 'line\\n<redacted>');
    // An even run is two literal backslashes: the secret after it is still a whole token.
    assert.equal(m.scrubSecrets('C:\\\\Hunter2!x'), 'C:\\\\<redacted>');
    // Letters glued on either side keep it whole-token only.
    assert.equal(m.scrubSecrets('aHunter2!x'), 'aHunter2!x');
  });
});

describe('round 5, item 6: a secret inside words', () => {
  beforeEach(() => m.resetSecretsForTest());
  test('1.6 MB of in-word occurrences scrubs nothing and stays fast', () => {
    m.rememberSecret('Hunter2!x');
    const text = 'abcHunter2!xdef '.repeat(100_000);
    const { ms, out } = timed(text);
    assert.equal(out, text);
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  });
});
