# Safety

Chrome's sandbox, the agent profile, origin lists, what is protected and Claude Code permissions. Back to the [README](../README.md).

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
  not covered: [Security defaults](security.md).
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
