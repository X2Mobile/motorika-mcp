# Quick start

From install to a first prompt in Claude Code. Back to the [README](../README.md).

## Requirements

Needs Node >= 20 and an installed Google Chrome. `playwright-core` downloads no browser.

You also need Claude Code, or another MCP client that runs stdio servers.

## Install

Nothing to clone or build. Motorika is the `motorika` package on npm; `npx -y motorika` fetches it on
first start and runs it from npm's cache after that. To run it from a clone instead (for development),
see [Development](development.md).

## Register with Claude Code

The server runs headed by default: Chrome opens a visible window, so you can watch the agent. `-s user`
makes it available in every project:

```sh
claude mcp add motorika -s user -- npx -y motorika
```

For headless Chrome, add `--headless`:

```sh
claude mcp add motorika -s user -- npx -y motorika --headless
```

Chrome starts lazily, on the first tool call that needs a page; `initialize` and `tools/list` never start it.
Every other flag (profile, output dir, origin lists, timeouts) is in [Configuration](configuration.md#flags),
and `npx motorika --help` lists them too.

## Log in once

The agent uses its own persistent profile, `~/.motorika/profile`, so cookies and logins persist across
restarts. Google refuses sign-in in automation-controlled windows, so log in by hand once, with a plain
Chrome on the agent profile:

```sh
npx motorika open https://accounts.google.com
```

- Sign in, then quit Chrome fully: Cmd+Q on macOS, where closing the window leaves it running. Quitting
  normally also writes the cookies to disk (otherwise Chrome writes them about every 30 s).
- `open` exits when that Chrome exits. Until then, that Chrome holds the profile, and the agent's first
  page tool fails with `profile … is in use by another Chrome (pid N) that is not a Motorika server`.
- Run it while no server uses the profile. If a server owns it, `open` exits with code 2 and tells you to
  log in through that server's window instead.
- Log in only to accounts you are willing to let the agent use: not your bank, your main email or admin
  consoles. See [Safety](safety.md).

Details: "Logging in by hand" in [Configuration](configuration.md#modes).

## Try it

Start Claude Code and ask, for example:

> Open https://en.wikipedia.org, search for "Model Context Protocol" and summarise the first paragraph of
> the article.

Each action reports what changed
(`→ navigated …`, `→ new tab …`), and a navigation to a new document comes with a viewport snapshot.
[Tools](tools.md) explains the output.

## Permissions

Claude Code keys the server's tools by the name you gave `claude mcp add` (here `motorika`). Two setups
for `.claude/settings.json` (or `~/.claude/settings.json`):

- No prompts: `"allow": ["mcp__motorika"]`. Every tool, including clicks, typing, uploads and `evaluate`,
  then runs without asking.
- Reads free, actions still ask: allow only `mcp__motorika__snapshot`, `mcp__motorika__screenshot`,
  `mcp__motorika__read`, `mcp__motorika__find`, `mcp__motorika__console` and `mcp__motorika__network`.

Choose with care. The agent drives a real browser with no per-site permission prompts, and a
prompt-injected page can try to make the agent use whatever the agent profile is logged into. The full
JSON for both setups is under "Claude Code permissions" in [Safety](safety.md).

## Where things live

| Path | What |
|---|---|
| `~/.motorika/profile` | the agent profile: cookies and logins (`--profile-dir`) |
| `~/.motorika/output` | `screenshots/` and `downloads/`, plus `frames/` from `video frames save:true` (`--output-dir`) |
| `~/.motorika/run` | the user-only unix sockets of the shared agent browser |
| stderr | the server's log; `MOTORIKA_LOG=debug` for more. stdout carries JSON-RPC only |

## Next

- [Tools](tools.md): how the tools behave and what their output means.
- [Configuration](configuration.md): flags, env vars, the shared browser, connect and auto-connect.
- [Safety](safety.md) and [Security defaults](security.md): what to keep out of the agent profile, origin
  lists, and what the server refuses and redacts.
- [Troubleshooting](troubleshooting.md): error messages and what to do.
