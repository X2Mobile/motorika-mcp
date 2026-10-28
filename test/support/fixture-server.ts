// Fixture server: serves test/fixtures on two different sites so a cross-origin iframe is a real OOPIF.
//   origin A: http://127.0.0.1:<p1>      origin B: http://localhost:<p2>
//
// HTML files are templated: __ORIGIN_A__ / __ORIGIN_B__ / __OTHER_ORIGIN__ become absolute origins.
//
// Routes (both origins):
//   GET  /<file>                 static file from test/fixtures (HTTP Range for every file, HEAD)
//   GET|POST /submit             recorded (urlencoded, multipart with file name + bytes, JSON)
//   GET  /__log[?reset=1]        the records as JSON; reset clears them after reading
//   GET  /slow?ms=N              headers are delayed N ms (default 5000)
//   GET  /status/<code>          that status with a small HTML page
//   GET  /download/<name>        Content-Disposition attachment, bytes from spec.downloadBytes(name)
//   GET  /csp/<page>             test/fixtures/csp/<page> with a strict CSP + Trusted Types header
//   GET  /fail/500               a 500 response
//   GET  /hang                   never answers (sockets are destroyed on close)
//   GET  /api/data               JSON {ok:true}; its request headers are recorded
//   GET  /set-cookie?v=X         sets cookie motorika_acc=X (persistent, 1 h); recorded
//   GET  /echo-cookie            records the Cookie header
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { FIXTURES_DIR } from './paths.ts';
import { downloadBytes, sha256 } from './spec.ts';

export const CSP_HEADER = "script-src 'none'; require-trusted-types-for 'script'";

export interface FileRecord {
  field: string;
  name: string;
  type: string;
  size: number;
  sha256: string;
  text: string;
}

export interface RequestRecord {
  seq: number;
  at: number;
  origin: string;
  method: string;
  path: string;
  query: Record<string, string>;
  contentType: string;
  fields: [string, string][];
  files: FileRecord[];
  json: unknown;
  headers: Record<string, string>;
}

export interface FixtureServer {
  originA: string;
  originB: string;
  /** Absolute URL on origin A (default) or B. */
  url(path: string, origin?: 'A' | 'B'): string;
  /** Records of /submit, /api/data, /set-cookie and /echo-cookie, in arrival order. */
  records(filter?: (r: RequestRecord) => boolean): RequestRecord[];
  submissions(form?: string): RequestRecord[];
  reset(): void;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function safePath(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath);
  const p = normalize(join(root, decoded));
  if (p !== root && !p.startsWith(root + sep)) return null;
  return p;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  let records: RequestRecord[] = [];
  let seq = 0;
  const sockets = new Set<Socket>();
  const origins = { A: '', B: '' };

  async function record(req: IncomingMessage, url: URL, origin: string): Promise<RequestRecord> {
    const body = await readBody(req);
    const contentType = String(req.headers['content-type'] ?? '');
    const fields: [string, string][] = [];
    const files: FileRecord[] = [];
    let json: unknown = null;
    if (body.length > 0) {
      if (contentType.startsWith('multipart/form-data') || contentType.startsWith('application/x-www-form-urlencoded')) {
        const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData();
        for (const [name, value] of form.entries()) {
          if (typeof value === 'string') fields.push([name, value]);
          else {
            const bytes = Buffer.from(await value.arrayBuffer());
            if (value.name === '' && bytes.length === 0) continue; // an empty file input
            files.push({
              field: name,
              name: value.name,
              type: value.type,
              size: bytes.length,
              sha256: sha256(bytes),
              text: bytes.toString('utf8'),
            });
          }
        }
      } else if (contentType.startsWith('application/json')) {
        json = JSON.parse(body.toString('utf8'));
      } else {
        fields.push(['__raw', body.toString('utf8')]);
      }
    }
    if (req.method === 'GET') for (const [k, v] of url.searchParams) if (k !== 'form') fields.push([k, v]);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    seq += 1;
    const rec: RequestRecord = {
      seq,
      at: Date.now(),
      origin,
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      contentType,
      fields,
      files,
      json,
      headers,
    };
    records.push(rec);
    return rec;
  }

