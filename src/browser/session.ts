// Browser session: lazy launch / connect / auto-connect, tab + client registry, disconnect recovery, exit.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { blockedUrlPatterns, checkNavigation, checkOrigin, guardLanding, hostResolverRules, originRouteMatch } from '../util/urls.js';
import { safeUrl } from '../util/secrets.js';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Frame, type Page, type Request } from 'playwright-core';
import type { Config, Mode } from '../config.js';
import { configuredMode } from '../config.js';
import { ToolError, firstLine } from '../util/errors.js';
import { ARROW, effect } from '../util/format.js';
import { log } from '../util/log.js';
import { RefRegistry } from './refs.js';
import { RANK, Tab, activate, newClient, removeFromClient, type Client } from './tabs.js';

export const DEFAULT_CLIENT = 'local';
export const TEMP_PROFILE_PREFIX = 'motorika-profile-';

export interface LockInfo {
  pid: number;
  host: string;
  /** true when the pid is alive on this host; false when dead; undefined when on another host. */
  alive: boolean | undefined;
}

/**
 * Chrome's profile lock: <profile>/SingletonLock is a symlink to "<host>-<pid>". Reusable: phase 2
 * extends it to "owned by a live Motorika server -> join".
 */
export function readProfileLock(profileDir: string): LockInfo | null {
  let target: string;
  try {
    target = readlinkSync(join(profileDir, 'SingletonLock'));
  } catch {
    return null;
  }
  const m = /^(.*)-(\d+)$/.exec(target);
  if (!m) return null;
  const host = m[1] ?? '';
  const pid = Number(m[2]);
  if (host !== hostname()) return { pid, host, alive: undefined };
  return { pid, host, alive: pidAlive(pid) };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Round 4, G1: Chrome switches for a launch with an origin list (none without one). Chrome's DevTools
 * request interception does not see speculation-rules prefetch and prerender, WebSocket handshakes from
 * workers, or WebRTC's STUN/TURN traffic.
 * - `--host-resolver-rules`: listed host names (or, with an allow-list, every unlisted one) resolve to nothing.
 * - `--webrtc-ip-handling-policy=disable_non_proxied_udp`: no WebRTC UDP unless through a proxy (the brief's
 *   `--force-webrtc-ip-handling-policy` is not a Chrome switch; measured, it changes nothing).
 */
export function originListSwitches(c: Pick<Config, 'blockedOrigins' | 'allowedOrigins'>): string[] {
  if (c.blockedOrigins.length === 0 && c.allowedOrigins.length === 0) return [];
  const rules = hostResolverRules(c);
  return ['--webrtc-ip-handling-policy=disable_non_proxied_udp', ...(rules ? [`--host-resolver-rules=${rules}`] : [])];
}

/** Chrome's "Preload pages" preference value for "no preloading" (net.network_prediction_options). */
const NO_PRELOADING = 2;

/**
 * G1: turn off speculation-rules prefetch and prerender on the profile before Chrome starts, by Chrome's
 * own "Preload pages: off" preference (no switch or feature flag does this; measured). Only called with an
 * origin list. The preference stays in a persistent profile afterwards (docs/safety.md "Origin lists"). A
 * Preferences file this cannot read is left alone, with a warning: the DNS layer still covers listed host
 * names.
 */
export function disablePreloading(profileDir: string): boolean {
  const dir = join(profileDir, 'Default');
  const file = join(dir, 'Preferences');
  let prefs: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object');
      prefs = parsed as Record<string, unknown>;
    } catch (e) {
      log.warn(`origin lists: could not read ${file}; page preloading (speculation rules) stays as configured in that profile`, e);
      return false;
    }
  }
  const net = typeof prefs.net === 'object' && prefs.net !== null && !Array.isArray(prefs.net) ? (prefs.net as Record<string, unknown>) : {};
  if (net.network_prediction_options === NO_PRELOADING) return true;
  prefs.net = { ...net, network_prediction_options: NO_PRELOADING };
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.motorika-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(prefs));
    renameSync(tmp, file);
    return true;
  } catch (e) {
    log.warn(`origin lists: could not write ${file}; page preloading (speculation rules) stays on`, e);
    return false;
  }
}

