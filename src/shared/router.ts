// Decides, for a launch-mode server on a persistent profile, whether it owns the profile's browser or
// joins the server that does. Ownership = holding the profile's unix socket. A joiner forwards every
// call; when its owner goes away, the next call takes over (listens, launches, says so in a notice).
import { DEFAULT_CLIENT, readProfileLock, type Session } from '../browser/session.js';
import { DEADLINE_SLACK_MS, budgetOf } from '../dispatch.js';
import type { ToolResult } from '../tools/types.js';
import { log } from '../util/log.js';
import { JoinClient } from './joiner.js';
import type { Counters } from './protocol.js';
import { OwnerServer, type OwnerHooks } from './owner.js';
import { socketPathFor } from './paths.js';
import { policyDifferences, securityPolicy } from './policy.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ref numbers named in a call's ref-taking arguments (the agent's own args, never result text). */
export function refsInArgs(tool: string, args: Record<string, unknown>): number[] {
  const out: number[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string') {
      const m = /^\s*e(\d+)\s*$/.exec(v);
      if (m) out.push(Number(m[1]));
    } else if (Array.isArray(v)) {
      for (const x of v) add(x);
    } else if (typeof v === 'object' && v !== null && 'target' in v) {
      add((v as { target: unknown }).target);
    }
  };
  if (tool === 'batch' && Array.isArray(args.steps)) {
    for (const st of args.steps as unknown[]) {
      if (typeof st !== 'object' || st === null) continue;
      const { tool: t, args: a } = st as { tool?: unknown; args?: unknown };
      if (typeof t === 'string' && typeof a === 'object' && a !== null) out.push(...refsInArgs(t, a as Record<string, unknown>));
    }
    return out;
  }
  for (const k of ['target', 'fields', 'submit', 'from', 'to', 'scope']) add(args[k]);
  return out;
}

export class ShareRouter {
  role: 'none' | 'owner' | 'client' = 'none';
  private owner: OwnerServer | undefined;
  private joined: JoinClient | undefined;
  private deciding: Promise<void> | undefined;
  private takeoverFrom: number | undefined;
  /** Sharing could not be set up (e.g. socket path too long); run locally without retrying each call. */
  private disabled = false;
  /** G2: the last join attempt found an owner with other security settings; the call is refused. */
  private refusal: ToolResult | undefined;
  private lastRefusalLog: string | undefined;

  constructor(
    private readonly session: Session,
    private readonly hooks: OwnerHooks,
  ) {}

  private eligible(): boolean {
    const o = this.session.opts;
    return o.mode === 'launch' && !o.isolated;
  }

  get ownerPid(): number | undefined {
    return this.joined?.ownerPid;
  }

  /** A result when the call was forwarded to the owner; undefined to run it locally. */
  async route(tool: string, args: unknown): Promise<ToolResult | undefined> {
    if (this.disabled) return undefined;
    if (!this.eligible()) {
      if (this.role === 'owner') await this.stopOwning();
      return undefined;
    }
    if (this.role === 'owner') return undefined;
    if (this.role === 'client') {
      if (this.joined && !this.joined.closed) return this.forward(this.joined, tool, args);
      this.takeoverFrom = this.joined?.ownerPid;
      // Everything shown so far came from the owner that went away (R-C2).
      this.staleRefFloor = this.highestRef;
      this.joined = undefined;
      this.role = 'none';
    }
    this.deciding ??= this.decide().finally(() => {
      this.deciding = undefined;
    });
    await this.deciding;
    if (this.refusal) return this.refusal;
    const joined = this.joined;
    if (joined && !joined.closed) return this.forward(joined, tool, args);
    return undefined;
  }

  /** Highest ref and tab numbers this session has been shown (takeover continues above them; C3). */
  private highestRef = 0;
  private highestTab = 0;
  /** Refs at or below this number were shown by an owner that went away (R-C2). */
  private staleRefFloor = 0;
  /** Sent with the first call after rejoining another owner, so it raises its counters (R-C2). */
  private pendingSeen: Counters | undefined;

