// Minimal PNG reader for the video tool's black-frame probe: 8-bit, non-interlaced, colour types
// 0 (gray), 2 (RGB), 4 (gray+alpha), 6 (RGBA); all five scanline filters. Anything else returns null
// (the caller then reports nothing rather than a guess). node:zlib only: no runtime dependency.
import { inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export interface Raster {
  width: number;
  height: number;
  /** RGB triples, row-major. */
  rgb: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Raster | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let ctype = -1;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8] ?? 0;
      ctype = data[9] ?? -1;
      interlace = data[12] ?? 0;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const ch = CHANNELS[ctype];
  if (!ch || depth !== 8 || interlace !== 0 || width === 0 || height === 0) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * ch;
  if (raw.length < (stride + 1) * height) return null;
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base] ?? 0;
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i] ?? 0;
      const a = i >= ch ? (cur[i - ch] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= ch ? (prev[i - ch] ?? 0) : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4:
          v = x + paeth(a, b, c);
          break;
        default:
          return null;
      }
      cur[i] = v & 0xff;
    }
    for (let px = 0; px < width; px++) {
      const o = (y * width + px) * 3;
      if (ch >= 3) {
        rgb[o] = cur[px * ch] ?? 0;
        rgb[o + 1] = cur[px * ch + 1] ?? 0;
        rgb[o + 2] = cur[px * ch + 2] ?? 0;
      } else {
        const g = cur[px * ch] ?? 0;
        rgb[o] = g;
        rgb[o + 1] = g;
        rgb[o + 2] = g;
      }
    }
    prev.set(cur);
  }
  return { width, height, rgb };
}

/** All pixels at most `max` on every channel (default 16 of 255: black within codec noise). */
export function isAllBlack(r: Raster, max = 16): boolean {
  for (let i = 0; i < r.rgb.length; i++) if ((r.rgb[i] ?? 0) > max) return false;
  return true;
}
