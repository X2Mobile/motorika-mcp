import { z } from 'zod';
import type { Tab } from '../browser/tabs.js';
import { activate } from '../browser/tabs.js';
import { ToolError } from '../util/errors.js';
import { assertNavigable, navigateTo, normalizeUrl } from './navigate.js';
import { defineTool, tabArg, type CallCtx } from './types.js';
import { titleQ } from '../util/format.js';
import { safeUrl } from '../util/secrets.js';

const titles = new WeakMap<Tab, string>();

async function titleOf(tab: Tab): Promise<string> {
  if (tab.dialog || tab.crashed) return titles.get(tab) ?? '';
  const t = await Promise.race([tab.page.title().catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 1000))]);
  if (t !== undefined) titles.set(tab, t);
  return t ?? titles.get(tab) ?? '';
}

export async function tabLine(tab: Tab, active: boolean): Promise<string> {
  const title = await titleOf(tab);
  return `${tab.id} ${titleQ(title)} ${safeUrl(tab.page.url())}${active ? ' (active)' : ''}${tab.dialog ? ` dialog=${tab.dialog.type}` : ''}${tab.crashed ? ' crashed' : ''}`;
}

async function list(ctx: CallCtx): Promise<string> {
  const tabs = ctx.session.clientTabs(ctx.client.id).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  if (tabs.length === 0) return 'no tabs open (tabs new or navigate opens one)';
  const lines = await Promise.all(tabs.map((t) => tabLine(t, t.id === ctx.client.active)));
  return lines.join('\n');
}

function owned(ctx: CallCtx, id: string | undefined): Tab {
  const tid = id ?? ctx.client.active;
  if (!tid) throw new ToolError('no active tab', 'open one with tabs new');
  const t = ctx.session.getTab(tid);
  if (!t || t.closed || !ctx.client.owned.has(tid)) throw new ToolError(`no open tab ${tid}`, 'call tabs list for the open tabs');
  return t;
}

export const tabs = defineTool({
  name: 'tabs',
  description:
    'Tabs: list ("t1 "Title" url (active)"), new (optionally at url, becomes active unless background:true; returns a viewport snapshot when url is given (call snapshot for the whole page)), select (make active; brings it to the front in headed mode), close (default the active tab; the previously active tab becomes active). Tab ids are never reused; popups are registered automatically.',
  shape: {
    action: z.enum(['list', 'new', 'select', 'close']),
    tab: tabArg,
    url: z.string().optional(),
    background: z.boolean().optional(),
  },
  annotations: { openWorldHint: true },
  scope: 'free',
  needsBrowser: (a) => a.action !== 'list',
  timeoutMs: (_a, c) => c.navigationTimeout,
  async handler(a, ctx) {
    const s = ctx.session;
    if (a.action === 'list') {
      // Launch modes stay lazy; attach modes connect so the existing tabs get ids.
      if (!s.running && !s.isAttach) return 'no tabs open (the browser starts on the first page action)';
      await s.ensure();
      return list(ctx);
    }
    if (a.action === 'new') {
      // Check the URL before a tab is created (review item 1/2: refuse first, touch nothing).
      if (a.url) assertNavigable(normalizeUrl(a.url), ctx);
      const tab = await s.newTab(ctx.client.id, a.background ?? false);
      if (!s.opts.headless && !a.background) {
        await tab.page.bringToFront().catch(() => undefined);
        s.frontTab = tab.id;
      }
      if (a.url) {
        const url = a.url;
        return tab.enqueue(() => navigateTo({ ...ctx, tab }, 'goto', url, 'domcontentloaded', ctx.config.navigationTimeout, undefined));
      }
      return `[${tab.id}] new tab ${safeUrl(tab.page.url())}${ctx.client.active === tab.id ? ' (active)' : ''}`;
    }
    if (a.action === 'select') {
      const t = owned(ctx, a.tab);
      activate(ctx.client, t.id);
      if (!s.opts.headless || s.isAttach) {
        await t.page.bringToFront().catch(() => undefined);
        s.frontTab = t.id;
      }
      return tabLine(t, true);
    }
    const t = owned(ctx, a.tab);
    t.ownNavigation++;
    const closed = new Promise<void>((r) => t.page.once('close', () => r()));
    try {
      await t.page.close({ runBeforeUnload: true });
      const ok = await Promise.race([closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
      if (!ok) await t.page.close();
    } finally {
      t.ownNavigation--;
    }
    if (s.frontTab === t.id) s.frontTab = undefined;
    const active = ctx.client.active;
    return `[${t.id}] closed${active ? `; active tab is ${active}` : '; no tabs left'}`;
  },
});
