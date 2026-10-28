import { z } from 'zod';
import { DEFAULT_CLIENT, type LaunchOptions } from '../browser/session.js';
import { ToolError } from '../util/errors.js';
import { defineTool } from './types.js';

export const session = defineTool({
  name: 'session',
  description:
    'Browser session: status (mode, headless, browser version, profile, tabs, active tab), launch (restart with new options; tabs are not carried over, cookies persist in a persistent profile), close (close the browser in launch mode, disconnect in attach modes).',
  shape: {
    action: z.enum(['status', 'launch', 'close']),
    headless: z.boolean().optional(),
    mode: z.enum(['launch', 'connect', 'auto_connect']).optional(),
    cdp_endpoint: z.string().optional().describe('http(s)://host:port or ws(s)://… for mode=connect'),
    isolated: z.boolean().optional().describe('Fresh temporary profile, deleted on exit'),
  },
  annotations: { openWorldHint: false },
  scope: 'free',
  needsBrowser: () => false,
  timeoutMs: (_a, c) => c.navigationTimeout,
  async handler(a, ctx) {
    const s = ctx.session;
    if (a.action === 'status') {
      const tabs = s.clientTabs(ctx.client.id);
      const parts = [
        `mode=${s.opts.mode}`,
        `headless=${s.opts.headless}`,
        `browser=${s.running ? s.version : 'not-started'}`,
        `profile=${s.profileLabel}`,
        `tabs=${tabs.length}`,
        `active=${ctx.client.active ?? 'none'}`,
      ];
      // A joined session's calls run on the owner under a non-default client id.
      if (ctx.client.id !== DEFAULT_CLIENT) parts.push(`shared=client(owner pid ${process.pid})`);
      else if (s.shared === 'owner') parts.push('shared=owner');
      return parts.join(' ');
    }
    const joined = ctx.client.id !== DEFAULT_CLIENT;
    if (a.action === 'close' && joined) {
      // Closing the shared browser would take it from every other session: close only this client's tabs.
      const n = s.clientTabs(ctx.client.id).length;
      await Promise.all(s.clientTabs(ctx.client.id).map((t) => t.page.close().catch(() => undefined)));
      return `closed this session's ${n} tab${n === 1 ? '' : 's'}; the shared browser keeps running (owner pid ${process.pid})`;
    }
    if (a.action === 'close') {
      const wasRunning = s.running;
      // N1: joined sessions lose their tabs too; tell them at the top of their next result.
      if (wasRunning) s.notifyJoined(`notice: the owner server (pid ${process.pid}) closed the shared browser; your tabs are gone`);
      await s.lock.exclusive(() => s.close());
      if (!wasRunning) return 'browser was not running';
      return s.isAttach ? 'disconnected from Chrome (its tabs stay open)' : 'browser closed';
    }
    const next: LaunchOptions = {
      mode: a.mode ?? (a.cdp_endpoint ? 'connect' : s.opts.mode),
      headless: a.headless ?? s.opts.headless,
      isolated: a.isolated ?? s.opts.isolated,
      cdpEndpoint: a.cdp_endpoint ?? s.opts.cdpEndpoint,
    };
    if (joined) {
      const o = s.opts;
      const changes = next.mode !== o.mode || next.headless !== o.headless || next.isolated !== o.isolated || next.cdpEndpoint !== o.cdpEndpoint;
      if (changes) {
        throw new ToolError(
          `the browser is shared and owned by server pid ${process.pid}; a joined session cannot change its mode`,
          'restart that server with the options you need, or start this server with --isolated or another --profile-dir',
        );
      }
      return `the shared browser already runs mode=${o.mode} headless=${o.headless} (owner pid ${process.pid}); nothing changed`;
    }
    if (next.mode === 'connect' && !next.cdpEndpoint) {
      throw new ToolError('mode=connect needs a CDP endpoint', 'pass cdp_endpoint (http://127.0.0.1:9222 or ws://…)');
    }
    if (s.running) s.notifyJoined(`notice: the owner server (pid ${process.pid}) relaunched the shared browser; your tabs are gone`);
    await s.lock.exclusive(() => s.relaunch(next));
    const persistent = next.mode === 'launch' && !next.isolated;
    return `relaunched mode=${next.mode} headless=${next.headless} browser=${s.version} profile=${s.profileLabel}; tabs not carried over${persistent ? ' (cookies persist in the profile)' : ''}`;
  },
});
