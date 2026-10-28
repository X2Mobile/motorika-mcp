# Review of fix/secret-text-paths (ee4c863)

The security reviewer's report (flow-verifier-max), verbatim, from 2026-10-27. Base fba6f4f; merged = main 55d5372
plus the branch's `src` diff. Scripts and logs: `~/x2b-st-review/`. The reviewer ran nothing until the round-2 bench
ended. It drives the branch's one fix round.

## Security (flow-verifier-max)

# Security review (secrets lens): `fix/secret-text-paths` — one critical, one warning, no stall

**Verdict: yes, one critical.** In the incident's own text paths (`read`, `console`, `evaluate`), a secret-named URL parameter now prints in clear where fba6f4f hid it. There is one pre-existing warning and no stall.

**What I checked.** Builds made from git objects: head ee4c863 (85dd643 differs only in PLAN.md), base fba6f4f, main 55d5372, and merged = 55d5372 + `git diff fba6f4f ee4c863 -- src` (applied cleanly). Environment: macOS Darwin 25.1.0, Node v24.21.0, Chrome 156.0.8078.48 (read from Info.plist; the server runs it headless and isolated). Nothing ran until the bench log showed `exit=0`. A bench agent process (pid 88621, `T3-x2-browser-rep1`) was still alive the whole time, probably orphaned. I left it alone.

## Critical

**C1. The URL safety net is never armed in real tool output, so the token leaks instead of the password.**
- **Cause:** `src/dispatch.ts` `final()` turns on `PRINTED_URL_OVER_MARKERS` only when its own scrub changed the text (`scrubbed !== c.text`).
  - Almost every tool that prints page text scrubs before `final()`: `read.ts:37`, `console.ts:15`, `evaluate.ts:102`, plus `common.ts:56`, `network.ts:70` and `dialog.ts:38`.
  - So `final()` finds nothing new, and the old regex still stops at `&lt;`.
- **Repro:** remember `Hunter2xZ`. A page URL holds `http://h.test/r?q=%27Hunter2xZ%27&amp;token=TOKVAL1`. I drove each tool's real pipeline, then the real `Dispatcher.final()`.

| tool | head and merged | base fba6f4f |
|---|---|---|
| read | `[link](http://h.test/r?q=%27&lt;redacted&gt;%27&amp;token=TOKVAL1)` | `…?q=%27Hunter2xZ%27&amp;token=&lt;redacted&gt;` |
| console | `[warning] 12:00:00.000 href …%27&lt;redacted&gt;%27&amp;token=TOKVAL1` | token hidden, password visible |
| evaluate | `"…%27&lt;redacted&gt;%27&amp;token=TOKVAL1"` | token hidden, password visible |

- The fragment form (`#q=%27…%27&amp;access_token=TOKVAL3`) behaves the same way.
- **On fba6f4f:** base printed the password and hid the token. Head hides the password and prints the token. The plain shape `?q=Hunter2xZ&amp;token=V` shows the token on both builds (pre-existing).
- **The net works only where text reaches `final()` unscrubbed**, such as error text.
  - The README claim at lines 539–540 (`?q=%27&lt;redacted&gt;%27&amp;token=&lt;redacted&gt;`) is false for read, console and evaluate.
  - URLs the server prints itself (header, `tabs`, `navigate`, `href=`) are fine.
- **Second symptom where the net is armed:** `see http://a.test/?q=!Hunter2xZ!http://b.test/?token=TOKVAL1` prints `…!&lt;redacted&gt;!http://b.test/?token=TOKVAL1`. Base gave `token=&lt;redacted&gt;`. The `#access_token=` version leaks the same way: the over-marker match runs on into a glued second URL.
- **Why the author's tests pass:** `test/unit/secrets-text.test.ts:172-191` feeds hand-built text containing the raw secret straight into the final pass, so the tool-level scrub never runs.
- **Fix direction (not applied):**
  - Run the secret-parameter check inside `scrubSecrets`, over the URLs that contain the markers it just inserted, so every tool-level scrub handles them.
  - Stop the over-marker match at a following `scheme://`.
  - Send the item-8 test rows through the read, console and evaluate pipelines.
- **Not checked through Chrome** for this exact shape (see Unknown).

## Warning

