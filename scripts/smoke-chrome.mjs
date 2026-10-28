// Version-skew smoke: playwright-core against the installed Google Chrome.
// Launches a throwaway profile headless, loads a data: page, takes a screenshot.
// Exit 0 = the pinned playwright-core can drive this Chrome. Fallback when it cannot:
// run with --executable-path pointing at a Chrome for Testing build.
import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profile = mkdtempSync(join(tmpdir(), 'motorika-smoke-'));
const started = Date.now();
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('data:text/html,<title>smoke</title><button>ok</button>');
  const png = await page.screenshot();
  const version = context.browser()?.version() ?? 'unknown (persistent context)';
  process.stdout.write(
    `ok chrome=${version} title=${await page.title()} screenshot=${png.length}B in ${Date.now() - started}ms\n`,
  );
} finally {
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
}
