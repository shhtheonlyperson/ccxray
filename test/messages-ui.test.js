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

  it('renders OpenAI Responses reasoning deltas as current thinking', () => {
    const context = loadMessagesContext();
    const steps = context.buildMergedSteps([], [
      { type: 'response.reasoning_text.delta', delta: 'Check repo. ' },
      { type: 'response.reasoning_summary_part.added', part: { text: 'Found renderer path.' } },
      { type: 'response.completed', _ts: 1200 },
    ]);

    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'tool-group');
    assert.equal(steps[0].source, 'current');
    assert.equal(steps[0].thinking, 'Check repo. Found renderer path.');
  });

  it('renders OpenAI Responses function-call events as pending tool calls', () => {
    const context = loadMessagesContext();
    const steps = context.buildMergedSteps([], [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'call_1', type: 'function_call', name: 'shell' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: '{"command":"' },
      { type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: 'npm test"}' },
    ]);

    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'tool-group');
    assert.equal(steps[0].calls.length, 1);
    assert.equal(steps[0].calls[0].name, 'shell');
    assert.equal(JSON.stringify(steps[0].calls[0].input), JSON.stringify({ command: 'npm test' }));
    assert.equal(steps[0].calls[0].pending, true);
  });
});
