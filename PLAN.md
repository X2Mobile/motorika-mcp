# x2-browser-mcp: plan and contract

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

Status: acceptance criteria proposed by Claude on 2026-10-21 and shown to the owner. The build started in
parallel, because every default below is a flag flip. Amendments go in the block at the end, never inline.

## Goal

An MCP server (stdio) that gives an AI agent fast, reliable, full control of Chrome:
- multiple tabs;
- forms, clicks and submits;
- keyboard, scrolling, drag and navigation;
- uploads, downloads and JS dialogs;
- watching videos (frames, captions, playback control);
- JS evaluation, console and network inspection.

It runs headed or headless, on a dedicated persistent profile or attached to an already-running Chrome.

"Fast" means three measurable things:
1. **Low per-action latency:** auto-wait instead of sleeps, and a bounded settle.
2. **Small outputs:** a compact snapshot grammar, and actions return an effect summary, not a page dump.
3. **Fewer model round trips:** `batch`, `fill_form`, refs that locate their own tab, and an automatic
   snapshot after navigation.

## Non-goals (v1)

- Bot-detection evasion, stealth, fingerprint spoofing or CAPTCHA solving.
- Firefox or WebKit. Only the Chrome family is supported: Chrome, Edge, Chromium, Chrome for Testing.
- npm publishing, an HTTP/SSE transport, a hosted service.
- Audio capture or transcription.

## Must not change

- The user's real Chrome profile. Launch modes always pass their own `--user-data-dir` and never use
  Chrome's default data directory. Chrome 136+ ignores debugging switches there anyway. Attach modes
  connect only when explicitly configured.
- The user's Claude Code config (`~/.claude.json`, settings). No `claude mcp add` without asking.
- No git remote, push or npm publish.

## Stack (pinned in package.json)

- **Runtime:** Node ≥ 20 (the dev machine runs 24.21); TypeScript 6.0.3 in strict mode; ESM.
- **Libraries:** `@modelcontextprotocol/sdk` 1.32.1, `playwright-core` 1.64.1 and zod 4.6.7.
  - `playwright-core` downloads no browser. It uses `channel: 'chrome'`, the installed Google Chrome
    155, verified by `npm run smoke:chrome`.
  - `--executable-path` is the fallback for Chrome for Testing or Chromium.
- **Tests:** `node:test` through tsx, with `--test-concurrency=2`, run by `npm test`.
- **Injected page code:** TypeScript, bundled by esbuild into one IIFE string at build time. `npm run build`
  must produce `dist/index.js`, the executable entry with a shebang.
- **Logging:** stdout carries JSON-RPC only. All logs go to stderr. A stray stdout write corrupts the
  protocol. There is no `console.log` in `src/`: use a stderr logger with levels (`X2B_LOG=debug`).

## Architecture

```
src/index.ts            CLI entry: flags/env -> config -> McpServer on StdioServerTransport
src/config.ts           flag + env parsing, defaults, validation (zod)
src/browser/session.ts  launch / connect / auto-connect, lazy start, relaunch on disconnect, exit cleanup
src/browser/tabs.ts     tab registry: ids, active tab, popups, per-tab queue, per-tab buffers and state
src/browser/refs.ts     global ref allocation + ref -> (tab, frame) ownership
src/page/engine.ts      server side of the injected engine: install (CSP-safe), call, frames stitching
src/page/injected/      in-page code (snapshot, accname, visibility, find, read, annotate, quiet, video)
src/page/target.ts      target string -> ref handle | locator | point
src/page/effects.ts     action wrapper: settle + effect summary
src/tools/<name>.ts     one file per tool: { name, description, inputSchema, annotations, handler }
src/tools/index.ts      the registry (batch dispatches through it)
src/util/paths.ts       file-root confinement, filename sanitising
src/util/format.ts      output formatting, truncation, redaction
```

### Injected-code rules (CSP and Trusted Types safe)

- Install by `frame.evaluate(<IIFE string>)`. That goes through CDP and is not subject to the page's CSP.
- Store the engine under `window[Symbol.for('x2b.engine')]`. Call it with `frame.evaluate(fn, args)`.
- If the engine is missing (a new document), install it and retry within the same tool call.
- Never call `eval`/`Function` inside page code. Never assign `innerHTML` or `outerHTML`. Build overlays
  with DOM APIs only.
- Cache native functions at install time. Pages sometimes monkey-patch prototypes.

## Modes and configuration

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--headless` | `X2B_HEADLESS=1` | headed | headless Chrome (new headless) |
| `--browser <chrome\|chrome-beta\|msedge\|chromium>` | `X2B_BROWSER` | chrome | Playwright channel |
| `--executable-path <path>` | `X2B_EXECUTABLE_PATH` | none | explicit browser binary |
| `--profile-dir <dir>` | `X2B_PROFILE_DIR` | `~/.x2-browser/profile` | persistent profile; logins persist |
| `--isolated` | `X2B_ISOLATED=1` | off | fresh temp profile per process, deleted on exit |
| `--cdp-endpoint <url>` | `X2B_CDP_ENDPOINT` | none | connect mode (`http(s)://host:port` or `ws(s)://…`) |
| `--auto-connect` | `X2B_AUTO_CONNECT=1` | off | attach to the user's running Chrome (see below) |
| `--chrome-user-data-dir <dir>` | `X2B_CHROME_USER_DATA_DIR` | OS default Chrome dir | where auto-connect reads `DevToolsActivePort` |
| `--viewport <WxH>` | `X2B_VIEWPORT` | 1280x800 | launch modes only; attach modes keep the window size |
| `--output-dir <dir>` | `X2B_OUTPUT_DIR` | `~/.x2-browser/output` | screenshots, frames, downloads |
| `--allow-file-root <dir>` (repeatable) | `X2B_FILE_ROOTS` (`:`-separated) | see Security | upload sources |
| `--allow-hidden-files` | `X2B_ALLOW_HIDDEN_FILES=1` | off | permit dot-files/dirs as upload sources |
| `--action-timeout <ms>` | `X2B_ACTION_TIMEOUT` | 10000 | default per-action timeout |
| `--navigation-timeout <ms>` | `X2B_NAVIGATION_TIMEOUT` | 30000 | default navigation timeout |
| `--max-output-chars <n>` | `X2B_MAX_OUTPUT_CHARS` | 20000 | cap for any text result |

**Auto-connect** needs Chrome 144+ with remote debugging enabled at `chrome://inspect/#remote-debugging`.
It works like this:
- Read `<chrome-user-data-dir>/DevToolsActivePort`. Line 1 is the port, line 2 the path
  `/devtools/browser/<id>`.
- Connect to `ws://127.0.0.1:<port><path>` with `connectOverCDP`. Use the ws:// URL, not http://: in this
  mode `/json/version` returns 404.
- Chrome shows a permission dialog on every connection, so a reconnect prompts again. Document this.
- If the file is missing, the error says how to enable the toggle.

The default Chrome user-data dirs:
- macOS: `~/Library/Application Support/Google/Chrome`
- Linux: `~/.config/google-chrome`
- Windows: `%LOCALAPPDATA%\Google\Chrome\User Data`

**Lifecycle**
- **Lazy:** the browser starts on the first tool call that needs it. Server start and `tools/list` never
  launch Chrome.
- **Launch modes** use Playwright's pipe transport, so Chrome opens no TCP debugging port. A persistent
  profile uses `launchPersistentContext`. `--isolated` uses `launch` + `newContext`.
- **Temp locations:** every temporary profile goes under `os.tmpdir()`, which respects `TMPDIR`. That
  covers `--isolated` and the profile-lock fallback. The prefix is `x2b-profile-`, and the profile is
  deleted on exit. Tests rely on this: they set `TMPDIR` to find and clean their Chrome processes.
- **Output layout:** `<output-dir>/screenshots/`, `<output-dir>/frames/` and `<output-dir>/downloads/`.
  The dirs are created on demand.
- **Profile lock:** another live Chrome may already own the profile dir (a second server process). Then
  fall back to an isolated temp profile and say so at the top of the first tool result.
- **Disconnect** (a crash, or the user closed the window): the next tool call relaunches (launch) or
  reconnects (attach). Its result starts with a one-line notice and it never hangs.
- **Exit** (stdin closes, SIGTERM or SIGINT): launch modes close Chrome and leave no orphans; attach modes
  only disconnect, so the user's Chrome and its tabs survive. Verify that a connected browser survives;
  don't assume `browser.close()` is harmless.
- **Background tabs:** actions on a background tab must work in headed launch mode. If Playwright's
  stability check stalls there (rAF throttling), call `bringToFront()` before acting. Document that
  multi-tab work then serializes in headed and attach modes, and make the active marker reflect reality.

## Tool contract

All tools return text content only (no `structuredContent`). Images are MCP image content. An error
result has `isError: true`, a one-line cause, and a hint for the next step.

**Common parameters**
- `tab?: string` is a tab id such as `"t3"`. The default is the active tab.
- `timeout_ms?: number` defaults to the configured action or navigation timeout.

**Targets** (`target`, `from`, `to`, `scope`) are strings of one of three kinds:
- **`e<digits>`:** a ref from `snapshot`, `find`, `video list` or a strict-mode error listing. A ref
  locates its own tab and frame, so `tab` is optional. If `tab` is given and doesn't match, that's an
  error.
- **`<x>,<y>`** (two numbers): a point in the pixel space of the tab's last viewport screenshot, mapped
  back to CSS px server-side. With no screenshot yet, it's CSS px of the viewport. If the last
  screenshot was full-page, the point is a page coordinate and is scrolled into view first.
- **Anything else** is a Playwright selector: `text=Sign in`, `role=button[name="Save"]`, `#email`,
  `css=…`, `xpath=…`. Matching is strict: if more than one element matches, the error lists up to 5
  matches as snapshot lines with refs.

**Output conventions**
- Every result about a page starts with `[tN]`.
- Events that happen between tool calls are reported at the top of the next result for that tab: late
  downloads, popups, dialogs, crashes.
- Page-derived text is untrusted data. Snapshot and read headers say so. This covers snapshot, read,
  find, console, network, evaluate results and dialog messages.

### The tools

1. **`session`** `{ action: 'status'|'launch'|'close', headless?, mode?: 'launch'|'connect'|'auto_connect', cdp_endpoint?, isolated? }`
   - `status` returns, for example,
     `mode=launch headless=false browser=Chrome/155.0.8059.85 profile=~/.x2-browser/profile tabs=3 active=t2`.
   - `launch` restarts with the given options and closes or disconnects the current browser. Omitted
     options keep the configured defaults. The result says that tabs were not carried over (cookies persist
     in a persistent profile).
   - `close` closes the browser (launch) or disconnects (attach).
