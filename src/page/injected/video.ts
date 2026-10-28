// In-page functions for the video tool. They are passed to Playwright's handle.evaluate (serialised with
// Function.prototype.toString and run through CDP, so page CSP does not apply), NOT bundled into the
// engine IIFE. Rule: every function here is self-contained. No imports, no module-scope helpers, no
// eval/innerHTML. Each wait carries its own timeout.

export interface VideoState {
  src: string;
  /** NaN before metadata, Infinity for a live stream. */
  duration: number;
  time: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  muted: boolean;
  volume: number;
  rate: number;
  loop: boolean;
  width: number;
  height: number;
  ready: number;
  tracks: number;
  /** checkVisibility() with visibility:hidden honoured (contract answer 3). */
  visible: boolean;
}

export function readVideo(el: HTMLVideoElement): VideoState {
  const cv = (el as { checkVisibility?: (o?: { visibilityProperty?: boolean }) => boolean }).checkVisibility;
  const r = el.getBoundingClientRect();
  const visible = (cv ? cv.call(el, { visibilityProperty: true }) : true) && r.width > 0 && r.height > 0;
  return {
    src: el.currentSrc || el.src || '',
    duration: el.duration,
    time: el.currentTime,
    paused: el.paused,
    ended: el.ended,
    seeking: el.seeking,
    muted: el.muted,
    volume: el.volume,
    rate: el.playbackRate,
    loop: el.loop,
    width: el.videoWidth,
    height: el.videoHeight,
    ready: el.readyState,
    tracks: el.textTracks ? el.textTracks.length : 0,
    visible,
  };
}

export function isVideo(el: Element): boolean {
  return el.tagName === 'VIDEO';
}

export interface SeekResult {
  time: number;
  ready: number;
  seeked: boolean;
  /** How the presented frame was awaited: requestVideoFrameCallback, two rAFs, or neither (timeout). */
  presented: 'rvfc' | 'raf' | 'timeout';
}

/**
 * Seek to `time` and wait until a decoded frame is on screen:
 * 1. `seeked` (or !seeking) and readyState >= 2 (HAVE_CURRENT_DATA), otherwise the capture is black;
 * 2. a presented frame via requestVideoFrameCallback (registered BEFORE the seek, so a frame presented
 *    before we listen is not missed), else two animation frames.
 * Every wait is bounded by `timeoutMs` in total.
 */
