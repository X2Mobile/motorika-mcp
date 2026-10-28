#!/usr/bin/env node
// A deliberately misbehaving MCP stdio server used ONLY by test/harness/client-helper.test.ts to prove
// that the client helper's G1 / G4 / C7 checks catch what they must and allow what they must.
// Tools: echo {text}, sleep {ms}, leak {} (returns the password literal), stray {} (writes a non-JSON
// stdout line, then answers normally), error {} (isError with cause + hint).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const literal = process.env.FAKE_LITERAL ?? 'missing';
const server = new Server({ name: 'fake', version: '0.0.0' }, { capabilities: { tools: {} } });
const tools = ['echo', 'sleep', 'leak', 'stray', 'error'].map((name) => ({ name, inputSchema: { type: 'object' } }));
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments ?? {};
  switch (req.params.name) {
    case 'echo':
      return { content: [{ type: 'text', text: String(a.text ?? '') }] };
    case 'sleep':
      await new Promise((r) => setTimeout(r, Number(a.ms ?? 0)));
      return { content: [{ type: 'text', text: 'slept' }] };
    case 'leak':
      return { content: [{ type: 'text', text: `[t1] value is ${literal}` }] };
    case 'stray':
      process.stdout.write('this is a stray log line\n');
      return { content: [{ type: 'text', text: 'ok' }] };
    case 'error':
      return { isError: true, content: [{ type: 'text', text: 'e12 is stale (element removed)\ntake a new snapshot' }] };
    default:
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
  }
});
await server.connect(new StdioServerTransport());
