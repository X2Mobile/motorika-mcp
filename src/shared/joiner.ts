// Joiner side: forwards every tool call to the owner of the profile.
import { createConnection, type Socket } from "node:net";
import type { ToolResult } from "../tools/types.js";
import { rememberSecret } from "../util/secrets.js";
import {
  onMessages,
  send,
  validCounters,
  validSecrets,
  type Counters,
} from "./protocol.js";
import { validPolicy, type SecurityPolicy } from "./policy.js";

/** A forwarded call's answer plus the owner's structured counters (re-check item 2). */
export interface Forwarded {
  result: ToolResult;
  counters?: Counters | undefined;
}

function gone(pid: number, during: boolean): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `the owner server (pid ${pid}) went away${during ? " during this call" : ""}\nhint: retry; the next call takes over the browser`,
      },
    ],
    isError: true,
  };
}

export class JoinClient {
  private nextId = 1;
  private readonly pending = new Map<number, (r: Forwarded) => void>();
  closed = false;

  private constructor(
    private readonly sock: Socket,
    readonly ownerPid: number,
    /** The owner's security settings from its hello; undefined from an older owner (G2). */
    readonly ownerPolicy: SecurityPolicy | undefined,
  ) {}

  private onResult(id: number, r: Forwarded): void {
    const done = this.pending.get(id);
    this.pending.delete(id);
    done?.(r);
  }

  private onClose(): void {
    this.closed = true;
    for (const done of this.pending.values())
      done({ result: gone(this.ownerPid, true) });
    this.pending.clear();
  }

  /** Connect and wait for the owner's hello. null when nobody accepts. */
  static connect(path: string, timeoutMs = 2000): Promise<JoinClient | null> {
    return new Promise((resolve) => {
      const sock = createConnection(path);
      let client: JoinClient | null = null;
      let settled = false;
      const finish = (c: JoinClient | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!c) sock.destroy();
        resolve(c);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      sock.on("error", () => finish(null));
      sock.on("close", () => {
        if (client) client.onClose();
        finish(null);
      });
      onMessages(sock, (m) => {
        if (!client) {
          if (m.t !== "hello") return finish(null);
          client = new JoinClient(sock, m.pid, validPolicy(m.policy));
          finish(client);
          return;
        }
        if (m.t === "result") {
          // Re-check item 6 (R-W8): remember what the owner remembered, so it survives a takeover.
          for (const sec of validSecrets(m.secrets)) rememberSecret(sec);
          client.onResult(m.id, {
            result: m.result,
            counters: validCounters(m.counters),
          });
        }
      });
    });
  }

  /** Forward one call; W5: answered by `timeoutMs` even if the owner is alive but unresponsive. */
  async call(
    tool: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<ToolResult> {
    return (await this.callFull(tool, args, timeoutMs)).result;
  }

  /** Forward one call; the answer comes with the owner's structured counters (re-check item 2). */
  callFull(
    tool: string,
    args: unknown,
    timeoutMs: number,
    seen?: Counters,
  ): Promise<Forwarded> {
    if (this.closed)
      return Promise.resolve({ result: gone(this.ownerPid, false) });
    const id = this.nextId++;
    return new Promise((resolve) => {
      // No budget given (a caller that is not the router): no local timeout rather than a 1 ms one.
      const timer = !Number.isFinite(timeoutMs)
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            resolve({
              result: {
                content: [
                  {
                    type: "text",
                    text: `the owner server (pid ${this.ownerPid}) did not answer within ${timeoutMs}ms\nhint: retry; if it keeps happening, restart that server`,
                  },
                ],
                isError: true,
              },
            });
          }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      send(
        this.sock,
        seen
          ? { t: "call", id, tool, args, seen }
          : { t: "call", id, tool, args },
      );
    });
  }

  close(): void {
    this.sock.destroy();
  }
}
