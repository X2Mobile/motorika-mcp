# Development

Building, testing and the layout of the code. Back to the [README](../README.md).

## Build and test

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

## Code and tests

- `src/tools/<name>.ts` holds one tool per file. Adding a tool means writing that file and adding one line
  in `src/tools/index.ts`. Batch dispatches through the same registry.
- `src/page/injected/` is the in-page engine, bundled into one IIFE. It is installed via CDP evaluate, so
  it is CSP and Trusted Types safe. It never uses `eval`, `Function` or `innerHTML`.
- Tests:
  - `test/unit/` covers pure logic.
  - `test/smoke/` runs the built server end to end, headless and `--isolated`, with a private
    `TMPDIR`. It asserts that no Chrome survives.
  - `test/acceptance/` holds the independent acceptance suite.
- CI (`.github/workflows/ci.yml`) runs on every pull request to `main`. Required to merge: `checks` (typecheck,
  build, unit and bench tests on Node 24) and `node20` (`scripts/mcp-smoke.mjs`: the built server answers
  `initialize` and lists its tools on Node 20). Advisory for now: `e2e`, the full suite with a headless Chrome on
  Linux.
