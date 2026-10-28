// Harness: the client helper is a checker, so it is validated on labelled must-catch / must-allow cases
// before it judges the real server (G1, G4, C7, "server not built").
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  assertBuilt,
  assertCauseAndHint,
  c7Violation,
  expectedTimeout,
  extractMarked,
  g4Violation,
  NOT_BUILT,
  startServer,
  type ServerHandle,
} from '../support/mcp-client.ts';
import { REPO_ROOT } from '../support/paths.ts';
import { PASSWORD_LITERAL } from '../support/spec.ts';

const FAKE = join(REPO_ROOT, 'test', 'support', 'fake-server.mjs');

describe('client helper checks', () => {
  let s: ServerHandle;
  before(async () => {
    s = await startServer({ entry: FAKE, slots: 0, headless: false, isolated: false, env: { FAKE_LITERAL: PASSWORD_LITERAL } });
  });
  after(async () => {
    await s.close();
  });

  test('must-allow: a normal call passes all checks', async () => {
    const r = await s.ok('echo', { text: 'hello value=<redacted>' });
    assert.equal(r.text, 'hello value=<redacted>');
  });

  test('C7 must-catch: the password literal in a result fails the call', async () => {
    await assert.rejects(s.call('leak'), /C7: password literal/);
  });

  test('G1 must-catch: a call slower than timeout + 2 s fails', async () => {
    await assert.rejects(s.call('sleep', { ms: 2600 }, { budgetMs: 500 }), /G1: sleep took \d+ ms/);
  });

  test('G1 must-allow: a call within timeout + 2 s passes', async () => {
    await s.ok('sleep', { ms: 300 }, { budgetMs: 500 });
  });

  test('G3 must-allow: cause + hint on two lines', async () => {
    await s.err('error');
  });

  test('G4 must-catch: a stray stdout line fails the next call and stays recorded', async () => {
    await assert.rejects(s.call('stray'), /G4: non-JSON-RPC stdout lines/);
    assert.equal(s.stdoutViolations().length, 1);
    await assert.rejects(s.call('echo', { text: 'x' }), /G4/);
  });
});

describe('pure checks', () => {
  test('G4 line check: valid response allowed; non-JSON and non-JSON-RPC caught', () => {
    assert.equal(g4Violation('{"jsonrpc":"2.0","id":1,"result":{}}'), null);
    assert.equal(g4Violation('{"jsonrpc":"2.0","method":"notifications/message","params":{}}'), null);
    assert.match(g4Violation('debug: started') ?? '', /not JSON/);
    assert.match(g4Violation('{"hello":"world"}') ?? '', /not a JSON-RPC message/);
    assert.match(g4Violation('') ?? '', /not JSON/);
  });

  test('C7 scan: nested text and error strings caught; image bytes ignored; redacted allowed', () => {
    assert.ok(c7Violation({ content: [{ type: 'text', text: `x ${PASSWORD_LITERAL} y` }] }));
    assert.ok(c7Violation(`McpError: bad ${PASSWORD_LITERAL}`));
    assert.equal(c7Violation({ content: [{ type: 'text', text: 'value=<redacted>' }] }), null);
    assert.equal(c7Violation({ content: [{ type: 'image', data: 'A'.repeat(300) + PASSWORD_LITERAL, mimeType: 'image/png' }] }), null);
  });

  test('G1 budgets follow the PLAN defaults', () => {
    assert.equal(expectedTimeout('click', {}), 10_000);
    assert.equal(expectedTimeout('click', { timeout_ms: 1500 }), 1500);
    assert.equal(expectedTimeout('navigate', {}), 30_000);
    assert.equal(expectedTimeout('tabs', { action: 'new', url: 'x' }), 30_000);
    assert.equal(expectedTimeout('tabs', { action: 'list' }), 10_000);
    assert.equal(expectedTimeout('wait', { ms: 500 }), 500);
    assert.equal(expectedTimeout('batch', { steps: [{ tool: 'navigate', args: {} }, { tool: 'click', args: { timeout_ms: 1000 } }] }), 31_000);
  });

  test('G3 shape: one line without a hint is caught', () => {
    assert.throws(() => assertCauseAndHint('failed'), /G3/);
    assertCauseAndHint('e12 is stale (element removed); take a new snapshot');
    assertCauseAndHint('timeout waiting for text "x"\nhint: raise timeout_ms');
  });

  test('evaluate marker extraction tolerates headers and pretty printing', () => {
    assert.deepEqual(extractMarked('[t1] (untrusted page content)\n{\n  "__motorikav": {"a": [1, 2]}\n}'), { a: [1, 2] });
    assert.equal(extractMarked('{"__motorikav":3}'), 3);
    assert.equal(extractMarked('[t2] {"__motorikav":"x}y"} trailing'), 'x}y');
  });

  test('not built: fails at once with the build hint, before any spawn', async () => {
    const t0 = Date.now();
    assert.throws(() => assertBuilt('/nonexistent/dist/index.js'), new RegExp(NOT_BUILT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await assert.rejects(startServer({ entry: '/nonexistent/dist/index.js' }), /server not built: run npm run build/);
    assert.ok(Date.now() - t0 < 500);
  });
});

describe('image helpers', () => {
  test('JPEG and PNG sizes come from the bytes', async () => {
    const { PNG } = await import('pngjs');
    const png = new PNG({ width: 7, height: 3 });
    const buf = PNG.sync.write(png);
    const { imageSize } = await import('../support/images.ts');
    assert.deepEqual(imageSize(buf, 'image/png'), { width: 7, height: 3 });
    // Minimal JPEG header: SOI, APP0 (len 16), SOF0 with 360x640.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x68, 0x02, 0x80, 0x03,
    ]);
    assert.deepEqual(imageSize(jpeg, 'image/jpeg'), { width: 640, height: 360 });
  });
});
