# Motorika

The name comes from the Hungarian *finommotorika*, "fine motor skills": the clicks, keystrokes and form
fills an agent needs. The project was called x2-browser-mcp until 2026-10-28.

An MCP server (stdio) that gives an AI agent fast, reliable control of Chrome:
- tabs, forms, clicks, keyboard, scrolling and drag;
- uploads, downloads and JS dialogs;
- JS evaluation, console and network inspection.

It runs headed or headless, on a dedicated persistent profile or attached to a running Chrome. The
contract (tools, snapshot grammar, effect lines, acceptance criteria) is `PLAN.md`.

## Install and build

Needs Node >= 20 and an installed Google Chrome. `playwright-core` downloads no browser.

```sh
git clone https://github.com/X2Mobile/motorika-mcp.git
cd motorika-mcp
npm ci
npm run build          # esbuild bundles the injected page engine, tsc compiles, dist/index.js gets a shebang
npm run smoke:chrome   # checks that the pinned playwright-core can drive your installed Chrome
npm test               # build + unit + smoke tests
```

The build output is `dist/index.js`, which is executable, and `dist/injected.js`, the page engine the
server loads at runtime.

Register it with Claude Code, for example:

```sh
claude mcp add motorika -- node /abs/path/to/motorika-mcp/dist/index.js --headless
```

## Flags

Flags win over env vars, and env vars win over defaults.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--headless` | `MOTORIKA_HEADLESS=1` | headed | headless Chrome (new headless) |
| `--browser <chrome\|chrome-beta\|msedge\|chromium>` | `MOTORIKA_BROWSER` | chrome | Playwright channel |
| `--executable-path <path>` | `MOTORIKA_EXECUTABLE_PATH` | none | explicit browser binary (Chrome for Testing, Chromium) |
| `--profile-dir <dir>` | `MOTORIKA_PROFILE_DIR` | `~/.motorika/profile` | persistent profile; logins persist |
| `--isolated` | `MOTORIKA_ISOLATED=1` | off | fresh temp profile per process, deleted on exit |
| `--no-sandbox` | `MOTORIKA_NO_SANDBOX=1` | off | launch Chrome without its sandbox, for containers running as root; unsafe (see Safety) |
| `--cdp-endpoint <url>` | `MOTORIKA_CDP_ENDPOINT` | none | connect mode (`http(s)://host:port` or `ws(s)://…`) |
| `--auto-connect` | `MOTORIKA_AUTO_CONNECT=1` | off | attach to your running Chrome (see below) |
| `--chrome-user-data-dir <dir>` | `MOTORIKA_CHROME_USER_DATA_DIR` | OS default Chrome dir | where auto-connect reads `DevToolsActivePort` |
| `--viewport <WxH>` | `MOTORIKA_VIEWPORT` | 1280x800 | launch modes only |
| `--output-dir <dir>` | `MOTORIKA_OUTPUT_DIR` | `~/.motorika/output` | `screenshots/` and `downloads/` |
| `--allow-file-root <dir>` (repeatable) | `MOTORIKA_FILE_ROOTS` (`:`-separated) | see Security | adds upload roots to the defaults |
| `--allow-hidden-files` | `MOTORIKA_ALLOW_HIDDEN_FILES=1` | off | permit dot-files and dot-dirs as upload sources and `file:` pages |
| `--allow-chrome-urls` | `MOTORIKA_ALLOW_CHROME_URLS=1` | off | permit `chrome:`, `devtools:`, `chrome-extension:` and `about:` pages (other than `about:blank`/`about:srcdoc`) |
| `--blocked-origins <list>` (repeatable) | `MOTORIKA_BLOCKED_ORIGINS` | empty | never load these hosts or origins (comma-separated; see Safety) |
| `--allowed-origins <list>` (repeatable) | `MOTORIKA_ALLOWED_ORIGINS` | empty (= everything) | load only these hosts or origins |
| `--action-timeout <ms>` | `MOTORIKA_ACTION_TIMEOUT` | 10000 | default per-action timeout |
| `--navigation-timeout <ms>` | `MOTORIKA_NAVIGATION_TIMEOUT` | 30000 | default navigation timeout |
| `--max-output-chars <n>` | `MOTORIKA_MAX_OUTPUT_CHARS` | 20000 | hard ceiling on the whole text of any result (notices, prefixes, batch totals included); a cut ends with `… output cut at <n> chars` (a `batch` shares it per step instead, see "batch output" below) |

