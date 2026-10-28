// Acceptance group E: video. Oracle: the generated color table (second k = COLOR_TABLE[k]), the VTT cues,
// and element state read back via `evaluate`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// @ts-expect-error -- plain .mjs module without type declarations
import { COLOR_TABLE, CUES } from '../../scripts/gen-fixture-video.mjs';
import { findAll, mmss, parseFrameLabels, parseVideoList, type Snapshot } from '../support/grammar.ts';
import { centerPixel, near } from '../support/images.ts';
import { until, useFileServer } from '../support/suite.ts';

const TABLE = COLOR_TABLE as [number, number, number][];
const CUE_LIST = CUES as { start: number; end: number; text: string }[];
const ctx = useFileServer('E');

const V = 'document.getElementById("v1")';

async function go(path: string): Promise<Snapshot> {
  await ctx.s.ok('navigate', { url: ctx.fx.url(path), snapshot: false });
  return ctx.s.snapshot();
}

async function loaded(): Promise<void> {
  const ok = await until(() => ctx.s.state<boolean>(`${V}.readyState >= 2`), 5000, 200);
  assert.equal(ok, true, 'the fixture video loaded');
}

/** Colors acceptable at time t: the second's color; within 0.1 s of a boundary either neighbour. */
function colorsAt(t: number): [number, number, number][] {
  const idx = (k: number) => TABLE[Math.min(TABLE.length - 1, Math.max(0, k))]!;
  const k = Math.floor(t);
  const out = [idx(k)];
  if (t - k < 0.1) out.push(idx(k - 1));
  if (k + 1 - t < 0.1) out.push(idx(k + 1));
  return out;
}

function checkFrames(images: { data: string; mimeType: string }[], times: number[]): void {
  assert.equal(images.length, times.length);
  images.forEach((img, i) => {
    assert.equal(img.mimeType, 'image/png');
    const px = centerPixel(Buffer.from(img.data, 'base64'));
    const want = colorsAt(times[i]!);
    assert.ok(want.some((w) => near(px, w, 40)), `frame ${i} @${times[i]}s: center ${px.join(',')} vs table ${want.map((w) => w.join(',')).join(' | ')}`);
  });
}

