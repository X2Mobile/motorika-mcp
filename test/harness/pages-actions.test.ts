// Harness: every action fixture's oracle works when driven by plain playwright-core, so it may judge
// the server. Expectations come from the fixture specs (test/support/spec.ts and the page comments).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { launchPw, type PwBrowser } from '../support/pw.ts';
import { downloadBytes, FULL_FORM, sha256, UPLOAD_BYTES, UPLOAD_FILE, UPLOAD_NAME } from '../support/spec.ts';

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

async function until<T>(fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > deadline) return v;
    await sleep(50);
  }
}

const counts = (p: Page) => p.evaluate(() => (window as unknown as { __counts: Record<string, number> }).__counts);
const events = (p: Page) => p.evaluate(() => (window as unknown as { __events: string[] }).__events);

describe('D3 forms fixture', () => {
  test('filling with plain Playwright records exactly the expected payload', async () => {
    const i = FULL_FORM.inputs;
    await page.goto(fx.url(FULL_FORM.path));
    await page.getByLabel(i.fullName.label, { exact: true }).fill(i.fullName.value);
    await page.getByLabel(i.email.label, { exact: true }).fill(i.email.value);
    await page.getByLabel(i.password.label, { exact: true }).fill(i.password.value);
    await page.getByLabel(i.comments.label, { exact: true }).fill(i.comments.value);
    await page.getByLabel(i.country.label, { exact: true }).selectOption({ label: i.country.valueLabel });
    await page.getByLabel(i.toppings.label, { exact: true }).selectOption(i.toppings.valueLabels.map((label) => ({ label })));
    await page.getByLabel(i.subscribe.label, { exact: true }).check();
    await page.getByRole('radio', { name: i.plan.optionLabel, exact: true }).check();
    await page.getByLabel(i.startDate.label, { exact: true }).fill(i.startDate.value);
    await page.getByLabel(i.volume.label, { exact: true }).fill(i.volume.value);
    await page.getByLabel(i.color.label, { exact: true }).fill(i.color.value);
    await page.getByLabel(i.attachment.label, { exact: true }).setInputFiles(UPLOAD_FILE);
    await page.getByRole('textbox', { name: i.bio.label, exact: true }).fill(i.bio.value);
    await page.getByRole('button', { name: FULL_FORM.submitButton }).click();
    await page.waitForURL(/\/submit\?form=full/);
    const [rec] = fx.submissions('full');
    assert.ok(rec, 'recorded');
    assert.deepEqual(rec.fields, FULL_FORM.expectedFields);
    assert.equal(rec.files.length, 1);
    assert.equal(rec.files[0]!.field, FULL_FORM.expectedFile.field);
    assert.equal(rec.files[0]!.name, FULL_FORM.expectedFile.name);
    assert.equal(rec.files[0]!.sha256, sha256(UPLOAD_BYTES()));
    assert.ok(!(await page.content()).includes(i.password.value), 'the receipt page does not echo the password');
  });

  test('the radio group is a fieldset named "Plan" and the bio mirror only fills on input/submit', async () => {
    await page.goto(fx.url(FULL_FORM.path));
    assert.equal(await page.getByRole('group', { name: 'Plan' }).count(), 1);
    assert.equal(await page.locator('#bio-hidden').inputValue(), '');
  });
});

describe('D8 upload fixture', () => {
  test('file input and file-chooser button both POST name + bytes', async () => {
    await page.goto(fx.url('/upload.html'));
    await page.getByLabel('Upload file').setInputFiles(UPLOAD_FILE);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Choose file' }).click()]);
    await chooser.setFiles(UPLOAD_FILE);
    await until(() => fx.submissions('direct').length + fx.submissions('chooser').length === 2);
    for (const form of ['direct', 'chooser']) {
      const f = fx.submissions(form)[0]?.files[0];
      assert.equal(f?.name, UPLOAD_NAME, form);
      assert.equal(f?.sha256, sha256(readFileSync(UPLOAD_FILE)), form);
    }
  });
});

