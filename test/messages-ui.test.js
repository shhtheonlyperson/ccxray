'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMessagesContext() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'messages.js'), 'utf8');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

describe('dashboard timeline rendering helpers', () => {
  it('renders OpenAI Responses output text deltas as assistant timeline text', () => {
    const context = loadMessagesContext();
    const steps = context.buildMergedSteps([], [
      { type: 'response.output_text.delta', delta: 'Hi' },
      { type: 'response.output_text.delta', delta: '. What' },
      { type: 'response.output_text.delta', delta: ' next?' },
    ]);

    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'assistant-text');
    assert.equal(steps[0].source, 'current');
    assert.equal(steps[0].text, 'Hi. What next?');
  });

  it('falls back to OpenAI Responses output_text.done when deltas are absent', () => {
    const context = loadMessagesContext();
    const steps = context.buildMergedSteps([], [
      { type: 'response.output_text.done', text: 'Done text' },
    ]);

    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'assistant-text');
    assert.equal(steps[0].text, 'Done text');
  });
});
