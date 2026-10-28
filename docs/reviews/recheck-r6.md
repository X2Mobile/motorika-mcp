# Round 6 re-check reports (2c45028)

Verbatim reviewer reports from 2026-10-23, extracted from the session transcript after the 2026-10-24 restart wiped their scripts in /tmp. Security first (line 4408), then correctness (line 4438). They drove fix round 7.

## Security (flow-verifier-max)
**Checked:** main 2c45028 (dist built 22:16:46) and base 7789a38. Chrome 155 headless, Playwright 1.64.1, Node 24.21.0. Paths are under `<repo>/src/`; scripts and outputs are in `/tmp/x2b-r6rs/`.

**Verdict:** The forged-line class holds. No page text started a line, and no tab was marked crashed. Hostile builtins were clean in 62 of 66 environments across 16 tools, and in 4 of 4 inside a cross-origin iframe. But quoting and frame isolation still leak:

- **critical (also on 7789a38, outside the diff):** one scriptless `<iframe src="about:blank#x">`, even nested inside a cross-origin frame, makes the host's snapshot, find and wait text time out. Navigate takes 31 s. Cause: unbounded `Promise.all` over frames at `page/snapshot.ts:86`, `tools/find.ts:33`, `tools/wait.ts:10` (r2d, r2e).
- **warning (new in round 6):** `dispatch.ts:432` checks crash wording before `ToolError`. "page crashed" in an overlay title, in the caller's wait text or in an evaluate exception replaces the real error (3 of 3, r6-shadow).
- **warning:** `video.ts:237` (isVideo) is not wrapped. A page error containing "Timeout 1ms exceeded" is printed unquoted through `dispatch.ts:459`, and its balanced quotes hide e99999 from the matrix's oracle. `pageText` (`video.ts:73`) escapes only line breaks, so raw ESC/DEL reach the play error (`:543`) and `lang=` (`:497`) (r1, r3 setTimeout).
- **warning:** `tools/read.ts:38` prints a data: iframe's URL raw, with spaces, quotes and e99999, so the header no longer parses. A cross-origin frame can navigate itself to data: (r2c).
- **nit (the open item):** URLs a page sets via location, pushState, popups, redirects or links (http(s), about:, blob:) are percent-encoded, and every line parses.

**Sound:** `redactPrintedUrls` (200k fuzz cases), the CDP crash probe, SHAPES running on `JSON.parse` output.

**Not checked (for the owner):** giant answers (`engine.ts:331` has no size cap), and a cross-origin iframe's renderer exiting (Playwright wires `targetCrashed` per frame session).

## Correctness (flow-verifier-high)
**Verdict: round 6 is not ready.** The fix holds for the original d1s case, but the same false "navigated" comes back whenever a redirect is involved. Checked on dist built from 2c45028, Chrome 155 headless, with three test lanes and the other reviewer running at the same time.

**Previous items, re-run 10×:**
1. **Not fixed for redirects.** d1s itself is fixed: 60/60 runs stopped, none reloaded later.
2. Fixed: d1n, d1n2, d1n3 and d1b all name both URLs.
3. Fixed.
4. Fixed: clk 219/220; the one miss is load jitter and carries the "settle incomplete" note. The /poll window has 0 bad results in 300.
5. Fixed: 10/10.

d1v 0/490, c1e 0/60, d1r 30/30, r6 BAD 0, d1q 0/260, tc 0.

**New findings:**
- **CRITICAL, `navwatch.ts:100` and `:118`.** `responded` turns true on a 302 hop's response, and `requested_` holds every hop's URL. The old page calling `replaceState(location.href)` then counts as the commit, and nothing is stopped. Reproduced 4/4, failed the same way on 7789a38, clean without the `replaceState` loop.
  - goto or reload `/a` that redirects to a slow `/slow`: answers "navigated /a (302)", then the tab lands on `/slow`. Repro: `v1.mjs`.
  - `/b` redirecting to `/a` (also with `#frag`): answers success, `timeout_ms` 2000 is ignored. Repro: `v1b.mjs`, 6/6.
- **WARNING, `navigate.ts:289`.** back to an entry whose URL is the current page's commits at once on the page's own `replaceState`. It answered at 2.6 s and the tab landed at 4 s. Repro: `v2.mjs`, 3/3.
- **WARNING, `effects.ts:213` with `navwatch.ts:102`.** A click on a link to the page's own URL reports a navigation that never happened: "→ navigated (204)", "(200)" next to the download, or "(302)" while the tab goes to `/slow`. Repro: `v4.mjs`, 3/3.
- **NIT, `effects.ts:236`.** Any main-frame navigation request counts, not one within 100 ms. I couldn't reproduce this.

**Sound:** data: and about: targets, Location with a fragment, page-script interruption, bfcache back/forward, iframe-only click, and the <50 ms rule (text accurate).

**Not checked:** the history-read fallback.

Everything is in `/tmp/x2b-r6rc/t/`.