`MOTORIKA_LOG=debug|info|warn|error` sets the stderr log level. stdout carries JSON-RPC only.

## Modes

**Launch (default).**
- Chrome starts lazily, on the first tool call that needs a page. `initialize` and `tools/list` never
  start it.
- Chrome uses Playwright's pipe transport, so it opens no TCP debugging port.
- A persistent `--profile-dir` keeps cookies and logins across restarts.
- `--isolated` uses a fresh profile in `$TMPDIR/motorika-profile-*`, deleted on exit.

**One agent browser, shared by every session.** Several Claude sessions can run their own server process
on the same `--profile-dir`, and all of them use one Chrome with your logins.
- **Ownership:** the first server to need the browser owns it. It listens on a user-only unix socket at
  `~/.motorika/run/<first 12 hex of sha1(realpath(profile))>.sock`, with mode 0600 in a 0700 dir. It is
  never a TCP port. `~` is `os.homedir()`, so `HOME` moves it.
- **Joining:** every later server on that profile joins. It forwards each tool call over the socket, and
  the owner runs it on its browser under that session's own client id.
  - Each session has its own active tab and its own `tabs list`: the tabs it opened, plus popups those
    tabs spawned.
  - Tab ids and refs come from the owner's counters, so they never collide.
  - When a joined session exits, the owner closes its tabs.
- **Status:** `session status` adds `shared=owner` on the owner, or `shared=client(owner pid N)` for a
  joined session.
- **Mode changes:** a joined session cannot change the shared browser's mode. A `session launch` that
  would change it returns an error naming the owner's pid. A joined session's `session close` closes only
  its own tabs.
- **Takeover:** if the owner exits, a joined session's next call takes over. It launches Chrome on the
  profile and becomes the owner, and its result starts with a `notice:` line. Its old tabs are gone;
  cookies persist. Ref numbers and tab ids continue above the highest ones that session saw, and an old
  ref is refused as `from a previous browser session`.
- **Owner close:** when the owner runs `session close` (or relaunches), each joined session's next result
  starts with a notice that its tabs are gone.
- **Unresponsive owner:** a forwarded call answers by its own budget + 2 s even if the owner hangs.
- **Foreign lock:** if no server owns the profile but some Chrome holds it, such as an `open` window,
  page tools return an error naming that pid and asking you to close the window.
- **Isolated:** `--isolated` servers never share.
- **Same security settings:** a server joins only an owner with the same `--blocked-origins`,
  `--allowed-origins`, `--no-sandbox`, `--allow-chrome-urls`, `--allow-hidden-files` and
  `--allow-file-root` (compared after normalising order, case and paths). Otherwise every call returns an
  error naming each differing flag (`--no-sandbox (this server: off; owner: on)`), and no second Chrome
  starts. Start both servers with the same flags, or this one with `--isolated` or another `--profile-dir`.
  Once that owner exits, the next call takes over with this server's own settings.
  - The cwd and `--output-dir` are per session and not compared. A joined session's uploads and `file:`
    pages follow the owner's roots (the owner's cwd and output dir), not its own.

**Logging in by hand.** Google refuses sign-in in automation-controlled windows. So log in once with a
plain Chrome on the agent profile:

```sh
node dist/index.js open https://accounts.google.com            # default profile ~/.motorika/profile
node dist/index.js open --profile-dir ~/agent-profile [url]
```

