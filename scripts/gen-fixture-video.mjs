#!/usr/bin/env node
// Generates the E1 fixture video: 6 s, 640x360, second k is a solid color COLOR_TABLE[k].
// Outputs (committed): test/fixtures/media/colors.webm, colors.mp4, colors.vtt.
//
// Encoders available in the pinned ffmpeg-static 5.3.0 (ffmpeg 6.0, darwin arm64), checked on
// 2026-10-21 with `ffmpeg -encoders`: libvpx-vp9, libvpx (VP8), libaom-av1, libsvtav1, libx264,
// libx264rgb, h264_videotoolbox, webvtt. So: WebM = VP9 (libvpx-vp9), MP4 = H.264 (libx264).
// The script re-checks at run time and falls back to VP8, then AV1, for WebM.
//
// Importing this module only exports the tables; it generates files only when run directly.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** RGB of second k (k = 0..5). Mid-saturation, pairwise far apart (> 100 on some channel). */
export const COLOR_TABLE = [
  [200, 40, 40], // 0 red
  [40, 180, 60], // 1 green
  [40, 60, 200], // 2 blue
  [210, 200, 50], // 3 yellow
  [190, 50, 190], // 4 magenta
  [50, 190, 200], // 5 cyan
];

export const VIDEO = { width: 640, height: 360, seconds: 6, fps: 30 };

/** Cues written to colors.vtt; E6 compares `captions` output against these timestamps. */
export const CUES = [
  { start: 0.0, end: 1.5, text: 'Caption one red' },
  { start: 2.0, end: 3.25, text: 'Caption two blue' },
  { start: 4.0, end: 5.75, text: 'Caption three magenta' },
];

export const MEDIA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'media');

const hex = ([r, g, b]) => '0x' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

function vttTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
}

export function vttText() {
  return ['WEBVTT', '', ...CUES.flatMap((c) => [`${vttTime(c.start)} --> ${vttTime(c.end)}`, c.text, ''])].join('\n');
}

async function main() {
  const { default: ffmpeg } = await import('ffmpeg-static');
  if (!ffmpeg) throw new Error('ffmpeg-static has no binary for this platform');
  const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const has = (name) => new RegExp(`\\s${name}\\s`).test(encoders);
  mkdirSync(MEDIA_DIR, { recursive: true });

  const inputs = [];
  for (const c of COLOR_TABLE) {
    inputs.push('-f', 'lavfi', '-i', `color=c=${hex(c)}:s=${VIDEO.width}x${VIDEO.height}:r=${VIDEO.fps}:d=1`);
  }
  const concat = ['-filter_complex', `${COLOR_TABLE.map((_, i) => `[${i}:v]`).join('')}concat=n=${COLOR_TABLE.length}:v=1:a=0[v]`, '-map', '[v]'];
  const common = ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, ...concat, '-pix_fmt', 'yuv420p', '-g', String(VIDEO.fps), '-keyint_min', String(VIDEO.fps), '-an'];

  let webmCodec;
  if (has('libvpx-vp9')) webmCodec = ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-row-mt', '1'];
  else if (has('libvpx')) webmCodec = ['-c:v', 'libvpx', '-b:v', '200k'];
  else if (has('libaom-av1')) webmCodec = ['-c:v', 'libaom-av1', '-crf', '45', '-b:v', '0', '-cpu-used', '8'];
  else throw new Error('no WebM encoder (libvpx-vp9 / libvpx / libaom-av1) in this ffmpeg');
  const webm = join(MEDIA_DIR, 'colors.webm');
  execFileSync(ffmpeg, [...common, ...webmCodec, webm]);

  const outputs = [webm];
  if (has('libx264')) {
    const mp4 = join(MEDIA_DIR, 'colors.mp4');
    execFileSync(ffmpeg, [...common, '-c:v', 'libx264', '-preset', 'medium', '-crf', '28', '-movflags', '+faststart', mp4]);
    outputs.push(mp4);
  } else {
    process.stderr.write('libx264 not available: no MP4 written\n');
  }

  const vtt = join(MEDIA_DIR, 'colors.vtt');
  writeFileSync(vtt, vttText());
  outputs.push(vtt);
  for (const f of outputs) {
    const size = statSync(f).size;
    if (size > 300 * 1024) throw new Error(`${f} is ${size} bytes, over the 300 KB budget`);
    process.stderr.write(`${f} ${size} B\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