2. **`tabs`** `{ action: 'list'|'new'|'select'|'close', tab?, url?, background?: boolean }`
   - `list` returns one line per tab: `t1 "Title" https://url (active)`. A pending dialog is shown as
     ` dialog=confirm`.
   - `new` opens a tab, optionally at `url`, and it becomes active unless `background: true`. When `url`
     is given, it also returns the snapshot, as `navigate` does (a viewport snapshot, amended by
     [Decisions from the bench](#decisions-from-the-bench-2026-10-23)).
   - `select` makes a tab active. In headed mode it brings the tab to the front.
   - `close` closes a tab, the active one by default. The previously active remaining tab becomes active.
   - Tab ids are never reused within a server process.
   - Tabs opened by a page (`target=_blank`, `window.open`) are registered automatically, reported by the
     action that opened them, and become active.
   - In attach modes, tabs that already existed get ids too.
3. **`navigate`** `{ url?, action?: 'goto'|'back'|'forward'|'reload', tab?, wait_until?: 'commit'|'domcontentloaded'|'load'|'networkidle', snapshot?: boolean, timeout_ms? }`
   - A `url` without a scheme gets `https://`.
   - `wait_until` defaults to `domcontentloaded`, and then the settle runs.
   - The output is `[t1] navigated <url> "<title>" (<status>)`, followed by the snapshot unless
     `snapshot: false` (by default a viewport snapshot; `snapshot: true` the whole page; amended by
     [Decisions from the bench](#decisions-from-the-bench-2026-10-23)).
   - An HTTP error status is reported, not an error.
   - A network failure (DNS, refused, timeout) returns `isError` with the `net::ERR_…` code.
4. **`snapshot`** `{ tab?, scope?: target, mode?: 'interactive'|'full', viewport_only?: boolean, offset?: number, max_chars?: number }`
   returns the [grammar](#snapshot-grammar) below. `offset` is a line offset for paging.
5. **`screenshot`** `{ tab?, target?, full_page?: boolean, annotate?: boolean, format?: 'jpeg'|'png', quality?: number, max_edge?: number, save?: boolean }`
   - Defaults: jpeg, quality 70, `max_edge` 1280 (the long edge of the output image).
   - The output is the image plus `[t1] screenshot <w>x<h> scale=<image px per CSS px>; x,y targets use this image's pixels`.
   - `annotate` draws each visible ref's label on its element box. The labels are gone before the tool
     returns, so afterwards the DOM has no overlay nodes.
   - `save` writes the file under `<output-dir>/screenshots/` and prints its path.
6. **`read`** `{ tab?, target?, format?: 'markdown'|'text', offset?: number, max_chars?: number }`
   - Returns the main content in markdown:
     - title;
     - headings;
     - paragraphs;
     - lists;
     - links as `[text](url)`;
     - simple tables.
   - Excludes boilerplate: nav, footer, cookie banners, sidebars and ads.
   - Pages long content with a character `offset`.
7. **`find`** `{ tab?, query: string, role?: string, limit?: number }`
   - `limit` defaults to 10.
   - Matching is a case-insensitive substring over:
     - accessible name;
     - visible text;
     - placeholder;
     - label;
     - value.
   - Exact matches come first. Searches all frames.
   - Each hit is a snapshot-grammar line with its ref, followed by `  in <nearest heading or landmark line>`.
8. **`click`** `{ target, tab?, button?: 'left'|'right'|'middle', count?: 1|2|3, modifiers?: ('Alt'|'Control'|'Meta'|'Shift')[], force?: boolean, snapshot?: boolean, timeout_ms? }`
9. **`type`** `{ target, text, tab?, append?: boolean, slowly?: boolean, submit?: boolean, snapshot?, timeout_ms? }`
   - By default the value is replaced. `append` adds to it instead.
   - `slowly` sends key-by-key events, for autocomplete widgets.
   - `submit` presses Enter after typing.
10. **`fill_form`** `{ fields: { target: string, value: string|boolean|string[] }[], submit?: string, tab?, snapshot?, timeout_ms? }`
    - Values by element kind:
      - **Text-like** (text/email/password/search/tel/url/number inputs, textarea, contenteditable): the
        value is replaced.
      - **`select`:** option(s) matched by value or visible label. A `string[]` selects several in a
        multiple select.
      - **Checkbox, switch:** a boolean.
      - **Radio:** `true` selects it. Targeting a radio group with a string value picks the option by
        label or value.
      - **`input[type=file]`:** path(s), confined (see [Security](#security)).
      - **date, time, datetime-local, month, week, color, range:** the string value is set and
        `input`/`change` events are fired.
    - Every field is attempted, and the result has one line per field: `ok e4 textbox "Email"` or
      `failed e9 combobox "Country": no option "Narnia" (options: "Austria", "Belgium", … +240)`.
    - `submit` (a target) is clicked only if every field succeeded.
    - The result never echoes a password value.
11. **`press`** `{ keys: string[], target?, tab?, snapshot? }`
    - Each entry is a key or a chord: `"Enter"`, `"Tab"`, `"Control+a"`, `"Meta+Shift+K"`, `"ArrowDown"`.
    - `target` is focused first.
12. **`hover`** `{ target, tab? }`
13. **`scroll`** `{ tab?, target?, direction?: 'up'|'down'|'left'|'right', amount?: number, to?: 'top'|'bottom' }`
    - Without `direction`/`to`, `target` is scrolled into view. With them, `target` is the scroll
      container.
    - `amount` is in px and defaults to 80% of the viewport (or container).
    - The output is `[t1] scrolled y=<y>/<scrollHeight> viewport=<h>`. When the page height changed (an
      infinite scroll), it adds ` height <old> -> <new>`.
14. **`drag`** `{ from: target, to: target, tab? }` handles both HTML5 drag-and-drop and pointer-event drags.
15. **`upload`** `{ target, paths: string[], tab? }`. The target is either an `input[type=file]` (its files
    are set directly) or an element that opens a file chooser. The chooser is intercepted, so no native
    OS dialog ever appears.
16. **`dialog`** `{ action: 'accept'|'dismiss', text?: string, tab? }` handles the pending dialog. `text`
    is the answer to a prompt.
17. **`wait`** `{ tab?, text?, text_gone?, target?, state?: 'visible'|'hidden'|'attached'|'detached', url?, load_state?: 'domcontentloaded'|'load'|'networkidle', ms?: number, timeout_ms? }`
    - Exactly one condition is allowed.
    - `url` is a substring, or a `/regex/`.
    - `ms` is an unconditional wait of at most 30000.
    - On timeout, `isError` names the condition.
18. **`evaluate`** `{ script: string, target?, tab? }`
    - `script` is an expression or a function source. If it evaluates to a function, that function is
      called with the target element, or with no argument.
    - The result is JSON, truncated. A DOM element in the result is rendered as its snapshot line.
    - A page exception returns `isError` with the message.
19. **`video`** `{ action: 'list'|'play'|'pause'|'seek'|'set'|'frames'|'captions', target?, tab?, time?, rate?, muted?, volume?, loop?, times?: number[], count?: number, start?, end?, every_ms?, duration_ms?, max_edge?, format? }`
    - **Default video:** the largest visible playing video in any frame, else the largest visible video.
    - **`list`**, one line per video: ref, frame, src (truncated), duration, currentTime, paused, muted,
      volume, rate, `<w>x<h>`, readyState, text tracks.
    - **`frames`** has three ways to pick frames:
      - `times`: seek to each time and capture.
      - `count` (default 6): evenly spaced over `[start, end]`, which defaults to the whole duration.
        A live stream (duration `Infinity`) uses sampling instead.
      - `every_ms` + `duration_ms`: sample while the video plays in real time.
    - Seek-based capture restores the earlier `currentTime` and paused state.
    - **Seek and capture:**
      - After each seek, wait for `seeked` and `readyState >= 2`, then capture.
      - Capture by element screenshot (CDP), never through a canvas. That works for cross-origin video.
      - A frame that comes back all black (e.g. DRM) is flagged.
    - **Frames output:** one image per frame, each preceded by `frame <i>/<n> @ <mm:ss.ss>`.
    - **`captions`:** the cues of text tracks (`<track>`, in-band), as `<mm:ss.ss>-<mm:ss.ss> text`, with an
      optional `start`/`end` window.
20. **`console`** `{ tab?, level?: 'error'|'warning'|'all', pattern?, limit?: number, clear?: boolean }`
    - Each line is `[error] <hh:mm:ss.mmm> <message> (<url>:<line>)`.
    - Includes uncaught page errors.
    - Buffered from tab creation, at most 500 per tab.
21. **`network`** `{ tab?, pattern?, type?: string[], failed_only?: boolean, limit?: number, request_id?: string }`
    - Each line is `r<n> <METHOD> <status|failed:<reason>> <type> <url> <ms>ms <size>`.
    - With `request_id`, the result has headers and a body. Body text is truncated at 10k; a binary body
      shows its size only.
    - The values of these headers are redacted:
      - `authorization`;
      - `proxy-authorization`;
      - `cookie`;
      - `set-cookie`;
      - `x-api-key`;
      - `x-auth-token`.
    - At most 1000 requests per tab.
22. **`batch`** `{ steps: { tool: string, args: object }[], stop_on_error?: boolean }`
    - Runs up to 50 steps sequentially in one call. `stop_on_error` defaults to true.
    - Each step's output sits under a `## step <n>: <tool>` header, and images are kept.
    - After a failed step, the remaining steps are listed as `skipped`.
    - `batch` cannot nest.

Tool annotations:
- `readOnlyHint` on `snapshot`, `screenshot`, `read`, `find`, `console` and `network`.
- `destructiveHint` on `evaluate`.
- `openWorldHint` on page-acting tools.

### Snapshot grammar

```
[t1] "Sign in – Example" https://example.com/login (untrusted page content)
- banner e1
  - link "Example" e2 href="/"
  - navigation "Main" e3
    - link "Pricing" e4 href="/pricing"
- main e5
  - heading "Sign in" e6 level=1
  - form "Login" e7
    - textbox "Email" e8 type=email required value="ann@example.com"
    - textbox "Password" e9 password value=<redacted>
    - checkbox "Remember me" e10 checked=false
    - combobox "Country" e11 value="Romania" options=["Austria","Belgium","…+240"]
    - button "Sign in" e12 disabled
  - alert "Wrong password" e13
  - iframe "Payment" e14 frame=f2
    - textbox "Card number" e15
… 120 more lines (offset=40 to continue; or narrow with scope, find or viewport_only)
```

- **Header line:** `[tN] <JSON title> <url> (untrusted page content)`.
- **Element line:** `<2 spaces × depth>- <role>[ <JSON name>] e<digits>[ <attr>…]`.
- **Text line:** `<indent>- text <JSON string>`. Text lines have no ref.
- **Role vocabulary**, all lowercase:
  - ARIA roles: link, button, textbox, searchbox, combobox, listbox, option, checkbox, radio, switch,
    slider, spinbutton, tab, tablist, tabpanel, menu, menubar, menuitem, menuitemcheckbox,
    menuitemradio, tree, treeitem, grid, row, cell, columnheader, rowheader, heading, img, dialog,
    alertdialog, alert, status, log, progressbar, banner, navigation, main, complementary,
    contentinfo, search, form, region, list, listitem, table, figure, article, group, toolbar.
  - Non-ARIA:
    - `text`;
    - `iframe`;
    - `video`;
    - `audio`;
    - `canvas`;
    - `file` (`input[type=file]`);
    - `clickable` (a non-semantic element that is clickable by `cursor:pointer`, `onclick` or
      `tabindex>=0`, with no interactive ancestor).
- **Name:** a JSON string literal, truncated at 100 chars with `…`. It is omitted when empty.
- **Refs:** every element line has exactly one ref.
- **Attributes**, in this fixed order:
  1. `level=N`
  2. `type=<input type other than text/password>`
  3. `password`
  4. `checked=true|false|mixed`
  5. `selected`
  6. `pressed=true|false|mixed`
  7. `expanded=true|false`
  8. `disabled`
  9. `readonly`
  10. `required`
  11. `invalid`
  12. `focused`
  13. `value=<JSON, truncated at 100>`. A password is shown as `value=<redacted>`, and only when it is
      non-empty.
  14. `options=<JSON array of at most 10 labels, then "…+N">`
  15. `href=<JSON; same-origin shown as path>`
  16. `frame=fN`
- **`interactive` mode** (the default) contains:
  - interactive elements;
  - headings;
  - landmarks (`form` and `region` only when named);
  - dialogs;
  - alert/status/log, with their text as the name;
  - iframes;
  - video/audio.
  Wrapper and generic elements are flattened. A container with nothing included under it is omitted.
- **`full` mode** adds:
  - text lines (visible text merged per block, at most 200 chars each);
  - `img` with alt;
  - list and listitem;
  - table, row and cell;
  - article, figure and group.
- **Hidden elements are excluded:**
  - not rendered: `checkVisibility()` is false;
  - `aria-hidden="true"` subtrees;
  - `inert` subtrees;
  - zero-size elements.

  The exception is a visually hidden focusable input with a visible associated label, such as a custom
  checkbox: it is included.
- Offscreen elements are included unless `viewport_only`. The snapshot attached automatically to a new
  document is viewport-only, with its own footer (amended by [Decisions from the bench](#decisions-from-the-bench-2026-10-23)).
- **Frames:** iframes in any frame, including cross-origin ones (OOPIF), are inlined under their
  `iframe … frame=fN` line. An iframe smaller than 2×2 px or hidden is skipped.
- Open shadow roots are traversed. Closed shadow roots are a documented limitation.
- **Truncation:** at `max_chars` (default = `--max-output-chars`), cut at a line boundary, then add the
  footer line `… <n> more lines (offset=<m> to continue; or narrow with scope, find or viewport_only)`.
  Paging by `offset` has no gaps and no overlaps.

### Refs

- An element keeps the same ref for its lifetime. Snapshots, finds and actions all reuse it.
- Ref numbers come from one counter per server process, shared across all tabs and frames, and are never
  reused. So a ref identifies exactly one element in one tab, and the server knows its tab and frame.
- **Stale ref** (the element was removed):
  - The action proceeds on a replacement only when all of these hold:
    - The replacement is in the same document (no navigation since the ref was issued).
    - It has the same role and name.
    - That role+name was unique on the page when the ref was issued.
    - It is unique now.

    The result then says `(re-resolved e12 -> e57 button "Save")`.
  - Otherwise the result is `isError: e12 is stale (element removed); take a new snapshot`. Never guess.
- A ref from an earlier document of the tab, or from a closed tab, returns `isError` with that reason.

### Effect summary (click, type, fill_form, press, hover, scroll, drag, upload, dialog, navigate back/forward/reload)

```
[t1] clicked e12 button "Sign in"
→ navigated https://app.example.com/home "Home" (200)
→ new tab t3 https://docs.example.com/
→ dialog pending confirm "Leave page?" (use dialog accept|dismiss)
→ download /Users/x/.x2-browser/output/downloads/report.pdf (52.1 KB)
→ alert "Invalid password"
→ console 2 new errors: TypeError: x is undefined
```

- A line appears only when that effect happened.
- The line forms are fixed (`→ ` is U+2192 followed by a space):
  - `→ navigated <url> <JSON title> (<status>)`
  - `→ url <url>` (a same-document change: pushState or hash)
  - `→ new tab <tN> <url>`
  - `→ tab closed <tN>`
  - `→ dialog pending <alert|confirm|prompt|beforeunload> <JSON message> (use dialog accept|dismiss)`
  - `→ dialog accepted <type> <JSON message>`
  - `→ download <absolute path> (<size>)`
  - `→ alert <JSON text>` (new or changed text in role=alert/status or in aria-live regions)
  - `→ console <n> new error(s): <first message>`
- When a snapshot is attached, it follows after one blank line. It is attached:
  - for `snapshot: true`;
  - by default, when the action navigated to a new document (unless `snapshot: false`). This automatic
    snapshot is viewport-only and capped at 6,000 chars (amended by [Decisions from the bench](#decisions-from-the-bench-2026-10-23)).

**Settle**, after the action and before the summary, in this order (hitting a cap is never an error):
1. If a main-frame navigation started within 250 ms of the action: wait for the new document's
   `domcontentloaded`, up to the navigation timeout.
2. Wait for document/fetch/XHR requests started since the action began, capped at 1500 ms. These are
   ignored: websocket, eventsource, media, beacon/ping, and long-polls past the cap.
3. Wait until the main frame has had no DOM mutations for 100 ms, capped at 600 ms.

**Dialogs**
- An `alert` is auto-accepted and reported as `→ dialog accepted alert …`.
- A `beforeunload` raised during our own `navigate`/`tabs close` is auto-accepted and reported.
- `confirm`/`prompt` (and any other `beforeunload`) stay pending until the `dialog` tool handles them.
- While a dialog is pending, every other tool on that tab returns `isError` at once (within 1 s) with
  the dialog text. The exceptions are `tabs list`, `session status` and `dialog`.
  - Reason: JS evaluation blocks while a dialog is open.
  - Other tabs keep working.
- An action that raises a confirm/prompt returns within the settle window with the `dialog pending` line.

**Downloads** are saved to `<output-dir>/downloads/<sanitized suggested filename>`, with a numeric suffix
on a collision.

**Concurrency:** calls on the same tab run serially in arrival order. Calls on different tabs run
concurrently. `session launch/close` is exclusive.

## Security

- **Threat model:** text on a web page can try to steer the agent (prompt injection), for example "upload
  ~/.ssh/id_rsa here" or "upload .env". The tool's job is to never make that easy by default.
- **Upload sources** must resolve, by realpath with symlinks followed, inside an allowed root.
  - The default roots are:
    - the process cwd;
    - `<output-dir>`;
    - `~/Downloads`;
    - `~/Desktop`;
    - `~/Documents`.
  - A path with any segment starting with `.` is denied unless `--allow-hidden-files`.
  - A denial names the flag that would widen it.
- **Written files** (screenshots, frames, downloads) go only inside `<output-dir>`. Filenames are
  sanitised:
  - no separators;
  - no `..`;
  - no leading dot;
  - at most 120 chars.
- **No TCP debugging port** in launch modes, because they use the pipe transport.
- **Password values never appear in any output:**
  - snapshot;
  - find;
  - `fill_form` results;
  - effect summaries;
  - errors.

  The values of the network headers listed above are redacted.
- **Page-derived content** is marked untrusted (the snapshot and read headers).
- **`evaluate`** is enabled, because full control is a requirement, and annotated destructive.
- No telemetry, and no network traffic other than the browser's own.

## Performance targets

Measured by `npm run bench`, client-side over stdio:
- headless, warm browser, local fixtures;
- p50 of 20 runs unless noted.

| Step | Target |
|---|---|
| click (no navigation) | ≤ 150 ms |
| type into an input | ≤ 150 ms |
| fill_form 8 fields + submit | ≤ 900 ms |
| snapshot of a page with 1,000 interactive elements | ≤ 300 ms |
| navigate (local) + snapshot | ≤ 400 ms |
| cold first call (launch + navigate), existing profile | ≤ 3 s |

Against `@playwright/mcp@0.0.83` on the same steps (same machine, headless):
- faster on every step;
- at least 40% fewer output characters for navigate and click.

## Acceptance criteria

The tests cite these IDs. An expectation comes from the fixture's own specification, such as what the
fixture server recorded or the page state read back. It never comes from this server's output.

### A. Session and modes
- **A1** The server answers `initialize` + `tools/list` within 1 s, and no Chrome process is started by
  that.
- **A2** The acceptance suite passes headless. The headed smoke subset (B2, D1, D3, D8, D9, E2) is run once
  and recorded in VERIFICATION.md.
- **A3** A cookie set in one server process is present after restarting the server with the same
  `--profile-dir`.
- **A4** A second server process on the same profile dir works and reports that it uses a temporary
  profile.
- **A5** `session launch` with a different `headless` value switches the mode at runtime. The result says
  that tabs were not carried over, and cookies survive (persistent profile).
- **A6** After the test kills the Chrome process, the next tool call relaunches. Its result starts with a
  notice, and nothing hangs.
- **A7** After the server's stdin closes, or on SIGTERM, no Chrome process from launch mode remains within
  5 s.
- **A8** Connect mode works and leaves the attached Chrome running.
  - Setup: the test starts Chrome with `--remote-debugging-port=0 --user-data-dir=<tmp>` and one tab
    open, and passes that endpoint as `--cdp-endpoint`.
  - `tabs list` shows the existing tab, and the server can act on it.
  - After the server exits, that Chrome is still alive with its tab, checked via its own `/json/list`.
- **A9** Auto-connect:
  - `--auto-connect --chrome-user-data-dir <tmp>` reads the `DevToolsActivePort` that the test Chrome
    wrote and connects over `ws://`.
  - With no file, the error tells the user to enable `chrome://inspect/#remote-debugging`.
  - Checking against an everyday Chrome is a manual step.
- **A10** In launch mode, Chrome has no TCP listening socket (lsof on the browser PID).

### B. Tabs
- **B1** After three `tabs new` calls with URLs, `tabs list` shows `t1..t3` with title, URL and one
  `(active)` marker.
- **B2** Click and type on a non-active tab via `tab` work in headless and headed launch modes. The active
  marker tells the truth afterwards.
- **B3** Clicking a `target=_blank` link or calling `window.open` gives `→ new tab tN <url>`. The tab is
  in `list` and is active.
- **B4** Closing the active tab activates the previously active one. Ids are never reused.
- **B5** Refs locate their own tab:
  - A ref from t1, used without `tab` while t2 is active, acts on t1 (the fixture counter in t1
    increments).
  - A ref with a mismatched `tab` is an error.
- **B6** Two concurrent calls on two tabs both complete correctly. Two concurrent calls on one tab run
  serially (the fixture sees ordered events).

### C. Snapshot, read, find, screenshot
- **C1** Every snapshot line parses with the grammar. Refs are unique, and the header line is present.
- **C2** The coverage fixture is reported correctly.
  - Each of these appears with the right role, name and states:
    - links and buttons;
    - every input type;
    - a select with its options;
    - a textarea;
    - a checkbox and a radio, including a custom one (hidden input + label);
    - a contenteditable;
    - an open shadow DOM;
    - a same-origin iframe;
    - a cross-origin iframe (`localhost` vs `127.0.0.1`);
    - a `<dialog>`;
    - a role=alert.
  - These are absent:
    - `display:none`;
    - `visibility:hidden`;
    - `aria-hidden`;
    - `inert`;
    - a closed `<details>`.
- **C3** An element keeps its ref across two snapshots. After a navigation, the old refs are rejected.
- **C4** Stale refs:
  - The fixture re-renders a unique "Save" button. The old ref still clicks it, and the result says
    `re-resolved`.
  - With two "Save" buttons, the result is the stale error and the fixture click counter stays
    unchanged.
- **C5** On a page with 5,000 elements, the snapshot is ≤ `max_chars` with a footer. `offset` paging
  returns the following lines with no gap or overlap.
- **C6** `viewport_only` returns only elements that intersect the viewport.
- **C7** The fixture password literal never appears in any tool output across the whole suite. The client
  helper scans every result. A filled password field shows `value=<redacted>`.
- **C8** `read` on the article fixture:
  - It returns the title, the body paragraphs and the links in markdown.
  - The fixture's boilerplate strings are absent: nav, footer, cookie banner and sidebar ad.
  - Paging with `offset` works.
- **C9** `find "save"` returns the matching buttons with refs, including those inside iframes.
- **C10** `screenshot`:
  - The default is a jpeg of the viewport. png works on request.
  - `max_edge` is respected, and so is `full_page`.
  - `annotate` labels are visible in the image, and the DOM has no overlay nodes after the call.
- **C11** Coordinates:
  - Take a downscaled screenshot (`max_edge` 640, or DPR 2 emulated). Click `"x,y"` at the image
    coordinates of a fixture button's center: the button's counter increments.
  - The same works after a `full_page` screenshot for a button below the fold.
- **C12** On a fixture served with `Content-Security-Policy: script-src 'none'; require-trusted-types-for 'script'`,
  these all work:
  - snapshot;
  - click;
  - type;
  - read;
  - `screenshot annotate`.

### D. Actions
- **D1** `click` (the fixture counters are the oracle):
  - plain, double, right (contextmenu) and Shift (`event.shiftKey`) clicks;
  - an element that appears after 800 ms, via auto-wait;
  - an offscreen element (scrolled into view);
  - an overlay that disappears after 500 ms (the click waits);
  - a permanent overlay: the error names the covering element;
  - a disabled button: the error says disabled.
- **D2** `type`:
  - replace and append;
  - `slowly` fires per-key events, so the autocomplete fixture shows its suggestions;
  - `submit` presses Enter;
  - a contenteditable;
  - a controlled-input fixture that takes state only from input events receives the value.
- **D3** `fill_form` fills the full-form fixture in one call and submits it.
  - The fixture has these fields:
    - text, email, password and textarea;
    - single and multiple select;
    - checkbox and radio group;
    - date, range and color;
    - file;
    - contenteditable mirrored into a hidden field.
  - The fixture server's recorded submission equals the expected payload. The test writes that payload
    from the fixture spec.
  - A bad field gives a per-field error, and the submit is not clicked: the server records nothing.
- **D4** `press`:
  - Tab moves focus.
  - `Control+a`/`Meta+a` selects.
  - Enter submits.
  - ArrowDown moves the listbox selection.
- **D5** `hover` reveals a CSS `:hover` menu. The menu item is clickable afterwards.
- **D6** `scroll`:
  - down, up and `to: 'bottom'` change `scrollY`;
  - the infinite-scroll fixture loads more, and the height change is reported;
  - a scrollable container target scrolls.
- **D7** `drag`: both an HTML5 DnD fixture and a pointer-event drag fixture register the drop.
- **D8** `upload`:
  - A file input and a file-chooser button both deliver the file: the server receives the name and
    the bytes.
  - A path outside the roots is refused.
  - A dot-file is refused.
  - In headed mode, no native dialog appears.
- **D9** Dialogs:
  - An alert is auto-accepted and reported.
  - A click that raises a confirm returns within 2 s with `dialog pending`.
  - While it is pending, other tools on that tab fail within 1 s.
  - `dialog accept` makes the page see `true`.
  - A prompt answered with text gives the page that text.
  - `dismiss` gives `false`/`null`.
  - Another tab works while one has a pending dialog.
- **D10** `navigate`:
  - a scheme-less goto, back, forward and reload;
  - a 404 is reported with its status;
  - `http://nonexistent.invalid` gives `isError` with `net::ERR_NAME_NOT_RESOLVED`;
  - a slow page honours `timeout_ms` with a clear timeout error;
  - an SPA `pushState` is reported as `→ url`.
- **D11** `wait`:
  - Each condition passes on the fixtures:
    - text appearing after 1 s;
    - text gone;
    - target visible/hidden;
    - url;
    - load_state;
    - ms.
  - A timeout gives `isError` naming the condition.
- **D12** `evaluate`:
  - an expression;
  - a function with a target element;
  - a JSON result;
  - an exception gives `isError` with the message;
  - a large result is truncated.
- **D13** A download link saves the file under `<output-dir>/downloads`. The result reports the path and
  size, and the bytes equal the served file.
- **D14** `batch`:
  - A 5-step batch (navigate, fill_form, click, wait, snapshot) runs in one call.
  - If step 3 fails, steps 4 and 5 are reported as `skipped`.
  - `stop_on_error: false` continues past the failure.
- **D15** console and network:
  - The fixture's console log and error appear at their levels, and the uncaught exception is captured.
  - `network` lists the fixture's fetch with method, status and type.
  - The `request_id` detail redacts the `Authorization` header.
  - `failed_only` shows the 500 response and the aborted request.

### E. Video
- **E1** A fixture video is generated by `scripts/gen-fixture-video.mjs` with ffmpeg-static and
  committed.
  - Format: WebM VP9 and MP4 H.264, 6 s, 640x360. Second k is a solid color from a fixed table.
  - The fixture server supports HTTP Range.
  - `video list` shows duration 6±0.1, paused, `640x360`.
- **E2** `video frames times=[0.5,2.5,4.5] format=png` returns 3 images. The center pixel of each matches
  the color table for that second (per-channel tolerance 40).
- **E3** `count=3` spreads frames across the duration. Afterwards the earlier `currentTime` and paused
  state are back.
- **E4** These change the element state as read back by `evaluate`:
  - play;
  - pause;
  - seek;
  - set rate;
  - muted;
  - volume.
- **E5** Live sampling (`every_ms=500, duration_ms=2000` while playing) returns ≥ 3 frames with
  increasing timestamps.
- **E6** `captions` returns the `<track>` VTT cues with the VTT file's timestamps.
- **E7** A video inside a cross-origin iframe is listed and its frames are captured.
- **E8** Real web, recorded in VERIFICATION.md (not in the suite):
  - On a YouTube watch page, after any consent wall is clicked through, `video frames` returns ≥ 3
    non-black, mutually different frames.
  - This holds headless and headed.

### F. Performance and tokens
- **F1** `npm run bench` writes `bench/RESULTS.md` with the [performance targets](#performance-targets),
  and the targets are met.
- **F2** The comparison with `@playwright/mcp@0.0.83` is recorded: faster on every step, and ≥ 40% fewer
  output characters on navigate and click.

### G. Robustness and hygiene
- **G1** No tool call exceeds its timeout + 2 s, ever. The client helper asserts this suite-wide.
- **G2** After the full suite, no Chrome process with a `--user-data-dir` under the test profile root
  remains.
- **G3** Every `isError` result names a cause and a next step. The fixture cases above spot-check this.
- **G4** The code is clean:
  - `npm run typecheck` is clean;
  - no `any`;
  - no `console.log` in `src/`;
  - the server's stdout carries only valid JSON-RPC messages for the whole suite (the client helper
    checks this).

### H. Consumer-side proof (main session)
- **H1** A real Claude Code headless run completes the task, and the result is recorded in
  VERIFICATION.md.
  - The run is `claude -p --mcp-config <tmp> --allowedTools "mcp__x2-browser__*"`.
  - The task is httpbin.org/forms/post: fill and submit.
  - The answer contains the values that httpbin echoed.
- **H2** Real-web smoke, recorded in VERIFICATION.md:
  - a Wikipedia search, then reading the article;
  - three real sites in three tabs, acted on by `tab`.

## Test harness rules

- **Fixture server** (`test/support/`):
  - It serves `test/fixtures/` on two origins: `http://127.0.0.1:<p1>` and `http://localhost:<p2>`.
    They are different sites, so a cross-origin iframe is a real OOPIF.
  - It records requests: `POST/GET /submit` (urlencoded, multipart with files, JSON) is recorded, and
    tests read the log back over `/__log`.
  - It also serves:
    - `/slow?ms=`;
    - `/status/<code>`;
    - `/download/<name>`;
    - `/csp/<page>` (strict CSP + Trusted Types);
    - HTTP Range for media;
    - a 500 endpoint and a hanging endpoint.
- **Tests drive the built server** (`node dist/index.js`) through the SDK `Client` + `StdioClientTransport`,
  which is the consumer side. Unit tests may import `src/` directly.
- **One server per test file**, run with `--headless --isolated --output-dir <test tmp>`. Test files run
  at most 2 at a time, because the laptop has limited RAM and swap.
- **The client helper enforces suite-wide rules:**
  - G1: timeout + 2 s;
  - G4: stdout is JSON-RPC only;
  - C7: no password literal in any output.
- **G2:** a post-suite check that no Chrome process with the test profile root remains.
- **Process kills:** a test that kills processes kills only the PIDs it started itself.

## Amendments

(append-only, with date and reason)

### 2026-10-21: one logged-in agent browser, shared by every session

Decision: one separate agent browser that the user logs into once. Users often run several Claude Code
sessions at once, sometimes for days. Each session has its own server process, and only one Chrome can
hold a profile. The temp-profile fallback in A4 would leave every session but the first without the
user's logins. A4 is therefore replaced, and A11 is added.

**1. Join instead of fall back.** A server that finds `--profile-dir` owned by another live x2-browser
server joins that server's browser.
- **Socket:** the owner listens on a user-only local socket at
  `~/.x2-browser/run/<first 12 hex of sha1(realpath(profile))>.sock`, mode 0600, in a 0700 dir. It is
  never a TCP port.
- **Calls:** the joiner forwards every tool call to the owner. The owner runs it on its own browser under
  the joiner's client id.
- **Tabs:** each client has its own active tab and its own tab list. `tabs list` shows only the tabs that
  client opened, plus popups those tabs spawned. Refs and tab ids come from the owner's counters, so they
  never collide.
- **Status:** `session status` adds `shared=owner` or `shared=client(owner pid N)`.
- **Mode changes:** `session launch` from a client returns `isError` with the owner's pid when it would
  change the shared browser's mode.
- **Takeover:** if the owner goes away, the client's next call takes over. It launches on the profile,
  becomes the owner, and its result starts with a notice. Its old tabs are gone; cookies persist.
- **Foreign lock:** if no server owns the profile but a Chrome holds it (e.g. the `open` window below),
  the result is `isError` naming the pid and asking the user to close that window.

**New A4:**
- (a) A cookie set through server 1 is visible through server 2 on the same origin.
- (b) Exactly one Chrome process uses the profile dir.
- (c) Server 2's `tabs list` shows only its own tabs, and its tab ids and refs do not collide with
  server 1's.
- (d) After server 1 exits, server 2's next call succeeds with a takeover notice and the cookie is
  still there.
- (e) The socket is mode 0600 inside a 0700 dir. No Chrome or server process listens on TCP.

**2. New A11: log in once, by hand.** `x2-browser-mcp open [url] [--profile-dir <dir>] [--headless]`
starts a plain Chrome on the agent profile so the user can sign in.
- It adds no automation flags: no `--enable-automation` and no `--remote-debugging-*`. Google refuses
  sign-in in automation-controlled windows.
- It exits when that Chrome exits.
- If a server currently owns the profile, it exits with code 2 and says to log in through the open agent
  window instead.
- `--headless` exists only so tests can run it.
- **Test:** the spawned Chrome's command line contains `--user-data-dir=<profile>` and none of those
  flags. The locked case exits with code 2.

**3. Who builds it.** The join and `open` are a separate phase-2 change after `feat/core` lands.
`feat/core` does two things now:
- It routes every tool call through one dispatcher that takes a client context (active tab, owned tabs),
  so a socket server can call it.
- It detects the lock (a live pid in `SingletonLock`) and returns an interim `isError` that names the
  pid.

### 2026-10-21: core build (feat/core)

- 2026-10-21 (core build): upload hidden-segment rule is applied to the path *relative to the allowed root
  that contains it* (as given, dot-segments normalised, and after realpath). Reason: the default root
  `<output-dir>` = `~/.x2-browser/output` is itself under a dot-dir, so a literal whole-path check would
  refuse every file in a default root. `~/.ssh/id_rsa`, `.env` inside a root, and symlinks into dot-dirs
  stay refused.
- 2026-10-21 (core build): `--isolated` launches with `launchPersistentContext(<mkdtemp $TMPDIR/x2b-profile-*>)`
  instead of `launch` + `newContext`. Reason: Playwright's `launch()` refuses a `--user-data-dir`, so its
  own temp profile would not carry the `x2b-profile-` prefix the tests rely on (Lifecycle, Temp locations).
  Behaviour is the same: a fresh profile per process, deleted on exit, pipe transport.
- 2026-10-21 (core build): `find` prints the context as its own line after the hit,
  `  in - heading "Settings" e3 level=2`, so the hit line itself stays a pure grammar line.
- 2026-10-21 (core build): an element with no vocabulary role (e.g. a `<div>` returned by `evaluate` or
  listed in a strict-mode error) is described with role `group`; `clickable` when it is clickable.
- 2026-10-21 (core build): background tabs. Measured headed launch mode: a background-tab click takes
  ~90 ms with no `bringToFront` (Playwright disables background throttling), so launch modes act directly
  and the active marker does not move. Attach modes bring the tab to the front before acting (the user's
  Chrome may throttle) and the client's active tab follows.
- 2026-10-21 (core build): settle is additionally bounded by the call's own timeout + 0.7 s (a click that
  starts a slow navigation returns its effect summary instead of overrunning G1's timeout + 2 s).

### 2026-10-21: contract answers to the acceptance agent's 18 questions

Decided by the main session. Both the server and the tests follow these from now on.

1. **Call budgets (G1).** `timeout_ms`, when given, replaces the default budget. The defaults:
   - `navigate`, `tabs new` with a `url`, and `session launch`: the navigation timeout.
   - `wait`: `ms` for an `ms` wait, otherwise the action timeout.
   - `video frames`: `duration_ms` + the action timeout when sampling with `every_ms`, otherwise the
     navigation timeout.
   - `batch`: the sum of its steps' budgets.
   - `fill_form`: one budget, the action timeout, shared by all fields. Each field waits only for what
     remains. A field that never gets a turn is reported as `failed … timed out (call budget)`.
   - Every other tool: the action timeout.
2. **Error shape (G3).** Line 1 states the cause. Line 2 starts with `hint: ` and names the next step.
3. **Not rendered** means `checkVisibility({ visibilityProperty: true })` is false. The other exclusions
   in the grammar also apply: `aria-hidden`, `inert`, zero size.
4. A contenteditable with no role is reported as `textbox`.
5. Inputs of type date, time, datetime-local, month, week and color are `textbox` with `type=<t>`.
6. (No change: an alert's text is its name, as the grammar already says.)
7. **`find` context** goes on its own next line, as amended by the core build. A hit inside a frame takes
   its iframe line as context.
8. **Paging.** Every page repeats the header line. `offset` counts body lines. `max_chars` bounds header
   + body; the footer comes on top.
9. **`read` paging.** `read` ends with `… <n> more chars (offset=<m> to continue)` when it is cut.
10. **First tab.** The initial blank tab of a fresh launch is t1. `navigate` without `tab` uses it, and
    the first `tabs new` reuses it while it is still `about:blank` and untouched.
11. **Radio group target.** A selector or ref of the `fieldset` or `radiogroup` that contains the radios.
    The value is the label or value of the radio to pick.
12. **Named landmarks** are always kept in interactive mode, even when they contain only text.
13. **Scheme-less URLs.** `localhost`, `127.0.0.1` and `[::1]` (with an optional port) get `http://`;
    everything else gets `https://`.
14. **`video list`**, one line per video, fields in this order:
    `<ref> frame=<fN> src=<JSON> duration=<s.ss|Infinity> time=<s.ss> paused=<bool> muted=<bool> volume=<0..1> rate=<x> size=<w>x<h> ready=<0-4> tracks=<n>`.
15. **Console location** is `(<url>:<line>)`, with no column.
16. **`session launch`** includes the words `tabs not carried over` in its result.
17. **Harness flags.** `--headless --isolated` apply to launch modes only. Attach-mode tests leave them
    out.
18. **`~`** means `os.homedir()`, which respects `HOME`.

**Run command note.** Under Node 24 + tsx, `node --test <directory>/` collects nothing and fails with
`ERR_UNSUPPORTED_DIR_IMPORT`. Always pass quoted globs, as `npm test` does.

### 2026-10-21: decisions from the three review lenses

Three independent reviews (correctness, security at max effort, performance) found real defects. Their
reproductions are in the main session's scratchpad. These decisions change the contract; all other
findings are plain fixes against the existing text.

1. **URL policy** (security, critical: `navigate file://…` + `read` exposed any local file and
   bypassed the upload confinement).
   - **Local files.** `file:` and `view-source:file:` URLs are allowed only where an upload source would
     be: the realpath must lie inside an allowed root, and no segment may start with a dot. The same
     widening flags apply.
   - **Where it is enforced.** The rule covers `navigate` and `tabs new url`. A guard also catches any
     other navigation that lands on a disallowed `file:` URL (a click, a redirect, history): it sends
     the tab to `about:blank` and reports `→ blocked <url> (<reason>)`. A download whose source is a
     disallowed `file:` URL is cancelled.
   - **Internal pages.** `chrome:`, `chrome-untrusted:`, `chrome-extension:`, `chrome-search:` and
     `devtools:` URLs are refused unless `--allow-chrome-urls` (env `X2B_ALLOW_CHROME_URLS=1`) is set.
     So is every `about:` URL except `about:blank` and `about:srcdoc`, because about:version is
     chrome://version.
   - `http(s):` and `data:` stay unrestricted.
2. **Origin lists** (requested by the owner after a safety review: keep high-value accounts out of the
   agent's reach).
   - **Flags:** `--blocked-origins <list>` and `--allowed-origins <list>` (env `X2B_BLOCKED_ORIGINS`,
     `X2B_ALLOWED_ORIGINS`), comma-separated and repeatable.
   - **Entry forms:**
     - a host (`bank.example`, which also matches its subdomains);
     - a `*.` pattern;
     - a full origin (`https://mail.google.com`).
   - **Enforcement.** Every http(s) and ws(s) request of every tab is aborted at the network level when
     its origin is blocked or not allowed. `navigate` and `tabs new` check first and return isError
     `blocked by --blocked-origins: <host>` (or `--allowed-origins`), with a hint.
   - **Default:** both lists empty, so there is no restriction.
3. **Output hygiene** (page-derived text must not forge server lines).
   - In `console` output, the continuation lines of a multi-line message start with `  | `.
   - In `read` output, a line that would start with `→ `, `hint: `, `notice:` or `[t<digits>]` gets a
     leading backslash.
   - Each stored console message is clipped to 4,096 chars, ending with `…`.
4. **Hard cap.** The dispatcher applies `--max-output-chars` to the final text of every result: all
   text parts, prefixes and notices, and batch totals. It cuts at a line boundary, and the closing note
   `… output cut at <n> chars` fits inside the cap.
5. **Secrets.**
   - Values the server types into password fields (through `type` or `fill_form`) are remembered for
     the life of the process and printed as `<redacted>` in every result.
   - In every URL the server prints, query parameters whose name matches
     `pass|pwd|secret|token|api[-_]?key|auth` (case-insensitive) have their values printed as
     `<redacted>`.
6. **Crashed tab.**
   - A page tool on a crashed tab returns isError `tab tN crashed`, with
     `hint: close it with tabs close, or open a new tab with tabs new`.
   - `tabs list` marks the tab ` crashed`.
   - The crash notice is line 1 of the next result for that tab.
7. **`video list`** may print `duration=unknown` before the metadata has loaded. This amends answer
   14: `duration=<s.ss|Infinity|unknown>`.
8. **Takeover counters.** After a takeover, ref numbers and tab ids continue above the highest ones that
   session has seen. A ref issued before the takeover is refused as `from a previous browser session`.
9. **Deadlines.**
   - A call never starts a page action after its deadline.
   - If a call's turn in the tab queue comes after its deadline, it returns the timeout error and
     touches nothing.
   - Multi-step tools (`fill_form`, `batch`, `video frames`) check the deadline between steps.
10. **Dialogs inside multi-step actions.**
    - `fill_form` stops at the first dialog. Later fields are reported as
      `not attempted (dialog pending)`, submit is not clicked, and the summary counts attempted fields.
    - `type submit:true` does not press Enter if a dialog opened while typing.
11. **Settle on a page that changes by itself.** On a page whose DOM changes every 50 ms without any
    action (a clock), a click that changes nothing else must settle within 250 ms at p50. The static
    click target stays as before.
12. **The login window and the agent must read each other's cookies.** Found by the main session while
    preparing the fixes; no test covered the user's end-to-end flow.
    - Playwright starts Chrome with `--use-mock-keychain` (macOS) and `--password-store=basic` (Linux).
      Cookies the agent's Chrome saves are therefore encrypted with a mock key.
    - The plain Chrome started by `open` uses the real macOS Keychain. Cookies saved there would be
      unreadable to the agent, so a login done by hand would silently disappear.
    - `open` therefore passes the same two switches, while still adding no automation flags.
    - **New A12:**
      - A cookie the fixture server sets during an `open --headless` session is sent by the agent's
        browser afterwards, through a server on the same `--profile-dir`.
      - A cookie set through the server is sent during a later `open` session.
13. **`fill_form` lines after a dialog.**
    - A field that was not attempted prints `skipped <target>: not attempted (dialog pending)`, which
      follows the tool's `<status> <target>` line form.
    - The field whose handler raised the dialog prints `ok <desc> (a dialog opened)`.
    - The summary reads `filled <ok>/<attempted> fields; <n> not attempted (dialog pending)`, adding
      `; submit not clicked (dialog pending)` when a submit target was given.
    - A dialog stop is not `isError`. The `→ dialog pending` line reports it.

### 2026-10-21: decisions from the re-check round (the fix diff 13fb319..5a35003 re-reviewed by all three lenses)

All 16 original correctness findings are fixed, S1–S3 are closed for direct paths, and the performance
targets pass. The fix diff introduced new defects. These decisions sharpen items 5, 8, 9 and 11 and add
the rest.

1. **Deadline, sharper item 9.**
   - Every Playwright action timeout inside a call is capped by what remains of that call's deadline.
   - The tab queue moves on only after a timed-out job has actually settled. That wait is short,
     because the timeouts are capped.
   - So a call never acts on the page after its timeout result was sent, and never overlaps the next
     call on the same tab.
2. **Takeover counters, sharper item 8.**
   - Ref and tab counters travel as structured fields of the shared-socket protocol. They are never
     parsed out of result text, because page text can contain `e<digits>`.
   - A client that rejoins sends its highest seen ref and tab numbers.
   - The new owner raises its counters and its previous-session floor to match, and the rejoined
     client gets the takeover notice.
3. **Origin lists.**
   - Redirects are checked at every hop, for navigations and for subresource requests alike.
   - A host's trailing dot is ignored.
   - Only URLs a list could match are routed through the server, so unrelated traffic is never
     intercepted.
4. **Popups and pages downloaded from the web.**
   - The first URL of every new page (popup, `target=_blank`, `window.open`) obeys the URL policy. A
     refused one is sent to `about:blank` or closed, and reported as `→ blocked <url> (<reason>)`.
   - `<output-dir>/downloads` is not a root for `file:` navigation, because any page can put a file
     there. It remains an upload source.
5. **Line breaks in page text.** `\r`, `\n`, U+2028, U+2029, U+0085, `\v` and `\f` all count as line
   breaks wherever page text is escaped or continued (item 3). JSON-quoted fields escape U+2028 and
   U+2029.
6. **Secrets, sharper item 5.**
   - A remembered password literal is scrubbed only when it is at least 6 characters long, and only as
     a whole token: no letter or digit directly before or after it. Roles and ref tokens are never
     altered.
   - Query parameter names match as a word part,
     `(^|[_.-])(pass(word)?|passwd|pwd|secret|token|api[-_]?key|auth)($|[_.-])`, case-insensitive.
     So `author` and `passengers` are left alone.
   - At most 64 secrets are remembered, the most recent kept.
   - Secrets reach a joined client too, so they survive a takeover.
   - Only the literal is guaranteed scrubbed. Encoded or transformed echoes (base64, a changed case)
     are a documented limit.
7. **Settle, sharper item 11.** Changes the action itself causes are always waited for. Only nodes that
   change periodically on their own count as background: at least 3 changes at a steady interval, none
   of them inside the previous action's settle window.
8. **`fill_form`.** A field gets `ok` only when its fill finished. A fill that was cut short by a dialog
   or the deadline must not land later.
9. **`wait`.** `state: detached` or `state: hidden` succeeds for a ref whose document is gone.
10. **The snapshot footer count is exact,** including iframes that fall past the cut.
11. **Ref retention.** Refs whose elements the in-page sweep found to be garbage are retired, and live
    refs are capped at 20k per document. A retired or evicted ref gets the stale-ref error.
12. **`authorization` is a secret parameter name.** It is added to item 6's list, because the verbatim regex left `?Authorization=…` unredacted.

### Decisions from the bench (2026-10-23)

Reason: in the agent-level bench (`bench/RESULTS.md`, B2) we were fastest on 2 of 3 tasks but Playwright
MCP was cheapest on all 3. Every new document attached a full-page snapshot capped only by
`--max-output-chars` (about 20k chars per Wikipedia navigation; T2 median 32,866 result chars against
5,007). The owner decided the rule below; the bench is re-run afterwards.

1. **The automatic snapshot is viewport-only.** The snapshot attached because an action produced a new
   document (navigate, `tabs new` with a url, a navigating click, type, press or submit) is:
   - interactive mode, listing only elements that intersect the viewport, by the same rule as
     `snapshot { viewport_only: true }` (C6);
   - capped at 6,000 chars, header and footer included (`ATTACHED_SNAPSHOT_MAX_CHARS` in
     `src/util/format.ts`). The summary and the snapshot together still never exceed
     `--max-output-chars`;
   - the header line is unchanged, and its refs work as any other.
   - An explicit `snapshot: true` keeps the old behaviour: the whole page, capped by
     `--max-output-chars`, with the `… <n> more lines (offset=…)` footer, even when the action navigates.
     `snapshot: false` still attaches none, and the "(snapshot unavailable: …)" fallback is unchanged.
   - The `snapshot` tool itself is unchanged (full page by default).
2. **The viewport footer.** When anything is left out (elements off-screen, or lines past the cap), the
   attached snapshot ends with exactly one footer line, never a body line:

   ```
   … viewport only: <n> more off-screen (find or read for text; snapshot for the whole page)
   … viewport only: <n> more off-screen, <k> more lines (find or read for text; snapshot for the whole page; offset=<m> with viewport_only to continue)
   ```

   - `<n>` counts elements the interactive snapshot would list that lie outside the viewport. `<k>` and
     `<m>` appear together, only when lines were cut; `snapshot { viewport_only: true, offset: <m> }`
     continues the page.
   - Counts a frame's engine reports (`<n>`, the omitted lines) are page-controlled: only finite,
     non-negative integers are used, anything else counts as 0.
   - **Limitations:** an iframe that is itself off-screen is not walked, so its elements are not in `<n>`.
     An iframe that is only partly on screen contributes all its elements, because each frame judges
     "in the viewport" against its own window (`inViewport` in `src/page/injected/dom.ts`).
   - One walk: the attached snapshot takes `unique` (ref re-resolution) from the counts of its own walk,
     off-screen elements included, so refs behave exactly as with the full-page walk; the explicit
     `snapshot { viewport_only: true }` is unchanged.
   - `find` and `read` are named before `snapshot` on purpose: an agent told only "call snapshot" pulls
     the whole page back and the saving is lost.
   - It carries no page text, so it needs no escaping; page lines cannot forge it (body lines start
     with `- `).
3. **The settle quiet window stays at 100 ms** (capped at 600 ms). A 50 ms window was measured and
   rejected: at the agent level it saved about 0.2 s per task (1-2%) and nothing on cost, and a page that
   updates 50-100 ms after its last mutation would be reported stale. SQ2 (`test/acceptance/S.test.ts`)
   guards the window: a role=alert update 30 ms after a click is an effect line of that click.
4. **Bench output names.** `bench/micro.mjs` and `bench/agent/run.mjs` take `--tag <name>` and write
   `bench/results/<date>-micro-<tag>.json` / `<date>-agent-<tag>.json`, with agent logs in
   `bench/results/agent/<date>-<tag>/`. Both refuse to overwrite an existing dated result file, tagged
   or not (message, exit 1); a bad tag exits 2. `run.mjs --rescore <file>` still rewrites the file it is
   given, and `micro.mjs --smoke` still writes to `bench/.tmp`.
5. **A line longer than the page.** When the first line of a page does not fit the remaining budget
   (a huge `href`), it is cut to fit instead of overflowing: a cut inside a JSON string ends the string
   with `…"`, a cut elsewhere drops trailing attribute tokens. Every page makes progress and stays within
   its cap (6,000 for the attached snapshot, `max_chars` for the `snapshot` tool). Before, one such line
   could exceed both, and `--max-output-chars` then dropped the whole snapshot.
6. **Titles in summary lines** (`[tN] navigated … "<title>"`, `tabs list`) are JSON-quoted with U+2028,
   U+2029 and U+0085 escaped too, like every other quoted page string, so a title cannot start a line.
7. **Tool descriptions** say "a viewport snapshot (call snapshot for the whole page)" where they
   promised a snapshot after navigation. Tests: `test/acceptance/S.test.ts` (AS8 and the rest),
   `test/harness/grammar.test.ts` (the footer grammar).

### 2026-10-23: Chrome sandbox

Chrome ran without its renderer sandbox: playwright-core adds `--no-sandbox` unless `chromiumSandbox: true`,
and `launchPersistentContext` did not pass it. A headed run showed Chrome's "unsupported command-line flag" banner.
1. **Default:** launch mode passes `chromiumSandbox: true`. No Chrome process of a launch (headed,
   headless, `--isolated`, persistent profile) carries `--no-sandbox`.
2. **Opt-out:** `--no-sandbox` / `X2B_NO_SANDBOX=1`, off by default, for environments where the sandbox
   cannot start (Linux containers as root). It restores the old flag and logs one `warn` line at startup.
3. **Unchanged:** connect and auto-connect (we did not launch that Chrome), the `open` subcommand (it
   spawns Chrome itself without `--no-sandbox`), every other launch flag.
4. **Tests:** `test/regress/sandbox.test.ts` (the launched processes' command lines, via `ps`) and
   `test/unit/config.test.ts` (flag, env, `--help`).

### 2026-10-23: fix round 3 (core)

Amendments found while fixing C1-C11 (brief `brief-r3-core.md`); each says what reality contradicted.
1. **C3, boundary.** Carrying the in-page sweep's dropped ids to `RefRegistry.retireLocals` needs
   `injected/snapshot.ts`, `injected/index.ts`, `page/protocol.ts` and `page/snapshot.ts`, not only
   `injected/dom.ts`. Those are page files, so core does not wire it this round and `dom.ts` is not
   touched. The AC is met in core: a re-issued ref moves to the tail of its document's recency queue, the
   20k cap evicts the least recently issued ref, and an evicted ref answers with the stale-ref error
   (`e<n> is stale (element removed)`), not "earlier document". `retireLocals` keeps its stale reason for
   when the page side calls it.
2. **C3, target.ts.** The stale reason needs one branch in `tabOfRef` (`src/page/target.ts`), beyond R-W11.
3. **C2, dispatcher.** `resolveTab` routed every ref through `tabOfRef`, which throws for a ref of a gone
   document before `wait` runs. `wait` with `state: detached|hidden` now routes a ref of a gone document
   (earlier document or stale) to the tab it came from.
4. **C8/C5, mechanism.** `ctx.browser()` is available for the persistent launch context too, so the origin
   lists use one browser-level CDP session with `Fetch.enable` (request stage). Measured (spike, Chrome
   headless): it pauses navigation redirect hops, popups (direct and redirected), iframes, cross-site
   iframe (OOPIF) subresources, dedicated workers and service workers. `ctx.route` (which enables Fetch
   for `*` on every page and turns the HTTP cache off) is gone, and so is the per-tab
   `Network.setBlockedURLs`; both stay only as the fallback when no Browser object exists.
   - `--blocked-origins` alone: only URLs matching the blocked hosts' patterns pause.
   - `--allowed-origins`: every http(s) request pauses in this process (any of them can be refused); the
     HTTP cache stays on. That is the documented cost.
   - A redirect hop into a listed host now fails with `net::ERR_BLOCKED_BY_CLIENT` before any request
     leaves Chrome, instead of committing and being sent to about:blank. The tab still gets
     `→ blocked <url> (<reason>)`, and navigate's error names the hop.
   - WebSockets keep `ctx.routeWebSocket` (Fetch does not see the handshake).
   - In connect and auto-connect the browser-level session covers every context of that Chrome (incognito
     included), where `ctx.route` covered the default context only.
   - The cost of `--allowed-origins` (every request paused) was not timed this round: unknown.
6. **C5, the 5% target is not met; it conflicts with C8.** Measured: enabling `Fetch` at all costs about
   40% of a raw `goto` of the 50-iframe page, whatever the patterns (one browser, modes interleaved, n=30:
   none 255 ms, browser-level Fetch 350 ms, page-level Fetch 365 ms, `Network.setBlockedURLs` 274 ms). The
   cheap mechanism, `Network.setBlockedURLs`, never sees navigations, iframes, popups or workers (spike: all
   of them reached the blocked host). So "no request reaches a blocked host" (C8, critical) and "within 5%"
   (C5) cannot both hold with a CDP mechanism; C8 wins. End to end (`pn1t`, n=40): with a list 649 ms
   against 526 ms without (+23%; main: 638 against 556, +15%); server hits per navigation 52 against 201 on
   main (the cache works). Option not taken, needs a decision: launch Chrome with `--host-resolver-rules`
   mapping the blocked hosts to `~NOTFOUND` (no interception cost), but it cannot express origin or port
   entries or IP literals, a proxy bypasses it, the error becomes `ERR_NAME_NOT_RESOLVED`, and it does
   nothing in connect modes.
7. **C10, download names.** The saved path is printed by `effect.download` (page agent's `format.ts`). Core
   replaces U+2028, U+2029 and U+0085 in the suggested name with `_` before it becomes a file name
   (`sanitizeFilename` already replaces the C0 controls), and the failure line JSON-quotes the name.

### 2026-10-23: fix round 3 (page)

Sources: the correctness re-check of the snapshot round, the security re-check (flow-verifier-max) and
the first round of real-site probes on old.reddit.com. Tests: `test/regress/page-r3.test.ts` (end to end) and
`test/unit/format-r3.test.ts`; each was red on 017be23.
1. **read and forms (P1).** A `<form>` is no longer boilerplate: old.reddit puts every post and comment
   body in `form.usertext`. Its controls still are (`input`, `textarea`, `select`, `button`), so `read`
   never prints a control's value, hidden inputs included.
2. **read and "N comments" (P2).** The class token `comments` no longer makes a *link* boilerplate
   (`a.comments` on old.reddit). It still drops a comments container; `nav`, header menus and the other
   tokens are unchanged.
3. **Screenshot size (P3).** The header size and the `x,y` mapping are read from the delivered image
   bytes. Chrome does not always capture at `devicePixelRatio`: Playwright's viewport emulation reports 1
   on a 2x retina screen, and an emulated deviceScaleFactor 2 captures at 1. When the bytes show another
   factor, the capture is retaken once with it, so `max_edge` still holds. Tested by attaching to a Chrome
   with `--force-device-scale-factor=2` under the same emulation, and to a deviceScaleFactor 2 context.
4. **find and split text (P4).** A second pass finds text no single element holds (`<span>21</span>
   comment karma`): the smallest visible elements whose combined text contains the query. Such a hit is
   never one that is, holds or sits inside another hit. A non-semantic hit prints as `group`, with its
   text as its name.
5. **find with an empty query (P5).** With `role`, an empty query lists every element of that role,
   capped by `limit`. Without a role it is an error that names `role`.
6. **Cut lines (P6, P12).** `cutLine` cuts by tokens: the element head (indent, role, name, ref) stays
   whole when it fits, else its name is cut; attributes follow in order; a JSON string is cut at a whole
   unit (never inside `\uXXXX`, never between surrogate halves) and ends `…"`; an options array keeps
   whole elements and closes with `]`.
7. **The cap and paging (P7).** The snapshot header clips the title to 200 chars and the URL to 500. A
   page always shows its first line, at least as its head (`lineFloor`), never as an empty line. Decision:
   when `max_chars` is below header + that head + footer (e.g. `max_chars:120`), the page exceeds
   `max_chars` by that floor so paging still covers every line; `--max-output-chars` and the 6,000-char
   attached cap hold.
8. **Off-screen count (P8).** An iframe is never counted in `<n> more off-screen`.
9. **Untrusted engine (P9).** Every field an engine returns is untrusted, because a page or a
   cross-origin frame can plant `Symbol.for('x2b.engine')` before ours:
   - the role is one of the vocabulary (`SNAP_ROLES`), otherwise `group`. The brief said `generic`, but
     `generic` is not in the snapshot grammar, and `describe` already prints a non-semantic element as
     `group`;
   - `level` prints only as an integer 1-99; `type` only as an input-type word (`[a-z][a-z-]*`), because
     it is a bare token in the grammar; `checked`/`pressed` only as `true|false|mixed`; flags only when
     `true`; strings only when they are strings; ids only as positive integers;
   - the snapshot and `read` header URL and every frame's href base come from Playwright (`frame.url()`,
     `page.url()`), never from the engine;
   - find hits, live-region texts and `scroll`'s numbers are coerced the same way.
   Refs are always minted by the server for the frame it called, so with the role allowlist no engine
   field can print a ref. Fake-engine detection was not built: a secret per install does not stop a page
   that calls a real engine of a same-origin frame, and the output rules above are what the tests hold.
10. **Separators (P10).** The `→ console` line collapses all 7 separators (NEL included). Download names
    lose NEL, U+2028 and U+2029 in `sanitizeFilename`, and `effect.download` escapes any left as
    `\uXXXX` (`escapeBreaks`).
11. **Secrets (P11).** A remembered secret is also scrubbed in its form-urlencoded and fully
    percent-encoded spellings (`!` as `%21`, a space as `+`). Secret parameter names match camelCase
    (`accessToken`, `apiKey`, `APIKey`; `isSecretParam`) and parameters in the fragment
    (`#access_token=`, `#/cb?token=`).
12. **read markers (P12).** A page line starting `## step <digit>` gets a leading backslash, like the
    other server-line prefixes.

### 2026-10-23: fix round 4 (A)

Sources: the correctness and performance re-checks of fix round 3 (`/tmp/x2b-r3rc/t/c1e.mjs`, `c1.mjs`,
`/tmp/x2b-r3rp/`) and real-site probes on www.reddit.com. Tests: `test/regress/core-r4.test.ts`
(end to end), `test/unit/core-r4.test.ts` and `test/unit/security-r4.test.ts`; each item's tests were
red on e8b6834. Guards, green on e8b6834 and kept: the D4 table and old-regex comparison (unchanged output),
the short-title and safe-name cases, and in security-r4 "a remembered secret next to every escape", "a
secret with a quote and a backslash, echoed by the page" (`q()` scrubs before quoting) and "a secret after
a raw backslash" (it pins that the escape guard does not skip `C:\Hunter2!x`).
1. **D1, a queued navigate to a page that keeps a request open.** `runAction` takes the call deadline
   (`ActionOptions.deadlineAt`). Settle ends `POST_SETTLE_RESERVE_MS` (600 ms) before it and is raced
   against that end; every read after settle (title, live regions, popups, the attached snapshot) is
   capped `DEADLINE_GUARD_MS` (100 ms) before it, and so are navigate's two title reads. When the deadline,
   not settle's own caps, ended settle, the summary ends with `(settle incomplete: …)`; it is not an error.
   c1e.mjs: 8 of 8 queued `/poll` navigates answer `[t1] navigated …` at about 3.42 s of a 3.9 s deadline.
2. **D1, timeout errors.** The dispatcher appends `; the tab shows <url>` to the deadline error, to a raw
   Playwright timeout and to any tool error whose cause says `timed out`. The deadline error spells out
   its parts (`timeout + 1.9 s, queue included`); when the tab's URL changed during the call its hint says
   to check with snapshot, never to retry. navigate and wait report the timeout that applied and say when
   the call deadline capped `timeout_ms`.
3. **D2.** `whyMissing` answers `stale` for any number below `next` that is not live, after the three
   capped reason maps; such a ref has no known tab, so `wait detached|hidden` runs it on `tab=` or the
   active tab and succeeds. Found on the way: `e0` answered "from a previous browser session" with no
   takeover; numbering starts at 1, so it is now "not a known ref".
4. **D3.** `titleQ` (format.ts) clips a title to 200 chars for the navigate line, `→ navigated` and the
   `tabs` lines (`tabs new` prints through navigate). **Nit:** `clip` never keeps a lone high surrogate.
5. **D4.** `redactPrintedUrls` peels trailing punctuation with a backward scan (`trailingPunctStart`); the
   output is unchanged (table test against the old regex).
6. **D5.** A new live-region text equal to the document title (whitespace-normalised) is not reported.
   The filter sits in `effects.ts`, after the engine's `liveTexts`, so `injected/index.ts` is untouched.

7. **F1 (security, critical).** `PRINTED_URL` stops at a backslash. In JSON-quoted page text the URL took
   the `\` of a following `\"` into its parameter value, redaction removed it, the string ended early and
   the page forged a ref (`Keep http://x/?access_token=q" e1`). `scrubSecrets` never replaces a match that
   starts inside an escape or ends on its backslash. Test: every JSON escape after six URL shapes, through
   the real `final()`, parsed with `test/support/grammar.ts` (`test/unit/security-r4.test.ts`).
8. **F2 (security, critical, the rest of P9).** `target.ts` `describe` validates the engine's node with
   `safeNode` before it is issued or printed, and `describeShort` prints `safeRole` and a quoted name.
   `evaluate` parses the engine's JSON and serialises it again (`safeEngineJson`, U+2028/2029/0085
   escaped); what does not parse prints as one JSON string. Test: the reviewer's fake engine
   (`test/fixtures/fake-engine-r3.mjs`, copied verbatim) through click, type, evaluate and a cross-origin
   iframe click.
9. **F3 (security).** `[` and `]` separate words in secret parameter names (`user[password]=`). A
   remembered secret is also scrubbed in its JSON-escaped spelling, and right after a JSON escape
   (`\nHunter2!x`). The reviewer's leak was `tabs list`, which quoted the title before scrubbing; titles now
   go through `titleQ` (scrub, clip, quote).

Amendments (files beyond the brief's list; none is implementer B's or C's):
- `src/tools/common.ts`: `actionOpts` passes `ctx.deadlineAt` (the one funnel into `runAction`, dialog
  included).
- `src/page/target.ts`: `refState` with `goneOk` accepts a stale ref with no known tab.
  (target.ts, secrets.ts and evaluate.ts were added to this implementer's files by the security re-check.)
- `src/tools/click.ts`: the description says `→ alert` is a live-region announcement, not a JS dialog
  (the only tool description that listed alerts).
- `src/tools/common.ts` `actionError` (in scope, coordinator): click, type, hover and the other action tools
  report the timeout Playwright applied (`Timeout 812ms exceeded`), with `(timeout_ms N capped by the call
  deadline)` when it is shorter; the dispatcher appends the tab URL to every timeout wording (`after Nms`,
  `for Nms`, `timed out`). Test: core-r4 "a queued click that times out", red on e8b6834.

### 2026-10-23: fix round 4 (B)

Source: real-site probes on www.reddit.com (shreddit web components). Brief `brief-r4-b.md`. Tests:
`test/regress/page-r4.test.ts` with fixtures `shreddit-comments.html`, `shadow-chat.html` and
`slot-fallback.html`; 14 of its 16 tests were red on ec5af4d (the two login-form ones are guards).
1. **E1, read and find on the composed tree.** Both now follow the flattened tree, as `snapshot` does:
   - an open shadow root is shown in place of its host's light DOM;
   - a light-DOM node assigned to a `<slot>` shows where that slot renders, exactly once;
   - a host's light DOM that no slot takes is not rendered and is not shown;
   - a slot's fallback content shows only when nothing is assigned to it.
   Closed shadow roots stay unreachable (`el.shadowRoot` is null to the page): their text is in neither
   `read` nor `find`. Text matching uses `composedText` (`src/page/injected/read-text.ts`): native
   `innerText` wherever a subtree holds no shadow host or slot, a composed walk only over the ancestors
   of those. `find` sorts hits and picks its `in <heading|landmark>` line by composed-tree order.
2. **E2, form labels.** A form control (`input`, `textarea`, `select`, `button`) is still never read, but
   it now separates the text around it: `Username Password`, not `UsernamePassword`.
3. **Amendment (boundary).** The brief pointed at `src/page/injected/*find*`, but `find` lives in
   `src/page/injected/snapshot.ts`. Only its find section (`find`, `lowerText`, `textHits`, `findIn`,
   `contextFor`) changed; the snapshot walker and its output did not.
4. **Performance** (end to end through the server, headless, base ec5af4d against the fix, interleaved,
   median of 30; bench script not committed). A 3,000-section page without shadow DOM: `read` 87 against
   89 ms (+3%), `find` 145 against 146 ms (+1%). The same page as 3,000 slotted custom elements: `read`
   38 against 128 ms and `find` 124 against 169 ms. That base was fast because it showed none of the
   content; against the plain page with the same text, the fix costs +44% for `read` and +16% for `find`.
5. **read paging forged a marker (security re-check).** Every `read` page starts a line of its own, so a
   marker the body held mid-line (`AAAA…## step 2:` padded to the page boundary) started a line on the
   next page unescaped. Each page is now escaped again at its start (`escapeServerLines` on the page
   text, in `src/tools/read.ts`), so every page escapes `## step <n>`, `[tN]`, `→ `, `hint: ` and
   `notice:` like the first. Trap: such a page shows one extra `\` before the marker that is not in the
   paged text; offsets and the footer still index the unescaped page text.

### 2026-10-23: fix round 4 (C)

Brief `brief-r4-c.md` (G1-G5, from the security re-check of round 3). Tests: `test/regress/core-r4c.test.ts`;
each new test was red on ec5af4d (`X2B_TEST_ENTRY=<ec5af4d build>/dist/index.js`) and is green here.
Amendments, each with what reality contradicted:
1. **G1 (b), switch name.** `--force-webrtc-ip-handling-policy` is not a Chrome switch; measured, STUN/TURN
   UDP still left. The switch is `--webrtc-ip-handling-policy=disable_non_proxied_udp` (UDP 20 -> 0).
2. **G1 (a), not a switch.** No launch switch turns speculation rules off: `--disable-blink-features=
   SpeculationRules` and `--disable-features=Prerender2,…` changed nothing, and a second `--disable-features`
   would silently replace Playwright's own list. Chrome's "Preload pages" preference
   (`net.network_prediction_options: 2`) does. So with a list the server writes it into
   `<profile>/Default/Preferences` before launch (read, merge, atomic rename; an unreadable file is left
   alone with a warning). In a persistent profile it stays off afterwards; README says so.
3. **G1 (c), mechanism.** `--host-resolver-rules` (`MAP host ~NOTFOUND`, `MAP *.host ~NOTFOUND`; with an
   allow-list `MAP * ~NOTFOUND` plus `EXCLUDE` per entry). Measured: Chrome applies it to IP-address hosts
   too, so IPv4 entries are mapped with their `::ffff:` spellings, and allowed IPv4 entries are excluded
   (otherwise an allow-list of `127.0.0.1` would block itself). The CDP route on worker targets was dropped:
   `Network.setBlockedURLs` does not stop a WebSocket handshake even from a page (probe: page and worker
   WebSockets both reached the listed host).
4. **G1 (d), vectors.** Blocked, by the refused host's logs, under `--blocked-origins` (host entry, IPv4
   entry, mapped spelling) and `--allowed-origins`: speculation-rules prefetch, its redirect hop, prerender,
   WebSockets from dedicated, shared and service workers, STUN/TURN UDP, TURN over TCP. Documented as not
   blocked: connect and auto-connect (no switches, no preference); proxied requests (not measured); with
   both lists, a blocked host under an allowed one (Chrome checks exclusions before mappings). A
   full-origin blocklist entry blocks its whole host at this layer (stricter than the list).
   - Honest zeros: with preloading off, the prefetch controls on the unlisted host are 0 by design; the
     ec5af4d run is the evidence they were live (1 each). In the mapped-IPv6 mode Chrome never prefetched
     the IPv6-literal URL even on ec5af4d, so those three checks are vacuous there; its worker-WebSocket,
     UDP and TURN-TCP checks were live (red on ec5af4d).
   - Unknown: on a takeover with a list set, whether the departing Chrome's last Preferences write can
     land after ours (losing the preference). Not measured.
5. **G2, compared settings.** The brief lists "upload and file: roots". `fileRoots` contains the cwd and
   `--output-dir`, which differ for every Claude session, so an exact comparison would end sharing between
   projects. Compared: both origin lists, `--no-sandbox`, `--allow-chrome-urls`, `--allow-hidden-files`,
   `--allow-file-root` (new `Config.extraFileRoots`, realpath'd). Not compared, documented: cwd and output
   dir; a joined session's uploads follow the owner's roots. The owner sends its settings in `hello`; an
   owner that sends none (older build) is refused too. A refusing joiner does not fall through to launching
   (that would hit the profile lock); it retries per call, so takeover still works once the owner exits.
   Only the joiner checks: a joiner built before this round still joins any owner.
6. **G3.** The sandbox already followed the flag on `session launch`; only the startup line was wrong. It
   now warns in every mode, and `relaunch` from an attach mode into launch mode warns again.
7. **G4.** The URL parser already folds `127.1`, decimal, hex and octal; the gap was `::ffff:` forms, in
   `hostMatches`, the Fetch patterns and the route regex. Entries are canonicalised the same way. `[::1]`
   is not `127.0.0.1` and stays unmatched.
8. **G5.** `tools/video.ts` coerces every page value to its type (`cleanState`, `cleanSeek`, `cleanTracks`)
   and prints page strings with `escapeBreaks` (kind, language, cue text, a play() error).
9. **G3 supersedes round-3 C7** (found at the r4 merge, 81b9099). C7 had connect mode print a "no effect"
   note instead of the `--no-sandbox` warning; the round-3 PLAN block has no C7 text, only
   `test/regress/core-r3.test.ts` did, and it failed in the full suite. That test now asserts G3 (warning,
   no "no effect" note) and its name says G3 superseded C7.
10. **Chrome slots: hold-and-wait deadlock** (found at the r4 merge). G2's owner and joiner each took a
   slot, so a G2 test held one of the two slots while waiting for a second; page-r3 P3 does the same (its
   file-level server holds one). Run together under `--test-concurrency=2`, both waited 15 min. Fix: G2
   takes one slot per shared profile (the A4/R8 convention, released in `afterEach`), and
   `test/support/slots.ts` breaks any remaining cycle: when every live holder is waiting for 2 s, the
   lowest-pid holder gets an overflow slot and logs `slots: hold-and-wait cycle`. Test:
   `test/harness/slots.test.ts` (red on the old slots.ts after 30 s, green here).

### 2026-10-23: fix round 5 (nav)

Source: the independent re-check of round 4 (`/tmp/x2b-r4rc/t/`: `d1v.mjs`, `c1e.mjs`, `d1r.mjs`, `r6.mjs`
and their logs); the brief's D1 AC2/AC3 and two nits. Tests: `test/regress/nav-r5.test.ts` (end to end,
`X2B_TEST_ENTRY` runs it against another build) and `test/unit/nav-r5.test.ts`. Measurements are Chrome 155
with Playwright 1.64.1 on macOS, headless, through the scripts in `/tmp/x2b-r5n-t/` and probes.
1. **D1, two phases** (`navigateTo`; goto, back, forward and reload alike). Phase 1 waits for the commit
   only (`waitUntil: 'commit'`), capped by the call deadline minus `NAV_STOP_MARGIN_MS` (300 ms). Phase 2
   waits for `wait_until` in what remains of `timeout_ms`, ending `POST_SETTLE_RESERVE_MS` before the
   deadline. If phase 2 runs out, navigate succeeds: `[tN] navigated <url> "<title>" (<status>)` plus
   `(still loading: <state> not reached in <ms> ms)`, where ms counts from the start of the navigation.
   Why a success: the tab is on the new document, and the old error invited a retry that requested the
   page twice (`d1r.mjs`: 3 of 3 runs). Settle is skipped after such a note (`ActionOptions.stillLoading`),
   because it would only wait for the same load again. The note replaces `(settle incomplete …)`.
2. **D1, a commit that did not come in time.** `stopBeforeCommit` sends `Page.stopLoading`, then decides
   from browser events, never from the stop's answer alone. A main-frame watch (`src/browser/navwatch.ts`)
   starts before the navigation and records:
   - the navigation requests, their responses and failures;
   - the commit: a main-frame `framenavigated` on one of those request URLs, or on the goto target;
     for back and forward, any main-frame commit counts.

   An old page's `pushState` is therefore not taken for the commit. What was measured, and what each
   result means:
   - A navigation whose response has arrived cannot be cancelled. The stop is refused ("Not attached to an
     active page", 3 of 4 races in a sweep) or answered, and the commit lands 0-3 ms later. If the old
     page's `pagehide` handler is busy, the commit lands only after it: 900 ms, every time. Result:
     **committed**, the success path with the note.
   - A request that was still pending fails with `net::ERR_ABORTED` within about 5 ms of the stop.
     Result: **stopped**. The error is
     `… timed out after <T>ms before it committed (…); stopped, the tab shows <url>` with
     `hint: stopped before it committed; the tab still shows <url>; retrying requests the page again …`.
     The hint never says `wait_until=commit`.
   - The stop was answered and no response was ever seen: **stopped**.
   - Otherwise (a stop that was never answered, or a commit that does not land before
     `LATE_COMMIT_RESERVE_MS` before the deadline): **uncertain**. The hint is "the navigation may still
     land; check the tab with snapshot", never a retry.

   A navigation that has committed is never stopped, which also fixes the old code: it called
   `stopPending` on every timeout, committed or not.
3. **R6, crash during navigate. Amendment: a fixed "about 300 ms" wait is too close.** `chrome://crash`
   fails as `net::ERR_ABORTED` 20-140 ms after the goto, and the renderer answers nothing until the crash
   shows. Measured:
   - in a bare Playwright context, the `crash` event came 1.9-2.5 s later (3 of 3);
   - through this server, navigate answered "crashed" after 264-299 ms end to end (10 of 10,
     `r6-timing.mjs`).

   A 300 ms wait would miss the first case and only just catch the second. After ERR_ABORTED,
   `crashedSoon` races an evaluation of `1` against the `crash` event, for at most `CRASH_WAIT_MS` (4 s)
   capped by the deadline:
   - a live renderer answers (a 204 or a download also fails as ERR_ABORTED; answered in 60-260 ms);
   - a crashed one rejects with "Target crashed", or the page fires `crash`.

   The tab is then marked crashed, and navigate answers `[tN] tab tN crashed` with the crash hint.
   `r6.mjs`: 10 of 10. Trade-off: an ERR_ABORTED on a page whose main thread is blocked
   waits until the cap.
4. **Nit, the click's late navigation** (`runAction`). When the call deadline cut settle short, the action
   waits for its navigation, until `LATE_NAV_RESERVE_MS` (150 ms) before the deadline, inside the reads'
   600 ms reserve. If no navigation request has shown yet, it first waits up to the 250 ms nav window. The
   URL is read after that wait. A committed new document is reported as `→ navigated` even before its
   DOMContentLoaded: the line was `→ url`, or nothing when the commit came later.
   `d1v.mjs click:#go,#go2`, dense delays: 16 of 16 printed no `→ navigated` on adbecd3.
5. **Nit (D5).** A fresh live text equal to the title is skipped only when no visible `role=alert` holds
   that text (`liveAlerts`). That element is read with Playwright's locator, in its utility world, and only
   when some text equals the title. `src/page/injected/*` is untouched (implementer B's).
6. **AC3 at the dispatcher.** The deadline error of a navigate whose job had started says
   `NAV_DEADLINE_HINT` ("the navigation may still be in progress; check the tab with snapshot …"). It
   used to say "retry …" when the URL had not changed yet. Other tools are unchanged.

7. **Security (added mid-round from the fix/r5-sec audit): page text never starts a line in an error.**
   `firstLine` split only on `\n`, so page text after `\r`, U+2028, U+2029, NEL, `\v` or `\f` reached the
   output. It now splits on all 7 separators, and what is left goes through `escapeControls`
   (`src/util/errors.ts`). That function drops Playwright's own ANSI styling, then writes every control
   character as `\uXXXX`: the 7 separators, ESC and the rest of C0 except `\t`, plus DEL.
   - `actionError`'s `covered by <element>` uses it too. Playwright's preview of the covering element
     carries attribute values and maps only `\n` and `\t`. Measured on adbecd3: a covering element whose
     attribute holds the 6 other separators turned one error into 8 lines. It also showed raw ANSI codes
     (Playwright dims call-log lines and treats `\r` as a line break).
   - The ESC handling goes beyond the AC ("escaped like names": `jsonQuote` escapes every control).
8. **Security: "Target crashed" text no longer marks a tab crashed.** On adbecd3, an `evaluate` of
   `throw new Error('Target crashed')` marked the tab crashed, and every later call was refused.
   - `toError` maps to the crashed-tab error only when `tab.crashed` is set.
   - Crash wording ("Target crashed", "page crashed") is now only a reason to look. `crashCheck` in the
     dispatcher asks the browser, bounded by the call deadline, at most 2 s. The evidence is the page's
     `crash` event, or `crashedSoon`'s own evaluation of `1` (which page script cannot make fail)
     rejected as crashed.
   - A live renderer answers in ms, so the page's text is then shown as its error. R6 still holds: a
     crashed renderer rejects the probe at once, or fires `crash`.
   - The hint and text of the crashed-tab error are unchanged.

Changed existing tests (each because an AC required it):
- `test/unit/dispatch-crash.test.ts`: the fake tab gets a renderer. Its three tests keep their assertions;
  their tab's renderer is crashed (its evaluations reject as crashed), because the text alone no longer
  counts (item 8). Added: the crash event arriving after the error, and three live-renderer cases that
  must not be marked crashed.

Amendments:
- **README.md** is not in this round's file list. Its navigate and timeout text described the old error,
  so it was edited: the settle paragraph, a **navigate** bullet, the timeouts bullet, the alert item, and
  one row of the error table.
- **d1r AC, how it is read.** `d1r.mjs` always navigates a second time, whatever the first answer says.
  So the AC is measured with `d1r-follow.mjs`, which follows the answer: it navigates again only if the
  answer is an error whose hint invites it. On adbecd3 that is 5 of 5 double hits; here the first answer
  is a success and nothing is followed.

Verification (Chrome 155, headless, macOS). adbecd3 is the build at `/tmp/x2b-r5n-base`; the fix is dfeee36,
plus a docs-only 4252717. Scripts and logs are in `/tmp/x2b-r5n-t/` (`summarize.py <base|final>`). These
are self-measured; the independent re-check is still to come.

| Check | adbecd3 | fix |
| --- | --- | --- |
| `d1v.mjs /never`, the reviewer's 12 committed delays | 12 of 12 errors | 0 errors |
| `d1v.mjs`, full default sweep (49 runs) | (reviewer: 7 flagged) | 0 flagged. 9 honest errors: the queue left under 100 ms and the tab stayed on /start |
| `c1e-full.mjs` x3 (9 queued navigates) | 0 errors | 0 errors |
| /poll variants: `c1e-poll.mjs` (14) + `d1v` window (30) | 5 false errors | 0 false errors (14 honest) |
| `ph.mjs`, a commit after the stop | 4 of 4 false errors | 0 of 5 |
| `d1r-follow.mjs`, 5 runs | 5 double hits | 0 double hits, 0 errors |
| `r6.mjs`, 10 runs | 0 crashed (ERR_ABORTED) | 10 of 10 crashed; `r6-timing`: 264-299 ms |
| click nit (`d1v` click sweep) | 0 of 16 `→ navigated` | 15 of 20. The 5 misses committed after the answer was sent (busy >= 3600 ms) |
| `nav-r5`, `sec-r5` (end to end) | 8 of 8 and 2 of 2 red | green |
| `security-r5` (unit) | 22 of 24 red (the 2 `\r\n` cases were already handled) | green |
| core-r3, core-r4, core-r4c, nav-r5, sec-r5, R (R6, R15), S, unit | | 621 of 621 pass |
| full suite (`npm test`, alone, 4252717, 296 s) | | 899 tests: 898 pass, 0 fail, 1 skipped (A5, headed only) |

### 2026-10-23: fix round 5 (page)

Source: the independent re-checks of round 4 (performance scripts `/tmp/x2b-r4rp/scripts/`, correctness
`/tmp/x2b-r4rc/t/e1b.mjs`). Tests: `test/regress/page-r5.test.ts` (fixtures `inline-host.html`,
`deep-chains.html`, `shadow-long.html`) and `test/unit/secrets-r5.test.ts`. Red-first against adbecd3 with
`X2B_TEST_ENTRY=/tmp/x2b-r5p-base/dist/index.js` (page) and `X2B_TEST_SRC=/tmp/x2b-r5p-base/src` (unit):
page-r5 7 of 10 red, secrets-r5 2 of 4 red; the green ones are pins (named-slot find order, display:none
inside an inline wrapper, find at depth 200, in-word scrubbing). Timings below were taken on a machine at
load average 250-380, interleaved with the base build; absolute numbers are inflated, ratios are the
evidence. The test bounds are looser than the AC for the same reason.
1. **Item 1, `read` linear on nested `display:contents`.** `hasBlockChild` is memoised per `read` call
   (`blockMemo` in `read.ts`), so each element is classified once. Ten chains 800 deep: 6444 ms on adbecd3,
   99-136 ms here, against 101 ms for the pre-round-4 build in the same run (the review measured that build
   at 15 ms, so the AC's 40 ms is met by the same ratio; not measured on an idle machine: unknown).
2. **Item 2, `find` with shadow DOM.** `read-text.ts` builds one composed pre-order index (enter/exit per
   element, an iterative walk) on the first compare of a call on a page with shadow DOM; `composedCompare`
   and `composedContains` are O(1) for indexed elements and fall back to the ancestor-chain walk otherwise.
   `contextFor` takes one landmark map per call instead of rebuilding it per hit. `find limit=200`, 3000
   sections: plain 720 ms, one banner host 368 ms (adbecd3: 760 / 1682). 10k sections slotted into one host:
   1290 ms against plain 2434 ms (adbecd3: 7480 / 3339). Within +20% of the no-shadow baseline in both.
3. **Item 3, inline hosts.** An inline element (not `a`, not `br`) whose composed subtree holds a
   block-level element is walked as blocks, so slotted `p`, `div`, `li` and headings stay separate whatever
   the host's display. The block check descends through `display:contents` and inline wrappers and skips
   `display:none` (a hidden span no longer splits a line). The same applies to an unknown light-DOM element
   (`<x-plain><p>..</p><p>..</p></x-plain>` was glued too). Not changed: an `<a>` around blocks is still one
   link, and blocks inside a list item, table cell or heading are still read inline.
4. **Item 4, amendment: no truncation in `read`.** Reality contradicts the finding: the reviewer's
   `deep.mjs` page builds its chain in `connectedCallback`, and Chrome stops that recursion at 43 hosts
   (evaluate: 43 hosts, the 44th has no shadow root). `read` printed every level that existed. Built
   iteratively, a chain of 250 hosts reads all 250 levels on adbecd3 and here; at 400 or more the tab
   crashes before `read` runs (Chrome, not the walker). The snapshot walker has no depth cap of its own,
   so nothing was changed; page-r5 pins 200 levels. Its red on adbecd3 comes from item 3 (the hosts are
   inline, so the levels were glued), not from depth.
5. **Item 5, scrubbing linear on backslash runs.** `backslashesBefore` reads a run-length table filled
   left to right once per string (`runs` in `secrets.ts`). 100k backslashes against a six-backslash
   secret: 16 s on adbecd3 (2.1 s in the review), 9 ms here. 80 000 random strings over backslashes,
   escapes and the secret's encoded forms scrub identically on both builds.
6. **Item 6, in-word secrets.** Not targeted; it fell out of item 5: 1.6 MB of in-word occurrences
   267 ms on adbecd3, 124 ms here.

### 2026-10-23: fix round 5 (sec)

Third round in which a page-planted engine (`window[Symbol.for('x2b.engine')]`, top page or cross-origin
iframe) forged server lines; this time `fill_form`'s `not a fillable field` error printed the engine's
`kind().tag`/`.type` raw (repro `/tmp/x2b-r4rs/t/f2.mjs`). Closed at three levels:
1. **Boundary guard (`src/page/engine.ts`).** The page side runs every engine call inside try/catch and
   returns one primitive string (`R` + JSON of `[docId, value]`, or a flag for no-engine / throw), so no page object is
   serialised by Playwright and no page getter runs outside the try. A page throw becomes a fixed
   ToolError (`the page's script engine failed (<method>)`); the page's message is never printed (only the
   real engine's `x2b:stale` maps to `the element was removed from the page`). Node parses the JSON in a
   try (a SyntaxError quotes its input) and coerces the value to the method's shape: `SHAPES` is typed
   over every engine method (a new method without a shape does not compile). Strings stay strings (no
   newline stripping: read's body and names are escaped by their printers); `kind.tag`/`type` must be
   bare tokens (else `''`); node ids positive integers, roles from the vocabulary, attributes only the
   known `SnapAttrs` fields; `hasText` and booleans are strict; `serialize.nodes` keeps marker positions
   (an invalid node is a hole, never shifted). `docId` is a ref key only: a string is kept as given (so it
   equals what `refHandle` compares in the page, which applies the same `typeof === 'string'` test); a
   non-string becomes `x2b-bad-doc`, and that frame's refs answer old-doc. Two hostile frames that share
   the fallback (or pick the same string) can confuse only each other's refs: attacker against attacker,
   accepted. `refHandle`/`handleFor` run `byId` inside a try. `safeNode`/`safeNodes`/`pageCount` moved here (re-exported by snapshot.ts).
2. **Call sites.** The audit below; fixed: `fill_form` (`kindLabel`: `<tag type=…>` only as tokens, else
   `element`; `safeRole` on the role; option and radio labels through `q`; the user's value through
   `jsonQuote`), `video.ts` `refFor` (`safeNode` before `issueRef`), `snapshot.ts` child-frame `idOf` ids.
3. **Standing matrix: `test/regress/forged-lines-matrix.test.ts`.** Any new tool, engine method or output
   path is added there in the same change (see its header). 70 cases (3 frame-specific), each in the top frame and a cross-origin iframe (whose
   engine's docId is a forged string), plus navigate and tabs, plus 14 tests on an engine whose docId is
   not a string (155 tests, about 30 s). 14 success paths must succeed (proof the hostile engine was
   driven). Oracle scope: read's body is page content, so its element-shaped lines and `e99999` are not
   checked there (page markdown may hold `- item`); its marker lines (`[tN]`, `→ `, `hint: `, `notice:`,
   `## step N`) are, since read escapes them.

**Audit: every place engine data reaches output text (24).** S = safe by its printer, G = also by the guard.
1. snapshot `title` -> header (`snapshotHeader`: jsonQuote, clip) S G
2. snapshot `nodes` role/name/attrs -> element and text lines (`elementLine`: safeRole, q, formatAttrs) S G
3. snapshot `omitted`/`offscreen` -> footers (`pageCount`) S G
4. snapshot `iframes`/`droppedIframes`, child-frame `idOf` -> frame stitching (ints; fixed: `idOf` ids) G
5. snapshot `url` -> never printed (Playwright's URL) S
6. `describe` (selector target, re-resolve) -> `t.desc` in every action header and error (`describeShort`) S G
7. ref registry role/name (issued from safe nodes) -> `describeShort` in click/hover/drag/press/type/upload/scroll/fill_form/screenshot/video S
8. `resolveUnique` -> handleFor (int, not printed) G
9. strict listing `describe` -> `nodeLine` S G
10. `find` hits and context -> `nodeLine`; iframe context `describe` -> `elementLine` S G
11. `read` title -> header; body -> `escapeServerLines` (page text, markers escaped) S G
12. `serialize` json -> `safeEngineJson`; nodes -> `nodeLine` by marker index S G
13. video `describe` -> `issueRef` -> `video list` and later descriptions (fixed: `safeNode`) S G
14. fill_form `kind().tag/type` -> `not a fillable field` (fixed: `kindLabel`) S G
15. fill_form `kind().options` labels -> `no option … (options: …)` (fixed: `q`) S G
16. fill_form `kind().group` labels -> `no radio option …` (fixed: `q`) S G
17. fill_form `kind().group` ids, `labelId` -> handleFor (ints) G
18. upload `kind()` -> branch only G
19. scroll `scrollState` -> `scrolled y=…/…` (`safeState` numbers) S G
20. wait `hasText` -> condition only (strict boolean) G
21. screenshot `annotate`/`unannotate`, fill_form `setValue`, type `caretToEnd` -> ignored or error path G
22. effects `quiet().live` / `liveTexts` -> `→ alert` (`effect.alert`: jsonQuote, clip) S G
23. every engine throw -> `actionError`/dispatch `firstLine` (was raw page text; now a fixed message) G
24. `docId` (ping and every call) -> ref keys only, never printed G

**Red on adbecd3** (`/tmp/x2b-r5s-base/`: a detached worktree of adbecd3, built, with this test file
   copied in): 17 of 155, green here (155/155).
Top frame: scroll (container whose engine throws), click (describe throws), type append (caretToEnd
throws), upload (kind throws), fill_form not fillable (forged tag/type), not fillable (forged file
type), video str, kind throws, batch. Cross-origin iframe: the same except `click describe throws`
(that case is top-only, since a selector cannot reach the iframe).

**Left for the owners of off-limits files** (unreachable from engine calls now; still reachable from
other paths): `util/errors.ts firstLine` splits on `\n` only (should split on `LINE_BREAK`);
`dispatch.ts` runs `isCrashError` (any `Target crashed` in a message) before the ToolError branch, so a
page-chosen message containing it could mark a tab crashed; `tools/common.ts actionError`'s
`covered by <…>` quotes Playwright's log, which holds page markup (attribute values with U+2028; not measured).

### 2026-10-23: fix round 6

The last fix round, from the final re-checks of main 7789a38: correctness (`/tmp/x2b-r5rc/t/`) and security
(`/tmp/x2b-r5rs/t/`). One implementer owned all files. Tests:
- `test/regress/r6.test.ts`, end to end: each item's test was red on 7789a38 (`X2B_TEST_ENTRY`);
- the forged-lines matrix's new hostile dimension;
- `test/unit/nav-r5.test.ts`, `security-r5.test.ts` and `dispatch-crash.test.ts`, updated.

Measured with Chrome 155 and Playwright 1.64.1.
1. **D1 regression (critical): only a new document's commit counts** (`navwatch.ts`). Round 5 counted any
   main-frame `framenavigated` on a requested URL. A same-URL navigate or reload therefore took the old
   page's `history.replaceState(location.href)` for the commit: 6 of 6 runs of `d1s.mjs` answered
   "navigated … Loading", and the page reloaded later.
   - A commit now counts only on a requested URL whose response has arrived. A network document commits
     after its response; in every probe the response event came first. A commit seen up to 200 ms
     before its response is credited when the response comes.
   - A goto's non-network target (data:, about:, file:) or a history entry's URL counts without a
     response.
   - `anyCommit` is gone. Same-document changes (`pushState`, `replaceState`, a fragment) never count.
2. **back and forward name both URLs, and never guess "no earlier history entry"** (items 2 and 3).
   - They read `Page.getNavigationHistory` first. No entry means the error, before anything navigates.
   - Then `Page.navigateToHistoryEntry`, waiting for this watch's commit. Playwright's `goBack` resolves
     on any main-frame navigation event, so a page that kept calling `replaceState` made it resolve at
     once: "no earlier history entry", and the tab landed later (3 of 3).
   - Errors read `navigation back to <entry> … the tab shows <url>`.
   - If the history cannot be read, Playwright's `goBack` is the fallback, and its old check now says
     "may still be in progress".
3. **Click nit (item 4):** the late-commit wait also runs when settle ends with less than
   `NEAR_DEADLINE_MS` (1 s) left. Before, it ran only when the deadline cut settle short. Far from the
   deadline it never runs: an unqueued call ends settle with at least 1.2 s left.
4. **Download (item 5):** Playwright's "Download is starting" (from Page.navigate's `isDownload`, browser
   side) answers `[tN] <url> started a download: "<file>"` with no error. The file name is JSON-quoted;
   `→ download …` follows once the file is saved. No snapshot is attached.
5. **Engine rejections (item 6, critical):** Playwright's main-world evaluate runs `globalThis.eval(…)`, so
   a page that replaces `eval` writes the rejection's message. `mainWorldError` (engine.ts) maps every
   main-world rejection (engine calls, install, ref and element lookups, point mapping, the pixel-ratio
   reads, video) to our own error:
   - a lost context, a closed page and a crash become fixed canonical texts the callers recognise;
   - anything else becomes `the page's script engine failed (<operation>)`.

   Defense in depth:
   - `actionError`'s fallback and the dispatcher's generic branch print an unknown error's first line only
     JSON-quoted (`error: "…"`);
   - `evaluate` prints `page exception: "<message>"`.
   The matrix's hostile dimension found the `actionError` path through fill_form: 4 of 18 environments red
   before that change.
6. **Crash probe (item 7):** `crashedSoon` asks through CDP (`Runtime.evaluate` of `1` on the tab's own
   session), never through Playwright's evaluate. Only the page's `crash` event marks a tab crashed. A
   page's own crash wording on a live tab answers "the page's script failed (it reported a crash, but the
   tab answers)". R6 still holds: 10 of 10.
7. **Item 8:** the covered-by preview is `jsonQuote`d (after dropping Playwright's ANSI styling).
8. **Item 9:** the caller's URL is echoed through `escapeControls`, in every navigate error and in the
   refusal. Item 10: `escapeControls` escapes all C0 (tabs too), DEL and C1. `jsonQuote` (format.ts)
   escapes DEL and C1 too; `JSON.stringify` already escapes C0.
9. **The matrix's hostile environment (item 11).** The real engine on a page that replaces each of `eval`,
   `JSON.stringify`, `Array.prototype.map`, `Array.prototype[Symbol.iterator]`, `String.prototype.replace`,
   `Object.defineProperty`, `Function.prototype.call`, `Function.prototype.apply` and
   `Promise.prototype.then`. Each is replaced at load (before our engine installs) and once our engine
   exists (after). Plus `eval` replaced in a cross-origin iframe.
   - Every tool runs against each, with the same oracle.
   - Also checked: the tab is never marked crashed, and it works again once it leaves the page.
   - 19 environments; the matrix is 174 of 174 green.

10. **The queue 0-70 ms cases (`d1q.mjs`).** A navigate whose turn leaves less than `MIN_COMMIT_MS` (50 ms)
    for the commit, after the 300 ms stop margin, no longer starts the navigation. It answers
    `navigation to <url> not started: the call waited behind earlier calls on this tab until no time was
    left; the tab shows <url>`, and nothing is requested. Round 5 started it and stopped it 1 ms later, and
    a fast page could commit before the stop landed: 1 of 26 "error but landed" in the re-check. The
    `r6.test.ts` d1q test only checks that both outcomes are consistent: the race is not deterministic,
    so the 10 runs of `d1q.mjs` are the evidence.

11. **A click whose timeout comes after it started a navigation** (found by `d1v.mjs`: `click:#go`
    busy=3700, 1 of 490 calls). Playwright's click with a capped timeout of 54 ms dispatched the click and
    then reported its timeout. The answer was an error with a retry hint, while the tab went to /poll.
    - `ActionOptions.timeoutAfterNavRan` (set by click): such a timeout, followed within 100 ms by a
      main-frame navigation request of this action, means the click ran. It is reported with its effects
      (`→ navigated` once committed), never as an error that invites a second click.
    - A timeout without a navigation stays an error.

Changed existing tests (each because an AC required it):
- `test/unit/nav-r5.test.ts`: the `anyCommit` case became the history-entry case. "already committed"
  gets its response first (item 1). Added: the d1s same-URL `replaceState`, and the commit credited when
  its response trails.
- `test/unit/security-r5.test.ts` and `test/regress/sec-r5.test.ts`: the covered-by preview is quoted now
  (item 8).
- `test/unit/dispatch-crash.test.ts`: the probe goes through CDP. The fake renderer answers `Runtime.evaluate`
  (live), or never answers and fires `crash` (crashed); its evaluate always throws "Target crashed", which
  must change nothing (item 7).

**Known limitation and next step (item 12).** The engine runs in the page's main world. A hostile page can
therefore always subvert it for its OWN frame:
- it can lie about its own content (the snapshot, find and read of that frame);
- it can make actions on its own elements fail (`the page's script engine failed`).
What it must never do, and what the matrix holds:
- forge server lines;
- affect other frames or tabs;
- mark a tab crashed;
- make our output print its text outside a JSON string.
The proper fix is an isolated world: install the engine with CDP `Page.createIsolatedWorld` per frame and
evaluate there, so page script cannot replace our builtins or `eval`. It is recorded as a separate future
task, not part of this round. It touches every engine call site, the ref/handle plumbing and the CSP-safe
install.

Residual, not in this round's items and measured: URLs are printed unquoted. The grammar prints them
unquoted (`→ url`, headers, `the tab shows`), and so do navigate's errors (escaped since item 9).
- A URL the page sets (`replaceState` to `?q=%E2%80%A8[t1]%20navigated…`) or one the caller passes can
  therefore carry marker-like text in the middle of a line, never at its start.
- `s4-fixes.mjs`'s stricter oracle (FORGED anywhere outside a JSON string on a marker line) flags 8 such
  lines. 3 page-set URLs were flagged on 7789a38 too; there the 5 caller URLs still started new lines.
- Quoting URLs would change the snapshot grammar, and is left for the isolated-world task's review.

Verification (Chrome 155, headless, macOS). 7789a38 is built at `/tmp/x2b-r6-base`. The fix runs from a
build snapshot (`/tmp/x2b-r6-fix`), and the reviewer's scripts are copied to `/tmp/x2b-r6-t/`
(`summarize6.py`). Self-measured; the independent re-check is still to come.
- `r6.test.ts`: 7 of its 8 tests red on 7789a38; the d1q test is a consistency guard. Green here.
- Forged-lines matrix: 174 of 174, including the 19 hostile environments. Before `actionError`'s quoting,
  4 of those environments were red.
- Security repros on 12fa548: s1, s2, s3, s5, s6 have 0 offences, and no tab is marked crashed. s4 has the
  8 URL lines above.
- 10 runs each, on 095748f; the click fix at 12fa548 changes only click:
  - d1v: 1 flagged of 490 calls (a click, item 11).
  - The /poll window: 0 of 300.
  - c1e: 0 false errors of 30.
  - d1r: 0 errors and 0 double hits of 30.
  - d1s: 0 false successes and 0 reloads of 60.
  - r6: 100 of 100 crashed.
  - d1q: 0 bad of 260.
  - d1n2 and d1n: every case gave the same outcome in all 10 runs.
- Rerun 10 times each on 12fa548:
  - d1v: 0 flagged of 490 calls (90 honest errors, where the queue left the navigation no time);
  - the /poll window: 0 flagged of 300;
  - clk: 220 of 220 clicks report `→ navigated`.
- Full suite (`npm test`, alone, on ac27754, 346 s): 1097 tests. 1096 pass, 0 fail, 1 skipped (A5, headed only).

### 2026-10-26: fix round 7

The round-6 re-checks of 2c45028 (correctness `v1`/`v1b`/`v2`/`v4`; security `r2d`, `r2e`, `r6-shadow`, `r1`,
`r3`, `r2c`). One implementer owned all files. Tests:
- `test/regress/r7.test.ts`: 8 tests, all red on 2c45028 (`X2B_TEST_ENTRY`);
- the forged-lines matrix: stricter oracle, a hostile `HTMLMediaElement.prototype.play`, a `video play` call;
- `test/unit/nav-r5.test.ts`, rewritten for document identity.
1. **A commit is a new document, never a URL match (items 1-3).**
   - `Tab.trackDocuments` enables the Page domain on the tab's own CDP session and tracks the main
     frame's `loaderId`. A commit is `Page.frameNavigated` for the main frame with another loaderId than
     the document had when the watch started (`watchMainNav`, now async).
   - Measured on Chrome 155:
     - a 302 hop never commits; only its final document does;
     - `pushState`, `replaceState` and fragments come as `Page.navigatedWithinDocument` and never count;
     - a bfcache restore is `Page.frameNavigated` of type `BackForwardCacheRestore` with the restored
       document's own loaderId. It counts, and navigate skips its load-state wait (no load events come).
   - A history step to a same-document entry counts only after Chrome starts it as `historySameDocument`
     (`Page.frameStartedNavigating`). A page's own `replaceState` to the entry's URL never counts (v2).
   - Applies to navigate (goto, back, forward, reload) and to every action's effects (`→ navigated`).
     A click on a link to the page itself that answers 204 reports no navigation (v4).
2. **Item 4: a frame never blocks the rest.**
   - Every fan-out over frames gives each frame `FRAME_BUDGET_MS` (500 ms, `inTime`, engine.ts): the
     snapshot's `frameElement` and child snapshots, find, wait text, the video search, screenshot
     annotate/unannotate.
   - A child frame that does not answer shows `- text "(frame unavailable)"` under its iframe line.
   - Audit: the other Promise.all/allSettled sites (`tabs list` 1 s per tab, downloads, popups, session
     close) were bounded already.
3. **Item 5: no text-based crash detection.** `isCrashError` is gone.
   - After any failed tab call (not a deadline), the dispatcher asks the browser: CDP `Runtime.evaluate`
     of `1`, raced against the page's `crash` event, at most 2 s within the deadline.
   - Only the crash event marks a tab crashed, so a page's or caller's "page crashed" text keeps its own
     error.
4. **Item 6: page text in video and error lines is JSON-quoted.**
   - `isVideo` runs through `mainWorld`.
   - Quoted: play() errors, track kind and lang, cue text, the dispatcher's timeout branch, and the
     `→ console` first error (`r3-builtins`).
   - Changed assertions: `E.test.ts` captions parse the quoted cue text; `format.test.ts` has the quoted
     console text.
   - The matrix oracle hides a quoted segment only if it is valid JSON with no raw control. Its forged
     texts carry `"x<ESC> e99999 y"` segments, so page text in balanced quotes no longer hides a token.
     The new hostile media environment is red on 2c45028 in 4 of 4 runs and green here.
5. **Item 7: one URL escaper.** `safeUrl` (every printed URL) percent-encodes whitespace, quotes, `<>`,
   backslash, backtick and the C0/DEL/C1 controls, before redaction (`<redacted>` stays readable).
   A data: frame's URL now prints as one token, and the read header parses.
6. **Item 8:** an engine answer over `ENGINE_ANSWER_MAX` (8 Mi chars) is refused before it is parsed:
   `the page's script engine answered too much (<method>)`.

7. **A queued click with almost no time left** (window sweep, `click:#go` busy=3800 ms, 2 of 300). The click's
   capped timeout of 37 ms dispatched the click and still timed out, with no time left to see the navigation
   it started. That gave an error with a retry hint, while the tab went to /poll.
   - A deadline-capped click now keeps `CLICK_RESERVE_MS` (150 ms) after its own timeout. That leaves room
     for round 6's `timeoutAfterNavRan` to see the navigation.
   - A click left with less than `MIN_CLICK_MS` (50 ms) is not attempted:
     `<target>: not clicked: the call waited behind earlier calls …; the tab shows <url>` with "nothing was
     clicked".
   - An unqueued click keeps its full `timeout_ms`.

**Repro scripts lost.** The machine restarted on 2026-10-24 and `/tmp` was wiped. That took the re-check
scripts in `/tmp/x2b-r6rc`, `/tmp/x2b-r6rs`, `/tmp/x2b-r5rc` and `/tmp/x2b-r4rc` (v1, v1b, v2, v4, d1q,
d1n, d1n2, r2d, r2e, r6-shadow, r1, r3, r2c).
- `~/x2b-repro-r7/` holds re-typed copies of the scripts whose full source was in the session transcript:
  `lib`, `d1v`, `c1e-full`, `d1r`, `r6`, `d1s`, `clk`.
- `cases.mjs` and `d1q.mjs` are reconstructions from the re-checks' descriptions and logs. `cases.mjs` covers
  v1, v1b, v2, v4, d1n and d1n2. It flags 7 of 22 cases on 2c45028 and 0 here.
- The security scripts were not reconstructed; their scenarios are in `r7.test.ts` and the matrix.

Verification (Chrome 155, headless, macOS). 2c45028 is built at `/tmp/x2b-r7-base`. Logs and scripts are in
`~/x2b-repro-r7/` (outside `/tmp` since the wipe; `summarize.py <tag>`). Self-measured; the independent
re-check is still to come.
- `r7.test.ts`: 8 of 8 red on 2c45028, green here.
- The matrix: 176 of 176 here. Its hostile media-play environment is red on 2c45028 (4 runs).
- Unit tests: 550 of 550.
- The security re-check scripts were not rerun: they are gone (see above).
- 10 runs each:
  - On aa88125 (the click change after it touches only click): c1e 0 false errors of 30; d1r 0 errors and
    0 double hits of 30; d1s 0 false successes and 0 reloads of 60; r6 100 of 100 crashed; d1q 0 bad of 260.
  - On a346837: d1v 0 flagged of 490; the /poll window 0 of 300 (2 of 300 before the click reserve); clk
    220 of 220 `→ navigated`; `cases.mjs` (v1, v1b, v2, v4, d1n, d1n2) 0 bad of 220.
- Full suite (`npm test`, alone, on a346837, 382 s): 1107 tests. 1106 pass, 0 fail, 1 skipped (A5, headed
  only).

### 2026-10-26: fix round 7b

The round-7 re-check of c052783 (`docs/reviews/recheck-r7.md`): two criticals (C1 security, C2 correctness)
and two warnings on the same surface (W1, W2). One implementer owned all files. This is the one fix round
allowed for these criticals. Tests:
- `test/unit/secrets-r7b.test.ts` (C1, against `X2B_TEST_SRC`): a scenario table and the review's rows;
- `test/regress/r7b.test.ts` (C1 at the printed-URL sites, C2, W2), end to end (`X2B_TEST_ENTRY`);
- the forged-lines matrix: a planted-marker scenario (W1), a fake engine that sends the mark, and an oracle
  rule for it.

1. **C1 (critical, security): `safeUrl` claims the raw URL before it encodes** (`src/util/secrets.ts`).
   - The cause: round 7 percent-encoded first and redacted after. A remembered secret next to a character
     it encodes (`'`, `\`, `"`, a space, a control) got a hex digit glued to it (`#%27Hunter2xZ%27`), and the
     whole-token rule refused it. Chrome's own escapes (`%60`, `%3C`) did the same on every build.
   - One walk over the raw URL now marks what to redact, in order:
     1. the values of secret-named parameters (the rules of `redactUrlParams`, unchanged);
     2. every URL spelling of every remembered secret. In `urlPattern`, each code point is either itself or
        the percent-escapes of its UTF-8 bytes, with hex in either case, and a space is also `+`. So Chrome's
        own serialisation matches (measured on Chrome 155: `O%27Brien!26` in a query, `p@ss%20word` in a
        fragment), and so do encodeURIComponent, form encoding and any mix. The JSON spelling is kept too.
   - Inside a printed URL a `%XX` escape is one unit and a token edge: a secret next to one is redacted. A
     match that starts or ends inside an escape takes the whole escape (`7Hunter2xZ` in `#%27Hunter2xZ`
     prints `#<redacted>`), so a redaction never splits one. The whole-token rule still holds against raw
     letters and digits (`xHunter2xZ` is left alone).
   - Output: each marked run prints as one `<redacted>`, and everything else is percent-encoded as in
     round 7. A `<redacted>` in a printed URL is therefore always the server's: the page's own text prints
     `%3Credacted%3E`.
   - Applies to every `safeUrl` site (23: headers, `→ url`/`→ navigated`/`→ new tab`/`→ blocked`, tabs,
     network, console locations, the "not clicked", timeout and navigate errors). `displayHref` (`href=` in
     snapshot lines) uses the same rules without encoding, because it is JSON-quoted. So a page's own
     `<redacted>` text can appear in an `href=`, never in a `safeUrl` site.
   - `scrubSecrets` (all other text) is unchanged (AC4): an escape is not a token edge there, and the URL
     spellings are not matched.
   - Found on the way: `rememberSecret` threw `URIError` on a lone surrogate (`encodeURIComponent` in
     `encodedForms`). It now keeps the raw and JSON spellings.
   - Cost, measured: 2 MB `data:` URL dense in escapes, 64 remembered secrets: 119 ms (c052783: 222 ms); no
     secret: 65 ms (the same); 10,000 short URLs with 64 secrets: 30 ms (c052783: 74 ms).
2. **C2 (critical, correctness): "did not answer within the budget" is a third state** (`askFrame`,
   `src/page/engine.ts`).
   - The cause: round 7's `inTime(…, fallback)` read a frame that did not answer in 500 ms as "not there".
     So `wait text_gone` succeeded at ~502 ms while the text was on a busy page (10 of 10), and `find` printed
     a clean "0 hits".
   - `askFrame` keeps three states apart: answered, unanswered, and gone. A failed call is unanswered (a
     frame mid-navigation, a broken engine) unless the frame is detached by then; a gone frame holds nothing.
   - **wait** (`text`, `text_gone`):
     - Each poll tick asks every frame. One in-flight ask per frame is reused across ticks, so a busy frame
       is asked again only after it answered: an evaluate is never cancelled, and one per tick would queue
       dozens in it.
     - `text` succeeds as soon as an answering frame holds the text.
     - `text_gone` succeeds only on a tick where every frame answered and none holds it. A frame that did not
       answer is asked again within the timeout.
     - The timeout error names them: `… timed out after 2000ms; 1 of 2 frames unavailable (no answer within
       500 ms): f2`, with a hint that such a frame may still hold the text.
     - A tick may end past `timeout_ms` by at most its budget, never past the call deadline (`capMs`).
     - A crashed tab answers `tab tN crashed`, never "gone" (round 7 read it as gone).
   - **find**: the main frame is unchanged (its failure is the answer). It returns the hits of the frames
     that answered, counts the rest in the header and names them on the line after it:
     ```
     [t1] find "Pay": 0 hits; 1 frame unavailable (untrusted page content)
     not searched: 1 frame unavailable (no answer within 500 ms): f2; find again, or snapshot
     ```
     The `(no matches; …)` line comes only when every frame answered. The iframe context line of a hit has
     a frame budget, because its parent may be the busy frame.
   - **video**: `video list` and the default-video search (`no video on the page`) add
     `; 1 frame unavailable (no answer within 500 ms): f2` to their frame count. They no longer print a
     clean "0 videos".
   - Not changed: screenshot annotate. A frame that does not answer gets no labels in the image, and nothing
     printed decides on it.
   - `fN` is the frame id the snapshot prints on that frame's iframe line.
3. **W2: a frame that answers shows its content** (`src/page/snapshot.ts`).
   - The cause: round 7 gave a child frame 500 ms for its whole subtree, so a frame that answered but held a
     hanging child was marked unavailable with all its content (s4b, every run).
   - Now a child's budget covers its own answer and the mapping of its iframes. Its children are asked once
     it answered, each with its own budget, and only a frame that did not answer is marked.
   - The whole tree below the snapshot's own frame ends `FRAME_TREE_MS` (1.5 s) after that frame answered,
     so a chain of frames that each answer just in time stays bounded. The mapping evaluate in the parent
     frame now has a budget too.
4. **W1: the mark is an attribute only the server prints.**
   - **Snapshot grammar amendment:** attribute 17 is `unavailable`. It follows `frame=fN` on an iframe line
     (`- iframe "Ad" e14 frame=f2 unavailable`), and only there.
   - It marks an iframe whose content is not shown: the frame did not answer within its budget, its call
     failed, or no frame could be matched to the iframe (then the line has no `frame=`).
   - Round 7's `- text "(frame unavailable)"` line is gone: a page text node printed it byte-identically.
     Page text is always quoted, and `safeAttrs` passes only the known engine fields, so a page cannot
     produce the attribute.
   - `test/support/grammar.ts` parses it. The matrix's fake engine now sends `unavailable: true` on every
     node, and its oracle refuses the mark on any line that is not an iframe.

Changed existing behaviour, each because an AC required it:
- `wait text_gone` never succeeds while a frame is silent. A frame that never answers (a sandboxed or
  scriptless `about:blank`) therefore makes it time out, naming that frame (README "Frames").
- A child frame whose snapshot call failed (navigating) is marked `unavailable`; before, it printed no
  content and no mark.
- `find`'s header gains `; N frame(s) unavailable` and its `not searched:` line when frames did not answer.

**Backlog (from the round-7 re-check)**, not fixed in this round:
- `nav.tracking` is never read: if document tracking fails, back/forward can report "stopped" while the tab
  moved (correctness, warning "from reading only").
- The `console` tool prints raw ESC/DEL/NUL and lone surrogates in `messageText` (security, pre-existing,
  `src/tools/console.ts:15`).
- `inTime` does not cancel the underlying evaluate (security, "not checked", nit). `wait` now reuses one ask
  per frame; snapshot, find and video still leave one evaluate running in a busy frame per call.
- The 8 Mi answer cap is per answer, so N frames can allocate N × 8 Mi at once (security, "giant answers").
- A click whose `history.back()` lands in bfcache takes 10.7 s (correctness, "already on base").
- "no element matches" is shown when the queue used up the deadline (correctness, "already on base").
- A slow `window.open` popup is not reported, then becomes the active tab (correctness, "already on base").
- A cross-origin iframe's renderer exit is unchecked (security, "not checked: OOPIF renderer exit").
- Future task: move the injected engine into an isolated world with `Page.createIsolatedWorld` (round 6,
  item 12; security, "hostile-builtin matrix beyond play()").

Residual:
- By design (AC4): outside printed URLs, a secret next to a percent-escape in page text
  (`- text "%27Hunter2xZ%27"`) is still not a whole token. The dispatcher's safety net `redactPrintedUrls`
  (URLs inside other text) applies only the parameter rule.
- Wording: a `wait` queued behind other calls asks frames with what its deadline leaves (`capMs`). That can
  be under 500 ms, and a frame that did not answer in that shorter time is still reported as "no answer
  within 500 ms". This happens only with less than 550 ms of the call deadline left; the state is right,
  the number is not.

Verification (Chrome 155, headless, macOS). c052783 is built at `~/x2b-r7b-base` (outside `/tmp`). The fix
runs from a frozen copy, `~/x2b-r7b-fix` (REV e117297). The reviewer's scripts were copied to
`~/x2b-r7b-repro/` and changed only in where they point:
- `run-sec.sh`, `run-corr.sh` and `summarize.py <label>` run and summarise them;
- `--headless --isolated` throughout.
Self-measured; the independent re-check is still to come.
- `secrets-r7b.test.ts`: 40 of its 67 tests red on c052783, all green here. The 27 green on both are guards:
  - AC3 parity: with no secret remembered, the output is byte-identical to round 7's;
  - AC4;
  - the whole-token negatives;
  - the raw and upper-case spellings inside a secret, which c052783 already caught.
- `r7b.test.ts`: 7 of 8 red on c052783, green here. The 8th, `wait text` appearing while another frame is
  busy, is a guard.
- The matrix: 177 of 177. Its planted-marker scenario is red on c052783.
- `r7.test.ts`: 8 of 8. Unit tests: 617 of 617.
- The reviewer's security repros, c052783 → here:
  - `sec-unit`: 10 of 11 cases leak → 0;
  - `sec-unit2`: 3 of 5 → 0;
  - `secret-raw`: 3 of 3 → 0;
  - `secret-e2e`: 2 leaking results → 0.
- The reviewer's correctness repros, 10 runs each, c052783 → e117297 (`summarize.py before|after`):
  - `s4e`: 100 of 100 `wait text_gone` calls answered "gone" while the text was on the page → 0 of 100. Both
    the busy-frame and the busy-main-frame cases now time out naming the frame (2.3 s and 2.9 s with
    `timeout_ms` 2000; the main case waits for round 7's crash probe, as c052783 did with its own timeout);
  - `s4d`: 30 of 30 clean "0 hits" → 0 of 30. Now `0 hits; 1 frame unavailable` with the frame named;
  - `s4b`: `/nested` and `/nested-same` showed the answering frame's content 0 of 10 each → 10 of 10 each,
    with only the about:blank#x frame marked. That costs 545 ms (c052783: 513-532 ms). `/nestedok` 10 of 10
    on both.
- The "not clicked" error on a queued click (`notclicked.mjs`): c052783 printed the secret in 5 of 5 → 0.
- Full suite (`npm test`, on ce1a59a, 403 s): 1183 tests. 1182 pass, 0 fail, 1 skipped (A5, headed only).
  "Alone" means no other run of mine; other sessions' Chrome processes were up (load 3.6 → 6.3 during it).
  The commit after ce1a59a is this PLAN text only.

### 2026-10-26: re-check of round 7b, round 7 closed

The independent re-check of ef2f9a0 (correctness on flow-verifier-high, security on flow-verifier-max; their own
scenarios, not the author's tests; logs in `~/x2b-r7brc-corr/` and `~/x2b-r7brc-sec/`) closed both criticals.
Round 7 is closed. Per the stopping rule, the non-critical findings below go to the backlog and open no round.
- **C1 closed.** The reviewer's earlier scripts went to 0 leaks. Its new `e2e-sites.mjs` (5 secrets × 24 wrappers ×
  16 print sites) leaked 0 times on ef2f9a0 and 542–659 times per secret on c052783. A unit fuzz of 359,856 URLs
  found no escape split and no raw space or quote.
- **W1 closed.** No page text produced a `frame=fN unavailable` mark.
- **C2 closed.** 0 of 36 false "gone" or clean "0 hits" in a busy-frame matrix (c052783: 25 of 36). Every call
  ended within its deadline.
- **W2 closed.** s4b 10 of 10.
- **Real sites.** No frame was unavailable on 28 pages (Wikipedia, YouTube, GitHub, news sites, Reddit's
  wall pages). `wait text_gone` after a click worked 8 of 8, in at most 227 ms.
- **Speed.** navigate p50 127–130 ms, click p50 138–140 ms, the same as c052783.
- The matrix 177/177; parameter redaction 48/48, identical to c052783.

**Backlog, added by this re-check:**
- Secret matching costs URL length × secret length (`secrets.ts:90`, `:296`). A 1000-char secret with a 2 MB
  fragment makes `tabs` take 11 s and blocks other calls (c052783: 17 ms). Realistic secrets stay ≤111 ms.
  New in 7b; warning.
- Matching is one pass, so two touching secrets (`Hunter2%C3%A9Zebra99!`) can leave the first whole. Repeat the
  pass until nothing new is claimed. Also on c052783.
- **Priority:** text paths outside printed URLs (`read` links, console text, `evaluate` results) print a
  secret glued to a percent-escape (`?q=%27Hunter2xZ%27`). Same on c052783; the residual above names it.
- A GET form on a windows-1252 page prints `P%E4ssw%F6rd1`, and double encoding is missed. The "any URL
  spelling" claim of 7b's C1 is overstated for non-UTF-8 pages.
- A page can show its own `<redacted>` in `mailto:` or unparsable hrefs (nit). The final scrub can print
  `#%<redacted>` (cosmetic).
- Frames that never answer: an offscreen `loading=lazy` iframe until it is scrolled into view, an iframe
  whose src never responds, and `about:blank#frag`. `wait text_gone` times out on such pages even when the
  text is gone. A never-loaded lazy frame could count as empty. The README now names these frames.
- A cross-site iframe that re-navigates every 300 ms makes `text_gone` time out (5 of 6; timing, needs a quiet
  rerun).
- `video list` checks frames one after another: 25 hanging frames reach the 11.9 s deadline. Also on c052783.
- The "500 ms" wording in a deadline-capped wait (`engine.ts:116`) is wrong in both directions (nit).
- **Headed Chrome plays sound** (2026-10-26: in a headed run a YouTube consent click autoplayed
  with sound). Playwright passes `--mute-audio` only headless. Proposal: headed launches get `--mute-audio` by default,
  with a flag to allow sound. Audio is a v1 non-goal anyway.
- **`video frames` seeks far past YouTube's buffered range answer `not-ready`** on every build since 13fb319.
  Near seeks and `every_ms` work. A fix would play to the time, or use the page player's own seek. The README's
  video trap should name it.

### 2026-10-26: read keeps comment sections

Source: live probes of a www.reddit.com comment permalink
(the evidence notes are kept outside the repo). `read` returned the post body, then a bare number (the post's score),
and none of the comments; `find` saw them.
- **Cause.** Every comment sits in `<section aria-label="Comments">` (plain light DOM, nothing hidden;
  `pickRoot` correctly picks `main#main-content`). `isBoiler` dropped any element whose id, class or
  aria-label has the token `comments`, so the whole section went. This supersedes round 3's P2 line "It
  still drops a comments container".
- **Fix.** `comments` is no longer a boilerplate token, and `LINK_CONTENT_TOKENS` (P2's exemption for
  `a.comments`) is gone with it. A blog's `<section id="comments">` is read too, on purpose: an agent asked
  to read the page wants the comments. Every other token is unchanged, and tokens still match whole
  (`shadow`, `header`, `padding`, `loading`, `badge` are not `ad`).
- **Tests.** `test/regress/read-comments.test.ts` with fixtures `shreddit-permalink.html` (the live chain,
  post, score, inline scripts, empty faceplate siblings, a nested reply) and `read-sections.html` (blog
  comments, the whole-token guard, nav/footer/cookie/ad/ads/sidebar/share/related/newsletter still out).
  The permalink and blog tests were red on fba6f4f (4 of 5; the guard passes on both, as a guard should).
  Green on the fix: the new file 5/5, unit 617/617, `page-r3` (P1–P12) 20/20, `page-r4` 16/16, acceptance
  `R` 24/24, acceptance C8 1/1. Not run here: the full suite.
- **Review of b312f78 (not merged; two fixes, red on b312f78).**
  - *Usernames in aria-labels (critical).* Reddit labels each comment "Comment from <user> 4 days ago",
    so a user named `Cookie_Monster`, `ad_astra_fan` or `Share_Holder` dropped the whole comment and left
    its replies orphaned. Rule now: id and class tokens count as before; an aria-label counts only when it
    is at most 3 words and holds a token ("Advertisement", "Cookie consent", "Related posts"), and never
    on `role=article`, `<details>` or `shreddit-comment`. Tested with every boilerplate token as a
    username (three spellings each) on the permalink fixture, plus six boilerplate labels that must stay out.
  - *Comment footers.* A `<footer>` inside a comment (an ancestor with `role=article`, or whose id or class
    has the token `comment`, e.g. WordPress `li.comment`, `article.comment-body`) is content, so
    `footer.comment-meta` shows the author and date. A page footer stays boilerplate. Fixture
    `wordpress-comments.html`.
  - Results: `read-comments.test.ts` 31 of 38 red on b312f78 (all 29 token usernames, both WordPress
    formats; the guards pass on both), 38/38 on the fix. Unit 617/617, `page-r3` 20/20, `page-r4` 16/16,
    acceptance `R` 24/24, C8 1/1. Not run: the full suite.
- **Backlog (from the review; not fixed):**
  - GitHub comments become one list line each, so their code blocks are flattened.
  - A collapsed `<details>` comment shows only its author (its summary).
  - Two `<p>` in one `<li>` print glued together ("maraBLOG-COMMENT-ONE").
- **WordPress nicenames (follow-up, fixed).** WordPress puts a registered author's nicename in the comment's
  class (`li.comment.byuser.comment-author-cookie-monster`), and class tokens counted, so the comment dropped.
  Rule now: a comment itself (`role=article`, `<details>`, `shreddit-comment`, or an element with the whole
  class name `comment`) is never boilerplate by its id, class or aria-label tokens; boilerplate tags inside it
  still drop. Tightened from "has the token `comment`" to the whole class name, because the token rule would
  read a page-level `div.comment-ad` and `div.comments-sidebar`; both still drop. Tested with every token as a
  nicename (two spellings each). Results: `read-comments.test.ts` 29 of 68 red on b4c0d54 (exactly the 29
  nicename tests), 68/68 on the fix; unit 617/617, `page-r3` 20/20, `page-r4` 16/16, `R` 24/24, C8 1/1.

### 2026-10-26: batch shares the output cap per step

**Incident** (old.reddit, 2026-10-26): a 20-step batch (navigate + evaluate + wait, repeated) went past the
20,000-char cap. The dispatcher's generic cap (item 4 of the amendments) cut the tail: after step 13 the
output ended with `… output cut at 20000 chars`, and steps 14-20 had no header and no result although they
ran and navigated. The caller could not tell what to rerun.

**Rule** (`src/tools/batch.ts`, `shareOutput`). Tool 22 and item 4 keep applying when the output fits; this
replaces item 4's tail cut for `batch` only.
1. Output that fits (text parts plus one separator between parts, within the cap less any pending notices)
   is byte-identical to before.
2. Over the cap, every step keeps its header `## step <n>: <tool>` (` (error)`) and the first line of its
   result; an error step keeps every line up to and including its `hint:` line; a skipped step keeps
   `skipped`. Images are kept.
3. The rest of the cap is shared max-min fairly (water-filling): a step whose remaining text is under the
   even share keeps it whole, and what it leaves goes to the others. Each cut step's note is reserved first.
4. A cut body ends, after a blank line (which ends an attached snapshot block), with
   `… <k> chars cut from step <n> (rerun it alone, or use read/snapshot with offset)`; `k` is the number
   of that step's chars not shown.
5. Cuts keep the grammar (`cutResultText`/`cutResultLine` in `src/util/format.ts`): whole lines; the
   first line that does not fit is cut by `cutLine` when it is a snapshot line, dropped when it starts
   like a server line (`→ `, `hint: `, `notice:`, `[tN]`, `## step N`), else cut at a whole unit with an
   open JSON string closed by `…"` (never inside an escape or a surrogate pair). A cut keeps a prefix of
   each line, so escaped page text (`\## step 99`) stays escaped.
6. When the headers and first lines do not fit, only the headers (and `skipped`) are kept and the first
   lines share the budget too. When not even headers and cut notes fit (about 120 chars per step), the
   output is left to the dispatcher's generic cap.

**Remaining safety net.** The dispatcher still runs `capResult` over the batch result. It fires only if
text grows after the batch measured it: the final `scrubSecrets` replacing a password remembered during
this batch (`<redacted>` is longer than a short password) in an earlier step's text, or any other final
redaction that lengthens text. The generic tail cut then applies as before.

**Changed expectation.** R4 (`test/acceptance/R.test.ts`) expected `… output cut at <n> chars` from a
batch; it now expects the per-step note and all four headers.

**Tests.** `test/unit/batch-budget.test.ts` (AC3 byte identity written from the contract, shares, notes,
cuts inside JSON strings with escapes and surrogates, snapshot lines, dropped server lines, notices, the
floor); `test/acceptance/batch-cap.test.ts` (the incident shape: 20 steps over the cap; red on fba6f4f,
headers stop at step 7); the forged-lines matrix case `batch cut mid-body` (page text forging
`## step 99: navigate`, read twice in one batch).

**Amendment, review of cc50db4 (2026-10-26).**
- Item 1 (critical): `capResult` counted no separators between text parts (12 screenshot steps at cap 400
  joined to 404 chars, 5 of 12 headers, the last cut to `## step 5:`). It now counts one per part boundary
  and keeps whole lines only. Below the batch floor, the batch prints as many whole headers as fit (images
  kept) and one line `… steps <list>: no room; rerun them` naming the steps whose output or header did
  not fit; rule 6 above no longer hands over to the generic cap.
- Item 2: at the headers-only level a step's own first line is clipped (`cutResultLine(…, own)`), not dropped
  as a server line; an error keeps its cause and hint at every level; room a step cannot use is handed to
  the steps still cut (rebased on what each used, so the sum stays within the cap).
- Item 3: `… ` joins the escaped server-line prefixes (`escapeServerLines`, `SERVER_LINE_START`), so page
  text cannot print the cut note or a paging footer. Matrix: `… ` in MARKER, a forged note in every fake
  engine field, and `read` of a page printing the exact note and a read footer.
- Item 4: a cut drops a trailing backslash (no lone `\` line); the note gets a blank line before it after
  an image.
- Tests: `test/unit/batch-budget.test.ts` (describe blocks `review of cc50db4`),
  `test/acceptance/batch-cap.test.ts` (12 screenshots at cap 400), the matrix cases above; each red on
  cc50db4.

**Amendment, re-check of dc80dfe (2026-10-26).**
- Item 1: below the batch floor, "an error's cause and hint always survive" was not true (18 steps at cap
  1500 printed 377 chars, the error's cause and hint lost). The real rule: as many whole headers as fit,
  then the no-room line; when every header fits, the room left goes first to each error's cause and hint
  (whole, in step order), then max-min fairly to the other steps' first lines (clipped, never dropped). An
  error's cause and hint are guaranteed only while all the headers and they fit.
- Item 2: a result that starts with an image keeps its first text line (an error: cause through hint),
  pinned as its own part right after the image and counted in the fixed part, so it is never dropped at
  the first level and clipped, not dropped, at the headers-only level.
- Tests: `test/unit/batch-budget.test.ts`, describe blocks `review of dc80dfe`; both red on dc80dfe.

### 2026-10-26: secrets in text paths

Status: re-checked 2026-10-27 at ee4c863 (one critical, one warning); see "fix round 2" below. Branch `fix/secret-text-paths`, code at ee4c863,
worktree `-wt-secrets`, from main fba6f4f; main has since moved to 6da69a1 with bench results only (no file in common).
Three findings of the round-7b re-check (its backlog above), reviewer scripts in `~/x2b-r7brc-sec/`:
1. **Priority.** `read` links, console text and `evaluate` results print a secret glued to a percent-escape
   (`?q=%27Hunter2xZ%27`). Repro `text-paths.mjs`; also on c052783. The 7b residual "by design (AC4)" is reversed.
2. Matching is one pass, so two touching secrets (`Hunter2%C3%A9Zebra99!`) can leave the first whole. Repro
   `unit-pairs.mjs`.
3. Matching costs text length × secret length (`secrets.ts:90`, `:296`): a 1000-char secret against a 2 MB fragment
   made `tabs` take 11 s and block other calls (c052783: 17 ms). Repro `perf-e2e.mjs`.

Acceptance criteria (from the brief):
1. Every output path redacts a remembered secret, in its literal, percent-encoded or JSON-escaped spelling, when it
   sits next to a percent-escape (`%XX`, either case): `read` text and link URLs, console messages, `evaluate`
   results, snapshot text and values, `find`, `network`, `tabs`, the effect lines and error messages. Proven end to
   end through Chrome for read, console and evaluate; `text-paths.mjs` reports 0 leaks.
2. Otherwise the plain-text whole-token rule is unchanged: a secret glued to letters or digits in plain text is not
   redacted; a literal equal to a role word or a ref id is not scrubbed; with no secret remembered the output is
   byte-identical to fba6f4f (tested).
3. A redaction never splits an escape or a quoted string, and `<redacted>` stays readable.
4. Two touching or overlapping secrets are both redacted, in any order of remembering.
5. Bounded cost: a 1000-char secret against 2 MB of text well under 200 ms (reported 11 s), without blocking other
   calls; realistic cases in the low milliseconds. Measured before and after.
6. Red-first: the new tests are red on fba6f4f and green after; the forged-lines matrix and the unit tests stay green.
7. Docs: the README's secret section states exactly what is covered and what is not; this amendment.

Approach (`src/util/secrets.ts` and a new `src/util/secret-match.ts`; no call site changes. Item 8's change to
`src/dispatch.ts` was replaced in fix round 2):
- One matcher for every output. It reads the text two ways at once:
  - the raw view: today's literal spellings (`encodedForms`) as UTF-16 code units, unchanged;
  - the decoded view: the text as UTF-8 bytes, where a `%XX` escape (hex in either case) is its byte and, in text
    (not in a printed URL), a JSON escape (`\"`, `\\`, `\n`, `\u2028` …) is its character's bytes. A secret's
    decoded forms (its own bytes, and its raw spelling read the same way) are matched there, so every mix of raw,
    percent-encoded and JSON-escaped characters is one pattern.
  - Both views are Aho-Corasick automata over all remembered secrets: one pass over the text, whatever the secret
    count or length (finding 3).
- Edges: a `%XX` escape is a token edge on both sides, whatever it decodes to; so is a JSON escape (as before), a
  non-letter-or-digit, the text's start or end, and a position already claimed for redaction. A match that starts
  or ends inside a `%XX` escape takes the whole escape (7b); a match inside a JSON escape is refused (as before).
- Claims are resolved to a fixpoint with a work list: a claimed run is an edge for its neighbours, so touching and
  overlapping secrets are all redacted in any order (finding 2), and overlapping ones merge into one `<redacted>`.
- A redaction never removes an unescaped `"` that delimits a JSON string whose other quote lies outside the run (a
  secret ending in `"` used to eat a closing quote: `["<redacted>,"e99999 FORGED"]` on fba6f4f).
- Details:
  - A secret's decoded forms: its own bytes, and the bytes of each spelling where a subset of its escape-like
    characters (a `%` before two hex digits; in text, a backslash) is written raw and the rest escaped. Every mix up
    to 4 such characters in a secret up to 128 chars (at most 16 forms); otherwise all raw and all escaped. A form
    that reads as a grammar word or a ref id (after trimming spaces) or is shorter than 6 is dropped; its literal
    still matches (`%62utton` written raw reads `button`).
  - A text without `%`, `\` or `+` is read once, over code units, against the literals and the forms as strings.
  - A match that starts at an escape's first hex digit takes the escape and counts its `%` as the left edge, like
    the plain rule would: `100%25Hunter` for the secret `25Hunter` prints `100<redacted>` (fba6f4f printed
    `100%<redacted>`, a split escape). A match that starts at the second hex digit or ends inside an escape takes
    the escape and needs an edge outside it (7b).
  - Claims: one work list; a position is claimed once (a union-find skips claimed runs), and matches that wait for a
    neighbour are indexed by the position they wait on, so a chain of 100k touching copies resolves in one pass.

Decisions and changed behaviour (each from an AC):
1. 7b's AC4 ("outside URLs nothing widens") is reversed by AC1. `secrets-r7b.test.ts` "C1 AC4" now asserts the new
   rule (`- text "%27<redacted>%27"`, `O%27Brien!26` and `%48unter2xZ` redacted in text); its glued-letter row stays.
2. Touching and overlapping secrets resolve to the least fixpoint, which is what the re-check proposed ("repeat the
   pass until nothing new is claimed"). Two secrets glued to each other with no edge between them
   (`Hunter2xZebra99!`, or `Hunter2éZebra99!` with a raw `é`) stay as they are: neither has an edge, so the
   whole-token rule (AC2) keeps both. Rejected: treating a connected run of matches as one token. It would also
   redact a 2 MB run of `a` for the secret `a`×1000 and `aaaaaaa` for `aaaaaa`, a change to AC2's glued rule.
3. A `+` and a space are one character in the decoded view. 7b matched a secret's space as `+`; now a secret's `+`
   also matches a space (over-redaction only). A form that trims to a grammar word is dropped, so `+button` does not
   match ` button`.
4. Touching or overlapping claims print one `<redacted>` (fba6f4f printed one per literal match in text).
5. Quotes (found on the way, pre-existing): a secret ending in `"` ate the closing quote of a JSON string and moved
   page text outside the quotes (fba6f4f printed `- button "<redacted> e5 href="/x?q=e99999"` and
   `["<redacted>,"e99999 FORGED"]`). An unescaped `"` that delimits a JSON string whose other quote is outside the
   claimed run is now kept: `- button "<redacted>" e5 …`. Lines are read as a consumer reads them; after an
   invalid string the rest of the line has no delimiters. A whole value that is a secret still prints one
   `<redacted>`, quotes and all (`rememberedIn` relies on it).
6. JSON escapes are unchanged: a match that would start or end inside one is refused (`\nopass12` for the secret
   `nopass12`), `\u` without four hex digits included.
7. Not covered, stated in the README: base64 and other encodings, a changed case, a secret split across elements,
   double percent-encoding (`%2527`), a `"` or `\` escaped twice (a JSON string inside a JSON string), non-UTF-8
   charsets (`P%E4ssw%F6rd1`, the re-check's windows-1252 item), mixes past 4 escape-like characters or 128 chars.
   `test/unit/secrets-text.test.ts` pins each gap, so covering one changes the README with it.
8. Replaced in fix round 2 (C1: it never fired in real tool output, because the tools scrub before `final()`).
   The dispatcher's printed-URL safety net (`PRINTED_URL`, `src/dispatch.ts`) ended a URL at `<`. Once the scrub put
   a `<redacted>` inside a URL in page text, the secret-named parameters after it were not redacted:
   `?q=%27<redacted>%27&token=abc` (fba6f4f printed the secret there and hid the token; with a plain spelling,
   `?q=<redacted>&token=abc`, it printed the token too). When its scrub redacted something in that text, the final
   pass now reads URLs with a variant that also passes over `<redacted>`; otherwise a URL still ends at `<`, so with
   no secret the output stays byte-identical (a page's own `<redacted>` text ends a URL as on fba6f4f). Found by the
   advisor's review before hand-off; unit rows cover four shapes through the real final pass and the no-secret case
   (red before, green after).

Cost, fba6f4f → this branch (ms, in-process, best of 3; other sessions' Chrome processes were up throughout):

| case | fba6f4f | here |
| --- | ---: | ---: |
| printed URL, 2 MB of `a`, secret `a`×1000 (the reported case, `perf2.mjs`) | 12,116 | 30 |
| the same, secret `a`×4000 | 40,085 | 28 |
| the same, secret `a`×999+`b` (never matches) | 21,139 | 20 |
| the same, secret `a`×64 | 313 | 29 |
| 64 secrets of 63 `a` + one letter, 2 MB of `a` (`perf.mjs`) | 30,627 | 33 |
| 64 random 40-char secrets, 2 MB of `%XX` | 105 | 39 |
| a 12-char secret, its prefix and a space repeated to 2 MB | 59 | 70 |
| text, 2 MB of `a`, secret `a`×1000 | 0.7 | 26 |
| text, 2 MB of `%61`, secret `a`×1000 (fba6f4f matched nothing there) | 0.1 | 80 |
| text, 200k separate redactions | 16 | 36 |
| text, a chain of 100k touching copies (fba6f4f resolved none) | 6.9 | 54 |
| 64 secrets of 1000 chars with 4 escape-like sequences: building all four matchers (first calls) | 1,670 | 34 (36 MB) |
| realistic: 3 secrets, 20 KB of page text with escapes and JSON | 0.0 | 0.3 |
| realistic: 10,000 snapshot lines (name, value, href), 3 secrets | 22 | 34 |
| end to end (`perf-e2e.mjs`): click that sets a 2 MB fragment / `tabs list` / a concurrent `evaluate` | 11,611 / 11,873 / 11,829 | 622 / 71 / 25 |

c052783 (before 7b) did the end-to-end case in 411 / 17 / 6 ms. Without a remembered secret nothing changed (early
return). In text the cost rose from ~1 ms (fba6f4f matched far fewer spellings, with literal regexes) to tens of ms
for 2 MB; per call about 1.1 µs instead of 0.7 µs.

Tests:
- `test/unit/secrets-text.test.ts` (`X2B_TEST_SRC`), 45 tests: every output path (read body, console message,
  evaluate result, snapshot text and value, find, tabs title, effect lines, error message, network body) x 5
  secrets x 10 spellings x 30 escape neighbours through the real dispatcher's final pass; the reviewer's leaking
  lines; named rows; AC2 guards (glued, role words, no-secret identity); AC3 (quotes, JSON escapes, readable
  marker); the README's not-covered list pinned; AC4 pairs in both orders and exact; AC5 in a child process with a
  timeout and an RSS watchdog; the safety net for parameters after a marker. On fba6f4f: 27 red, 18 green (the
  guards, and the text-path timings, which fba6f4f's literal-only rule already met).
- `test/regress/secrets-text.test.ts` (`X2B_TEST_ENTRY`), 6 tests through Chrome: `text-paths.mjs` for 3 secrets
  (read links and text, console, evaluate, snapshot, find, tabs, the click's effect lines), a touching and an
  overlapping pair typed in both orders, and `perf-e2e.mjs` with a 1 s bound. fba6f4f: 6 of 6 red.
- `test/support/leak-oracle.ts`: the consumer-side oracle both use (whole token, raw or decoded; an escape is an
  edge).
- Mutation runs on scratch copies of `src`: without the work list the exact pair rows, the chain and the
  self-touching rows go red; without the form filter the `+button` row; without the cap on mixes the build row
  (171 ms, 174 MB); with the per-run quote lookup the 200k-runs row (17.9 s); with the over-marker URL net always on
  (c402230) the page-planted `<redacted>` row (AC2).

Verification (Chrome 155, headless, macOS; the fix frozen at `~/x2b-st-fix`, fba6f4f built at `~/x2b-st-base`; the
reviewer's scripts copied to `~/x2b-st-repro/` and changed only in where they point):
- Unit tests (ee4c863): 662 of 662.
- Targeted end-to-end tests (ee4c863): 231 of 231, among them the forged-lines matrix 177 of 177, `r7b.test.ts`,
  `r7.test.ts`, `sec-r5.test.ts`, `page-r2.test.ts` and the 6 new.
- `text-paths.mjs` (ee4c863): 0 leaking results (fba6f4f: 6 of 6).
- `unit-pairs.mjs` (ee4c863): 0 of 1,134 cases show a secret whole (fba6f4f: 111).
- `unit-fuzz.mjs` (ee4c863), 359,856 URLs through `safeUrl`, `href=` and the final pass: whole 0 (fba6f4f 30,401; 7b's
  re-check counted these "twice" cases), `href` 0 (7b: 25,438), escape splits 0 (the white-box mask, and every
  black-box `%`-before-marker row has a stray `%` in its input).
- `e2e-sites.mjs`, 5 secrets x 24 wrappers x 16 print sites, on 47afe83: 0 whole leaks and 0 offences for each
  secret (1,056 calls each; the 59 partial rows per secret are the `x`-glued wrapper, by design). Not rerun on
  ee4c863: the later changes cannot remove a redaction (the cap on mixes applies only to secrets over 128 chars or
  with more than 4 escape-like sequences, none here; the URL net only redacts more parameters).
- `diff-nosecret.mjs` (ee4c863): 493,056 comparisons of every output function on fba6f4f and here, with no secret
  and with 3 secrets that do not occur: 0 differences.
- Self-measured; the independent re-check is still to come.

Backlog, added here:
- Pre-existing, found on the way: a secret that is a role word with spaces around it (` textbox `) matches the
  grammar's own text in the raw view, as on fba6f4f: `- textbox "Search"` prints `-<redacted>"Search"`. Proposal:
  `rememberSecret` refuses a value whose trimmed form is a role word or a ref id.
- From the 7b re-check, still open: a page's own `<redacted>` in a `mailto:` or unparsable `href` (nit); the final
  pass can print `#%<redacted>` after a stray `%` (cosmetic).

### 2026-10-27: secrets in text paths, fix round 2

The security re-check of ee4c863 (flow-verifier-max, `docs/reviews/review-secret-text-paths.md`, scripts in
`~/x2b-st-review/`) found one critical and one warning. This is the branch's one fix round. Main was merged first
(ac79c06: 11b9f17 with fix/batch-budget and fix/read-comments, plus the review doc 422588d; only PLAN.md conflicted,
both sides had appended), so the re-check runs on what will land.

1. **C1 (critical, a regression against fba6f4f): the URL safety net was never armed in real tool output.**
   - Cause: item 8 armed the over-marker net in `final()` only when its own scrub changed the text. But `read`,
     `console` and `evaluate` (and `common`, `network`, `dialog`) scrub first, so `final()` changed nothing and the
     net stopped at the marker's `<`: `?q=%27<redacted>%27&token=TOKVAL1` (fba6f4f: the password in clear, the
     token hidden). Where it was armed, the over-marker match ran on into a URL glued after the secret.
   - Fix: `scrubSecrets` itself claims the values of the secret-named parameters of every URL run that holds one of
     its own claims, before the marker prints (`claimParamsOfTouchedUrls`, `src/util/secrets.ts`). So every
     tool-level scrub covers it, and `final()`'s too.
     - A run starts at a `scheme://` (no word edge needed: a URL can be glued after the secret) and goes on over the
       net's URL characters and over claimed runs.
     - It is parsed as one URL, which is what the net would read with the secret in place, so it never hides
       less. It is also parsed from each `scheme://` inside it (a URL glued after the secret).
   - `src/dispatch.ts` is main's again: the net is fba6f4f's, and URLs that hold no claim are left to it, so
     no-secret output is byte-identical.
   - Two shapes that printed the token on fba6f4f are now hidden too: `?q=<secret>&token=…` and a URL glued after a
     `%27`-wrapped secret.
2. **W1 (warning, pre-existing): an escaped surrogate pair read as two U+FFFD.** `decode()` now reads a high-surrogate
   `\uXXXX` followed by a low one as one character (Python's `json.dumps` writes an emoji so). Alone, each half is
   still U+FFFD.
3. Cost: the reviewer's 46k-URL case (a secret and a token in each URL, 2 MB) took 147 ms with the first version of the
   check. One streaming pass and a cache of parameter-name decisions brought it to 83 ms best of 3 (104 ms in the
   reviewer's single-run harness; ee4c863 without the check: 77 ms).

Red, then green:
- `test/unit/secrets-text.test.ts`, describes "C1 (round 2)" and "W1 (round 2)":
  - C1: the reviewer's shapes x 4 secrets x 10 spellings through all 10 output paths (each with its tool's own
    scrub first) and the console tool's real handler, then the real `final()`; plus the exact prescrub rows. A
    JSON-escaped spelling on the two JSON-quoted paths is skipped: escaped twice, which is the README's documented
    gap (the net stops at the backslash there, on fba6f4f too).
  - W1: an emoji secret shown as surrogate-pair escapes.
  - On ee4c863: 14 of 15 red (the no-secret guard green). Here: 15 of 15.
- `test/regress/secrets-text.test.ts` through Chrome: C1 for 2 secrets (read, console, evaluate, tabs) and W1
  (`fill_form`, a page echoing json.dumps-style escapes). On ee4c863: 3 of 3 red. Here: green.
- The reviewer's scripts, copied to `~/x2b-st-repro/review2/` (only the build path changed):
  - `prescrub.mjs`: 0 of 12 rows show the token or the password (ee4c863: 9 show the token).
  - `urlnet.mjs`: everything hidden except its no-secret nested-URL control (fba6f4f the same).
  - `astral.mjs`: 0 leaks, but its emoji spelling never wrote a surrogate pair (the review discarded it), so it is
    no W1 evidence; the W1 evidence is the unit rows and the Chrome `fill_form` test above.

AC2 and AC3 on bb83cb3 (Chrome 156.0.8078.48, read from its Info.plist; headless, isolated):
- Unit 697 of 697. Targeted end-to-end 236 of 236 (forged-lines matrix, `r7b`, `r7`, `sec-r5`, `page-r2`,
  `secrets-text`).
- `diff-nosecret.mjs`: 0 differences in 493,056 comparisons against fba6f4f, and 0 against main 422588d.
- `text-paths.mjs`: 0 leaks. `unit-pairs.mjs`: 0 of 1,134 (fba6f4f 111). `unit-fuzz.mjs`: whole 0, escape splits
  0, `href` 0 in 359,856.
- Cost, 2 MB, memory-capped children (RSS watchdog, timeout, heap cap):
  - the reviewer's 11 cases: 9-104 ms;
  - `perf2.mjs`, URL of `a` with the secret `a`×1000: 31 ms (fba6f4f 11,360 ms); `a`×4000: 30 ms (39,452 ms);
  - `perf.mjs`, 64 a-prefixed secrets: 38 ms (30,180 ms).
- End to end (`perf-e2e.mjs`): `tabs list` 69 ms, a concurrent `evaluate` 21 ms (fba6f4f 11.9 s and 11.8 s).

Backlog, from this re-check (no fix needed in this round):
- N1 (nit): a secret holding `"` in raw text can pair with a later quote on the same line, so one quote character
  and its position stay visible (`'<redacted>"<redacted>'` for `Hu"nt!2x`). The README describes the quote-keeping.
- A secret ending in `\` followed by `"`, `/`, `n` or `u…` in raw text is not redacted: the rule against splitting a JSON
  escape applies to markdown and console text too (`"trailing\"`).
- The net's own gaps, also on fba6f4f, outside secrets: a secret-named parameter inside another parameter's value
  (`?next=http://b.test/?token=…`), a URL glued to a letter or digit (`xhttp://…`), and a parameter after a raw `'`,
  backslash or space in text (a fragment keeps `'` raw), unless a redacted secret holding that character bridges it.
- `bench/agent/run.test.mjs`'s signal test can orphan its fake `claude` stub (the review's note).
