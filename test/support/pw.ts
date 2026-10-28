// Plain playwright-core Chrome for the fixture harness (never the server under test).
// The profile and TMPDIR live under the test root so G2-style checks see it, and a slot is held.
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { freshDir } from './paths.ts';
import { killChromeUnder } from './procs.ts';
import { acquireSlots } from './slots.ts';

export interface PwBrowser {
  context: BrowserContext;
  root: string;
  page(): Promise<Page>;
  close(): Promise<void>;
}

export async function launchPw(opts: { env?: NodeJS.ProcessEnv; viewport?: { width: number; height: number } } = {}): Promise<PwBrowser> {
  const lease = await acquireSlots(1, 'harness');
  const root = freshDir('h');
  try {
    const context = await chromium.launchPersistentContext(join(root, 'profile'), {
      channel: 'chrome',
      headless: true,
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      acceptDownloads: true,
      env: { ...process.env, TMPDIR: root + '/', ...opts.env },
    });
    let closed = false;
    return {
      context,
      root,
      page: () => context.newPage(),
      close: async () => {
        if (closed) return;
        closed = true;
        await context.close().catch(() => undefined);
        await killChromeUnder(root).catch(() => 0);
        lease.release();
      },
    };
  } catch (err) {
    await killChromeUnder(root).catch(() => 0);
    lease.release();
    throw err;
  }
}
