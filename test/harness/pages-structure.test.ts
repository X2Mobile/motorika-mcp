// Harness: structural fixtures (C2 coverage, C5 big pages, C6 rows, C8 article, C9 find, C11 coords,
// C12 CSP, OOPIF) match their specs when inspected with plain playwright-core.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Frame, Page } from 'playwright-core';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { launchPw, type PwBrowser } from '../support/pw.ts';
import { ARTICLE, BIG_PAGES, COVERAGE } from '../support/spec.ts';

let fx: FixtureServer;
let pw: PwBrowser;
let page: Page;

before(async () => {
  fx = await startFixtureServer();
  pw = await launchPw();
});
after(async () => {
  await pw?.close();
  await fx?.close();
});
beforeEach(async () => {
  if (page && !page.isClosed()) await page.close();
  page = await pw.page();
  fx.reset();
});

/**
 * Hidden per PLAN.md: not rendered, aria-hidden subtree, inert subtree, or zero size.
 * CONTRACT-QUESTION: PLAN says "checkVisibility() is false", but a bare checkVisibility() is TRUE for
 * visibility:hidden (proven by this harness), while C2 requires visibility:hidden to be absent. The
 * predicate therefore uses checkVisibility({ visibilityProperty: true }).
 */
const HIDDEN_PREDICATE = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return (
    !el.checkVisibility({ visibilityProperty: true }) ||
    el.closest('[aria-hidden="true"]') !== null ||
    el.closest('[inert]') !== null ||
    r.width === 0 ||
    r.height === 0
  );
};

