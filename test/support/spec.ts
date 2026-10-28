// Fixture specifications: hand-written expectations the fixtures are built to satisfy.
// Nothing here is derived from the server under test or from parsing the fixture pages.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_DIR } from './paths.ts';

/** C7: this literal is typed into password fields and must never appear in any tool result. */
export const PASSWORD_LITERAL = 'Pw-7f3K-xyzzy-91q';

/** The upload source file shipped with the fixtures (inside the repo, so inside the server cwd root). */
export const UPLOAD_FILE = join(FIXTURES_DIR, 'upload', 'hello-upload.txt');
export const UPLOAD_NAME = 'hello-upload.txt';
export const UPLOAD_BYTES = (): Buffer => readFileSync(UPLOAD_FILE);

/** D3 full-form fixture (`/forms.html`): what to fill, and what /submit must record. */
export const FULL_FORM = {
  path: '/forms.html',
  /** Values in the fixture's own terms: label text -> value to enter. */
  inputs: {
    fullName: { label: 'Full name', value: 'Ada Lovelace' },
    email: { label: 'Email', value: 'ada@example.test' },
    password: { label: 'Password', value: PASSWORD_LITERAL },
    comments: { label: 'Comments', value: 'Line one\nLine two' },
    country: { label: 'Country', valueLabel: 'Belgium', value: 'be' },
    toppings: { label: 'Toppings', valueLabels: ['Olives', 'Basil'], values: ['olives', 'basil'] },
    subscribe: { label: 'Subscribe to newsletter', checked: true },
    plan: { groupLabel: 'Plan', optionLabel: 'Pro', value: 'pro' },
    startDate: { label: 'Start date', value: '2026-03-15' },
    volume: { label: 'Volume', value: '75' },
    color: { label: 'Favorite color', value: '#ff8800' },
    attachment: { label: 'Attachment' },
    bio: { label: 'Bio', value: 'Wrote the first program' },
  },
  submitButton: 'Send form',
  /** The exact multipart payload /submit?form=full must record (field order = document order). */
  expectedFields: [
    ['full_name', 'Ada Lovelace'],
    ['email', 'ada@example.test'],
    ['password', PASSWORD_LITERAL],
    ['comments', 'Line one\r\nLine two'],
    ['country', 'be'],
    ['toppings', 'olives'],
    ['toppings', 'basil'],
    ['subscribe', 'yes'],
    ['plan', 'pro'],
    ['start_date', '2026-03-15'],
    ['volume', '75'],
    ['color', '#ff8800'],
    ['bio', 'Wrote the first program'],
  ] as [string, string][],
  expectedFile: { field: 'attachment', name: UPLOAD_NAME },
} as const;

/** Deterministic bytes served by /download/<name>. */
export function downloadBytes(name: string): Buffer {
  const parts: Buffer[] = [];
  let i = 0;
  let size = 0;
  while (size < 5000) {
    const chunk = Buffer.from(`motorika-download:${name}:${i}\n`);
    parts.push(chunk);
    size += chunk.length;
    i += 1;
  }
  return Buffer.concat(parts).subarray(0, 5000);
}

