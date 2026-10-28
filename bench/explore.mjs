// Dev aid: print what one contender returns for navigate/snapshot on a fixture page.
// Usage: node --import tsx bench/explore.mjs <id> <page> [tool argsJSON]...
import { startFixtureServer } from '../test/support/fixture-server.ts';
import { CONTENDERS } from './contenders.mjs';
import { startContender } from './lib.mjs';

const [, , id, page, ...rest] = process.argv;
const srv = await startFixtureServer();
const url = srv.url(page);
const h = await startContender(CONTENDERS.find((c) => c.id === id));
try {
  for (let i = 0; i < rest.length; i += 2) {
    const args = JSON.parse(rest[i + 1].replaceAll('$URL', url));
    const r = await h.call(rest[i], args);
    process.stdout.write(`\n##### ${rest[i]} ${Math.round(r.ms)}ms chars=${r.textChars} img=${r.imageBytes} err=${r.isError}\n${r.text.slice(0, Number(process.env.MAXC ?? 2500))}\n`);
  }
} finally {
  const k = await h.close();
  await srv.close();
  process.stdout.write(`\nclosed, killed=${k.killed}\n`);
}