  private async forward(joined: JoinClient, tool: string, args: unknown): Promise<ToolResult> {
    const a = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    const stale = refsInArgs(tool, a).find((n) => n <= this.staleRefFloor);
    if (stale !== undefined) {
      return {
        content: [{ type: 'text', text: `e${stale} is from a previous browser session\nhint: the owner server went away and another server now owns the shared browser; take a new snapshot` }],
        isError: true,
      };
    }
    const seen = this.pendingSeen;
    this.pendingSeen = undefined;
    // The owner answers by budget + 1.9 s; give the socket a little more before answering anyway (W5).
    const r = await joined.callFull(tool, args, budgetOf(tool, a, this.session.config) + DEADLINE_SLACK_MS + 50, seen);
    // Re-check item 2 (R-C3): counters arrive as structured fields; result text is never scanned.
    if (r.counters) {
      this.highestRef = Math.max(this.highestRef, r.counters.ref);
      this.highestTab = Math.max(this.highestTab, r.counters.tab);
    } else if (seen) {
      this.pendingSeen = seen; // the owner never saw it (no answer): send it again
    }
    return r.result;
  }

  private async decide(): Promise<void> {
    const profile = this.session.config.profileDir;
    let path: string;
    try {
      path = socketPathFor(profile);
    } catch (e) {
      log.warn('sharing disabled: cannot resolve the profile socket path', e);
      this.disabled = true;
      return;
    }
    this.refusal = undefined;
    const mine = securityPolicy(this.session.config);
    for (let attempt = 0; attempt < 10; attempt++) {
      const c = await JoinClient.connect(path);
      const differs = c ? policyDifferences(mine, c.ownerPolicy) : [];
      if (c && differs.length > 0) {
        // G2: never run this session's calls under another server's security settings, and never fall
        // through to launching a second Chrome on the profile the owner holds. Every call asks again, so
        // this server takes over once that owner exits.
        c.close();
        const why = `not joining the browser of server pid ${c.ownerPid}: security settings differ: ${differs.join(', ')}`;
        if (why !== this.lastRefusalLog) log.warn(why);
        this.lastRefusalLog = why;
        this.refusal = {
          content: [
            {
              type: 'text',
              text: `this server's security settings differ from those of server pid ${c.ownerPid}, which owns the shared browser on ${profile}: ${differs.join(', ')}\nhint: start both servers with the same flags, or start this one with --isolated or another --profile-dir`,
            },
          ],
          isError: true,
        };
        return;
      }
      if (c) {
        this.joined = c;
        this.role = 'client';
        this.session.shared = 'client';
        log.info(`joined the browser of server pid ${c.ownerPid} via ${path}`);
        if (this.takeoverFrom !== undefined) {
          // Rejoined another owner after ours went away (R-C2): that owner continues above our numbers.
          this.pendingSeen = { ref: this.highestRef, tab: this.highestTab };
          this.session.client(DEFAULT_CLIENT).notices.push(
            `notice: the owner server (pid ${this.takeoverFrom}) went away; server pid ${c.ownerPid} now owns the browser on ${profile}. Your tabs and refs are gone; cookies persist.`,
          );
          this.takeoverFrom = undefined;
        }
        return;
      }
      const owner = new OwnerServer(path, this.hooks, mine);
      let r: 'ok' | 'in-use';
      try {
        r = await owner.listen();
      } catch (e) {
        log.warn(`sharing disabled: cannot listen on ${path}`, e);
        this.disabled = true;
        return;
      }
      if (r === 'ok') {
        this.owner = owner;
        this.role = 'owner';
        this.session.shared = 'owner';
        if (this.takeoverFrom !== undefined) await this.takeOver(this.takeoverFrom, profile);
        return;
      }
      await sleep(100);
    }
  }

  private async takeOver(oldPid: number, profile: string): Promise<void> {
    this.takeoverFrom = undefined;
    // The old owner closes its Chrome on exit; give the profile lock time to be released.
    for (let i = 0; i < 80; i++) {
      const lock = readProfileLock(profile);
      if (!lock || lock.alive === false) break;
      await sleep(100);
    }
    // Item 8: never reuse a ref or tab id the agent has already seen.
    this.session.refs.continueAbove(this.highestRef);
    this.session.continueTabsAbove(this.highestTab);
    this.session.client(DEFAULT_CLIENT).notices.push(
      `notice: the owner server (pid ${oldPid}) went away; this server took over the browser on ${profile}. Its tabs are gone; cookies persist.`,
    );
  }

  private async stopOwning(): Promise<void> {
    const o = this.owner;
    this.owner = undefined;
    this.role = 'none';
    this.session.shared = 'none';
    await o?.close();
  }

  async close(): Promise<void> {
    this.joined?.close();
    this.joined = undefined;
    await this.stopOwning();
  }
}
