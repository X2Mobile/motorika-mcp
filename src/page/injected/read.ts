// Main-content extraction as markdown (or plain text), excluding boilerplate.
import { attr, composedChildren, innerTextOf, norm, qsa, styleOf, visibility } from './dom.js';
import { composedText, withComposedText } from './read-text.js';

// E1 (round 4): every walk below follows the composed (flattened) tree, as snapshot does: a shadow host
// shows its open shadow root, a <slot> its assigned nodes (its fallback only when nothing is assigned),
// and a host's unassigned light DOM is not shown. Closed shadow roots are unreachable.
// E2: a form control is never read, but it still separates the text around it ("Username" / "Password").
const CONTROL_TAGS = new Set(['input', 'textarea', 'select', 'button']);

// P1: a <form> is not boilerplate (old.reddit puts every post and comment body in form.usertext); its
// controls are, so no value of an input, textarea, select or button is ever read out.
const BOILER_TAGS = new Set(['nav', 'footer', 'aside', 'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'button', 'select', 'input', 'textarea', 'dialog']);
const BOILER_ROLES = new Set(['navigation', 'contentinfo', 'complementary', 'banner', 'search', 'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar']);
const BOILER_TOKENS = new Set([
  'nav', 'navbar', 'menu', 'footer', 'sidebar', 'aside', 'cookie', 'cookies', 'consent', 'gdpr', 'banner', 'ad', 'ads',
  'advert', 'advertisement', 'adsbygoogle', 'sponsor', 'sponsored', 'promo', 'newsletter', 'share', 'social', 'related',
  'breadcrumb', 'breadcrumbs', 'popup', 'modal', 'subscribe', 'skip',
]);
// 2026-10-26: `comments` is not a boilerplate token. A comment section is content (www.reddit.com puts
// every comment in section[aria-label=Comments], blogs use section#comments), and so is the "8 comments"
// link of an old.reddit listing row (P2). Tokens match whole tokens only: `shadow` or `badge` is not `ad`.

const tokens = (s: string | null): string[] => (s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * 2026-10-26 review: names are not class lists. A comment itself (role=article, <details>, shreddit-comment,
 * or a whole class name `comment`, as on WordPress li.comment) is never boilerplate by its id, class or
 * aria-label tokens: its label or class carries the author's name ("Comment from Cookie_Monster",
 * `comment-author-cookie-monster`). A whole class name, not a token, so div.comment-ad and
 * div.comments-sidebar are not comments and still drop. Boilerplate tags inside a comment still drop. On
 * any other element an aria-label counts only when it is short (at most 3 words: "Advertisement",
 * "Cookie consent", "Related posts") and holds a token.
 */
const LABEL_MAX_WORDS = 3;
const COMMENT_TAGS = new Set(['details', 'shreddit-comment']);

function isCommentEl(el: Element, role: string | null): boolean {
  return role === 'article' || COMMENT_TAGS.has(el.localName) || (attr(el, 'class') ?? '').toLowerCase().split(/\s+/).includes('comment');
}

/** Inside a comment: an ancestor with role=article, or whose id or class has the token `comment`. */
function inComment(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (attr(p, 'role') === 'article') return true;
    if (tokens(`${attr(p, 'id') ?? ''} ${attr(p, 'class') ?? ''}`).includes('comment')) return true;
  }
  return false;
}

function isBoiler(el: Element): boolean {
  const tag = el.localName;
  // A footer inside a comment holds its author and date (WordPress footer.comment-meta): content.
  if (BOILER_TAGS.has(tag) && !(tag === 'footer' && inComment(el))) return true;
  if (tag === 'header' && !el.parentElement?.closest('article, main, [role=main]')) return true;
  const role = attr(el, 'role');
  if (role && BOILER_ROLES.has(role)) return true;
  if (isCommentEl(el, role)) return false;
  if (tokens(`${attr(el, 'id') ?? ''} ${attr(el, 'class') ?? ''}`).some((tok) => BOILER_TOKENS.has(tok))) return true;
  const label = attr(el, 'aria-label');
  if (!label) return false;
  if (label.trim().split(/\s+/).length > LABEL_MAX_WORDS) return false;
  return tokens(label).some((tok) => BOILER_TOKENS.has(tok));
}

function pickRoot(): Element {
  const candidates = qsa(document, 'main, [role=main], article');
  let best: Element | null = null;
  let bestLen = 0;
  for (const c of candidates) {
    if (visibility(c, styleOf(c)) === 'skip') continue;
    const len = norm(composedText(c)).length;
    // Prefer main over a nested article unless the article holds most of the text.
    if (len > bestLen * (c.localName === 'article' ? 1.0 : 1.0)) {
      best = c;
      bestLen = len;
    }
  }
  return best ?? document.body ?? document.documentElement;
}

interface Out {
  blocks: string[];
  markdown: boolean;
}

/** Keep the original leading/trailing whitespace of s around the formatted text. */
function wrap(s: string, formatted: string): string {
  const lead = /^\s/.test(s) ? ' ' : '';
  const trail = /\s$/.test(s) ? ' ' : '';
  return `${lead}${formatted}${trail}`;
}

function inline(node: Node, md: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/[\s ]+/g, ' ');
  if (!(node instanceof Element)) return '';
  if (CONTROL_TAGS.has(node.localName)) return ' ';
  if (visibility(node, styleOf(node)) === 'skip' || isBoiler(node)) return '';
  const tag = node.localName;
  if (tag === 'br') return '\n';
  if (tag === 'img') {
    const alt = norm(attr(node, 'alt'));
    return md && alt ? `![${alt}](${(node as HTMLImageElement).src})` : alt;
  }
  let s = '';
  for (const c of composedChildren(node)) s += inline(c, md);
  if (md && tag === 'a') {
    const href = (node as HTMLAnchorElement).href;
    const t = norm(s);
    if (href && t && !href.startsWith('javascript:')) return wrap(s, `[${t}](${href})`);
  }
  if (md && (tag === 'strong' || tag === 'b') && norm(s)) return wrap(s, `**${norm(s)}**`);
  if (md && (tag === 'em' || tag === 'i') && norm(s)) return wrap(s, `*${norm(s)}*`);
  if (md && tag === 'code' && norm(s)) return wrap(s, `\`${norm(s)}\``);
  return s;
}

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'pre', 'blockquote', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'details', 'summary', 'hr', 'address']);

