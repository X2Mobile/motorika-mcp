# Performance review: x2-browser-mcp main@13fb319 (flow-verifier-high, 2026-10-21)

Measured on a busy machine. The reviewer's repro scripts are in `/tmp/x2b-rev-p/`:

| Script | Reproduces |
|---|---|
| `h.mjs` | harness and watchdog |
| `s5.mjs` | serialisation, labels |
| `s12.mjs` | labels on a realistic page |
| `s2.mjs`, `s3.mjs` | second walk |
| `s6.mjs` | churn |
| `l1.mjs`, `l2.mjs`, `l3.mjs`, `l4.mjs` | memory retention |
| `s13.mjs` | orphan tab |
| `s11.mjs` | video frames, cold start |

## P1 (critical): state from every past page is kept forever
- **Where:** `refs.ts:72,95-96` and `tabs.ts:97,112-119`.
- **Measured** on a 50-iframe page:
  - about 1.4 MB of heap retained per navigation, growing linearly;
  - `frameIds` 1001 → 3001;
  - refs 21k → 63k;
  - the user-visible frame label climbs to `frame=f3001`;
  - the ref store costs 274 B per ref;
  - `closedRefs` keeps 7 MB after the tab closes.
- **Cause:**
  - `forgetDocs` is never called.
  - `RefRecord.frame` pins a detached Playwright Frame.
  - `frameIds` never deletes an entry.
  - `closedRefs` and `oldDocRefs` only grow.
  - Refs are issued for every walked node, not just the lines output (a 20k-element page puts 25k refs in the store).
- **Fix:**
  - Delete from `frameIds` on `framedetached`.
  - Call `forgetDocs` on main-frame `framenavigated`, keeping the current frames' doc ids.
  - Store a frame label in `RefRecord`, not the Frame.
  - Cap `closedRefs` and `oldDocRefs`, e.g. at the last 10k, so stale-ref errors stay informative for recent ones.
  - Issue refs only for output lines, or lazily.

## P2 (warning): snapshot data serialised as a nested object, with no caps in the page
- **Where:** `engine.ts:40-51`; `dom.ts:289-298`, `:457`, `:475`; `snapshot.ts:72-85`.
- **Measured:**
  - 5k page: `call()` 180 ms vs 38 ms as a JSON string.
  - 20k page: 698 ms vs 117 ms.
  - Payload for a 19.8k-char result: 1.83 MB.
  - A labelledby-heavy page: 3.96 MB.
  - A 1 MB textarea: 1.5 MB for a 382-char result.
  - Server RSS peaks went 118 → 459 MB.
- **Fix:**
  - Return a JSON string from the page for snapshot, find and read, and `JSON.parse` it on the server.
  - Truncate names and values to 100 chars, and labelledby text to about 400, inside the page.
  - Stop emitting once past `max_chars` + offset.
  - **Expected gain:** 4.7–6×.

## P3 (warning): `.labels` searches the whole document again after any DOM change
- **Where:** `dom.ts:302` (`labelText`); `snapshot.ts:251` (`find` reads `.labels` on every node, buttons included).
- **Measured:**
  - Warm 20k walk: 85 ms. After one DOM append: 1200 ms.
  - `find` on the 20k page: 2.36 s.
- **Fix:** build one `Map<control, label[]>` per walk from `qsa('label')` and `label.control`, plus wrapping labels.

## P4 (warning): `scope`, `viewport_only` and `describe(el, true)` walk the whole document again
- **Where:** `snapshot.ts:202,216,228`.
- **Measured:** `scope=h1` on the 20k page takes 172 ms for one line. Each `describe(el, true)` is a full walk:
  - once per video in `video list` (`video.ts:117`);
  - once per iframe context line in `find` (`find.ts:66`);
  - twice per stale-ref re-resolve.
- **Fix:** cache role+name counts and mark the cache dirty from a long-lived MutationObserver, or count only the subtree being output.

