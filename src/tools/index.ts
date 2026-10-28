// The tool registry. Adding a tool = one file in src/tools/ plus one line here.
import { batch } from './batch.js';
import { click } from './click.js';
import { console_ } from './console.js';
import { dialog } from './dialog.js';
import { drag } from './drag.js';
import { evaluate } from './evaluate.js';
import { fill_form } from './fill_form.js';
import { find } from './find.js';
import { hover } from './hover.js';
import { navigate } from './navigate.js';
import { network } from './network.js';
import { press } from './press.js';
import { read } from './read.js';
import { screenshot } from './screenshot.js';
import { scroll } from './scroll.js';
import { session } from './session.js';
import { snapshot } from './snapshot.js';
import { tabs } from './tabs.js';
import { type } from './type.js';
import type { Tool } from './types.js';
import { upload } from './upload.js';
import { video } from './video.js';
import { wait } from './wait.js';

export const TOOLS: Tool[] = [
  session,
  tabs,
  navigate,
  snapshot,
  screenshot,
  read,
  find,
  click,
  type,
  fill_form,
  press,
  hover,
  scroll,
  drag,
  upload,
  dialog,
  wait,
  evaluate,
  video,
  console_,
  network,
  batch,
];

export function toolMap(): Map<string, Tool> {
  return new Map(TOOLS.map((t) => [t.name, t]));
}
