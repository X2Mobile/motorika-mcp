// video: list videos (all frames, incl. cross-origin iframes), control playback, capture frames by
// element screenshot through CDP (never a canvas: works for cross-origin video), read text-track cues.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession, ElementHandle, Frame } from 'playwright-core';
import { z } from 'zod';
import type { Tab } from '../browser/tabs.js';
import type { Config } from '../config.js';
import { FRAME_BUDGET_MS, askFrame, call, mainWorld, mainWorldError, unavailableFrames } from '../page/engine.js';
import {
  controlVideo,
  isVideo,
  type Control,
  readCaptions,
  readVideo,
  restoreVideo,
  seekAndPresent,
  type SeekResult,
  type TrackCues,
  type VideoState,
} from '../page/injected/video.js';
import { issueRef, safeNode } from '../page/snapshot.js';
import { resolveElement } from '../page/target.js';
import { ToolError } from '../util/errors.js';
import { capText, jsonQuote, q } from '../util/format.js';
import { scrubSecrets } from '../util/secrets.js';
import { uniquePathIn } from '../util/paths.js';
import { capMs, frontFor, sleep } from './common.js';
import { clipScale } from './screenshot.js';
import { defineTool, tabArg, timeoutArg, type CallCtx, type Content } from './types.js';
import { decodePng, isAllBlack } from './video-png.js';

const DEFAULT_COUNT = 6;
const DEFAULT_MAX_EDGE = 1280;
const JPEG_QUALITY = 70;
/** Probe image long edge (px) for the black-frame check when the frame itself is a jpeg. */
const PROBE_EDGE = 32;
/** Live fallback for `count` on a stream (duration Infinity): one frame per second. */
const LIVE_FALLBACK_EVERY_MS = 1000;
const MAX_FRAMES = 60;

// ---------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)

/** `mm:ss.ss` (minutes not capped at 59: 75:00.00 for 1h15m). */
export function fmtClock(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const m = Math.floor(cs / 6000);
  const s = (cs % 6000) / 100;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function num(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}

function fmtDuration(d: number): string {
  if (d === Infinity) return 'Infinity';
  if (!Number.isFinite(d)) return 'unknown';
  return d.toFixed(2);
}

// Round 4, G5: everything the page hands back is untrusted. A page can redefine `paused`, `readyState`,
// `textTracks` or a cue's `text` with getters that return any value, line separators included. Every value
// is coerced to the type it is printed as, and page strings print with the 7 line separators escaped.

/** A page-reported number: a number, or NaN for anything else. */
function pageNum(x: unknown): number {
  return typeof x === 'number' ? x : Number.NaN;
}

/**
 * Page text (round 7, item 6): remembered secrets scrubbed, otherwise as the page gave it. It is printed only
 * JSON-quoted (jsonQuote escapes every C0 control, DEL, C1, U+2028 and U+2029), never in an unquoted field:
 * escaping only the line separators let ESC and DEL through, and quotes in the text hid tokens from parsers.
 */
export function pageText(x: unknown): string {
  return scrubSecrets(typeof x === 'string' ? x : String(x ?? ''));
}

/** A VideoState as read from the page, with every field of its declared type (G5). */
export function cleanState(raw: unknown): VideoState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    src: typeof r.src === 'string' ? r.src : String(r.src ?? ''),
    duration: pageNum(r.duration),
    time: pageNum(r.time),
    paused: r.paused === true,
    ended: r.ended === true,
    seeking: r.seeking === true,
    muted: r.muted === true,
    volume: pageNum(r.volume),
    rate: pageNum(r.rate),
    loop: r.loop === true,
    width: pageNum(r.width),
    height: pageNum(r.height),
    ready: pageNum(r.ready),
    tracks: pageNum(r.tracks),
    visible: r.visible === true,
  };
}

/** A seek result from the page, typed (G5). */
export function cleanSeek(raw: unknown): SeekResult {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const presented = r.presented === 'rvfc' || r.presented === 'raf' ? r.presented : 'timeout';
  return { time: pageNum(r.time), ready: pageNum(r.ready), seeked: r.seeked === true, presented };
}

