# Acceptance traceability

Criterion id → test(s) → oracle. Criteria come from `PLAN.md` "Acceptance criteria" plus the amendment of
2026-10-21 (new A4, new A11; `main` commit 754e079). Every expectation comes from the contract or a fixture's
own spec, never from server output.

Oracle kinds:
- **fixture record**: what the fixture server recorded (`/submit`, `/api/data`, `/echo-cookie`), read in-process.
- **page state**: counters / `window.__events` / DOM values read back through the `evaluate` tool.
- **raw CDP**: `Runtime.evaluate` over the throwaway Chrome's own websocket, independent of the server.
- **process table**: `ps` (`--user-data-dir` under the test root), `lsof` for TCP listeners, `stat` for sockets.
- **grammar**: `test/support/grammar.ts`, written from PLAN "Snapshot grammar" / "Effect summary" / tool output forms.
- **spec**: `test/support/spec.ts`, `scripts/gen-fixture-video.mjs` (`COLOR_TABLE`, `CUES`), fixture page comments.
- **image bytes**: PNG decode (pngjs) or JPEG SOF dimensions of the returned MCP image content.

Every fixture oracle is first proven with plain playwright-core in `test/harness/` (see the last section).

Suite-wide rules enforced on **every** call by `test/support/mcp-client.ts`:
G1 (wall time ≤ timeout + 2 s), G4 (every server stdout line is valid JSON-RPC), C7 (password literal never in
any result). G2 runs in every acceptance file's `after` hook (`assertNoOrphans`).

## A. Session and modes (`A.test.ts`)

| Id | Test | Oracle |
|---|---|---|
| A1 | A1 initialize + tools/list answer within 1 s and start no Chrome | client wall clock; process table (no Chrome under the server root); tool names from PLAN "The tools" |
| A2 | not in the suite (headed smoke run recorded in VERIFICATION.md by others) | — |
| A3 | A3 a cookie survives a server restart on the same --profile-dir | fixture record (`Cookie` header on `/echo-cookie`) |
| A4 | A4 a second server on the same profile joins the first browser (cookie, one Chrome, own tabs, takeover, socket) | (a) page state `document.cookie` via server 2; (b) process table: one main Chrome with that `--user-data-dir`; (c) grammar (`tabs list`, snapshot refs) disjoint sets; (d) first-line notice + page state cookie; (e) `stat` mode bits of `$HOME/.motorika/run/<sha1[0:12]>.sock` and dir, `lsof` |
| A5 | A5 session launch with a different headless value switches mode; … | `session status` token `headless=…`; fixture record cookie. **Skipped unless `MOTORIKA_TEST_HEADED=1`** (opens a headed window) |
| A6 | A6 after Chrome is killed, the next call relaunches with a notice and does not hang | process table (new main PID); result's first line is not the normal `[tN] navigated` line; G1 |
| A7 | A7 after stdin close, … / A7 after SIGTERM, … within 5 s | process table polled for 5 s |
| A8 | A8 connect mode acts on the existing tab and leaves the attached Chrome running | raw CDP counter `{"plain":1}`; Chrome's own `/json/list`; child process still alive |
| A9 | A9 auto-connect reads DevToolsActivePort and attaches; without the file the error names chrome://inspect | raw CDP counter; error text contains `chrome://inspect/#remote-debugging` |
| A10 | A10 a launch-mode Chrome (and the server) has no TCP listening socket | `lsof -iTCP -sTCP:LISTEN` on server + all Chrome PIDs under its root |
| A11 | A11 open starts a plain Chrome on the profile (no automation flags), exits with it, and exits 2 when a server owns the profile | process table (command line flags); child exit after its Chrome is killed; exit code 2 |

## B. Tabs (`B.test.ts`)

