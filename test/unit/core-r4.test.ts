// Unit tests for fix round 4, implementer A (PLAN.md "2026-10-23: fix round 4 (A)"; brief D2, D3, D4, D5, nit).
// Expectations come from the brief's acceptance criteria and the reviewers' scenarios, not from this code.
//   node --import tsx --test test/unit/core-r4.test.ts
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { FORGOTTEN_CAP, RefRegistry } from '../../src/browser/refs.ts';
import { redactPrintedUrls } from '../../src/dispatch.ts';
import { clip, effect } from '../../src/util/format.ts';
import * as effects from '../../src/page/effects.ts';

/** A lone high surrogate (no low half after it) or a lone low surrogate. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------------------------------------------------------------------------------------------------
// D4: "Trimming is linear: the 50k case takes under 10 ms. The output is the same as before for normal URLs."
describe('D4 printed-URL trailing punctuation', () => {
  // Expected outputs written from the C11 contract: the URL body is redacted, trailing ) ] . , ; : ! ? stay
  // outside it, brackets and parentheses inside the URL stay inside.
  const R = '<redacted>';
  const table: [string, string][] = [
    ['https://a.test/x', 'https://a.test/x'],
    ['see https://a.test/x?token=abc.', `see https://a.test/x?token=${R}.`],
    ['(https://a.test/x?token=abc)', `(https://a.test/x?token=${R})`],
    ['[https://a.test/x?token=abc]', `[https://a.test/x?token=${R}]`],
    ['https://a.test/x?token=abc).,;:!?', `https://a.test/x?token=${R}).,;:!?`],
    ['https://a.test/?a[0]=1&token=abc', `https://a.test/?a[0]=1&token=${R}`],
    ['https://a.test/?q=(x)&token=abc', `https://a.test/?q=(x)&token=${R}`],
    ['https://a.test/?q=(x)&token=abc).', `https://a.test/?q=(x)&token=${R}).`],
    ['go to http://a.test/path/ now', 'go to http://a.test/path/ now'],
    ['ws://a.test/s?password=p,', `ws://a.test/s?password=${R},`],
    ['file:///tmp/x.html.', 'file:///tmp/x.html.'],
    ['https://a.test/x?token=abc"', `https://a.test/x?token=${R}"`],
    ['two https://a.test/?token=1, https://b.test/?api_key=2.', `two https://a.test/?token=${R}, https://b.test/?api_key=${R}.`],
  ];
  for (const [input, want] of table) {
    it(`unchanged output: ${JSON.stringify(input)}`, () => {
      assert.equal(redactPrintedUrls(input), want);
    });
  }

  it('the old regex trim gives the same split on every table case (the behaviour did not move)', () => {
    const OLD = /[)\].,;:!?]+$/;
    for (const [input] of table) {
      const old = input.replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/g, (u) => {
        const tail = OLD.exec(u)?.[0] ?? '';
        return `<${tail ? u.slice(0, -tail.length) : u}|${tail}>`;
      });
      const now = input.replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/g, (u) => {
        let i = u.length;
        while (i > 0 && ')].,;:!?'.includes(u[i - 1] as string)) i--;
        return `<${u.slice(0, i)}|${u.slice(i)}>`;
      });
      assert.equal(now, old, input);
    }
  });

  it('http://a/ + 50k dots + x takes under 10 ms (was 2.1 s)', () => {
    const text = `http://a/${'.'.repeat(50_000)}x`;
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t = performance.now();
      const out = redactPrintedUrls(text);
      best = Math.min(best, performance.now() - t);
      assert.equal(out, text);
    }
    assert.ok(best < 10, `50k dots took ${best.toFixed(1)} ms`);
  });

  it('a URL ending in 50k dots keeps them outside the body, under 10 ms', () => {
    const text = `http://a/?token=s${'.'.repeat(50_000)}`;
    const t = performance.now();
    const out = redactPrintedUrls(text);
    const ms = performance.now() - t;
    assert.equal(out, `http://a/?token=<redacted>${'.'.repeat(50_000)}`);
    assert.ok(ms < 10, `took ${ms.toFixed(1)} ms`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Nit: "clip() at format.ts:11 splits a surrogate pair at 100 chars. Make it surrogate-safe."
describe('nit: clip is surrogate-safe', () => {
  it('a pair straddling the cut is dropped whole', () => {
    const s = `${'a'.repeat(98)}😀${'b'.repeat(50)}`;
    const out = clip(s, 100);
    assert.ok(out.length <= 100);
    assert.ok(!LONE_SURROGATE.test(out), JSON.stringify(out.slice(-4)));
    assert.equal(out, `${'a'.repeat(98)}…`);
  });
  it('a pair that fits is kept', () => {
    const s = `${'a'.repeat(97)}😀${'b'.repeat(50)}`;
    assert.equal(clip(s, 100), `${'a'.repeat(97)}😀…`);
  });
  it('every cut of an emoji-only string is surrogate-safe', () => {
    const s = '😀'.repeat(300);
    for (let max = 1; max < 320; max++) {
      const out = clip(s, max);
      assert.ok(out.length <= max, `max ${max}`);
      assert.ok(!LONE_SURROGATE.test(out), `max ${max}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// D3: "titles are clipped to about 200 chars, surrogate-safe, ending in …" (the `→ navigated` line).
describe('D3 the → navigated line clips the title', () => {
  it('a 30,000-char title prints at most ~200 chars and ends in …', () => {
    const line = effect.navigated('https://a.test/', `${'T'.repeat(199)}😀${'x'.repeat(30_000)}`, 200);
    const m = /^→ navigated (\S+) ("(?:[^"\\]|\\.)*") \((\d+)\)$/.exec(line);
    assert.ok(m, line.slice(0, 300));
    const title = JSON.parse(m[2] as string) as string;
    assert.ok(title.length <= 200, `title ${title.length} chars`);
    assert.ok(title.endsWith('…'), title.slice(-5));
    assert.ok(!LONE_SURROGATE.test(title));
  });
  it('a short title is unchanged', () => {
    assert.equal(effect.navigated('https://a.test/', 'Home', 200), '→ navigated https://a.test/ "Home" (200)');
  });
});

// ---------------------------------------------------------------------------------------------------------
// D5: "A live-region announcement whose text equals the document title is not reported."
describe('D5 a live region that repeats the title is not an alert', () => {
  it('isTitleAnnouncement matches the title (whitespace-normalised) and nothing else', () => {
    const f = (effects as Record<string, unknown>).isTitleAnnouncement as ((t: string, title: string) => boolean) | undefined;
    assert.equal(typeof f, 'function', 'effects.ts exports isTitleAnnouncement');
    if (!f) return;
    assert.equal(f('r/programming', 'r/programming'), true);
    assert.equal(f('  r/programming\n', 'r/programming '), true);
    assert.equal(f('Saved', 'r/programming'), false);
    assert.equal(f('', ''), false, 'an empty title never hides an announcement');
    assert.equal(f('Post failed: r/programming', 'r/programming'), false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// D2: "A ref number this server process issued that is no longer live always gives the stale-ref error,
// using an O(1) rule ... A number that was never issued stays 'not a known ref'. Refs from a previous
// session after a takeover keep their 'previous session' error."
describe('D2 stale refs are never forgotten', () => {
  function issue(r: RefRegistry<string>, tab: string, doc: string, local: number): number {
    return r.issue({ tabId: tab, frame: 'f1', docId: doc, localId: local, role: 'button', name: `b${local}` });
  }

  it('after more than FORGOTTEN_CAP retirements the oldest ref is still stale, not unknown', () => {
    const r = new RefRegistry<string>();
    const first = issue(r, 't1', 'd0', 0);
    for (let i = 1; i < FORGOTTEN_CAP + 2000; i++) issue(r, 't1', `d${i}`, i);
    r.forgetFrame('t1', 'f1');
    assert.equal(r.size, 0);
    assert.equal(r.whyMissing(first).reason, 'stale', 'the first ref ever issued');
    assert.equal(r.whyMissing(1000).reason, 'stale', 'older than the FORGOTTEN_CAP most recent retirements');
    assert.equal(r.whyMissing(r.issued).reason, 'old-doc', 'the most recent keep their informative reason');
    assert.ok(r.forgottenSize <= 3 * FORGOTTEN_CAP, 'no growing memory');
  });

  it('a number never issued stays unknown (0, next, far above)', () => {
    const r = new RefRegistry<string>();
    for (let i = 0; i < 5; i++) issue(r, 't1', 'd', i);
    assert.equal(r.whyMissing(0).reason, 'unknown');
    assert.equal(r.whyMissing(r.issued + 1).reason, 'unknown');
    assert.equal(r.whyMissing(1e9).reason, 'unknown');
  });

  it('a live ref is not reported missing; previous-session refs keep their reason', () => {
    const r = new RefRegistry<string>();
    r.continueAbove(41);
    const mine = issue(r, 't1', 'd', 1);
    assert.equal(mine, 42);
    assert.ok(r.get(mine));
    assert.equal(r.whyMissing(7).reason, 'previous-session');
    assert.equal(r.whyMissing(41).reason, 'previous-session');
    assert.equal(r.whyMissing(43).reason, 'unknown');
  });
});
