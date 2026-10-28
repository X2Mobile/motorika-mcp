// 2026-10-26: read keeps comment sections. Oracles: a live probe of a www.reddit.com
// comment permalink (evidence notes kept outside the repo: every comment sits in
// section[aria-label=Comments], plain light DOM) and the acceptance criteria in PLAN.md "2026-10-26: read
// keeps comment sections", never this code's output. Run alone (after npm run build):
//   MOTORIKA_TEST_ROOT=/tmp/motorika-rc node --import tsx --test --test-concurrency=1 'test/regress/read-comments.test.ts'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { assertBuilt, assertNoOrphans, startServer, type ServerHandle } from '../support/mcp-client.ts';
import { FIXTURES_DIR, REPO_ROOT } from '../support/paths.ts';

const roots: string[] = [];
let s: ServerHandle;
let fx: FixtureServer;

before(async () => {
  assertBuilt();
  fx = await startFixtureServer();
  s = await startServer({ label: 'read-comments', flags: ['--action-timeout', '3000'] });
  roots.push(s.root);
});
after(async () => {
  await s?.close();
  await fx?.close();
  await assertNoOrphans(roots);
});

async function read(path: string, format?: 'markdown' | 'text'): Promise<string> {
  await s.ok('navigate', { url: path.startsWith('data:') ? path : fx.url(path), snapshot: false });
  return (await s.ok('read', format ? { format } : {})).text;
}

/** Every marker present, each after the previous one. */
function assertInOrder(t: string, markers: string[]): void {
  let last = -1;
  for (const m of markers) {
    const i = t.indexOf(m, last + 1);
    assert.ok(i >= 0, `missing "${m}":\n${t}`);
    assert.ok(i > last, `"${m}" out of document order:\n${t}`);
    last = i;
  }
}

describe('www.reddit.com permalink: comments inside section[aria-label=Comments] are read', () => {
  for (const format of ['markdown', 'text'] as const) {
    test(`post body, then every comment body with its author, in document order (${format})`, async () => {
      const t = await read('/shreddit-permalink.html', format);
      assertInOrder(t, [
        'POST-BODY: a question for the community',
        'POST-BODY-2: what do you all use and why?',
        'first_user',
        'COMMENT-ONE: the first top-level comment.',
        'second_user',
        'COMMENT-TWO: a nested reply.',
        'third_user',
        'COMMENT-THREE: the last top-level comment.',
        'COMMENT-THREE-P2: with a second paragraph.',
      ]);
      for (const b of ['NAV-BOILERPLATE', 'SIDEBAR-BOILERPLATE', 'FOOTER-BOILERPLATE', 'INLINE-SCRIPT-PAYLOAD']) {
        assert.ok(!t.includes(b), `boilerplate "${b}" was read:\n${t}`);
      }
    });
  }
});

describe('a blog-style <section id="comments"> is content', () => {
  for (const format of ['markdown', 'text'] as const) {
    test(`article, then the comments with their authors (${format})`, async () => {
      const t = await read('/read-sections.html', format);
      assertInOrder(t, ['ARTICLE-BODY: tides follow the moon.', '3 Comments', 'AUTHOR-MARA', 'BLOG-COMMENT-ONE: great explainer.', 'AUTHOR-ION', 'BLOG-COMMENT-TWO: what about spring tides?']);
    });
  }
});

describe('boilerplate tokens still match, and only whole tokens', () => {
  test('shadow, header, padding, loading and badge classes are read; ad, ads, share, related, nav, footer, cookie, sidebar, newsletter are not', async () => {
    const t = await read('/read-sections.html');
    for (const kept of ['SHADOW-TEXT kept', 'HEADER-TEXT kept', 'PADDING-TEXT kept', 'LOADING-TEXT kept', 'BADGE-TEXT kept']) {
      assert.ok(t.includes(kept), `"${kept}" dropped (a class containing "ad" as a substring is not an ad):\n${t}`);
    }
    for (const b of ['AD-BOILERPLATE', 'ADS-BOILERPLATE', 'SHARE-BOILERPLATE', 'RELATED-BOILERPLATE', 'NAV-BOILERPLATE', 'FOOTER-BOILERPLATE', 'COOKIE-BOILERPLATE', 'SIDEBAR-BOILERPLATE', 'NEWSLETTER-BOILERPLATE']) {
      assert.ok(!t.includes(b), `boilerplate "${b}" was read:\n${t}`);
    }
  });
});