| Id | Test | Oracle |
|---|---|---|
| B1 | B1 three tabs new calls give t1..t3 with title, URL and one (active) marker | grammar (`tabs list` line form); fixture titles/URLs |
| B2 | B2 click and type on a non-active tab via tab (headless); the active marker tells the truth | page state in the background tab; a no-`tab` `evaluate` returns the URL of the tab marked active |
| B3 | B3 target=_blank and window.open report "→ new tab tN <url>", listed and active | grammar (effect line); `tabs list` |
| B4 | B4 closing the active tab activates the previously active one; ids are never reused | `tabs list`; every id ever seen vs the next new id |
| B5 | B5 a ref acts on its own tab without `tab`; a mismatched `tab` is an error | page state counter in the ref's tab; `isError` |
| B6 | B6 concurrent calls on two tabs both complete; on one tab they run serially | page state counters; ordered `window.__events` = `A-start, A-end, B` (harness proves overlap gives `A-start, B, A-end`) |

## C. Snapshot, read, find, screenshot (`C.test.ts`)

| Id | Test | Oracle |
|---|---|---|
| C1 | C1 every snapshot line parses, refs are unique, the header is present (interactive and full) | grammar (zero unparseable lines; the helper also asserts this on every `snapshot`) |
| C2 | C2 the coverage fixture: right roles, names and states; hidden kinds absent | spec `COVERAGE` (roles/names/attributes; absent names); grammar |
| C3 | C3 an element keeps its ref across snapshots; after navigation old refs are rejected | grammar; `isError` |
| C4 | C4 stale refs: a unique re-rendered Save re-resolves; … | `re-resolved eA -> eB button "Save"` form; page state `__counts.save` (1, then unchanged) |
| C5 | C5 a 5,000-element snapshot fits max_chars with a footer; offset paging has no gap or overlap | spec (5,000 buttons `Item 1..5000` in order); footer form; result length |
| C6 | C6 viewport_only returns only elements that intersect the viewport | spec (row geometry) + page state `innerHeight` |
| C7 | C7 a filled password shows value=<redacted>; … | grammar `value=<redacted>`; helper scans every result of the whole suite |
| C8 | C8 read returns title, paragraphs and markdown links, drops boilerplate, pages with offset | spec `ARTICLE` (markers, link, boilerplate strings) |
| C9 | C9 find "save" returns the matching buttons with refs, including inside iframes; exact match first | spec (four "save" buttons across frames); grammar (find hits) |
| C10 | C10 screenshot: jpeg viewport by default, png on request, max_edge, full_page, save, annotate leaves no DOM nodes | image bytes (mime, dimensions, aspect); pixel diff annotated vs plain; page state element count |
| C11 | C11 "x,y" targets map from a downscaled viewport screenshot and from a full_page one | spec (button geometry) × scale from the returned image's own size; page state counters |
| C12 | C12 under script-src none + Trusted Types: snapshot, click, type, read and screenshot annotate work | grammar; fixture record (`csp_name`); page state element count |

## D. Actions (`D.test.ts`)