/** Block-level in its own right: a block tag or any display other than inline. a, span and br never are. */
function blockLevel(c: Element, d: string): boolean {
  return BLOCK_TAGS.has(c.localName) || (d !== 'inline' && d !== 'inline-block' && c.localName !== 'a' && c.localName !== 'span' && c.localName !== 'br');
}

/**
 * Per read: whether el's composed subtree holds a block-level element that is not inside another box, i.e.
 * reached through display:contents (a <slot>) or an inline wrapper (round 5, item 3: a custom element is
 * inline unless it sets `:host{display:block}`, and its slotted paragraphs must stay separate blocks). An
 * <a> is opaque (it keeps its [text](url) form). Round 5, item 1: memoised, so a walk is linear in the
 * number of nodes even on long display:contents chains.
 */
let blockMemo: Map<Element, boolean> | null = null;

function hasBlockChild(el: Element): boolean {
  const hit = blockMemo?.get(el);
  if (hit !== undefined) return hit;
  let found = false;
  for (const c of composedChildren(el)) {
    if (!(c instanceof Element)) continue;
    const d = styleOf(c).display;
    // A display:none element renders nothing, so it separates nothing either.
    if (d === 'none') continue;
    if (d === 'contents' || (d === 'inline' && c.localName !== 'a' && c.localName !== 'br')) {
      if (hasBlockChild(c)) {
        found = true;
        break;
      }
      continue;
    }
    if (blockLevel(c, d)) {
      found = true;
      break;
    }
  }
  blockMemo?.set(el, found);
  return found;
}

function list(el: Element, out: Out, depth: number): void {
  const items: Out = { blocks: [], markdown: out.markdown };
  listItems(el, items, depth);
  if (items.blocks.length > 0) out.blocks.push(items.blocks.join('\n'));
}