describe('E video', () => {
  // PLAN contract answer 14 (+ review-lens decision 7: duration may be `unknown` before metadata).
  test('E1 video list shows duration 6±0.1 s, paused, 640x360; the fixture server serves Range', async () => {
    const range = await fetch(ctx.fx.url('/media/colors.webm'), { headers: { range: 'bytes=0-9' } });
    assert.equal(range.status, 206);
    await go('/video.html');
    await loaded();
    const r = await ctx.s.ok('video', { action: 'list' });
    const vids = parseVideoList(r.text);
    assert.equal(vids.length, 1, r.text);
    const v = vids[0]!;
    assert.deepEqual([v.width, v.height], [640, 360]);
    assert.ok(v.duration !== null && Math.abs(v.duration - 6) <= 0.1, `duration 6±0.1: ${v.raw}`);
    assert.equal(v.paused, true);
    assert.equal(v.tracks, 1);
  });

  test('E2 frames times=[0.5,2.5,4.5] format=png returns 3 images matching the color table', async () => {
    await go('/video.html');
    await loaded();
    const times = [0.5, 2.5, 4.5];
    const r = await ctx.s.ok('video', { action: 'frames', times, format: 'png' });
    checkFrames(r.images, times);
    const labels = parseFrameLabels(r.text);
    assert.deepEqual(labels.map((l) => [l.i, l.n]), [[1, 3], [2, 3], [3, 3]]);
    labels.forEach((l, i) => assert.ok(Math.abs(l.seconds - times[i]!) <= 0.05, `label ${l.seconds} vs ${times[i]}`));
  });

  test('E3 count=3 spreads frames across the duration and restores currentTime and paused', async () => {
    await go('/video.html');
    await loaded();
    await ctx.s.ok('evaluate', { script: `${V}.currentTime = 1.25` });
    await until(() => ctx.s.state<boolean>(`Math.abs(${V}.currentTime - 1.25) < 0.01 && !${V}.seeking`));
    const r = await ctx.s.ok('video', { action: 'frames', count: 3, format: 'png' });
    assert.equal(r.images.length, 3);
    const t = parseFrameLabels(r.text).map((l) => l.seconds);
    assert.equal(t.length, 3);
    assert.ok(t[0]! < t[1]! && t[1]! < t[2]!, `increasing: ${t.join(',')}`);
    assert.ok(t[0]! <= 2 && t[2]! >= 4, `spread over 0..6: ${t.join(',')}`);
    checkFrames(r.images, t);
    const after = await ctx.s.state<[number, boolean]>(`[${V}.currentTime, ${V}.paused]`);
    assert.ok(Math.abs(after[0] - 1.25) < 0.05, `currentTime restored: ${after[0]}`);
    assert.equal(after[1], true, 'still paused');
  });

  test('E4 play, pause, seek, rate, muted and volume change the element state', async () => {
    const s = await go('/video.html');
    await loaded();
    const ref = findAll(s, { role: 'video' })[0]?.ref;
    assert.ok(ref, 'the video has a ref');
    await ctx.s.ok('video', { action: 'play', target: ref });
    assert.equal(await ctx.s.state(`${V}.paused`), false);
    await ctx.s.ok('video', { action: 'pause', target: ref });
    assert.equal(await ctx.s.state(`${V}.paused`), true);
    await ctx.s.ok('video', { action: 'seek', time: 3, target: ref });
    assert.ok(Math.abs((await ctx.s.state<number>(`${V}.currentTime`)) - 3) < 0.05);
    await ctx.s.ok('video', { action: 'set', rate: 1.5, target: ref });
    assert.equal(await ctx.s.state(`${V}.playbackRate`), 1.5);
    await ctx.s.ok('video', { action: 'set', muted: false, target: ref });
    assert.equal(await ctx.s.state(`${V}.muted`), false);
    await ctx.s.ok('video', { action: 'set', volume: 0.3, target: ref });
    assert.ok(Math.abs((await ctx.s.state<number>(`${V}.volume`)) - 0.3) < 0.001);
    await ctx.s.ok('video', { action: 'set', muted: true, target: ref });
  });

  test('E5 live sampling every_ms=500 duration_ms=2000 while playing returns >= 3 frames with increasing timestamps', async () => {
    await go('/video.html');
    await loaded();
    await ctx.s.ok('video', { action: 'set', loop: true });
    await ctx.s.ok('video', { action: 'play' });
    const r = await ctx.s.ok('video', { action: 'frames', every_ms: 500, duration_ms: 2000, format: 'png' });
    assert.ok(r.images.length >= 3, `${r.images.length} frames`);
    const t = parseFrameLabels(r.text).map((l) => l.seconds);
    assert.equal(t.length, r.images.length);
    for (let i = 1; i < t.length; i++) assert.ok(t[i]! > t[i - 1]!, `increasing: ${t.join(',')}`);
    await ctx.s.ok('video', { action: 'pause' });
  });

  test('E6 captions returns the <track> cues with the VTT timestamps', async () => {
    await go('/video.html');
    await loaded();
    const r = await ctx.s.ok('video', { action: 'captions' });
    // Round 7 (item 6): a cue's text is page text, printed JSON-quoted.
    const cues = [...r.text.matchAll(/^(\d+:\d{2}\.\d{2})-(\d+:\d{2}\.\d{2}) (".*")$/gm)].map((m) => ({
      start: mmss(m[1]!),
      end: mmss(m[2]!),
      text: JSON.parse(m[3]!) as string,
    }));
    assert.equal(cues.length, CUE_LIST.length, r.text);
    cues.forEach((c, i) => {
      assert.ok(Math.abs(c.start - CUE_LIST[i]!.start) < 0.006 && Math.abs(c.end - CUE_LIST[i]!.end) < 0.006, JSON.stringify(c));
      assert.equal(c.text, CUE_LIST[i]!.text);
    });
  });

  test('E7 a video inside a cross-origin iframe is listed and its frames are captured', async () => {
    await go('/video-xo.html');
    let s: Snapshot | null = null;
    await until(async () => {
      s = await ctx.s.snapshot();
      return findAll(s, { role: 'video' }).length > 0;
    }, 5000, 250);
    const iframe = findAll(s!, { role: 'iframe' })[0];
    assert.ok(iframe?.attrs.frame, 'the iframe line names its frame');
    const list = await until(async () => {
      const vids = parseVideoList((await ctx.s.ok('video', { action: 'list' })).text);
      return vids.length === 1 && vids[0]!.width === 640 && vids[0]!.height === 360 ? vids : null;
    }, 5000, 250);
    assert.ok(list, 'one loaded video listed');
    assert.equal(list[0]!.frame, iframe.attrs.frame, 'listed with its OOPIF frame');
    const times = [0.5, 2.5, 4.5];
    const r = await ctx.s.ok('video', { action: 'frames', times, format: 'png' });
    checkFrames(r.images, times);
  });
});