describe('D2 type fixture', () => {
  test('autocomplete shows suggestions only for per-key typing', async () => {
    await page.goto(fx.url('/type.html'));
    await page.getByLabel('City', { exact: true }).fill('Ber');
    assert.equal(await page.locator('#suggestions li').count(), 0, 'fill (no keydowns) shows nothing');
    await page.reload();
    await page.getByLabel('City', { exact: true }).pressSequentially('Ber');
    assert.deepEqual(await page.locator('#suggestions li').allTextContents(), ['Berlin', 'Bern', 'Bergen']);
  });

  test('controlled input keeps state only from input events', async () => {
    await page.goto(fx.url('/type.html'));
    await page.getByLabel('Controlled').fill('typed');
    assert.equal(await page.evaluate(() => (window as unknown as { __controlled: string }).__controlled), 'typed');
    await page.evaluate(() => {
      const el = document.getElementById('controlled') as HTMLInputElement;
      el.value = 'sneaky';
      el.dispatchEvent(new Event('change'));
    });
    assert.equal(await page.getByLabel('Controlled').inputValue(), 'typed', 'a value set without input events is reverted');
  });

  test('Enter in the search box submits it; contenteditable and replace/append fields exist', async () => {
    await page.goto(fx.url('/type.html'));
    await page.getByLabel('Search query').fill('needle');
    await page.getByLabel('Search query').press('Enter');
    await until(() => fx.submissions('search').length === 1);
    assert.deepEqual(fx.submissions('search')[0]!.fields, [['q', 'needle']]);
    await page.goto(fx.url('/type.html'));
    assert.equal(await page.getByLabel('Replace me').inputValue(), 'old');
    assert.equal(await page.getByLabel('Append me').inputValue(), 'abc');
    await page.getByRole('textbox', { name: 'Editor' }).fill('rich text');
    assert.equal(await page.locator('#editor').textContent(), 'rich text');
  });
});

describe('D4 keys fixture', () => {
  test('Tab focus, select-all, Enter submit, ArrowDown in listbox', async () => {
    await page.goto(fx.url('/keys.html'));
    await page.getByLabel('First field').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'second');
    await page.getByLabel('Select me').focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    assert.deepEqual(
      await page.evaluate(() => {
        const t = document.getElementById('selectme') as HTMLTextAreaElement;
        return [t.selectionStart, t.selectionEnd, t.value.length];
      }),
      [0, 23, 23],
    );
    await page.getByLabel('Enter field').press('Enter');
    assert.deepEqual(await events(page), ['submitted:pressed']);
    await page.getByLabel('Pick one').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => (document.getElementById('pick') as HTMLSelectElement).selectedIndex), 1);
  });
});

describe('D1/B6 click fixture', () => {
  test('plain, double, right, shift counters', async () => {
    await page.goto(fx.url('/click.html'));
    await page.getByRole('button', { name: 'Plain' }).click();
    await page.getByRole('button', { name: 'Double' }).dblclick();
    await page.getByRole('button', { name: 'Right' }).click({ button: 'right' });
    await page.getByRole('button', { name: 'Shift' }).click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Shift' }).click();
    assert.deepEqual(await counts(page), { plain: 1, double: 1, right: 1, shift: 1, noShift: 1 });
  });

  test('delayed element appears 800 ms after "Show delayed"; far button starts offscreen', async () => {
    await page.goto(fx.url('/click.html'));
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Show delayed' }).click();
    assert.equal(await page.getByRole('button', { name: 'Delayed target' }).count(), 0);
    await page.getByRole('button', { name: 'Delayed target' }).click();
    assert.ok(Date.now() - t0 >= 700);
    assert.equal((await counts(page)).delayed, 1);
    const far = await page.evaluate(() => document.getElementById('far')!.getBoundingClientRect().top - window.innerHeight);
    assert.ok(far > 1000, 'Far below starts well outside the viewport');
  });

  test('temporary overlay covers the target for 500 ms; a waiting click lands after it', async () => {
    await page.goto(fx.url('/click.html'));
    await page.evaluate(() => (window as unknown as { armTemp: () => void }).armTemp());
    const covered = await page.evaluate(() => {
      const r = document.getElementById('under-temp')!.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.id;
    });
    assert.equal(covered, 'temp-overlay');
    await page.getByRole('button', { name: 'Under temporary overlay' }).click();
    const s = await page.evaluate(() => {
      const w = window as unknown as { __underTempAt: number; __armedAt: number; __counts: Record<string, number> };
      return { waited: w.__underTempAt - w.__armedAt, counts: w.__counts };
    });
    assert.ok(s.waited >= 450, `click landed ${s.waited} ms after arming`);
    assert.deepEqual(s.counts, { underTemp: 1 });
  });

  test('permanent overlay intercepts (named #perm-overlay); disabled button never fires', async () => {
    await page.goto(fx.url('/click.html'));
    const top = await page.evaluate(() => {
      const r = document.getElementById('under-perm')!.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.id;
    });
    assert.equal(top, 'perm-overlay');
    await assert.rejects(page.getByRole('button', { name: 'Under permanent overlay' }).click({ timeout: 1000 }), /perm-overlay/);
    await assert.rejects(page.getByRole('button', { name: 'Disabled action' }).click({ timeout: 1000 }));
    assert.deepEqual(await counts(page), {});
  });

  test('B6 order fixture distinguishes serial-with-settle from overlapping clicks', async () => {
    await page.goto(fx.url('/click.html'));
    // Overlapping: B is clicked while A's fetch is in flight.
    await page.getByRole('button', { name: 'Order A' }).click();
    await page.getByRole('button', { name: 'Order B' }).click();
    await until(async () => (await events(page)).length === 3);
    assert.deepEqual(await events(page), ['A-start', 'B', 'A-end']);
    // Serial with A's settle (waits for its fetch): A-end comes before B.
    await page.reload();
    await page.getByRole('button', { name: 'Order A' }).click();
    await until(async () => (await events(page)).includes('A-end'));
    await page.getByRole('button', { name: 'Order B' }).click();
    assert.deepEqual(await events(page), ['A-start', 'A-end', 'B']);
  });
});

