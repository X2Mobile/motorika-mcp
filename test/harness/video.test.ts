// Harness: the generated video files match the color table, decode in Chrome in both formats, the
// captions file matches CUES, and the cross-origin video page really plays from another site.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Frame, Locator, Page } from 'playwright-core';
import ffmpegPath from 'ffmpeg-static';
// @ts-expect-error -- plain .mjs module without type declarations
import { COLOR_TABLE, CUES, VIDEO, vttText } from '../../scripts/gen-fixture-video.mjs';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { centerPixel, near } from '../support/images.ts';
import { MEDIA_DIR } from '../support/paths.ts';
import { launchPw, type PwBrowser } from '../support/pw.ts';

const TABLE = COLOR_TABLE as [number, number, number][];
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
});

async function seek(scope: Page | Frame, selector: string, t: number): Promise<void> {
  // A string expression: tsx would inject a __name helper into named closures passed to evaluate().
  await scope.evaluate(`new Promise((resolve) => {
    const v = document.querySelector(${JSON.stringify(selector)});
    v.addEventListener('seeked', function poll() { v.readyState >= 2 ? resolve() : setTimeout(poll, 20); }, { once: true });
    v.currentTime = ${t};
  })`);
}

async function ready(scope: Page | Frame, selector: string): Promise<void> {
  await scope.waitForFunction((sel) => (document.querySelector(sel) as HTMLVideoElement | null)?.readyState! >= 2, selector);
}

async function checkColors(scope: Page | Frame, selector: string, shot: Locator): Promise<void> {
  for (const t of [0.5, 2.5, 4.5]) {
    await seek(scope, selector, t);
    const px = centerPixel(await shot.screenshot({ type: 'png' }));
    const want = TABLE[Math.floor(t)]!;
    assert.ok(near(px, want), `t=${t}: center ${px.join(',')} vs table ${want.join(',')}`);
  }
}

describe('E1 video files', () => {
  test('WebM is VP9 and MP4 is H.264, 640x360, 6 s, each under 300 KB', () => {
    const info = (f: string) => {
      try {
        execFileSync(ffmpegPath as unknown as string, ['-hide_banner', '-i', join(MEDIA_DIR, f)], { encoding: 'utf8', stdio: 'pipe' });
        return '';
      } catch (e) {
        return String((e as { stderr?: string }).stderr ?? '');
      }
    };
    const webm = info('colors.webm');
    const mp4 = info('colors.mp4');
    assert.match(webm, /Duration: 00:00:06\.00/);
    assert.match(webm, /Video: vp9.*640x360/);
    assert.match(mp4, /Duration: 00:00:06\.00/);
    assert.match(mp4, /Video: h264.*640x360/);
    for (const f of ['colors.webm', 'colors.mp4', 'colors.vtt']) assert.ok(statSync(join(MEDIA_DIR, f)).size < 300 * 1024, f);
    assert.equal(readFileSync(join(MEDIA_DIR, 'colors.vtt'), 'utf8'), vttText());
    assert.deepEqual(VIDEO, { width: 640, height: 360, seconds: 6, fps: 30 });
  });

  test('pairwise the table colors differ by more than twice the tolerance', () => {
    for (let a = 0; a < TABLE.length; a++)
      for (let b = a + 1; b < TABLE.length; b++)
        assert.ok(TABLE[a]!.some((v, i) => Math.abs(v - TABLE[b]![i]!) > 80), `${a} vs ${b}`);
  });
});

describe('E1/E2 decoding in Chrome', () => {
  for (const file of ['colors.webm', 'colors.mp4']) {
    test(`${file}: duration 6, 640x360, center pixels at 0.5/2.5/4.5 s match the table`, async () => {
      await page.goto(fx.url('/video.html'));
      await page.evaluate((src) => {
        const v = document.getElementById('v1') as HTMLVideoElement;
        v.src = src;
        v.load();
      }, `/media/${file}`);
      await ready(page, '#v1');
      const meta = await page.evaluate(() => {
        const v = document.getElementById('v1') as HTMLVideoElement;
        return [v.duration, v.videoWidth, v.videoHeight, v.paused];
      });
      assert.ok(Math.abs((meta[0] as number) - 6) <= 0.1, `duration ${meta[0]}`);
      assert.deepEqual(meta.slice(1), [640, 360, true]);
      await checkColors(page, '#v1', page.locator('#v1'));
    });
  }

  test('the page as served (both sources) loads; Chrome fetched media with Range', async () => {
    const ranges: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/media/colors.')) ranges.push(r.headers().range ?? 'none');
    });
    await page.goto(fx.url('/video.html'));
    await ready(page, '#v1');
    assert.ok(ranges.some((r) => r.startsWith('bytes=')), `range requests: ${ranges.join(',')}`);
  });
});

describe('E6 captions', () => {
  test('the default <track> exposes exactly the CUES', async () => {
    await page.goto(fx.url('/video.html'));
    const cues = await page.waitForFunction(() => {
      const t = (document.getElementById('v1') as HTMLVideoElement).textTracks[0];
      if (!t || !t.cues || t.cues.length === 0) return null;
      return [...t.cues].map((c) => ({ start: c.startTime, end: c.endTime, text: (c as VTTCue).text }));
    });
    assert.deepEqual(await cues.jsonValue(), CUES);
  });
});

describe('E7 cross-origin video', () => {
  test('the video in the OOPIF is on origin B and its frames match the table', async () => {
    await page.goto(fx.url('/video-xo.html'));
    const frameEl = page.frameLocator('iframe[title="Video frame"]');
    await frameEl.locator('#vx').waitFor();
    const frame = page.frames().find((f) => f.url().startsWith(fx.originB))!;
    assert.ok(frame, 'frame on origin B');
    assert.equal(await page.evaluate(() => (document.querySelector('iframe') as HTMLIFrameElement).contentDocument), null);
    await ready(frame, '#vx');
    await checkColors(frame, '#vx', frameEl.locator('#vx'));
  });
});