  function sendFile(req: IncomingMessage, res: ServerResponse, file: string, extra: Record<string, string> = {}): void {
    const ext = extname(file);
    const type = TYPES[ext] ?? 'application/octet-stream';
    const base = { 'content-type': type, 'cache-control': 'no-store', ...extra };
    if (ext === '.html') {
      const html = readFileSync(file, 'utf8')
        .replaceAll('__ORIGIN_A__', origins.A)
        .replaceAll('__ORIGIN_B__', origins.B);
      const host = String(req.headers.host ?? '');
      const other = host.startsWith('localhost') ? origins.A : origins.B;
      const out = Buffer.from(html.replaceAll('__OTHER_ORIGIN__', other));
      res.writeHead(200, { ...base, 'content-length': String(out.length) });
      res.end(req.method === 'HEAD' ? undefined : out);
      return;
    }
    const size = statSync(file).size;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = m?.[1] ? Number(m[1]) : NaN;
      let end = m?.[2] ? Number(m[2]) : size - 1;
      if (m && !m[1] && m[2]) {
        start = size - Number(m[2]);
        end = size - 1;
      }
      if (!m || Number.isNaN(start) || start >= size || end < start) {
        res.writeHead(416, { ...base, 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        ...base,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...base, 'accept-ranges': 'bytes', 'content-length': String(size) });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  }

  function page(res: ServerResponse, status: number, title: string, body = ''): void {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, originKey: 'A' | 'B'): Promise<void> {
    const origin = origins[originKey];
    const url = new URL(req.url ?? '/', origin);
    const p = url.pathname;
    if (p === '/__log') {
      const out = JSON.stringify(records);
      if (url.searchParams.get('reset') === '1') records = [];
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(out);
      return;
    }
    if (p === '/submit') {
      const rec = await record(req, url, origin);
      page(res, 200, 'Submitted', `<p id="receipt">Recorded submission ${rec.seq}</p>`);
      return;
    }
    if (p === '/api/data') {
      await record(req, url, origin);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
      return;
    }
    if (p === '/echo-cookie') {
      await record(req, url, origin);
      page(res, 200, 'Cookie echo');
      return;
    }
    if (p === '/set-cookie') {
      await record(req, url, origin); // A12: lets a test see when an `open` window loaded the page
      const v = url.searchParams.get('v') ?? 'persist';
      res.setHeader('set-cookie', `motorika_acc=${encodeURIComponent(v)}; Max-Age=3600; Path=/; SameSite=Lax`);
      page(res, 200, 'Cookie set');
      return;
    }
    if (p === '/slow') {
      const ms = Math.min(Number(url.searchParams.get('ms') ?? '5000'), 120_000);
      const timer = setTimeout(() => page(res, 200, 'Slow page'), ms);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    const status = /^\/status\/(\d{3})$/.exec(p);
    if (status) {
      page(res, Number(status[1]), `Status ${status[1]}`);
      return;
    }
    if (p === '/fail/500') {
      page(res, 500, 'Server error');
      return;
    }
    if (p === '/hang') {
      req.resume();
      return; // never answers
    }
    const dl = /^\/download\/([^/]+)$/.exec(p);
    if (dl) {
      const name = decodeURIComponent(dl[1] ?? 'file.bin');
      const bytes = downloadBytes(name);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
        'content-length': String(bytes.length),
        'cache-control': 'no-store',
      });
      res.end(bytes);
      return;
    }
    const csp = /^\/csp\/([^/]+)$/.exec(p);
    if (csp) {
      const file = safePath(join(FIXTURES_DIR, 'csp'), csp[1] ?? '');
      if (file && existsSync(file)) {
        sendFile(req, res, file, { 'content-security-policy': CSP_HEADER });
        return;
      }
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = safePath(FIXTURES_DIR, p === '/' ? '/index.html' : p);
      if (file && existsSync(file) && statSync(file).isFile()) {
        sendFile(req, res, file);
        return;
      }
    }
    page(res, 404, 'Not found');
  }

  function make(key: 'A' | 'B'): Server {
    const s = createServer((req, res) => {
      handle(req, res, key).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err));
      });
    });
    s.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    s.on('clientError', (_err, sock) => sock.destroy());
    return s;
  }

  const listen = (s: Server, host: string, port = 0): Promise<number> =>
    new Promise((resolveListen, reject) => {
      s.once('error', reject);
      s.listen(port, host, () => resolveListen((s.address() as AddressInfo).port));
    });

  const a = make('A');
  const b = make('B');
  const pA = await listen(a, '127.0.0.1');
  const pB = await listen(b, '127.0.0.1');
  origins.A = `http://127.0.0.1:${pA}`;
  origins.B = `http://localhost:${pB}`;
  // localhost may resolve to ::1 first; serve origin B there too when IPv6 loopback exists.
  const b6 = make('B');
  const servers: Server[] = [a, b];
  try {
    await listen(b6, '::1', pB);
    servers.push(b6);
  } catch {
    /* no IPv6 loopback or port taken: Chrome falls back to 127.0.0.1 */
  }

  return {
    originA: origins.A,
    originB: origins.B,
    url: (path, origin = 'A') => `${origins[origin]}${path.startsWith('/') ? '' : '/'}${path}`,
    records: (filter) => (filter ? records.filter(filter) : [...records]),
    submissions: (form) =>
      records.filter((r) => r.path === '/submit' && (form === undefined || r.query.form === form)),
    reset: () => {
      records = [];
    },
    close: async () => {
      for (const s of servers) s.closeAllConnections();
      for (const sock of sockets) sock.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}