/** Text tracks from the page: kind, label, language and cue text as escaped page text (G5). */
export function cleanTracks(raw: unknown): TrackCues[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t: unknown) => {
    const r = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>;
    const cues = Array.isArray(r.cues)
      ? r.cues.map((c: unknown) => {
          const x = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
          return { start: pageNum(x.start), end: pageNum(x.end), text: pageText(x.text) };
        })
      : null;
    return { kind: pageText(r.kind), label: typeof r.label === 'string' ? r.label : pageText(r.label), lang: pageText(r.lang), cues };
  });
}

/** Contract answer 14. */
export function listLine(ref: number, frameLabel: string, s: VideoState): string {
  return [
    `e${ref}`,
    `frame=${frameLabel}`,
    `src=${q(s.src, 100)}`,
    `duration=${fmtDuration(s.duration)}`,
    `time=${s.time.toFixed(2)}`,
    `paused=${s.paused}`,
    `muted=${s.muted}`,
    `volume=${num(s.volume)}`,
    `rate=${num(s.rate)}`,
    `size=${s.width}x${s.height}`,
    `ready=${s.ready}`,
    `tracks=${s.tracks}`,
  ].join(' ');
}

/** `count` frames evenly spaced over [start, end]: the midpoints of `count` equal bins (never the very end). */
export function countTimes(count: number, start: number, end: number): number[] {
  const step = (end - start) / count;
  return Array.from({ length: count }, (_, i) => Math.round((start + (i + 0.5) * step) * 1000) / 1000);
}

/** Sampling tick offsets (ms from the first capture). */
export function sampleTicks(everyMs: number, durationMs: number, max = MAX_FRAMES): number[] {
  const n = Math.min(max, Math.floor(durationMs / everyMs) + 1);
  return Array.from({ length: n }, (_, k) => k * everyMs);
}

export interface BudgetArgs {
  action: string;
  every_ms?: number | undefined;
  duration_ms?: number | undefined;
  count?: number | undefined;
  timeout_ms?: number | undefined;
}

/** Sampling duration when `duration_ms` is omitted: `count` (default 6) frames. */
export function liveDurationMs(a: BudgetArgs): number {
  return a.duration_ms ?? (a.every_ms ?? LIVE_FALLBACK_EVERY_MS) * ((a.count ?? DEFAULT_COUNT) - 1);
}

/** Contract answer 1: frames with every_ms = duration_ms + action timeout; other frames = navigation timeout. */
export function videoBudget(a: BudgetArgs, c: Pick<Config, 'actionTimeout' | 'navigationTimeout'>): number {
  if (a.timeout_ms !== undefined) return a.timeout_ms;
  if (a.action !== 'frames') return c.actionTimeout;
  if (a.every_ms !== undefined) return liveDurationMs(a) + c.actionTimeout;
  return c.navigationTimeout;
}

// ---------------------------------------------------------------------------------------------------
// Finding videos

interface Vid {
  frame: Frame;
  handle: ElementHandle<HTMLVideoElement>;
  ref: number;
  label: string;
  state: VideoState;
  /** Rendered area in CSS px (0 when not visible). */
  area: number;
  note?: string;
}

async function refFor(ctx: CallCtx, frame: Frame, handle: ElementHandle<HTMLVideoElement>): Promise<number> {
  const r = await call(frame, 'describe', handle as unknown as ElementHandle<Element>, true);
  // Fix round 5 (sec): the engine's node is validated before it is issued (role, name, id).
  const node = safeNode(r.value);
  if (!node || node.role === 'text') throw new ToolError('the page did not describe the video', 'run video list again');
  return issueRef(ctx.session, ctx.tab, frame, r.docId, node);
}

async function measure(ctx: CallCtx, frame: Frame, handle: ElementHandle<HTMLVideoElement>): Promise<Vid | null> {
  try {
    const state = cleanState(await handle.evaluate(readVideo));
    const box = state.visible ? await handle.boundingBox() : null;
    const ref = await refFor(ctx, frame, handle);
    return { frame, handle, ref, label: ctx.tab.frameLabel(frame), state, area: box ? box.width * box.height : 0 };
  } catch {
    return null; // detached or navigating
  }
}

/**
 * Every <video> in every frame (open shadow roots pierced), in frame order. Round 7 (item 4): one budget per
 * frame. Round 7b (C2): a frame that did not answer is not "no video": it is returned in `unavailable`.
 */
