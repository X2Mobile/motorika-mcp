# Browser MCP benchmark: results

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
> | bench contender id (`--only`; result files keep the old one, `report.mjs` reads it as the new) | `x2-browser` | `motorika` |
>
> **Test persona.** Also on 2026-10-28, for publication, the bench's test persona was replaced. The recorded
> runs typed an earlier test persona. The published
> task text and result files show the neutral persona: Ann Bench, 10115 (T4) and Ann H1, +1 555 0100 (T1).
> Nothing else in the recorded data changed.

Measured on 2026-10-23 at build 4aaec31 of x2-browser-mcp, plus the bench commits on `feat/bench`.
The tables between `gen:` markers come from `node bench/report.mjs <micro.json> <agent.json>`. The prose
around them is written by hand. Raw data is in `bench/results/`: the JSON and CSV summaries are published,
the raw `claude -p` streams under `results/agent/` are not. They hold third-party page text and the
measuring machine's local Claude Code setup. Every number below comes from the published JSON.

## Conclusion (2026-10-23, final)

The final B2 run compared x2-browser and Playwright MCP 0.0.83 head to head.
- **Runs:** 5 per task for each tool. Before measuring, each tool got one untimed warm-up run (`--warmup`), so no measured run started with a cold prompt cache.
- **Setup:** model `claude-opus-5-5`, live sites, the same machine (heavily loaded).
- **Cost:** 30 runs, $3.03, plus $0.09 for the warm-ups.
- **Code:** the test suite on the same code gives 414 pass, 0 fail and 1 skipped.
- **Data:** `results/2026-10-23-agent-final.json`.
- **Command:** `node bench/agent/run.mjs --tag final --reps 5 --warmup --only x2-browser,playwright`.

| Task | Tool | ok | wall s, median [min–max] | cost USD, median [min–max] | calls | result chars |
|---|---|---|---|---|---|---|
| T1 form | x2-browser | 5/5 | 16.9 [13.6–19.8] | 0.086 [0.085–0.094] | 3 | 2,659 |
| T1 form | playwright | 5/5 | 23.4 [21.2–30.9] | 0.116 [0.106–0.120] | 6 | 5,155 |
| T2 Wikipedia | x2-browser | 5/5 | 15.3 [12.0–17.9] | 0.116 [0.088–0.120] | 3 | 12,570 |
| T2 Wikipedia | playwright | 5/5 | 18.4 [15.1–20.1] | 0.099 [0.094–0.161] | 5 | 4,539 |
| T3 three tabs | x2-browser | 5/5 | 19.1 [14.0–21.7] | 0.095 [0.094–0.103] | 3 | 4,841 |
| T3 three tabs | playwright | 5/5 | 18.2 [17.5–19.9] | 0.090 [0.089–0.094] | 4 | 1,960 |

Mean difference, x2-browser minus Playwright, with Welch's t:

| Task | Cost | Wall time |
|---|---|---|
| T1 form | −$0.027 (t ≈ −8.9) | −8.0 s (t ≈ −3.9) |
| T2 Wikipedia | −$0.004 (t ≈ −0.3) | −2.8 s (t ≈ −2.0) |
| T3 three tabs | +$0.006 (t ≈ +3.1) | −0.6 s (t ≈ −0.4) |

Over all 15 runs, x2-browser averaged 16.4 s and $0.097 per run. Playwright averaged 20.2 s and $0.105. Summing the three task medians gives 51.3 s and $0.297 for x2-browser, and 60.0 s and $0.305 for Playwright.

What we conclude:
- **Both tools solved every task**, 15 of 15.
- **Form filling:** x2-browser is clearly faster and cheaper. One `fill_form` call replaces Playwright's six calls.
- **Reading a content page (T2):** Playwright is typically about $0.02 cheaper: the medians are $0.099 and $0.116. The mean difference is near zero only because of one $0.161 Playwright run. x2-browser is probably faster, but the evidence is borderline (t ≈ −2).
- **Three tabs (T3):** Playwright is about 6% cheaper, half a cent per run. Time is level.
- **Across the three tasks,** x2-browser takes 15–19% less time. Cost is roughly level: 3–8% less, depending on whether medians or means are compared. The real picture is per task: clearly ahead on forms, and a cent or two behind on content pages and on tabs.
- **The tool-result size** on content pages fell by 60–75% after the snapshot change. That change is what closed the cost gap.
- **The other tools** were measured at n = 2, so these are directions only:
  - Chrome DevTools MCP, agent-infra, Claude in Chrome, Playwright in vision mode and BrowserMCP were slower, costlier, or both.
  - BrowserMCP and the Puppeteer reference server cannot open tabs, so they fail T3.
  - agent-infra fails two micro steps.
- **Single steps (B1):**
  - x2-browser is fastest on click (127 ms against Playwright's 527 ms), on form filling and on screenshots.
  - It is slower on typing and on cold start, because it waits for the page to settle and reports what happened. That costs about 0.1 s per action, and it does not show at the agent level.
- **Limits:**
  - three tasks, one model, one heavily loaded machine, and live sites;
  - n = 5 for x2-browser and Playwright only.

## Summary

> **Re-run after the snapshot change:** see that section below. The agent prose in this section describes the first session.

### Micro steps (B1): fastest tool per step, and our output size against the others

"Fastest" counts only tools that passed the oracle on every run of the step. A step with failures has
its numbers in the detail tables, but it is never ranked.

<!-- gen:micro-summary:begin -->
| Step | Fastest p50 (all runs passed) | x2-browser p50 | Output: x2, then each other tool with the x2 difference from it (text chars, median; image bytes for g) |
|---|---|---|---|
| (a) cold first call | agent-infra 598 ms | 809 ms | x2 1,035 chars; playwright 365 chars (x2 184% more); devtools 129 chars (x2 702% more); agent-infra 1,735 chars (x2 40% less) |
| (b) navigate + snapshot, form page | agent-infra 17.4 ms | 123 ms | x2 960 chars; playwright 1,972 chars (x2 51% less); devtools 1,971 chars (x2 51% less); agent-infra 1,735 chars (x2 45% less) |
| (c) complete snapshot, big-1000 | x2-browser 13.0 ms | 13.0 ms | x2 25,559 chars; playwright 38,002 chars (x2 33% less); devtools 30,928 chars (x2 17% less); agent-infra: failed (0/20) |
| (d) click, no navigation | x2-browser 118 ms | 118 ms | x2 33 chars; playwright 250 chars (x2 87% less); devtools 35 chars (x2 6% less); agent-infra 18 chars (x2 83% more) |
| (e) type into an input | playwright 7.0 ms | 107 ms | x2 42 chars; playwright 112 chars (x2 63% less); devtools 35 chars (x2 20% more); agent-infra 73 chars (x2 42% less) |
| (f) fill 8 fields + submit | x2-browser 277 ms | 277 ms | x2 481 chars; playwright 868 chars (x2 45% less); devtools 126 chars (x2 282% more); agent-infra: failed (0/20) |
| (g) viewport screenshot | devtools 15.1 ms | 15.4 ms | x2 33 KB; playwright 37 KB (x2 11% less); devtools 54 KB (x2 39% less); agent-infra 37 KB (x2 11% less) |
<!-- gen:micro-summary:end -->

Where we lose (p50 figures):

- **Cold first call.** We take 809 ms. agent-infra takes 598, Playwright 612 and DevTools 746.
- **Navigate + snapshot.** We take 123 ms. agent-infra takes 17 and Playwright 32. DevTools is close
  to us at 120.
- **Type.** We take 107 ms. Playwright takes 7 and agent-infra 13.
- **Screenshot.** DevTools wins by 0.3 ms (15.1 ms against our 15.4), which is within noise.

Most of the action-time gap is by design: after every action, `src/page/effects.ts` waits for 100 ms of
DOM quiet (`SETTLE.quietMs`, capped at 600 ms). Playwright's click waits even longer (500 ms by default,
`--timeout-settle`), which is why its click is the slowest. Its type and navigate do not wait at all.

Where we win:

- **Click:** 118 ms, against DevTools 239, agent-infra 208 and Playwright 525.
- **Fill 8 fields + submit:** 277 ms in 1 call, against 658 ms in 2 calls for Playwright and DevTools.
  agent-infra failed this step.
- **Complete big-1000 snapshot:** 13 ms in 2 calls, against 18 ms for Playwright and 37 ms for DevTools.
- **Output size:** the smallest text output on both snapshot steps, (b) and (c). On click, ours is
  smaller than Playwright's and DevTools', but agent-infra's is smaller still (18 chars against our 33).
  On type, ours is smaller than Playwright's and agent-infra's, but larger than DevTools'. On fill +
  submit, ours is smaller than Playwright's, but larger than DevTools'.

### Against PLAN.md "Performance targets"

| Target | Measured (x2 p50) | Met |
|---|---|---|
| click ≤ 150 ms | 118 ms | yes |
| type ≤ 150 ms | 107 ms | yes |
| fill_form 8 fields + submit ≤ 900 ms | 277 ms | yes |
| snapshot of 1,000 elements ≤ 300 ms | 13 ms (2 calls: the 20k cap pages it) | yes |
| navigate (local) + snapshot ≤ 400 ms | 123 ms | yes |
| cold first call ≤ 3 s, existing profile | 809 ms, measured with `--isolated` (a fresh temp profile), not an existing one | yes, on a different profile setup |
| faster than `@playwright/mcp@0.0.83` on every step | slower on cold start, navigate + snapshot and type; faster on big snapshot, click, fill + submit and screenshot | **no** |
| ≥ 40% fewer output chars than Playwright on navigate and click | navigate + snapshot 51% fewer; click 87% fewer | yes |

On "navigate" alone, our navigate attaches a snapshot by default (1,035 chars in step a), while Playwright
0.0.83 returns a 365-char summary with a link to a snapshot file. The 40% target is met only when the
comparison includes the snapshot an agent needs, which is step (b).

### Agent tasks (B2): success rate, median time and median cost

This block and the B2 detail block further down render the first round-1 run, `results/2026-10-23-agent.json`
(36 runs, six tools). The final head-to-head in the conclusion above is `results/2026-10-23-agent-final.json`.

<!-- gen:agent-summary:begin -->
| Task | Tool | success | median wall s | median cost USD | median tool calls | median tool-result chars |
|---|---|---|---|---|---|---|
| T1 | x2-browser | 2/2 | 14.1 | 0.123 | 3 | 2,659 |
| T1 | playwright | 2/2 | 20.7 | 0.113 | 5.5 | 5,390 |
| T1 | devtools | 2/2 | 21.0 | 0.160 | 7 | 3,337 |
| T1 | agent-infra | 2/2 | 24.6 | 0.127 | 11 | 3,405 |
| T1 | browsermcp | 2/2 | 61.1 | 0.223 | 16 | 16,585 |
| T1 | claude-in-chrome | 2/2 | 24.8 | 0.137 | 5 | 3,535 |
| T2 | x2-browser | 2/2 | 17.4 | 0.204 | 3.5 | 32,866 |
| T2 | playwright | 2/2 | 22.4 | 0.103 | 5 | 5,007 |
| T2 | devtools | 2/2 | 22.8 | 0.298 | 6.5 | 49,504 |
| T2 | agent-infra | 2/2 | 30.0 | 0.130 | 7 | 10,279 |
| T2 | browsermcp | 2/2 | 16.0 | 0.271 | 3 | 51,214 |
| T2 | claude-in-chrome | 2/2 | 32.0 | 0.151 | 5.5 | 8,668 |
| T3 | x2-browser | 2/2 | 16.4 | 0.170 | 3.5 | 20,631 |
| T3 | playwright | 2/2 | 13.9 | 0.087 | 4 | 2,029 |
| T3 | devtools | 2/2 | 18.1 | 0.095 | 7.5 | 907 |
| T3 | agent-infra | 2/2 | 20.9 | 0.090 | 6 | 1,895 |
| T3 | browsermcp | 0/2 | 144.9 | 0.532 | 10.5 | 58,053 |
| T3 | claude-in-chrome | 2/2 | 24.9 | 0.127 | 5.5 | 2,722 |
<!-- gen:agent-summary:end -->

What the agent numbers say (2 runs per cell, so these are directions, not significance):

- **Success.** The five contenders of the first session passed every task, 30 of 30 runs. Four runs
  first failed on the evidence half of the oracle and were rescored from their saved streams, with
  nothing re-run. See "Oracle fixes after the run" below. BrowserMCP, run separately later that morning,
  passed T1 and T2 (4 of 4) and failed T3 in both runs. It has no tab tools, so it loaded the three
  pages one after another in its one connected tab. The answers were right, but the task asks for three
  tabs.
- **Time.** x2-browser had the lowest median wall time on T1 (14.1 s). On T2, BrowserMCP was quickest
  (16.0 s, 3 calls, reading the fact from a screenshot), then x2-browser (17.4 s). Playwright had the
  lowest on T3 (13.9 s, against our 16.4 s). Summed over all six of its runs, x2 took 96 s, against
  114 s for Playwright, 124 s for DevTools, 151 s for agent-infra, 163 s for Claude in Chrome and 444 s
  for BrowserMCP. BrowserMCP's T1 took 61.1 s. It has no form tool, so after one `browser_navigate` it
  made 8 `browser_type` calls and 7 `browser_click` calls, one for each field, radio button, checkbox
  and the submit button.
- **Cost.** Playwright MCP was the cheapest overall: $0.61 for its six runs, against $0.99 for x2-browser
  and $2.05 for BrowserMCP.
  It was cheapest on T1 ($0.113 against our $0.123), T2 ($0.103 against our $0.204) and T3 ($0.087
  against our $0.170).
- **Why our cost is higher.** Our tool results are large on real pages: a median of 32,866 chars on T2
  and 20,631 on T3, against Playwright's 5,007 and 2,029. Our `navigate`, a navigating `type` and
  `tabs new` attach a snapshot by default. On Wikipedia, each of those hits the ~20k-char cap. Playwright
  0.0.83 writes its snapshots to files and returns a link, so the model sees a few hundred chars per
  action. **The output advantage in the micro steps does not carry over to these agent tasks.**