- `open` starts Chrome with `--user-data-dir`, `--no-first-run` and `--no-default-browser-check`, plus
  the agent's cookie-encryption mode: `--use-mock-keychain` (macOS) or `--password-store=basic` (Linux).
  Without that, cookies saved in the login window would be encrypted with the real Keychain key and be
  unreadable to the agent (measured: the login cookie was on disk but never sent). There is no
  `--enable-automation` and no `--remote-debugging-*`.
- Chrome writes cookies to disk about every 30 s. Leave the window open half a minute after signing in,
  or quit Chrome normally (Cmd+Q).
- It exits when that Chrome exits; close the window when you are signed in.
- If a server currently owns the profile, `open` exits with code 2 and tells you to log in through that
  server's window instead (`session launch headless=false` makes it visible). It also exits 2 when another
  Chrome already uses the profile.
- `--headless` exists only for tests.

**First tab.** In launch modes the initial blank tab is `t1`. `navigate` without `tab` uses it, and the
first `tabs new` reuses it while it is still `about:blank` and has never navigated.

**Connect.** `--cdp-endpoint http://127.0.0.1:9222` (or a `ws://…/devtools/browser/<id>` URL) attaches to
a Chrome started with `--remote-debugging-port`.
- Its existing tabs get ids.
- On exit the server only disconnects; Chrome and its tabs stay open. This was verified: a
  CDP-connected `browser.close()` leaves Chrome running with its tab.

**Auto-connect.** `--auto-connect` attaches to your everyday Chrome (Chrome 144+). Setup:
1. In that Chrome, open `chrome://inspect/#remote-debugging` and turn on remote debugging.
2. Chrome writes `DevToolsActivePort` into its user-data dir. The server reads it (line 1 is the port,
   line 2 the browser path) and connects to `ws://127.0.0.1:<port><path>`. The `http` `/json/version`
   endpoint returns 404 in this mode, so it is not used.
3. Chrome shows a permission prompt on every connection. A reconnect, after a disconnect or a
   `session launch`, prompts again.

If the file is missing, the error tells you to enable the toggle. Use `--chrome-user-data-dir` when the
Chrome you want is not in the OS default dir:
- macOS: `~/Library/Application Support/Google/Chrome`
- Linux: `~/.config/google-chrome`
- Windows: `%LOCALAPPDATA%\Google\Chrome\User Data`

**Switching at runtime.** `session launch` restarts with new options (`headless`, `mode`,
`cdp_endpoint`, `isolated`). Tabs are not carried over; cookies persist in a persistent profile.
`session close` closes Chrome in launch mode and only disconnects in attach modes.

**Disconnects.** If Chrome crashes or you close its window, the next tool call relaunches (launch) or
reconnects (attach). Its result starts with a `notice:` line. Old tabs and refs are gone.

**Background tabs.**
- Launch modes, headless and headed, act on background tabs directly. This was verified headed: a
  background-tab click took 91 ms and requestAnimationFrame was not throttled. The active marker does not
  move.
- In attach modes, your Chrome may throttle background tabs, so the server brings the tab to the front
  before acting, and the client's active tab follows. Multi-tab work there effectively serializes. This
  path has not been measured against a real throttled Chrome.

**Exit.** On stdin end, SIGTERM, SIGINT or SIGHUP, launch modes close Chrome. If Chrome does not exit
within 3 s, the server kills the pid in the profile's `SingletonLock`, which is a Chrome this server
launched. Attach modes only disconnect.

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

### Video

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

## Safety

**Chrome's sandbox stays on.** Every Chrome the server launches (headed, headless, `--isolated`, persistent
profile) runs with Chrome's renderer sandbox. `--no-sandbox` (`MOTORIKA_NO_SANDBOX=1`) turns it off for
environments where it cannot start, such as Linux containers running as root. The cost: a page that
exploits a renderer bug then runs with your user's rights instead of a locked-down process, so use it only
where the container is the boundary. The server logs a `warn` line at startup when it is set. Connect and
auto-connect attach to a Chrome you started, so that Chrome keeps its own flags. With `--no-sandbox` the
server still warns at startup there, because a Chrome it launches later (`session launch mode=launch`)
runs without the sandbox, and it warns again at that launch.