export async function seekAndPresent(el: HTMLVideoElement, a: { time: number; timeoutMs: number }): Promise<SeekResult> {
  const t0 = performance.now();
  const left = () => Math.max(0, a.timeoutMs - (performance.now() - t0));
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const rvfc = (el as { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
  let framePresented = false;
  if (typeof rvfc === 'function') rvfc.call(el, () => (framePresented = true));
  let seekedFired = false;
  const onSeeked = () => (seekedFired = true);
  el.addEventListener('seeked', onSeeked, { once: true });
  el.currentTime = a.time;
  try {
    // 1. seeked + readyState >= 2 (polled: `seeked` alone is not enough when data arrives later).
    while (left() > 0 && !((seekedFired || !el.seeking) && el.readyState >= 2)) await sleep(10);
    const seeked = seekedFired || !el.seeking;
    // 2. a presented frame.
    let presented: SeekResult['presented'] = 'timeout';
    if (typeof rvfc === 'function') {
      const cap = Math.min(left(), 1000);
      const start = performance.now();
      while (!framePresented && performance.now() - start < cap) await sleep(10);
      if (framePresented) presented = 'rvfc';
    }
    if (presented === 'timeout' && left() > 0) {
      const raf = () =>
        Promise.race([new Promise<void>((r) => requestAnimationFrame(() => r())), sleep(Math.min(left(), 200))]);
      await raf();
      await raf();
      presented = 'raf';
    }
    return { time: el.currentTime, ready: el.readyState, seeked, presented };
  } finally {
    el.removeEventListener('seeked', onSeeked);
  }
}

/** Put time and paused state back (after seek-based capture). Bounded by timeoutMs. */
export async function restoreVideo(el: HTMLVideoElement, a: { time: number; paused: boolean; timeoutMs: number }): Promise<boolean> {
  const t0 = performance.now();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let seeked = false;
  const onSeeked = () => (seeked = true);
  el.addEventListener('seeked', onSeeked, { once: true });
  el.currentTime = a.time;
  while (performance.now() - t0 < a.timeoutMs && !(seeked || !el.seeking)) await sleep(10);
  el.removeEventListener('seeked', onSeeked);
  if (!a.paused) {
    const p = el.play();
    await Promise.race([p.catch(() => undefined), sleep(Math.max(0, a.timeoutMs - (performance.now() - t0)))]);
  }
  return Math.abs(el.currentTime - a.time) < 0.05 && el.paused === a.paused;
}

export type Control =
  | { op: 'play'; timeoutMs: number }
  | { op: 'pause' }
  | { op: 'set'; rate?: number; muted?: boolean; volume?: number; loop?: boolean };

/** play/pause/set. Returns an error string (play() rejection) or null. */
export async function controlVideo(el: HTMLVideoElement, c: Control): Promise<string | null> {
  if (c.op === 'pause') {
    el.pause();
    return null;
  }
  if (c.op === 'set') {
    if (c.rate !== undefined) el.playbackRate = c.rate;
    if (c.muted !== undefined) el.muted = c.muted;
    if (c.volume !== undefined) el.volume = c.volume;
    if (c.loop !== undefined) el.loop = c.loop;
    return null;
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<string>((r) => (timer = setTimeout(() => r('timeout'), c.timeoutMs)));
    const res = await Promise.race([el.play().then(() => 'ok'), timedOut]);
    clearTimeout(timer);
    if (res === 'timeout' && el.paused) return `play() did not start within ${c.timeoutMs}ms (readyState ${el.readyState})`;
    return null;
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return `${err.name ?? 'Error'}: ${err.message ?? String(e)}`;
  }
}

export interface TrackCues {
  kind: string;
  label: string;
  lang: string;
  /** null when the track's cues did not load within the timeout. */
  cues: { start: number; end: number; text: string }[] | null;
}

/**
 * Cues of every text track (<track> and in-band). A disabled track has no cues, so it is switched to
 * `hidden` (loads cues, renders nothing), read, and switched back. Bounded by timeoutMs.
 */
export async function readCaptions(el: HTMLVideoElement, a: { timeoutMs: number }): Promise<TrackCues[]> {
  const t0 = performance.now();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const tracks = Array.from(el.textTracks ?? []);
  const before = tracks.map((t) => t.mode);
  for (const t of tracks) if (t.mode === 'disabled') t.mode = 'hidden';
  const trackEls = Array.from(el.querySelectorAll('track'));
  const loading = () =>
    tracks.some((t) => {
      if (t.cues !== null && t.cues.length > 0) return false;
      const te = trackEls.find((x) => x.track === t);
      // <track> readyState: 0 none, 1 loading, 2 loaded, 3 error. In-band tracks: wait for cues briefly.
      return te ? te.readyState < 2 : t.cues === null;
    });
  while (performance.now() - t0 < a.timeoutMs && loading()) await sleep(25);
  const out: TrackCues[] = tracks.map((t) => ({
    kind: t.kind,
    label: t.label,
    lang: t.language,
    cues:
      t.cues === null
        ? null
        : Array.from(t.cues).map((c) => {
            const raw = (c as { text?: string }).text ?? '';
            const text = raw.replace(/<[^>]*>/g, '').replace(/\s*\n\s*/g, ' ').trim();
            return { start: c.startTime, end: c.endTime, text };
          }),
  }));
  tracks.forEach((t, i) => {
    const m = before[i];
    if (m !== undefined && t.mode !== m) t.mode = m;
  });
  return out;
}