describe('D9 dialogs fixture', () => {
  test('confirm/prompt results are visible as page state; alert continues after accept', async () => {
    await page.goto(fx.url('/dialogs.html'));
    const state = () => page.evaluate(() => {
      const w = window as unknown as { __confirm: unknown; __prompt: unknown };
      return [w.__confirm, w.__prompt];
    });
    assert.deepEqual(await state(), ['unset', 'unset']);
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Confirm' }).click();
    assert.equal((await state())[0], true);
    page.once('dialog', (d) => void d.dismiss());
    await page.getByRole('button', { name: 'Confirm' }).click();
    assert.equal((await state())[0], false);
    page.once('dialog', (d) => void d.accept('Zed'));
    await page.getByRole('button', { name: 'Prompt' }).click();
    assert.equal((await state())[1], 'Zed');
    page.once('dialog', (d) => void d.dismiss());
    await page.getByRole('button', { name: 'Prompt' }).click();
    assert.equal((await state())[1], null);
    let msg = '';
    page.once('dialog', (d) => {
      msg = d.message();
      void d.accept();
    });
    await page.getByRole('button', { name: 'Alert' }).click();
    assert.equal(msg, 'Hello alert');
    assert.deepEqual(await events(page), ['after-alert']);
  });
});

describe('D7 drag fixture', () => {
  test('HTML5 DnD and pointer drag both register the drop', async () => {
    await page.goto(fx.url('/drag.html'));
    await page.dragAndDrop('#src', '#dropzone');
    const h = await page.locator('#handle').boundingBox();
    const t = await page.locator('#ptarget').boundingBox();
    await page.mouse.move(h!.x + h!.width / 2, h!.y + h!.height / 2);
    await page.mouse.down();
    await page.mouse.move(t!.x + t!.width / 2, t!.y + t!.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.deepEqual(await events(page), ['html5-drop:payload-42', 'pointer-down', 'pointer-drop']);
  });
});

describe('D5 hover fixture', () => {
  test('the menu item is hidden until hover, then clickable', async () => {
    await page.goto(fx.url('/hover.html'));
    assert.equal(await page.getByRole('button', { name: 'Hidden item' }).isVisible(), false);
    await page.getByRole('button', { name: 'Products' }).hover();
    assert.equal(await page.getByRole('button', { name: 'Hidden item' }).isVisible(), true);
    await page.getByRole('button', { name: 'Hidden item' }).click();
    assert.deepEqual(await counts(page), { hiddenItem: 1 });
  });
});

describe('D6 scroll fixtures', () => {
  test('page scrollY, container scrollTop, infinite feed grows at the bottom', async () => {
    await page.goto(fx.url('/scroll.html'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 6000);
    await page.mouse.wheel(0, 500);
    await until(async () => (await page.evaluate(() => window.scrollY)) > 0);
    await page.locator('#box').evaluate((el) => el.scrollBy(0, 300));
    assert.equal(await page.locator('#box').evaluate((el) => el.scrollTop), 300);
    await page.goto(fx.url('/infinite.html'));
    const before = await page.evaluate(() => [document.querySelectorAll('#feed li').length, document.documentElement.scrollHeight]);
    assert.equal(before[0], 30);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await until(async () => (await page.evaluate(() => document.querySelectorAll('#feed li').length)) > 30);
    const afterS = await page.evaluate(() => [document.querySelectorAll('#feed li').length, document.documentElement.scrollHeight]);
    assert.ok(afterS[0]! > 30 && afterS[1]! > before[1]!);
  });
});

describe('C4 stale fixture', () => {
  test('re-render removes the old node; single vs double Save', async () => {
    await page.goto(fx.url('/stale.html'));
    const old = await page.getByRole('button', { name: 'Save', exact: true }).elementHandle();
    await page.getByRole('button', { name: 'Re-render single' }).click();
    assert.equal(await old!.evaluate((el) => el.isConnected), false);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.deepEqual(await counts(page), { save: 1 });
    await page.getByRole('button', { name: 'Re-render double' }).click();
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 2);
  });
});

describe('B3 tabs fixture', () => {
  test('target=_blank and window.open both open /tab-target.html', async () => {
    await page.goto(fx.url('/tabs.html'));
    const [p1] = await Promise.all([pw.context.waitForEvent('page'), page.getByRole('link', { name: 'Open blank' }).click()]);
    await p1.waitForLoadState();
    assert.match(p1.url(), /\/tab-target\.html\?via=blank$/);
    assert.equal(await p1.title(), 'Tab Target');
    const [p2] = await Promise.all([pw.context.waitForEvent('page'), page.getByRole('button', { name: 'Window open' }).click()]);
    await p2.waitForLoadState();
    assert.match(p2.url(), /\/tab-target\.html\?via=open$/);
    await p1.close();
    await p2.close();
  });
});

describe('D10 SPA and navigation fixtures', () => {
  test('pushState changes the URL without a new document', async () => {
    await page.goto(fx.url('/spa.html'));
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 7));
    await page.getByRole('button', { name: 'Go to section' }).click();
    assert.equal(new URL(page.url()).pathname, '/spa/section-2');
    assert.equal(await page.evaluate(() => (window as unknown as { __marker: number }).__marker), 7);
  });

  test('reload is observable as navigation type "reload"', async () => {
    await page.goto(fx.url('/nav-a.html'));
    await page.reload();
    assert.equal(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type), 'reload');
  });
});

