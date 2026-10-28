// CLI entry: flags/env -> config -> McpServer on stdio. stdout carries JSON-RPC only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Session, withDeadline } from './browser/session.js';
import { ConfigError, HELP, configuredMode, parseConfig, type Config } from './config.js';
import { runOpen } from './cli/open.js';
import { Dispatcher } from './dispatch.js';
import { ShareRouter } from './shared/router.js';
import { toolMap } from './tools/index.js';
import { log } from './util/log.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'open') await runOpen(argv.slice(1));
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(HELP);
    process.exit(0);
  }
  let config: Config;
  try {
    config = parseConfig(argv);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`motorika: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

  if (config.noSandbox) {
    // Round 3 C7 / round 4 G3: connect and auto-connect attach to a Chrome this server did not launch, but
    // `session launch mode=launch` can still launch one, and that one follows the flag.
    const mode = configuredMode(config);
    if (mode !== 'launch') {
      log.warn(
        `--no-sandbox: the Chrome attached in ${mode} mode keeps its own settings; a Chrome this server launches (session launch mode=launch) runs WITHOUT its sandbox, so a compromised page renderer runs with your user rights`,
      );
    } else log.warn('--no-sandbox: Chrome is launched WITHOUT its sandbox; a compromised page renderer runs with your user rights');
  }
  const session = new Session(config);
  const tools = toolMap();
  const dispatcher = new Dispatcher(session, config, tools);
  // Launch mode on a persistent profile: own the profile's browser, or join the server that does.
  const router = new ShareRouter(session, {
    dispatch: (tool, args, clientId) => dispatcher.dispatch(tool, args, clientId),
    dropClient: (clientId) => void session.dropClient(clientId),
    counters: () => ({ ref: session.refs.issued, tab: session.highestTab }),
    raise: (seen) => {
      session.refs.continueAbove(seen.ref);
      session.continueTabsAbove(seen.tab);
    },
  });
  dispatcher.router = router;
  const server = new McpServer({ name: 'motorika', version: VERSION }, { capabilities: { tools: {} } });

  for (const t of tools.values()) {
    server.registerTool(
      t.name,
      {
        ...(t.title ? { title: t.title } : {}),
        description: t.description,
        inputSchema: t.shape,
        annotations: t.annotations,
      },
      async (args: Record<string, unknown>) => (await dispatcher.dispatch(t.name, args)) as CallToolResult,
    );
  }

  // W1: the SDK validates arguments itself and answers "MCP error -32602: Input validation error" with no
  // hint. Route every call through the dispatcher instead; its zod parse gives the two-line cause + hint.
  // (tools/list still renders the registered schemas.)
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    return (await dispatcher.dispatch(request.params.name, args)) as CallToolResult;
  });

  let exiting = false;
  const shutdown = async (why: string) => {
    if (exiting) return;
    exiting = true;
    log.info(`shutting down (${why})`);
    // Stop sharing first: joined sessions see the socket close and take over on their next call.
    await withDeadline(router.close(), 500);
    await withDeadline(session.close(), 4000);
    await withDeadline(server.close(), 500);
    process.exit(0);
  };
  process.stdin.on('end', () => void shutdown('stdin closed'));
  process.stdin.on('close', () => void shutdown('stdin closed'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown('transport closed');
  await server.connect(transport);
  log.info(`motorika ${VERSION} ready (mode=${session.opts.mode} headless=${session.opts.headless})`);
}

main().catch((e: unknown) => {
  log.error('fatal', e);
  process.exit(1);
});
