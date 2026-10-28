# Performance re-check: main@5a35003 (flow-verifier-high, 2026-10-21)

The reviewer's scripts are in `/tmp/x2b-rev-p/`:
- `r1`–`r6`
- `l6`–`l9`
- `l7spa`
- `m1`
- `s13b`

Its builds are in `/tmp/x2b-rev-p/build` (new) and `/tmp/x2b-rev-p/build-old` (old).

## Status

**Fixed:**

| Finding | Before | After |
|---|---|---|
| P2: 5k snapshot | 179 ms | 31 ms |
| P2: 20k snapshot | killed at 1.5 GB | 105 ms |
| P3: 20k walk after one DOM append | 1200 ms | 96 ms |
| P6 | | 0 undisposed handles, heap flat |
| P7 | | renderer heap flat |
| P8 | | 0 orphans |
| P9 | | 383 ms, 41/41 frames |

**Partly fixed:**
- **P1, navigation:** retention is gone from our state. The remaining ~1.15 MB per navigation is inside playwright-core: it keeps detached Frames and each document's Request/Response objects until `page.close`.
- **P1, single-page apps:** NOT fixed. A re-render plus snapshot adds about 1000 live refs per cycle: 301k refs and about 97 MB after 300 cycles. Nothing retires refs whose elements left the DOM.
- **P1, frame label:** still climbs (`f6001`), because `nextFrame` never resets. Cosmetic.
- **P4:** the cache is keyed on `docVersion`, so a page that changes by itself gets no gain.
- **P5:** navigating ONTO a churning page still waits the full 626 ms cap.

**Unchanged:**
- **P10:** no bench script yet.
- **Static click floor:** 116.5 ms. The 100 ms quiet window dominates.

## New findings

### PN1 (warning): origin lists send every request through Node
- **Where:** `browser/session.ts:262-264`.
- **Cause:** `ctx.route` with a function matcher compiles to `{glob: "**/*"}`, so every request of every tab makes a round trip through Node.
- **Measured:** about +15% on a 50-iframe page.
- **Fix:** compile the host lists into a regex `URLMatch`, so only matching URLs are routed. Also fix the comment that says "allowed traffic pays nothing".

### PN2 (warning): ref-registry scans walk every live ref
- **Where:** `browser/refs.ts:133,143,148`.
- **Cause:** `forgetFrame`, `forgetFrameBefore` and `forgetTab` each scan all of `byRef`.
- **Measured:**
  - 20 ms per navigation at 25k live refs, 133 ms at 100k.
  - With a single-page-app tab holding 302k refs, navigate + snapshot in another tab takes about 577 ms instead of about 430 ms.
- **Fix:** index refs by `tabId|frameLabel` → `Set<ref>`. Also retire same-document refs whose ids were dropped by the in-page sweep, or cap live refs per document.

### PN3 (nit): remembered secrets are never evicted
- **Where:** `util/secrets.ts:19`.
- **Measured:** with 500 remembered secrets, a 2500-line snapshot costs about 39 ms more.
- **Fix:** cap the set (e.g. 64 most recent) or build one combined regex.

## Off-lens notes
- **Ref stability:** `sweepIds` (`dom.ts:82`) drops entries for detached nodes, so a node that is re-attached loses its ref. Only dead WeakRefs should be dropped.
- **Short passwords:** with `MIN_SECRET_LEN = 4`, a password like "test" scrubs every "test" in every result.
- **Settle:** `wasChurning` keys `childList` mutations on the parent, so an action that appends to an already-active feed is ignored by settle.

## PLAN targets (p50 / p95 in ms, n=20, busy machine)

| Step | Result |
|---|---|
| click | 116.5 / 118.1 |
| type | 107.5 / 111.0 |
| fill_form 8 fields + submit | 167.2 / 190.6 |
| snapshot of 1k elements | 8.0 / 10.3 |
| navigate + snapshot | 129.2 / 200.1 |
| cold initialize + first navigate | 263 + 521 |
| click on a churning page | 116.9 / 135.3 |

All targets pass.