- **DevTools** is the most expensive on T2 ($0.298), at 49,504 result chars, because of its full
  `take_snapshot` of Wikipedia.

Oracle fixes after the run (each run's `first_verdict` is kept in the JSON):

- **T3, x2-browser (both reps) and Claude in Chrome (rep 2).** The first evidence check counted only
  top-level tab-opening calls. These runs opened their tabs inside a batch call (x2 `batch` steps with
  `tabs {action:"new"}`, and Claude in Chrome `browser_batch` actions with `tabs_create_mcp`). The check
  now looks inside batches.
- **T2, Claude in Chrome (rep 2).** Its `javascript_tool` call was refused with "[BLOCKED: Cookie/query
  string data]". It then read the fact from a zoomed screenshot of the article, and the tab context
  confirms the article URL. The evidence check now accepts an image result taken after the article is
  reached. The run is labelled "fact only in a screenshot (not text-verifiable)" because this oracle
  cannot read pixels.

## Re-run after the snapshot change (2026-10-23, about four hours later, `--tag rerun`)

### What changed between the runs
- **The automatic snapshot.** The snapshot that x2-browser attaches after a new document now covers the viewport only. It is capped at 6,000 chars and ends with a footer pointing to find, read or snapshot (PLAN.md, "Decisions from the bench"). An explicit `snapshot:true` still returns the full page. The settle quiet window stays at 100 ms.
- **Two new contenders.**
  - `playwright-vision`: `@playwright/mcp@0.0.83 --caps vision`. In B2 it may not use `browser_snapshot`, `browser_find`, `browser_evaluate` or `browser_run_code_unsafe`, so it works from screenshots and x/y coordinates.
  - `puppeteer`: the archived reference server, `@modelcontextprotocol/server-puppeteer@2025.5.12`, deprecated on npm. It runs headless on the installed Chrome through `PUPPETEER_LAUNCH_OPTIONS`.
- **Not run: `@executeautomation/playwright-mcp-server@1.0.12`.** Headless is a per-call argument that defaults to false, and no flag or environment variable forces it. Installing it also downloads three browsers.

### How it ran
- **B2:** x2-browser, Playwright as the same-session control, and the two new contenders. 24 runs in total, costing $3.15.
- **B1:** all six stdio tools.
- **Load:** heavy. The 1-minute load average was 12.8–13.7, with swap nearly full. Wall times are slower than in the first session for most tools.
- **Files:** results are in `results/2026-10-23-agent-rerun.json` and `results/2026-10-23-micro-rerun.json`. Logs are in `results/agent/2026-10-23-rerun/`.

### B2 agent tasks: median of 2 runs (success, wall time, cost, tool calls, tool-result chars)

| Task | Tool | first session | re-run |
|---|---|---|---|
| T1 | x2-browser | 2/2, 14.1 s, $0.123, 3 calls, 2,659 chars | 2/2, 20.3 s, $0.126, 3 calls, 2,756 chars |
| T1 | playwright | 2/2, 20.7 s, $0.113, 5.5 calls, 5,390 chars | 2/2, 21.8 s, $0.106, 5 calls, 4,688 chars |
| T1 | playwright-vision | – | 2/2, 33.1 s, $0.197, 8 calls, 3,720 chars |
| T1 | puppeteer | – | 2/2, 27.4 s, $0.130, 12 calls, 4,301 chars |
| T2 | x2-browser | 2/2, 17.4 s, $0.204, 3.5 calls, 32,866 chars | 2/2, 18.8 s, $0.119, 3 calls, 12,820 chars |
| T2 | playwright | 2/2, 22.4 s, $0.103, 5 calls, 5,007 chars | 2/2, 20.8 s, $0.098, 4.5 calls, 5,580 chars |
| T2 | playwright-vision | – | 2/2, 23.8 s, $0.115, 5 calls, 2,462 chars |
| T2 | puppeteer | – | 2/2, 38.3 s, $0.113, 9 calls, 3,209 chars |
| T3 | x2-browser | 2/2, 16.4 s, $0.170, 3.5 calls, 20,631 chars | 2/2, 19.0 s, $0.095, 3 calls, 4,888 chars |
| T3 | playwright | 2/2, 13.9 s, $0.087, 4 calls, 2,029 chars | 2/2, 18.7 s, $0.089, 4.5 calls, 1,947 chars |
| T3 | playwright-vision | – | 2/2, 27.4 s, $0.108, 6 calls, 2,265 chars |
| T3 | puppeteer | – | 0/2, 96.5 s, $0.276, 13 calls, 1,667 chars |

Totals over each tool's six re-run runs:

| Tool | Passed | Wall time | Cost |
|---|---|---|---|
| x2-browser | 6/6 | 116 s | $0.68 |
| Playwright | 6/6 | 123 s | $0.59 |
| playwright-vision | 6/6 | 168 s | $0.84 |
| puppeteer | 4/6 | 325 s | $1.04 |

What it says. With n = 2, read these numbers by kind:
- **Wall times differ by a few seconds, and that is noise.** Our T1 moved from 14.1 s to 20.3 s with no relevant code change.
- **Per-run cost and result chars are much steadier.** Leaving out the cold-cache runs, the two reps of each cell are under 4% apart.

- **x2-browser's cost fell where the snapshot was the problem.** T2 went from $0.204 to $0.119, and T3 from $0.170 to $0.095. The tool-result chars on T2 and T3 dropped by 61% and 76%. Our total went from $0.99 to $0.68. Over the same session, Playwright's went from $0.61 to $0.59.
- **Each tool's first T1 run paid a cold prompt cache.** A contender's first run writes its own prompt prefix to the
  cache, so its first turn reads 0 cached tokens.
  - x2-browser's T1 rep 1 cost $0.166, against $0.087 for rep 2. The first session shows the same: $0.162
    against $0.084.
  - In the first session, DevTools, agent-infra and BrowserMCP show the same pattern.
  - Playwright and Claude in Chrome were already warm on their first run, reading 7,554 and 11,500 cached
    tokens. Why is unknown.
  - **Comparing rep 2 only,** T1 cost $0.087 for x2-browser and $0.106 for Playwright. With T1 counted at its rep 2
    cost, the six-run totals are $0.60 and $0.59: a tie.
- **What remains.** On T2, Playwright is about $0.02 cheaper per run.
  - Most of our ~12.8k T2 result chars are the two automatic viewport snapshots, about 9.9k between them:
    - navigate on the Wikipedia main page: 4,092 chars;
    - the navigating `type` that lands on the article: 5,813 chars.
  - `read` adds 2.7k–3.2k.
  - Wikipedia's viewport is dense with links, so the 6,000 cap is the lever there.
  - On T3 the gap is about $0.005, which is within the noise.
- **The new contenders.**
  - Vision costs more and takes longer on every task. Screenshots replace the text tree, and its T1 needed 8 calls.
  - Puppeteer has no tab tools, so it fails T3 in both runs. It also needs the most calls, because it has no snapshot and the agent probes the page with `puppeteer_evaluate`.
- **Fix later.** Before its measured runs, give each contender one untimed warm-up run, or report rep 2 and later only.

### B1 micro steps, re-run: p50 ms and output chars (n=20; cold start n=10)

| Step | x2-browser | playwright | playwright-vision | devtools | agent-infra | puppeteer | x2 in the first session |
|---|---|---|---|---|---|---|---|
| a cold start | 1234.8 / 1,035 | 789.8 / 365 | 869.1 / 365 | 1117.6 / 129 | 860.3 / 1,735 | 717.2 / 46 | 808.7 / 1,035 |
| b navigate + snapshot | 135.1 / 960 | 36.4 / 1,972 | fail 0/20 | 131.8 / 1,971 | 28.1 / 1,735 | 12.8 / 338 | 122.8 / 960 |
| c 1k-element snapshot | 19.3 / 25,559 | 20.4 / 38,002 | fail 0/20 | 58.5 / 30,928 | fail 0/20 | fail 0/20 | 13.0 / 25,559 |
| d click | 127.0 / 33 | 527.4 / 250 | 510.5 / 262 | 245.1 / 35 | 213.5 / 18 | 5.3 / 15 | 117.7 / 33 |
| e type | 109.6 / 42 | 8.9 / 112 | 581.4 / 1,287 | 239.9 / 35 | 26.9 / 73 | 13.7 / 73 | 107.3 / 42 |
| f fill_form, 8 fields + submit | 295.9 / 481 | 707.7 / 868 | 4420.9 / 7,268 | 690.4 / 126 | fail 0/20 | 138.4 / 292 | 277.0 / 481 |
| g screenshot | 12.6 / 69 | 35.4 / 329 | 25.4 / 329 | 23.6 / 49 | 27.8 / 40 | 31.6 / 36 | 15.4 / 69 |

Notes on the micro table:
- **Puppeteer's** fast b, d and e come from doing nothing after an action: no settle and no snapshot. Its b is a bare navigate with a 338-char reply. Its c fails because `innerText` runs the 1,000 adjacent buttons together.
- **Vision** has no snapshot equivalent for b and c. Its f is 4.4 s because it fills field by field through the mouse and keyboard.
- **x2-browser's** cold start and c are slower than in the first session. The cold start code did not change, and the performance review's A/B (interleaved, n=20) found no change on the explicit snapshot path, so the likely cause is the heavier load. These pages fit in the viewport, so the b output is the same as before.

## Round 2 (2026-10-26 and 2026-10-27): all 8 tools

**Goal:** every contender we have, on five tasks, n = 5 each, with a balanced, seeded run order so that
drift hits all tools equally.
- **Tasks:** T1–T3 unchanged (byte-identical to the 2026-10-23 code, tested), plus T4 shop checkout and
  T5 long thread (see Method → B2).
- **Single tab:** T4 and T5 need only one tab, so BrowserMCP and Puppeteer can solve them. Tab support
  stays T3's test.
- **Model:** `claude-opus-5-5`, as in round 1.

**Before the run (the operator):**
1. `npm run build` on the code being measured, then `(cd bench && npm ci)`. Note the commit in the results.
2. BrowserMCP: check `lsof -nP -iTCP:9009 -sTCP:LISTEN`. Stop a BrowserMCP server that the bench did not
   start only with the operator's approval: it may belong to another Claude session. Then open Chrome, click the
   BrowserMCP extension and connect a tab. It reconnects by itself to each new server, so the tab stays
   connected for the whole run. Its startup kill (narrowed to listeners by `agent/lsof-listen-only`)
   runs at every BrowserMCP spawn: about 26 times.
3. Claude in Chrome: the extension is signed in and Chrome is open.
   - **T4 runs on a local shop** at `http://127.0.0.1:47823` (fixed port, `--shop-port` to change it). The
     bench starts it, and nothing else may hold that port.
   - Claude in Chrome asks for site permission per site. Whether it asks for `127.0.0.1`, and whether
     `claude -p --chrome` can answer that prompt, is **unknown**: it was not probed, because the brief
     forbids running it. Before the run, start the shop by hand (`node bench/agent/shop-server.mjs`
     prints a URL) and open that URL once in Chrome through the Claude extension. Grant it if asked, so
     no measured run blocks on a permission prompt.
   - BrowserMCP drives the connected tab directly and has no site permissions, so it should reach the
     shop; this is also unprobed.
4. Both drive the operator's everyday Chrome, visible, for the whole run. Do not use that Chrome while the run is
   going.

**The command** (all 8 tools; BrowserMCP is opt-in, so every tool is named):

```bash
node bench/agent/run.mjs --tag r2 --balanced --warmup --reps 5 --tasks T1,T2,T3,T4,T5 \
  --only x2-browser,playwright,playwright-vision,devtools,agent-infra,puppeteer,claude-in-chrome,browsermcp
# if it stops: node bench/agent/run.mjs --resume bench/results/<date>-agent-r2.json
node bench/report.mjs --prefix r2 --csv bench/results/<date>-agent-r2.csv bench/results/<date>-agent-r2.json
```

**Estimate:** about $45 ($35–55) and 2.5–3.5 hours for 200 runs plus 8 warm-ups. That is about twice
the earlier $20–25 guess. How it is built:
- T1–T3: 120 runs at the round-1 mean over the 8 tools, $0.16 and about 37 s with reaping.
- T4 and T5: 80 runs. The probe costs ($0.15–0.22, the local-shop T4 included) are scaled by the same ratio the other tools showed
  against x2-browser and Playwright in round 1 (about 1.6×).
- The long tail is BrowserMCP and Puppeteer: up to 211 s per run in round 1.

### Round 2 probes (oracle validation, 2026-10-26)

x2-browser and Playwright only, headless and `--isolated`, one run each, `--budget-usd 1`, no warm-up,
model `claude-opus-5-5`, at abea518. Total spend: $0.71.

| Task | Tool | ok | wall s | cost USD | calls | result chars | how it solved it |
|---|---|---|---|---|---|---|---|
| T4 (retired saucedemo version) | x2-browser | yes | 28.8 | 0.213 | 12 | 3,702 | `fill_form` login and checkout, `evaluate` to read the overview and the complete page |
| T4 (retired saucedemo version) | playwright | yes | 50.5 | 0.188 | 14 | 10,031 | snapshot, `browser_find`, `browser_fill_form`, clicks, `browser_evaluate` for the overview and the complete page |
| **T4 local shop** (at c0c2269 + main ef2f9a0, `--budget-usd 0.45`) | x2-browser | yes | 35.1 | 0.220 | 12 | 5,706 | `navigate`, `read`, `fill_form` login, clicks (add, cart, checkout), `fill_form` checkout, `read` overview, click Finish, `read` the confirmation; id in the shop log, order right |
| **T4 local shop** | playwright | yes | 37.2 | 0.175 | 15 | 8,211 | snapshots, `browser_fill_form`, clicks through the same forms; id in the shop log, order right |
| T5 | x2-browser | yes | 19.7 | 0.161 | 3 | 24,423 | navigate, then two `evaluate` calls that dump every comment row (user, depth, text) |
| T5 | playwright | yes | 24.9 | 0.150 | 2 | 27,455 | navigate, then one `browser_evaluate` that dumps every comment row |
| T5 | x2-browser | invalid | 0 | 0 | 0 | 0 | first attempt: the precheck got HTTP 419 from HN for its made-up "Mozilla/5.0 (...)" user agent, so no agent started. Fixed in d56dafe (honest UA, one retry). |

