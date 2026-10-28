import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RefRegistry } from '../../src/browser/refs.js';
import { activate, newClient, removeFromClient } from '../../src/browser/tabs.js';
import { mapPoint, parsePoint, parseRef } from '../../src/page/target.js';
import { normalizeUrl } from '../../src/tools/navigate.js';
import { matchOptions, optionsHint } from '../../src/tools/fill_form.js';
import { clipScale } from '../../src/tools/screenshot.js';

const el = (tabId: string, docId: string, localId: number, role = 'button', name = 'Save', unique = true) => ({
  tabId, frame: 'f', docId, localId, role, name, unique,
});

describe('refs (PLAN Refs)', () => {
  it('one counter across tabs and frames; the same element keeps its ref', () => {
    const r = new RefRegistry<string>();
    const a = r.issue(el('t1', 'docA', 1));
    const b = r.issue(el('t2', 'docB', 1));
    const c = r.issue(el('t1', 'docA2', 1));
    assert.deepEqual([a, b, c], [1, 2, 3]);
    assert.equal(r.issue(el('t1', 'docA', 1)), a, 'same element, same ref');
  });
  it('a ref locates its own tab and frame', () => {
    const r = new RefRegistry<string>();
    const n = r.issue(el('t3', 'd', 7));
    assert.equal(r.get(n)?.tabId, 't3');
    assert.equal(r.get(n)?.localId, 7);
  });
  it('refs are never reused after a tab closes, and the reason is reported', () => {
    const r = new RefRegistry<string>();
    const a = r.issue(el('t1', 'd1', 1));
    r.forgetTab('t1');
    assert.equal(r.get(a), undefined);
    assert.deepEqual(r.whyMissing(a), { reason: 'closed-tab', tabId: 't1' });
    const b = r.issue(el('t2', 'd2', 1));
    assert.ok(b > a);
    assert.deepEqual(r.whyMissing(999), { reason: 'unknown' });
  });
  it('re-issuing updates role/name/uniqueness', () => {
    const r = new RefRegistry<string>();
    const a = r.issue(el('t1', 'd', 1, 'button', 'Save', true));
    r.issue(el('t1', 'd', 1, 'button', 'Save', false));
    assert.equal(r.get(a)?.unique, false);
  });
});

describe('target strings (PLAN Targets)', () => {
  it('e<digits> is a ref', () => {
    assert.equal(parseRef('e12'), 12);
    assert.equal(parseRef('e'), null);
    assert.equal(parseRef('#e12'), null);
  });
  it('two numbers are a point', () => {
    assert.deepEqual(parsePoint('10,20'), { x: 10, y: 20 });
    assert.deepEqual(parsePoint(' 10.5 , 20 '), { x: 10.5, y: 20 });
    assert.equal(parsePoint('text=10,20'), null);
  });
});

describe('coordinate mapping (PLAN screenshot + x,y targets)', () => {
  it('no screenshot yet: CSS px of the viewport', () => {
    assert.deepEqual(mapPoint(undefined, 100, 50), { x: 100, y: 50, page: false });
  });
  it('downscaled viewport shot: image px / ratio', () => {
    // 1280x800 viewport at DPR 1 with max_edge 640 -> ratio 0.5
    assert.deepEqual(mapPoint({ ratio: 0.5, originX: 0, originY: 0, page: false }, 320, 200), { x: 640, y: 400, page: false });
  });
  it('DPR 2 without downscale: ratio 2 maps device px back to CSS px', () => {
    assert.deepEqual(mapPoint({ ratio: 2, originX: 0, originY: 0, page: false }, 200, 100), { x: 100, y: 50, page: false });
  });
  it('full-page shot: page coordinates', () => {
    assert.deepEqual(mapPoint({ ratio: 0.25, originX: 0, originY: 0, page: true }, 100, 1000), { x: 400, y: 4000, page: true });
  });
  it('element shot: offset by the element origin', () => {
    assert.deepEqual(mapPoint({ ratio: 1, originX: 30, originY: 900, page: true }, 5, 5), { x: 35, y: 905, page: true });
  });
  it('clip scale keeps the long output edge within max_edge and never upscales', () => {
    for (const [w, h, dpr, max] of [[1280, 800, 1, 1280], [1280, 800, 1, 640], [1280, 800, 2, 1280], [1280, 20000, 1, 1280], [300, 200, 1, 1280]] as const) {
      const s = clipScale(w, h, dpr, max);
      assert.ok(s <= 1);
      assert.ok(Math.round(Math.max(w, h) * s * dpr) <= max || s === 1, `${w}x${h}@${dpr} max ${max} -> ${s}`);
      if (Math.max(w, h) * dpr <= max) assert.equal(s, 1);
    }
  });
});

describe('client tab bookkeeping (PLAN tabs close)', () => {
  it('closing the active tab activates the previously active remaining tab', () => {
    const c = newClient('local');
    for (const t of ['t1', 't2', 't3']) c.owned.add(t);
    activate(c, 't1');
    activate(c, 't3');
    activate(c, 't2');
    removeFromClient(c, 't2');
    assert.equal(c.active, 't3');
    removeFromClient(c, 't3');
    assert.equal(c.active, 't1');
    removeFromClient(c, 't1');
    assert.equal(c.active, undefined);
  });
});

describe('navigate url normalisation (PLAN: scheme-less gets https://; answer 13: local hosts get http://)', () => {
  it('adds https:// only when there is no scheme', () => {
    assert.equal(normalizeUrl('example.com/a'), 'https://example.com/a');
    assert.equal(normalizeUrl('localhost:3000/x'), 'http://localhost:3000/x'); // contract answer 13
    assert.equal(normalizeUrl('127.0.0.1'), 'http://127.0.0.1');
    assert.equal(normalizeUrl('[::1]:8080/a'), 'http://[::1]:8080/a');
    assert.equal(normalizeUrl('localhost.example.com'), 'https://localhost.example.com');
    assert.equal(normalizeUrl('http://a.b/'), 'http://a.b/');
    assert.equal(normalizeUrl('data:text/html,hi'), 'data:text/html,hi');
    assert.equal(normalizeUrl('about:blank'), 'about:blank');
  });
});

describe('fill_form select matching (PLAN: option by value or visible label)', () => {
  const opts = [
    { value: 'at', label: 'Austria' },
    { value: 'be', label: 'Belgium' },
  ];
  it('by value, by label, case-insensitive label', () => {
    assert.deepEqual(matchOptions(opts, ['be']).values, ['be']);
    assert.deepEqual(matchOptions(opts, ['Austria']).values, ['at']);
    assert.deepEqual(matchOptions(opts, ['belgium']).values, ['be']);
  });
  it('a missing option is named', () => {
    assert.equal(matchOptions(opts, ['Narnia']).missing, 'Narnia');
  });
  it('options hint lists 10 then "… +N"', () => {
    const labels = Array.from({ length: 250 }, (_, i) => `L${i}`);
    const h = optionsHint(labels);
    assert.match(h, /^"L0", "L1", .*"L9", … \+240$/);
  });
});
