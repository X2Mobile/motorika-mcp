// CI smoke: start the built server over stdio and check that it answers initialize and lists its tools.
// It never starts Chrome (the browser starts on the first page tool), so it runs on any machine.
// Usage: node scripts/mcp-smoke.mjs [path/to/dist/index.js]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry = process.argv[2] ?? 'dist/index.js';
const home = mkdtempSync(join(tmpdir(), 'motorika-smoke-'));
const child = spawn(process.execPath, [entry, '--headless', '--isolated'], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
const fail = (msg) => {
  console.error(`mcp-smoke: ${msg}`);
  child.kill();
  process.exit(1);
};
const timer = setTimeout(() => fail('no answer within 20 s'), 20000);
let done = false;
child.on('exit', (code) => { if (!done) fail(`server exited (code ${code}) before answering`); });
let buf = '';
const answers = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
    const line = buf.slice(0, i).trim();
    if (line) {
      const msg = JSON.parse(line);
      answers.get(msg.id)?.(msg);
    }
  }
});
const call = (id, method, params) =>
  new Promise((resolve) => {
    answers.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const init = await call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '1' } });
if (init.result?.serverInfo?.name !== 'motorika') fail(`unexpected initialize answer: ${JSON.stringify(init)}`);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await call(2, 'tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name);
if (names.length < 20 || !names.includes('navigate')) fail(`unexpected tools/list answer: ${names.join(',')}`);
clearTimeout(timer);
done = true;
console.log(`mcp-smoke: ${init.result.serverInfo.name} ${init.result.serverInfo.version} on Node ${process.versions.node}, ${names.length} tools`);
child.stdin.end();
child.on('exit', (code) => process.exit(code ?? 0));
