# Round 7 re-check reports (c052783)

Verbatim reviewer reports from 2026-10-26. Base 2c45028. Scripts and logs: `~/x2b-r7rc-sec/` and `~/x2b-r7rc-corr/`. They drive fix round 7b.

## Security (flow-verifier-max)
I have everything. Final report.

---

**Verdict: round 7 does NOT close.** Items 1–4, 6 and 7(click) verify fixed by my own scripts, but item 5 (`safeUrl`) introduces a **critical** secret leak, new in round 7, inside the diff. All scripts/logs in `~/x2b-r7rc-sec/` (builds byte-identical to repo `dist`@c052783 and `/tmp/x2b-r7-base`@2c45028; Chrome 155 headless `--isolated`).

**Round-6 security items — all fixed:**
- **r2d/r2e** (frame budget): fixed. `about:blank#x`, incl. nested cross-origin: base `snapshot` 11.9s / `wait` 6.9s / `navigate` 31s; head ≤517 ms, sibling/nested content still shown (`frames2`, `r2de`).
- **r6-shadow** (crash wording): fixed. `evaluate` throwing `Target crashed` → `page exception: "Error: Target crashed"`; overlay title/wait-text "page crashed" never mark the tab crashed, real error survives (`battery`).
- **r1/r3** (video/timeout quoting): fixed. Base prints `FORGED`/`e99999` **outside quotes** and raw ESC on play error, `lang=`, cue text (e99999 hidden in balanced quotes); head `jsonQuote`s all (`battery-base` vs `battery-head`).
- **r2c** (data: URL header): fixed. Base prints raw data: URL → `e99999` a standalone token in snapshot/read/tabs/navigate; head = one %-encoded token (`forge`).
- **Giant answers (was unchecked):** now checked — 9 Mi refused on `snapshot`+`read` (`answered too much (<method>)`), Node server peak 162 MB; base has no cap. Check sits after Playwright receives the string, before `JSON.parse`. Per-answer not per-snapshot: N frames allocate N×≤8 Mi concurrently (2-frame confirmed); `batch` is sequential (`bigans`).