describe('C2 coverage fixture', () => {
  test('every present item exists with that role and name (Playwright accname) and is visible', async () => {
    await page.goto(fx.url(COVERAGE.path));
    for (const item of COVERAGE.present) {
      const scope: Page | ReturnType<Page['frameLocator']> = item.frame ? page.frameLocator(`iframe[title="${item.frame}"]`) : page;
      let loc;
      if (item.role === 'iframe') loc = page.locator(`iframe[title="${item.name}"]`);
      else if (item.role === 'file') loc = page.getByLabel(item.name, { exact: true });
      else if (item.role === 'clickable') loc = page.getByText(item.name, { exact: true });
      // A plain contenteditable has no ARIA role (Playwright finds no textbox): see the CONTRACT-QUESTION in spec.ts.
      else if (item.name === 'Editable area') loc = page.locator('[contenteditable="true"][aria-label="Editable area"]:not([role])');
      // ARIA gives role=alert no name from content; PLAN's snapshot uses "their text as the name".
      else if (item.role === 'alert') loc = page.getByRole('alert').filter({ hasText: item.name });
      else if (item.name === '') loc = scope.getByRole(item.role as 'main', {});
      else loc = scope.getByRole(item.role as 'button', { name: item.name, exact: true });
      assert.equal(await loc.count(), 1, `${item.role} "${item.name}"`);
      const box = await loc.boundingBox();
      if (item.role !== 'checkbox' && item.role !== 'radio') {
        assert.ok(box && box.width >= 2 && box.height >= 2, `${item.role} "${item.name}" is rendered`);
      }
    }
    assert.equal(await page.getByLabel('File input', { exact: true }).getAttribute('type'), 'file');
    assert.equal(await page.getByText('Clickable div', { exact: true }).evaluate((el) => getComputedStyle(el).cursor), 'pointer');
  });

  test('states and values in the spec match the DOM', async () => {
    await page.goto(fx.url(COVERAGE.path));
    for (const item of COVERAGE.present) {
      if (!item.attrs || item.frame) continue;
      const loc = page.getByRole(item.role as 'button', { name: item.name, exact: true });
      const a = item.attrs;
      if (a.checked !== undefined) assert.equal(String(await loc.isChecked()), a.checked, item.name);
      if (a.disabled) assert.equal(await loc.isDisabled(), true, item.name);
      if (a.readonly) assert.equal(await loc.evaluate((el) => (el as HTMLInputElement).readOnly), true);
      if (a.required) assert.equal(await loc.evaluate((el) => (el as HTMLInputElement).required), true);
      if (a.type) assert.equal(await loc.getAttribute('type'), a.type, item.name);
      if (a.level) assert.equal(await loc.evaluate((el) => el.tagName), `H${String(a.level)}`);
      if (a.href) assert.equal(await loc.getAttribute('href'), a.href);
      if (a.pressed) assert.equal(await loc.getAttribute('aria-pressed'), a.pressed);
      if (a.expanded) assert.equal(await loc.getAttribute('aria-expanded'), a.expanded);
      if (a.options) {
        assert.deepEqual(await loc.locator('option').allTextContents(), a.options);
        assert.equal(await loc.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent), a.value);
      } else if (a.value !== undefined) {
        assert.equal(await loc.inputValue(), a.value, item.name);
      }
    }
    for (const t of COVERAGE.typedAnyRole) {
      assert.equal(await page.getByLabel(t.name, { exact: true }).getAttribute('type'), t.type);
    }
  });

  test('custom checkbox/radio: the input is visually hidden but focusable, its label visible', async () => {
    await page.goto(fx.url(COVERAGE.path));
    for (const id of ['custom-cb', 'custom-rd']) {
      const s = await page.locator(`#${id}`).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const label = document.querySelector(`label[for="${el.id}"]`)!.getBoundingClientRect();
        return { w: r.width, tab: (el as HTMLInputElement).tabIndex, labelW: label.width };
      });
      assert.ok(s.w <= 1 && s.tab === 0 && s.labelW > 20, JSON.stringify(s));
    }
  });

  test('every absent item exists in the DOM and is hidden by one of the PLAN rules', async () => {
    await page.goto(fx.url(COVERAGE.path));
    for (const name of COVERAGE.absent) {
      const hidden = await page.evaluate(
        ([n, pred]) => {
          const el = [...document.querySelectorAll('button')].find((b) => b.textContent === n);
          if (!el) return 'missing';
          return (new Function(`return (${pred})`)() as (e: Element) => boolean)(el);
        },
        [name, HIDDEN_PREDICATE.toString()] as const,
      );
      assert.equal(hidden, true, name);
    }
    assert.equal(await page.getByRole('button', { name: 'More details' }).count(), 0, 'summary is not a button');
    const bare = await page.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Hidden visibility')!.checkVisibility(),
    );
    assert.equal(bare, true, 'a bare checkVisibility() does not catch visibility:hidden (why the predicate passes visibilityProperty)');
    assert.equal(await page.getByRole('textbox', { name: 'Editable area' }).count(), 0, 'no implicit textbox role for plain contenteditable');
  });

  test('the cross-origin iframe is a real OOPIF on another site', async () => {
    await page.goto(fx.url(COVERAGE.path));
    await page.frameLocator('iframe[title="Cross frame"]').getByRole('button', { name: 'Cross frame button' }).waitFor();
    const cross = page.frames().find((f: Frame) => f.url().startsWith(fx.originB));
    assert.ok(cross, 'frame on origin B');
    assert.equal(await cross.evaluate(() => location.origin), fx.originB);
    assert.equal(await page.evaluate(() => (document.querySelector('iframe[title="Cross frame"]') as HTMLIFrameElement).contentDocument), null);
    assert.notEqual(await page.evaluate(() => (document.querySelector('iframe[title="Same frame"]') as HTMLIFrameElement).contentDocument), null);
    const cdp = await page.context().newCDPSession(page);
    try {
      const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: { type: string; url: string }[] };
      assert.ok(
        targetInfos.some((t) => t.type === 'iframe' && t.url.startsWith(`${fx.originB}/frame-cross.html`)),
        'Chrome runs the cross-origin frame as its own target (OOPIF)',
      );
      assert.ok(!targetInfos.some((t) => t.type === 'iframe' && t.url.includes('/frame-same.html')), 'same-origin frame is in-process');
    } finally {
      await cdp.detach();
    }
  });
});