export function sha256(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** C8 article fixture spec. */
export const ARTICLE = {
  path: '/article.html',
  title: 'The Quiet Harbor',
  paragraphMarkers: Array.from({ length: 30 }, (_, i) => `PARA-${String(i + 1).padStart(2, '0')}`),
  link: { text: 'tide tables', href: 'https://example.org/tides' },
  boilerplate: ['NAV-BOILERPLATE', 'FOOTER-BOILERPLATE', 'COOKIE-BOILERPLATE', 'AD-BOILERPLATE'],
} as const;

/** D15 console/network fixture spec. */
export const CONSOLE_PAGE = {
  path: '/console.html',
  log: 'fixture-log-message',
  warning: 'fixture-warning-message',
  error: 'fixture-error-message',
  uncaught: 'fixture-uncaught-boom',
  authToken: 'Bearer fixture-secret-token-5521',
} as const;

/** Big pages (C5, F): the number of `button.item` elements, named "Item 1".."Item N". */
export const BIG_PAGES = { '/big-1000.html': 1000, '/big-5000.html': 5000 } as const;

/**
 * C2 coverage fixture (`/coverage.html`) spec. `attrs` lists grammar attributes that MUST be present with
 * these values (others may also appear). Roles follow ARIA/HTML-AAM where those are unambiguous.
 */
export interface CoverageItem {
  role: string;
  name: string;
  attrs?: Record<string, unknown>;
  /** Inside which iframe (by iframe name), when not in the main frame. */
  frame?: string;
}

export const COVERAGE = {
  path: '/coverage.html',
  present: [
    { role: 'banner', name: '' },
    { role: 'main', name: '' },
    { role: 'link', name: 'Coverage link', attrs: { href: '/nav-a.html' } },
    { role: 'heading', name: 'Coverage page', attrs: { level: 1 } },
    { role: 'button', name: 'Coverage button' },
    { role: 'button', name: 'Disabled button', attrs: { disabled: true } },
    { role: 'button', name: 'Toggle pressed', attrs: { pressed: 'true' } },
    { role: 'button', name: 'Expandable', attrs: { expanded: 'false' } },
    { role: 'clickable', name: 'Clickable div' },
    { role: 'form', name: 'All inputs' },
    { role: 'textbox', name: 'Text input', attrs: { value: 'hello' } },
    { role: 'textbox', name: 'Email input', attrs: { type: 'email', required: true } },
    { role: 'textbox', name: 'Password input', attrs: { password: true } },
    { role: 'searchbox', name: 'Search input', attrs: { type: 'search' } },
    { role: 'textbox', name: 'Tel input', attrs: { type: 'tel' } },
    { role: 'textbox', name: 'Url input', attrs: { type: 'url' } },
    { role: 'spinbutton', name: 'Number input', attrs: { type: 'number', value: '5' } },
    { role: 'slider', name: 'Range input', attrs: { type: 'range', value: '3' } },
    { role: 'file', name: 'File input' },
    { role: 'textbox', name: 'Readonly input', attrs: { readonly: true, value: 'fixed' } },
    { role: 'button', name: 'Submit input' },
    { role: 'button', name: 'Reset input' },
    { role: 'button', name: 'Button input' },
    { role: 'combobox', name: 'Single select', attrs: { value: 'Beta', options: ['Alpha', 'Beta', 'Gamma'] } },
    { role: 'listbox', name: 'Multi select' },
    { role: 'textbox', name: 'Notes area', attrs: { value: 'note text' } },
    { role: 'checkbox', name: 'Native checkbox', attrs: { checked: 'true' } },
    { role: 'radio', name: 'Radio A', attrs: { checked: 'true' } },
    { role: 'radio', name: 'Radio B', attrs: { checked: 'false' } },
    { role: 'checkbox', name: 'Custom checkbox', attrs: { checked: 'false' } },
    { role: 'radio', name: 'Custom radio', attrs: { checked: 'false' } },
    // CONTRACT-QUESTION: a contenteditable without a role has no implicit ARIA role; textbox assumed.
    { role: 'textbox', name: 'Editable area' },
    { role: 'button', name: 'Shadow button' },
    { role: 'iframe', name: 'Same frame' },
    { role: 'button', name: 'Same frame button', frame: 'Same frame' },
    { role: 'iframe', name: 'Cross frame' },
    { role: 'button', name: 'Cross frame button', frame: 'Cross frame' },
    { role: 'dialog', name: 'Info dialog' },
    { role: 'button', name: 'Dialog OK' },
    { role: 'alert', name: 'Coverage alert text' },
  ] as CoverageItem[],
  /**
   * Inputs whose role is not fixed by ARIA (CONTRACT-QUESTION: which role do date/time/color/... get?).
   * Asserted by name + the `type=` attribute only.
   */
  typedAnyRole: [
    { name: 'Date input', type: 'date' },
    { name: 'Time input', type: 'time' },
    { name: 'Datetime input', type: 'datetime-local' },
    { name: 'Month input', type: 'month' },
    { name: 'Week input', type: 'week' },
    { name: 'Color input', type: 'color' },
  ],
  absent: [
    'Hidden display none',
    'Hidden visibility',
    'Hidden aria',
    'Hidden inert',
    'Hidden details',
    'Hidden zero size',
  ],
  /** Never appears in any form: the hidden input's value. */
  absentText: ['hidden-field-value'],
} as const;

/**
 * Chrome commits its cookie store to disk about every 30 s; SIGTERM does not flush it (measured on Chrome 155,
 * proven in test/harness/round2.test.ts "A12 method"). A window must live this long before it is ended for a
 * cookie it received to survive.
 */
export const COOKIE_COMMIT_MS = 32_000;
