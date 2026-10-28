// Shared harness: spawn a contender over stdio, time calls from the client side, measure output,
// and reap exactly the process tree the bench started (never anything else).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Short root on purpose: macOS caps Unix socket paths at 104 bytes and Chrome puts a socket in its profile.
export const TMP_ROOT = `/tmp/motorika-bench-${process.getuid?.() ?? 0}`;
export const CALL_TIMEOUT_MS = 60_000;

let seq = 0;
/**
 * Dated result name: `<date>-<kind>[-<tag>]`. A tag is 1-64 letters, digits, `.`, `_` or `-`, so it can
 * never leave bench/results. Exits non-zero on a bad tag.
 */
export const MAX_TAG = 64;
export function resultName(date, kind, tag) {
  if (tag === undefined) return `${date}-${kind}`;
  if (!/^[A-Za-z0-9._-]+$/.test(tag) || tag.startsWith('.') || tag.length > MAX_TAG) {
    process.stderr.write(`bad --tag ${JSON.stringify(tag)}: use 1-${MAX_TAG} letters, digits, ".", "_" or "-"\n`);
    process.exit(2);
  }
  return `${date}-${kind}-${tag}`;
}

/** Refuses to overwrite an existing dated result file: prints why and exits non-zero. */
export function refuseOverwrite(file) {
  if (!existsSync(file)) return;
  process.stderr.write(`refusing to overwrite ${file}: it already exists. Pass --tag <name> for a new file, or move the old one.\n`);
  process.exit(1);
}

export function freshTmp(tag) {
  seq += 1;
  const dir = join(TMP_ROOT, `${tag}-${process.pid}-${seq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** All descendants of `root` (pid list), from one `ps` snapshot. */
export function descendants(root) {
  let out = '';
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const kids = new Map();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const all = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    for (const k of kids.get(p) ?? []) {
      all.push(k);
      stack.push(k);
    }
  }
  return all;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a contender. Returns { client, call, close, pid }.
 * `call` returns { ms, text, textChars, imageBytes, images, isError, raw }.
 */
export async function startContender(c) {
  const tmp = freshTmp(c.id);
  const args = [...c.args];
  if (c.outputDirFlag) args.push(c.outputDirFlag, join(tmp, 'out'));
  if (c.freshProfileFlag) args.push(c.freshProfileFlag, join(tmp, 'profile'));
  const transport = new StdioClientTransport({
    command: c.command,
    args,
    cwd: tmp, // tools that write files relative to cwd (Playwright, DevTools) write here
    stderr: 'ignore',
    env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', ...c.env },
  });
  const client = new Client({ name: 'motorika-bench', version: '0.0.0' });
  await client.connect(transport);
  const pid = transport.pid;
  let tree = new Set();

  async function call(name, args = {}, timeout = CALL_TIMEOUT_MS) {
    // Remember the tree while it is alive: a Chrome reparented to launchd after its parent died is still ours.
    for (const p of descendants(pid)) tree.add(p);
    const t0 = performance.now();
    let raw;
    let isError = false;
    try {
      raw = await client.callTool({ name, arguments: args }, undefined, { timeout });
      isError = Boolean(raw.isError);
    } catch (err) {
      raw = { content: [{ type: 'text', text: `CLIENT ERROR: ${err?.message ?? err}` }] };
      isError = true;
    }
    const ms = performance.now() - t0;
    for (const p of descendants(pid)) tree.add(p);
    return { ms, isError, raw, ...measure(raw) };
  }

  async function close() {
    for (const p of descendants(pid)) tree.add(p);
    if (pid) tree.add(pid);
    try {
      await Promise.race([client.close(), sleep(5000)]);
    } catch {
      /* closing a dead transport */
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && [...tree].some(alive)) await sleep(200);
    const survivors = [...tree].filter(alive);
    for (const p of survivors) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Chrome may still be flushing; the root is removed at the end */
    }
    return { killed: survivors.length };
  }

  return { client, call, close, pid, tmp, tree };
}

/** Output size: text chars (token proxy) and image bytes (decoded base64), counted separately. */
export function measure(raw) {
  let textChars = 0;
  let imageBytes = 0;
  let images = 0;
  const texts = [];
  const imgs = [];
  for (const part of raw?.content ?? []) {
    if (part.type === 'text') {
      textChars += part.text.length;
      texts.push(part.text);
    } else if (part.type === 'image') {
      const b = Buffer.from(part.data ?? '', 'base64');
      imageBytes += b.length;
      images += 1;
      imgs.push({ mimeType: part.mimeType, bytes: b });
    } else if (part.type === 'resource') {
      const t = part.resource?.text ?? '';
      textChars += t.length;
      texts.push(t);
    }
  }
  if (raw?.structuredContent) {
    // Counted as text: a client that forwards structured content pays for it too.
    const s = JSON.stringify(raw.structuredContent);
    textChars += s.length;
  }
  return { text: texts.join('\n'), textChars, imageBytes, images, imgs };
}

/** Width/height from a PNG or JPEG header, or null when the bytes are neither. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  if (buf.length > 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { format: 'webp', width: null, height: null };
  }
  return null;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function machineState() {
  const sh = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  };
  return {
    at: new Date().toISOString(),
    uptime: sh('uptime', []),
    swap: sh('sysctl', ['-n', 'vm.swapusage']),
  };
}