export interface LaunchOptions {
  mode: Mode;
  headless: boolean;
  isolated: boolean;
  cdpEndpoint: string | undefined;
}

/** Read DevToolsActivePort and build the ws:// URL (the http /json/version endpoint 404s in this mode). */
export function autoConnectEndpoint(userDataDir: string): string {
  const file = join(userDataDir, 'DevToolsActivePort');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ToolError(
      `auto-connect found no ${file} (Chrome is not running with remote debugging enabled)`,
      'in your Chrome open chrome://inspect/#remote-debugging and turn on "Allow remote debugging", then retry (Chrome 144+; Chrome asks for permission on each connection)',
    );
  }
  const [portLine, pathLine] = raw.split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || !pathLine?.startsWith('/')) {
    throw new ToolError(`auto-connect could not parse ${file}`, 'toggle chrome://inspect/#remote-debugging off and on again, then retry');
  }
  return `ws://127.0.0.1:${port}${pathLine.trim()}`;
}

export class RWLock {
  private writeTail: Promise<void> = Promise.resolve();
  private readonly active = new Set<Promise<unknown>>();

  async shared<T>(fn: () => Promise<T>): Promise<T> {
    await this.writeTail;
    const p = fn();
    this.active.add(p);
    try {
      return await p;
    } finally {
      this.active.delete(p);
    }
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeTail;
    let release: () => void = () => undefined;
    this.writeTail = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prev;
      await Promise.allSettled([...this.active]);
      return await fn();
    } finally {
      release();
    }
  }
}

export class Session {
  /** Refs store a frame label; the label resolves through the tab registry (no detached Frames pinned). */
  readonly refs: RefRegistry<Frame> = new RefRegistry<Frame>({
    label: (tabId, frame) => this.tabs.get(tabId)?.frameLabel(frame) ?? 'f?',
    resolve: (tabId, label) => this.tabs.get(tabId)?.frameByLabel(label),
  });
  /** Joined sessions that went away: pages created for them late are closed, not orphaned (P8). */
  private readonly dropped = new Set<string>();
  readonly tabs = new Map<string, Tab>();
  readonly clients = new Map<string, Client>();
  readonly lock = new RWLock();
  opts: LaunchOptions;
  private context: BrowserContext | undefined;
  private browser: Browser | undefined;
  private starting: Promise<BrowserContext> | undefined;
  private tempDir: string | undefined;
  private profileInUse: string | undefined;
  private lost = false;
  private closing = false;
  /** The origin lists run on ctx.route (no Browser object); see installOriginPolicy. */
  private routeFallback = false;
  private versionStr: string | undefined;
  private nextTab = 1;
  private nextReq = 1;
  private readonly pageToTab = new Map<Page, Tab>();
  private spare: Page[] = [];
  private creating = 0;
  /** Tabs currently inside an action window (popup attribution for noopener popups). */
  readonly actionTabs: string[] = [];
  /** Role in profile sharing (set by the share router). */
  shared: 'none' | 'owner' | 'client' = 'none';
  /** Tab last brought to the front (headed/attach modes). */
  frontTab: string | undefined;
  readonly pendingPopups = new Set<Promise<void>>();

  constructor(readonly config: Config) {
    this.opts = { mode: configuredMode(config), headless: config.headless, isolated: config.isolated, cdpEndpoint: config.cdpEndpoint };
    this.clients.set(DEFAULT_CLIENT, newClient(DEFAULT_CLIENT));
  }

  client(id: string): Client {
    let c = this.clients.get(id);
    if (!c) {
      c = newClient(id);
      // A dropped client gets a throwaway record: nothing it opens is kept.
      if (!this.dropped.has(id)) this.clients.set(id, c);
    }
    return c;
  }

