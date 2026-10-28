// stderr logger. stdout carries JSON-RPC only; nothing in src/ may write to it.
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.MOTORIKA_LOG ?? 'info').toLowerCase();
  return raw in order ? order[raw as Level] : order.info;
}

function write(level: Level, msg: string, extra?: unknown): void {
  if (order[level] < threshold()) return;
  let line = `${new Date().toISOString()} motorika ${level} ${msg}`;
  if (extra !== undefined) {
    line += ` ${extra instanceof Error ? (extra.stack ?? extra.message) : safeJson(extra)}`;
  }
  process.stderr.write(`${line}\n`);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => write('debug', m, e),
  info: (m: string, e?: unknown) => write('info', m, e),
  warn: (m: string, e?: unknown) => write('warn', m, e),
  error: (m: string, e?: unknown) => write('error', m, e),
};
