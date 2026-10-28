# Troubleshooting

Error messages and what to do about them. Back to the [README](../README.md).

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
| Garbled protocol in the client | Something wrote to stdout. The server logs only to stderr; check wrappers around the server command (`npx motorika`, or `node dist/index.js` from a clone). |

The full log is on stderr. Set `MOTORIKA_LOG=debug` for more.
