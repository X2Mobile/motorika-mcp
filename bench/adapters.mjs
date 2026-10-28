// Each contender's "own best way" for every micro step, plus a page-state oracle (evaluate) that is
// called out of band: oracle calls are never timed, counted or measured.
//
// A step function returns the list of timed call results; the runner sums ms, chars and calls.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Run JS in the page; the value comes back wrapped in a marker so every tool's text format parses. */
const MARK = (expr) => `'@@'+encodeURIComponent(JSON.stringify(${expr}))+'@@'`;
export function parseMarked(text) {
  const m = /@@([^@"\\\s]*)@@/.exec(text);
  if (!m) return { ok: false, value: undefined };
  try {
    return { ok: true, value: JSON.parse(decodeURIComponent(m[1])) };
  } catch {
    return { ok: false, value: undefined };
  }
}

function need(ref, what) {
  if (!ref) throw new Error(`ref not found in snapshot: ${what}`);
  return ref;
}

// Elements every adapter must locate, by role + accessible name, in its own snapshot format.
export const FORM = {
  full_name: { role: 'textbox', name: 'Full name', id: 'full_name' },
  email: { role: 'textbox', name: 'Email', id: 'email' },
  password: { role: 'textbox', name: 'Password', id: 'password' },
  comments: { role: 'textbox', name: 'Comments', id: 'comments' },
  country: { role: 'combobox', name: 'Country', id: 'country' },
  subscribe: { role: 'checkbox', name: 'Subscribe to newsletter', id: 'subscribe' },
  plan: { role: 'radio', name: 'Pro', label: 'Pro' },
  start_date: { role: 'textbox', name: 'Start date', id: 'start_date', dtRole: 'Date' },
  submit: { role: 'button', name: 'Send form', submit: true },
};

export function formValues(i) {
  return {
    full_name: `Bench User ${i}`,
    email: `bench${i}@example.com`,
    password: `pw-${i}-bench`,
    comments: `run ${i} comments`,
    country: { label: 'Romania', value: 'ro' },
    subscribe: true,
    plan: 'pro',
    start_date: '2026-10-23',
  };
}

/** What /submit?form=full must have recorded for run i (the oracle, from the fixture's field names). */
export function expectedSubmission(i) {
  const v = formValues(i);
  return {
    full_name: v.full_name,
    email: v.email,
    password: v.password,
    comments: v.comments,
    country: 'ro',
    subscribe: 'yes',
    plan: 'pro',
    start_date: v.start_date,
  };
}

export const ADAPTERS = {
  'motorika': {
    nav: async (h, url) => [await h.call('navigate', { url })],
    async navSnap(h, url) {
      return [await h.call('navigate', { url, snapshot: true })];
    },
    async snapAll(h) {
      const out = [await h.call('snapshot', {})];
      // Paged at --max-output-chars: follow the continuation offsets until the whole tree is read.
      for (let guard = 0; guard < 20; guard += 1) {
        const m = /offset=(\d+) to continue/.exec(out[out.length - 1].text);
        if (!m) break;
        out.push(await h.call('snapshot', { offset: Number(m[1]) }));
      }
      return out;
    },
    snapshot: (h) => h.call('snapshot', {}),
    ref: (text, el) => new RegExp(`${el.role} "${esc(el.name)}" (e\\d+)`).exec(text)?.[1],
    click: async (h, ref) => [await h.call('click', { target: ref })],
    type: async (h, ref, text) => [await h.call('type', { target: ref, text })],
    async fill(h, refs, i) {
      const v = formValues(i);
      const fields = [
        { target: refs.full_name, value: v.full_name },
        { target: refs.email, value: v.email },
        { target: refs.password, value: v.password },
        { target: refs.comments, value: v.comments },
        { target: refs.country, value: v.country.label },
        { target: refs.subscribe, value: true },
        { target: refs.plan, value: true },
        { target: refs.start_date, value: v.start_date },
      ];
      return [await h.call('fill_form', { fields, submit: refs.submit })];
    },
    shot: async (h) => [await h.call('screenshot', {})],
    evaluate: (h, expr) => h.call('evaluate', { script: MARK(expr) }),
  },

  playwright: {
    nav: async (h, url) => [await h.call('browser_navigate', { url })],
    async navSnap(h, url) {
      // 0.0.83 writes the navigate snapshot to a file and returns a link, so the tree needs a second call.
      return [await h.call('browser_navigate', { url }), await h.call('browser_snapshot', {})];
    },
    snapAll: async (h) => [await h.call('browser_snapshot', {})],
    snapshot: (h) => h.call('browser_snapshot', {}),
    ref: (text, el) =>
      new RegExp(`${el.role} "${esc(el.name)}"[^\\n]*?\\[ref=(\\w+)\\]`).exec(text)?.[1],
    click: async (h, ref) => [await h.call('browser_click', { target: ref, element: 'button' })],
    type: async (h, ref, text) => [await h.call('browser_type', { target: ref, element: 'input', text })],
    async fill(h, refs, i) {
      const v = formValues(i);
      const f = (k, type, value) => ({ target: refs[k], name: FORM[k].name, type, value });
      const fields = [
        f('full_name', 'textbox', v.full_name),
        f('email', 'textbox', v.email),
        f('password', 'textbox', v.password),
        f('comments', 'textbox', v.comments),
        f('country', 'combobox', v.country.label),
        f('subscribe', 'checkbox', 'true'),
        f('plan', 'radio', 'true'),
        f('start_date', 'textbox', v.start_date),
      ];
      return [
        await h.call('browser_fill_form', { fields }),
        await h.call('browser_click', { target: refs.submit, element: 'Send form' }),
      ];
    },
    shot: async (h) => [await h.call('browser_take_screenshot', {})],
    evaluate: (h, expr) => h.call('browser_evaluate', { function: `() => ${MARK(expr)}` }),
  },

  devtools: {
    // Default --page-id-routing requires pageId; the first page of a fresh isolated browser is 1.
    nav: async (h, url) => [await h.call('navigate_page', { pageId: 1, type: 'url', url })],
    async navSnap(h, url) {
      return [
        await h.call('navigate_page', { pageId: 1, type: 'url', url }),
        await h.call('take_snapshot', { pageId: 1 }),
      ];
    },
    snapAll: async (h) => [await h.call('take_snapshot', { pageId: 1 })],
    snapshot: (h) => h.call('take_snapshot', { pageId: 1 }),
    ref: (text, el) =>
      new RegExp(`uid=(\\S+) ${el.dtRole ?? el.role} "${esc(el.name)}"`).exec(text)?.[1],
    click: async (h, ref) => [await h.call('click', { pageId: 1, uid: ref })],
    type: async (h, ref, text) => [await h.call('fill', { pageId: 1, uid: ref, value: text })],
    async fill(h, refs, i) {
      const v = formValues(i);
      const elements = [
        { uid: refs.full_name, value: v.full_name },
        { uid: refs.email, value: v.email },
        { uid: refs.password, value: v.password },
        { uid: refs.comments, value: v.comments },
        { uid: refs.country, value: v.country.label },
        { uid: refs.subscribe, value: 'true' },
        { uid: refs.plan, value: 'true' },
        { uid: refs.start_date, value: v.start_date },
      ];
      return [
        await h.call('fill_form', { pageId: 1, elements }),
        await h.call('click', { pageId: 1, uid: refs.submit }),
      ];
    },
    shot: async (h) => [await h.call('take_screenshot', { pageId: 1 })],
    evaluate: (h, expr) => h.call('evaluate_script', { pageId: 1, function: `() => ${MARK(expr)}` }),
  },

  'agent-infra': {
    nav: async (h, url) => [await h.call('browser_navigate', { url })],
    // Its navigate already returns the indexed clickable-element list (its "snapshot"); no a11y tree tool.
    navSnap: async (h, url) => [await h.call('browser_navigate', { url })],
    snapAll: async (h) => [await h.call('browser_get_clickable_elements', {})],
    snapshot: (h) => h.call('browser_get_clickable_elements', {}),
    ref(text, el) {
      if (el.id) return new RegExp(`\\[(\\d+)\\] \\[[^\\]]*id="${esc(el.id)}"`).exec(text)?.[1];
      if (el.label) return new RegExp(`\\[(\\d+)\\] \\[label\\] <label>${esc(el.label)}</label>`).exec(text)?.[1];
      if (el.submit) return /\[(\d+)\] \[submit\]/.exec(text)?.[1];
      return new RegExp(`\\[(\\d+)\\] [^\\n]*>${esc(el.name)}<`).exec(text)?.[1];
    },
    click: async (h, ref) => [await h.call('browser_click', { index: Number(ref) })],
    type: async (h, ref, text) => [await h.call('browser_form_input_fill', { index: Number(ref), value: text, clear: true })],
    async fill(h, refs, i) {
      // No form tool: one call per field, select and click separately, then the submit click.
      const v = formValues(i);
      const out = [];
      const fillIdx = (k, value) => h.call('browser_form_input_fill', { index: Number(refs[k]), value, clear: true });
      out.push(await fillIdx('full_name', v.full_name));
      out.push(await fillIdx('email', v.email));
      out.push(await fillIdx('password', v.password));
      out.push(await fillIdx('comments', v.comments));
      out.push(await h.call('browser_select', { index: Number(refs.country), value: v.country.value }));
      out.push(await h.call('browser_click', { index: Number(refs.subscribe) }));
      out.push(await h.call('browser_click', { index: Number(refs.plan) }));
      out.push(await fillIdx('start_date', v.start_date));
      out.push(await h.call('browser_click', { index: Number(refs.submit) }));
      return out;
    },
    shot: async (h) => [await h.call('browser_screenshot', {})],
    evaluate: (h, expr) => h.call('browser_evaluate', { script: `() => ${MARK(expr)}` }),
  },
};

// ---- Adapters for tools without a structured snapshot (vision, CSS selectors) ----

/**
 * Untimed preparation for tools that have no element refs: one page evaluate that returns every form control's
 * attributes, accessible name and viewport-centre coordinates, plus the date-field segment order of the browser
 * locale. It plays the part the snapshot plays for the ref-based adapters (the d/e/f prep is never timed).
 */
const PREP = `(() => {
  const nm = (e) => ((e.labels && e.labels[0] ? e.labels[0].innerText : e.getAttribute('aria-label') || (e.tagName === 'BUTTON' ? e.innerText : '')) || '').trim();
  const els = [...document.querySelectorAll('input,select,textarea,button')].map((e) => {
    const r = e.getBoundingClientRect();
    return { tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id, attrName: e.getAttribute('name') || '', value: e.value ?? '', name: nm(e),
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), left: Math.round(r.x), bottom: Math.round(r.bottom) };
  });
  const dateOrder = new Intl.DateTimeFormat(navigator.language).formatToParts(new Date(2026, 9, 23)).map((p) => p.type).filter((t) => t === 'month' || t === 'day' || t === 'year');
  return { vh: innerHeight, els, dateOrder };
})()`;

function prepFind(text, el) {
  const p = parseMarked(text);
  if (!p.ok) return undefined;
  const all = p.value.els;
  let e;
  if (el.id) e = all.find((x) => x.id === el.id);
  else if (el.submit) e = all.find((x) => x.type === 'submit');
  else e = all.find((x) => x.name === el.name && x.tag !== 'label');
  return e ? JSON.stringify({ ...e, vh: p.value.vh, dateOrder: p.value.dateOrder }) : undefined;
}

/** The keys that type `yyyy-mm-dd` into a native date input, in the locale's segment order. */
function dateKeys(iso, order) {
  const [year, month, day] = iso.split('-');
  return (order?.length === 3 ? order : ['month', 'day', 'year']).map((t) => ({ year, month, day })[t]).join('');
}

const vision = (why) => async () => {
  throw new Error(`no vision equivalent: ${why}`);
};

ADAPTERS['playwright-vision'] = {
  nav: async (h, url) => [await h.call('browser_navigate', { url })],
  // Vision mode reads the page from pixels; these steps' oracles need the page text, which only the
  // (forbidden) snapshot tools give. Recorded as failures with this reason, nothing is called.
  navSnap: vision('step b reads the page as text; vision mode has only screenshots (snapshot tools forbidden)'),
  snapAll: vision('step c needs all 1000 items as text; vision mode has only screenshots (snapshot tools forbidden)'),
  // Untimed prep: coordinates come from one evaluate, standing in for reading them off a screenshot.
  snapshot: (h) => h.call('browser_evaluate', { function: `() => ${MARK(PREP)}` }),
  ref: prepFind,
  click: async (h, ref) => {
    const e = JSON.parse(ref);
    return [await h.call('browser_mouse_click_xy', { x: e.x, y: e.y })];
  },
  async type(h, ref, text) {
    // Triple-click selects the old value; the typed keys replace it. No vision tool types a whole string.
    const e = JSON.parse(ref);
    const out = [await h.call('browser_mouse_click_xy', { x: e.x, y: e.y, clickCount: 3 })];
    for (const ch of text) out.push(await h.call('browser_press_key', { key: ch === ' ' ? 'Space' : ch }));
    return out;
  },
  async fill(h, refs, i) {
    const v = formValues(i);
    const ad = ADAPTERS['playwright-vision'];
    const at = (k) => JSON.parse(refs[k]);
    const out = [];
    for (const k of ['full_name', 'email', 'password', 'comments']) out.push(...(await ad.type(h, refs[k], v[k])));
    // Native select: the click focuses it (headless shows no popup) and the first letter picks the option.
    // No Enter: on a focused select it submits the form.
    out.push(await h.call('browser_mouse_click_xy', { x: at('country').x, y: at('country').y }));
    out.push(await h.call('browser_press_key', { key: v.country.label[0] }));
    out.push(...(await ad.click(h, refs.subscribe)));
    out.push(...(await ad.click(h, refs.plan)));
    // Date input: click its first segment, then type the digits in the locale's segment order.
    const d = at('start_date');
    out.push(await h.call('browser_mouse_click_xy', { x: d.left + 8, y: d.y }));
    for (const ch of dateKeys(v.start_date, d.dateOrder)) out.push(await h.call('browser_press_key', { key: ch }));
    const s = at('submit');
    if (s.bottom > s.vh) throw new Error(`submit button below the fold (bottom ${s.bottom} > ${s.vh})`);
    out.push(...(await ad.click(h, refs.submit)));
    return out;
  },
  shot: async (h) => [await h.call('browser_take_screenshot', {})],
  evaluate: (h, expr) => h.call('browser_evaluate', { function: `() => ${MARK(expr)}` }),
};

/** CSS selector for a prepared element, from its attributes (what the page's HTML shows). */
function cssOf(ref) {
  const e = JSON.parse(ref);
  if (e.id) return `#${e.id}`;
  if (e.type === 'radio' || e.type === 'checkbox') return `input[name="${e.attrName}"][value="${e.value}"]`;
  if (e.type === 'submit') return `${e.tag}[type="submit"]`;
  throw new Error(`no selector for ${ref}`);
}

const PUP_SHOT = { name: 'bench', width: 1280, height: 800 }; // its default 800x600 would shrink the viewport

ADAPTERS.puppeteer = {
  nav: async (h, url) => [await h.call('puppeteer_navigate', { url })],
  // No snapshot tool: the page's text comes from its evaluate tool (innerText), the only way it can read a page.
  async navSnap(h, url) {
    return [await h.call('puppeteer_navigate', { url }), await h.call('puppeteer_evaluate', { script: 'document.body.innerText' })];
  },
  snapAll: async (h) => [await h.call('puppeteer_evaluate', { script: 'document.body.innerText' })],
  snapshot: (h) => h.call('puppeteer_evaluate', { script: MARK(PREP) }),
  // The ref is the CSS selector (plus the locale's date order, which the date field needs).
  ref: (text, el) => {
    const r = prepFind(text, el);
    return r && JSON.stringify({ sel: cssOf(r), dateOrder: JSON.parse(r).dateOrder });
  },
  click: async (h, ref) => [await h.call('puppeteer_click', { selector: JSON.parse(ref).sel })],
  async type(h, ref, text) {
    // puppeteer_fill types (appends) and has no clear: empty the field through evaluate first.
    const sel = JSON.parse(ref).sel;
    return [
      await h.call('puppeteer_evaluate', { script: `document.querySelector(${JSON.stringify(sel)}).value = ''` }),
      await h.call('puppeteer_fill', { selector: sel, value: text }),
    ];
  },
  async fill(h, refs, i) {
    // Fresh page, so the text fields are empty and fill (typing) needs no clear. One call per field.
    const v = formValues(i);
    const sel = (k) => JSON.parse(refs[k]).sel;
    const out = [];
    for (const k of ['full_name', 'email', 'password', 'comments']) out.push(await h.call('puppeteer_fill', { selector: sel(k), value: v[k] }));
    out.push(await h.call('puppeteer_select', { selector: sel('country'), value: v.country.value }));
    out.push(await h.call('puppeteer_click', { selector: sel('subscribe') }));
    out.push(await h.call('puppeteer_click', { selector: sel('plan') }));
    // A date input takes keystrokes per segment, in the locale's order.
    const order = JSON.parse(refs.start_date).dateOrder;
    out.push(await h.call('puppeteer_fill', { selector: sel('start_date'), value: dateKeys(v.start_date, order) }));
    out.push(await h.call('puppeteer_click', { selector: sel('submit') }));
    return out;
  },
  shot: async (h) => [await h.call('puppeteer_screenshot', PUP_SHOT)],
  evaluate: (h, expr) => h.call('puppeteer_evaluate', { script: MARK(expr) }),
};

export { need };