async function allVideos(ctx: CallCtx): Promise<{ videos: Vid[]; unavailable: Frame[]; searched: number }> {
  const out: Vid[] = [];
  const unavailable: Frame[] = [];
  const frames = ctx.tab.page.frames().filter((f) => !f.isDetached());
  for (const frame of frames) {
    const found = await askFrame(frame, frame.$$('video'), FRAME_BUDGET_MS);
    if (found.state !== 'answered') {
      if (found.state === 'unanswered') unavailable.push(frame);
      continue;
    }
    let late = false;
    for (const h of found.value as ElementHandle<HTMLVideoElement>[]) {
      const v = await askFrame(frame, measure(ctx, frame, h), FRAME_BUDGET_MS);
      if (v.state === 'answered' && v.value) out.push(v.value);
      else {
        late ||= v.state === 'unanswered';
        await h.dispose().catch(() => undefined);
      }
    }
    if (late) unavailable.push(frame);
  }
  return { videos: out, unavailable, searched: frames.length };
}

/** `; 1 frame unavailable (no answer within 500 ms): f2` after a video count, or nothing. */
function unavailableNote(ctx: CallCtx, frames: Frame[]): string {
  return frames.length > 0 ? `; ${unavailableFrames(frames.map((f) => ctx.tab.frameLabel(f)))}` : '';
}

/** Default video: the largest visible playing one, else the largest visible one. */
export function pickDefault<T extends { state: Pick<VideoState, 'paused' | 'ended' | 'visible'>; area: number }>(vids: T[]): T | undefined {
  const visible = vids.filter((v) => v.state.visible && v.area > 0);
  const largest = (l: T[]) => l.reduce<T | undefined>((best, v) => (!best || v.area > best.area ? v : best), undefined);
  return largest(visible.filter((v) => !v.state.paused && !v.state.ended)) ?? largest(visible);
}

const NO_VIDEO_HINT = 'navigate to a page with a video, or wait for it to load (wait target=video), then video list';

async function resolveVideo(ctx: CallCtx, target: string | undefined): Promise<Vid> {
  if (target) {
    const t = await resolveElement(ctx.session, ctx.tab, target, { timeoutMs: capMs(ctx, ctx.config.actionTimeout) });
    // Round 7 (item 6): a main-world evaluation; its error never carries page text.
    if (!(await mainWorld(t.handle.evaluate(isVideo), 'check the video'))) {
      throw new ToolError(`${t.desc} is not a video`, 'pass a ref from video list, or omit target for the default video');
    }
    const handle = t.handle as unknown as ElementHandle<HTMLVideoElement>;
    const v = await measure(ctx, t.frame, handle);
    if (!v) throw new ToolError(`${t.desc} was removed from the page`, 'run video list for current refs');
    if (t.note) v.note = t.note;
    return v;
  }
  const { videos: all, unavailable, searched } = await allVideos(ctx);
  const pick = pickDefault(all);
  for (const v of all) if (v !== pick) await v.handle.dispose().catch(() => undefined);
  if (pick) return pick;
  if (all.length === 0) {
    throw new ToolError(
      `no video on the page (searched ${searched} frames${unavailableNote(ctx, unavailable)})`,
      unavailable.length > 0 ? `a frame that did not answer may hold the video: retry, or ${NO_VIDEO_HINT}` : NO_VIDEO_HINT,
    );
  }
  throw new ToolError(`${all.length} video(s) on the page, none visible`, 'pass target=<ref> from video list, or scroll/open the player first');
}

function needMetadata(v: Vid): void {
  if (Number.isNaN(v.state.duration)) {
    throw new ToolError(`e${v.ref} has no metadata yet (readyState ${v.state.ready})`, 'wait for the video to load (or play it), then retry');
  }
}

function checkInRange(v: Vid, t: number, what: string): void {
  const d = v.state.duration;
  if (Number.isFinite(d) && t > d + 0.001) {
    throw new ToolError(`${what} ${num(t)} is past the end of e${v.ref} (duration ${d.toFixed(2)})`, `use a time between 0 and ${d.toFixed(2)}`);
  }
}

