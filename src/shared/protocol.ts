// Owner <-> joiner protocol: newline-delimited JSON over the unix socket.
import type { Socket } from 'node:net';
import type { ToolResult } from '../tools/types.js';

/** Highest ref and tab numbers (re-check item 2: structured, never parsed out of result text). */
export interface Counters {
  ref: number;
  tab: number;
}

export type Msg =
  /** `policy`: the owner's security settings (round 4, G2); a joiner with other settings does not join. */
  | { t: 'hello'; pid: number; policy?: Record<string, string> }
  /** `seen`: a client that rejoins after its owner went away sends the highest numbers it was shown. */
  | { t: 'call'; id: number; tool: string; args: unknown; seen?: Counters }
  /** `counters`: the owner's counters after the call (an upper bound of what the client was shown). */
  /** `secrets`: password literals the owner remembered from this call (re-check item 6, R-W8). */
  | { t: 'result'; id: number; result: ToolResult; counters?: Counters; secrets?: string[] };

/** Upper bound for a counter value from the socket (R-C3: never let a value push `next++` past 2^53). */
export const COUNTER_MAX = 1_000_000_000;

/** A well-formed Counters value, or undefined. */
export function validCounters(c: unknown): Counters | undefined {
  if (typeof c !== 'object' || c === null) return undefined;
  const { ref, tab } = c as { ref?: unknown; tab?: unknown };
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= COUNTER_MAX;
  return ok(ref) && ok(tab) ? { ref, tab } : undefined;
}

/** Max size of one message (a screenshot result can be several MB of base64). */
export const MAX_LINE = 64 * 1024 * 1024;

export function send(sock: Socket, m: Msg): void {
  if (!sock.destroyed) sock.write(`${JSON.stringify(m)}\n`);
}

/** Calls onMsg for every complete line; destroys the socket on garbage or an oversized line. */
export function onMessages(sock: Socket, onMsg: (m: Msg) => void): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE) {
      sock.destroy();
      return;
    }
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      let m: unknown;
      try {
        m = JSON.parse(line);
      } catch {
        sock.destroy();
        return;
      }
      // N2: a frame must be an object with a string type; `null`, numbers, arrays are dropped.
      if (typeof m !== 'object' || m === null || Array.isArray(m) || typeof (m as { t?: unknown }).t !== 'string') continue;
      try {
        onMsg(m as Msg);
      } catch {
        /* a handler bug on one frame must not take the process down */
      }
    }
  });
}

/** Remembered-secret literals from a result frame: strings only, bounded in count and length. */
export function validSecrets(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 4096).slice(0, 64);
}
