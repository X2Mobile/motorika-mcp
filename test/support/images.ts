// Image helpers for screenshot / frame checks: PNG decode (pngjs), JPEG dimensions from the SOF marker
// (no JPEG decoder is pinned), pixel sampling and diffing.
import { PNG } from 'pngjs';

export type RGB = [number, number, number];

export function decodePng(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

export function pixelAt(img: PNG, x: number, y: number): RGB {
  const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

export function centerPixel(png: Buffer): RGB {
  const img = decodePng(png);
  return pixelAt(img, img.width / 2, img.height / 2);
}

export function near(a: number[], b: number[], tol = 40): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= tol);
}

/** Width/height of a JPEG from its first SOFn segment. */
export function jpegSize(buf: Buffer): { width: number; height: number } {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error(`bad JPEG marker at ${i}`);
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('no SOF marker');
}

export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function imageSize(data: Buffer, mimeType: string): { width: number; height: number } {
  return mimeType === 'image/png' ? pngSize(data) : jpegSize(data);
}

/** Number of pixels whose max channel difference exceeds `tol` (images must be the same size). */
export function diffPixels(a: Buffer, b: Buffer, tol = 30): number {
  const A = decodePng(a);
  const B = decodePng(b);
  if (A.width !== B.width || A.height !== B.height) throw new Error('size mismatch');
  let n = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    if (
      Math.abs(A.data[i]! - B.data[i]!) > tol ||
      Math.abs(A.data[i + 1]! - B.data[i + 1]!) > tol ||
      Math.abs(A.data[i + 2]! - B.data[i + 2]!) > tol
    )
      n += 1;
  }
  return n;
}
