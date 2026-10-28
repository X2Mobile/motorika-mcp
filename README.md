# Motorika

An MCP server (stdio) that gives an AI agent fast, reliable control of Chrome:
- tabs, forms, clicks, keyboard, scrolling and drag;
- uploads, downloads and JS dialogs;
- JS evaluation, console and network inspection.

It runs headed or headless, on a dedicated persistent profile or attached to a running Chrome. The
contract (tools, snapshot grammar, effect lines, acceptance criteria) is `PLAN.md`.

## What it does

- **Multi-tab:** each session has its own active tab and tab list. Launch modes act on background tabs
  directly, without bringing them to the front.
- **`fill_form`:** many fields in one call, under one shared budget; when a field fails, the result lists
  each field as `ok …` or `failed …`.
- **`batch`:** several steps in one call; each step's output sits under its own `## step <n>: <tool>`
  header, and the output cap is shared fairly between the steps.
- **Actions report what changed:** each action prints `→` lines for a navigation, a new or closed tab, a
  dialog, a download, a live-region alert and new console errors, and a viewport snapshot after a
  navigation to a new document.
- **Video:** frames of a `<video>` as images, cross-origin iframes included (a DRM-protected or not yet
  decoded frame comes back black), and the cues of its text tracks; play, pause, seek and rate.
- **One agent browser for many sessions:** in launch mode, several Claude sessions on the same profile
  share one Chrome with your logins, each with its own tabs. `--isolated` servers never share.
- **Headed or headless,** on a persistent profile, a fresh `--isolated` one, or attached to your running
  Chrome (`--cdp-endpoint`, `--auto-connect`).

## Quick start

1. Have Node >= 20 and an installed Google Chrome. Nothing to clone or build: `npx` fetches the `motorika`
   package from npm on first start.
2. Register: `claude mcp add motorika -s user -- npx -y motorika` (headed; add `--headless` at the end for
   headless Chrome). Or as a Claude Code plugin: `/plugin marketplace add X2Mobile/x2-plugins`, then
   `/plugin install motorika@x2mobile`.
3. Log in once, if the agent needs your accounts: `npx motorika open https://accounts.google.com`, sign in,
   then quit Chrome fully (Cmd+Q on macOS).
4. Try it: ask Claude Code to open a page, search for something and summarise what it finds.

The full guide, with logging in once and the permission setup: [docs/quick-start.md](docs/quick-start.md).

## Documentation

| Page | What it covers |
|---|---|
| [Quick start](docs/quick-start.md) | install, register, log in once, a first prompt, permissions |
| [Tools](docs/tools.md) | targets, errors, paging, effect lines, settle, frames, dialogs, downloads and `video` |
| [Configuration](docs/configuration.md) | every flag and env var; launch, shared, connect and auto-connect modes |
| [Safety](docs/safety.md) | the sandbox, the agent profile, origin lists, Chrome's own traffic, Claude Code permissions |
| [Security defaults](docs/security.md) | upload roots, written files, password and secret redaction, what is not covered |
| [Troubleshooting](docs/troubleshooting.md) | error messages and what to do about them |
| [Development](docs/development.md) | build outputs, tests, code layout |
| [PLAN.md](PLAN.md), [docs/reviews/](docs/reviews/), [VERIFICATION.md](VERIFICATION.md) | design record: the contract, the reviews and what was verified |

## Safety

**Keep your bank, your main email and admin accounts out of the agent profile.** The agent acts with no
per-site permission prompts, and a prompt-injected page can try to make it use whatever the agent profile
(`~/.motorika/profile`) is logged into. Use separate, low-privilege accounts for what the agent needs.
How to block sites outright, and what else to know: [docs/safety.md](docs/safety.md).

## License

MIT, see `LICENSE`. Copyright (c) 2026 X2 Mobile.