Files: `results/2026-10-26-agent-probe-t4-shop.json` (the current T4, with each run's `shop_orders`),
`-probe-t4.json` (retired saucedemo T4), `-probe-t5.json` (the invalid one), `-probe-t5b.json`,
`-probe-t5-playwright.json`, with their streams in `results/agent/`. Spend: $0.71 for the first probes
plus $0.39 for the local-shop T4.

**What the probes show:**
- Both oracles pass genuine runs. For T4 the shop logged exactly one order per run, and the reported id
  matched it.
- **T5 is solved with a script, not by reading.** Both agents dumped the whole thread with one
  `evaluate` call and never paged through a snapshot. T5 therefore measures "can the agent script the
  DOM" for every tool that has evaluate. Only Playwright vision has evaluate forbidden, so it must page
  through screenshots.

**Decided (2026-10-26):** evaluate stays allowed on T5, so T5 is reported as "solved by script
where the tool can". The full run is approved at about $45.

**Still open:**
1. **Claude in Chrome and localhost.** Resolved on 2026-10-27. The shop was opened once through the extension
   before the run, and no permission prompt appeared. Then all 25 Claude in Chrome runs reached the shop.
2. **Untested contenders on T4 and T5.** Puppeteer, devtools, agent-infra and vision are unprobed on these
   two tasks. The first rep of the full run is their probe. The T4 oracle does not depend on their output
   shapes (`agent/shop.test.mjs`).

### Round 2 results

**Status:** all 8 tools are measured, in two sessions.
- **2026-10-26, the six headless tools.** `--tag r2 --balanced --warmup --reps 5`, 150 runs, $23.84. Code measured:
  server `src/` at ef2f9a0, the round-7b merge (main fba6f4f).
- **2026-10-27, the two tools that drive a real, signed-in desktop Chrome.** Claude in Chrome and BrowserMCP,
  `--tag r2-realchrome`, same flags, 41 runs, $8.15 (plus the BrowserMCP timeouts, whose cost is unknown). Bench
  code identical to 6da69a1. No x2-browser code is involved in these two tools.
- **Model:** `claude-opus-5-5` in both sessions.
- **Tables:** the tables below render the merged file `results/2026-10-27-agent-r2-all8.json`, written by
  `node bench/merge-agent.mjs <out> <r2.json> <r2-realchrome.json>`. The merge refuses a tool present in both inputs,
  or a different model or timeout. CSV: `-agent-r2-all8.csv`.
- **The 2026-10-27 streams were never in git.** `results/agent/2026-10-27-r2-realchrome/` stayed on the laptop. They come from a signed-in desktop Chrome, so they are not
  published. The JSON and CSV above were checked with grep for the account name, and they are committed.
- **The two sessions are a day apart.** The order was balanced within each session, not across them. The load average
  was 4.2→1.9 on 2026-10-26 and 4.8→3.2 on 2026-10-27.
- **Chrome version:** Chrome updated itself to 156.0.8078.48 on 2026-10-26 at 22:23. So the six headless tools ran on
  Chrome 155 and the two real-Chrome tools on 156. The result files do not record it; this comes from the app's
  Info.plist time.

**What happened during the run:**
- **The Mac slept** from 17:59 to 19:03, waking for a few seconds about every 15 minutes (`pmset -g log`). Five runs
  were in flight: T1 rep 4 of playwright, devtools, agent-infra, playwright-vision and puppeteer. Each lasted
  15–17 min and made 0 tool calls. They were voided (kept under `voided` in the JSON) and re-run with `--resume`
  under `caffeinate -i`. All five passed.
- **The network changed** during x2-browser T5 rep 5 (`net::ERR_NETWORK_CHANGED`). Hacker News did not reach
  domcontentloaded in 30 s, and the tool said so: `(still loading: …)`. The agent then spent about 100 s
  thinking and reloaded. That run took 160.9 s and passed. **It is kept**: it counts against us, and the medians
  hardly move.
- **Second session (2026-10-27):** the pre-run steps above were followed. With the operator's approval, a BrowserMCP
  server not started by the bench was stopped, and a tab was connected by hand. A `--probe-chrome` came first, then warm-ups for both tools. The
  security re-check of a fix branch was held until the bench ended, so the machine ran no test load from us.
  - **BrowserMCP was stopped by the T1 rule** after 4 T1 runs: rep 1 and rep 4 hit the 6 min timeout. In rep 1,
    six parallel `browser_type`/`browser_click` calls all returned `WebSocket response timeout after 30000ms`.
    The keystrokes kept arriving after the timeout and garbled the fields (the e-mail field held "L+h"). Later
    single `browser_type` calls timed out the same way while the text appeared slowly. Reps 2 and 3 passed in
    about 60 s. So BrowserMCP has 4 T1 runs and 3 runs of each other task, and it is left out of the like-for-like
    row.
  - **Cause not established.** One untested hypothesis: Chrome throttles a tab that is not in front, and Claude in
    Chrome's runs open their own window in the same Chrome. Round 1 saw the same long tail (up to 211 s).
  - **BrowserMCP cannot open tabs.** T3 failed 0/3 for that reason ("tab-opening calls=0"); all three titles
    were right.

**What we conclude** (Welch's t on n = 5 per cell, x2-browser against each tool; |t| above about 2.5 is a clear
difference):
- **Forms (T1):** x2-browser is faster and cheaper than every other tool. It finished in 13.3 s against 21.1 s for
  Playwright, and every t is 5 or more on both time and cost.
- **Shop checkout (T4):**
  - x2-browser is the fastest, at a median of 32.9 s against 38.4 s for Playwright (t ≈ −2.0, borderline).
  - It is cheaper than Playwright, $0.153 against $0.173 (t ≈ −4.6).
  - agent-infra costs about the same (t ≈ +1.7).
- **Reading a content page (T2):**
  - x2-browser is the fastest by median, but it is not the cheapest.
  - playwright-vision is $0.03 cheaper (t ≈ +2.6) and as fast. Without its snapshot tools, it answers from
    one screenshot.
  - Playwright is about $0.02 cheaper (t ≈ +1.5).
- **Three tabs (T3):** time is level with every tool that can open tabs. Playwright is $0.008 cheaper
  (t ≈ +4.3). Puppeteer cannot open tabs and fails 0/5.
- **Long thread (T5):** no tool is clearly faster or cheaper than x2-browser, except that playwright-vision is clearly
  costlier. Almost every agent pulled the thread out with one `evaluate`.
- **Claude in Chrome** passed 25/25, in a real, visible Chrome. Against it, x2-browser:
  - is faster on T1 (13.3 s against 35.3 s, t ≈ −5.1), T2 (14.7 against 30.5 s, t ≈ −6.9) and T4 (32.9 against
    70.7 s, t ≈ −11.0);
  - is level on T3 (17.4 against 22.6 s, t ≈ −1.1);
  - is level on T5 by mean, because of x2-browser's 160.9 s network-change run (medians 21.5 against 29.2 s);
  - is cheaper on T1, T3, T4 and T5 (T4 $0.153 against $0.253, t ≈ −12);
  - costs more on T2: Claude in Chrome is about $0.01 cheaper there ($0.110 against $0.119, t ≈ +2.0). Like
    playwright-vision, it answers from a screenshot (`browser_batch` plus `computer`), with about 1.8k chars of text.
- **BrowserMCP** passed 10 of its 16 runs. T3 failed 0/3, for want of tabs. On every task it solved, it was slower
  and costlier than x2-browser by median. Its T2 median (24.0 s) is the closest. 7 of its 16 runs took over 80 s,
  3 of them the full 360 s.
- **Overall (like-for-like mean over the five tasks):**
  - x2-browser 26.3 s and $0.127;
  - Playwright 26.6 s and $0.131;
  - DevTools 27.2 s and $0.175;
  - agent-infra 29.7 s and $0.133;
  - Claude in Chrome 37.7 s and $0.167;
  - playwright-vision 38.1 s and $0.208;
  - Puppeteer 50.1 s and $0.179, with 20/25 passed;
  - BrowserMCP is left out (T1 rule).

  Against Playwright that is a tie overall. The difference is per task: clearly ahead on forms and on the
  checkout, level on tabs and the thread, and a cent or two behind on reading a content page.
- **Limits:**
  - one model, one laptop, live sites (T1–T3, T5) and a local shop (T4);
  - Claude in Chrome and BrowserMCP ran headed in a real, signed-in Chrome on the next day; the other six ran
    headless with fresh profiles;
  - the load average was 4.2 at the start and 1.9 at the end;
  - the balanced order spreads drift evenly over the tools, but it does not remove it.


<!-- gen:r2-agent-summary:begin -->
| Task | Tool | success | median wall s | median cost USD | median tool calls | median tool-result chars |
|---|---|---|---|---|---|---|
| T1 | x2-browser | 5/5 | 13.3 | 0.087 | 3 | 2,659 |
| T1 | playwright | 5/5 | 21.1 | 0.108 | 5 | 4,688 |
| T1 | playwright-vision | 5/5 | 33.4 | 0.154 | 8 | 4,004 |
| T1 | devtools | 5/5 | 21.3 | 0.109 | 7 | 3,277 |
| T1 | agent-infra | 5/5 | 26.6 | 0.117 | 12 | 3,685 |
| T1 | puppeteer | 5/5 | 27.4 | 0.120 | 12 | 4,202 |
| T1 | browsermcp | 2/4 | 210.7 | 0.196† (2 of 4 without cost) | 17.5 | 12,022 |
| T1 | claude-in-chrome | 5/5 | 35.3 | 0.125 | 5 | 3,654 |
| T2 | x2-browser | 5/5 | 14.7 | 0.119 | 3 | 12,938 |
| T2 | playwright | 5/5 | 19.7 | 0.103 | 5 | 5,342 |
| T2 | playwright-vision | 5/5 | 14.8 | 0.087 | 3 | 1,194 |
| T2 | devtools | 5/5 | 21.9 | 0.293 | 6 | 49,489 |
| T2 | agent-infra | 5/5 | 31.6 | 0.168 | 8 | 15,887 |
| T2 | puppeteer | 5/5 | 31.9 | 0.115 | 9 | 2,900 |
| T2 | browsermcp | 3/3 | 24.0 | 0.267 | 5 | 48,183 |
| T2 | claude-in-chrome | 5/5 | 30.5 | 0.110 | 5 | 1,819 |
| T3 | x2-browser | 5/5 | 17.4 | 0.100 | 3 | 4,631 |
| T3 | playwright | 5/5 | 20.0 | 0.091 | 4 | 1,968 |
| T3 | playwright-vision | 5/5 | 23.6 | 0.111 | 6 | 2,249 |
| T3 | devtools | 5/5 | 24.8 | 0.094 | 7 | 848 |
| T3 | agent-infra | 5/5 | 24.3 | 0.090 | 6 | 1,895 |
| T3 | puppeteer | 0/5 | 128.2 | 0.311 | 13 | 1,599 |
| T3 | browsermcp | 0/3 | 57.4 | 0.321 | 7 | 51,608 |
| T3 | claude-in-chrome | 5/5 | 22.6 | 0.104 | 5 | 2,277 |
| T4 | x2-browser | 5/5 | 32.9 | 0.153 | 12 | 6,125 |
| T4 | playwright | 5/5 | 38.4 | 0.173 | 15 | 8,211 |
| T4 | playwright-vision | 5/5 | 63.3 | 0.327 | 21 | 8,696 |
| T4 | devtools | 5/5 | 46.1 | 0.156 | 11 | 6,329 |
| T4 | agent-infra | 5/5 | 40.5 | 0.143 | 18 | 2,999 |
| T4 | puppeteer | 5/5 | 36.0 | 0.162 | 19 | 6,266 |
| T4 | browsermcp | 2/3 | 60.1 | 0.167† (1 of 3 without cost) | 12 | 10,142 |
| T4 | claude-in-chrome | 5/5 | 70.7 | 0.253 | 16 | 7,975 |
| T5 | x2-browser | 5/5 | 21.5 | 0.178 | 4 | 26,036 |
| T5 | playwright | 5/5 | 15.9 | 0.169 | 2 | 32,731 |
| T5 | playwright-vision | 5/5 | 56.0 | 0.390 | 18 | 6,050 |
| T5 | devtools | 5/5 | 20.9 | 0.192 | 4 | 36,350 |
| T5 | agent-infra | 5/5 | 21.1 | 0.151 | 3 | 16,192 |
| T5 | puppeteer | 5/5 | 17.8 | 0.180 | 2 | 33,070 |
| T5 | browsermcp | 3/3 | 106.2 | 0.357 | 24 | 3,994 |
| T5 | claude-in-chrome | 5/5 | 29.2 | 0.234 | 6 | 39,257 |

† Some runs have no recorded cost: they were killed at the hard timeout before `claude` wrote its result line. A run's own cost then shows n/a. A median, mean or total marked † covers only the runs with a cost, and states how many were left out. A timed-out run usually costs more than the others, so the marked figure understates.
<!-- gen:r2-agent-summary:end -->

<!-- gen:r2-agent-cross:begin -->
Each cell: runs passed / runs (a timeout is a failure); wall seconds, median [min–max]; cost USD, median [min–max]. A tool missing a task shows "not run".
The last row compares like with like. For each tool it is the mean of that tool's per-task means, over exactly the tasks named in the row, which every compared tool ran. Each task weighs the same. A tool with any unknown cost there shows "n/a (k runs unknown)".

| Task | x2-browser | playwright | playwright-vision | devtools | agent-infra | puppeteer | browsermcp | claude-in-chrome |
|---|---|---|---|---|---|---|---|---|
| T1 form | 5/5; 13.3 [12.1–14.6] s; $0.087 [0.084–0.088] | 5/5; 21.1 [18.7–28.1] s; $0.108 [0.106–0.117] | 5/5; 33.4 [24.9–39.5] s; $0.154 [0.148–0.176] | 5/5; 21.3 [19.2–23.0] s; $0.109 [0.108–0.121] | 5/5; 26.6 [23.2–33.3] s; $0.117 [0.112–0.130] | 5/5; 27.4 [24.9–35.1] s; $0.120 [0.117–0.121] | 2/4; 210.7 [59.9–360.0] s; $0.196 [0.186–0.205]† (2 of 4 without cost) | 5/5; 35.3 [25.8–49.0] s; $0.125 [0.123–0.135] |
| T2 Wikipedia | 5/5; 14.7 [12.4–16.8] s; $0.119 [0.119–0.167] | 5/5; 19.7 [17.4–36.1] s; $0.103 [0.101–0.140] | 5/5; 14.8 [13.1–22.6] s; $0.087 [0.086–0.116] | 5/5; 21.9 [17.8–28.3] s; $0.293 [0.285–0.387] | 5/5; 31.6 [17.0–42.4] s; $0.168 [0.115–0.215] | 5/5; 31.9 [25.8–44.5] s; $0.115 [0.111–0.122] | 3/3; 24.0 [20.4–192.7] s; $0.267 [0.261–0.589] | 5/5; 30.5 [24.6–35.5] s; $0.110 [0.106–0.113] |
| T3 three tabs | 5/5; 17.4 [15.8–26.4] s; $0.100 [0.093–0.103] | 5/5; 20.0 [17.2–29.8] s; $0.091 [0.089–0.094] | 5/5; 23.6 [16.6–37.1] s; $0.111 [0.102–0.134] | 5/5; 24.8 [16.1–58.1] s; $0.094 [0.093–0.109] | 5/5; 24.3 [18.5–30.2] s; $0.090 [0.087–0.108] | 0/5; 128.2 [51.7–203.8] s; $0.311 [0.172–0.485] | 0/3; 57.4 [31.5–73.8] s; $0.321 [0.292–0.325] | 5/5; 22.6 [21.5–26.3] s; $0.104 [0.102–0.114] |
| T4 shop checkout | 5/5; 32.9 [31.6–41.8] s; $0.153 [0.136–0.162] | 5/5; 38.4 [36.1–61.6] s; $0.173 [0.172–0.179] | 5/5; 63.3 [51.9–69.0] s; $0.327 [0.311–0.342] | 5/5; 46.1 [29.5–50.4] s; $0.156 [0.153–0.163] | 5/5; 40.5 [34.3–54.5] s; $0.143 [0.139–0.146] | 5/5; 36.0 [33.4–69.2] s; $0.162 [0.160–0.175] | 2/3; 60.1 [56.6–360.0] s; $0.167 [0.167–0.168]† (1 of 3 without cost) | 5/5; 70.7 [60.3–76.5] s; $0.253 [0.235–0.268] |
| T5 long thread | 5/5; 21.5 [18.7–160.9] s; $0.178 [0.127–0.187] | 5/5; 15.9 [13.9–35.6] s; $0.169 [0.165–0.169] | 5/5; 56.0 [40.7–57.0] s; $0.390 [0.172–0.401] | 5/5; 20.9 [17.1–27.5] s; $0.192 [0.183–0.213] | 5/5; 21.1 [18.2–23.8] s; $0.151 [0.129–0.201] | 5/5; 17.8 [15.2–29.0] s; $0.180 [0.166–0.198] | 3/3; 106.2 [83.7–236.1] s; $0.357 [0.294–0.554] | 5/5; 29.2 [24.5–36.2] s; $0.234 [0.220–0.249] |
| **Like-for-like mean over T1, T2, T3, T4, T5** | 25/25; mean 26.3 s; mean $0.127 | 25/25; mean 26.6 s; mean $0.131 | 25/25; mean 38.1 s; mean $0.208 | 25/25; mean 27.2 s; mean $0.175 | 25/25; mean 29.7 s; mean $0.133 | 20/25; mean 50.1 s; mean $0.179 | excluded: stopped by the T1 rule | 25/25; mean 37.7 s; mean $0.167 |

Excluded from the like-for-like row: browsermcp (stopped by the T1 rule after failing T1 twice).
† Some runs have no recorded cost: they were killed at the hard timeout before `claude` wrote its result line. A run's own cost then shows n/a. A median, mean or total marked † covers only the runs with a cost, and states how many were left out. A timed-out run usually costs more than the others, so the marked figure understates.
<!-- gen:r2-agent-cross:end -->

<!-- gen:r2-agent-detail:begin -->
Run 2026-10-26 + 2026-10-27, model `claude-opus-5-5`, 191 runs, total cost $31.99† + n/a for 3 run(s) without cost, hard timeout 6 min per run.
Start: `2026-10-26 (agent-infra, devtools, playwright, playwright-vision, puppeteer, x2-browser): 16:52  up 2 days, 17:46, 1 user, load averages: 4.16 4.73 4.74; 2026-10-27 (browsermcp, claude-in-chrome): 17:47  up 3 days, 18:40, 1 user, load averages: 4.76 3.39 3.00`. End: `2026-10-26 (agent-infra, devtools, playwright, playwright-vision, puppeteer, x2-browser): 19:46  up 2 days, 20:39, 1 user, load averages: 1.85 1.96 2.47; 2026-10-27 (browsermcp, claude-in-chrome): 18:41  up 3 days, 19:34, 1 user, load averages: 3.22 3.31 3.31`. Resumed 1x: 2026-10-26T17:43:13.332Z.

| Task | Tool | rep | ok | wall s | duration_ms | turns | tool calls | result chars | images | cost USD | oracle |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T1 | x2-browser | 1 | yes | 13.3 | 12046 | 4 | 3 | 2,659 | 0 | 0.084 | all 7 fields echoed |
| T1 | x2-browser | 2 | yes | 14.6 | 13211 | 4 | 3 | 2,659 | 0 | 0.088 | all 7 fields echoed |
| T1 | x2-browser | 3 | yes | 13.2 | 11549 | 4 | 3 | 2,852 | 0 | 0.087 | all 7 fields echoed |
| T1 | x2-browser | 4 | yes | 14.6 | 13320 | 4 | 3 | 2,659 | 0 | 0.088 | all 7 fields echoed |
| T1 | x2-browser | 5 | yes | 12.1 | 10783 | 4 | 3 | 2,659 | 0 | 0.085 | all 7 fields echoed |
| T1 | playwright | 1 | yes | 28.1 | 27003 | 7 | 6 | 5,162 | 0 | 0.117 | all 7 fields echoed |
| T1 | playwright | 2 | yes | 21.0 | 19811 | 6 | 5 | 4,688 | 0 | 0.108 | all 7 fields echoed |
| T1 | playwright | 3 | yes | 18.7 | 17515 | 6 | 5 | 4,688 | 0 | 0.106 | all 7 fields echoed |
| T1 | playwright | 4 | yes | 21.3 | 20143 | 6 | 5 | 4,688 | 0 | 0.106 | all 7 fields echoed |
| T1 | playwright | 5 | yes | 21.1 | 19978 | 6 | 5 | 4,688 | 0 | 0.111 | all 7 fields echoed |
| T1 | playwright-vision | 1 | yes | 33.4 | 32346 | 9 | 8 | 4,004 | 2 | 0.154 | all 7 fields echoed |
| T1 | playwright-vision | 2 | yes | 33.4 | 32278 | 10 | 9 | 4,462 | 3 | 0.176 | all 7 fields echoed |
| T1 | playwright-vision | 3 | yes | 34.9 | 33744 | 9 | 8 | 4,004 | 2 | 0.152 | all 7 fields echoed |
| T1 | playwright-vision | 4 | yes | 24.9 | 23790 | 7 | 6 | 2,783 | 3 | 0.148 | all 7 fields echoed |
| T1 | playwright-vision | 5 | yes | 39.5 | 38329 | 10 | 9 | 4,532 | 3 | 0.174 | all 7 fields echoed |
| T1 | devtools | 1 | yes | 22.0 | 20827 | 8 | 7 | 3,277 | 0 | 0.109 | all 7 fields echoed |
| T1 | devtools | 2 | yes | 23.0 | 21926 | 8 | 7 | 3,316 | 0 | 0.121 | all 7 fields echoed |
| T1 | devtools | 3 | yes | 21.3 | 20232 | 8 | 7 | 3,316 | 0 | 0.117 | all 7 fields echoed |
| T1 | devtools | 4 | yes | 19.3 | 18288 | 7 | 6 | 3,200 | 0 | 0.108 | all 7 fields echoed |
| T1 | devtools | 5 | yes | 19.2 | 18156 | 7 | 6 | 3,200 | 0 | 0.109 | all 7 fields echoed |
| T1 | agent-infra | 1 | yes | 32.6 | 31706 | 14 | 13 | 3,720 | 0 | 0.123 | all 7 fields echoed |
| T1 | agent-infra | 2 | yes | 26.3 | 25323 | 12 | 11 | 3,405 | 0 | 0.113 | all 7 fields echoed |
| T1 | agent-infra | 3 | yes | 26.6 | 25674 | 15 | 14 | 4,810 | 0 | 0.130 | all 7 fields echoed |
| T1 | agent-infra | 4 | yes | 23.2 | 22280 | 12 | 11 | 3,405 | 0 | 0.112 | all 7 fields echoed |
| T1 | agent-infra | 5 | yes | 33.3 | 32471 | 13 | 12 | 3,685 | 0 | 0.117 | all 7 fields echoed |
| T1 | puppeteer | 1 | yes | 30.9 | 29850 | 13 | 12 | 4,202 | 0 | 0.119 | all 7 fields echoed |
| T1 | puppeteer | 2 | yes | 27.4 | 26470 | 13 | 12 | 4,034 | 0 | 0.120 | all 7 fields echoed |
| T1 | puppeteer | 3 | yes | 24.9 | 23903 | 13 | 12 | 4,202 | 0 | 0.121 | all 7 fields echoed |
| T1 | puppeteer | 4 | yes | 35.1 | 34262 | 13 | 12 | 3,814 | 0 | 0.117 | all 7 fields echoed |
| T1 | puppeteer | 5 | yes | 26.4 | 25412 | 13 | 12 | 4,202 | 0 | 0.120 | all 7 fields echoed |
| T1 | browsermcp | 1 | NO | 360.0 | n/a | n/a | 20 | 5,741 | 4 | n/a† | TIMEOUT; no parseable ```json answer; answer_ok=false evidence_ok=false |
| T1 | browsermcp | 2 | yes | 59.9 | 58438 | 11 | 10 | 15,941 | 0 | 0.186 | all 7 fields echoed |
| T1 | browsermcp | 3 | yes | 61.4 | 60047 | 16 | 15 | 16,426 | 0 | 0.205 | all 7 fields echoed |
| T1 | browsermcp | 4 | NO | 360.0 | n/a | n/a | 21 | 8,102 | 0 | n/a† | TIMEOUT; no parseable ```json answer; answer_ok=false evidence_ok=false |
| T1 | claude-in-chrome | 1 | yes | 49.0 | 48091 | 8 | 7 | 3,981 | 1 | 0.134 | all 7 fields echoed |
| T1 | claude-in-chrome | 2 | yes | 35.3 | 34370 | 8 | 7 | 4,018 | 1 | 0.135 | all 7 fields echoed |
| T1 | claude-in-chrome | 3 | yes | 39.1 | 38095 | 6 | 5 | 3,654 | 0 | 0.123 | all 7 fields echoed |
| T1 | claude-in-chrome | 4 | yes | 27.0 | 26048 | 6 | 5 | 3,516 | 1 | 0.125 | all 7 fields echoed |
| T1 | claude-in-chrome | 5 | yes | 25.8 | 24828 | 6 | 5 | 3,554 | 1 | 0.125 | all 7 fields echoed |
| T2 | x2-browser | 1 | yes | 14.9 | 13590 | 4 | 3 | 12,938 | 0 | 0.119 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | x2-browser | 2 | yes | 14.7 | 13387 | 4 | 3 | 12,938 | 0 | 0.120 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | x2-browser | 3 | yes | 16.8 | 15797 | 4 | 3 | 12,938 | 0 | 0.119 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | x2-browser | 4 | yes | 12.4 | 11106 | 5 | 4 | 3,544 | 0 | 0.167 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | x2-browser | 5 | yes | 12.4 | 11002 | 4 | 3 | 12,533 | 0 | 0.119 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | playwright | 1 | yes | 19.1 | 17954 | 6 | 5 | 5,342 | 0 | 0.102 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | playwright | 2 | yes | 19.7 | 18636 | 6 | 5 | 5,354 | 0 | 0.106 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | playwright | 3 | yes | 36.1 | 34892 | 6 | 5 | 15,314 | 0 | 0.140 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | playwright | 4 | yes | 28.5 | 27271 | 6 | 5 | 4,991 | 0 | 0.103 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | playwright | 5 | yes | 17.4 | 16301 | 6 | 5 | 5,237 | 0 | 0.101 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | playwright-vision | 1 | yes | 22.6 | 21002 | 6 | 5 | 2,462 | 2 | 0.115 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | playwright-vision | 2 | yes | 13.1 | 11724 | 4 | 3 | 1,162 | 1 | 0.086 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | playwright-vision | 3 | yes | 14.8 | 13411 | 4 | 3 | 1,162 | 1 | 0.087 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | playwright-vision | 4 | yes | 14.8 | 13450 | 4 | 3 | 1,194 | 1 | 0.087 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | playwright-vision | 5 | yes | 19.7 | 18439 | 6 | 5 | 2,466 | 2 | 0.116 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | devtools | 1 | yes | 20.0 | 19007 | 7 | 6 | 50,774 | 0 | 0.293 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | devtools | 2 | yes | 28.3 | 27224 | 7 | 6 | 49,489 | 0 | 0.289 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | devtools | 3 | yes | 21.9 | 20646 | 8 | 7 | 48,193 | 0 | 0.297 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | devtools | 4 | yes | 17.8 | 16755 | 7 | 6 | 50,360 | 0 | 0.387 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | devtools | 5 | yes | 21.9 | 20615 | 7 | 6 | 48,066 | 0 | 0.285 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | agent-infra | 1 | yes | 17.0 | 16024 | 6 | 5 | 10,790 | 0 | 0.115 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | agent-infra | 2 | yes | 42.4 | 41447 | 10 | 9 | 16,422 | 0 | 0.168 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | agent-infra | 3 | yes | 42.3 | 41338 | 11 | 10 | 15,887 | 0 | 0.168 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | agent-infra | 4 | yes | 28.8 | 27535 | 9 | 8 | 22,302 | 0 | 0.215 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | agent-infra | 5 | yes | 31.6 | 29498 | 7 | 6 | 10,409 | 0 | 0.123 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | puppeteer | 1 | yes | 31.9 | 30974 | 10 | 9 | 2,801 | 0 | 0.116 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | puppeteer | 2 | yes | 25.8 | 24719 | 10 | 9 | 3,179 | 0 | 0.111 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | puppeteer | 3 | yes | 35.0 | 34071 | 9 | 8 | 3,258 | 0 | 0.115 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | puppeteer | 4 | yes | 29.2 | 28109 | 10 | 9 | 2,708 | 0 | 0.113 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | puppeteer | 5 | yes | 44.5 | 43374 | 11 | 10 | 2,900 | 0 | 0.122 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | browsermcp | 1 | yes | 192.7 | 191259 | 14 | 13 | 96,835 | 4 | 0.589 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | browsermcp | 2 | yes | 24.0 | 22182 | 6 | 5 | 48,183 | 1 | 0.267 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | browsermcp | 3 | yes | 20.4 | 18792 | 4 | 3 | 47,970 | 1 | 0.261 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | claude-in-chrome | 1 | yes | 26.6 | 25494 | 6 | 5 | 1,819 | 2 | 0.113 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | claude-in-chrome | 2 | yes | 24.6 | 23700 | 6 | 5 | 1,854 | 2 | 0.110 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | claude-in-chrome | 3 | yes | 30.5 | 29480 | 6 | 5 | 1,831 | 2 | 0.110 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | claude-in-chrome | 4 | yes | 35.1 | 34167 | 6 | 5 | 1,799 | 2 | 0.106 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | claude-in-chrome | 5 | yes | 35.5 | 34516 | 6 | 5 | 1,775 | 2 | 0.109 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T3 | x2-browser | 1 | yes | 17.4 | 16297 | 4 | 3 | 4,295 | 0 | 0.093 | three titles right; tab-opening calls=3; httpbin title="" |
| T3 | x2-browser | 2 | yes | 15.8 | 14563 | 4 | 3 | 5,014 | 0 | 0.100 | three titles right; tab-opening calls=3; httpbin title="" |
| T3 | x2-browser | 3 | yes | 16.6 | 15527 | 4 | 3 | 5,046 | 0 | 0.103 | three titles right; tab-opening calls=3; httpbin title="" |
| T3 | x2-browser | 4 | yes | 25.1 | 21136 | 4 | 3 | 4,631 | 0 | 0.099 | three titles right; tab-opening calls=3; httpbin title="" |
| T3 | x2-browser | 5 | yes | 26.4 | 23866 | 4 | 3 | 4,631 | 0 | 0.100 | three titles right; tab-opening calls=3; httpbin title="" |
| T3 | playwright | 1 | yes | 17.2 | 16083 | 5 | 4 | 1,941 | 0 | 0.089 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | playwright | 2 | yes | 17.7 | 16642 | 6 | 5 | 1,931 | 0 | 0.091 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | playwright | 3 | yes | 20.0 | 18913 | 5 | 4 | 1,975 | 0 | 0.089 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | playwright | 4 | yes | 21.7 | 20403 | 5 | 4 | 1,968 | 0 | 0.091 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | playwright | 5 | yes | 29.8 | 27586 | 6 | 5 | 1,992 | 0 | 0.094 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | playwright-vision | 1 | yes | 20.6 | 19482 | 6 | 5 | 2,081 | 1 | 0.102 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | playwright-vision | 2 | yes | 16.6 | 15443 | 6 | 5 | 2,081 | 1 | 0.103 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | playwright-vision | 3 | yes | 25.1 | 23958 | 9 | 8 | 5,586 | 0 | 0.120 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | playwright-vision | 4 | yes | 23.6 | 22462 | 7 | 6 | 2,249 | 1 | 0.111 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | playwright-vision | 5 | yes | 37.1 | 35076 | 9 | 8 | 5,966 | 1 | 0.134 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | devtools | 1 | yes | 25.7 | 24694 | 9 | 8 | 966 | 0 | 0.098 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | devtools | 2 | yes | 24.8 | 23745 | 8 | 7 | 800 | 0 | 0.094 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | devtools | 3 | yes | 16.1 | 15044 | 8 | 7 | 833 | 0 | 0.093 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | devtools | 4 | yes | 16.3 | 15097 | 8 | 7 | 848 | 0 | 0.093 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | devtools | 5 | yes | 58.1 | 56298 | 10 | 9 | 982 | 0 | 0.109 | three titles right; tab-opening calls=3; httpbin title="" |
| T3 | agent-infra | 1 | yes | 18.5 | 17331 | 7 | 6 | 1,895 | 0 | 0.089 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | agent-infra | 2 | yes | 23.5 | 22468 | 7 | 6 | 1,895 | 0 | 0.090 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | agent-infra | 3 | yes | 24.3 | 23371 | 7 | 6 | 1,895 | 0 | 0.090 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | agent-infra | 4 | yes | 27.3 | 26165 | 10 | 9 | 2,301 | 0 | 0.108 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | agent-infra | 5 | yes | 30.2 | 26366 | 7 | 6 | 1,895 | 0 | 0.087 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | puppeteer | 1 | NO | 149.3 | 148278 | 9 | 8 | 1,310 | 0 | 0.379 | three titles right; tab-opening calls=0; httpbin title=""; answer_ok=true evidence_ok=false |
| T3 | puppeteer | 2 | NO | 77.6 | 76597 | 14 | 13 | 1,599 | 1 | 0.225 | three titles right; tab-opening calls=0; httpbin title=""; answer_ok=true evidence_ok=false |
| T3 | puppeteer | 3 | NO | 51.7 | 50733 | 7 | 6 | 596 | 0 | 0.172 | three titles right; tab-opening calls=0; httpbin title=""; answer_ok=true evidence_ok=false |
| T3 | puppeteer | 4 | NO | 128.2 | 126065 | 17 | 16 | 2,362 | 0 | 0.311 | three titles right; tab-opening calls=0; httpbin title=""; answer_ok=true evidence_ok=false |
| T3 | puppeteer | 5 | NO | 203.8 | 201734 | 15 | 14 | 2,098 | 0 | 0.485 | three titles right; tab-opening calls=0; httpbin title=""; answer_ok=true evidence_ok=false |
| T3 | browsermcp | 1 | NO | 57.4 | 56031 | 8 | 7 | 51,608 | 1 | 0.321 | three titles right; tab-opening calls=0; httpbin title="httpbin.org/html"; answer_ok=true evidence_ok=false |
| T3 | browsermcp | 2 | NO | 73.8 | 72363 | 8 | 7 | 53,181 | 0 | 0.325 | three titles right; tab-opening calls=0; httpbin title="httpbin.org/html"; answer_ok=true evidence_ok=false |
| T3 | browsermcp | 3 | NO | 31.5 | 30010 | 6 | 5 | 50,776 | 1 | 0.292 | three titles right; tab-opening calls=0; httpbin title="httpbin.org/html"; answer_ok=true evidence_ok=false |
| T3 | claude-in-chrome | 1 | yes | 21.5 | 20487 | 6 | 5 | 2,514 | 0 | 0.102 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | claude-in-chrome | 2 | yes | 22.6 | 21675 | 5 | 4 | 1,919 | 0 | 0.104 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | claude-in-chrome | 3 | yes | 26.3 | 25274 | 6 | 5 | 2,258 | 0 | 0.114 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | claude-in-chrome | 4 | yes | 22.6 | 21184 | 6 | 5 | 2,521 | 0 | 0.107 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | claude-in-chrome | 5 | yes | 22.0 | 20928 | 5 | 4 | 2,277 | 0 | 0.104 | three titles right; tab-opening calls=2; httpbin title="" |
| T4 | x2-browser | 1 | yes | 41.8 | 40774 | 13 | 12 | 6,188 | 0 | 0.159 | order id matches the shop log; logged order right |
| T4 | x2-browser | 2 | yes | 32.9 | 31855 | 15 | 14 | 6,125 | 0 | 0.162 | order id matches the shop log; logged order right |
| T4 | x2-browser | 3 | yes | 31.6 | 30583 | 12 | 11 | 6,007 | 0 | 0.147 | order id matches the shop log; logged order right |
| T4 | x2-browser | 4 | yes | 32.5 | 31508 | 12 | 11 | 5,911 | 0 | 0.136 | order id matches the shop log; logged order right |
| T4 | x2-browser | 5 | yes | 34.1 | 33005 | 13 | 12 | 6,284 | 0 | 0.153 | order id matches the shop log; logged order right |
| T4 | playwright | 1 | yes | 61.6 | 60499 | 16 | 15 | 8,211 | 0 | 0.179 | order id matches the shop log; logged order right |
| T4 | playwright | 2 | yes | 37.9 | 36630 | 16 | 15 | 8,211 | 0 | 0.172 | order id matches the shop log; logged order right |
| T4 | playwright | 3 | yes | 36.1 | 34966 | 16 | 15 | 8,211 | 0 | 0.173 | order id matches the shop log; logged order right |
| T4 | playwright | 4 | yes | 54.7 | 53541 | 16 | 15 | 8,211 | 0 | 0.173 | order id matches the shop log; logged order right |
| T4 | playwright | 5 | yes | 38.4 | 36820 | 16 | 15 | 8,211 | 0 | 0.174 | order id matches the shop log; logged order right |
| T4 | playwright-vision | 1 | yes | 51.9 | 50797 | 21 | 20 | 8,696 | 10 | 0.311 | order id matches the shop log; logged order right |
| T4 | playwright-vision | 2 | yes | 60.8 | 59685 | 19 | 18 | 7,279 | 8 | 0.318 | order id matches the shop log; logged order right |
| T4 | playwright-vision | 3 | yes | 63.3 | 62211 | 22 | 21 | 8,216 | 9 | 0.333 | order id matches the shop log; logged order right |
| T4 | playwright-vision | 4 | yes | 69.0 | 67904 | 23 | 22 | 8,776 | 10 | 0.342 | order id matches the shop log; logged order right |
| T4 | playwright-vision | 5 | yes | 68.5 | 66444 | 23 | 22 | 8,765 | 10 | 0.327 | order id matches the shop log; logged order right |
| T4 | devtools | 1 | yes | 29.5 | 27432 | 12 | 11 | 6,302 | 0 | 0.153 | order id matches the shop log; logged order right |
| T4 | devtools | 2 | yes | 48.5 | 47234 | 12 | 11 | 6,329 | 0 | 0.156 | order id matches the shop log; logged order right |
| T4 | devtools | 3 | yes | 37.4 | 36304 | 12 | 11 | 6,388 | 0 | 0.163 | order id matches the shop log; logged order right |
| T4 | devtools | 4 | yes | 50.4 | 49450 | 12 | 11 | 6,329 | 0 | 0.155 | order id matches the shop log; logged order right |
| T4 | devtools | 5 | yes | 46.1 | 44989 | 12 | 11 | 6,329 | 0 | 0.156 | order id matches the shop log; logged order right |
| T4 | agent-infra | 1 | yes | 38.7 | 37770 | 19 | 18 | 3,111 | 0 | 0.143 | order id matches the shop log; logged order right |
| T4 | agent-infra | 2 | yes | 34.3 | 33398 | 21 | 20 | 3,365 | 0 | 0.139 | order id matches the shop log; logged order right |
| T4 | agent-infra | 3 | yes | 40.5 | 39603 | 19 | 18 | 2,999 | 0 | 0.145 | order id matches the shop log; logged order right |
| T4 | agent-infra | 4 | yes | 41.2 | 40247 | 19 | 18 | 2,999 | 0 | 0.143 | order id matches the shop log; logged order right |
| T4 | agent-infra | 5 | yes | 54.5 | 53503 | 19 | 18 | 2,999 | 0 | 0.146 | order id matches the shop log; logged order right |
| T4 | puppeteer | 1 | yes | 34.8 | 33972 | 20 | 19 | 5,812 | 0 | 0.160 | order id matches the shop log; logged order right |
| T4 | puppeteer | 2 | yes | 69.2 | 68321 | 22 | 21 | 6,355 | 0 | 0.175 | order id matches the shop log; logged order right |
| T4 | puppeteer | 3 | yes | 33.4 | 32529 | 20 | 19 | 7,558 | 0 | 0.162 | order id matches the shop log; logged order right |
| T4 | puppeteer | 4 | yes | 59.4 | 58527 | 21 | 20 | 6,266 | 0 | 0.171 | order id matches the shop log; logged order right |
| T4 | puppeteer | 5 | yes | 36.0 | 35035 | 19 | 18 | 5,737 | 0 | 0.161 | order id matches the shop log; logged order right |
| T4 | browsermcp | 1 | NO | 360.0 | n/a | n/a | 35 | 15,498 | 5 | n/a† | TIMEOUT; no parseable ```json answer; answer_ok=false evidence_ok=false |
| T4 | browsermcp | 2 | yes | 60.1 | 58635 | 13 | 12 | 10,142 | 0 | 0.168 | order id matches the shop log; logged order right |
| T4 | browsermcp | 3 | yes | 56.6 | 55168 | 13 | 12 | 10,142 | 0 | 0.167 | order id matches the shop log; logged order right |
| T4 | claude-in-chrome | 1 | yes | 60.3 | 59223 | 14 | 13 | 7,044 | 2 | 0.235 | order id matches the shop log; logged order right |
| T4 | claude-in-chrome | 2 | yes | 70.9 | 69862 | 19 | 18 | 8,222 | 1 | 0.268 | order id matches the shop log; logged order right |
| T4 | claude-in-chrome | 3 | yes | 76.5 | 75540 | 17 | 16 | 7,975 | 1 | 0.253 | order id matches the shop log; logged order right |
| T4 | claude-in-chrome | 4 | yes | 70.7 | 69733 | 14 | 13 | 7,419 | 2 | 0.238 | order id matches the shop log; logged order right |
| T4 | claude-in-chrome | 5 | yes | 70.7 | 69387 | 17 | 16 | 8,088 | 1 | 0.268 | order id matches the shop log; logged order right |
| T5 | x2-browser | 1 | yes | 18.7 | 17566 | 4 | 3 | 11,722 | 0 | 0.127 | three answers right; all three commenters seen in tool text |
| T5 | x2-browser | 2 | yes | 23.6 | 22408 | 5 | 4 | 26,653 | 0 | 0.181 | three answers right; all three commenters seen in tool text |
| T5 | x2-browser | 3 | yes | 20.4 | 19337 | 4 | 3 | 26,241 | 0 | 0.168 | three answers right; all three commenters seen in tool text |
| T5 | x2-browser | 4 | yes | 21.5 | 20350 | 5 | 4 | 26,036 | 0 | 0.178 | three answers right; all three commenters seen in tool text |
| T5 | x2-browser | 5 | yes | 160.9 | 157083 | 6 | 5 | 24,724 | 0 | 0.187 | three answers right; all three commenters seen in tool text |
| T5 | playwright | 1 | yes | 17.2 | 16137 | 3 | 2 | 32,849 | 0 | 0.169 | three answers right; all three commenters seen in tool text |
| T5 | playwright | 2 | yes | 13.9 | 12527 | 3 | 2 | 32,423 | 0 | 0.165 | three answers right; all three commenters seen in tool text |
| T5 | playwright | 3 | yes | 15.2 | 13780 | 3 | 2 | 32,735 | 0 | 0.169 | three answers right; all three commenters seen in tool text |
| T5 | playwright | 4 | yes | 15.9 | 14557 | 3 | 2 | 32,511 | 0 | 0.168 | three answers right; all three commenters seen in tool text |
| T5 | playwright | 5 | yes | 35.6 | 31495 | 3 | 2 | 32,731 | 0 | 0.169 | three answers right; all three commenters seen in tool text |
| T5 | playwright-vision | 1 | yes | 56.1 | 54942 | 23 | 22 | 7,321 | 11 | 0.401 | three answers right; thread reached, 0/3 commenters in text, rest only in screenshots (not text-verifiable) |
| T5 | playwright-vision | 2 | yes | 40.7 | 39560 | 9 | 8 | 4,204 | 6 | 0.172 | three answers right; thread reached, 0/3 commenters in text, rest only in screenshots (not text-verifiable) |
| T5 | playwright-vision | 3 | yes | 56.0 | 54922 | 21 | 20 | 8,087 | 12 | 0.390 | three answers right; all three commenters seen in tool text |
| T5 | playwright-vision | 4 | yes | 55.2 | 54108 | 19 | 18 | 6,050 | 9 | 0.357 | three answers right; thread reached, 0/3 commenters in text, rest only in screenshots (not text-verifiable) |
| T5 | playwright-vision | 5 | yes | 57.0 | 54751 | 19 | 18 | 5,936 | 7 | 0.391 | three answers right; all three commenters seen in tool text |
| T5 | devtools | 1 | yes | 20.0 | 18725 | 5 | 4 | 37,432 | 0 | 0.210 | three answers right; all three commenters seen in tool text |
| T5 | devtools | 2 | yes | 17.1 | 15993 | 4 | 3 | 36,117 | 0 | 0.190 | three answers right; all three commenters seen in tool text |
| T5 | devtools | 3 | yes | 27.5 | 26560 | 5 | 4 | 37,725 | 0 | 0.213 | three answers right; all three commenters seen in tool text |
| T5 | devtools | 4 | yes | 20.9 | 19818 | 5 | 4 | 28,076 | 0 | 0.183 | three answers right; all three commenters seen in tool text |
| T5 | devtools | 5 | yes | 26.9 | 25558 | 4 | 3 | 36,350 | 0 | 0.192 | three answers right; all three commenters seen in tool text |
| T5 | agent-infra | 1 | yes | 21.1 | 20216 | 4 | 3 | 16,192 | 0 | 0.151 | three answers right; all three commenters seen in tool text |
| T5 | agent-infra | 2 | yes | 23.3 | 22258 | 4 | 3 | 8,986 | 0 | 0.129 | three answers right; all three commenters seen in tool text |
| T5 | agent-infra | 3 | yes | 23.8 | 22776 | 4 | 3 | 37,037 | 0 | 0.201 | three answers right; all three commenters seen in tool text |
| T5 | agent-infra | 4 | yes | 20.2 | 19209 | 4 | 3 | 20,360 | 0 | 0.158 | three answers right; all three commenters seen in tool text |
| T5 | agent-infra | 5 | yes | 18.2 | 17187 | 3 | 2 | 14,581 | 0 | 0.134 | three answers right; all three commenters seen in tool text |
| T5 | puppeteer | 1 | yes | 29.0 | 28011 | 3 | 2 | 32,373 | 0 | 0.169 | three answers right; all three commenters seen in tool text |
| T5 | puppeteer | 2 | yes | 17.8 | 16905 | 4 | 3 | 33,070 | 0 | 0.180 | three answers right; all three commenters seen in tool text |
| T5 | puppeteer | 3 | yes | 15.2 | 14004 | 3 | 2 | 38,534 | 0 | 0.198 | three answers right; all three commenters seen in tool text |
| T5 | puppeteer | 4 | yes | 16.6 | 15684 | 3 | 2 | 38,169 | 0 | 0.197 | three answers right; all three commenters seen in tool text |
| T5 | puppeteer | 5 | yes | 20.1 | 19257 | 3 | 2 | 30,129 | 0 | 0.166 | three answers right; all three commenters seen in tool text |
| T5 | browsermcp | 1 | yes | 236.1 | 234699 | 39 | 38 | 11,201 | 18 | 0.554 | three answers right; thread reached, 0/3 commenters in text, rest only in screenshots (not text-verifiable) |
| T5 | browsermcp | 2 | yes | 106.2 | 104397 | 24 | 23 | 3,890 | 11 | 0.357 | three answers right; thread reached, 0/3 commenters in text, rest only in screenshots (not text-verifiable) |
| T5 | browsermcp | 3 | yes | 83.7 | 82321 | 25 | 24 | 3,994 | 12 | 0.294 | three answers right; thread reached, 0/3 commenters in text, rest only in screenshots (not text-verifiable) |
| T5 | claude-in-chrome | 1 | yes | 24.5 | 23538 | 6 | 5 | 39,053 | 0 | 0.220 | three answers right; all three commenters seen in tool text |
| T5 | claude-in-chrome | 2 | yes | 27.1 | 26121 | 7 | 6 | 39,140 | 0 | 0.234 | three answers right; all three commenters seen in tool text |
| T5 | claude-in-chrome | 3 | yes | 29.2 | 28115 | 7 | 6 | 39,257 | 0 | 0.231 | three answers right; all three commenters seen in tool text |
| T5 | claude-in-chrome | 4 | yes | 33.9 | 32952 | 7 | 6 | 39,312 | 0 | 0.248 | three answers right; all three commenters seen in tool text |
| T5 | claude-in-chrome | 5 | yes | 36.2 | 35319 | 8 | 7 | 39,349 | 0 | 0.249 | three answers right; all three commenters seen in tool text |

† Some runs have no recorded cost: they were killed at the hard timeout before `claude` wrote its result line. A run's own cost then shows n/a. A median, mean or total marked † covers only the runs with a cost, and states how many were left out. A timed-out run usually costs more than the others, so the marked figure understates.

Skipped or stopped:
- browsermcp: T1 failed twice; remaining agent runs stopped per the budget rule

Invalid (page changed or precheck failed; no agent started, not counted as failures):
- none
<!-- gen:r2-agent-detail:end -->

## How to run

```bash
npm run build                         # our server: dist/
(cd bench && npm ci)                  # the pinned third-party servers
npm run bench                         # B1 → bench/results/<date>-micro.json (about 10 min)
node bench/agent/run.mjs              # B2 → bench/results/<date>-agent.json + agent/<date>/*.jsonl (costs money)
node bench/report.mjs bench/results/<date>-micro.json bench/results/<date>-agent.json
```

`npm run bench -- --smoke` runs every step once. `--only x2-browser,playwright` limits the contenders.
BrowserMCP runs only when named: `node bench/agent/run.mjs --only browsermcp`. Before that, stop any
other BrowserMCP server (its startup kills the one listening on port 9009) and connect a tab in the
extension.
`--warmup` gives each B2 contender one untimed run before its measured runs, so that no measured run pays a
cold prompt cache.
`node bench/list-tools.mjs <id> --schemas` prints a contender's tools.

Round-2 flags (`bench/agent/run.mjs`):
- `--tasks T1,T2,T3,T4,T5` picks the tasks; the default is still `T1,T2,T3`.
- `--balanced [--seed N]` orders every (rep, task) block by a seeded Williams Latin square (see Method → B2).
  The seed (random unless given), the planned order and the order the runs actually ran in are recorded
  in the result's `plan` (`seed`, `planned_orders`, `orders`).
- `--resume bench/results/<file>.json` continues a stopped run: it replays the plan recorded in that file
  (model, tasks, reps, `--only`, `--balanced` and its seed, `--warmup`, timeout, budget; command-line values are ignored),
  skips every task|tool|rep already recorded, and warms up again first, because the prompt cache has expired.
  It writes back to the path it was given. It re-runs two kinds of record (moved to `retried` in the file):
  runs cut short by Ctrl-C or SIGTERM (`interrupted`), and T5 runs voided because the precheck could not
  reach the page (`invalid_kind: unavailable`). A "page changed" void stays.
  Without `--resume`, the `--tag` overwrite refusal is unchanged. Files from before 2026-10-26 have no plan
  and cannot be resumed.
- **Ctrl-C / SIGTERM** kills the running `claude`, its MCP server and its browser, records that run as
  `interrupted`, saves, and exits (130 / 143). Resume from there.
- **Timeouts** (6 min, process group killed) count as failures. Their cost is unknown unless the saved
  stream holds a result line; the report then shows "n/a" with a footnote, never $0.
- `--budget-usd N` sets the per-run `--max-budget-usd` (default 3; used at 1 for probes).
- `--shop-port N` is the T4 shop's port (default 47823, fixed so that a one-time Claude in Chrome permission
  holds; 0 picks any free port). `node bench/agent/shop-server.mjs [port]` runs the shop by hand.
- `node bench/report.mjs --prefix r2 --csv bench/results/<file>.csv bench/results/<file>.json` writes the
  round-2 tables into the `gen:r2-agent-*` blocks and a per-run CSV (tool, task, rep, ok, wall_s, cost_usd,
  calls, result_chars, timed_out, invalid). Without `--prefix` it writes round 1's blocks, unchanged.
  - **ok** is false for a timed-out run in every table and in the CSV.
  - **Unknown cost.** A run's cost comes from its record, else from the result line of its saved stream.
    With neither, it shows `n/a†`. Aggregates and the run total cover only the runs with a cost and carry
    `†`, the number left out and a footnote. An unknown cost is never shown as $0, and the summary and
    cross tables use the same figures.
  - **Run total.** The header total is computed from the same per-run costs as the tables, recovered
    costs included. It is never read from the file's own `total_cost_usd`, which a file saved mid-run
    does not have yet.
  - **Headline row.** The cross table's last row is like-for-like: per tool, the mean of its per-task
    means. Each task weighs the same. It covers only the tasks that every compared tool has valid runs for.
    The row names that task set, and a note lists the tasks left out and the tools that caused it. Quote
    it with its task set.
    - A tool stopped by the T1 rule is not compared. It shows "excluded" and is named in a note, so it
      cannot shrink everyone's set to T1.
    - A timed-out run counts at the full timeout (6 min), marked ‡.
    - A recovered cost counts at that cost. If any cost in a tool's set is still unknown, its headline
      cost reads "n/a (k runs unknown)". A mean of the remaining runs would leave out the likely most
      expensive ones.
- `cd bench && npm test` runs the harness tests (oracles, T5 precheck, ordering, resume with a fake
  `claude`, report). No network and no real agent.

## Method

### B1 micro

- **Client.** The MCP SDK client (`@modelcontextprotocol/sdk` 1.32.1) runs in one Node process, and the
  timing is client-side wall time (`performance.now()` around `callTool`). A step's time is the sum of its
  calls. Contenders run one after another, so only one browser is up at a time.
- **Launch.** Third-party servers are pinned in `bench/package.json` and started with `node <bin>`, the
  same way as ours, not through `npx`, so cold start does not include npm's package resolution. Every
  contender gets the same 1280x800 viewport and runs headless on the installed Google Chrome (the binary
  is captured from the process tree, see the environment table).
- **Fixtures.** `test/support/fixture-server.ts` serves the local pages `forms.html`, `big-1000.html`,
  `click.html` and `type.html`.
- **Oracle.** It never trusts the tool's own words. After each timed step, one out-of-band `evaluate`
  call (every contender has one) reads the page state. The value is wrapped in a URL-encoded marker, so
  every tool's text format parses the same way. For (f), the oracle is the fixture server's record of
  `POST /submit?form=full`. Oracle calls are not timed, counted or measured. A run that fails the
  oracle, or returns a tool error, does not count, and p50/p95 cover passing runs only.
- **Output size** is the text-content length in characters (the token proxy, with any `structuredContent`
  counted too), plus the decoded image bytes, reported separately.

| Step | Oracle | Each tool's own best way (calls) |
|---|---|---|
| (a) cold | `document.title` is "Full form" | spawn → initialize → one navigate: x2 `navigate`, Playwright `browser_navigate`, DevTools `navigate_page` (pageId 1), agent-infra `browser_navigate` |
| (b) navigate + snapshot | the output contains "Full name", "Email", "Country" and "Send form", and the title is right | x2 `navigate{snapshot:true}` (1); Playwright `browser_navigate` + `browser_snapshot` (2: 0.0.83 writes the navigate snapshot to a file and returns only a link); DevTools `navigate_page` + `take_snapshot` (2); agent-infra `browser_navigate` (1, it returns its indexed element list) |
| (c) big-1000 | all 1000 "Item N" labels appear in the output | x2 `snapshot` plus continuation pages (`offset=`), because one result is capped at 20,000 chars; Playwright `browser_snapshot`; DevTools `take_snapshot`; agent-infra `browser_get_clickable_elements` (it has no a11y tree tool) |
| (d) click | `window.__counts.plain` goes up by exactly 1 | click by ref or index from one untimed snapshot taken before the 20 runs |
| (e) type | `#replace.value` equals the typed string | x2 `type`, Playwright `browser_type`, DevTools `fill`, agent-infra `browser_form_input_fill{clear:true}` |
| (f) fill 8 + submit | exactly one submission whose 8 fields equal the expected values (text ×4, select, checkbox, radio, date) | x2 `fill_form{submit}` (1); Playwright `browser_fill_form` + `browser_click` (2); DevTools `fill_form` + `click` (2); agent-infra 5× `browser_form_input_fill` + `browser_select` + 2× `browser_click` + the submit `browser_click` (9). Untimed preparation, the same for every tool: open the form, take one snapshot for refs |
| (g) screenshot | an inline image whose PNG/JPEG header decodes to a non-zero size | each tool's default screenshot call with no arguments (format and quality are each tool's default) |