The agent drives a real browser with no per-site permission prompts. Claude in Chrome asks before acting
on a new site; this server does not. Whatever the agent profile is logged into, a prompt-injected page can
try to make the agent use.

**Keep high-value accounts out of the agent profile.** Do not log the agent profile
(`~/.motorika/profile`) into your bank, your main email or admin consoles (cloud, domain, payments).
Use separate, low-privilege accounts for what the agent needs, and keep the rest in your everyday Chrome.
For extra certainty, block those sites outright:

```sh
node dist/index.js --blocked-origins bank.example,mail.google.com,*.console.aws.amazon.com
node dist/index.js --allowed-origins docs.example,https://staging.example   # only these load
```

**Origin lists.**
- An entry is a host, which also matches its subdomains (`bank.example`); a `*.` pattern, which matches
  subdomains only (`*.bank.example`); or a full origin (`https://mail.google.com`).
- Every http(s) request of every tab, popup, iframe (in or out of process), dedicated worker and service
  worker is refused inside Chrome before it is sent, when its origin is blocked or, with an allow-list, not
  allowed. ws(s) connections from pages are closed. A host's trailing dot (`localhost.`) is ignored.
- An IPv4 entry matches every spelling of that address: `127.1`, `2130706433`, `0x7f000001` and the
  IPv4-mapped IPv6 forms `[::ffff:127.0.0.1]` and `[::ffff:7f00:1]`. `[::1]` is another address than
  `127.0.0.1`, and IPv6 entries are not accepted, so a blocked `127.0.0.1` does not cover `[::1]`.
- **Below the interception (launch modes, only with a list).** Chrome's request interception does not see
  speculation-rules prefetch and prerender, WebSockets opened by dedicated, shared and service workers,
  or WebRTC. With a list, the server therefore also:
  - starts Chrome with `--host-resolver-rules`. Listed hosts and their subdomains resolve to nothing; with
    an allow-list, every unlisted host does. An IPv4 entry is covered with its mapped IPv6 spellings.
  - starts Chrome with `--webrtc-ip-handling-policy=disable_non_proxied_udp`, so WebRTC sends no UDP
    (STUN/TURN) unless through a proxy.
  - turns the profile's "Preload pages" setting off (`net.network_prediction_options: 2` in
    `<profile>/Default/Preferences`), so speculation rules fetch nothing. In a persistent profile this
    stays off afterwards, also in runs without a list. Turn it back on in Chrome's settings
    (search "Preload pages") in an `open` window.
  - Measured in `test/regress/core-r4c.test.ts` (Chrome 155, headless), with `--blocked-origins` and with
    `--allowed-origins`. The refused host's own logs show none of: speculation-rules prefetch, a prefetch
    whose redirect goes there, prerender, WebSockets from dedicated, shared and service workers, STUN/TURN
    UDP, and TURN over TCP. The same holds for an IPv4 entry and its mapped IPv6 spelling.
  - A full-origin entry in `--blocked-origins` (`https://mail.google.com`) blocks the whole host at this
    layer, every scheme and port. A request the interception would let through then fails as
    `net::ERR_NAME_NOT_RESOLVED`.
  - Without a list, Chrome starts with none of these switches and the profile is not touched.
- **Not blocked.** For strict isolation, use an OS firewall or a filtering proxy.
  - **Connect and auto-connect:** the attached Chrome keeps its own switches and settings, so only the
    interception applies. Speculation-rules prefetch and prerender, worker WebSockets and WebRTC can reach
    a listed host.
  - **Proxies:** with a proxy (system, PAC or `--proxy-server` on your Chrome), the proxy resolves host
    names, so the resolver layer does not apply to proxied requests. This was not measured.
  - **Both lists:** with both, a blocked host under an allowed one (`--allowed-origins example.com
    --blocked-origins mail.example.com`) gets only the interception, because Chrome applies the allow-list's
    exclusions before any mapping.
  - **Chrome's own traffic:** see below.
  - **DNS rebinding:** the lists are host-based: they match the host name in the URL, never the address
    it resolves to. A listed (allowed) name whose DNS answer is a blocked IP, or any name that resolves
    to `127.0.0.1` (a public name pointing at loopback, or one that switches to it after the first
    lookup), loads; a blocked IPv4 entry covers only URLs that spell that address.