function listItems(el: Element, out: Out, depth: number): void {
  const ordered = el.localName === 'ol';
  let i = 1;
  for (const li of composedChildren(el)) {
    if (!(li instanceof Element) || li.localName !== 'li' || visibility(li, styleOf(li)) === 'skip' || isBoiler(li)) continue;
    let text = '';
    const nested: Element[] = [];
    for (const c of composedChildren(li)) {
      if (c instanceof Element && (c.localName === 'ul' || c.localName === 'ol')) nested.push(c);
      else text += inline(c, out.markdown);
    }
    const bullet = out.markdown ? (ordered ? `${i}. ` : '- ') : ordered ? `${i}. ` : '- ';
    const t = norm(text);
    if (t) out.blocks.push(`${'  '.repeat(depth)}${bullet}${t}`);
    i++;
    for (const n of nested) listItems(n, out, depth + 1);
  }
}

function table(el: HTMLTableElement, out: Out): void {
  const rows = Array.from(el.rows).filter((r) => visibility(r, styleOf(r)) !== 'skip');
  if (rows.length === 0) return;
  const cells = rows.map((r) => Array.from(r.cells).map((c) => norm(inline(c, out.markdown)).replace(/\|/g, '\\|')));
  const width = Math.max(...cells.map((r) => r.length));
  const lines: string[] = [];
  cells.forEach((r, idx) => {
    while (r.length < width) r.push('');
    lines.push(out.markdown ? `| ${r.join(' | ')} |` : r.join('\t'));
    if (idx === 0 && out.markdown) lines.push(`|${' --- |'.repeat(width)}`);
  });
  if (el.caption && out.markdown) out.blocks.push(`**${norm(innerTextOf(el.caption))}**`);
  out.blocks.push(lines.join('\n'));
}

function block(el: Element, out: Out): void {
  if (visibility(el, styleOf(el)) === 'skip' || isBoiler(el)) return;
  const tag = el.localName;
  const md = out.markdown;
  const h = /^h([1-6])$/.exec(tag);
  if (h) {
    const t = norm(inline(el, md));
    if (t) out.blocks.push(md ? `${'#'.repeat(Number(h[1]))} ${t}` : t);
    return;
  }
  if (tag === 'ul' || tag === 'ol') return list(el, out, 0);
  if (tag === 'table') return table(el as HTMLTableElement, out);
  if (tag === 'pre') {
    const t = el.textContent ?? '';
    if (t.trim()) out.blocks.push(md ? `\`\`\`\n${t.replace(/\n$/, '')}\n\`\`\`` : t);
    return;
  }
  if (tag === 'hr') {
    if (md) out.blocks.push('---');
    return;
  }
  if (tag === 'blockquote') {
    const inner: Out = { blocks: [], markdown: md };
    children(el, inner);
    if (inner.blocks.length) out.blocks.push(inner.blocks.map((b) => (md ? b.split('\n').map((l) => `> ${l}`).join('\n') : b)).join('\n\n'));
    return;
  }
  if (!hasBlockChild(el)) {
    const t = inline(el, md).replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').trim();
    if (t) out.blocks.push(t);
    return;
  }
  children(el, out);
}

function children(el: Element, out: Out): void {
  let pending = '';
  const flush = () => {
    const t = norm(pending);
    if (t) out.blocks.push(t);
    pending = '';
  };
  for (const c of composedChildren(el)) {
    if (c instanceof Element) {
      const st = styleOf(c);
      if (st.display === 'none') continue;
      const isInline = (st.display.startsWith('inline') && !BLOCK_TAGS.has(c.localName)) || c.localName === 'a' || c.localName === 'br';
      // Round 5, item 3: an inline wrapper (an inline shadow host) around blocks is walked as blocks.
      if (isInline && (st.display !== 'inline' || c.localName === 'a' || c.localName === 'br' || !hasBlockChild(c))) {
        pending += inline(c, out.markdown);
        continue;
      }
      flush();
      block(c, out);
    } else if (c.nodeType === Node.TEXT_NODE) {
      pending += c.textContent ?? '';
    }
  }
  flush();
}

export function read(root: Element | null, format: 'markdown' | 'text'): string {
  const out: Out = { blocks: [], markdown: format === 'markdown' };
  blockMemo = new Map();
  try {
    withComposedText(() => {
      const r = root ?? pickRoot();
      if (root) block(r, out);
      else children(r, out);
    });
  } finally {
    blockMemo = null;
  }
  const title = norm(document.title);
  const body = out.blocks.join('\n\n');
  if (!root && title && !out.blocks[0]?.replace(/^#+\s*/, '').startsWith(title)) {
    return `${format === 'markdown' ? '# ' : ''}${title}\n\n${body}`;
  }
  return body;
}