### B2 agent

- **Command.** For each run: `claude -p <task> --model claude-opus-5-5 --output-format stream-json --verbose
  --settings '{"disableAllHooks":true}' --strict-mcp-config --mcp-config <one server> --allowedTools
  mcp__<name> --tools "" --disallowedTools WebFetch,WebSearch,Bash --max-budget-usd 3`. `--tools ""`
  removes the built-in tools, so the browser server is the only way to the web. Claude in Chrome uses
  `--chrome` with no MCP config.
- **Process.** Each run has a fresh working directory and a hard 6-minute timeout, after which the
  process group is killed. The runs are interleaved: rep 1 runs T1 for every tool, then T2, then T3, and
  rep 2 repeats that order.
- **Oracle, two parts.**
  1. The final ```json answer must hold the right values.
  2. The stream must show that a browser tool actually produced them. For T1, a tool result contains the
     echoed `custemail`. For T2, a tool call or result touches the Model Context Protocol article and a
     result mentions Anthropic. For T3, at least two tab-opening calls are made.

  The model knows "Anthropic, 2024" and "Example Domain" from memory, so an answer alone proves nothing.
- **T3 and httpbin.** httpbin.org/html has no `<title>` element, so its `document.title` is empty. The
  T3 oracle accepts an empty title, a "no title" wording or the URL for that tab.
- **T4 shop checkout (round 2, redesigned 2026-10-26).** A local shop, `agent/shop-server.mjs`, served
  by the bench process on `127.0.0.1` (loopback only), as B1 serves its fixtures. It is plain
  server-rendered HTML with forms and links and no scripts. The flow mirrors a demo store: login, with
  demo credentials printed on the login page; six products; cart; a checkout form (first name, last name,
  postal code); an overview with item total, 8% tax and total; then Finish.
  - **The task.** Buy the Canvas Field Jacket alone as Ann Bench, 10115, and report the order number.
    The expected order is $49.99 + $4.00 tax = $53.99.
  - **Password.** `qT7-vRw2-Lx9k`, random-looking and not a known demo password, so Chrome's data-breach
    warning has nothing to match.
  - **Per-run state.** Every T4 run gets its own random run path, `/r/<16 base32 chars>/`, with its own
    sessions and order log. The session cookie is scoped to that path. Runs cannot see each other's
    orders, even in one shared Chrome profile, and a resumed run gets a fresh shop.
  - **Finish records the order.** Only a POST to Finish, from a logged-in session with a non-empty cart
    and checkout details, records an order. It gets an unguessable 8-character base32 id (40 random bits).
    The order is logged with the run id, items, name, postcode, item total, tax and total. The
    confirmation page shows the id to that session only. A direct visit to it, with or without a session,
    shows no id and records nothing. The run's log is stored in the result as `shop_orders`, so
    `--rescore` needs no server.
  - **Oracle.** It does no tool-output parsing at all. The run's log must hold exactly one order:
    none fails as "no order recorded", more than one as "multiple orders". The answer's `order_id`
    (case and surrounding spaces ignored) must be that order's id, and the order must hold exactly
    `["Canvas Field Jacket"]`, Ann, Bench, 10115 and $53.99.
    - Every bypass the reviewer found fails: an errored Finish click, a screenshot named "before-finish",
      an evaluate that only mentions Finish, a timed-out wait, a direct or `pushState` visit to the
      confirmation page, a hard-coded heading, wrong click coordinates, and a `browser_batch` shortcut.
      So do an invented id, an id copied from another run, and a wrong item, name, postcode or extra item.
    - The genuine agent-infra (index clicks), Claude in Chrome (coordinate and ref clicks), DevTools and
      Puppeteer shapes pass with no per-tool code (`agent/shop.test.mjs`).
  - **Retired.** The first T4 used saucedemo.com with a tool-output evidence rule. It failed genuine
    agent-infra and Claude in Chrome runs and let a `browser_batch` shortcut through, because finishing on
    saucedemo leaves no trace outside the browser. Its probe files (`results/2026-10-26-agent-probe-t4*`)
    belong to that version.
- **T5 long thread (round 2).** Hacker News item 1626305, "Why GNU grep is Fast" (2010, 115 comments,
  one page, about 174 KB of HTML, locked). Three questions, each answered by a top-level comment near
  the bottom of the page. The answers sit in the last 7% of the HTML.
  - The questions: who recommends which blog post (Qerub, "The Treacherous Optimization"); which
    podcast covered Boyer-Moore and who said so (frou_dh, Security Now); who says Plan 9 grep is
    competitive and who replied (konad, kragen).
  - The prompt names none of the answers. All six were checked on the live page on 2026-10-26, and the
    capture is the test fixture `agent/fixtures/hn-1626305-2026-10-26.html.gz`.
  - Evidence: all three usernames came back in tool text (case-insensitive, as are the answers; no two
    usernames on the page differ only by case). A pixel-only tool passes on images taken on the
    thread, labelled as not text-verifiable.
  - **Precheck.** Before every T5 run, one plain `fetch` of the page checks four things: the title, the
    `115 comments` header, every answer string, and that the three content strings still sit past 60% of
    the page. If any check fails, the run is recorded as `invalid` with the reason. No agent starts and it
    costs nothing. Invalid runs are not failures: the report excludes them from every number and lists
    them apart. `invalid_kind` says which: `page-changed` is final; `unavailable` (network or HTTP error,
    after one retry) is re-run by `--resume`.
- **Fair ordering (round 2).** With `--balanced`, the blocks follow a Williams Latin square. It has R
  rows, where R = n for an even number of tools n and R = 2n for odd n. Over the R rows, every tool takes
  every position equally often (once for even n, twice for odd n), and the same holds for every ordered
  pair of neighbours. The seed shuffles the rows and the tool labels, and block b uses row b mod R.
  Neighbours change from block to block, so drift within a block (load, site latency) and carry-over from
  the previous tool do not keep landing on the same tool. The plain rotation this replaces kept every
  tool's neighbours fixed.
  - **How balanced the planned run is.** 8 tools × 5 reps × 5 tasks = 25 blocks, which is 3 full
    squares plus one extra row. Measured over 200 seeds, every tool is first 3–4 times and last 3–4
    times, takes each position 3–4 times, and each ordered pair of neighbours occurs 3–4 times. It is
    close to balanced, not exactly: the one extra row gives 8 tools a fourth turn at its positions.
  - **What is recorded.** `plan.seed`; `plan.planned_orders`, the schedule; and `plan.orders`, the order
    the recorded runs actually ran in. They differ after a resume that re-runs an interrupted or voided
    run.

<!-- gen:agent-detail:begin -->
Run 2026-10-23T04:35:33.058Z, model `claude-opus-5-5`, 36 runs, total cost $6.28, hard timeout 6 min per run.
Start: `7:35  up 48 days, 23:48, 1 user, load averages: 3.88 4.87 6.38`. End: `7:47  up 49 days, 0 sec, 1 user, load averages: 9.41 7.40 6.40`.

| Task | Tool | rep | ok | wall s | duration_ms | turns | tool calls | result chars | images | cost USD | oracle |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T1 | x2-browser | 1 | yes | 16.3 | 15191 | 4 | 3 | 2,659 | 0 | 0.162 | all 7 fields echoed |
| T1 | x2-browser | 2 | yes | 12.0 | 10722 | 4 | 3 | 2,659 | 0 | 0.084 | all 7 fields echoed |
| T1 | playwright | 1 | yes | 20.8 | 19774 | 6 | 5 | 4,688 | 0 | 0.106 | all 7 fields echoed |
| T1 | playwright | 2 | yes | 20.7 | 19733 | 7 | 6 | 6,092 | 0 | 0.120 | all 7 fields echoed |
| T1 | devtools | 1 | yes | 17.5 | 16495 | 8 | 7 | 3,358 | 0 | 0.205 | all 7 fields echoed |
| T1 | devtools | 2 | yes | 24.4 | 23319 | 8 | 7 | 3,316 | 0 | 0.115 | all 7 fields echoed |
| T1 | agent-infra | 1 | yes | 24.0 | 23083 | 12 | 11 | 3,405 | 0 | 0.143 | all 7 fields echoed |
| T1 | agent-infra | 2 | yes | 25.1 | 24229 | 12 | 11 | 3,405 | 0 | 0.111 | all 7 fields echoed |
| T1 | browsermcp | 1 | yes | 54.5 | 52642 | 17 | 16 | 16,598 | 0 | 0.234 | all 7 fields echoed |
| T1 | browsermcp | 2 | yes | 67.7 | 66137 | 17 | 16 | 16,571 | 0 | 0.211 | all 7 fields echoed |
| T1 | claude-in-chrome | 1 | yes | 22.1 | 21218 | 6 | 5 | 3,517 | 1 | 0.136 | all 7 fields echoed |
| T1 | claude-in-chrome | 2 | yes | 27.5 | 26566 | 6 | 5 | 3,553 | 1 | 0.137 | all 7 fields echoed |
| T2 | x2-browser | 1 | yes | 21.4 | 20365 | 4 | 3 | 42,703 | 0 | 0.243 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | x2-browser | 2 | yes | 13.3 | 11976 | 5 | 4 | 23,029 | 0 | 0.164 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | playwright | 1 | yes | 21.0 | 19795 | 6 | 5 | 5,197 | 0 | 0.103 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | playwright | 2 | yes | 23.9 | 22956 | 6 | 5 | 4,816 | 0 | 0.103 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | devtools | 1 | yes | 26.1 | 24822 | 8 | 7 | 50,120 | 0 | 0.309 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | devtools | 2 | yes | 19.6 | 18576 | 7 | 6 | 48,887 | 0 | 0.287 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | agent-infra | 1 | yes | 32.2 | 31282 | 8 | 7 | 10,187 | 0 | 0.130 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | agent-infra | 2 | yes | 27.9 | 26803 | 8 | 7 | 10,370 | 0 | 0.130 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | browsermcp | 1 | yes | 16.5 | 15153 | 4 | 3 | 51,214 | 1 | 0.272 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | browsermcp | 2 | yes | 15.5 | 13630 | 4 | 3 | 51,214 | 1 | 0.269 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T2 | claude-in-chrome | 1 | yes | 36.5 | 35646 | 6 | 5 | 15,225 | 1 | 0.163 | introduced_by="Anthropic" year="2024"; fact seen in tool text |
| T2 | claude-in-chrome | 2 | yes | 27.4 | 26450 | 7 | 6 | 2,111 | 2 | 0.139 | introduced_by="Anthropic" year="2024"; fact only in a screenshot (not text-verifiable) |
| T3 | x2-browser | 1 | yes | 16.8 | 15687 | 5 | 4 | 20,626 | 0 | 0.173 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | x2-browser | 2 | yes | 16.0 | 14766 | 4 | 3 | 20,636 | 0 | 0.166 | three titles right; tab-opening calls=3; httpbin title="" |
| T3 | playwright | 1 | yes | 15.0 | 13798 | 5 | 4 | 2,074 | 0 | 0.090 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | playwright | 2 | yes | 12.9 | 11765 | 5 | 4 | 1,983 | 0 | 0.084 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | devtools | 1 | yes | 18.5 | 17450 | 9 | 8 | 966 | 0 | 0.097 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | devtools | 2 | yes | 17.8 | 16759 | 8 | 7 | 848 | 0 | 0.093 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | agent-infra | 1 | yes | 20.2 | 19244 | 7 | 6 | 1,895 | 0 | 0.089 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | agent-infra | 2 | yes | 21.7 | 20693 | 7 | 6 | 1,895 | 0 | 0.090 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | browsermcp | 1 | NO | 78.8 | 77453 | 8 | 7 | 56,425 | 0 | 0.356 | three titles right; tab-opening calls=0; httpbin title="httpbin.org/html"; answer_ok=true evidence_ok=false |
| T3 | browsermcp | 2 | NO | 211.0 | 209459 | 15 | 14 | 59,680 | 1 | 0.707 | three titles right; tab-opening calls=0; httpbin title=""; answer_ok=true evidence_ok=false |
| T3 | claude-in-chrome | 1 | yes | 24.5 | 23445 | 6 | 5 | 2,524 | 0 | 0.116 | three titles right; tab-opening calls=2; httpbin title="" |
| T3 | claude-in-chrome | 2 | yes | 25.4 | 24464 | 7 | 6 | 2,920 | 0 | 0.139 | three titles right; tab-opening calls=2; httpbin title="" |

Skipped or stopped:
- none
<!-- gen:agent-detail:end -->

## Environment and fairness (B3)

- **Machine.** Apple M2 Pro (12 cores) with 16 GB RAM, running macOS 26.1 (Darwin 25.1.0). The
  machine was busy and swapping: the load average was 12.8 at the start, and 24.8 GiB of 26.0 GiB swap
  was in use. Other desktop apps were running. The numbers are
  comparable with each other, but not with an idle machine. Cold start is the most sensitive to this.
- **Browser.** Every headless contender launched the same installed binary,
  `/Applications/Google Chrome.app` (Chrome 155.0.8059.85).
- **Order.** In B1, contenders ran one after another (x2, Playwright, DevTools, agent-infra), not
  interleaved. The load averages before and after each one are in the table below. In B2, runs were
  interleaved.
- **Versions.** x2-browser-mcp 0.1.0 at 4aaec31; `@playwright/mcp` 0.0.83 (server reports Playwright
  1.64.0-alpha); `chrome-devtools-mcp` 1.12.0; `@agent-infra/mcp-server-browser` 1.2.29; MCP SDK client
  1.32.1; Node 24.21.0; Claude Code 2.1.296; model `claude-opus-5-5`. The Claude in Chrome extension version is unknown: it does not appear in the streams and was not read from Chrome.

<!-- gen:micro-env:begin -->
Run 2026-10-23T04:28:01.691Z, 20 warm runs per step, 10 cold starts. Apple M2 Pro, 12 cores, 16 GB RAM, Node v24.21.0.
Start: `7:28  up 48 days, 23:40, 1 user, load averages: 6.14 8.17 7.94`; swap `total = 24576.00M  used = 23123.62M  free = 1452.38M  (encrypted)`.
End: `7:34  up 48 days, 23:47, 1 user, load averages: 2.85 4.89 6.46`; swap `total = 24576.00M  used = 23035.62M  free = 1540.38M  (encrypted)`.

| Tool | Version | Mode | Browser binary | Load before | Load after |
|---|---|---|---|---|---|
| x2-browser | 0.1.0 (this repo, dist/) | headless, isolated temp profile | /Applications/Google Chrome.app/Contents/MacOS/Google Chrome | 6.14 8.17 7.94 | 6.05 7.91 7.86 |
| playwright | @playwright/mcp@0.0.83 | headless, isolated in-memory profile | /Applications/Google Chrome.app/Contents/MacOS/Google Chrome | 6.05 7.91 7.86 | 4.77 7.03 7.52 |
| devtools | chrome-devtools-mcp@1.12.0 | headless, isolated temp profile | /Applications/Google Chrome.app/Contents/MacOS/Google Chrome | 4.77 7.03 7.52 | 5.60 6.90 7.44 |
| agent-infra | @agent-infra/mcp-server-browser@1.2.29 | headless (no isolated flag; see caveats) | /Applications/Google Chrome.app/Contents/MacOS/Google Chrome | 5.60 6.90 7.44 | 2.85 4.89 6.46 |
| browsermcp | @browsermcp/mcp@0.1.3 | HEADED: the user's real Chrome via the BrowserMCP extension | not run |  |  |
<!-- gen:micro-env:end -->

### Headless or headed

| Tool | B1 | B2 |
|---|---|---|
| x2-browser | headless, `--isolated` temp profile | same |
| Playwright MCP | headless, `--isolated` in-memory profile, `--browser chrome` | same |
| Chrome DevTools MCP | headless, `--isolated` temp profile | same |
| agent-infra | headless, `--browser chrome`, fresh `--user-data-dir` per spawn (it has no isolated flag), deleted afterwards | same |
| BrowserMCP | not run (no micro adapter) | **headed**: the operator's real, visible Chrome and profile, one tab connected through the extension |
| Claude in Chrome | not a stdio server, so not in B1 | **headed**: the operator's real, visible Chrome and profile, through the extension |

### Skipped or failed, with reasons

- **BrowserMCP (`@browsermcp/mcp@0.1.3`): B2 only, run separately.**
  - **Why it was skipped at first.** At every startup, the server runs `lsof -ti:9009 | xargs kill -9`
    (`dist/index.js`, `createWebSocketServer`), whether or not the port is taken. During the first
    session, the port was held by a BrowserMCP server started outside the bench (pid 82877).
  - **How it was run.** At 06:43 UTC, with the operator's approval, that server was stopped with SIGTERM.
    The operator had connected a tab in the extension, and `node bench/agent/run.mjs --only browsermcp` ran
    the six runs. The extension polls every second, so it reconnects to each new server by itself.
  - **The lsof shim.** That `lsof` also matches the port's clients, which includes Chrome's network
    service while the extension is connected. The bench therefore puts a shim first on PATH
    (`bench/agent/lsof-listen-only/lsof`) that narrows the match to listeners. It was tested on a
    dummy port: plain `lsof` listed the listener and the client, and the shim listed only the listener.
    The shim was first on PATH for all six startups. Chrome's network-service process (pid 36537) was
    the same before and after the runs.
  - **The result file.** The runner writes one dated file, so it replaced the 30-run file. The six
    runs were merged back into `results/2026-10-23-agent.json` by script; `browsermcp_session` holds
    their start state.
  - **Why no B1.** There is no micro adapter: BrowserMCP drives the real, headed Chrome, so its step
    timings would not be comparable. The micro tables still show the first session's skip reason.
- **agent-infra, step (c), 0/20.** `browser_get_clickable_elements` lists only part of a long page: 642
  of the 1,000 items, missing 643 to 1000. It has no other structured-snapshot tool.
- **agent-infra, step (f), 0/20.** `browser_form_input_fill` on the date input answers "Maybe failed
  filled index 21". After that, the submit click reports "Clicked element: 29", but nothing is
  submitted: the date input keeps focus and the page stays on `forms.html`. A submit click without the
  date fill does submit. All 9 calls returned without a tool error, so only the oracle caught this.
- **Agent runs.** There were no timeouts. No Claude in Chrome run stalled: all six finished in 20 to
  37 s. Whether the extension showed a site-permission prompt was not observed. In two runs (T2 DevTools rep 1 and T1 agent-infra rep 2), 2 processes from that
  run's own tree were still alive 3 s after `claude` exited, and the bench SIGKILLed them.

### Caveats

- **Sample size.** B2 has n = 2 per cell. The medians of two runs are their mean, so do not read small
  differences as real.
- **Live sites.** B2 uses live sites (httpbin.org, wikipedia.org), so network time is part of every run,
  and the sites can change.
- **Global instructions.** `claude -p` loads the machine's user-level Claude Code instructions. That is the same for
  every contender, but it is part of every run's input cost.
- **BrowserMCP's conditions.** Its six runs started two hours after the others, at a lower load (1-minute
  load 2.10, against 3.88). They ran in the operator's real Chrome: headed, logged in, with a warm cache. Its
  times are not directly comparable with the headless, fresh-profile runs.
- **Probe run.** One extra Claude in Chrome probe ($0.057) read its tool list. It is not in the tables.
- **Defaults.** "Own best way" means each tool's default output settings. Some flags would change the
  picture, and none were used:
  - Playwright's `--snapshot-mode none` and `--timeout-settle` (its 500 ms click settle);
  - DevTools' `--screenshotFormat` and `--slim`;
  - our `navigate {snapshot:false}`.
- **Screenshot formats.** These are the defaults: we return JPEG, while Playwright, DevTools and
  agent-infra return PNG. The image sizes compare those defaults, not encoders.
- **DevTools page ids.** DevTools requires a `pageId` by default, and B1 passes `1`. A real agent first
  needs `list_pages`, which B2 shows.
- **Ref preparation.** In B1 (d), (e) and (f), the snapshot that yields refs is untimed and identical
  for every tool. Ours and Playwright's also accept CSS selectors, but refs were used everywhere.
- **Cold start profile.** Cold start uses a fresh temporary profile for all four tools. PLAN.md's ≤ 3 s
  target names an existing profile, which was not measured, so as not to touch `~/.x2-browser/profile`.
- **Run order.** B1 ran its contenders one after another under changing load (see the load columns).
  It ran each step 20 times, not interleaved across tools.

## Micro detail

<!-- gen:micro-detail:begin -->

**(a) cold first call**, cold first call: spawn + initialize + first navigate (incl. browser launch)

| Tool | passed | p50 ms | p95 ms | calls | text chars | image bytes | note |
|---|---|---|---|---|---|---|---|
| x2-browser | 10/10 | 809 | 1076 | 1 | 1,035 | 0 |  |
| playwright | 10/10 | 612 | 679 | 1 | 365 | 0 |  |
| devtools | 10/10 | 746 | 1056 | 1 | 129 | 0 |  |
| agent-infra | 10/10 | 598 | 796 | 1 | 1,735 | 0 |  |
| browsermcp | skipped | | | | | | startup SIGKILLs whatever holds TCP :9009; a BrowserMCP server not started by the bench held it |

**(b) navigate + snapshot, form page**, navigate + snapshot of the form page

| Tool | passed | p50 ms | p95 ms | calls | text chars | image bytes | note |
|---|---|---|---|---|---|---|---|
| x2-browser | 20/20 | 123 | 130 | 1 | 960 | 0 |  |
| playwright | 20/20 | 32.2 | 37.3 | 2 | 1,972 | 0 |  |
| devtools | 20/20 | 120 | 122 | 2 | 1,971 | 0 |  |
| agent-infra | 20/20 | 17.4 | 24.5 | 1 | 1,735 | 0 |  |
| browsermcp | skipped | | | | | | startup SIGKILLs whatever holds TCP :9009; a BrowserMCP server not started by the bench held it |

**(c) complete snapshot, big-1000**, complete snapshot of big-1000 (all 1000 items; continuation pages counted)

| Tool | passed | p50 ms | p95 ms | calls | text chars | image bytes | note |
|---|---|---|---|---|---|---|---|
| x2-browser | 20/20 | 13.0 | 16.1 | 2 | 25,559 | 0 |  |
| playwright | 20/20 | 17.7 | 21.9 | 1 | 38,002 | 0 |  |
| devtools | 20/20 | 37.3 | 42.5 | 1 | 30,928 | 0 |  |
| agent-infra | 0/20 | n/a | n/a | n/a | n/a | n/a | FAILED: missing 358 items (first 643) (all-runs p50 311 ms, 1 calls, 26,114 chars) |
| browsermcp | skipped | | | | | | startup SIGKILLs whatever holds TCP :9009; a BrowserMCP server not started by the bench held it |

**(d) click, no navigation**, click, no navigation

| Tool | passed | p50 ms | p95 ms | calls | text chars | image bytes | note |
|---|---|---|---|---|---|---|---|
| x2-browser | 20/20 | 118 | 126 | 1 | 33 | 0 |  |
| playwright | 20/20 | 525 | 533 | 1 | 250 | 0 |  |
| devtools | 20/20 | 239 | 244 | 1 | 35 | 0 |  |
| agent-infra | 20/20 | 208 | 209 | 1 | 18 | 0 |  |
| browsermcp | skipped | | | | | | startup SIGKILLs whatever holds TCP :9009; a BrowserMCP server not started by the bench held it |

**(e) type into an input**, type into an input

| Tool | passed | p50 ms | p95 ms | calls | text chars | image bytes | note |
|---|---|---|---|---|---|---|---|
| x2-browser | 20/20 | 107 | 108 | 1 | 42 | 0 |  |
| playwright | 20/20 | 7.0 | 11.0 | 1 | 112 | 0 |  |
| devtools | 20/20 | 222 | 232 | 1 | 35 | 0 |  |
| agent-infra | 20/20 | 13.2 | 21.6 | 1 | 73 | 0 |  |
| browsermcp | skipped | | | | | | startup SIGKILLs whatever holds TCP :9009; a BrowserMCP server not started by the bench held it |

**(f) fill 8 fields + submit**, fill 8 fields + submit

| Tool | passed | p50 ms | p95 ms | calls | text chars | image bytes | note |
|---|---|---|---|---|---|---|---|
| x2-browser | 20/20 | 277 | 286 | 1 | 481 | 0 |  |
| playwright | 20/20 | 658 | 694 | 2 | 868 | 0 |  |
| devtools | 20/20 | 659 | 672 | 2 | 126 | 0 |  |
| agent-infra | 0/20 | n/a | n/a | n/a | n/a | n/a | FAILED: submissions=0 wrong=<no single submission>:undefined errs= (all-runs p50 737 ms, 9 calls, 441 chars) |
| browsermcp | skipped | | | | | | startup SIGKILLs whatever holds TCP :9009; a BrowserMCP server not started by the bench held it |

**(g) viewport screenshot**, viewport screenshot

| Tool | passed | p50 ms | p95 ms | calls | text chars | image bytes | note |
|---|---|---|---|---|---|---|---|
| x2-browser | 20/20 | 15.4 | 27.8 | 1 | 69 | 33,635 |  |
| playwright | 20/20 | 30.8 | 35.2 | 1 | 329 | 37,875 |  |
| devtools | 20/20 | 15.1 | 18.7 | 1 | 49 | 54,803 |  |
| agent-infra | 20/20 | 31.9 | 33.6 | 1 | 40 | 37,639 |  |
| browsermcp | skipped | | | | | | startup SIGKILLs whatever holds TCP :9009; a BrowserMCP server not started by the bench held it |
<!-- gen:micro-detail:end -->
