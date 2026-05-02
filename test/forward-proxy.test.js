'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveProxyAgent,
  applyModelPrefix,
  stripInjectedStats,
  setStatusLineEnabled,
  getStatusLineEnabled,
  parseSSEFrame,
  extractOpenAIUsage,
  extractOpenAIStreamUsage,
  extractOpenAICompletedResponse,
  collectOpenAIStreamText,
} = require('../server/forward');

describe('resolveProxyAgent', () => {
  it('returns null when no proxy env vars are set', () => {
    assert.equal(resolveProxyAgent('https', {}), null);
  });

  it('returns null when protocol is http', () => {
    assert.equal(resolveProxyAgent('http', { HTTPS_PROXY: 'http://proxy:3128' }), null);
  });

  it('returns an agent when HTTPS_PROXY is set (uppercase)', () => {
    const agent = resolveProxyAgent('https', { HTTPS_PROXY: 'http://proxy.example.com:3128' });
    assert.ok(agent != null);
    assert.equal(agent._proxyUrl, 'http://proxy.example.com:3128');
  });

  it('returns an agent when https_proxy is set (lowercase)', () => {
    const agent = resolveProxyAgent('https', { https_proxy: 'http://proxy.example.com:3128' });
    assert.ok(agent != null);
    assert.equal(agent._proxyUrl, 'http://proxy.example.com:3128');
  });

  it('HTTPS_PROXY takes precedence over https_proxy', () => {
    const agent = resolveProxyAgent('https', {
      HTTPS_PROXY: 'http://upper.proxy:3128',
      https_proxy: 'http://lower.proxy:3128',
    });
    assert.equal(agent._proxyUrl, 'http://upper.proxy:3128');
  });
});

describe('applyModelPrefix', () => {
  it('returns false when prefix is empty', () => {
    const body = { model: 'claude-sonnet-4-6' };
    assert.equal(applyModelPrefix(body, ''), false);
    assert.equal(body.model, 'claude-sonnet-4-6');
  });

  it('returns false when model already starts with prefix', () => {
    const body = { model: 'databricks-claude-sonnet-4-6' };
    assert.equal(applyModelPrefix(body, 'databricks-'), false);
  });

  it('prepends prefix and returns true', () => {
    const body = { model: 'claude-sonnet-4-6' };
    assert.equal(applyModelPrefix(body, 'databricks-'), true);
    assert.equal(body.model, 'databricks-claude-sonnet-4-6');
  });

  it('returns false when parsedBody has no model', () => {
    assert.equal(applyModelPrefix({}, 'databricks-'), false);
  });
});

describe('stripInjectedStats', () => {
  it('removes the status line from the last assistant text block', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world\n\n---\n📊 Context: 10.0% (20,000 / 200,000) | 20,000 in + 5 out' }],
      }],
    };
    assert.equal(stripInjectedStats(body), true);
    assert.equal(body.messages[0].content[0].text, 'Hello world');
  });

  it('removes the block entirely when only the status line remains', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: '\n\n---\n📊 Context: 10.0% (20,000 / 200,000) | 20,000 in + 5 out' }],
      }],
    };
    assert.equal(stripInjectedStats(body), true);
    assert.equal(body.messages[0].content.length, 0);
  });

  it('leaves messages without a status line untouched', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'No stats here' }],
      }],
    };
    assert.equal(stripInjectedStats(body), false);
    assert.equal(body.messages[0].content[0].text, 'No stats here');
  });

  it('ignores non-assistant messages', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Hello\n\n---\n📊 Context: 10.0% (20,000 / 200,000) | 20,000 in + 5 out' }],
      }],
    };
    assert.equal(stripInjectedStats(body), false);
    assert.ok(body.messages[0].content[0].text.includes('📊'));
  });

  it('returns false when messages is absent', () => {
    assert.equal(stripInjectedStats({}), false);
    assert.equal(stripInjectedStats(null), false);
  });
});

describe('statusLineEnabled flag', () => {
  beforeEach(() => setStatusLineEnabled(true));

  it('defaults to true', () => {
    assert.equal(getStatusLineEnabled(), true);
  });

  it('setStatusLineEnabled(false) disables the flag', () => {
    setStatusLineEnabled(false);
    assert.equal(getStatusLineEnabled(), false);
  });

  it('setStatusLineEnabled(true) re-enables the flag', () => {
    setStatusLineEnabled(false);
    setStatusLineEnabled(true);
    assert.equal(getStatusLineEnabled(), true);
  });
});

describe('OpenAI Responses SSE helpers', () => {
  it('parses OpenAI event names and JSON data without Anthropic event assumptions', () => {
    const frame = parseSSEFrame([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"hello"}',
    ].join('\n'), 123);

    assert.equal(frame.event, 'response.output_text.delta');
    assert.equal(frame.type, 'response.output_text.delta');
    assert.equal(frame.data.delta, 'hello');
    assert.equal(frame._ts, 123);
  });

  it('keeps malformed SSE data as raw parse-tolerant text', () => {
    const frame = parseSSEFrame('event: response.output_text.delta\ndata: {"delta":', 123);

    assert.equal(frame.event, 'response.output_text.delta');
    assert.equal(frame.type, 'response.output_text.delta');
    assert.equal(frame.parseError, true);
    assert.equal(frame.dataRaw, '{"delta":');
    assert.ok(frame.raw.includes('data: {"delta":'));
  });

  it('extracts final completed response, text, and usage from OpenAI Responses events', () => {
    const events = [
      parseSSEFrame('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}'),
      parseSSEFrame('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello "}'),
      parseSSEFrame('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"world"}'),
      parseSSEFrame('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.1-codex","status":"completed","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}'),
    ];

    assert.equal(extractOpenAICompletedResponse(events).status, 'completed');
    assert.equal(collectOpenAIStreamText(events), 'Hello world');
    assert.deepEqual(extractOpenAIStreamUsage(events), {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: 0,
      raw_input_tokens: 3,
      input_tokens_details: null,
      output_tokens_details: null,
    });
  });

  it('normalizes Responses usage with cached input and reasoning details', () => {
    const usage = extractOpenAIUsage({
      usage: {
        input_tokens: 1_000,
        output_tokens: 300,
        total_tokens: 1_300,
        input_tokens_details: { cached_tokens: 250 },
        output_tokens_details: { reasoning_tokens: 120 },
      },
    });

    assert.deepEqual(usage, {
      input_tokens: 750,
      output_tokens: 300,
      total_tokens: 1_300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 250,
      reasoning_tokens: 120,
      raw_input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 250 },
      output_tokens_details: { reasoning_tokens: 120 },
    });
  });

  it('normalizes partial Responses usage without throwing', () => {
    assert.equal(extractOpenAIUsage({}), null);
    assert.deepEqual(extractOpenAIUsage({ usage: { input_tokens: 7 } }), {
      input_tokens: 7,
      output_tokens: 0,
      total_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: 0,
      raw_input_tokens: 7,
      input_tokens_details: null,
      output_tokens_details: null,
    });
  });
});