describe('D11 wait fixtures', () => {
  test('all conditions flip together 1000 ms after Start timers', async () => {
    await page.goto(fx.url('/wait.html'));
    assert.equal(await page.getByText('Appeared later').count(), 0);
    await page.getByRole('button', { name: 'Start timers' }).click();
    await page.getByText('Appeared later').waitFor({ timeout: 3000 });
    assert.equal(await page.getByText('Vanishing text').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Hide me later' }).isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Show me later' }).isVisible(), true);
    assert.match(page.url(), /\?step=2$/);
    const dt = await page.evaluate(() => {
      const w = window as unknown as { __firedAt: number; __startedAt: number };
      return w.__firedAt - w.__startedAt;
    });
    assert.ok(dt >= 999);
    assert.equal(await page.getByText('Never appears').count(), 0);
  });

  test('wait-load: load fires >= 1 s after DOMContentLoaded', async () => {
    await page.goto(fx.url('/wait-load.html'), { waitUntil: 'load' });
    const t = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return n.loadEventStart - n.domContentLoadedEventEnd;
    });
    assert.ok(t >= 1000, `load came ${t} ms after DCL`);
  });
});

describe('D13 download fixture', () => {
  test('the link downloads report.txt with the spec bytes', async () => {
    await page.goto(fx.url('/downloads.html'));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download report' }).click()]);
    assert.equal(dl.suggestedFilename(), 'report.txt');
    const path = await dl.path();
    assert.ok(readFileSync(path).equals(downloadBytes('report.txt')));
  });
});

describe('D15 console/network fixture', () => {
  test('log/warning/error, uncaught exception, 200 fetch with Authorization, 500 and aborted requests', async () => {
    const msgs: string[] = [];
    const errors: string[] = [];
    const reqs: string[] = [];
    page.on('console', (m) => msgs.push(`${m.type()}:${m.text()}`));
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (res) => {
      const r = res.request();
      reqs.push(`${r.method()} ${res.status()} ${r.resourceType()} ${new URL(r.url()).pathname} auth=${r.headers().authorization ?? ''}`);
    });
    page.on('requestfailed', (r) => reqs.push(`failed ${r.resourceType()} ${new URL(r.url()).pathname}`));
    await page.goto(fx.url('/console.html'));
    await until(
      async () =>
        (await events(page)).length === 3 &&
        errors.length === 1 &&
        reqs.some((r) => r.includes('/api/data')) &&
        reqs.some((r) => r.includes('/fail/500')) &&
        reqs.some((r) => r.includes('/hang')),
    );
    // Chrome also logs "Failed to load resource ... 500" as an error; the fixture's own messages are these:
    assert.deepEqual(msgs.filter((m) => m.includes('fixture-')), ['log:fixture-log-message', 'warning:fixture-warning-message', 'error:fixture-error-message']);
    assert.deepEqual(errors, ['fixture-uncaught-boom']);
    assert.ok(reqs.includes('GET 200 fetch /api/data auth=Bearer fixture-secret-token-5521'), reqs.join('\n'));
    assert.ok(reqs.includes('GET 500 fetch /fail/500 auth='), reqs.join('\n'));
    assert.ok(reqs.includes('failed fetch /hang'), reqs.join('\n'));
  });
});
