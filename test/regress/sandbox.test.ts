// Chrome sandbox (PLAN.md amendment "2026-10-23: Chrome sandbox"). Consumer side: the built server is
// started through the MCP client helper, a page is loaded, and the command lines of the Chrome processes
// on that server's profile are read with `ps`. The server talks to Chrome over a pipe and opens no
// debugging port, so `Browser.getBrowserCommandLine` is not reachable from outside.
//   S1  by default no launched Chrome process carries --no-sandbox (headless, headed, isolated, persistent)
//   S2  --no-sandbox / MOTORIKA_NO_SANDBOX=1 bring the flag back and log one warning line at startup
// Run alone, after npm run build:
//   MOTORIKA_TEST_ROOT=/tmp/motorika-sbx node --import tsx --test --test-concurrency=1 'test/regress/sandbox.test.ts'
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { assertNoOrphans, startServer, type ServerHandle, type ServerOptions } from '../support/mcp-client.ts';
import { freshDir } from '../support/paths.ts';
import { chromeUnder, chromeWithProfile, type ProcInfo } from '../support/procs.ts';

const roots: string[] = [];
after(async () => {
  await assertNoOrphans(roots);
});

const PAGE = `data:text/html,${encodeURIComponent('<title>Sandbox</title><p>sandbox probe</p>')}`;

interface Case {
  name: string;
  opts: () => ServerOptions & { profile?: string };
}

/** Starts the server, loads a page so renderers exist, returns that launch's Chrome processes. */
async function launchAndList(label: string, o: ServerOptions & { profile?: string }): Promise<{ s: ServerHandle; procs: ProcInfo[] }> {
  const s = await startServer({ label, ...o });
  roots.push(s.root);
  if (o.profile) roots.push(o.profile);
  await s.ok('navigate', { url: PAGE });
  const procs = o.profile ? await chromeWithProfile(o.profile) : await chromeUnder(s.root);
  // Zero processes would make every "has no --no-sandbox" check pass vacuously.
  assert.ok(procs.some((p) => p.main), `${label}: no Chrome browser process found for this launch`);
  assert.ok(
    procs.some((p) => /\s--type=renderer\b/.test(p.command)),
    `${label}: no renderer process found for this launch:\n${procs.map((p) => p.command).join('\n')}`,
  );
  return { s, procs };
}

function withNoSandbox(procs: ProcInfo[]): string[] {
  return procs.filter((p) => /(^|\s)--no-sandbox(\s|$)/.test(p.command)).map((p) => `${p.pid} ${p.command.slice(0, 300)}`);
}

const persistent = (headless: boolean) => (): ServerOptions & { profile: string } => {
  const profile = freshDir('sbxp');
  return { headless, isolated: false, profile, flags: ['--profile-dir', profile], env: { HOME: freshDir('home') } };
};

const S1: Case[] = [
  { name: 'headless + isolated', opts: () => ({ headless: true, isolated: true }) },
  { name: 'headed + isolated', opts: () => ({ headless: false, isolated: true }) },
  { name: 'headless + persistent profile', opts: persistent(true) },
  { name: 'headed + persistent profile', opts: persistent(false) },
];

describe('S1 Chrome runs with its sandbox by default', () => {
  for (const c of S1) {
    test(`${c.name}: no Chrome process of the launch has --no-sandbox`, async () => {
      const { s, procs } = await launchAndList(`s1-${c.name.replace(/\W+/g, '-')}`, c.opts());
      try {
        assert.deepEqual(withNoSandbox(procs), [], `${c.name}: Chrome processes started with --no-sandbox`);
        assert.doesNotMatch(s.stderr(), /--no-sandbox/, 'no sandbox warning without the opt-out');
      } finally {
        await s.close();
      }
    });
  }
});

describe('S2 --no-sandbox / MOTORIKA_NO_SANDBOX=1 opt out', () => {
  const variants: { name: string; opts: ServerOptions }[] = [
    { name: 'flag --no-sandbox', opts: { flags: ['--no-sandbox'] } },
    { name: 'env MOTORIKA_NO_SANDBOX=1', opts: { env: { MOTORIKA_NO_SANDBOX: '1' } } },
  ];
  for (const v of variants) {
    test(`${v.name}: Chrome gets --no-sandbox and the server warns once`, async () => {
      const { s, procs } = await launchAndList(`s2-${v.name.replace(/\W+/g, '-')}`, v.opts);
      try {
        assert.ok(withNoSandbox(procs).length > 0, `${v.name}: expected --no-sandbox on the browser command line`);
        const warnings = s
          .stderr()
          .split('\n')
          .filter((l) => / warn /.test(l) && /sandbox/i.test(l));
        assert.equal(warnings.length, 1, `${v.name}: expected exactly one sandbox warning line, got:\n${s.stderr()}`);
      } finally {
        await s.close();
      }
    });
  }
});
