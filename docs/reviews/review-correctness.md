# Correctness review: x2-browser-mcp main@13fb319 (flow-verifier-high, 2026-10-21)

Every finding was reproduced against the built server, with scenarios derived from PLAN.md.

## Critical

### C1. A queued call times out but still runs
- **Where:** `src/dispatch.ts:176`.
- **Breaks:** G1 and same-tab serial execution.
- **Cause:** the deadline timer starts only when the queued job starts. When it fires, the job (`job()`) has already begun, and nothing cancels it.
- **Repro:** `wait ms=15000` on t1, then 100 ms later `click #b` on t1 (budget 10 s, so it must answer by 11.9 s).
- **Observed:** the click answered at 14915 ms with `[t1] timed out after 11900ms`, yet the page counter reads 1. The click happened after the agent was told it failed. An agent that retries such a click double-submits.
- **Fix:** race the queue wait itself against the deadline. If the job's turn comes after the deadline, return the timeout without touching the page.

### C2. A dialog in the middle of `fill_form`
- **Where:** `src/page/effects.ts:111-113` (the action is abandoned when a dialog wins the race) and `src/tools/fill_form.ts:165`.
- **Breaks:** "submit only if all fields succeeded", as seen by the agent, and the tab queue.
- **Repro:** fields `#a`, `#b`, `#c` with `submit #go`, where `#b`'s change handler calls `confirm()`.
- **Observed:** after 48 ms the result said `filled 3/3 fields`, with only two `ok` lines and `→ dialog pending confirm`. After `dialog dismiss`, the page read `{"c":"C","submitted":1}`: field c was filled and the form submitted in the background, outside the queue.
- **Same path:** `type submit:true`.
- **Fix:** check `tab.dialog` between fields and before submit, and stop there. Count fields attempted. Don't let an abandoned action keep running fields.

### C3. Ref numbers and tab ids restart at 1 after a takeover
- **Where:** `src/browser/refs.ts:27` (`next = 1`) and `src/browser/session.ts:124` (`nextTab = 1`).
- **Breaks:** "never reused".
- **Repro:** server B joins A and gets `button "Keep draft" e4` on t2. A exits and B takes over.
- **Observed:** B's new page lists `e1..e5`. `click e4` (the old ref) silently clicked `button "z"`.
- **Fix:** have the joiner track the highest e/t numbers it has seen (or the owner sends its counters), and start both counters above that after a takeover.

### C4. Two servers making their first call at once
- **Where:** `src/shared/owner.ts:64-65` and `src/shared/router.ts:86`.
- **Breaks:** A4.
- **Cause:** on macOS, `server.listen()` throws `EEXIST` synchronously once the other server has bound the socket. That error goes to `reject`, so `decide()` sets `disabled = true` permanently.
- **Observed:** 2 of 4 rounds failed. Every later call was refused with a false "not an x2-browser server" foreign-lock error.
- **Fix:** wrap `listen` in try/catch, treat `EEXIST` like `EADDRINUSE` as in-use (retry the join), and never set `disabled` on that path.

### C5. `wait target=<ref from an earlier document>` checks an element on the current page
- **Where:** `src/tools/wait.ts:102`. It uses `handleFor(rec.frame, rec.localId)` without the document check.
- **Breaks:** "a ref from an earlier document returns isError".
- **Observed:** `waited for e3 visible (18ms)` was a false success.
- **Fix:** run the same ping/document check as `resolveRef` (`page/target.ts`).

## Warnings

### W1. Invalid arguments bypass the two-line error shape
- **Where:** `src/index.ts:50`.
- **Breaks:** G3 and contract answer 2.
- **Observed:** `click {}` returned `MCP error -32602: Input validation error: …` with no `hint:` line.
- **Fix:** register a permissive schema and validate in `tool.parse`, or reformat the SDK's error.

### W2. A selector click lowers a ref's `unique` flag, so stale-ref re-resolution stops working
- **Where:** `src/page/target.ts:144` and `src/browser/refs.ts:41`.
- **Fix:** don't lower `unique` when the issuer didn't compute it.

### W3. The password literal leaks through URLs and live regions
- **Scenario A:** a GET form submit puts `?pass=Hunter2SecretPW` into:
  - the `→ navigated` effect line;
  - the snapshot header;
  - `tabs list`;
  - `network`;
  - `read`.
- **Scenario B:** a page that echoes the input produces `→ alert "You typed Hunter2SecretPW"`.
- **Fix:** remember the literals the server itself typed into password fields and scrub them from every result. Redact password-named query parameters in URLs.

### W4. A stale `SingletonLock` from an earlier hostname blocks the profile permanently
- **Where:** `src/browser/session.ts:39` and `:252`.
- **Why it matters here:** a Mac's hostname can follow DHCP, so it can change between networks.
- **Fix:** when the host differs, let Chrome decide (try the launch), or tell the user how to remove the lock.

### W5. A joiner waits forever if the owner is alive but unresponsive
- **Where:** `src/shared/joiner.ts:75` (no timer).
- **Breaks:** G1.
- **Fix:** time the forwarded call out at the call's budget plus slack.

### W6. A crashed tab can't be recovered as the notice says
- **Where:** `src/browser/tabs.ts:186`.
- **Observed:** after a crash, reload/navigate returns `Page crashed` with a generic hint. The notice arrives late, and `tabs list` doesn't mark the tab.
- **Fix:** a dedicated error ("tab crashed; close it with tabs close or open a new tab") and a mark in `tabs list`.

## Nits

- **N1.** Owner `session close` drops joined clients' tabs without notice (`src/tools/session.ts:47`).
- **N2.** One malformed line kills the owner: a `null\n` line on the socket gives a TypeError (`src/shared/protocol.ts:38`, `owner.ts:80`). Validate frames, and never crash on a bad frame.
- **N3.** `fill_form` error text reads "noelement matches" (`src/tools/fill_form.ts:191`), because `reason.replace(' ', '')` deletes the first space.
- **N4.** `video list` prints `duration=unknown` before metadata loads (`src/tools/video.ts:47`). Contract answer 14 allows only `s.ss|Infinity`. Decide: amend the contract or print something the contract allows.
- **N5.** `forgetDocs` has no caller, so ref records (holding Frame objects) for every past document live for the whole process.

## Unknown (not checked by the reviewer)
- `beforeunload` auto-accept.
- annotate cleanup.
- Chrome launch time inside `ensure()` runs outside the deadline (G1 under load).
- The `batch` budget sum.
- The stale-socket unlink race.
- Long-session memory.
- Headed mode.