| Id | Test(s) | Oracle |
|---|---|---|
| D1 | D1 plain, double, right and Shift clicks …; D1 auto-waits … 800 ms; D1 scrolls an offscreen element …; D1 waits for an overlay …; D1 a permanent overlay …; D1 a disabled button … | page state counters; `__underTempAt - __armedAt ≥ 450`; error names `perm-overlay`; error says disabled |
| D2 | D2 replace (default) and append; D2 slowly …; D2 submit presses Enter …; D2 types into a contenteditable; D2 a controlled input … | page state values, `__keydowns`, suggestions; fixture record (search form); `__controlled` |
| D3 | D3 fill_form fills the full form in one call and submits it …; D3 a bad field …; D3 a radio group target … | fixture record = `FULL_FORM.expectedFields` + file name/sha256; no record after a failed field; `ok`/`failed` line forms |
| D4 | D4 Tab moves focus, select-all selects, Enter submits, ArrowDown … | page state (`activeElement`, selection range, `__events`, `selectedIndex`) |
| D5 | D5 hover reveals a CSS :hover menu … | grammar (item absent before hover); page state counter |
| D6 | D6 down, up and to bottom change scrollY …; D6 infinite scroll … | page state `scrollY`/`scrollTop`, item count; `scrolled y=…` and ` height a -> b` forms |
| D7 | D7 HTML5 drag-and-drop and a pointer-event drag … | page state `__events` (`html5-drop:payload-42`, `pointer-drop`) |
| D8 | D8 a file input and a file-chooser button …; D8 a path outside the roots and a dot-file are refused … | fixture record (name + sha256); error names `--allow-file-root` / `--allow-hidden-files`; no record. Headed "no native dialog" is part of the A2 headed run |
| D9 | D9 an alert is auto-accepted …; D9 confirm: pending within 2 s …; D9 dismiss gives false/null … | effect lines; `tabs list` ` dialog=confirm`; error latency ≤ 1 s; page state `__confirm` / `__prompt` |
| D10 | D10 a scheme-less goto gets https://; D10 back, forward and reload; D10 a 404 …; D10 http://nonexistent.invalid …; D10 a slow page …; D10 an SPA pushState … | page state (`location`, navigation type `reload`); `navigated … (404)` form; `net::ERR_NAME_NOT_RESOLVED`; `→ url` effect |
| D11 | D11 text appearing after 1 s; D11 text gone; D11 target hidden and target visible; D11 url substring and /regex/; D11 load_state and ms; D11 a timeout … | page state (`__firedAt`, DOM, `location.search`, `loadEventEnd`); wall clock for `ms`; error names the condition |
| D12 | D12 an expression, a function with a target, …; D12 a DOM element in the result … | known values (42, `"Plain!"`, the JSON literal); output cap 20000; grammar element line |
| D13 | D13 a download link saves under <output-dir>/downloads … | bytes on disk = `downloadBytes('report.txt')`; path under `<output-dir>/downloads` |
| D14 | D14 a 5-step batch …; D14 when step 3 fails …; D14 stop_on_error false … | `## step n: tool` sections; `skipped`; fixture record (`{name:"Batchy"}`) |
| D15 | D15 console levels and the uncaught exception; network fetch; Authorization redacted; failed_only | spec `CONSOLE_PAGE`; console / network line forms; token absent from the detail |

## E. Video (`E.test.ts`)

| Id | Test | Oracle |
|---|---|---|
| E1 | E1 video list shows duration 6±0.1 s, paused, 640x360; the fixture server serves Range | spec `VIDEO`; `206` on a Range request. File formats proven in the harness |
| E2 | E2 frames times=[0.5,2.5,4.5] format=png returns 3 images matching the color table | image bytes: center pixel vs `COLOR_TABLE[floor(t)]`, tolerance 40; `frame i/n @ mm:ss.ss` labels |
| E3 | E3 count=3 spreads frames across the duration and restores currentTime and paused | labels spread over 0..6; center pixels; page state `currentTime`/`paused` before = after |
| E4 | E4 play, pause, seek, rate, muted and volume change the element state | page state of the `<video>` |
| E5 | E5 live sampling every_ms=500 duration_ms=2000 while playing … | image count ≥ 3; strictly increasing labels |
| E6 | E6 captions returns the <track> cues with the VTT timestamps | spec `CUES` (the generated `colors.vtt`) |
| E7 | E7 a video inside a cross-origin iframe is listed and its frames are captured | `frame=fN` of the iframe line appears in the list line; center pixels vs table |
| E8 | not in the suite (real web, VERIFICATION.md) | — |

## F, H — not in the suite

F1–F2 (bench) and H1–H2 (consumer-side proof) are recorded by others.

## G. Robustness and hygiene (`G.test.ts` + suite-wide)