- Redirects: every hop is checked before it is sent. A navigation whose redirect goes to a refused origin
  fails (`navigate`: `refused: it redirected to <url> (<reason>)`), and the tab reports
  `→ blocked <url> (<reason>)`; a popup that opens on one is closed with the same line on its opener.
- Cost: one browser-level DevTools session pauses only the requests a list could refuse and asks the server.
  With only a blocked list that is the requests to the listed hosts; everything else runs untouched, and the
  HTTP cache stays on. An allow-list pauses every http(s) request (any of them can be refused), which adds
  a round trip through the server to each request; the cache still works. Measured on a page with 50
  iframes, any list adds about 20% to `navigate` (Chrome's request interception itself; a cheaper Chrome
  mechanism does not see navigations or redirects).
- In connect and auto-connect, the interception applies to every window of the attached Chrome, incognito
  included (the layer below it does not; see "Not blocked").
- `navigate` and `tabs new` check first and return `blocked by --blocked-origins: <host>` (or
  `--allowed-origins`).

**What is protected by default.**
- **Upload sources** must resolve, by realpath, inside the allowed roots (cwd, `<output-dir>`,
  `~/Downloads`, `~/Desktop`, `~/Documents`, plus `--allow-file-root`).
- **Dot-files** (`.env`, `~/.ssh/…`) are refused unless `--allow-hidden-files`.
- **Local pages:** `file:` and `view-source:file:` URLs follow the same rule as uploads.
  - A click, redirect or history step that lands on a disallowed `file:` URL sends the tab to
    `about:blank` and reports `→ blocked <url> (<reason>)`.
  - A download from such a URL is cancelled.
  - A page opened by a page (popup, `window.open`, `target=_blank`) is checked before it becomes a tab;
    a refused one is closed and the opener's result reports `→ blocked <url> (<reason>)`.
  - `<output-dir>/downloads` is never a `file:` navigation target, because any web page can save a file
    there. It stays an upload source. Paths are compared canonically (symlinks resolved, on-disk case),
    so `DOWNLOADS/` on a case-insensitive disk is refused too.
- **Internal pages:** `chrome:`, `devtools:`, `chrome-extension:` and `about:` pages (except `about:blank`
  and `about:srcdoc`) are refused unless `--allow-chrome-urls`. For example, `chrome://version` shows the
  profile path and command line.