## P5 (warning): any page that keeps changing makes every action wait the full 600 ms cap
- **Where:** `injected/index.ts:51-52` (observer with `attributes` and `characterData`, no filter); `effects.ts:11-16,59-67`.
- **Measured** on a clock or a style attribute updated every 50 ms: click p50 630 ms, press 608 ms, hover 651 ms, navigate + snapshot 627 ms. A static click is 117 ms.
- **Fix:**
  - Measure the page's normal mutation rate before the action, and settle when it returns to that baseline.
  - Or ignore attribute/characterData mutations on nodes the action didn't touch, and style-only changes.
- **Correctly excluded already:** WebSocket, EventSource, a playing video, a pre-existing hanging fetch.

## P6 (warning): about 5.8 KB leaked per action
- **Element handles are never disposed:**
  - `click.ts`, `type.ts`, `hover.ts`, `press.ts`, `scroll.ts`, `drag.ts`, `upload.ts`;
  - `fill_form.ts:54,69`;
  - the re-resolve handle at `target.ts:76`.

  That is about 3.3 KB each, and they survive navigations.
- **Promise reactions pile up** (`tabs.ts:144-154`, `effects.ts:110,146`, `dispatch.ts:170`). `dialogOpened()` returns a shared promise that never settles while no dialog appears, so each action adds `.then` reactions: about 2.5 KB per action.
- **Fix:**
  - Dispose handles in a `finally` in every tool.
  - Use a per-action abort signal, or remove the listener, instead of racing a shared promise that never settles.

## P7 (warning): the in-page id map never shrinks on single-page apps
- **Where:** `dom.ts:44-56`.
- **Measured:** 200 re-renders of 1000 rows → id counter 200,007 while 1,009 nodes were alive.
- **Fix:** sweep entries whose WeakRef is dead at the start of each walk, or use a FinalizationRegistry.

## P8 (warning): a joined session killed mid-call leaves an orphan tab in the shared Chrome
- **Where:** `session.ts:433-438` (`dropClient`), `:339-351` (`register`), `:142-149` (`client()` recreates).
- **Mechanism:** `dropClient` reads `clientTabs()` before `newTab` has registered the page. `register` then calls `this.client(owner)`, which recreates the deleted client. The tab lives on, and no client can see it.
- **Fix:**
  - Mark the client id as dropped.
  - In `register` and `newTab`, close the page if its owner was dropped.
  - Never create a client from `register`.

## P9 (warning): default jpeg video frames each take a second capture for the black-frame check
- **Where:** `video.ts:238-248`.
- **Measured:**
  - `count:6`: jpeg 550 ms vs png 362 ms.
  - Sampling every 50 ms caught 28 of 41 frames.
- **Fix:** probe only the first frame, or reuse a single small capture.

## P10 (warning): no `npm run bench`, so F1 does not exist yet
Scheduled for the bench agent.

## Nits
- **Timers not cleared after a race:** `effects.ts:48-51,66,192`.
- **Static click floor:** about 85% of the 117 ms click is the 100 ms quiet window. Fewer round trips into the page also save time:
  - merge `ping` + `byId`;
  - fold `liveTexts` into `quiet`.
- **Hidden iframes:** 2 calls per child frame before filtering (`snapshot.ts:35-54`).

## Crashed-tab behaviour (handed to the correctness lens)
- `find` swallows errors per frame and says "0 hits": a silent wrong answer (`find.ts:29`).
- `screenshot` hangs for the full 11.9 s.
- `navigate` fails with "Page crashed", while the notice says to reload.

## PLAN targets (p50 on a busy machine; all pass on static pages)

| Step | p50 | Notes |
|---|---|---|
| click | 116.6 ms | |
| click on a churning page | 630 ms | fails (P5) |
| type | 108.2 ms | |
| fill_form 8 fields + submit | 150–167 ms | |
| snapshot of 1k elements | 37.4 ms | |
| navigate + snapshot | 124.3 ms | |
| cold first call | 466–671 ms | `--isolated` |