**W1. A secret with an emoji (or any non-BMP character) leaks when a page shows it as `😀` escapes.**
- **Repro:** secret `Smile😀42`. Raw page text `Smile😀42` in a read body, console message or response body. Output is unchanged, and it JSON-decodes back to the secret.
  - 432 matrix rows on head (raw paths × every edge neighbour), and the same 432 on fba6f4f (pre-existing).
- **Cause:** `secret-match.ts` `decode()` lines 305–306 decode each `\uXXXX` separately. A high/low surrogate escape pair becomes two U+FFFD. The raw-surrogate branch at lines 311–317 does pair them.
- **Trigger:** `ensure_ascii`-style encoders (Python `json.dumps` default) echoing such a password.
- BMP `\uXXXX` escapes are fixed by this branch (856 rows on base, 0 on head). The README claims JSON-escaped coverage with no exception for this, so the few-line fix plus a README line belong in this branch.
- Checked in-process only.

## Nit

**N1.** In the Chrome read run for the secret `Hu"nt!2x`, the output was `body text '&lt;redacted&gt;"&lt;redacted&gt;'`. `emitText` paired the secret's `"` with a later quote on the same raw markdown line. That reveals one character and its position. The README documents this quote-keeping.

## Documented in the README, but not in the brief's exemption list (your call)

- **Secret ending in `\`:** followed by `"`, `/`, `\n` or `\u…` in raw text, it is not redacted (`"trailing\""`, 128 rows). This is the README's "end inside a JSON escape" rule, applied to markdown and console text that has no JSON escaping.
- **Glued secrets stay visible by design:** a secret glued to a letter or digit, or two secrets glued with no edge between them. Examples: `Hunter2xZx` in read; `Hunter2xZhint:` and `## step 1Hunter2xZ` in console.
- **Over-redactions (AC2 deviations the README covers), never a leak:**
  - `pass+word1` also redacts `pass word1`;
  - `pass word1` also redacts `pass%2Bword1`;
  - `ab%41cdef` also redacts `abAcdef`;
  - a page's own `&lt;redacted&gt;` inside a URL widens the safety net once a secret in the same text was redacted.

## Checked and clean
- **AC1 matrix:** 29 secrets × 14 spellings × about 40 neighbour pairs × 10 paths = 365,330 rows per build.
  - On head, W1 is the only undocumented leak group. Base had 87,819 leak rows.
  - Secret shapes covered: regex characters, `%`, `+`, quotes, backslashes, non-ASCII, substring and prefix secrets, and secrets containing `&lt;redacted&gt;`.
- **Touching pairs:** 0 leaks on head in both remember orders (base: 24).
- **Joined-session sharing predicate (`owner.rememberedIn`):** 0 of 47 shapes left unshared, on head and base.
- **AC2:** 600,000 comparisons (no secret, and secrets that cannot occur), 0 differences.
  - Glued shapes: head redacts base's set plus 32 rows. All 32 are another remembered secret appearing whole with an escape as its edge. Base redacts none that head shows.
- **AC3:**

| case | base | head |
|---|---|---|
| 11 cases at 2 MB | — | 9–82 ms |
| 4 costliest at 8 MB | — | 202–303 ms (about linear) |
| 2 MB URL, 1000-char secret (the reported case) | 10,635 ms | 33 ms |
| 200k-char typed value | 307 ms / 393 MB | 78 ms / 220 MB |

  - Peak RSS stayed ≤ 377 MB, and no case came near a cap.
- **AC4:** read, console (with the real line shape) and batch on merged produce 0 forged server lines.
- **Batch per-step cut (merged):** 906 cap values, 0 secret pieces of 6+ chars, 0 forged lines. In the one run where the cut made a glued secret whole, the batch's second `final()` redacted it.
- **Chrome, head:** 4 secrets × 11 outputs (read, snapshot, find, console, evaluate ×3, network, navigate, tabs, error). The only visible secrets were the glued controls I put there on purpose.

**Discarded (my own scenario errors):**
- 810 rows that fed JSON spellings into `safeUrl` (Chrome never puts JSON escapes in a URL);
- my first `ac4` console rows (no real line prefix; redone);
- the emoji spelling in `astral.mjs` (a bug; the matrix covers it correctly);
- the pairs "overlap" rows (my texts were actually glued to a letter);
- head-only page `… ` lines (that escaping rule lands with main; merged shows 0).

