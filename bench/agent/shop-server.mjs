// T4 shop fixture: a small server-rendered shop on localhost that mirrors the saucedemo flow (login, inventory,
// cart, checkout form, overview with item total, tax and total, Finish). Plain HTML forms and links, no scripts.
//
// Every T4 run gets its own random run id, and all of its pages live under /r/<runId>/. Cookies are scoped to that
// path, so runs cannot see each other's sessions or orders, even in one shared browser profile (Claude in Chrome,
// BrowserMCP). Finish (POST) is the only thing that records an order: an unguessable 8-character base32 order id,
// shown on the confirmation page and appended to the run's order log. The confirmation page shows an id only to the
// session that placed the order; a direct visit shows none and records nothing.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const SHOP_USER = 'shopper';
// Random-looking and not a known demo password, so Chrome's data-breach warning has nothing to match.
export const SHOP_PASSWORD = 'qT7-vRw2-Lx9k';
export const TAX_RATE = 0.08;
export const ITEMS = [
  { id: 'lantern', name: 'Trail Lantern', price: 24.5 },
  { id: 'flask', name: 'Steel Flask', price: 18.99 },
  { id: 'jacket', name: 'Canvas Field Jacket', price: 49.99 },
  { id: 'cap', name: 'Wool Cap', price: 12.0 },
  { id: 'pack', name: 'Day Pack 20L', price: 39.95 },
  { id: 'mug', name: 'Enamel Mug', price: 9.5 },
];

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** n random base32 characters (5 bits each, from crypto randomness). */
export function base32Id(n = 8) {
  const bytes = randomBytes(n);
  return [...bytes].map((b) => B32[b & 31]).join('');
}
const money = (v) => `$${v.toFixed(2)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function totals(itemIds) {
  const itemTotal = Math.round(itemIds.reduce((n, id) => n + ITEMS.find((i) => i.id === id).price, 0) * 100) / 100;
  const tax = Math.round(itemTotal * TAX_RATE * 100) / 100;
  return { itemTotal, tax, total: Math.round((itemTotal + tax) * 100) / 100 };
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | Outpost Supply</title></head><body><header><h1>Outpost Supply</h1></header><main><h2>${esc(title)}</h2>${body}</main></body></html>`;
}

async function formBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) break;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * Starts the shop. Returns { port, origin, newRun(), orders(runId), close() }. newRun() returns { runId, url }.
 * orders(runId) is that run's order log: [{ run_id, order_id, items, first_name, last_name, postcode, item_total,
 * tax, total, at }].
 */
