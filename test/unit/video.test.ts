// Unit tests for the video tool's pure parts. Expectations come from PLAN.md (tool 19, contract answers 1
// and 14) and from pngjs as an independent PNG encoder, not from the implementation.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { countTimes, fmtClock, listLine, pickDefault, sampleTicks, videoBudget } from '../../src/tools/video.js';
import { decodePng, isAllBlack } from '../../src/tools/video-png.js';
import type { VideoState } from '../../src/page/injected/video.js';

// Contract answer 14, written as a parser independent of the formatter.
const LIST =
  /^e(\d+) frame=f(\d+) src=("(?:[^"\\]|\\.)*") duration=(\d+\.\d{2}|Infinity) time=(\d+\.\d{2}) paused=(true|false) muted=(true|false) volume=(0|1|0?\.\d+|0\.\d+) rate=(\d+(?:\.\d+)?) size=(\d+)x(\d+) ready=([0-4]) tracks=(\d+)$/;

const base: VideoState = {
  src: 'http://127.0.0.1:1234/media/colors.webm',
  duration: 6.006,
  time: 1.25,
  paused: true,
  ended: false,
  seeking: false,
  muted: true,
  volume: 1,
  rate: 1,
  loop: false,
  width: 640,
  height: 360,
  ready: 4,
  tracks: 1,
  visible: true,
};

describe('video list line (contract answer 14)', () => {
  it('has every field in order', () => {
    const l = listLine(7, 'f2', base);
    const m = LIST.exec(l);
    assert.ok(m, l);
    assert.equal(m[1], '7');
    assert.equal(m[2], '2');
    assert.equal(JSON.parse(m[3] ?? ''), base.src);
    assert.equal(m[4], '6.01');
    assert.equal(m[5], '1.25');
    assert.equal(m[10], '640');
    assert.equal(m[11], '360');
  });
  it('live stream duration is Infinity; volume and rate are plain numbers', () => {
    const l = listLine(1, 'f1', { ...base, duration: Infinity, volume: 0.3, rate: 1.5, paused: false });
    assert.match(l, LIST);
    assert.match(l, / duration=Infinity /);
    assert.match(l, / paused=false /);
    assert.match(l, / volume=0\.3 rate=1\.5 /);
  });
  it('a long src is truncated but stays a JSON string', () => {
    const l = listLine(1, 'f1', { ...base, src: `https://x.test/${'a'.repeat(300)}` });
    assert.match(l, LIST);
    assert.ok(l.length < 300);
  });
});

describe('mm:ss.ss labels (frames and captions)', () => {
  it('formats with two decimals', () => {
    assert.equal(fmtClock(0), '00:00.00');
    assert.equal(fmtClock(1.5), '00:01.50');
    assert.equal(fmtClock(3.25), '00:03.25');
    assert.equal(fmtClock(65.004), '01:05.00');
    assert.equal(fmtClock(59.999), '01:00.00');
    assert.equal(fmtClock(4500), '75:00.00');
  });
});

describe('frame planning', () => {
  it('count is evenly spaced over [start, end] and stays inside it', () => {
    const t = countTimes(3, 0, 6);
    assert.equal(t.length, 3);
    const gaps = [t[1]! - t[0]!, t[2]! - t[1]!];
    assert.ok(Math.abs(gaps[0]! - gaps[1]!) < 1e-9, `even: ${t.join(',')}`);
    assert.ok(t[0]! > 0 && t[2]! < 6, `inside: ${t.join(',')}`);
    const w = countTimes(4, 10, 20);
    assert.ok(w.every((x) => x > 10 && x < 20));
  });
  it('every_ms ticks cover duration_ms inclusive of the start', () => {
    assert.deepEqual(sampleTicks(500, 2000), [0, 500, 1000, 1500, 2000]);
    assert.deepEqual(sampleTicks(700, 2000), [0, 700, 1400]);
    assert.equal(sampleTicks(50, 600000).length, 60);
  });
});

