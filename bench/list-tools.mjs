// Print each contender's tool names and input schemas (for choosing each tool's "own best way").
// Usage: node bench/list-tools.mjs <contender-id> [--schemas]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONTENDERS } from './contenders.mjs';

const [, , id, flag] = process.argv;
const c = CONTENDERS.find((x) => x.id === id);
if (!c) { process.stderr.write(`unknown contender ${id}\n`); process.exit(2); }
const transport = new StdioClientTransport({ command: c.command, args: c.args, stderr: 'ignore', ...(c.env && { env: { ...process.env, ...c.env } }) });
const client = new Client({ name: 'x2-bench-list', version: '0.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
const info = client.getServerVersion();
process.stdout.write(`${c.id} server=${JSON.stringify(info)} tools=${tools.length}\n`);
for (const t of tools) {
  process.stdout.write(`- ${t.name}${flag === '--schemas' ? ' ' + JSON.stringify(t.inputSchema?.properties ?? {}) : ''}\n`);
}
await client.close();