export async function startShop({ port = 0, host = '127.0.0.1' } = {}) {
  const runs = new Map(); // runId -> { sessions: Map<sid, session>, orders: [] }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const m = /^\/r\/([A-Z2-7]{16})(\/.*)?$/.exec(url.pathname);
      const run = m && runs.get(m[1]);
      if (!run) return send(res, 404, page('Not found', '<p>No such shop.</p>'));
      const runId = m[1];
      const base = `/r/${runId}`;
      const path = m[2] ?? '/';
      const sid = /(?:^|;\s*)sid=([A-Z2-7]{26})/.exec(req.headers.cookie ?? '')?.[1];
      const s = sid ? run.sessions.get(sid) : undefined;
      const go = (to, extra = {}) => send(res, 303, '', { location: `${base}${to}`, ...extra });
      const nav = `<nav><a href="${base}/inventory">Products</a> | <a href="${base}/cart">Cart (${s?.cart.length ?? 0})</a></nav>`;

      if (path === '/' && req.method === 'GET') {
        const err = url.searchParams.get('error') ? '<p role="alert">Username and password do not match.</p>' : '';
        return send(
          res,
          200,
          page(
            'Log in',
            `${err}<form method="post" action="${base}/login"><label>Username <input name="username" autocomplete="off"></label> <label>Password <input name="password" type="password" autocomplete="off"></label> <button type="submit">Log in</button></form><p>Demo credentials: username <code>${SHOP_USER}</code>, password <code>${SHOP_PASSWORD}</code>.</p>`,
          ),
        );
      }
      if (path === '/login' && req.method === 'POST') {
        const f = await formBody(req);
        if (f.username !== SHOP_USER || f.password !== SHOP_PASSWORD) return go('/?error=1');
        const id = base32Id(26);
        run.sessions.set(id, { cart: [], info: null, lastOrder: null });
        return go('/inventory', { 'set-cookie': `sid=${id}; Path=${base}/; HttpOnly; SameSite=Lax` });
      }
      // Everything below needs a logged-in session of this run.
      if (!s) {
        if (path === '/complete') return send(res, 200, page('Checkout: Complete', '<p>There is no order to show. Please log in and place an order.</p>'));
        return go('/');
      }
      if (path === '/inventory' && req.method === 'GET') {
        const rows = ITEMS.map(
          (i) => `<li><h3>${esc(i.name)}</h3><p>${money(i.price)}</p><form method="post" action="${base}/cart/add"><input type="hidden" name="item" value="${i.id}"><button type="submit">Add ${esc(i.name)} to cart</button></form></li>`,
        ).join('');
        return send(res, 200, page('Products', `${nav}<ul>${rows}</ul>`));
      }
      if (path === '/cart/add' && req.method === 'POST') {
        const f = await formBody(req);
        if (ITEMS.some((i) => i.id === f.item) && !s.cart.includes(f.item)) s.cart.push(f.item);
        return go('/inventory');
      }
      if (path === '/cart/remove' && req.method === 'POST') {
        const f = await formBody(req);
        s.cart = s.cart.filter((id) => id !== f.item);
        return go('/cart');
      }
      if (path === '/cart' && req.method === 'GET') {
        const rows = s.cart
          .map((id) => ITEMS.find((i) => i.id === id))
          .map((i) => `<li>1 x ${esc(i.name)} ${money(i.price)} <form method="post" action="${base}/cart/remove"><input type="hidden" name="item" value="${i.id}"><button type="submit">Remove ${esc(i.name)}</button></form></li>`)
          .join('');
        const next = s.cart.length ? `<p><a href="${base}/checkout">Checkout</a></p>` : '<p>Your cart is empty.</p>';
        return send(res, 200, page('Your cart', `${nav}<ul>${rows}</ul><p><a href="${base}/inventory">Continue shopping</a></p>${next}`));
      }
      if (path === '/checkout' && req.method === 'GET') {
        if (!s.cart.length) return go('/cart');
        const err = url.searchParams.get('error') ? '<p role="alert">First name, last name and postal code are required.</p>' : '';
        return send(
          res,
          200,
          page(
            'Checkout: Your information',
            `${err}<form method="post" action="${base}/checkout"><label>First name <input name="first_name"></label> <label>Last name <input name="last_name"></label> <label>Postal code <input name="postcode"></label> <button type="submit">Continue</button></form><p><a href="${base}/cart">Cancel</a></p>`,
          ),
        );
      }
      if (path === '/checkout' && req.method === 'POST') {
        const f = await formBody(req);
        const info = { first_name: (f.first_name ?? '').trim(), last_name: (f.last_name ?? '').trim(), postcode: (f.postcode ?? '').trim() };
        if (!info.first_name || !info.last_name || !info.postcode) return go('/checkout?error=1');
        s.info = info;
        return go('/overview');
      }
      if (path === '/overview' && req.method === 'GET') {
        if (!s.cart.length) return go('/cart');
        if (!s.info) return go('/checkout');
        const t = totals(s.cart);
        const rows = s.cart.map((id) => ITEMS.find((i) => i.id === id)).map((i) => `<li>1 x ${esc(i.name)} ${money(i.price)}</li>`).join('');
        return send(
          res,
          200,
          page(
            'Checkout: Overview',
            `<ul>${rows}</ul><p>Ship to: ${esc(s.info.first_name)} ${esc(s.info.last_name)}, ${esc(s.info.postcode)}</p><p>Item total: ${money(t.itemTotal)}</p><p>Tax: ${money(t.tax)}</p><p>Total: ${money(t.total)}</p><form method="post" action="${base}/finish"><button type="submit">Finish</button></form><p><a href="${base}/cart">Cancel</a></p>`,
          ),
        );
      }
      if (path === '/finish' && req.method === 'POST') {
        if (!s.cart.length || !s.info) return go('/overview');
        const t = totals(s.cart);
        const order = { run_id: runId, order_id: base32Id(8), items: s.cart.map((id) => ITEMS.find((i) => i.id === id).name), ...s.info, item_total: t.itemTotal, tax: t.tax, total: t.total, at: new Date().toISOString() };
        run.orders.push(order);
        s.lastOrder = order.order_id;
        s.cart = [];
        s.info = null;
        return go('/complete');
      }
      if (path === '/complete' && req.method === 'GET') {
        if (!s.lastOrder) return send(res, 200, page('Checkout: Complete', '<p>There is no order to show.</p>'));
        return send(res, 200, page('Checkout: Complete', `<p><strong>Thank you for your order!</strong></p><p>Your order number is <strong>${s.lastOrder}</strong>.</p><p><a href="${base}/inventory">Back to products</a></p>`));
      }
      if (path === '/logout' && req.method === 'POST') {
        run.sessions.delete(sid);
        return go('/');
      }
      return send(res, 404, page('Not found', `${nav}<p>No such page.</p>`));
    } catch (e) {
      return send(res, 500, page('Error', `<p>${esc(e?.message ?? e)}</p>`));
    }
  });

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(body);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  // The address the server is bound to (loopback only, never the LAN). `localhost` could resolve to ::1 first.
  const origin = `http://${host}:${actual}`;
  return {
    port: actual,
    origin,
    newRun() {
      const runId = base32Id(16);
      runs.set(runId, { sessions: new Map(), orders: [] });
      return { runId, url: `${origin}/r/${runId}/` };
    },
    orders: (runId) => [...(runs.get(runId)?.orders ?? [])],
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// By hand: `node bench/agent/shop-server.mjs [port]` (default 47823) starts the shop with one run and prints its URL,
// e.g. to grant Claude in Chrome its site permission for 127.0.0.1 before a B2 run. Ctrl-C stops it.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const shop = await startShop({ port: Number(process.argv[2] ?? 47823) });
  process.stdout.write(`shop running: ${shop.newRun().url}\n(Ctrl-C to stop)\n`);
}
