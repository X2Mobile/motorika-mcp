# Tools

How the tools behave: targets, output, paging, settle, frames, dialogs and video. Back to the [README](../README.md).

## Using the tools

These notes cover the contract details that most often matter. `PLAN.md` has the full tool list and
grammar.
- **Targets** take three forms:
  - a ref (`e12`) from snapshot, find, a strict-mode listing or an evaluate result. A ref locates its
    own tab and frame.
  - `"x,y"` in the last screenshot's pixels. With no screenshot yet, it is CSS px of the viewport. The
    screenshot header's size is read from the image itself, so it holds on a 2x retina screen too.
  - a Playwright selector, matched strictly. With more than one match, the error lists up to 5 matches
    as snapshot lines with refs.
- **Errors:** line 1 states the cause, line 2 starts with `hint: ` and names the next step. A
  `fill_form` with failed fields puts its per-field `ok …`/`failed …` lines after those two.
- **Snapshot paging:** the header line is printed on every page. `offset` counts body lines only, the
  footer reports the remaining body lines and the next offset, and pages have no gaps and no overlaps.
  The default `max_chars` is `--max-output-chars` minus 200, which leaves room for the footer. A line
  longer than the page is cut inside the grammar (strings end `…"`, option lists close with `]`); the
  header's title is clipped to 200 chars and its URL to 500. A `max_chars` too small for the header,
  the first line's head and the footer is exceeded by that much rather than showing an empty page.
