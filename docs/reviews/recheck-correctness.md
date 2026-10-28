# Correctness re-check: main@5a35003 (flow-verifier-high, 2026-10-21)

## Original findings: all fixed
C1, C2, C3 (as written), C4, C5, W1–W6 and N1–N4 are fixed. N5 is only partly fixed and was checked by reading the code. The reviewer's scripts are `/tmp/x2b-rc2/c1.mjs` to `c12.mjs`; logs are in `/tmp/x2b-rc2/logs/`.

## New findings introduced by the fix diff

### R-C1 (critical): a call can still click after reporting a timeout, while the next call runs
- **Where:** `src/tools/click.ts:27,29,49` and `src/dispatch.ts:243-249`.
- **Breaks:** item 9.
- **Repro** (action timeout 2000):
  1. `wait ms=3500`.
  2. At +100 ms, `click #b`. An overlay covers `#b` until 4.7 s.
  3. At +250 ms, `evaluate`.
- **Observed:**
  - The click answered `timed out after 3900ms` at 4008 ms.
  - The `evaluate` ran at 4008 ms.
  - The page then logged `click@4889`.
- **Cause:**
  - Playwright actions get the full action timeout instead of what remains of the call's deadline.
  - When `withDeadline(job(), left())` rejects, the queue advances while `job()` is still running.
- **Fix:**
  - Bound every Playwright timeout by `ctx.deadlineAt` in all act-based tools, the way `fill_form`'s `remaining()` does.
  - Don't advance the tab queue until `job()` actually settles. The caller gets its timeout answer on time; the queue waits for the abandoned job, which is now short because of the bounded timeouts.

### R-C2 (critical): a pre-takeover ref clicks the wrong element when three servers are involved
- **Where:** `src/shared/router.ts:47-58,62-76`.
- **Scenario:** A owns the browser; B and C have joined. A exits and B takes over. C rejoins B. C's old ref e12 then clicks B's new e12. There is no notice, and an old ref reports a tab belonging to another client.
- **Fix:**
  - The joiner sends its highest-seen ref and tab id when it joins (or with every call).
  - The owner raises its counters and the previous-session floor to match.
  - A client that rejoins gets the "previous browser session" floor and the takeover notice.

### R-C3 (critical): page text can collapse every ref and tab id into one value after a takeover
- **Where:** `src/shared/router.ts:72-73` and `src/browser/refs.ts:155-157`.
- **Cause:** the router regex-scans all result text, including page content, for `e<digits>` and `t<digits>`. A page containing `e9007199254740993` pushes the counters past 2^53, where `next++` no longer changes the number.
- **Fix:** the owner returns its counters in the result frame as structured fields, and the joiner never scans text. Add a sanity bound if any scan stays.

### R-C4 (critical): `--blocked-origins` is bypassed by any redirect
- **Where:** `src/browser/session.ts:267-268` and `src/tools/navigate.ts:94`.
- **Observed:**
  - `navigate` to an allowed URL that 302s to a blocked host lands on that host and reads it.
  - The same redirect trick works for `<img>` and `fetch`.
  - A direct request or a WebSocket to the blocked host is blocked correctly.
- **Cause:** the route handler only sees the first URL of a redirect chain.
- **Fix** (`--allowed-origins` uses the same predicate):
  - Handle redirects in the route: `route.fetch({ maxRedirects: 0 })`, then check each `Location` with `checkOrigin`.
  - Or check `request.redirectedFrom()` chains.
  - Or verify every main-frame and subframe navigation commit, sending the frame to about:blank and reporting `→ blocked`.

### R-C5 (critical regression): settle returns before the page has finished updating after quick successive actions
- **Where:** `src/page/injected/index.ts:38,64,73,114`.
- **Cause:** a node that the *previous action* changed twice within 1.5 s is classed as churning, so its later changes are ignored.
- **Repro 1:** each click sets a role=status element to "loading", then "step1" at 60 ms, then "final" at 150 ms. After four quick clicks, the alerts read "final 1", "step1 2", "step1 3", "step1 4". The pre-fix build reported "final" every time.
- **Repro 2:** a panel with a ticking clock, where the click appends a button 200 ms later. The snapshot misses the new button.
- **Fix:** treat a node as churning only when it changes periodically (for example ≥3 changes at a steady interval) and none of those changes fell inside the previous action's settle window. Item 11 must still hold.

### R-W6 (warning): a password of 4+ characters corrupts the output format
- **Where:** `src/util/secrets.ts:12` and `src/dispatch.ts:155-157`.
- **Observed:** with the password "text", the snapshot shows `- <redacted>box e10`, `button "Save <redacted>"`, and `evaluate` returns `"con<redacted> <redacted>"`.
- **Fix:** scrub only page-derived values (names, values, text, URLs, evaluate and console payloads), never roles or ref tokens. Match whole tokens, and raise the minimum length (e.g. 6). Common words must not be scrubbed.

### R-W7 (warning): secret-name matching is a substring match
- **Where:** `src/util/secrets.ts:9`.
- **Observed:** `?author=<redacted>&passengers=<redacted>`.
- **Fix:** match the name as a whole word or a word part, e.g. `(^|[_-])(pass(word)?|pwd|secret|token|api[-_]?key|auth)([_-]|$)`, case-insensitive. Amend item 5 accordingly.

### R-W8 (warning): remembered passwords are lost on takeover
- **Where:** `src/util/secrets.ts:14`. The set lives in the owner process.
- **Fix:** the joiner remembers what it types itself. Its args pass through it, so it can scrub results locally. The owner can also share the set.

### R-W9 (warning): `fill_form` reports `ok` for a field it never filled, then fills it in the background
- **Where:** `src/tools/fill_form.ts:228,241`.
- **Scenario:** a timer calls `confirm()` at 300 ms, while `#late` only appears at 600 ms.
- **Observed:** the result says `ok "#late" (a dialog opened)`. After `dismiss`, `#late` gets filled.
- **Fix:** print `ok … (a dialog opened)` only when the fill actually finished. Otherwise mark the field `skipped`, and make sure the pending fill can't land: bound its timeout, or abort it.

### R-W10 (warning): the snapshot footer undercounts when an iframe is past the in-page cut
- **Where:** `src/page/injected/snapshot.ts:209,219`.
- **Observed:** the first pages report a total of 457 lines, rising to 507 on later pages; the true total is 507. Line content is still exact.
- **Fix:** count dropped iframes, or print the count as "at least N".

### R-W11 (warning): `wait target=eN state=detached|hidden` fails when the element went away through a navigation
- **Where:** `src/tools/wait.ts:102`.
- **Fix:** for `detached` and `hidden`, an earlier-document ref counts as success.

## Nits
- **`dispatch.ts:215`:** dialog-exempt tools use `deadline` instead of `left()`.
- **Effect order:** a blocked file: click prints `→ navigated about:blank "" (200)` before `→ blocked …`. Print `→ blocked` first, or drop the about:blank line.
- **Error prefix:** the "earlier document" error has the `[t1]` prefix in one path and not in the other.
- **Already there before the fix:** a reload on an error page reports `chrome-error://chromewebdata/` as the URL that failed.

## Unknown
- Service-worker requests vs `ctx.route`.
- The `--allowed-origins` redirect variant.
- Whether C4's EEXIST branch was taken.
- `batch` budget sum.
- `video frames` deadline.
- `beforeunload`.
- Headed mode.
- N5 memory.
