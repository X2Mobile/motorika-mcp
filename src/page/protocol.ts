// Types shared by the server and the injected engine (type-only; no runtime code).

export type Tri = 'true' | 'false' | 'mixed';

export interface SnapAttrs {
  level?: number;
  type?: string;
  password?: boolean;
  checked?: Tri;
  selected?: boolean;
  pressed?: Tri;
  expanded?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  invalid?: boolean;
  focused?: boolean;
  /** Raw value; the server truncates. Never set for passwords (see valueRedacted). */
  value?: string;
  valueRedacted?: boolean;
  options?: string[];
  optionsTotal?: number;
  href?: string;
}

export interface SnapNode {
  /** Local id within the document; 0 for text lines. */
  id: number;
  role: string;
  name?: string;
  attrs?: SnapAttrs;
  children?: SnapNode[];
  /** role+name was unique in the document when this node was described (for stale re-resolution). */
  unique?: boolean;
}

export interface SnapshotOptions {
  mode: 'interactive' | 'full';
  viewportOnly: boolean;
  /** Local id of the scope root, if any. */
  scope?: number;
  /** Keep at most this many output lines (review P2/S2); the rest are counted in `omitted`. */
  limit?: number;
  /**
   * viewport_only without scope: uniqueness from this walk's own counts (off-screen nodes included), not a
   * second whole-document walk. The automatic snapshot sets it; the snapshot tool does not.
   */
  countsFromWalk?: boolean;
}

export interface SnapshotResult {
  title: string;
  url: string;
  nodes: SnapNode[];
  /** Local ids of iframe nodes in this frame (to stitch child frames). */
  iframes: number[];
  /** Lines not sent because of `limit`. */
  omitted?: number;
  /** Local ids of iframe nodes past the cut: the server counts their frames' lines (re-check item 10). */
  droppedIframes?: number[];
  /** viewport_only: elements left out because they lie outside the viewport. */
  offscreen?: number;
}

export interface FindHit {
  node: SnapNode;
  exact: boolean;
  context?: SnapNode;
}

export interface QuietResult {
  quiet: boolean;
  waited: number;
  /** Live-region texts when quiet finished. */
  live: string[];
}

export interface LiveText {
  texts: string[];
}

export interface ScrollState {
  y: number;
  x: number;
  scrollHeight: number;
  scrollWidth: number;
  viewport: number;
  viewportWidth: number;
}

export interface ElementKind {
  tag: string;
  type: string;
  role: string;
  contentEditable: boolean;
  multiple: boolean;
  visible: boolean;
  /** For a visually hidden input with a visible label: that label's local id. */
  labelId?: number;
  checked?: boolean;
  options?: { value: string; label: string }[];
  /** For radios: [localId, value, label] of the group members. */
  group?: { id: number; value: string; label: string; checked: boolean }[];
  /** A fieldset or role=radiogroup holding radios (contract answer 11); `group` lists those radios. */
  radioGroup?: boolean;
}