// Review of b312f78, item 1: Reddit labels each comment "Comment from <user> 4 days ago", so a username
// holding a boilerplate token ("Cookie_Monster") dropped the whole comment. The tokens below are the
// boilerplate list as of fba6f4f minus `comments`; the first test keeps it in step with read.ts.
const TOKENS = [
  'nav', 'navbar', 'menu', 'footer', 'sidebar', 'aside', 'cookie', 'cookies', 'consent', 'gdpr', 'banner', 'ad', 'ads',
  'advert', 'advertisement', 'adsbygoogle', 'sponsor', 'sponsored', 'promo', 'newsletter', 'share', 'social', 'related',
  'breadcrumb', 'breadcrumbs', 'popup', 'modal', 'subscribe', 'skip',
];
const PERMALINK = readFileSync(join(FIXTURES_DIR, 'shreddit-permalink.html'), 'utf8');
const WORDPRESS = readFileSync(join(FIXTURES_DIR, 'wordpress-comments.html'), 'utf8');
const cap = (t: string): string => t[0]!.toUpperCase() + t.slice(1);

describe('a username holding a boilerplate token does not drop its comment (review item 1a)', () => {
  test('the token list covers every BOILER_TOKENS entry in read.ts', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'page', 'injected', 'read.ts'), 'utf8');
    const m = /const BOILER_TOKENS = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(m, 'BOILER_TOKENS not found in read.ts');
    const inSrc = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    assert.deepEqual([...inSrc].sort(), [...TOKENS].sort());
  });
  for (const tok of TOKENS) {
    test(`usernames ${cap(tok)}_Monster, ${tok}_astra_fan and ${tok}`, async () => {
      const users = [`${cap(tok)}_Monster`, `${tok}_astra_fan`, tok];
      const html = PERMALINK.replaceAll('first_user', users[0]!).replaceAll('second_user', users[1]!).replaceAll('third_user', users[2]!);
      const t = await read(`data:text/html,${encodeURIComponent(html)}`, 'text');
      const body = t.slice(t.indexOf('POST-BODY:'));
      assertInOrder(body, [
        'POST-BODY: a question for the community',
        users[0]!,
        'COMMENT-ONE: the first top-level comment.',
        users[1]!,
        'COMMENT-TWO: a nested reply.',
        `${users[2]} `,
        'COMMENT-THREE: the last top-level comment.',
      ]);
    });
  }
});

describe('a short aria-label that is boilerplate still counts (review item 1b)', () => {
  test('"Advertisement", "Cookie consent", "Share", "Sponsored", "Related posts", "Breadcrumb" are not read', async () => {
    const t = await read('/read-sections.html');
    assert.ok(t.includes('ARTICLE-BODY'), t);
    for (const b of ['LABEL-AD-', 'LABEL-COOKIE-', 'LABEL-SHARE-', 'LABEL-SPONSORED-', 'LABEL-RELATED-', 'LABEL-BREADCRUMB-']) {
      assert.ok(!t.includes(b), `"${b}" was read:\n${t}`);
    }
  });
});

describe('a footer inside a comment is content; the page footer is not (review item 2)', () => {
  for (const format of ['markdown', 'text'] as const) {
    test(`WordPress: each comment's author from footer.comment-meta, in order; footer#colophon out (${format})`, async () => {
      const t = await read('/wordpress-comments.html', format);
      assertInOrder(t, ['WP-POST-BODY', 'WP-AUTHOR-MARA', 'October 1, 2026', 'WP-COMMENT-ONE: thanks, very clear.', 'WP-AUTHOR-ION', 'WP-COMMENT-TWO: and neap tides?']);
      for (const b of ['WP-SITE-FOOTER-BOILERPLATE', 'NAV-BOILERPLATE']) assert.ok(!t.includes(b), `"${b}" was read:\n${t}`);
    });
  }
});

// Follow-up to the review: WordPress puts a registered author's nicename in the comment's class
// (`li.comment.byuser.comment-author-<nicename>`), so a nicename holding a token dropped the comment.
describe('a WordPress nicename holding a boilerplate token does not drop its comment', () => {
  for (const tok of TOKENS) {
    test(`nicenames ${tok}-monster and ${tok}`, async () => {
      const html = WORDPRESS.replace('class="comment even thread-even depth-1 parent"', `class="comment byuser comment-author-${tok}-monster even thread-even depth-1 parent"`).replace(
        'class="comment odd alt depth-2"',
        `class="comment byuser comment-author-${tok} odd alt depth-2"`,
      );
      assert.notEqual(html, WORDPRESS);
      const t = await read(`data:text/html,${encodeURIComponent(html)}`, 'text');
      assertInOrder(t, ['WP-POST-BODY', 'WP-AUTHOR-MARA', 'WP-COMMENT-ONE: thanks, very clear.', 'WP-AUTHOR-ION', 'WP-COMMENT-TWO: and neap tides?']);
    });
  }
  test('a page-level div.comment-ad and div.comments-sidebar are still not read', async () => {
    const t = await read('/read-sections.html');
    assert.ok(t.includes('ARTICLE-BODY'), t);
    for (const b of ['COMMENT-AD-BOILERPLATE', 'COMMENTS-SIDEBAR-BOILERPLATE']) assert.ok(!t.includes(b), `"${b}" was read:\n${t}`);
  });
});