/** A control error from the page (its own error name and message: page text, G5), or null. */
async function ctl(v: Vid, c: Control): Promise<string | null> {
  const err: unknown = await v.handle.evaluate(controlVideo, c);
  return err === null || err === undefined ? null : pageText(err);
}

// ---------------------------------------------------------------------------------------------------
// Capture

interface Metrics {
  cssVisualViewport: { pageX: number; pageY: number };
}

interface Shot {
  data: string;
  black: boolean | undefined;
}

class Capturer {
  private dpr = 1;
  private cdp: CDPSession | undefined;
  /**
   * Review P9: a jpeg frame needs a second (png) capture for the black check. Probe the first frame of
   * the call; keep probing only while frames come back black (DRM), otherwise skip the extra capture.
   */
  private probeJpeg = true;
  constructor(
    private readonly tab: Tab,
    private readonly format: 'jpeg' | 'png',
    private readonly maxEdge: number,
  ) {}

  async init(): Promise<void> {
    this.cdp = await this.tab.cdp();
    this.dpr = await mainWorld(this.tab.page.evaluate(() => window.devicePixelRatio), 'read the device pixel ratio');
  }

  async shot(v: Vid): Promise<Shot> {
    const cdp = this.cdp;
    if (!cdp) throw new Error('capturer not initialised');
    const box = await v.handle.boundingBox();
    if (!box || box.width < 1 || box.height < 1) throw new ToolError(`e${v.ref} has no visible box`, 'scroll the video into view or open its player, then retry');
    const m = (await cdp.send('Page.getLayoutMetrics')) as Metrics;
    const clip = { x: box.x + m.cssVisualViewport.pageX, y: box.y + m.cssVisualViewport.pageY, width: box.width, height: box.height };
    const params: Record<string, unknown> = {
      format: this.format,
      clip: { ...clip, scale: clipScale(box.width, box.height, this.dpr, this.maxEdge) },
      captureBeyondViewport: true,
    };
    if (this.format === 'jpeg') params.quality = JPEG_QUALITY;
    const { data } = (await cdp.send('Page.captureScreenshot', params)) as { data: string };
    let probe: Buffer;
    if (this.format === 'png') {
      probe = Buffer.from(data, 'base64');
    } else {
      if (!this.probeJpeg) return { data, black: undefined };
      const p = (await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...clip, scale: clipScale(box.width, box.height, this.dpr, PROBE_EDGE) },
        captureBeyondViewport: true,
      })) as { data: string };
      probe = Buffer.from(p.data, 'base64');
    }
    const raster = decodePng(probe);
    const black = raster ? isAllBlack(raster) : undefined;
    if (this.format === 'jpeg' && black !== true) this.probeJpeg = false;
    return { data, black };
  }
}

// ---------------------------------------------------------------------------------------------------
// Tool

const shape = {
  action: z.enum(['list', 'play', 'pause', 'seek', 'set', 'frames', 'captions']),
  target: z.string().optional().describe('Video ref from video list/snapshot, or a selector; default: the largest visible playing video, else the largest visible one'),
  tab: tabArg,
  time: z.number().min(0).optional().describe('seek: time in seconds'),
  rate: z.number().min(0.0625).max(16).optional().describe('set: playback rate'),
  muted: z.boolean().optional().describe('set'),
  volume: z.number().min(0).max(1).optional().describe('set: 0..1'),
  loop: z.boolean().optional().describe('set'),
  times: z.array(z.number().min(0)).min(1).max(MAX_FRAMES).optional().describe('frames: seek to each time (s) and capture'),
  count: z.number().int().min(1).max(MAX_FRAMES).optional().describe('frames: evenly spaced frames over [start, end] (default 6)'),
  start: z.number().min(0).optional().describe('frames with count / captions: window start (s)'),
  end: z.number().min(0).optional().describe('frames with count / captions: window end (s)'),
  every_ms: z.number().int().min(50).max(60000).optional().describe('frames: sample every N ms while the video plays in real time'),
  duration_ms: z.number().int().min(1).max(600000).optional().describe('frames with every_ms: how long to sample'),
  max_edge: z.number().int().min(16).max(10000).optional().describe('frames: long edge of each image in px (default 1280)'),
  format: z.enum(['jpeg', 'png']).optional().describe('frames: jpeg (default) or png'),
  save: z.boolean().optional().describe('frames: also write each image under <output-dir>/frames/'),
  timeout_ms: timeoutArg,
};