  /** Tell every joined session (not this server's own client) something at the top of its next result. */
  notifyJoined(line: string): void {
    for (const c of this.clients.values()) if (c.id !== DEFAULT_CLIENT) c.notices.push(line);
  }

  /** After a takeover: tab ids continue above every id the previous session showed (review item 8). */
  continueTabsAbove(highestSeen: number): void {
    if (!Number.isSafeInteger(highestSeen) || highestSeen > 1e9) return; // R-C3 sanity bound
    if (this.nextTab <= highestSeen) this.nextTab = highestSeen + 1;
  }

  /** The highest tab number issued so far (shared-socket counters, re-check item 2). */
  get highestTab(): number {
    return this.nextTab - 1;
  }

  get running(): boolean {
    return this.context !== undefined;
  }

  get isAttach(): boolean {
    return this.opts.mode !== 'launch';
  }

  get profileLabel(): string {
    if (this.isAttach) return 'attached';
    if (this.opts.isolated) return this.tempDir ?? 'isolated';
    return this.profileInUse ?? this.config.profileDir;
  }

  get version(): string {
    return this.versionStr ?? 'unknown';
  }

  notifyAll(line: string): void {
    for (const c of this.clients.values()) c.notices.push(line);
  }

  /** Lazily start the browser. Never called by initialize/tools/list. */
  async ensure(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.starting) {
      const wasLost = this.lost;
      this.starting = this.start()
        .then((ctx) => {
          if (wasLost) {
            const verb = this.isAttach ? 'reconnected' : 'relaunched';
            this.notifyAll(`notice: the browser was closed or disconnected; ${verb}. Earlier tabs and refs are gone.`);
          }
          this.lost = false;
          return ctx;
        })
        .finally(() => {
          this.starting = undefined;
        });
    }
    return this.starting;
  }

  private async start(): Promise<BrowserContext> {
    const o = this.opts;
    let ctx: BrowserContext;
    if (o.mode === 'launch') {
      ctx = await this.launchContext();
    } else {
      const endpoint = o.mode === 'connect' ? (o.cdpEndpoint ?? this.config.cdpEndpoint) : autoConnectEndpoint(this.config.chromeUserDataDir);
      if (!endpoint) throw new ToolError('connect mode needs a CDP endpoint', 'pass --cdp-endpoint <url> or session launch with cdp_endpoint');
      let browser: Browser;
      try {
        browser = await chromium.connectOverCDP(endpoint, { timeout: this.config.navigationTimeout });
      } catch (e) {
        throw new ToolError(
          `could not connect to Chrome at ${endpoint}: ${firstLine(e)}`,
          o.mode === 'auto_connect'
            ? 'check that Chrome is running with chrome://inspect/#remote-debugging enabled and accept its permission prompt'
            : 'check that Chrome runs with --remote-debugging-port and the endpoint is reachable',
        );
      }
      this.browser = browser;
      this.versionStr = `Chrome/${browser.version()}`;
      browser.on('disconnected', () => this.onLost());
      ctx = browser.contexts()[0] ?? (await browser.newContext());
    }
    this.context = ctx;
    await this.installOriginPolicy(ctx);
    ctx.on('page', (p) => this.onNewPage(p));
    ctx.on('close', () => this.onLost());
    const existing = ctx.pages();
    if (this.isAttach) {
      const c = this.client(DEFAULT_CLIENT);
      for (const p of existing) {
        const t = this.register(p, DEFAULT_CLIENT, undefined);
        if (c.active === undefined) activate(c, t.id);
      }
    } else {
      // Contract Q10: the initial blank tab of a fresh launch is t1 (active for the default client).
      const c = this.client(DEFAULT_CLIENT);
      for (const p of existing) {
        const t = this.register(p, DEFAULT_CLIENT, undefined);
        t.pristine = p.url() === 'about:blank';
        if (c.active === undefined) activate(c, t.id);
      }
    }
    if (!this.versionStr) this.versionStr = await this.detectVersion(ctx);
    return ctx;
  }

  /**
   * Origin lists (review item 2, re-check item 3, round 3 C5/C8). One browser-level CDP session pauses, in
   * Chrome's network stack, only the requests a list could refuse (`Fetch.enable` with URL patterns,
   * request stage), and this process refuses or continues each with checkOrigin. That covers every
   * target of the browser (tabs, popups from their first request, iframes in or out of process, dedicated
   * and service workers) and every redirect hop, which arrives as its own paused request. Nothing else is
   * paused, and the HTTP cache stays on.
   * - `--blocked-origins` alone: patterns for the listed hosts only (a superset; checkOrigin decides).
   * - `--allowed-origins`: any http(s) request can be refused, so every one of them pauses here (the cost
   *   of an allow-list; docs/safety.md "Origin lists").
   * - WebSockets: Fetch does not see the handshake, so `ctx.routeWebSocket` (an in-page shim, no request
   *   interception) checks them.
   * Without a Browser object (not seen with Chrome; kept as a fallback) the old mechanism applies:
   * `ctx.route`, which pauses every request of every page and turns the cache off, plus
   * Network.setBlockedURLs per tab for subresource redirect hops; a navigation redirect hop is then only
   * caught at commit by the landing guard.
   */
  private async installOriginPolicy(ctx: BrowserContext): Promise<void> {
    const c = this.config;
    const match = originRouteMatch(c);
    if (!match) return;
    await ctx.routeWebSocket(match, (ws) => {
      if (checkOrigin(ws.url(), c).ok) {
        ws.connectToServer();
        return;
      }
      ws.close({ code: 1008, reason: 'blocked by the Motorika origin policy' }).catch(() => undefined);
    });
    const browser = ctx.browser();
    if (browser) {
      await this.installFetchPolicy(browser);
      return;
    }
    log.warn('origin lists: no browser-level CDP session; falling back to request routing (slower, cache off)');
    this.routeFallback = true;
    await ctx.route(match, (route) => {
      if (checkOrigin(route.request().url(), c).ok) return route.fallback().catch(() => undefined);
      return route.abort('blockedbyclient').catch(() => undefined);
    });
  }

  private async installFetchPolicy(browser: Browser): Promise<void> {
    const c = this.config;
    const urls = c.allowedOrigins.length > 0 ? ['http://*', 'https://*'] : blockedUrlPatterns(c);
    const s = await browser.newBrowserCDPSession();
    s.on('Fetch.requestPaused', (e: { requestId: string; request: { url: string } }) => {
      const ok = checkOrigin(e.request.url, c).ok;
      const send = ok
        ? s.send('Fetch.continueRequest', { requestId: e.requestId })
        : s.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' });
      send.catch((err: unknown) => log.debug('origin policy: paused request not answered', err));
    });
    await s.send('Fetch.enable', { patterns: urls.map((urlPattern) => ({ urlPattern, requestStage: 'Request' as const })) });
  }

  /** Fallback only (no Browser object): subresource redirect hops into a blocked host, per tab. */
  private installBlockedUrls(tab: Tab): void {
    if (!this.routeFallback) return;
    const urls = blockedUrlPatterns(this.config);
    if (urls.length === 0) return;
    void tab
      .cdp()
      .then(async (s) => {
        await s.send('Network.enable');
        await s.send('Network.setBlockedURLs', { urls });
      })
      .catch((e: unknown) => log.debug('blocked-url patterns not installed', e));
  }

  private async launchContext(): Promise<BrowserContext> {
    const o = this.opts;
    const c = this.config;
    let dir: string;
    if (o.isolated) {
      dir = mkdtempSync(join(tmpdir(), TEMP_PROFILE_PREFIX));
      this.tempDir = dir;
    } else {
      dir = c.profileDir;
      mkdirSync(dir, { recursive: true });
      const lock = readProfileLock(dir);
      // A lock naming another host (a Mac's hostname can follow DHCP) cannot be checked here: let Chrome
      // decide, and explain how to clear it if Chrome refuses (review W4).
      if (lock && lock.alive === true) {
        // No Motorika server owns the profile (the share router would have joined it), so this is a
        // foreign Chrome, e.g. a `motorika open` login window.
        throw new ToolError(
          `profile ${dir} is in use by another Chrome (pid ${lock.pid}${lock.alive === undefined ? ` on host ${lock.host}` : ''}) that is not a Motorika server, e.g. a \`motorika open\` window`,
          'close that Chrome window and retry, or start this server with --isolated or another --profile-dir',
        );
      }
    }
    this.profileInUse = dir;
    const listSwitches = originListSwitches(c);
    if (listSwitches.length > 0) disablePreloading(dir);
    try {
      const ctx = await chromium.launchPersistentContext(dir, {
        ...(c.executablePath ? { executablePath: c.executablePath } : { channel: c.browser }),
        headless: o.headless,
        // Playwright adds --no-sandbox unless this is true; the sandbox stays on unless --no-sandbox (S1/S2).
        chromiumSandbox: !c.noSandbox,
        // G1: only with an origin list; without one Chrome starts exactly as before.
        ...(listSwitches.length > 0 ? { args: listSwitches } : {}),
        viewport: c.viewport,
        acceptDownloads: true,
        timeout: c.navigationTimeout,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      return ctx;
    } catch (e) {
      this.cleanupTemp();
      const lock = readProfileLock(dir);
      if (lock && lock.alive) {
        throw new ToolError(`profile ${dir} is in use by another Chrome (pid ${lock.pid})`, 'close that Chrome or use --isolated / another --profile-dir');
      }
      if (lock && lock.alive === undefined) {
        throw new ToolError(
          `Chrome refused profile ${dir}: its lock names host "${lock.host}" pid ${lock.pid}, not this computer (${hostname()}); a hostname that changed (DHCP) leaves such a lock behind`,
          `if no Chrome uses this profile, remove the lock and retry: rm ${join(dir, 'SingletonLock')} ${join(dir, 'SingletonCookie')} ${join(dir, 'SingletonSocket')}`,
        );
      }
      throw new ToolError(
        `could not launch ${c.executablePath ?? c.browser}: ${firstLine(e)}`,
        'check that Google Chrome is installed, or pass --executable-path <chrome binary>',
      );
    }
  }

  private async detectVersion(ctx: BrowserContext): Promise<string> {
    const b = ctx.browser();
    if (b) return `Chrome/${b.version()}`;
    try {
      const page = ctx.pages()[0];
      if (!page) return 'unknown';
      const s = await ctx.newCDPSession(page);
      const v = (await s.send('Browser.getVersion')) as { product: string };
      await s.detach().catch(() => undefined);
      return v.product;
    } catch {
      return 'unknown';
    }
  }

  private onLost(): void {
    if (this.closing || !this.context) return;
    log.warn('browser disconnected');
    this.lost = true;
    this.resetState();
  }

  private resetState(): void {
    for (const t of this.tabs.values()) {
      t.closed = true;
      this.refs.forgetTab(t.id);
    }
    this.tabs.clear();
    this.pageToTab.clear();
    this.spare = [];
    for (const c of this.clients.values()) {
      c.active = undefined;
      c.history = [];
      c.owned.clear();
    }
    this.context = undefined;
    this.browser = undefined;
    this.cleanupTemp();
  }

  private cleanupTemp(): void {
    if (this.tempDir) {
      const d = this.tempDir;
      this.tempDir = undefined;
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (e) {
        log.warn(`could not remove temp profile ${d}`, e);
      }
    }
  }

  private register(page: Page, owner: string, openerId: string | undefined): Tab {
    const existing = this.pageToTab.get(page);
    if (existing) return existing;
    const id = `t${this.nextTab++}`;
    const tab = new Tab(id, page, owner, {
      nextRequestId: () => `r${this.nextReq++}`,
      downloadsDir: join(this.config.outputDir, 'downloads'),
      urlPolicy: this.config,
      onMainDocument: (t, committedAt) => this.refs.forgetFrameBefore(t.id, t.frameLabel(t.page.mainFrame()), committedAt),
      onFrameDetached: (t, label) => this.refs.forgetFrame(t.id, label),
    });
    tab.openerId = openerId;
    this.tabs.set(id, tab);
    this.pageToTab.set(page, tab);
    // Never create a client here: a page that arrives for a dropped client is closed (P8).
    const ownerClient = this.clients.get(owner);
    if (ownerClient && !this.dropped.has(owner)) ownerClient.owned.add(id);
    else void page.close().catch(() => undefined);
    this.spare = this.spare.filter((p) => p !== page);
    page.on('close', () => this.onPageClosed(tab));
    this.installBlockedUrls(tab);
    return tab;
  }

  tabForPage(page: Page): Tab | undefined {
    return this.pageToTab.get(page);
  }

  private onPageClosed(tab: Tab): void {
    if (tab.closed) return;
    tab.closed = true;
    this.tabs.delete(tab.id);
    this.pageToTab.delete(tab.page);
    this.refs.forgetTab(tab.id);
    for (const c of this.clients.values()) removeFromClient(c, tab.id);
  }

  private onNewPage(page: Page): void {
    // Round 3 C8: the origin lists refuse a popup's first request (or its redirect hop) inside Chrome, so
    // the popup shows an error page; remember which URL was refused, to report it.
    let refused: { url: string; reason: string } | undefined;
    const onFail = (r: Request) => {
      if (refused || !r.isNavigationRequest() || r.frame() !== page.mainFrame()) return;
      if (!(r.failure()?.errorText ?? '').includes('ERR_BLOCKED_BY_CLIENT')) return;
      const v = guardLanding(r.url(), this.config);
      if (!v.ok) refused = { url: r.url(), reason: v.reason };
    };
    page.on('requestfailed', onFail);
    const p = (async () => {
      const openerPage = await page.opener().catch(() => null);
      if (this.pageToTab.has(page)) return;
      let openerTab = openerPage ? this.pageToTab.get(openerPage) : undefined;
      if (!openerTab && this.creating > 0) return; // our own tabs new; registered by newTab()
      if (!openerTab) {
        const acting = this.actionTabs[this.actionTabs.length - 1];
        openerTab = acting ? this.tabs.get(acting) : undefined;
      }
      if (!openerTab && (this.isAttach || this.spare.includes(page))) {
        if (this.isAttach) this.register(page, DEFAULT_CLIENT, undefined);
        return;
      }
      // Re-check item 4 (NEW-1): the first URL of a page opened by a page (popup, target=_blank,
      // window.open) obeys the URL policy BEFORE the page is registered or activated. The Tab's own
      // landing guard attaches only at registration, so it cannot see this first navigation.
      if (page.url() === 'about:blank' || page.url() === '') {
        await page.waitForURL((u) => u.href !== 'about:blank', { timeout: 1500, waitUntil: 'commit' }).catch(() => undefined);
      }
      if (this.pageToTab.has(page)) return;
      const first = page.url();
      const checked = first === '' || first === 'about:blank' ? { ok: true as const } : checkNavigation(first, this.config);
      const v = refused ? { ok: false as const, reason: refused.reason } : checked;
      if (!v.ok) {
        void page.close().catch(() => undefined);
        const report = openerTab ?? this.activeOf(DEFAULT_CLIENT);
        report?.pushEvent(RANK.blocked, `${ARROW}blocked ${safeUrl(refused?.url ?? first)} (${v.reason})`);
        return;
      }
      if (!openerTab) {
        this.register(page, DEFAULT_CLIENT, undefined);
        return;
      }
      const tab = this.register(page, openerTab.owner, openerTab.id);
      activate(this.client(openerTab.owner), tab.id);
      openerTab.pushEvent(RANK.newTab, effect.newTab(tab.id, page.url()));
    })()
      .catch((e: unknown) => log.debug('popup registration failed', e))
      .finally(() => page.off('requestfailed', onFail));
    this.pendingPopups.add(p);
    void p.finally(() => this.pendingPopups.delete(p));
  }

  private activeOf(clientId: string): Tab | undefined {
    const id = this.clients.get(clientId)?.active;
    return id === undefined ? undefined : this.tabs.get(id);
  }

  async waitPopups(timeoutMs: number): Promise<void> {
    if (this.pendingPopups.size === 0) return;
    await Promise.race([Promise.allSettled([...this.pendingPopups]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** Open a new tab for a client (reusing the initial blank page in launch modes). */
  async newTab(clientId: string, background: boolean): Promise<Tab> {
    const ctx = await this.ensure();
    const c = this.client(clientId);
    const reuse = this.clientTabs(clientId).find((t) => t.pristine && !t.closed && t.page.url() === 'about:blank');
    if (reuse) {
      reuse.pristine = false;
      if (!background || c.active === undefined) activate(c, reuse.id);
      return reuse;
    }
    let page = this.spare.shift();
    if (!page || page.isClosed()) {
      this.creating++;
      try {
        page = await ctx.newPage();
      } finally {
        this.creating--;
      }
    }
    const tab = this.register(page, clientId, undefined);
    if (!background || c.active === undefined) activate(c, tab.id);
    return tab;
  }

  /** The client's active tab, creating one if the client has none. */
  async activeTab(clientId: string): Promise<Tab> {
    await this.ensure();
    const c = this.client(clientId);
    if (c.active) {
      const t = this.tabs.get(c.active);
      if (t && !t.closed) return t;
    }
    return this.newTab(clientId, false);
  }

  /** A joined session went away: close its tabs and forget the client. */
  async dropClient(clientId: string): Promise<void> {
    if (clientId === DEFAULT_CLIENT) return;
    this.dropped.add(clientId);
    const tabs = this.clientTabs(clientId);
    this.clients.delete(clientId);
    await Promise.all(tabs.map((t) => t.page.close().catch(() => undefined)));
  }

  getTab(id: string): Tab | undefined {
    return this.tabs.get(id);
  }

  clientTabs(clientId: string): Tab[] {
    const c = this.client(clientId);
    return [...this.tabs.values()].filter((t) => c.owned.has(t.id));
  }

  /** Close the browser (launch) or disconnect (attach). Tabs are not carried over. */
  async close(): Promise<void> {
    if (!this.context && !this.starting) return;
    if (this.starting) await this.starting.catch(() => undefined);
    this.closing = true;
    try {
      if (this.isAttach) {
        await withDeadline(this.browser?.close() ?? Promise.resolve(), 3000);
      } else {
        const ctx = this.context;
        const dir = this.profileInUse;
        const ok = await withDeadline(ctx?.close() ?? Promise.resolve(), 3000);
        if (!ok && dir) this.killProfileChrome(dir);
      }
    } finally {
      this.resetState();
      this.closing = false;
    }
  }

  /** Last resort for a stuck close: kill the Chrome that holds OUR profile lock (a process we launched). */
  private killProfileChrome(dir: string): void {
    const lock = readProfileLock(dir);
    if (lock?.alive) {
      try {
        process.kill(lock.pid, 'SIGKILL');
        log.warn(`killed stuck Chrome pid ${lock.pid}`);
      } catch (e) {
        log.warn('kill failed', e);
      }
    }
  }

  /** Restart with new options (session launch). */
  async relaunch(next: LaunchOptions): Promise<void> {
    // G3: an attach-mode server that now launches Chrome says again that this Chrome has no sandbox.
    if (next.mode === 'launch' && this.opts.mode !== 'launch' && this.config.noSandbox) {
      log.warn('--no-sandbox: session launch mode=launch starts Chrome WITHOUT its sandbox; a compromised page renderer runs with your user rights');
    }
    await this.close();
    this.lost = false;
    this.opts = next;
    this.versionStr = undefined;
    await this.ensure();
  }

  tempProfileDir(): string | undefined {
    return this.tempDir;
  }

  profileExists(): boolean {
    return existsSync(this.config.profileDir);
  }
}

export async function withDeadline(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const r = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((res) => {
      timer = setTimeout(() => res(false), ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return r;
}
