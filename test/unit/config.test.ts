import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, configuredMode, defaultChromeUserDataDir, HELP, parseConfig, parseViewport } from '../../src/config.js';

const CWD = '/work/project';

describe('config: defaults (PLAN modes table)', () => {
  const c = parseConfig([], {}, CWD);
  it('headed chrome, 1280x800, 10 s action, 30 s navigation, 20000 chars', () => {
    assert.equal(c.headless, false);
    assert.equal(c.browser, 'chrome');
    assert.deepEqual(c.viewport, { width: 1280, height: 800 });
    assert.equal(c.actionTimeout, 10000);
    assert.equal(c.navigationTimeout, 30000);
    assert.equal(c.maxOutputChars, 20000);
    assert.equal(c.isolated, false);
    assert.equal(c.autoConnect, false);
    assert.equal(c.cdpEndpoint, undefined);
  });
  it('profile and output under ~/.motorika', () => {
    assert.equal(c.profileDir, join(homedir(), '.motorika', 'profile'));
    assert.equal(c.outputDir, join(homedir(), '.motorika', 'output'));
  });
  it('default upload roots: cwd, output dir, Downloads, Desktop, Documents', () => {
    assert.deepEqual(c.fileRoots, [
      CWD,
      join(homedir(), '.motorika', 'output'),
      join(homedir(), 'Downloads'),
      join(homedir(), 'Desktop'),
      join(homedir(), 'Documents'),
    ]);
  });
  it('mode is launch', () => assert.equal(configuredMode(c), 'launch'));
});

describe('config: flags and env', () => {
  it('flags set every option', () => {
    const c = parseConfig(
      [
        '--headless', '--browser', 'msedge', '--executable-path', 'bin/chrome', '--profile-dir', '~/p', '--isolated',
        '--viewport', '800x600', '--output-dir', 'out', '--allow-file-root', '/a', '--allow-file-root=/b',
        '--allow-hidden-files', '--action-timeout', '500', '--navigation-timeout=700', '--max-output-chars', '900',
      ],
      {},
      CWD,
    );
    assert.equal(c.headless, true);
    assert.equal(c.browser, 'msedge');
    assert.equal(c.executablePath, '/work/project/bin/chrome');
    assert.equal(c.profileDir, join(homedir(), 'p'));
    assert.equal(c.isolated, true);
    assert.deepEqual(c.viewport, { width: 800, height: 600 });
    assert.equal(c.outputDir, '/work/project/out');
    assert.ok(c.fileRoots.includes('/a') && c.fileRoots.includes('/b'), 'extra roots are added');
    assert.ok(c.fileRoots.includes(CWD), 'defaults stay (the flag widens)');
    assert.equal(c.allowHiddenFiles, true);
    assert.equal(c.actionTimeout, 500);
    assert.equal(c.navigationTimeout, 700);
    assert.equal(c.maxOutputChars, 900);
  });
  it('env vars work and flags win over env', () => {
    const env = {
      MOTORIKA_HEADLESS: '1',
      MOTORIKA_BROWSER: 'chromium',
      MOTORIKA_VIEWPORT: '1024x768',
      MOTORIKA_ACTION_TIMEOUT: '1234',
      MOTORIKA_FILE_ROOTS: '/r1:/r2',
      MOTORIKA_ISOLATED: 'true',
      MOTORIKA_ALLOW_HIDDEN_FILES: '0',
    };
    const c = parseConfig([], env, CWD);
    assert.equal(c.headless, true);
    assert.equal(c.browser, 'chromium');
    assert.deepEqual(c.viewport, { width: 1024, height: 768 });
    assert.equal(c.actionTimeout, 1234);
    assert.ok(c.fileRoots.includes('/r1') && c.fileRoots.includes('/r2'));
    assert.equal(c.isolated, true);
    assert.equal(c.allowHiddenFiles, false);
    const c2 = parseConfig(['--action-timeout', '99', '--browser', 'chrome'], env, CWD);
    assert.equal(c2.actionTimeout, 99);
    assert.equal(c2.browser, 'chrome');
  });
  it('connect and auto-connect modes', () => {
    assert.equal(configuredMode(parseConfig(['--cdp-endpoint', 'http://127.0.0.1:9222'], {}, CWD)), 'connect');
    assert.equal(configuredMode(parseConfig([], { MOTORIKA_CDP_ENDPOINT: 'ws://h:1/devtools/browser/x' }, CWD)), 'connect');
    const a = parseConfig(['--auto-connect', '--chrome-user-data-dir', '/tmp/ud'], {}, CWD);
    assert.equal(configuredMode(a), 'auto_connect');
    assert.equal(a.chromeUserDataDir, '/tmp/ud');
  });
});

describe('config: validation errors name the problem', () => {
  const bad: [string[], RegExp][] = [
    [['--browser', 'firefox'], /--browser must be one of/],
    [['--viewport', 'big'], /invalid viewport/],
    [['--action-timeout', '-1'], /positive integer/],
    [['--action-timeout', 'abc'], /positive integer/],
    [['--cdp-endpoint', 'localhost:9222'], /must start with http/],
    [['--auto-connect', '--cdp-endpoint', 'http://x:1'], /exclusive/],
    [['--nope'], /unknown flag --nope/],
    [['--output-dir'], /needs a value/],
    [['stray'], /unexpected argument/],
    [['--headless=maybe'], /takes no value/],
  ];
  for (const [argv, re] of bad) {
    it(argv.join(' '), () => {
      assert.throws(() => parseConfig(argv, {}, CWD), (e: unknown) => e instanceof ConfigError && re.test(e.message));
    });
  }
  it('parseViewport accepts WxH only', () => {
    assert.deepEqual(parseViewport('1920x1080'), { width: 1920, height: 1080 });
    assert.throws(() => parseViewport('1920*1080'), ConfigError);
  });
});

describe('config: default Chrome user-data dirs (PLAN)', () => {
  it('macOS', () => assert.equal(defaultChromeUserDataDir('darwin', {}), join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')));
  it('Linux', () => assert.equal(defaultChromeUserDataDir('linux', {}), join(homedir(), '.config', 'google-chrome')));
  it('Windows', () => assert.equal(defaultChromeUserDataDir('win32', { LOCALAPPDATA: 'C:\\L' }), join('C:\\L', 'Google', 'Chrome', 'User Data')));
});

describe('config: --no-sandbox opt-out (amendment 2026-10-23, S2)', () => {
  it('off by default', () => assert.equal(parseConfig([], {}, CWD).noSandbox, false));
  it('flag turns it on', () => assert.equal(parseConfig(['--no-sandbox'], {}, CWD).noSandbox, true));
  it('env MOTORIKA_NO_SANDBOX=1 turns it on', () => assert.equal(parseConfig([], { MOTORIKA_NO_SANDBOX: '1' }, CWD).noSandbox, true));
  it('MOTORIKA_NO_SANDBOX=0 leaves it off', () => assert.equal(parseConfig([], { MOTORIKA_NO_SANDBOX: '0' }, CWD).noSandbox, false));
  it('takes no value', () => {
    assert.throws(() => parseConfig(['--no-sandbox=maybe'], {}, CWD), (e: unknown) => e instanceof ConfigError && /takes no value/.test(e.message));
  });
  it('is listed in --help with its env var', () => assert.match(HELP, /^\s+--no-sandbox\s+\(MOTORIKA_NO_SANDBOX=1\)/m));
});

describe('--help', () => {
  it('names MOTORIKA_LOG, the one env var without a flag', () => assert.match(HELP, /^\s+MOTORIKA_LOG=debug\|info\|warn\|error\s/m));
});
