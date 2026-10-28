// Child process for slots.test.ts. Runs against MOTORIKA_TEST_ROOT (set by the parent to a private dir), so it
// never touches the suite's own slots. Modes:
//   cycle <barrierDir>: take 1 slot, wait until both partners hold theirs, then ask for 1 more (hold-and-wait).
//   hold: take every slot and wait to be killed.
//   take: take every slot, print "took", release.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireSlots } from '../support/slots.ts';

const [mode, barrier] = process.argv.slice(2);
const MAX = Number(process.env.MOTORIKA_TEST_CHROME_SLOTS ?? '2');

if (mode === 'cycle') {
  const first = await acquireSlots(1, `first-${process.pid}`);
  writeFileSync(join(barrier!, `ready-${process.pid}`), '');
  while (readdirSync(barrier!).filter((f) => f.startsWith('ready-')).length < 2) await sleep(50);
  const second = await acquireSlots(1, `second-${process.pid}`);
  process.stdout.write('done\n');
  second.release();
  first.release();
} else if (mode === 'hold') {
  await acquireSlots(MAX, 'hold');
  process.stdout.write('held\n');
  while (!existsSync('/nonexistent-never')) await sleep(1000);
} else if (mode === 'take') {
  const l = await acquireSlots(MAX, 'take');
  process.stdout.write('took\n');
  l.release();
}