| Id | Test | Oracle |
|---|---|---|
| G1 | every call in every file (client helper); G1 a call never exceeds its timeout + 2 s (…) | client wall clock vs `timeout_ms` or the PLAN default (`expectedTimeout`) + 2 s |
| G2 | every file's `after` hook (`assertNoOrphans`); G2 after this server exits, no Chrome … remains | process table under each server root; orphans recorded at each server close |
| G3 | every `s.err(...)` in every file; G3 every isError result names a cause and a next step (spot checks); G3 a strict-mode error lists up to 5 matches … | `assertCauseAndHint` shape; grammar lines in strict-mode errors |
| G4 | every call (stdout tee); G4 npm run typecheck is clean; G4 no `any` and no console.log in src/; G4 the server stdout carried only JSON-RPC … | `JSONRPCMessageSchema` per stdout line; `tsc` exit; source scan with comments/strings removed |

## Harness (fixtures and checkers proven before they judge) — `test/harness/`

| File | Proves |
|---|---|
| `fixture-server.test.ts` | both origins; templating; `/submit` urlencoded/multipart(file bytes)/JSON/GET; `/__log` reset; `/slow`; `/status`; `/fail/500`; `/hang`; `/download` bytes; CSP header; Range 206/416/suffix |
| `client-helper.test.ts` | G1/G4/C7/G3 must-catch and must-allow on a fake MCP server; "server not built" fails fast; JPEG/PNG size parsing |
| `grammar.test.ts` | PLAN's sample snapshot parses; order/role/indent/duplicate violations rejected; effect, tabs, find, frame-label forms |
| `chrome-procs.test.ts` | throwaway Chrome + DevToolsActivePort + raw CDP; PID finder; `lsof` catches a debugging port and allows a pipe Chrome; Chrome runs with TMPDIR/HOME in the short root |
| `pages-actions.test.ts` | D3 payload (exact), D8 both upload paths, D2, D4, D1 (incl. overlay timing, `perm-overlay` interception), B6 ordering, D9, D7, D5, D6, C4, B3, D10 SPA/reload, D11 timings, D13 bytes, D15 events |
| `pages-structure.test.ts` | C2 spec vs Playwright's accname/DOM; hidden predicate; OOPIF (`Target.getTargets` type `iframe`); C12 CSP blocks inline script + Trusted Types; C5 counts; C6 rows; C8 boilerplate placement; C9 four matches across frames; C11 geometry |
| `video.test.ts` | VP9/H.264, 6 s, 640x360, < 300 KB; colors at 0.5/2.5/4.5 s in both formats; Range requests; CUES; cross-origin video colors |

## R. Review-lens decisions (`R.test.ts`, PLAN amendment "decisions from the three review lenses")

Run alone: `MOTORIKA_TEST_ROOT=/tmp/motorika-a node --import tsx --test --test-concurrency=1 'test/acceptance/R.test.ts'`.
Fixtures proven in `test/harness/round2.test.ts`.

