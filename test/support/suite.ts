// Per-file acceptance setup: one fixture server + one MCP server (`--headless --isolated --output-dir`)
// per test file, torn down in `after`, followed by the G2 check for this file's roots.
// The dist check runs FIRST, so an unbuilt tree fails at once without starting anything.
import { after, before } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFixtureServer, type FixtureServer } from './fixture-server.ts';
import { assertBuilt, assertNoOrphans, startServer, type ServerHandle, type ServerOptions } from './mcp-client.ts';

export interface FileContext {
  fx: FixtureServer;
  s: ServerHandle;
  /** Every per-server root started in this file (for G2). */
  roots: string[];
}

export function useFileServer(label: string, opts: ServerOptions = {}): FileContext {
  const ctx = { roots: [] as string[] } as unknown as FileContext;
  before(async () => {
    assertBuilt();
    ctx.fx = await startFixtureServer();
    ctx.s = await startServer({ label, ...opts });
    ctx.roots.push(ctx.s.root);
  });
  after(async () => {
    await ctx.s?.close();
    await ctx.fx?.close();
    await assertNoOrphans(ctx.roots); // G2 for this file
  });
  return ctx;
}

/** Polls `fn` until truthy or `ms` elapse; returns the last value. */
export async function until<T>(fn: () => T | Promise<T>, ms = 5000, step = 100): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > deadline) return v;
    await sleep(step);
  }
}

export type Counts = Record<string, number | undefined>;