type Args = z.infer<z.ZodObject<typeof shape>>;

interface Framed {
  label: string;
  shot: Shot;
}

async function frameContent(ctx: CallCtx, v: Vid, a: Args, header: string, frames: Framed[], tail: string[]): Promise<Content[]> {
  const format = a.format ?? 'jpeg';
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const content: Content[] = [{ type: 'text', text: header }];
  let dir: string | undefined;
  if (a.save && frames.length > 0) {
    dir = join(ctx.config.outputDir, 'frames');
    await mkdir(dir, { recursive: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const [i, f] of frames.entries()) {
    let line = `frame ${i + 1}/${frames.length} @ ${f.label}`;
    if (f.shot.black === true) line += ' black (all-black frame: DRM-protected, or not decoded yet)';
    if (dir) {
      const path = uniquePathIn(dir, `${ctx.tab.id}-e${v.ref}-${stamp}-${i + 1}.${format === 'png' ? 'png' : 'jpg'}`);
      await writeFile(path, Buffer.from(f.shot.data, 'base64'));
      line += ` saved ${path}`;
    }
    content.push({ type: 'text', text: line });
    content.push({ type: 'image', data: f.shot.data, mimeType });
  }
  if (tail.length > 0) content.push({ type: 'text', text: tail.join('\n') });
  return content;
}

async function sampleLive(ctx: CallCtx, v: Vid, cap: Capturer, everyMs: number, durationMs: number, stopAt: number): Promise<{ frames: Framed[]; tail: string[] }> {
  const tail: string[] = [];
  const wasPaused = v.state.paused;
  if (wasPaused) {
    const err = await ctl(v, { op: 'play', timeoutMs: capMs(ctx, Math.min(ctx.config.actionTimeout, 5000)) });
    if (err) throw new ToolError(`e${v.ref} is paused and play() failed: ${jsonQuote(err)}`, 'set muted=true (autoplay policy) or click the player, then retry');
    tail.push('started playback for sampling; paused again afterwards');
  }
  const frames: Framed[] = [];
  try {
    const t0 = Date.now();
    for (const off of sampleTicks(everyMs, durationMs)) {
      const due = t0 + off;
      if (due > stopAt) {
        tail.push(`stopped at the call budget after ${frames.length} frames`);
        break;
      }
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      else if (frames.length > 0 && wait < -everyMs / 2) continue; // capture overran this tick: skip it
      const time = await v.handle.evaluate((el) => el.currentTime);
      frames.push({ label: fmtClock(time), shot: await cap.shot(v) });
    }
  } finally {
    if (wasPaused) await ctl(v, { op: 'pause' }).catch(() => undefined);
  }
  return { frames, tail };
}

async function seekCapture(ctx: CallCtx, v: Vid, cap: Capturer, times: number[], stopAt: number): Promise<{ frames: Framed[]; tail: string[] }> {
  const tail: string[] = [];
  const frames: Framed[] = [];
  const before = { time: v.state.time, paused: v.state.paused };
  if (!before.paused) await ctl(v, { op: 'pause' });
  try {
    for (const t of times) {
      const left = stopAt - Date.now();
      if (left < 200) {
        tail.push(`stopped at the call budget after ${frames.length}/${times.length} frames`);
        break;
      }
      const r = cleanSeek(await v.handle.evaluate(seekAndPresent, { time: t, timeoutMs: capMs(ctx, Math.min(left, ctx.config.actionTimeout)) }));
      const shot = await cap.shot(v);
      let label = fmtClock(r.time);
      if (r.ready < 2 || !r.seeked) label += ` not-ready (seeked=${r.seeked} readyState=${r.ready})`;
      frames.push({ label, shot });
    }
  } finally {
    const ok = await v.handle
      .evaluate(restoreVideo, { time: before.time, paused: before.paused, timeoutMs: capMs(ctx, 1000) })
      .catch(() => false);
    tail.push(ok ? `restored time=${before.time.toFixed(2)} paused=${before.paused}` : `could not fully restore time=${before.time.toFixed(2)} paused=${before.paused}`);
  }
  return { frames, tail };
}

async function frames(ctx: CallCtx, v: Vid, a: Args, budget: number, t0: number): Promise<Content[]> {
  const modes = [a.times !== undefined, a.every_ms !== undefined].filter(Boolean).length;
  if (modes > 1) throw new ToolError('times and every_ms cannot be combined', 'pass times (seek), count (spread) or every_ms + duration_ms (sampling)');
  const stopAt = t0 + budget - 300;
  const cap = new Capturer(ctx.tab, a.format ?? 'jpeg', a.max_edge ?? DEFAULT_MAX_EDGE);
  await frontFor(ctx, ctx.tab);
  await v.handle.scrollIntoViewIfNeeded({ timeout: capMs(ctx, 2000) }).catch(() => undefined);
  await cap.init();
  const head = (how: string) => `[${ctx.tab.id}] video e${v.ref} frame=${v.label} frames (${how})`;
  const live = v.state.duration === Infinity;
  if (a.every_ms !== undefined || (live && a.times === undefined)) {
    const every = a.every_ms ?? LIVE_FALLBACK_EVERY_MS;
    let dur = a.every_ms !== undefined ? liveDurationMs(a) : every * ((a.count ?? DEFAULT_COUNT) - 1);
    dur = Math.min(dur, Math.max(0, stopAt - Date.now() - 1000));
    const r = await sampleLive(ctx, v, cap, every, dur, stopAt);
    const how = a.every_ms !== undefined ? `every ${every}ms for ${dur}ms` : `live stream: sampling every ${every}ms`;
    return frameContent(ctx, v, a, head(how), r.frames, r.tail);
  }
  needMetadata(v);
  let times: number[];
  let how: string;
  if (a.times) {
    for (const t of a.times) checkInRange(v, t, 'time');
    times = a.times;
    how = 'times';
  } else {
    const start = a.start ?? 0;
    const end = a.end ?? v.state.duration;
    checkInRange(v, start, 'start');
    checkInRange(v, end, 'end');
    if (!(end > start)) throw new ToolError(`start ${num(start)} is not before end ${num(end)}`, 'pass start < end (seconds)');
    times = countTimes(a.count ?? DEFAULT_COUNT, start, end);
    how = `count over ${fmtClock(start)}-${fmtClock(end)}`;
  }
  const r = await seekCapture(ctx, v, cap, times, stopAt);
  return frameContent(ctx, v, a, head(how), r.frames, r.tail);
}

async function captions(ctx: CallCtx, v: Vid, a: Args): Promise<string> {
  const tracks = cleanTracks(await v.handle.evaluate(readCaptions, { timeoutMs: capMs(ctx, Math.min(3000, ctx.config.actionTimeout)) }));
  const head = `[${ctx.tab.id}] video e${v.ref} captions (untrusted page content)`;
  if (tracks.length === 0) {
    return `${head}\nno text tracks (captions drawn by a site's own player are not text tracks; try read or snapshot of the caption area)`;
  }
  const lo = a.start ?? 0;
  const hi = a.end ?? Infinity;
  const out = [head];
  tracks.forEach((t, i) => {
    const meta = `track ${i + 1} kind=${jsonQuote(t.kind)}${t.label ? ` label=${q(t.label)}` : ''}${t.lang ? ` lang=${jsonQuote(t.lang)}` : ''}`;
    if (t.cues === null) {
      out.push(`${meta} cues=unavailable (not loaded)`);
      return;
    }
    const inWin = t.cues.filter((c) => c.end >= lo && c.start <= hi);
    out.push(`${meta} cues=${t.cues.length}${inWin.length !== t.cues.length ? ` in-window=${inWin.length}` : ''}`);
    for (const c of inWin) out.push(`${fmtClock(c.start)}-${fmtClock(c.end)} ${jsonQuote(c.text)}`);
  });
  return capText(out.join('\n'), ctx.config.maxOutputChars);
}

async function state(v: Vid): Promise<string> {
  const s = cleanState(await v.handle.evaluate(readVideo));
  return listLine(v.ref, v.label, s);
}

export const video = defineTool({
  name: 'video',
  description:
    'Watch videos on the page (all frames, incl. cross-origin iframes). list: one line per video (ref, frame, src, duration, time, paused, muted, volume, rate, size, readyState, text tracks). play/pause/seek(time)/set(rate, muted, volume, loop). frames: images by element screenshot, each preceded by "frame i/n @ mm:ss.ss": times=[s…] (seek each), count (default 6, evenly spaced over start..end), or every_ms + duration_ms (sample while playing); seek-based capture restores time and paused state; all-black frames (DRM) are flagged. captions: text-track cues as "mm:ss.ss-mm:ss.ss text", optional start/end window. Default target: the largest visible playing video, else the largest visible one.',
  shape,
  annotations: { openWorldHint: true },
  scope: 'tab',
  targetKeys: ['target'],
  timeoutMs: (a, c) => videoBudget(a, c),
  async handler(a, ctx) {
    const t0 = Date.now();
    const budget = videoBudget(a, ctx.config);
    const tab = ctx.tab;
    if (a.action === 'list') {
      const { videos: all, unavailable, searched } = await allVideos(ctx);
      const def = pickDefault(all);
      const ordered = def ? [def, ...all.filter((v) => v !== def)] : all;
      const lines = ordered.map((v) => listLine(v.ref, v.label, v.state));
      for (const v of all) await v.handle.dispose().catch(() => undefined);
      // Round 7b (C2): with frames that did not answer, a count is not a clean one.
      const note = unavailableNote(ctx, unavailable);
      if (all.length === 0) return `[${tab.id}] 0 videos on the page (searched ${searched} frames${note}); ${NO_VIDEO_HINT}`;
      const which = def ? 'the first line is the default video' : 'none is visible, so pass target';
      return capText(`[${tab.id}] ${all.length} video(s)${note} (untrusted page content); ${which}\n${lines.join('\n')}`, ctx.config.maxOutputChars);
    }
    const v = await resolveVideo(ctx, a.target);
    const pre = v.note ? `${v.note}\n` : '';
    try {
      switch (a.action) {
        case 'play': {
          const err = await ctl(v, { op: 'play', timeoutMs: capMs(ctx, Math.max(100, budget - 1000)) });
          if (err) throw new ToolError(`play() on e${v.ref} failed: ${jsonQuote(err)}`, 'set muted=true (autoplay policy) or click the player, then retry');
          return `${pre}[${tab.id}] video play\n${await state(v)}`;
        }
        case 'pause':
          await ctl(v, { op: 'pause' });
          return `${pre}[${tab.id}] video pause\n${await state(v)}`;
        case 'seek': {
          if (a.time === undefined) throw new ToolError('seek needs time (seconds)', 'pass time, e.g. video action=seek time=12.5');
          needMetadata(v);
          checkInRange(v, a.time, 'time');
          const r = cleanSeek(await v.handle.evaluate(seekAndPresent, { time: a.time, timeoutMs: capMs(ctx, Math.max(100, budget - 1000)) }));
          const warn = r.seeked && r.ready >= 2 ? '' : ` (not ready yet: seeked=${r.seeked} readyState=${r.ready})`;
          return `${pre}[${tab.id}] video seek ${fmtClock(a.time)}${warn}\n${await state(v)}`;
        }
        case 'set': {
          const c: Control = { op: 'set', rate: a.rate, muted: a.muted, volume: a.volume, loop: a.loop };
          if (a.rate === undefined && a.muted === undefined && a.volume === undefined && a.loop === undefined) {
            throw new ToolError('set needs at least one of rate, muted, volume, loop', 'e.g. video action=set rate=1.5 muted=false');
          }
          await ctl(v, c);
          return `${pre}[${tab.id}] video set\n${await state(v)}`;
        }
        case 'captions':
          return pre + (await captions(ctx, v, a));
        case 'frames': {
          const content = await frames(ctx, v, a, budget, t0);
          const first = content[0];
          if (pre && first?.type === 'text') content[0] = { type: 'text', text: pre + first.text };
          return { content };
        }
      }
    } catch (e) {
      if (e instanceof ToolError) throw e;
      // Round 6 (item 6): a video's evaluations run in the page's main world; their errors are page text.
      const m = mainWorldError(e, `video ${a.action}`);
      if (!(m instanceof ToolError)) throw m;
      throw new ToolError(`video ${a.action} on e${v.ref} failed: the page's script failed`, 'run video list to check the video, then retry');
    } finally {
      await v.handle.dispose().catch(() => undefined);
    }
  },
});