- **Passwords** typed into password fields never appear in a result (snapshot, read, console, evaluate,
  find, network, tabs, effect lines, errors), also not URL-, form- or JSON-encoded (`Hunter2%21x`), nor next
  to a percent-escape (`?q=%27<redacted>%27`). Secret-named URL parameters are redacted in the
  query and the fragment, camelCase names included (`accessToken`, `#access_token=`). Exactly what is and is
  not covered: [Security defaults](#security-defaults) below.
- **The page engine is untrusted:** a page can plant its own. Its roles, levels, types and ids print only
  in grammar form (an unknown role prints as `group`), and header URLs come from Chrome, not the page. Credential headers and password-like body fields are redacted in `network`.
- **Output cap:** every result is capped at `--max-output-chars`.
- **Debugging port:** launch modes open no TCP debugging port. The shared-browser socket is a 0600 unix
  socket in a 0700 dir.

**Chrome's own traffic.** Even with Playwright's switches (`--disable-background-networking`,
`--disable-component-update`, `--disable-sync`, …), an idle headless Google Chrome still connects to
Google:
- GCM on port 5228;
- update and component hosts;
- Google APIs on 443.

This was measured on Chrome 155 on 2026-10-21. Extra switches (`--no-pings`, more `--disable-features`)
did not change it. No page content is involved; it is the browser's own service traffic. If you need
none, run Chromium or Chrome for Testing through `--executable-path`, or block it with a host firewall.

**Claude Code permissions.** Two setups for `.claude/settings.json` (or `~/.claude/settings.json`):

(a) Fastest, with no prompts. Every tool, including clicks, typing, uploads and `evaluate`, runs without
asking:

```json
{ "permissions": { "allow": ["mcp__motorika"] } }
```

(b) Reads are free, and actions still ask each time:

```json
{
  "permissions": {
    "allow": [
      "mcp__motorika__snapshot",
      "mcp__motorika__screenshot",
      "mcp__motorika__read",
      "mcp__motorika__find",
      "mcp__motorika__console",
      "mcp__motorika__network"
    ]
  }
}
```

The server name in these keys is the one you gave `claude mcp add` (here `motorika`).

## Security defaults

- **Upload sources** must resolve, by realpath with symlinks followed, inside an allowed root.
  - The default roots are the process cwd, `<output-dir>`, `~/Downloads`, `~/Desktop` and
    `~/Documents`. `--allow-file-root` adds roots.
  - A dot-file or dot-dir is refused unless `--allow-hidden-files`. The check applies to the path
    relative to the root that contains it, both as given and after realpath, because the default output
    root itself lives under `~/.motorika`.
  - Each refusal names the flag that would widen it.
- **Written files** (screenshots, downloads) go only inside `<output-dir>`. Their names are sanitised: no
  separators, no `..`, no leading dot, at most 120 chars.
- **Password values** never appear in snapshot, find, fill_form, effect summaries or errors. A filled
  password field shows `value=<redacted>`. Typed text is never echoed. A value the server typed into a
  password field is remembered for the life of the process and printed as `<redacted>` in every result
  where a page echoes it: `read` text and links, console messages, `evaluate` results, snapshot text and
  values, `find`, `network`, `tabs`, effect lines, error messages and every printed URL.
  - **What is remembered:** literals of 6+ characters, at most the 64 most recent. A literal equal to a role
    word or a ref id (`button`, `e12345`) is not remembered, so the output grammar stays intact.
  - **Spellings covered:** the literal; percent-encoded, each character written raw or as the `%XX` escapes
    of its UTF-8 bytes (hex in either case), in any mix, as Chrome, `encodeURIComponent` or a form writes it
    (`O%27Brien!26`, `p@ss%20word`, `%48unter2xZ`); a space written `+` (a `+` and a space count as the same
    character); JSON-escaped, as a JSON string prints it (`Hu\"nt\\er2!`), an emoji as a surrogate-pair
    escape included (`Smile\ud83d\ude0042`, as Python's `json.dumps` writes it); and JSON-escaped and
    percent-encoded characters mixed, as a Chrome URL prints inside a JSON string (`Hu%22nt\\er2!`).
  - **Whole tokens only:** no letter or digit directly before or after it. A `%XX` escape next to it is an
    edge whatever it decodes to (`?q=%27<redacted>%27`, `%41<redacted>`), and so is a JSON escape
    (`\n<redacted>`) and another redaction: a secret that touches or overlaps a redacted one is redacted too,
    in any order of remembering (`%27Hunter2%C3%A9Zebra99!%27` prints `%27<redacted>%27`), and overlapping
    ones merge into one `<redacted>`. A secret glued to a letter or digit stays as it is, by design:
    `xHunter2xZ`, and also two secrets glued to each other with no edge between them (`Hunter2xZebra99!`).
  - **A redaction never splits an escape or a quoted string:** a match that starts or ends inside a `%XX`
    escape takes the whole escape (the secret `7Hunter2xZ` in `%27Hunter2xZ` prints `<redacted>`); a match
    that would start or end inside a JSON escape is left alone (`\nopass12` for the secret `nopass12`); and a
    `"` that opens or closes a JSON string reaching outside the redaction is kept, so a secret ending in `"`
    never ends a quoted name early.
  - **Not covered:** base64 or any other encoding, a changed case, a secret split across elements, double
    percent-encoding (`%2527`), a `"` or `\` escaped twice (a JSON string inside a JSON string), a page's
    non-UTF-8 charset (a GET form on a windows-1252 page prints `P%E4ssw%F6rd1`), and, for a secret that
    itself holds more than four `%XX`-like or backslash sequences or is longer than 128 characters, a mix of
    those sequences written raw and escaped (all raw or all escaped is covered).
- **Printed URLs** (headers, `→ url`, `→ navigated`, `→ new tab`, `→ blocked`, tabs, network, console
  locations, errors that name a URL, `href=`) are matched the same way on the raw URL, before the server
  percent-encodes it (without JSON escapes: a URL is raw text). A `<redacted>` in a printed URL is always the
  server's: the same text from a page prints as `%3Credacted%3E`. `href=` is the exception: it is page
  content inside a JSON string and is not percent-encoded, so a page's own `<redacted>` text can appear
  there. In printed URLs,
  query parameters whose name contains `pass`, `password`, `passwd`, `pwd`, `secret`, `token`,
  `api-key`/`api_key`/`apikey` or `auth` as a word part (separated by `_`, `.`, `-`, `[` or `]`, so
  `user[password]` too) show `<redacted>` values; `author` and `passengers` are left alone. A URL inside
  quoted page text ends at a backslash, so redaction never eats the `\` of an escaped quote. Where a remembered
  secret is redacted inside a URL in page text (a `read` link, a console message, an `evaluate` result), the same
  scrub also redacts that URL's secret-named parameters, the ones after the secret included
  (`?q=%27<redacted>%27&token=<redacted>`), and those of a URL glued right after it
  (`!<redacted>!http://b.test/?token=<redacted>`). Not seen by these rules: a secret-named parameter inside
  another parameter's value (`?next=http://b.test/?token=…`), a URL glued to a letter or digit (`xhttp://…`), and
  one after a quote, backslash or space that ends the URL in text (unless a redacted secret holding that character
  bridges it).
- **Network detail** redacts the values of `authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
  `x-api-key` and `x-auth-token`.
- **Untrusted content:** page-derived text is marked `(untrusted page content)` in snapshot, read, find,
  console, network and evaluate results.
- **Debugging port:** launch modes open no TCP debugging port.
- **evaluate** is enabled and annotated `destructiveHint`.
- **Network traffic:** no telemetry, and no network traffic besides the browser's own.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `profile … is in use by another Chrome (pid N) that is not a Motorika server` | A Chrome window holds `--profile-dir`, for example an `open` login window. Close it, or use `--isolated` or another `--profile-dir`. Servers on the same profile join each other instead of failing. |
| A result starts with `notice: the owner server (pid N) went away` | This session took over the shared browser. Its earlier tabs are gone; cookies persist. |
| `Chrome refused profile …: its lock names host "…"` | The profile's `SingletonLock` was left by a Chrome under an earlier hostname (this happens when the Mac's hostname follows DHCP). If no Chrome uses the profile, remove the three `Singleton*` files named in the hint and retry. |
| `tab tN crashed` | The tab's renderer crashed. Close it with `tabs close` (or ignore it) and open a new tab with `tabs new`. `tabs list` marks it ` crashed`. |
| `this server's security settings differ from those of server pid N` | Another server owns the shared browser on this `--profile-dir` with other security flags (named in the error). Start both with the same flags, or this one with `--isolated` or another `--profile-dir`. |
| `eN is from a previous browser session` | This server took over the shared browser after its owner exited. Refs and tab ids continue above the old numbers; take a new snapshot. |
| `open` exits with code 2 | A server or another Chrome already uses the profile. Log in through that window, or stop the server first. |
| `could not launch chrome` | Chrome is not installed for the `--browser` channel. Install it, or pass `--executable-path`. Check with `npm run smoke:chrome`. |
| `auto-connect found no …/DevToolsActivePort` | Enable `chrome://inspect/#remote-debugging` in the Chrome you want, or point `--chrome-user-data-dir` at its user-data dir. |
| Auto-connect hangs, then errors | Chrome is waiting on its permission prompt. Accept it in the Chrome window. |
| `… is stale (element removed); take a new snapshot` | The element was re-rendered and its role and name are not unique, or the ref is older than the last 10,000 retired refs (the reason is no longer kept). Take a new snapshot. `wait state=detached\|hidden` on it succeeds. |
| `eN is not a known ref` | This server never issued `eN`. Take a snapshot (or `find`) for current refs. |
| `… is from an earlier document` | The tab navigated since the ref was issued. Take a new snapshot. |
| `… is covered by "<div …>" (it intercepts pointer events)` | An overlay sits on top of the target. Wait for it to go (`wait target=… state=hidden`), close it, or pass `force:true`. |
| `the page's script engine failed (<operation>)` | The page broke the in-page engine for its own frame (for example it replaced `window.eval` or a builtin). The page's own message is never shown. Other tabs and frames are not affected; snapshot, click and the rest fail on that frame only. |
| `page exception: "<message>"` (evaluate) | Your script threw; the message is the page's, JSON-quoted. |
| `error: "<message>"` | An error no tool explained; its text is JSON-quoted, because it may be page text. |
| `navigation to … failed: net::ERR_…` | A network failure (DNS, TLS, refused). The tool returns only after Chrome has shown its error page, so the next `navigate` on that tab is not interrupted by it. A scheme-less URL gets `https://`, so a plain-HTTP local server needs an explicit `http://`. |
| `navigation to … timed out after …ms before it committed …; stopped` | The server did not answer in time, and the navigation was stopped: the tab still shows the URL named. Retrying requests the page again. A page that did answer but kept loading is not this error: it is `navigated …` with `(still loading: …)`. |
| `tab tN crashed` | The page's renderer crashed. `find` and `screenshot` say so instead of returning nothing or hanging. Close the tab with `tabs close`, or open a new one with `tabs new`. |
| `frame=fN unavailable` on an iframe line; `not searched: … unavailable` in find; `… frames unavailable (no answer within 500 ms): fN` in a wait timeout | That frame did not answer within 500 ms. It is never counted as empty. A busy page: retry when it is idle. An offscreen `loading=lazy` iframe: `scroll` it into view first. An iframe whose src never responds, or `about:blank#frag`, never answers, and it keeps `wait text_gone` from succeeding: wait for something in the frames that answer instead. |
| `dialog pending …` on every call | Handle it with `dialog accept` or `dialog dismiss` on that tab. |
| `upload refused …` | The path is outside the roots or hidden. Copy the file into an allowed root, or start with `--allow-file-root` / `--allow-hidden-files`. |
| A tool result starts with `notice:` | The browser was closed or disconnected and has been relaunched or reconnected. Old tabs and refs are gone. |
| Garbled protocol in the client | Something wrote to stdout. The server logs only to stderr; check wrappers around `node dist/index.js`. |

The full log is on stderr. Set `MOTORIKA_LOG=debug` for more.

## Development

- `src/tools/<name>.ts` holds one tool per file. Adding a tool means writing that file and adding one line
  in `src/tools/index.ts`. Batch dispatches through the same registry.
- `src/page/injected/` is the in-page engine, bundled into one IIFE. It is installed via CDP evaluate, so
  it is CSP and Trusted Types safe. It never uses `eval`, `Function` or `innerHTML`.
- Tests:
  - `test/unit/` covers pure logic.
  - `test/smoke/` runs the built server end to end, headless and `--isolated`, with a private
    `TMPDIR`. It asserts that no Chrome survives.
  - `test/acceptance/` holds the independent acceptance suite.

## License

MIT, see `LICENSE`. Copyright (c) 2026 X2 Mobile.
