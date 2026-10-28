import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError, errorText } from '../../src/util/errors.js';

// PLAN contract answer 2: line 1 states the cause; line 2 starts with "hint: " and names the next step.
describe('error shape (contract answer 2)', () => {
  it('line 1 is the cause, line 2 starts with "hint: "', () => {
    const lines = errorText('e12 is stale (element removed)', 'take a new snapshot').split('\n');
    assert.deepEqual(lines, ['e12 is stale (element removed)', 'hint: take a new snapshot']);
  });
  it('ToolError carries the same two-line message', () => {
    const e = new ToolError('no option "Narnia"', 'use one of the listed options');
    assert.equal(e.message, 'no option "Narnia"\nhint: use one of the listed options');
  });
});