describe('C12 CSP fixture', () => {
  test('inline script is blocked, Trusted Types enforced, and the static form still submits', async () => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    await page.goto(fx.url('/csp/csp-page.html'));
    assert.equal(await page.title(), 'CSP fixture');
    assert.equal(await page.evaluate(() => (window as unknown as { __inlineRan?: boolean }).__inlineRan), undefined);
    assert.ok(violations.length >= 1, 'Chrome reported the CSP violation');
    const tt = await page.evaluate(() => {
      try {
        document.body.insertAdjacentHTML('beforeend', '<b>x</b>');
        return 'allowed';
      } catch (e) {
        return (e as Error).name;
      }
    });
    assert.equal(tt, 'TypeError', 'require-trusted-types-for blocks string HTML sinks');
    await page.getByLabel('CSP name').fill('no-script');
    await page.getByRole('button', { name: 'CSP submit' }).click();
    await page.waitForURL(/\/submit\?form=csp/);
    assert.deepEqual(fx.submissions('csp')[0]!.fields, [['csp_name', 'no-script']]);
  });
});

describe('C5/F big pages', () => {
  test('the 1,000- and 5,000-element pages have exactly those counts', async () => {
    for (const [path, n] of Object.entries(BIG_PAGES)) {
      await page.goto(fx.url(path));
      assert.equal(await page.locator('button.item').count(), n);
      assert.equal(await page.locator('button.item').last().textContent(), `Item ${n}`);
    }
  });
});

describe('C6 viewport rows', () => {
  test('rows 0..7 intersect the 1280x800 viewport and none straddles its edge', async () => {
    await page.goto(fx.url('/viewport.html'));
    const vis = await page.evaluate(() =>
      [...document.querySelectorAll('button.row')].map((b) => {
        const r = b.getBoundingClientRect();
        return [b.textContent, r.top < innerHeight && r.bottom > 0, r.top < innerHeight && r.bottom > innerHeight];
      }),
    );
    assert.deepEqual(vis.filter((v) => v[1]).map((v) => v[0]), ['Row 0', 'Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5', 'Row 6', 'Row 7']);
    assert.equal(vis.filter((v) => v[2]).length, 0);
  });
});

describe('C8 article fixture', () => {
  test('content and boilerplate are where the spec says', async () => {
    await page.goto(fx.url(ARTICLE.path));
    assert.equal(await page.title(), ARTICLE.title);
    const article = (await page.locator('article').textContent()) ?? '';
    for (const m of ARTICLE.paragraphMarkers) assert.ok(article.includes(m), m);
    assert.equal(await page.getByRole('link', { name: ARTICLE.link.text }).getAttribute('href'), ARTICLE.link.href);
    for (const b of ARTICLE.boilerplate) {
      assert.ok(!article.includes(b), `${b} is not in the article`);
      const inside = await page.evaluate((s) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const hits: string[] = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.textContent?.includes(s)) hits.push(n.parentElement!.closest('nav, footer, aside, #cookie-banner')?.tagName ?? 'NONE');
        }
        return hits;
      }, b);
      assert.ok(inside.length > 0 && !inside.includes('NONE'), `${b} lives only in nav/footer/aside/cookie banner: ${inside.join(',')}`);
    }
    assert.ok(article.length > 6000, 'long enough to page');
  });
});

describe('C9 find fixture', () => {
  test('four "save" buttons across main, same-origin and cross-origin frames', async () => {
    await page.goto(fx.url('/find.html'));
    await page.frameLocator('iframe[title="Cross frame"]').getByRole('button', { name: 'Save remote' }).waitFor();
    const names: string[] = [];
    for (const f of page.frames()) {
      for (const t of await f.getByRole('button').allTextContents()) if (/save/i.test(t)) names.push(t);
    }
    assert.deepEqual(names.sort(), ['Autosave settings', 'Save', 'Save draft', 'Save remote']);
  });
});

describe('C11 coords fixture', () => {
  test('buttons sit at their spec positions and a mouse click at the center hits them', async () => {
    await page.goto(fx.url('/coords.html'));
    const r = await page.evaluate(() =>
      ['coord', 'below'].map((id) => {
        const b = document.getElementById(id)!.getBoundingClientRect();
        return [b.left + scrollX, b.top + scrollY, b.width, b.height];
      }),
    );
    assert.deepEqual(r, [[300, 200, 160, 60], [400, 2400, 240, 120]]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 3000);
    await page.mouse.click(380, 230);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __counts: object }).__counts), { coord: 1 });
    const png = await page.screenshot({ fullPage: true });
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 3000]);
    await sleep(0);
  });
});
