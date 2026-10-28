import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Frame } from 'playwright-core';
import { z } from 'zod';
import type { ShotMap } from '../browser/tabs.js';
import { FRAME_BUDGET_MS, call, inTime, mainWorld } from '../page/engine.js';
import { buildSnapshot } from '../page/snapshot.js';
import { resolveElement, type Target } from '../page/target.js';
import { ToolError } from '../util/errors.js';
import { uniquePathIn } from '../util/paths.js';
import { assertNotCrashed, disposeTargets, unlessCrash, capMs } from './common.js';
import { defineTool, tabArg, type CallCtx, type ToolResult } from './types.js';

interface Metrics {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  cssContentSize: { width: number; height: number };
}

/** Clip scale so that the long output edge (CSS × scale × dpr) is at most maxEdge. Never upscales. */
export function clipScale(cssW: number, cssH: number, dpr: number, maxEdge: number): number {
  const longPx = Math.max(cssW, cssH) * dpr;
  if (longPx <= 0) return 1;
  return Math.min(1, maxEdge / longPx);
}

/**
 * P3: the pixel size of the image actually delivered (PNG IHDR, JPEG SOFn), so the header and the x,y
 * mapping describe the bytes, not a size computed from devicePixelRatio. null when unreadable.
 */
export function imagePixels(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1] as number;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

export function fmtScale(r: number): string {
  return String(Math.round(r * 1000) / 1000);
}

const shape = {
  tab: tabArg,
  target: z.string().optional(),
  full_page: z.boolean().optional(),
  annotate: z.boolean().optional(),
  format: z.enum(['jpeg', 'png']).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  max_edge: z.number().int().min(16).max(10000).optional(),
  save: z.boolean().optional(),
};
type ScreenshotArgs = z.infer<z.ZodObject<typeof shape>>;

export const screenshot = defineTool({
  name: 'screenshot',
  description:
    'Screenshot of the viewport (default), the full page, or a target element. Default jpeg quality 70, long edge at most max_edge (1280). Afterwards, "x,y" targets use this image\'s pixel coordinates. annotate draws each visible ref label on its element (removed before returning). save writes it under <output-dir>/screenshots/.',
  shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  scope: 'tab',
  targetKeys: ['target'],
  async handler(a, ctx) {
    const tab = ctx.tab;
    // A crashed renderer never answers a capture: fail at once instead of hanging (crashed-tab review).
    assertNotCrashed(tab);
    return unlessCrash(tab, shoot(a, ctx));
  },
});

async function shoot(a: ScreenshotArgs, ctx: CallCtx): Promise<ToolResult> {
  const tab = ctx.tab;
  const page = tab.page;
  const format = a.format ?? 'jpeg';
  const maxEdge = a.max_edge ?? 1280;
  const cdp = await tab.cdp();
  const annotated: Frame[] = [];
  let target: Target | undefined;
  try {
    if (a.annotate) {
      const collect: { frame: Frame; localId: number; ref: number }[] = [];
      await buildSnapshot(ctx.session, tab, { mode: 'interactive', viewportOnly: !a.full_page, collect });
      const byFrame = new Map<Frame, [number, number][]>();
      for (const c of collect) {
        const l = byFrame.get(c.frame) ?? [];
        l.push([c.localId, c.ref]);
        byFrame.set(c.frame, l);
      }
      for (const [f, items] of byFrame) {
        // Round 7 (item 4): one budget per frame.
        await inTime(call(f, 'annotate', items), FRAME_BUDGET_MS, undefined);
        annotated.push(f);
      }
    }
    const m = (await cdp.send('Page.getLayoutMetrics')) as Metrics;
    const dpr = await mainWorld(page.evaluate(() => window.devicePixelRatio), 'read the device pixel ratio');
    const vv = m.cssVisualViewport;
    let x = vv.pageX;
    let y = vv.pageY;
    let w = vv.clientWidth;
    let h = vv.clientHeight;
    let pageCoords = false;
    if (a.target) {
      const t = await resolveElement(ctx.session, tab, a.target, { timeoutMs: capMs(ctx, ctx.config.actionTimeout) });
      target = t;
      await t.handle.scrollIntoViewIfNeeded({ timeout: capMs(ctx, ctx.config.actionTimeout) }).catch(() => undefined);
      const box = await t.handle.boundingBox();
      if (!box) throw new ToolError(`${t.desc} has no visible box`, 'take a screenshot of the viewport instead');
      const m2 = (await cdp.send('Page.getLayoutMetrics')) as Metrics;
      x = box.x + m2.cssVisualViewport.pageX;
      y = box.y + m2.cssVisualViewport.pageY;
      w = box.width;
      h = box.height;
      pageCoords = true;
    } else if (a.full_page) {
      x = 0;
      y = 0;
      w = m.cssContentSize.width;
      h = m.cssContentSize.height;
      pageCoords = true;
    }
    w = Math.max(1, w);
    h = Math.max(1, h);
    const capture = async (scale: number): Promise<{ data: string; size: { width: number; height: number } | null }> => {
      const params: Record<string, unknown> = {
        format,
        clip: { x, y, width: w, height: h, scale },
        captureBeyondViewport: pageCoords,
      };
      if (format === 'jpeg') params.quality = a.quality ?? 70;
      const r = (await cdp.send('Page.captureScreenshot', params)) as { data: string };
      return { data: r.data, size: imagePixels(Buffer.from(r.data, 'base64')) };
    };
    // P3: Chrome does not always capture at window.devicePixelRatio (Playwright's viewport emulation says 1
    // on a 2x retina screen; an emulated deviceScaleFactor 2 captures at 1). The delivered bytes are
    // measured; when they show another device factor, the capture is retaken once with that factor, so
    // max_edge holds. The header and the x,y mapping always describe the delivered image.
    let scale = clipScale(w, h, dpr, maxEdge);
    let shot = await capture(scale);
    if (shot.size && Math.abs(shot.size.width - Math.round(w * scale * dpr)) > 1) {
      const factor = shot.size.width / (w * scale);
      const again = clipScale(w, h, factor, maxEdge);
      if (Math.abs(again - scale) > 1e-6) {
        scale = again;
        shot = await capture(scale);
      }
    }
    const outW = shot.size?.width ?? Math.round(w * scale * dpr);
    const outH = shot.size?.height ?? Math.round(h * scale * dpr);
    const ratio = outW / w;
    const map: ShotMap = pageCoords ? { ratio, originX: x, originY: y, page: true } : { ratio, originX: 0, originY: 0, page: false };
    tab.lastShot = map;
    let text = `[${tab.id}] screenshot ${outW}x${outH} scale=${fmtScale(ratio)}; x,y targets use this image's pixels`;
    if (a.save) {
      const dir = join(ctx.config.outputDir, 'screenshots');
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = uniquePathIn(dir, `${tab.id}-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`);
      await writeFile(path, Buffer.from(shot.data, 'base64'));
      text += `\nsaved ${path}`;
    }
    return {
      content: [
        { type: 'text', text },
        { type: 'image', data: shot.data, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' },
      ],
    };
  } finally {
    for (const f of annotated) await inTime(call(f, 'unannotate'), FRAME_BUDGET_MS, undefined);
    disposeTargets(target);
  }
}
