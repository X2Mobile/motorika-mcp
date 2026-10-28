// Cross-process Chrome semaphore: at most MOTORIKA_TEST_CHROME_SLOTS (default 2) Chrome instances caused by
// this suite run at once, across all test files that node:test runs in parallel.
//
// Rules that keep it deadlock-free:
// - A caller acquires everything it needs in ONE call (`acquireSlots(n)` is all-or-nothing).
// - Prefer to hold nothing else while waiting. Hold-and-wait still happens (a file-level server holds a
//   slot while a test asks for another, e.g. page-r3 P3), so the semaphore also breaks the cycle itself:
//   a process that waits while holding slots publishes a `wait-<pid>-<n>` file, and when EVERY live slot
//   holder has one for DEADLOCK_GRACE_MS, nobody can ever release. The holding waiter with the lowest pid
//   then gets overflow slot(s) above the limit, finishes its test and releases. Overflow is at most one
//   grant per cycle (the granted process stops waiting, so the cycle condition turns false).
//   Found 2026-10-23: core-r4c G2 (owner slot, waiting for the joiner's) against page-r3 P3 (file
//   server's slot, waiting for P3's Chrome) held both slots and waited 15 min for each other.
//
// Mechanics: a mkdir mutex guards a directory of slot files; each slot file holds its owner pid, and
// a slot whose pid is dead is reclaimed. Leases die with their process (exit handler + dead-pid reclaim).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TEST_ROOT } from './paths.ts';

const SLOT_DIR = join(TEST_ROOT, 'slots');
const MUTEX = join(SLOT_DIR, '.mutex');
const MAX = Number(process.env.MOTORIKA_TEST_CHROME_SLOTS ?? '2');
const WAIT_LIMIT_MS = 15 * 60_000;
const DEADLOCK_GRACE_MS = 2_000;

mkdirSync(SLOT_DIR, { recursive: true });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockMutex(): boolean {
  try {
    mkdirSync(MUTEX);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(MUTEX).mtimeMs > 10_000) rmSync(MUTEX, { recursive: true, force: true });
    } catch {
      /* raced with another process; retry later */
    }
    return false;
  }
}

function unlockMutex(): void {
  rmSync(MUTEX, { recursive: true, force: true });
}

const held = new Set<string>();
const waiting = new Set<string>();
let waitSeq = 0;

process.on('exit', () => {
  for (const f of held) rmSync(f, { force: true });
  for (const f of waiting) rmSync(f, { force: true });
});

function ownerOf(f: string): number {
  try {
    return Number(readFileSync(f, 'utf8').split(' ')[0]);
  } catch {
    return 0;
  }
}

/** True when every live slot holder (overflow slots included) is itself waiting for more slots. */
function allHoldersWaiting(): { cycle: boolean; lowestWaitingHolder: number } {
  const names = readdirSync(SLOT_DIR);
  const waiters = new Set(
    names.filter((f) => f.startsWith('wait-')).map((f) => Number(f.split('-')[1])).filter((pid) => pid > 0 && alive(pid)),
  );
  const holders = new Set(
    names.filter((f) => f.startsWith('slot-')).map((f) => ownerOf(join(SLOT_DIR, f))).filter((pid) => pid > 0 && alive(pid)),
  );
  if (holders.size === 0) return { cycle: false, lowestWaitingHolder: 0 };
  for (const pid of holders) if (!waiters.has(pid)) return { cycle: false, lowestWaitingHolder: 0 };
  return { cycle: true, lowestWaitingHolder: Math.min(...holders) };
}

export interface SlotLease {
  readonly count: number;
  release(): void;
}

export async function acquireSlots(n: number, label = 'chrome'): Promise<SlotLease> {
  if (n <= 0) return { count: 0, release: () => undefined };
  if (n > MAX) throw new Error(`acquireSlots(${n}) exceeds the limit of ${MAX} concurrent Chrome instances`);
  const deadline = Date.now() + WAIT_LIMIT_MS;
  const waitFile = join(SLOT_DIR, `wait-${process.pid}-${++waitSeq}`);
  let cycleSince = 0;
  try {
    for (;;) {
      if (lockMutex()) {
        try {
          const free: string[] = [];
          for (let i = 0; i < MAX; i++) {
            const f = join(SLOT_DIR, `slot-${i}`);
            const owner = ownerOf(f);
            if (owner === 0 || (!alive(owner) && !held.has(f))) free.push(f);
          }
          if (free.length < n && held.size > 0) {
            // Hold-and-wait: publish it, and break a cycle in which every holder waits (see the header).
            if (!waiting.has(waitFile)) {
              writeFileSync(waitFile, `${n} ${label}\n`);
              waiting.add(waitFile);
            }
            const { cycle, lowestWaitingHolder } = allHoldersWaiting();
            if (!cycle) cycleSince = 0;
            else if (cycleSince === 0) cycleSince = Date.now();
            else if (Date.now() - cycleSince >= DEADLOCK_GRACE_MS && lowestWaitingHolder === process.pid) {
              free.length = 0;
              for (let i = MAX; free.length < n; i++) {
                const f = join(SLOT_DIR, `slot-${i}`);
                const owner = ownerOf(f);
                if (owner === 0 || (!alive(owner) && !held.has(f))) free.push(f);
              }
              process.stderr.write(`slots: hold-and-wait cycle among ${slotOwners().join('; ')}; overflow grant to ${process.pid} ${label}\n`);
            }
          }
          if (free.length >= n) {
            const mine = free.slice(0, n);
            for (const f of mine) {
              writeFileSync(f, `${process.pid} ${label}\n`);
              held.add(f);
            }
            let released = false;
            return {
              count: n,
              release: () => {
                if (released) return;
                released = true;
                for (const f of mine) {
                  rmSync(f, { force: true });
                  held.delete(f);
                }
              },
            };
          }
        } finally {
          unlockMutex();
        }
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} Chrome slot(s) in ${SLOT_DIR}: ${slotOwners().join('; ')}`);
      await sleep(250);
    }
  } finally {
    rmSync(waitFile, { force: true });
    waiting.delete(waitFile);
  }
}

/** For diagnostics only. */
export function slotOwners(): string[] {
  return readdirSync(SLOT_DIR)
    .filter((f) => f.startsWith('slot-'))
    .map((f) => `${f}: ${readFileSync(join(SLOT_DIR, f), 'utf8').trim()}`);
}
