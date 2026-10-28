# Verification record

> **Renamed.** On 2026-10-28 the project was renamed from x2-browser-mcp to Motorika. The text below
> records history under the old name; read the old names through this table.
>
> | What | Old | New |
> |---|---|---|
> | package and bin | `x2-browser-mcp` | `motorika` |
> | MCP server name | `x2-browser` (advertised `x2-browser-mcp`) | `motorika` |
> | env prefix | `X2B_` | `MOTORIKA_` |
> | default dir | `~/.x2-browser/` | `~/.motorika/` |
> | temp prefix | `x2b-profile-`, `x2b-…` | `motorika-profile-`, `motorika-…` |

State at the initial public commit of Motorika, 2026-10-28. The code is 05aab31 (fix round 7b plus the read-comments, batch-budget and secrets-in-text-paths fixes) with the rename and the open-source preparation on top; its code is 228899e of the private development history. Commit hashes in this file refer to that history, which is not published. macOS (Darwin 25.1.0), Node 24.21.0, Chrome 156.0.8078.48 (Chrome updated itself from 155.0.8059.85 on 2026-10-26 at 22:23). Headless unless noted.

## Verified
| Check | Result | Evidence |
|---|---|---|
| Full suite `npm test`, public tree (2026-10-28) | 1347 tests: 1346 pass, 0 fail, 1 skipped (A5 runs only headed) | Fresh `npm ci` in the new public repo, run alone, 424 s, load 2.45 at the start, on the tree before the privacy edits below. One test more than 05aab31: `--help` names `MOTORIKA_LOG`. The privacy edits after it change one source comment, one fixture and the bench guards; for them `read-comments` (68/68), the unit tests (698/698), the bench tests (87/87, also in a copy with no git history) and `typecheck` were run, not the full suite |
| Rename to Motorika (2026-10-28) | reviewed, no critical | Independent correctness review (flow-verifier-high) with its own scenarios: no half-renames (engine key, sentinels, overlay attribute, socket dir, temp prefixes, the 19 env names against HELP and README), the markers are no easier to forge than before, `tools/list` is identical apart from `serverInfo`, `MOTORIKA_*` is honoured and `X2B_*` ignored, an owner and a joiner share one profile over `~/.motorika/run`. Its warning (a red-first run against a pre-rename build silently misses the planted engine) and three nits are fixed or noted in the test headers. One nit stays: a regenerated r2 detail block keeps the recorded `x2-browser` label in its Start/End line |
| Open-source sweep and privacy review (2026-10-28) | clean | A pattern sweep (home paths, usernames, work addresses, session links, ticket ids, the old test persona, key and token formats) has 0 hits, and no raw agent streams are published. An independent privacy review then read every text file for personal content the patterns cannot see; its items were neutralised in place, the bench test persona was replaced (in the recorded JSON only exact-equal strings changed, no number), and a re-check found nothing critical in the tree; its warnings were fixed. All eight generated blocks of `bench/RESULTS.md` regenerate byte-identically from the published JSON alone, with no stream present (after mapping `motorika` back to the recorded `x2-browser` label). `npm pack --dry-run` ships 120 files: `dist/`, `README.md`, `LICENSE` and `package.json` |
| Full suite `npm test` | 1346 tests: 1345 pass, 0 fail, 1 skipped (A5 runs only headed) | Run alone on main 05aab31, 419 s, 2026-10-27; no other run of ours (log `~/x2b-merge-0127/full-suite-05aab31.log`). It includes the build, so `dist/` is that commit. Up from 1183 on ef2f9a0 (2026-10-26): `read-comments`, `batch-budget`/`batch-cap` and `secrets-text` (unit and regress) were added |
| Independent re-checks, fix rounds 3–7b | round 7 closed | Each round was re-checked by separate reviewer agents (correctness on flow-verifier-high, security on flow-verifier-max) with their own scenarios; every re-check up to round 7 found a new critical. The re-check of 7b (ef2f9a0) closed both criticals: 0 secret leaks in 5 secrets × 24 wrappers × 16 print sites, 0 of 36 false "gone" in a busy-frame matrix, and no unavailable frame on 28 real sites. Reports: `docs/reviews/recheck-r6.md`, `recheck-r7.md`, PLAN "re-check of round 7b". Backlog: PLAN's 7b block and that re-check block |
| Reviews of the three fixes merged on 2026-10-27 | closed | Each one had an independent review with its own scenarios, a fix and a re-check that closed it. **read-comments** (correctness): a username in an aria-label dropped the whole comment; closed. **batch-budget** (correctness): separators were not counted, and an error's cause was lost under the floor; closed. **secrets in text paths** (security, flow-verifier-max): C1 critical, secret-named URL parameters printed in read/console/evaluate, a regression against fba6f4f; W1, emoji secrets as surrogate-pair escapes. Both closed on 51be402: 0 secret rows in 56, 0 leaks in a 365,330-row matrix, 0 regressions against fba6f4f or main in 120,000 random URL rows, byte-identical no-secret output against main (600,000 comparisons), linear cost (3.4–3.8× for 4× input). Report: `docs/reviews/review-secret-text-paths.md`. The reviewer checked the C1 and W1 shapes in-process only; the author's `test/regress/secrets-text.test.ts` drives them through Chrome (3 of 3 red on ee4c863, green on 51be402) |
| H1 run 1 (2026-10-21, build 13fb319) | pass | `claude -p --strict-mcp-config` against httpbin.org/forms/post; 3 browser tool calls, 27 s; every echoed value present |
| H1 run 2 (2026-10-22, build e9a13c0) | pass | Same task: 4 browser tool calls (navigate, fill_form, click, read), 17 s, every echoed value present; harness in `docs/verification/`. The run log is not published. It typed the earlier test persona, so `analyze.mjs`, which now expects the neutral one, would not match it |
| E8 headless (YouTube) | pass | `video frames count=4` on a real watch page after clicking through the consent wall: 4 non-black, mutually different frames, inspected by eye |
| Performance targets | pass | Re-check lens, n=20, busy machine (see table) |
| Bench B2 round 2 (2026-10-26 and 2026-10-27) | run, all 8 tools | 5 tasks × 5 runs, balanced order, warm-ups, 191 runs, $31.99 plus the BrowserMCP timeouts. The six headless tools ran on server code ef2f9a0 with Chrome 155. Claude in Chrome and BrowserMCP ran a day later in a real desktop Chrome 156. Like-for-like mean: x2-browser 26.3 s / $0.127, Playwright 26.6 s / $0.131, Claude in Chrome 37.7 s / $0.167. BrowserMCP was stopped by the T1 rule. Conclusion: `bench/RESULTS.md` "Round 2"; merged results `bench/results/2026-10-27-agent-r2-all8.json` |
| Bench F1/F2 (2026-10-23) | run | `bench/RESULTS.md`. B1: micro steps, n=20, four tools, then six. B2: 36 agent runs across six tools, then a 24-run re-run after the viewport-snapshot change (x2-browser, Playwright, playwright-vision, puppeteer), then a final 30-run B2 with n=5 and warm-ups, x2-browser against Playwright (conclusion at the top of RESULTS.md) |
| H2 real-web smoke | pass | Covered by the B2 agent tasks, run by real `claude -p` agents. T2 is a Wikipedia search (`type` with submit), then `read` of the article. T3 opens three real sites with `tabs new` inside a `batch`, then acts on them with `evaluate {tab: tN}`. x2-browser passed both 5/5 in the final run (`bench/results/2026-10-23-agent-final.json`) and 2/2 in each earlier session |
| A2 headed subset (2026-10-26, main ef2f9a0 code) | pass | B2, D1, D3, D8, D9, E2 in visible Chrome windows: 16 of 16 (`X2B_TEST_SHOW=1`, which drops `--headless` in the test client). Log `~/x2b-headed/a2-headed.log` |
| A5 headed (2026-10-26) | pass | `X2B_TEST_HEADED=1`, the test alone: headless → headed switch, tabs not carried, cookies kept. (Under `X2B_TEST_SHOW=1` it cannot pass: it needs a headless start.) |
| E8 YouTube, 2026-10-26 | pass, with a limit | Big Buck Bunny watch page. Headed: navigate, `wait text "Reject all"` (the consent wall renders about 0.5 s after navigate returns), `find`, click, `video list`, `play`. Frames headless (Playwright's headless Chrome is started with `--mute-audio`): seeks to 5/8/11/14 s gave 4 frames and `every_ms` 1500 gave 5, all different, no overlay, checked by eye. **Limit:** seeks far past the buffered range (79 s, 238 s, 397 s) answer `not-ready` (readyState 0–1), honestly. Same result on 13fb319 (2026-10-21), 2c45028 and c052783, so not a regression: YouTube's player does not fetch for an outside seek. Script `~/x2b-headed/e8.mts` |
| Registered in Claude Code | done | `claude mcp add x2-browser -s user -- node <repo>/dist/index.js`; `claude mcp get` shows Connected |

Performance targets, p50 measured by the re-check lens:

| Step | p50 |
|---|---|
| click | 116.5 ms |
| type | 107.5 ms |
| fill_form, 8 fields + submit | 167 ms |
| snapshot of 1k elements | 8 ms |
| navigate + snapshot | 129 ms |
| click on a page that changes by itself | 117 ms |

## Not verified yet (unknown)
- **Since the rename:** `motorika open` (it starts a headed Chrome) was not run end to end, and the bench was not re-run under the new name. Linux and Windows are untested.
- **Test hygiene:** the 2026-10-28 full-suite run left an empty `~/.motorika/run` in the real home directory (created while it ran; removed by hand). Which test creates it is not traced.
- **The bench on the final build.** Round 2 measured server code ef2f9a0 (fix round 7b). The read-comments, batch-budget and secrets fixes came after it, and the agent tasks were not re-run on them. By design they change output only for comment sections, for batches over the cap, and for remembered secrets. That holds where the reviews' byte-identity checks cover it; it is unmeasured for the bench tasks themselves. The micro numbers (B1) are from 4aaec31 (2026-10-23).
- **Performance on a quiet machine.** The targets above and the re-check's figures (navigate p50 127–130 ms, click p50 138–140 ms on a local page) were measured on a busy laptop.
- **The read depth-800 bound** (under 40 ms) is unmeasured.
- **The backlog** in PLAN.md (the 7b block, its re-check block, and the blocks of the three 2026-10-27 fixes) lists the known open findings. The priority one, a secret glued to a percent-escape in text paths, is fixed and re-checked (above). Still open from that review: one quote character can stay visible for a secret that contains `"` when that quote pairs with another `"` on the line, before or after it; a secret ending in `\` is missed in raw text when `"`, `/` or a letter follows it; and the URL net's nested-parameter and `xhttp://` gaps. All are in [docs/security.md](docs/security.md) ("Not covered" and "Printed URLs"), and the first two are pinned in `test/unit/secrets-text.test.ts`.
- **Bench harness:** the signal test in `bench/agent/run.test.mjs` once left its fake `claude` stub running (2026-10-26, found and stopped 2026-10-27).

## Known limitations
These are documented in the docs pages: origin lists and Chrome's own traffic in [docs/safety.md](docs/safety.md), secret scrubbing in [docs/security.md](docs/security.md), settle in [docs/tools.md](docs/tools.md).
- **Origin lists** are enforced only on what Chrome's request interception sees. Every redirect hop is now checked before it is sent (fix round 3). A blocked IPv4 entry covers only URLs that spell that address, and a public name that resolves to loopback is not caught.
- **Secret scrubbing** covers the literal, any mix of percent-encoded and JSON-escaped characters, next to escapes too, in every output (PLAN "secrets in text paths"; docs/security.md lists exactly what is covered). A base64, case-changed, split, double-encoded or non-UTF-8-charset echo can still appear, and a secret glued to a letter or digit is left alone by design.
- **Settle on a very busy machine:** if two background ticks land in one observer batch, an action can wait out the 600 ms cap.
- **Headless Chrome network traffic:** an idle headless Chrome still opens connections to Google services. This is Chrome's own behaviour, documented.