## Unknown
- **C1 through Chrome:** not completed. The evidence is in-process, using the real tool-pipeline functions and the real `final()` on head, merged and base.
- **W1 through Chrome:** not run.
- **Not run end to end:** base through Chrome, `fill_form`, and joined-session sharing.
- **Timings:** single runs, not best-of-N, taken while the leftover bench process was alive.
- **Memory cap:** an RSS watchdog (1.5 GB) plus `--max-old-space-size=1024` and a 120 s timeout. RLIMIT_AS was not used, because macOS does not enforce it.

Everything is in `~/x2b-st-review/`. The ones to open first:
- `prescrub.mjs`
- `logs/prescrub.out`
- `logs/prescrub-merged.out`
- `logs/matrix-head.json`
- `logs/perf-all.log`
- `logs/e2e-head.log`

## Notes (main session)

- The leftover process pid 88621 was a fake `claude` stub from `bench/agent/run.test.mjs`'s signal test, orphaned
  since 2026-10-26 16:03 (ppid 1, its temp dir already gone). Stopped on 2026-10-27. Backlog: that test can orphan
  its stub.
- Chrome updated itself to 156.0.8078.48 on 2026-10-26 at 22:23 (the Info.plist mtime). So the six headless
  round-2 tools ran on 155, which ended at 19:46, and the two real-Chrome tools ran on 156 on 2026-10-27. The
  bench files do not record the Chrome version.

## Re-check of the fix round (51be402), security (flow-verifier-max)

Verbatim, 2026-10-27. The branch had merged main at ac79c06; the fix diff is `git diff ac79c06 51be402 -- src`
(`src/util/secrets.ts`, `src/util/secret-match.ts`). Merged into main as 05aab31.

# Re-check of fix round 2 on `fix/secret-text-paths` (51be402): no criticals

**Verdict: no criticals.** C1 (both symptoms) and W1 are closed on 51be402 through the real tool pipelines. Nothing that fba6f4f or main hid now shows. Output with no secret in it is byte-identical to main, and the new URL check stays linear. I found no new findings at any severity.

**Builds** (from git objects, repo untouched): head2 = 51be402 (code equals bb83cb3), main2 = 422588d, base = fba6f4f, and ee4c863 to confirm the "red before" claim. `dispatch.ts` on 51be402 is byte-identical to main. Node v24.21.0, Chrome 156.0.8078.48, macOS Darwin 25.1.0.

