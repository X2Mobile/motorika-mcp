// Acceptance group C: snapshot, read, find, screenshot.
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  descendants,
  findAll,
  parseElementLine,
  parseFindHits,
  parseSnapshot,
  refOf,
  type Snapshot,
} from '../support/grammar.ts';
import { decodePng, diffPixels, imageSize } from '../support/images.ts';
import { ARTICLE, COVERAGE, PASSWORD_LITERAL } from '../support/spec.ts';
import { until, useFileServer, type Counts } from '../support/suite.ts';

const ctx = useFileServer('C');

async function go(path: string): Promise<void> {
  await ctx.s.ok('navigate', { url: ctx.fx.url(path), snapshot: false });
}

/** Snapshots until `pred` holds (frames load asynchronously), at most `ms`. */
async function snapshotUntil(pred: (s: Snapshot) => boolean, args: Record<string, unknown> = {}, ms = 5000): Promise<Snapshot> {
  let last: Snapshot | null = null;
  await until(async () => {
    last = await ctx.s.snapshot(args);
    return pred(last);
  }, ms, 250);
  return last!;
}

const has = (s: Snapshot, role: string, name: string) => findAll(s, { role, name }).length > 0;

describe('C snapshot, read, find, screenshot', () => {
  test('C1 every snapshot line parses, refs are unique, the header is present (interactive and full)', async () => {
    for (const path of [COVERAGE.path, '/forms.html', ARTICLE.path, '/find.html']) {
      await go(path);
      for (const mode of ['interactive', 'full']) {
        const s = await ctx.s.snapshot({ mode }); // helper asserts zero unparseable lines
        assert.match(s.header.tab, /^t\d+$/);
        assert.equal(s.header.url, ctx.fx.url(path));
        assert.ok(s.elements.length > 0);
        assert.equal(new Set(s.elements.map((e) => e.ref)).size, s.elements.length, 'refs unique');
      }
    }
    // The navigate result's attached snapshot obeys the grammar too.
    const r = await ctx.s.ok('navigate', { url: ctx.fx.url('/nav-a.html') });
    assert.deepEqual(parseSnapshot(r.text).errors, []);
  });

  test('C2 the coverage fixture: right roles, names and states; hidden kinds absent', async () => {
    await go(COVERAGE.path);
    const s = await snapshotUntil((x) => has(x, 'button', 'Cross frame button') && has(x, 'button', 'Same frame button'));
    for (const item of COVERAGE.present) {
      const hits = item.name === '' ? findAll(s, { role: item.role }) : findAll(s, { role: item.role, name: item.name });
      assert.ok(hits.length >= 1, `${item.role} "${item.name}" missing`);
      const el = hits[0]!;
      for (const [k, v] of Object.entries(item.attrs ?? {})) {
        assert.deepEqual((el.attrs as Record<string, unknown>)[k], v, `${item.role} "${item.name}" ${k}: ${el.raw}`);
      }
      if (item.frame) {
        const frame = findAll(s, { role: 'iframe', name: item.frame })[0];
        assert.ok(frame, `iframe "${item.frame}"`);
        assert.ok(descendants(s, frame).includes(el), `${item.name} is inlined under iframe "${item.frame}"`);
      }
      if (item.role === 'iframe') assert.match(el.attrs.frame ?? '', /^f\d+$/, `${el.raw} has frame=fN`);
    }
    assert.equal(findAll(s, { name: 'Password input' })[0]!.attrs.value, undefined, 'empty password has no value attr');
    for (const t of COVERAGE.typedAnyRole) {
      const el = findAll(s, { name: t.name })[0];
      assert.ok(el, `${t.name} present`);
      assert.equal(el.attrs.type, t.type, el.raw);
    }
    const dialog = findAll(s, { role: 'dialog', name: 'Info dialog' })[0]!;
    assert.ok(descendants(s, dialog).some((l) => l.kind === 'element' && l.name === 'Dialog OK'));
    const full = await ctx.s.snapshot({ mode: 'full' });
    for (const snap of [s, full]) {
      const text = snap.lines.map((l) => l.raw).join('\n');
      for (const name of COVERAGE.absent) assert.ok(!text.includes(name), `"${name}" must be absent`);
      for (const t of COVERAGE.absentText) assert.ok(!text.includes(t), `"${t}" must be absent`);
    }
  });

  test('C3 an element keeps its ref across snapshots; after navigation old refs are rejected', async () => {
    await go('/nav-a.html');
    const a = await ctx.s.snapshot();
    const b = await ctx.s.snapshot();
    assert.deepEqual(
      b.elements.map((e) => [e.role, e.name, e.ref]),
      a.elements.map((e) => [e.role, e.name, e.ref]),
    );
    const old = refOf(a, 'button', 'Button A');
    await go('/nav-b.html');
    const c = await ctx.s.snapshot();
    assert.ok(!c.elements.some((e) => a.elements.some((x) => x.ref === e.ref)), 'no ref reused in the new document');
    await ctx.s.err('click', { target: old });
  });

  test('C4 stale refs: a unique re-rendered Save re-resolves; with two Saves the stale error, counter unchanged', async () => {
    await go('/stale.html');
    let s = await ctx.s.snapshot();
    const save = refOf(s, 'button', 'Save');
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Re-render single') });
    const r = await ctx.s.ok('click', { target: save });
    const m = /re-resolved (e\d+) -> (e\d+) button "Save"/.exec(r.text);
    assert.ok(m, `re-resolved note:\n${r.text}`);
    assert.equal(m[1], save);
    assert.notEqual(m[2], save);
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts'), { save: 1 });

    await go('/stale.html');
    s = await ctx.s.snapshot();
    const save2 = refOf(s, 'button', 'Save');
    await ctx.s.ok('click', { target: refOf(s, 'button', 'Re-render double') });
    const e = await ctx.s.err('click', { target: save2 });
    assert.match(e.text, new RegExp(`${save2} is stale`));
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts'), {});
  });

  // CONTRACT-QUESTION: does a page fetched with offset>0 repeat the header line, and does the header/footer
  // count toward max_chars? Assumed: the whole result text is <= max_chars; element lines are collected
  // line by line so either header choice works.
  test('C5 a 5,000-element snapshot fits max_chars with a footer; offset paging has no gap or overlap', async () => {
    await go('/big-5000.html');
    const max = 10_000;
    const seen: number[] = [];
    let offset = 0;
    for (let page = 0; page < 60; page++) {
      const r = await ctx.s.ok('snapshot', page === 0 ? { max_chars: max } : { max_chars: max, offset });
      const lines = r.text.split('\n');
      // PLAN: "cut at a line boundary, then add the footer line" -> the body before the footer is <= max_chars.
      const body = lines.filter((l) => !l.startsWith('… ')).join('\n');
      assert.ok(body.length <= max, `page ${page}: ${body.length} chars before the footer > ${max}`);
      for (const l of lines) {
        const { el } = parseElementLine(l);
        const m = el && el.role === 'button' ? /^Item (\d+)$/.exec(el.name ?? '') : null;
        if (m) seen.push(Number(m[1]));
      }
      const footer = lines.map((l) => /^… (\d+) more lines \(offset=(\d+) to continue; or narrow with scope, find or viewport_only\)$/.exec(l)).find(Boolean);
      if (page === 0) assert.ok(footer, 'first page has the footer');
      if (!footer) break;
      assert.ok(Number(footer[2]) > offset, 'offset advances');
      offset = Number(footer[2]);
    }
    assert.equal(seen.length, 5000, 'every item exactly once');
    assert.deepEqual(seen, Array.from({ length: 5000 }, (_, i) => i + 1), 'in order, no gap, no overlap');
  });

  test('C6 viewport_only returns only elements that intersect the viewport', async () => {
    await go('/viewport.html');
    const vh = await ctx.s.state<number>('innerHeight');
    // Spec: Row i spans page y = i*100+20 .. i*100+60 and the page is at scrollY 0.
    const expected = Array.from({ length: 40 }, (_, i) => i).filter((i) => i * 100 + 20 < vh).map((i) => `Row ${i}`);
    const s = await ctx.s.snapshot({ viewport_only: true });
    assert.deepEqual(findAll(s, { role: 'button' }).map((e) => e.name), expected);
  });

  test('C7 a filled password shows value=<redacted>; the literal never appears (helper scans every result)', async () => {
    await go('/forms.html');
    let s = await ctx.s.snapshot();
    const pw = refOf(s, 'textbox', 'Password');
    const r = await ctx.s.ok('fill_form', { fields: [{ target: pw, value: PASSWORD_LITERAL }] });
    assert.match(r.text, new RegExp(`^ok ${pw} textbox "Password"`, 'm'));
    s = await ctx.s.snapshot();
    const line = s.elements.find((e) => e.ref === pw)!;
    assert.equal(line.attrs.password, true);
    assert.equal(line.attrs.value, '<redacted>');
    await ctx.s.ok('type', { target: pw, text: PASSWORD_LITERAL });
    await ctx.s.ok('find', { query: 'password' });
    await ctx.s.ok('snapshot', { mode: 'full' });
    await ctx.s.ok('read', {});
  });

  // CONTRACT-QUESTION: read's paging signal is not specified (no footer form). Assumed: `offset` is a char
  // offset into the markdown and each result is <= max_chars; pages are requested at 0, max, 2*max, ...
  test('C8 read returns title, paragraphs and markdown links, drops boilerplate, pages with offset', async () => {
    await go(ARTICLE.path);
    const full = await ctx.s.ok('read', {});
    assert.ok(full.text.includes(ARTICLE.title));
    assert.ok(full.text.includes(`[${ARTICLE.link.text}](${ARTICLE.link.href})`), 'link as [text](url)');
    assert.ok(full.text.includes(ARTICLE.paragraphMarkers[0]!));
    const max = 3000;
    const pages: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await ctx.s.ok('read', { max_chars: max, offset: i * max });
      const content = r.text.split('\n').filter((l) => !/^\[t\d+\]/.test(l) && !l.startsWith('… ')).join('\n');
      assert.ok(content.length <= max, `page ${i} content is ${content.length} chars`);
      pages.push(r.text);
      if (!ARTICLE.paragraphMarkers.some((m) => r.text.includes(m)) && i > 0) break;
    }
    assert.ok(!ARTICLE.paragraphMarkers.every((m) => pages[0]!.includes(m)), 'the first page does not hold everything');
    const body = pages.map((p) => p.split('\n').filter((l) => !/^\[t\d+\]/.test(l) && !l.startsWith('…')).join('\n')).join('');
    for (const m of ARTICLE.paragraphMarkers) assert.ok(pages.some((p) => p.includes(m)) || body.includes(m), `${m} reachable by paging`);
    for (const p of [full.text, ...pages]) for (const b of ARTICLE.boilerplate) assert.ok(!p.includes(b), `${b} must be excluded`);
  });

  test('C9 find "save" returns the matching buttons with refs, including inside iframes; exact match first', async () => {
    await go('/find.html');
    await snapshotUntil((x) => has(x, 'button', 'Save remote'));
    const r = await ctx.s.ok('find', { query: 'save' });
    const hits = parseFindHits(r.text);
    const names = hits.map((h) => h.el.name);
    for (const n of ['Save', 'Autosave settings', 'Save draft', 'Save remote']) assert.ok(names.includes(n), `${n} found:\n${r.text}`);
    assert.ok(!names.includes('Cancel'));
    assert.equal(hits[0]!.el.name, 'Save', 'exact match first');
    for (const h of hits) assert.match(h.el.ref, /^e\d+$/);
    // CONTRACT-QUESTION: the frame documents have no heading/landmark of their own; whether the stitched tree
    // supplies one for hits inside frames is unspecified. Context is required for main-frame hits only.
    for (const h of hits.filter((x) => x.el.name === 'Save' || x.el.name === 'Autosave settings')) {
      assert.ok(h.context !== null, `"  in <context>" for ${h.el.raw}`);
    }
    await ctx.s.ok('click', { target: hits.find((h) => h.el.name === 'Save remote')!.el.ref });
  });

  test('C10 screenshot: jpeg viewport by default, png on request, max_edge, full_page, save, annotate leaves no DOM nodes', async () => {
    await go('/coords.html');
    const vw = await ctx.s.state<[number, number]>('[innerWidth, innerHeight]');
    const header = (t: string) => /^\[t\d+\] screenshot (\d+)x(\d+) scale=([\d.]+); x,y targets use this image's pixels/m.exec(t);

    const d = await ctx.s.ok('screenshot', {});
    assert.equal(d.images.length, 1);
    assert.equal(d.images[0]!.mimeType, 'image/jpeg');
    const ds = imageSize(Buffer.from(d.images[0]!.data, 'base64'), 'image/jpeg');
    assert.equal(Math.max(ds.width, ds.height), Math.min(1280, Math.max(...vw)), 'default max_edge 1280');
    assert.ok(Math.abs(ds.width / ds.height - vw[0] / vw[1]) < 0.02, 'viewport aspect');
    const h = header(d.text);
    assert.ok(h, d.text);
    assert.deepEqual([Number(h[1]), Number(h[2])], [ds.width, ds.height]);

    const p = await ctx.s.ok('screenshot', { format: 'png' });
    assert.equal(p.images[0]!.mimeType, 'image/png');

    const small = await ctx.s.ok('screenshot', { format: 'png', max_edge: 400 });
    const ss = imageSize(Buffer.from(small.images[0]!.data, 'base64'), 'image/png');
    assert.equal(Math.max(ss.width, ss.height), 400);

    const fp = await ctx.s.ok('screenshot', { format: 'png', full_page: true });
    const fs = imageSize(Buffer.from(fp.images[0]!.data, 'base64'), 'image/png');
    const page = await ctx.s.state<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.scrollHeight]');
    assert.ok(Math.abs(fs.height / fs.width - page[1] / page[0]) < 0.03, `full page aspect ${fs.width}x${fs.height} vs ${page.join('x')}`);
    assert.equal(Math.max(fs.width, fs.height), 1280);

    const saved = await ctx.s.ok('screenshot', { save: true });
    const path = /(\/\S+\.(?:jpe?g|png))/.exec(saved.text)?.[1];
    assert.ok(path && existsSync(path), `saved path printed:\n${saved.text}`);
    assert.ok(realpathSync(path).startsWith(realpathSync(join(ctx.s.outputDir, 'screenshots'))));

    const before = await ctx.s.state<number>('document.querySelectorAll("*").length');
    const plain = await ctx.s.ok('screenshot', { format: 'png' });
    const ann = await ctx.s.ok('screenshot', { format: 'png', annotate: true });
    const a = Buffer.from(ann.images[0]!.data, 'base64');
    const b = Buffer.from(plain.images[0]!.data, 'base64');
    decodePng(a);
    assert.ok(diffPixels(a, b) > 50, 'labels are visible in the annotated image');
    assert.equal(await ctx.s.state<number>('document.querySelectorAll("*").length'), before, 'no overlay nodes remain');
  });

  test('C11 "x,y" targets map from a downscaled viewport screenshot and from a full_page one', async () => {
    await go('/coords.html');
    const vw = await ctx.s.state<number>('innerWidth');
    const shot = await ctx.s.ok('screenshot', { format: 'png', max_edge: 640 });
    const size = imageSize(Buffer.from(shot.images[0]!.data, 'base64'), 'image/png');
    assert.equal(size.width, 640, 'long edge 640 for a 1280-wide viewport');
    const scale = size.width / vw;
    // Spec: "Coord target" at CSS 300,200 size 160x60 (page at scrollY 0).
    const x = Math.round((300 + 80) * scale);
    const y = Math.round((200 + 30) * scale);
    await ctx.s.ok('click', { target: `${x},${y}` });
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts'), { coord: 1 });

    const full = await ctx.s.ok('screenshot', { format: 'png', full_page: true, max_edge: 640 });
    const fsz = imageSize(Buffer.from(full.images[0]!.data, 'base64'), 'image/png');
    const pageH = await ctx.s.state<number>('document.documentElement.scrollHeight');
    const fscale = fsz.height / pageH;
    // Spec: "Below fold target" at page 400,2400 size 240x120.
    await ctx.s.ok('click', { target: `${Math.round((400 + 120) * fscale)},${Math.round((2400 + 60) * fscale)}` });
    assert.deepEqual(await ctx.s.state<Counts>('window.__counts'), { coord: 1, below: 1 });
  });

  test('C12 under script-src none + Trusted Types: snapshot, click, type, read and screenshot annotate work', async () => {
    ctx.fx.reset();
    await go('/csp/csp-page.html');
    const s = await ctx.s.snapshot();
    assert.equal(s.header.title, 'CSP fixture', 'the inline script did not run');
    assert.ok(has(s, 'heading', 'Strict CSP page') && has(s, 'link', 'CSP link'));
    await ctx.s.ok('type', { target: refOf(s, 'textbox', 'CSP name'), text: 'csp typed' });
    const r = await ctx.s.ok('read', {});
    assert.ok(r.text.includes('CSP-PARAGRAPH'));
    const before = await ctx.s.state<number>('document.querySelectorAll("*").length');
    const ann = await ctx.s.ok('screenshot', { annotate: true });
    assert.equal(ann.images.length, 1);
    assert.equal(await ctx.s.state<number>('document.querySelectorAll("*").length'), before);
    await ctx.s.ok('click', { target: refOf(s, 'button', 'CSP submit') });
    const rec = await until(() => ctx.fx.submissions('csp')[0]);
    assert.deepEqual(rec?.fields, [['csp_name', 'csp typed']]);
  });
});