- **read paging:** `offset` and `max_chars` count characters of the content (header and footer not
  included). A cut page ends with `… <n> more chars (offset=<m> to continue)`, where `m` is exactly
  `offset + max_chars`, so pages have no gaps and no overlaps. The default and the ceiling for
  `max_chars` keep the whole result within `--max-output-chars`. A content line that starts like a
  server line (`→ `, `hint: `, `notice:`, `[t<digits>]`, `## step <digit>` or `… `) is printed with a
  leading backslash (`… ` since 2026-10-26: page text cannot print a batch cut note or a paging footer). Text inside a `<form>` is read (old.reddit's posts and comments live there); the value of an
  input, textarea, select or button never is. Comment sections are content, not boilerplate: Reddit's
  `section[aria-label=Comments]` and a blog's `<section id="comments">` are read with the page. Nav,
  footer, cookie/consent, ad, sidebar, share, related and similar blocks are still left out (whole class
  or id tokens only, so `badge` or `shadow` is not an ad). A comment itself (`role=article`, `<details>`,
  `shreddit-comment`, or the class name `comment`) is never dropped by its id, class or label, so "Comment
  from Cookie_Monster" and WordPress `comment-author-cookie-monster` are read; elsewhere an `aria-label`
  counts only when it is at most 3 words ("Advertisement", "Cookie consent"). A `<footer>` inside a comment (WordPress
  `footer.comment-meta`, the author and date) is read; the page footer is not.
- **console output:** a multi-line message continues on lines that start with `  | `, and each message is
  clipped to 4,096 chars.
- **find output:** each hit is a snapshot line. When there is a nearest heading or landmark, it follows
  on its own line as `  in - heading "…" eN level=2`. A hit inside a frame takes its iframe line as the
  context (`  in - iframe "…" eN frame=f2`). Text split across elements (`<span>21</span> comment
  karma`) is found as the smallest element holding it, printed as `group` with that text as its name. An
  empty `query` with a `role` lists every element of that role.
- **fill_form:** all fields share one budget, `timeout_ms` or the action timeout. Each field waits only
  for what remains; a field that never gets a turn reports `failed … timed out (call budget)`. To pick a
  radio, target either the radio (`true`, or a label/value of its group) or the `fieldset`/`radiogroup`
  that holds the radios, with the label or value of the one to pick. At the first dialog, `fill_form`
  stops: the remaining fields are listed as `not attempted (dialog pending)`, submit is not clicked, and
  the summary counts only the attempted fields. `type submit:true` presses no Enter after a dialog opened.
- **batch output:** each step sits under `## step <n>: <tool>` (` (error)` when it failed), images kept.
  When the steps together would pass `--max-output-chars`, every step still prints its header and the
  first line of its result (an error step: its cause and `hint:` lines; a skipped step: `skipped`), and
  the rest of the cap is shared fairly: a step whose remaining text is under an even share keeps it whole,
  the others are cut and end with `… <k> chars cut from step <n> (rerun it alone, or use read/snapshot
  with offset)` after a blank line. The cut is grammar-safe: snapshot lines are cut as in snapshot paging,
  a JSON string ends `…"`, a line that starts like a server line is dropped, not cut (a step's own first
  line is clipped instead), and no lone `\` line is left. Room a step cannot use goes to the steps still
  cut. When the first lines do not fit, they share the budget too (an error keeps its cause and hint).
  The cap counts the text parts plus one separator between parts, here and in the generic cap. Output
  that fits is unchanged. A result that starts with an image (screenshot) keeps its first text line
  right after the image. Floor: when not even the headers and the cut notes fit, as many whole headers
  as fit (images kept), then one line such as `… steps 6-12: no room; rerun them` naming the steps whose
  output or header did not fit. When every header fits there, the room left goes first to each error's
  cause and hint lines (whole), then to the other steps' first lines (clipped). An error's cause and hint
  are guaranteed only while all the headers and they fit. Trap: the steps ran even when their output was cut; rerun a cut step alone (or page it with
  read/snapshot `offset`), not the whole batch. Tests: `test/unit/batch-budget.test.ts`,
  `test/acceptance/batch-cap.test.ts`.
- **Effect summary:** action tools print `[tN] <verb> <target>` followed by `→ …` lines. The `→` lines
  appear in this order:
  1. navigated or url;
  2. new tab;
  3. tab closed;
  4. dialog;
  5. download;
  6. alert: `→ alert "<text>"` is a live-region announcement that appeared during the action
     (`role=alert|status|log`, `aria-live`, `<output>`), not a JS dialog (those are `→ dialog …`). An
     announcement that only repeats the page title (an SPA route announcer, as on new Reddit) is not
     reported, unless a `role=alert` element holds that text;
  7. console: `→ console <n> new error(s): "<first error>"` (the page's text, JSON-quoted).

  Page titles in the `navigate` line, the `→ navigated` line and the `tabs` lines are clipped to 200
  chars, ending in `…`.

  A snapshot follows after a blank line when you pass `snapshot:true` (the whole page), or by default
  after a navigation to a new document. The default one is a viewport snapshot (call snapshot for the
  whole page): only elements in the viewport, at most 6,000 chars, ending with
  `… viewport only: <n> more off-screen (find or read for text; snapshot for the whole page)` when
  anything was left out; when lines were cut it adds `, <k> more lines` and
  `; offset=<m> with viewport_only to continue`. `snapshot:false` skips it.
- **Settle** runs after every action and its caps are never errors:
  1. If the main frame navigated within 250 ms, it waits for the new document's DOM.
  2. Document, fetch and XHR requests started by the action, at most 1.5 s.
  3. 100 ms without DOM mutations, at most 600 ms. Mutations of nodes that were already changing on
     their own before the action (a clock, a progress bar) do not count, so a self-updating page does
     not hold every action to the 600 ms cap. A change the action makes to such a node is not waited for.

  The whole settle also stops 0.7 s after the call's own timeout, so a call never runs past its timeout
  plus 2 s. It always ends 0.6 s before the call deadline, and the reads after it (title, live regions,
  the attached snapshot) end before the deadline too. A call that waited behind earlier calls on its tab
  therefore still reports what it did: when the deadline cut settle short, the summary ends with
  `(settle incomplete: the call deadline came first, …)`. That is not an error; check the page with
  `snapshot` or `wait`. A navigation such an action started that commits during the remaining
  0.6 s is still reported as `→ navigated`.
- **navigate** waits in two steps: for the commit (the new document replaced the old one), then for
  `wait_until` in what remains of `timeout_ms` and the call deadline. A page that committed but did not
  reach `wait_until` in time is a success, not an error:
  `[tN] navigated <url> "<title>" (<status>)` with `(still loading: domcontentloaded not reached in 1500 ms)`.
  Check it with `snapshot` or `wait`; navigating again would load it twice. Only a navigation that never
  committed is an error. It is stopped first (Page.stopLoading), and it is reported only once the browser
  confirmed that nothing committed: `… timed out after 1500ms before it committed (…); stopped, the tab
  shows <url>` with `hint: stopped before it committed; the tab still shows <url>; retrying requests the
  page again …`. A commit that races the stop is a success. When the stop is not confirmed, the hint says
  the navigation may still land and to check with `snapshot`. A navigate that crashes the renderer
  answers `tab tN crashed` (Chrome can report that crash a while after the navigation failed: navigate
  waits for it, at most 4 s). Only the browser's crash event marks a tab crashed (round 7: after any failed
  call the server asks the browser through CDP; no error text is read as a crash): no text a page can
  produce does.
- **Frames:** each frame gets 500 ms in snapshot, find, wait text, the video search and screenshot
  annotations, and never holds the rest. A frame that did not answer in that time, or whose call failed
  while it was still attached, is *unavailable*, never empty. Measured on Chrome 155 (round-7b re-check): a
  busy page answers once it is idle. These frames never answer: an offscreen `loading=lazy` iframe until it
  is scrolled into view, an iframe whose src never responds, and `about:blank#frag`. A plain sandboxed
  `about:blank` does answer. On 28 ordinary sites (Wikipedia, YouTube, GitHub, news sites) no frame was
  unavailable.
  - snapshot marks its iframe line: `- iframe "Ad" e14 frame=f2 unavailable`. Only the server prints this
    attribute (page text is always quoted). A frame that answers shows its content even when a frame inside
    it does not; only that inner frame is marked. Nested frames are asked one level after another, at most
    1.5 s below the snapshot's own frame;
  - find returns the hits of the frames that answered, counts the rest in its header
    (`[t1] find "Pay": 0 hits; 1 frame unavailable (untrusted page content)`) and names them on the next line:
    `not searched: 1 frame unavailable (no answer within 500 ms): f2; find again, or snapshot`;
  - `wait text_gone` succeeds only when every frame answered and none holds the text. A frame that did not
    answer is asked again until the timeout, whose error names it:
    `… to disappear timed out after 2000ms; 1 of 2 frames unavailable (no answer within 500 ms): f2`. A frame
    that never answers therefore makes `text_gone` time out. `wait text` succeeds as soon as an answering
    frame holds the text;
  - `video list` and the default-video search say so too:
    `0 videos on the page (searched 2 frames; 1 frame unavailable (no answer within 500 ms): f2)`.

  `fN` is the same frame id in all four. Printed URLs are one token: whitespace, quotes, `<>`, backslash,
  backtick and control characters are percent-encoded (a `data:` frame's URL included).
- **navigate, round 7:** a commit is a new document (Chrome's loaderId for the main frame), never a URL
  match: a 302 hop, `pushState`, `replaceState` or a fragment change is never taken for one.
- **navigate, round 6:** only a new document counts as the commit. A same-document change of the old page
  (`pushState`, `replaceState`, a fragment) while the navigation is pending is not it, so a same-URL
  navigate or reload is never reported before its page arrives. `back` and `forward` read the tab's history
  first: `no earlier history entry` means there is none, and their errors name both URLs
  (`navigation back to <entry> … the tab shows <url>`). A URL that starts a download answers
  `[tN] <url> started a download: "<file>"` (no error), followed by `→ download …` once it is saved.
- **Timeouts:** every timeout or deadline error names the URL the tab shows (`…; the tab shows <url>`)
  and the time that applied: a `navigate` that waited in the tab queue reports its shortened timeout
  (`timed out after 450ms (…; timeout_ms 2000 capped by the call deadline)`), and the deadline error
  reports `timed out after <timeout + 1.9 s>ms (the call deadline …)`. When the tab moved during the call,
  or a navigate had started, the hint says to check it with `snapshot` before navigating again, never to
  retry.
- **Dialogs:**
  - Alerts are auto-accepted and reported.
  - A `confirm` or `prompt` stays pending until `dialog accept|dismiss`.
  - While a dialog is pending, other tools on that tab fail at once with the dialog text. The exceptions
    are `tabs list`, `session status` and `dialog`. Other tabs keep working.
- **Downloads** are saved as `<output-dir>/downloads/<sanitized name>`, with `-1`, `-2` … appended on a
  collision.
- **Tabs and clients:** every call goes through one dispatcher with a client context, which holds the
  client's active tab and owned tabs. Refs and tab ids are global counters per server process and are
  never reused.

## Video

`video` works on `<video>` elements in every frame, including cross-origin iframes. Code:
`src/tools/video.ts`, page side `src/page/injected/video.ts`; tests `test/acceptance/E.test.ts` and
`test/unit/video.test.ts`.
- **Default video**, when `target` is omitted: the largest visible playing video, else the largest
  visible one. `target` takes a ref from `video list` or a snapshot `video` line, or a selector. A target
  that is not a `<video>` is an error.
- **`list`** prints one line per video, with the default first:
  `e5 frame=f1 src="…" duration=6.00 time=1.25 paused=true muted=true volume=1 rate=1 size=640x360 ready=4 tracks=1`.
  - `size` is the intrinsic size (`videoWidth`x`videoHeight`), so it is `0x0` before metadata loads.
  - `duration` is `Infinity` for a live stream and `unknown` before metadata loads.
- **`play` / `pause` / `seek time=` / `set rate= muted= volume= loop=`** print the state line after the
  change. A rejected `play()` (autoplay policy) is an error; `set muted=true` first.
- **`frames`** returns images, each preceded by `frame <i>/<n> @ <mm:ss.ss>`:
  - `times=[…]` seeks to each time.
  - `count` (default 6) takes the midpoints of `count` equal bins over `[start, end]`, which defaults to
    the whole video.
  - `every_ms` + `duration_ms` samples in real time. A paused video is played for the sampling and then
    paused again. `count` on a live stream (duration `Infinity`) samples once per second.
  - Seek-based capture pauses the video, then restores the earlier time and paused state (the last line
    says `restored …`). Each seek waits for `seeked`, `readyState >= 2` and a presented frame
    (`requestVideoFrameCallback`, else two animation frames), and every wait has a timeout.
  - The capture is an element screenshot through CDP (`Page.captureScreenshot` with a clip). It never
    uses a canvas, so cross-origin video works.
  - **The trap:** anything drawn over the video is in the image: consent walls, player controls,
    captions and ads. Clear consent walls first with `find`/`click`. YouTube's buttons are named
    "Reject the use of cookies…", not "Reject all".
  - `format` defaults to jpeg (quality 70) and `max_edge` to 1280. `save:true` also writes each image to
    `<output-dir>/frames/` and prints the path.
  - A frame whose capture is all black (max channel ≤ 16), e.g. DRM-protected or not yet decoded, gets
    `black (…)` on its line.
- **`captions`** prints the cues of the text tracks (`<track>` and in-band) as `mm:ss.ss-mm:ss.ss "text"` (the cue text JSON-quoted),
  optionally limited to a `start`/`end` window. A disabled track is switched to `hidden` while it is
  read, then switched back. Captions drawn by a site's own player (YouTube's, for example) are not text
  tracks, so read them with `read` or `snapshot`.
- **Budgets:** `frames` with `every_ms` gets `duration_ms` + the action timeout, other `frames` calls get
  the navigation timeout, and every other action gets the action timeout. When the budget runs out
  mid-way, `frames` returns the frames it has with a `stopped at the call budget` line.