## 1. Are C1 and W1 closed?
- **C1, both symptoms: closed.** I ran 14 URL shapes through 4 pipelines (`final()` alone, then read, console and evaluate, each with its tool's own scrub first and then the real `Dispatcher.final()`).
  - The shapes cover the incident, the plain and fragment forms, three glued-second-URL forms, markdown links back to back, a token before the secret, several tokens after it, the secret in the path, a nested URL, `xhttp://`, and camelCase and bracket names.
  - **51be402:** the secret shows in 0 of 56 rows. A token shows in 4, all the `nestedNoSecret` control (`?next=http://b.test/?token=…`, no secret in it), which fba6f4f and main show the same way.
  - **ee4c863:** the token showed in 34 rows, for example `?q=%27&lt;redacted&gt;%27&amp;token=TOKVAL1` through read, console and evaluate.
  - The glued-second-URL shapes are now hidden in all four pipelines. Four shapes that base and main leaked are also hidden now: `?q=&lt;secret&gt;&amp;token=`, a URL glued after `%27&lt;secret&gt;%27`, a nested URL next to a secret, and `xhttp://`.
- **W1: closed.** On 51be402 the full matrix (365,330 rows) has 0 rows where `Smile😀42` leaks. ee4c863 and fba6f4f each had 432. The remaining 128 undocumented rows are all the README-documented `trailing\` case, unchanged from round 1.
- **Chrome:** I did not check the C1 or W1 shapes through Chrome. My earlier attempt at that run was halted, so I did not retry it. Both shapes are covered in-process on all four builds. My general Chrome run on 51be402 (4 secrets × 11 outputs: read, snapshot, find, console, evaluate ×3, network, navigate, tabs, error) shows only the glued controls I added on purpose (`Hunter2xZx`, `O'Brien!26x`, `p@ss w0rdx`, `Hu"nt!2xx`).

## 2. New leaks or regressions?
None found.
- **Matrix, row by row:** 51be402 leaks 0 rows that fba6f4f didn't leak, and 0 that ee4c863 didn't.
- **Random URL differential:** 20,000 texts × 6 paths gives 120,000 rows per build.
  - The paths are `final`, read, console, evaluate, `safeUrl` and `href`.
  - The texts put a secret in many places and spellings, mix secret-named and plain parameters, nest and glue URLs, and vary the wrappers.
  - Result: 0 rows where a token or the secret is hidden on fba6f4f, or on main, but visible on 51be402. 51be402 hides more in 34,736 rows.
- **Byte identity:** 0 differences in 600,000 comparisons against main 422588d (no secret remembered, and secrets that cannot occur).
  - Against fba6f4f there are about 1,116 differences, all in my read pipeline. 51be402 and main are identical on the same seeded inputs, so these come from main's `… ` escaping rule (fix/batch-budget), not from this fix.
- **Other checks on 51be402:** the joined-session sharing predicate fails for 0 of 47 shapes; touching pairs leak 0; AC4 shows 0 forged server lines in read and console.

## 3. Cost
Each case ran once, alone, in its own capped child (RSS watchdog 1.5 GB, `--max-old-space-size=1024`, 120 s). RLIMIT_AS was not used. Every child exited 0 and none came near a cap.

| case | ee4c863, 2 MB | 51be402, 2 MB | 51be402, 8 MB | 8 MB ÷ 2 MB |
|---|---|---|---|---|
| the 46k-URL case (`markersUrls`) | 77 ms | 107 ms (author: 104) | — | — |
| many glued `http://` in one URL | 62 ms | 100 ms | 375 ms | 3.7× |
| bare `http://` repeated | 62 ms | 96 ms | 336 ms | 3.5× |
| about 110k markers in one URL | 82 ms | 102 ms | 346 ms | 3.4× |
| long URL, 64 secrets | 81 ms | 146 ms | 521 ms (RSS 536 MB) | 3.6× |
| distinct parameter names | 63 ms | 152 ms | 572 ms | 3.8× |
| trailing punctuation per segment | 63 ms | 90 ms | 307 ms | 3.4× |
| query with no `=` | 62 ms | 78 ms | 282 ms | 3.6× |
| 64 secrets, many URLs | 76 ms | 107 ms | 382 ms | 3.6× |

- Quadrupling the input costs 3.4× to 3.8× the time, so growth is linear.
- The extra check is bounded but not free: up to about 90 ms more per 2 MB (distinct names).
- My 11 earlier cases run in 9 to 107 ms on 51be402.
- The "unredacted token params" counts in the cost logs are artefacts of my own test setup, not findings:
  - In `longUrl64`, the `token${i}` names aren't secret-named under the word-part rule.
  - In `manySecretsManyRuns`, 2 of my generated secrets were only 5 characters, so they were never remembered.

## 4. Batch per-step cut on 51be402
I swept the output cap across 906 values. 865 runs cut something, and there were 0 secret pieces and 0 forged server lines. In the one run where the cut turned a glued secret into a whole word, the batch's second `final()` redacted it.

## Carried over from round 1, unchanged
These are documented in the README; no severity assigned:
- a secret ending in `\` followed by an escape character;
- secrets glued to a letter or digit;
- N1, the kept `"`, still visible as `'&lt;redacted&gt;"&lt;redacted&gt;'`;
- the URL net's own nested-parameter and `xhttp://` gaps, now named in the README and the same on all builds.

## Not checked
- The C1 and W1 shapes through Chrome.
- fba6f4f through Chrome.
- `fill_form` and joined sessions end to end.

Everything is in `~/x2b-st-review/`. The new scripts are `prescrub2.mjs`, `urldiff.mjs` and `perf2.mjs`. The logs to open first are:
- `logs/prescrub2.out`
- `logs/urldiff.out`
- `logs/matrix2.out` (with `logs/matrix-head2.json`)
- `logs/recheck-misc.out`
- `logs/perf2-all.log`
- `logs/e2e-head2.log`