**New findings:**
- **CRITICAL — `src/util/secrets.ts:201` `safeUrl`.** Percent-encoding (`url.replace(URL_UNSAFE_G,pct)`, line 203) runs BEFORE redaction. A remembered password adjacent to a char Chrome reports raw but `URL_UNSAFE_G` encodes (`'`,`\`,`"`,space,C0/C1/DEL) gets a hex digit/letter inserted beside it; `scrubSecrets`' whole-token `replaceable()` then refuses to redact. End-to-end: typed `Hunter2xZ` into `<input type=password>`, page `location.hash="'"+v+"'"` → head header/`→ url`/tabs/snapshot print `#%27Hunter2xZ%27` (and `#%5CHunter2xZ%5C`); base prints `#'<redacted>'`/`#\<redacted>\`. Hits ~20 `safeUrl` sites incl. click "not clicked". Neither `redactPrintedUrls` nor the final `scrubSecrets` pass rescues it (`sec-unit`, `sec-unit2`, `secret-raw`). Fix direction: scrub/redact the raw URL first, then encode all but the `<redacted>` marker.
- **WARNING — `src/page/snapshot.ts:154`.** `(frame unavailable)` rendered via `textLine`; a page text node "(frame unavailable)" renders byte-identically (`forge`), so a page can forge/suppress the new server status signal. New in round 7; low impact (quoted, no ref/marker, under "(untrusted page content)").

**Pre-existing (backlog, outside diff):** `console` tool `messageText` (`src/tools/console.ts:15`) emits raw ESC/DEL/NUL/lone-surrogate — identical on base. Backtick/angle-bracket secret adjacency leaks on both builds (Chrome pre-encodes).

**Not checked:** OOPIF renderer exit (needs forced renderer OOM; unsafe at 374 MB free swap on the review machine — named for the owner); hostile-builtin matrix beyond `play()` (`inTime`/`crashedSoon`/`trackDocuments` are Node/CDP-side, loaderId from the browser — page script cannot reach them, by code not measurement); `inTime` does not cancel the underlying evaluate (nit). No timing-dependent findings; concurrent correctness reviewer was running.

## Correctness (flow-verifier-high)
**Verdict: not ready.** All the round-6 correctness items are fixed. But round 7 adds one critical: a frame that is slow to answer gets read as "text is absent".

Checked on c052783 (dist built 13:41) and on the base at `/tmp/x2b-r7-base` (REV file says 2c45028), Chrome 155 headless `--isolated`. The security reviewer was running at the same time.

**Round-6 items** (bad runs, fix vs base):
- **Fixed** (0/10 vs 10/10 on base): v1 reload, v1 goto same URL, v1b, v1b with `#frag`, v2 back timeout, v4 204, v4 download.
- **Didn't reproduce on base** (0/10 both), so they don't prove anything: v1 from `/old`, v4 302 to a 20 s `/slow`.
- **Guards against over-correction** (10/10 pass on fix): a back to a slow entry answers only after the new document arrives; a back to a same-document entry still works.
- **effects.ts:236 nit:** that line didn't change in round 7 and isn't in the criteria. No repro.

**New findings:**
- **Critical, `wait.ts:11` and `find.ts:44`.** A frame that doesn't answer within 500 ms counts as "text not there".
  - `wait text_gone` says the text disappeared after about 502 ms while it's still on the page: 10/10 (5 with a busy child frame, 5 with a busy main frame). Base: 0/10, it times out honestly. A page that stays busy for over 500 ms after a click is enough to trigger it.
  - `find` returns "0 hits" with no note when the match is in a busy child frame: 3/3. Base found it at 3.9 s.
  - Repro: `s4e.mjs`, `s4d.mjs`.
  - Suggested fix: "didn't answer" needs to be a third state, never "gone"; `find` should say how many frames didn't answer.
- **Warning, `snapshot.ts:98-104`.** A working frame that contains a hanging child frame shows as "(frame unavailable)". `find` gets text from that same frame, so it does answer. Every run, cross-origin and same-origin. Base: the whole snapshot errors at 11.9 s. Repro: `s4b.mjs`.
- **Warning, from reading only.** `nav.tracking` is never read anywhere. If document tracking fails, back/forward never sees its commit and can report "stopped" while the tab actually moved. Can't trigger it under `--isolated`.

**Holds:**
- **Document tracking:** cross-site switches, back/forward/reload, same-URL goto, popups and `tabs new` all pass (121/121 fix, 120/120 base). I dropped 21 steps where my script was on the wrong tab.
- **bfcache:** Playwright turns bfcache off by default and src doesn't re-enable it, so I tested it on my own throwaway Chrome via `--cdp-endpoint`. Note that this departs from your launch rule. Fix passes 3/3; base waited 5 s ("still loading") and missed the `→ navigated` line.
- **Item 7 (click reserve):** a queued click never claims success or "not clicked" falsely (0 of 102). Base had 1 click that errored but did click. An unqueued click keeps its full `timeout_ms`.
- **Item 3 (crash probe):** at most 15 ms added to ordinary failures. A pinned page answers at 2.85 s against a 2.9 s deadline, with its original error and no false "crashed".
- **Speed:** navigate p50 is 123-126 ms (base 126-128), click p50 is 143-145 ms (base 142).

**Already on base (backlog):**
- A click that triggers `history.back()` into bfcache takes 10.7 s (fix 3/3, base 2/3). Timing: needs a quiet rerun.
- "no element matches" is shown when the queue used up the deadline.
- A slow `window.open` popup isn't reported, then becomes the active tab.

**Not checked:**
- Prerender activation (it never activated in headless).
- `frameStartedNavigating` on older Chrome in connect mode.
- Arm before act: code read only. The listener attaches synchronously right after the await.

The author's `~/x2b-repro-r7/lib.mjs` starts the server without `--isolated`.

Scripts and logs are in `~/x2b-r7rc-corr/`.

