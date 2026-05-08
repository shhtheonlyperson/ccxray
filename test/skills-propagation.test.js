'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/store');
const { handleApiRoutes } = require('../server/routes/api');

function reset() {
  store.entries.length = 0;
  for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
}

function callTokensApi(id) {
  return new Promise(resolve => {
    const clientRes = {
      headersSent: false,
      writeHead: () => {},
      end: (data) => resolve(JSON.parse(data)),
    };
    handleApiRoutes({ url: '/_api/tokens/' + id }, clientRes);
  });
}

function makeEntry(id, sessionId, loadedSkills) {
  return { id, sessionId, tokens: { contextBreakdown: { loadedSkills } } };
}

describe('loadedSkills session propagation (/_api/tokens)', () => {
  beforeEach(reset);

  it('returns loadedSkills as-is when entry already has them', async () => {
    store.entries.push(makeEntry('t1', 'sid-a', ['skill-x', 'skill-y']));
    const tok = await callTokensApi('t1');
    assert.deepEqual(tok.contextBreakdown.loadedSkills, ['skill-x', 'skill-y']);
    assert.deepEqual(store.sessionMeta['sid-a'].loadedSkills, ['skill-x', 'skill-y']);
  });

  it('fills empty loadedSkills from sessionMeta (post-compaction turn)', async () => {
    store.sessionMeta['sid-b'] = { loadedSkills: ['skill-a', 'skill-b'] };
    store.entries.push(makeEntry('t172', 'sid-b', []));
    const tok = await callTokensApi('t172');
    assert.deepEqual(tok.contextBreakdown.loadedSkills, ['skill-a', 'skill-b']);
  });

  it('fills empty loadedSkills from peer entry in same session', async () => {
    store.entries.push(makeEntry('t1', 'sid-c', ['skill-p', 'skill-q']));
    store.entries.push(makeEntry('t172', 'sid-c', []));
    const tok = await callTokensApi('t172');
    assert.deepEqual(tok.contextBreakdown.loadedSkills, ['skill-p', 'skill-q']);
  });

  it('caches peer-found skills into sessionMeta for subsequent turns', async () => {
    store.entries.push(makeEntry('t1', 'sid-d', ['skill-r']));
    store.entries.push(makeEntry('t172', 'sid-d', []));
    await callTokensApi('t172');
    assert.deepEqual(store.sessionMeta['sid-d']?.loadedSkills, ['skill-r']);
  });

  it('returns empty loadedSkills when no source found', async () => {
    store.entries.push(makeEntry('t172', 'sid-e', []));
    const tok = await callTokensApi('t172');
    assert.deepEqual(tok.contextBreakdown.loadedSkills, []);
  });

  it('does not overwrite non-empty sessionMeta with peer skills', async () => {
    store.sessionMeta['sid-f'] = { loadedSkills: ['skill-original'] };
    store.entries.push(makeEntry('t1', 'sid-f', ['skill-different']));
    store.entries.push(makeEntry('t172', 'sid-f', []));
    await callTokensApi('t172');
    assert.deepEqual(store.sessionMeta['sid-f'].loadedSkills, ['skill-original']);
  });
});
