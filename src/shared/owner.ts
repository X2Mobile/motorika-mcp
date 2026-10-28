// Owner side: listens on the profile's socket and runs joined sessions' calls on its own browser, each
// under its own client id (own active tab, own tab list).
import { chmodSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { log } from '../util/log.js';
import { REDACTED, scrubSecrets } from '../util/secrets.js';
import { ensureRunDir } from './paths.js';
import { onMessages, send, validCounters, type Counters } from './protocol.js';
import type { ToolResult } from '../tools/types.js';

export interface OwnerHooks {
  dispatch(tool: string, args: unknown, clientId: string): Promise<ToolResult>;
  /** A joined session went away: close its tabs. */
  dropClient(clientId: string): void;
  /** The owner's current highest ref and tab numbers (re-check item 2). */
  counters?(): Counters;
  /** A rejoined client was shown numbers up to `seen`: raise the counters and the previous-session floor. */
  raise?(seen: Counters): void;
}

/** Is something accepting connections on this socket path? */
export function probeSocket(path: string, timeoutMs = 1000): Promise<'live' | 'stale' | 'absent'> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    const timer = setTimeout(() => {
      s.destroy();
      resolve('stale');
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      s.destroy();
      resolve('live');
    });
    s.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(e.code === 'ENOENT' ? 'absent' : 'stale');
    });
  });
}

/**
 * Values of a call's arguments that the owner now remembers as secrets (typed into a password field).
 * They go back to the joined client, which remembers them too, so they stay scrubbed after a takeover.
 */
export function rememberedIn(args: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || out.size >= 64) return;
    if (typeof v === 'string') {
      if (v.length > 0 && scrubSecrets(v) === REDACTED) out.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (typeof v === 'object' && v !== null) {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(args, 0);
  return [...out];
}

export class OwnerServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private nextClient = 1;

  constructor(
    readonly path: string,
    private readonly hooks: OwnerHooks,
    /** This server's security settings, sent in the hello (G2). */
    private readonly policy?: Record<string, string>,
  ) {}

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  /** Bind the socket. 'in-use' when another live owner holds it. A stale file is removed first. */
  async listen(): Promise<'ok' | 'in-use'> {
    ensureRunDir();
    const state = await probeSocket(this.path);
    if (state === 'live') return 'in-use';
    if (state === 'stale') {
      try {
        unlinkSync(this.path);
      } catch {
        /* raced away */
      }
    }
    const server = createServer((sock) => this.onConnection(sock));
    // C4: another server may bind between the probe and here. On macOS listen() then throws EEXIST
    // synchronously (or emits EADDRINUSE): that is "in use", so the caller retries the join.
    const inUse = (e: NodeJS.ErrnoException) => e.code === 'EADDRINUSE' || e.code === 'EEXIST';
    const r = await new Promise<'ok' | 'in-use'>((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) => (inUse(e) ? resolve('in-use') : reject(e)));
      try {
        server.listen(this.path, () => resolve('ok'));
      } catch (e) {
        if (inUse(e as NodeJS.ErrnoException)) resolve('in-use');
        else reject(e);
      }
    });
    if (r === 'ok') {
      chmodSync(this.path, 0o600);
      this.server = server;
      log.info(`sharing the browser on ${this.path}`);
    }
    return r;
  }

  private onConnection(sock: Socket): void {
    const clientId = `c${process.pid}-${this.nextClient++}`;
    this.sockets.add(sock);
    send(sock, { t: 'hello', pid: process.pid, ...(this.policy ? { policy: this.policy } : {}) });
    onMessages(sock, (m) => {
      // N2: only well-formed call frames are dispatched; anything else is ignored, never thrown.
      if (m.t !== 'call' || typeof m.id !== 'number' || typeof m.tool !== 'string') return;
      const seen = validCounters(m.seen);
      if (seen) this.hooks.raise?.(seen);
      this.hooks
        .dispatch(m.tool, m.args, clientId)
        .then((result) => {
          const secrets = rememberedIn(m.args);
          const counters = this.hooks.counters?.();
          send(sock, { t: 'result', id: m.id, result, ...(counters ? { counters } : {}), ...(secrets.length > 0 ? { secrets } : {}) });
        })
        .catch((e: unknown) => {
          send(sock, {
            t: 'result',
            id: m.id,
            result: { content: [{ type: 'text', text: `the owner server failed the call: ${e instanceof Error ? e.message : String(e)}\nhint: retry` }], isError: true },
          });
        });
    });
    sock.on('error', () => undefined);
    sock.on('close', () => {
      this.sockets.delete(sock);
      this.hooks.dropClient(clientId);
    });
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    for (const sock of this.sockets) sock.destroy();
    if (s) await new Promise<void>((r) => s.close(() => r()));
    try {
      unlinkSync(this.path);
    } catch {
      /* already gone */
    }
  }
}