describe('call budgets (contract answer 1)', () => {
  const cfg = { actionTimeout: 10000, navigationTimeout: 30000 };
  it('frames with every_ms: duration_ms + action timeout', () => {
    assert.equal(videoBudget({ action: 'frames', every_ms: 500, duration_ms: 2000 }, cfg), 12000);
  });
  it('other frames: navigation timeout', () => {
    assert.equal(videoBudget({ action: 'frames', count: 3 }, cfg), 30000);
    assert.equal(videoBudget({ action: 'frames' }, cfg), 30000);
  });
  it('every other action: action timeout; timeout_ms replaces the default', () => {
    for (const action of ['list', 'play', 'pause', 'seek', 'set', 'captions']) assert.equal(videoBudget({ action }, cfg), 10000);
    assert.equal(videoBudget({ action: 'frames', every_ms: 500, duration_ms: 2000, timeout_ms: 4000 }, cfg), 4000);
  });
});

describe('default video (PLAN tool 19)', () => {
  const v = (name: string, area: number, paused: boolean, visible = true) => ({ name, area, state: { paused, ended: false, visible } });
  it('the largest visible playing video wins over a larger paused one', () => {
    assert.equal(pickDefault([v('big-paused', 900, true), v('small-playing', 100, false), v('mid-playing', 400, false)])?.name, 'mid-playing');
  });
  it('else the largest visible video', () => {
    assert.equal(pickDefault([v('a', 100, true), v('b', 300, true), v('hidden-playing', 0, false, false)])?.name, 'b');
  });
  it('none visible: no default', () => {
    assert.equal(pickDefault([v('h', 0, true, false)]), undefined);
  });
});

function png(w: number, h: number, px: (x: number, y: number) => [number, number, number], colorType: 2 | 6 = 6): Buffer {
  const p = new PNG({ width: w, height: h, colorType, inputColorType: 6, inputHasAlpha: true });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      const o = (y * w + x) * 4;
      p.data[o] = r;
      p.data[o + 1] = g;
      p.data[o + 2] = b;
      p.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(p, { colorType });
}

describe('black-frame probe PNG decoder (checked against pngjs)', () => {
  it('decodes noise exactly (exercises every scanline filter pngjs picks)', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256;
    const pixels: [number, number, number][] = [];
    for (let i = 0; i < 32 * 18; i++) pixels.push([rnd(), rnd(), rnd()]);
    for (const ct of [2, 6] as const) {
      const buf = png(32, 18, (x, y) => pixels[y * 32 + x]!, ct);
      const ref = PNG.sync.read(buf);
      const r = decodePng(buf);
      assert.ok(r, `colorType ${ct}`);
      assert.equal(r.width, 32);
      assert.equal(r.height, 18);
      for (let i = 0; i < 32 * 18; i++) {
        assert.deepEqual([r.rgb[i * 3], r.rgb[i * 3 + 1], r.rgb[i * 3 + 2]], [ref.data[i * 4], ref.data[i * 4 + 1], ref.data[i * 4 + 2]], `pixel ${i}`);
      }
    }
  });
  it('flags all-black, not a solid colour or a dark frame with a bright spot', () => {
    assert.equal(isAllBlack(decodePng(png(16, 9, () => [0, 0, 0]))!), true);
    assert.equal(isAllBlack(decodePng(png(16, 9, () => [5, 8, 3]))!), true);
    assert.equal(isAllBlack(decodePng(png(16, 9, () => [40, 60, 200]))!), false);
    assert.equal(isAllBlack(decodePng(png(16, 9, (x, y) => (x === 8 && y === 4 ? [200, 200, 200] : [0, 0, 0])))!), false);
  });
  it('returns null for non-PNG input', () => {
    assert.equal(decodePng(Buffer.from('not a png at all, definitely not')), null);
  });
});
