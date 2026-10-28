# Configuration

Command-line flags, env vars and the browser modes. Back to the [README](../README.md).

## Flags

Flags win over env vars, and env vars win over defaults.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--headless` | `MOTORIKA_HEADLESS=1` | headed | headless Chrome (new headless) |
| `--browser <chrome\|chrome-beta\|msedge\|chromium>` | `MOTORIKA_BROWSER` | chrome | Playwright channel |
| `--executable-path <path>` | `MOTORIKA_EXECUTABLE_PATH` | none | explicit browser binary (Chrome for Testing, Chromium) |
| `--profile-dir <dir>` | `MOTORIKA_PROFILE_DIR` | `~/.motorika/profile` | persistent profile; logins persist |
| `--isolated` | `MOTORIKA_ISOLATED=1` | off | fresh temp profile per process, deleted on exit |
| `--no-sandbox` | `MOTORIKA_NO_SANDBOX=1` | off | launch Chrome without its sandbox, for containers running as root; unsafe (see [Safety](safety.md)) |
| `--cdp-endpoint <url>` | `MOTORIKA_CDP_ENDPOINT` | none | connect mode (`http(s)://host:port` or `ws(s)://…`) |
| `--auto-connect` | `MOTORIKA_AUTO_CONNECT=1` | off | attach to your running Chrome (see [Modes](#modes) below) |
| `--chrome-user-data-dir <dir>` | `MOTORIKA_CHROME_USER_DATA_DIR` | OS default Chrome dir | where auto-connect reads `DevToolsActivePort` |
| `--viewport <WxH>` | `MOTORIKA_VIEWPORT` | 1280x800 | launch modes only |
| `--output-dir <dir>` | `MOTORIKA_OUTPUT_DIR` | `~/.motorika/output` | `screenshots/` and `downloads/` |
| `--allow-file-root <dir>` (repeatable) | `MOTORIKA_FILE_ROOTS` (`:`-separated) | see [Security defaults](security.md) | adds upload roots to the defaults |
| `--allow-hidden-files` | `MOTORIKA_ALLOW_HIDDEN_FILES=1` | off | permit dot-files and dot-dirs as upload sources and `file:` pages |
| `--allow-chrome-urls` | `MOTORIKA_ALLOW_CHROME_URLS=1` | off | permit `chrome:`, `devtools:`, `chrome-extension:` and `about:` pages (other than `about:blank`/`about:srcdoc`) |
| `--blocked-origins <list>` (repeatable) | `MOTORIKA_BLOCKED_ORIGINS` | empty | never load these hosts or origins (comma-separated; see [Safety](safety.md)) |
| `--allowed-origins <list>` (repeatable) | `MOTORIKA_ALLOWED_ORIGINS` | empty (= everything) | load only these hosts or origins |
| `--action-timeout <ms>` | `MOTORIKA_ACTION_TIMEOUT` | 10000 | default per-action timeout |
| `--navigation-timeout <ms>` | `MOTORIKA_NAVIGATION_TIMEOUT` | 30000 | default navigation timeout |
| `--max-output-chars <n>` | `MOTORIKA_MAX_OUTPUT_CHARS` | 20000 | hard ceiling on the whole text of any result (notices, prefixes, batch totals included); a cut ends with `… output cut at <n> chars` (a `batch` shares it per step instead, see "batch output" in [Tools](tools.md#using-the-tools)) |

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
