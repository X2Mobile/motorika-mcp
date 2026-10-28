// Harness: the fixture server's own routes behave as specified, checked with plain fetch.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CSP_HEADER, startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { MEDIA_DIR } from '../support/paths.ts';
import { downloadBytes, sha256 } from '../support/spec.ts';

let fx: FixtureServer;
before(async () => {
  fx = await startFixtureServer();
});
after(async () => {
  await fx.close();
});

describe('fixture server', () => {
  test('serves two different sites: 127.0.0.1 and localhost', async () => {
    assert.match(fx.originA, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(fx.originB, /^http:\/\/localhost:\d+$/);
    for (const o of ['A', 'B'] as const) {
      const r = await fetch(fx.url('/nav-a.html', o));
      assert.equal(r.status, 200);
      assert.match(await r.text(), /<title>Nav A<\/title>/);
    }
  });

  test('templates origins into HTML', async () => {
    const html = await (await fetch(fx.url('/coverage.html'))).text();
    assert.ok(html.includes(`${fx.originB}/frame-cross.html`));
    assert.ok(!html.includes('__ORIGIN_B__'));
    const xo = await (await fetch(fx.url('/video-xo.html', 'A'))).text();
    assert.ok(xo.includes(`${fx.originB}/video-frame.html`), 'video-xo on A embeds B');
  });

  test('records urlencoded, multipart (file name + bytes) and JSON submissions; /__log reads and resets', async () => {
    fx.reset();
    await fetch(fx.url('/submit?form=u'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=two+words&a=3',
    });
    const fd = new FormData();
    fd.append('note', 'hi');
    fd.append('file', new Blob([Buffer.from([0, 1, 2, 255])]), 'bin.dat');
    await fetch(fx.url('/submit?form=m'), { method: 'POST', body: fd });
    await fetch(fx.url('/submit?form=j'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":[1,2]}' });
    await fetch(fx.url('/submit?form=g&q=search+me'));
    const [u, m, j, g] = fx.submissions();
    assert.deepEqual(u!.fields, [['a', '1'], ['b', 'two words'], ['a', '3']]);
    assert.deepEqual(m!.fields, [['note', 'hi']]);
    assert.equal(m!.files[0]!.name, 'bin.dat');
    assert.equal(m!.files[0]!.size, 4);
    assert.equal(m!.files[0]!.sha256, sha256(Buffer.from([0, 1, 2, 255])));
    assert.deepEqual(j!.json, { x: [1, 2] });
    assert.deepEqual(g!.fields, [['q', 'search me']]);
    assert.equal(g!.query.form, 'g');
    const viaHttp = (await (await fetch(fx.url('/__log?reset=1'))).json()) as unknown[];
    assert.equal(viaHttp.length, 4);
    assert.equal(fx.records().length, 0, 'reset=1 cleared the log');
  });

  test('/slow delays headers by ms', async () => {
    const t0 = Date.now();
    const r = await fetch(fx.url('/slow?ms=400'));
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 >= 380);
  });

  test('/status/<code>, /fail/500', async () => {
    assert.equal((await fetch(fx.url('/status/404'))).status, 404);
    assert.equal((await fetch(fx.url('/status/418'))).status, 418);
    assert.equal((await fetch(fx.url('/fail/500'))).status, 500);
  });

  test('/hang never answers', async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 500);
    await assert.rejects(fetch(fx.url('/hang'), { signal: ctl.signal }));
    clearTimeout(t);
  });

  test('/download/<name> is an attachment with the spec bytes', async () => {
    const r = await fetch(fx.url('/download/report.txt'));
    assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="report.txt"/);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.length, 5000);
    assert.ok(body.equals(downloadBytes('report.txt')));
  });

  test('/csp/<page> carries the strict CSP + Trusted Types header', async () => {
    const r = await fetch(fx.url('/csp/csp-page.html'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-security-policy'), CSP_HEADER);
    assert.equal(CSP_HEADER, "script-src 'none'; require-trusted-types-for 'script'");
  });

  test('HTTP Range for media: 206 with Content-Range, suffix ranges, 416 out of range', async () => {
    const file = readFileSync(join(MEDIA_DIR, 'colors.webm'));
    const r = await fetch(fx.url('/media/colors.webm'), { headers: { range: 'bytes=0-99' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 0-99/${file.length}`);
    assert.equal(r.headers.get('content-type'), 'video/webm');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(file.subarray(0, 100)));
    const s = await fetch(fx.url('/media/colors.mp4'), { headers: { range: 'bytes=-10' } });
    assert.equal(s.status, 206);
    assert.equal((await s.arrayBuffer()).byteLength, 10);
    const bad = await fetch(fx.url('/media/colors.webm'), { headers: { range: `bytes=${file.length + 10}-` } });
    assert.equal(bad.status, 416);
    const full = await fetch(fx.url('/media/colors.webm'));
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
  });

  test('/api/data records its request headers; cookies round-trip', async () => {
    fx.reset();
    await fetch(fx.url('/api/data'), { headers: { authorization: 'Bearer zzz' } });
    assert.equal(fx.records()[0]!.headers.authorization, 'Bearer zzz');
    const sc = await fetch(fx.url('/set-cookie?v=abc'));
    assert.match(sc.headers.get('set-cookie') ?? '', /^motorika_acc=abc; Max-Age=3600/);
  });

  test('refuses path traversal', async () => {
    const r = await fetch(fx.url('/%2e%2e/%2e%2e/package.json'));
    assert.equal(r.status, 404);
  });
});