| Item | Test | Oracle |
|---|---|---|
| 1 local files | R1.file a file: URL outside the allowed roots is isError with a hint; R1.file … inside an allowed root loads; R1.file a dot-segment path and view-source:file: … are refused | runtime file tree (`support/local-files.ts`), `LOCAL-SECRET-TEXT` never printed; answer 2 `hint:` line |
| 1 guard | R1.guard a click … ends → blocked and the tab at about:blank | `→ blocked <url> (<reason>)` effect form; `tabs list` URL `about:blank` (harness proves the link really reaches the outside file without a guard) |
| 1 internal pages | R1.internal chrome://version and about:version are refused; about:blank is allowed; R1.internal --allow-chrome-urls allows … | isError + hint / ok |
| 2 origin lists | R2.blocked …; R2.allowed … | `blocked by --blocked-origins: localhost` / `--allowed-origins`; fixture record on origin B absent; page state `xo:err`; `network failed_only` line (harness proves the unblocked fetch reaches B) |
| 3 output hygiene | R3.console …; R3.clip …; R3.read … | `parseConsole` (`  | ` continuations, no forged line at a line start); message length 4096 ending `…`; leading backslash on forged read lines |
| 4 hard cap | R4 a batch of large evaluates … | total text ≤ `--max-output-chars`; `… output cut at <n> chars` |
| 5 secrets | R5.secret …; R5.query … | C7 helper on every call + `<redacted>` in effect line, snapshot header, `tabs list`, `network`; fixture record proves the literal was really in the URL |
| 6 crashed tab | R6 a crashed tab … | `tab tN crashed` + the exact hint line; `tabs list` ` crashed`; the other tab's snapshot |
| 7 video list | R7 video list prints duration=unknown …; E1/E7 now parse answer 14 | `parseVideoList` (`duration=<s.ss|Infinity|unknown>`); harness proves readyState 0 |
| 8 takeover counters (C3) | R8 C3 after a takeover … | `from a previous browser session`; ref and tab numbers vs the highest seen; page counter unchanged |
| 9 deadlines (C1) | R9 C1 a click queued behind a long wait times out and never runs | timeout isError within G1; page counter `{}` after the wait ends |
| 10 dialogs in fill_form (C2) | R10 C2 a dialog raised by field b stops fill_form … | `not attempted (dialog pending)` on c and d; Field C/D empty after dismiss; no fixture record |
| 11 self-changing page | R11 a no-op click on a self-changing page settles at <= 250 ms p50 … | client wall clock, 10 runs; page counter = 10 |
| 12 / A12 login cookies | R12 A12 a cookie set during open is sent by a server on the same profile, and the reverse | fixture record `Cookie` header on `/echo-cookie` (harness: `/set-cookie` recorded) |
| C4 | R13 C4 two servers whose first calls on one profile coincide … | both results ok; process table: one main Chrome on the profile |
| C5 | R14 C5 wait target=<ref from an earlier document>: visible is isError, hidden and detached succeed | visible isError; hidden, detached ok (round 3 C2, R-W11) |
| W5 / G1 | R15 W5 G1 with the owner SIGSTOPped … | helper G1 (timeout_ms 2000 + 2 s); isError with hint; owner resumed with SIGCONT |

## S. Decisions from the bench (`S.test.ts`, PLAN amendment of 2026-10-23)

| Id | Test | Oracle |
|---|---|---|
| AS8 (AS1, AS2, AS4, AS5) | AS8 navigate to a 1,000-element page attaches a viewport snapshot of at most 6,000 chars … | grammar (`parseSnapshot`, viewport footer); page state: items whose rect top ≥ innerHeight are absent; length ≤ 6,000 + summary; a ref from it clicks. Red on main f86439c (19,607 chars) |
| AS3, AS1 | AS3 AS1 the attached snapshot is the first page of snapshot viewport_only, and its offset continues it | the same role+name sequence as `snapshot {viewport_only:true}`; `offset=<m>` continues at the next item number (fixture spec) |
| AS7 | AS7 a following snapshot returns the full first page as before … | grammar: heading, Item 1..k in order, `… <n> more lines` footer with lines + n = 1,001 (fixture spec) |
| AS explicit / AS6 | AS-explicit navigate with snapshot:true attaches the whole page …; snapshot:false attaches none | grammar: paging footer, block > 6,000 chars; no header line with `snapshot:false` |
| SQ2 | SQ2 a live-region update 30 ms after a click … | `→ alert "Saved <n>"` in each of 5 click results; page counter `{save: 5}` |
| AS5 (review PERF-1) | AS5 a ref from the attached snapshot re-resolves only when its role+name is unique in the whole document | page state `__counts` `{solo: 1}`; isError for the Dup ref (PLAN Refs: re-resolve only a unique role+name) |
| review SEC-2 | SEC2 counts from a fake engine in a cross-origin frame … | no `NaN`/`abc`/`2.5` in the output; grammar parses; footer counts are non-negative integers |
| review SEC-3 | SEC3 a 12,000-char href keeps the attached snapshot within 6,000 chars …; SEC3 with --max-output-chars 7000 … | block ≤ 6,000 / result ≤ 7,000; grammar parses; `href` ends with `…`; unit `format.test.ts` (cutLine, pageCount) |
| review SEC-4 | SEC4 a title with U+2028, U+2029 and U+0085 … | no raw separator in navigate, tabs new, tabs list; the quoted title JSON-decodes to `window.__title` |
