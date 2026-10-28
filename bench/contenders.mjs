// The stdio contenders, pinned. All headless with a throwaway profile and the same 1280x800 viewport,
// except BrowserMCP, which drives the user's real, visible Chrome through its extension.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BENCH, '..');
// Launched with node from bench/node_modules (pinned in bench/package.json), not through npx, so cold
// start does not include npm's package resolution. Ours is launched the same way.
const bin = (pkg, rel) => join(BENCH, 'node_modules', pkg, rel);

export const VIEWPORT = { width: 1280, height: 800 };

export const CONTENDERS = [
  {
    id: 'motorika',
    version: '0.1.0 (this repo, dist/)',
    command: 'node',
    args: [join(ROOT, 'dist', 'index.js'), '--headless', '--isolated', '--viewport', '1280x800'],
    outputDirFlag: '--output-dir',
    mode: 'headless, isolated temp profile',
  },
  {
    id: 'playwright',
    version: '@playwright/mcp@0.0.83',
    command: 'node',
    args: [bin('@playwright/mcp', 'cli.js'), '--headless', '--isolated', '--browser', 'chrome', '--viewport-size', '1280x800'],
    mode: 'headless, isolated in-memory profile',
  },
  {
    // The same server with the vision capability: it works from screenshots and x/y coordinates. B2 forbids
    // its snapshot tools (disallowedTools below), so the agent cannot fall back to the accessibility tree.
    id: 'playwright-vision',
    version: '@playwright/mcp@0.0.83 --caps vision',
    command: 'node',
    args: [bin('@playwright/mcp', 'cli.js'), '--headless', '--isolated', '--browser', 'chrome', '--viewport-size', '1280x800', '--caps', 'vision'],
    // browser_find searches the snapshot text, and browser_evaluate / browser_run_code_unsafe read the DOM
    // directly, so they go too. Selector targets stay available: the agent would have to guess them blind.
    disallowedTools: ['browser_snapshot', 'browser_find', 'browser_evaluate', 'browser_run_code_unsafe'],
    mode: 'headless, isolated in-memory profile, vision caps (screenshots + xy mouse; snapshot and DOM-reading tools forbidden in B2)',
  },
  {
    id: 'devtools',
    version: 'chrome-devtools-mcp@1.12.0',
    command: 'node',
    args: [bin('chrome-devtools-mcp', 'build/src/bin/chrome-devtools-mcp.js'), '--headless', '--isolated', '--viewport', '1280x800', '--no-usage-statistics', '--no-performance-crux'],
    mode: 'headless, isolated temp profile',
  },
  {
    id: 'agent-infra',
    version: '@agent-infra/mcp-server-browser@1.2.29',
    command: 'node',
    args: [bin('@agent-infra/mcp-server-browser', 'dist/index.cjs'), '--headless', '--browser', 'chrome', '--viewport-size', '1280,800'],
    // No --isolated flag: each spawn gets a fresh --user-data-dir that is deleted afterwards.
    freshProfileFlag: '--user-data-dir',
    mode: 'headless (no isolated flag; see caveats)',
  },
  {
    // The archived reference server (DEPRECATED on npm, unmaintained). Its default launch is headed; the env
    // makes it headless on the installed Chrome. Puppeteer gives every launch a fresh temp profile in
    // os.tmpdir() and deletes it on close. No dangerous args, so ALLOW_DANGEROUS stays unset. Installed with
    // PUPPETEER_SKIP_DOWNLOAD=1 (its postinstall Chrome download is not needed). A tool call's own
    // launchOptions can still override this env; the agent is not told about it.
    id: 'puppeteer',
    version: '@modelcontextprotocol/server-puppeteer@2025.5.12 (deprecated, archived)',
    command: 'node',
    args: [bin('@modelcontextprotocol/server-puppeteer', 'dist/index.js')],
    env: {
      PUPPETEER_LAUNCH_OPTIONS: JSON.stringify({
        headless: true,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        defaultViewport: VIEWPORT,
      }),
    },
    mode: 'headless (via PUPPETEER_LAUNCH_OPTIONS), installed Chrome, puppeteer temp profile; DEPRECATED package',
  },
  {
    id: 'browsermcp',
    version: '@browsermcp/mcp@0.1.3',
    // At every startup it runs `lsof -ti:9009 | xargs kill -9` (dist/index.js, killProcessOnPort). That lsof
    // also matches the port's clients, i.e. Chrome's network service while the extension is connected or
    // retrying. The shim first on PATH narrows it to listeners, so only a stale BrowserMCP server is killed.
    // Before a run, stop any BrowserMCP server the bench did not start, and connect a tab in the extension
    // (it reconnects to each new server by itself, polling every second).
    command: 'sh',
    args: ['-c', `PATH="${join(BENCH, 'agent', 'lsof-listen-only')}:$PATH" exec npx -y @browsermcp/mcp@0.1.3`],
    microSkip: 'no micro adapter: it drives the real, headed Chrome, so its step timings are not comparable',
    optIn: true, // B2 runs it only with --only browsermcp (bench/agent/run.mjs)
    mode: 'HEADED: the user\'s real Chrome via the BrowserMCP extension',
    realChrome: true,
  },
];
