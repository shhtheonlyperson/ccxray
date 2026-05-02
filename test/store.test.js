'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('store', () => {
  describe('sessionCosts', () => {
    it('exports a sessionCosts Map', () => {
      const store = require('../server/store');
      assert.ok(store.sessionCosts instanceof Map, 'sessionCosts should be a Map');
    });

    it('accumulates cost across multiple turns', () => {
      const store = require('../server/store');
      store.sessionCosts.clear();
      const sid = 'test-session-1';
      // Simulate 3 turns
      for (let i = 0; i < 3; i++) {
        store.sessionCosts.set(sid, (store.sessionCosts.get(sid) || 0) + 0.01);
      }
      assert.ok(Math.abs(store.sessionCosts.get(sid) - 0.03) < 1e-10);
    });
  });

  describe('trimEntries eviction', () => {
    it('trims entries to MAX_ENTRIES', () => {
      const store = require('../server/store');
      const startLen = store.entries.length;

      // Push entries beyond limit
      const testLimit = store.MAX_ENTRIES;
      for (let i = 0; i < testLimit + 50; i++) {
        store.entries.push({ id: `trim-test-${i}`, req: null, res: null });
      }
      assert.ok(store.entries.length > testLimit);

      store.trimEntries();
      assert.equal(store.entries.length, testLimit, `Should trim to ${testLimit}`);

      // Oldest entries should be gone, newest kept
      assert.equal(store.entries[store.entries.length - 1].id, `trim-test-${testLimit + 49}`);

      // Clean up
      store.entries.splice(startLen);
    });

    it('does not trim when under limit', () => {
      const store = require('../server/store');
      const startLen = store.entries.length;
      store.entries.push({ id: 'under-limit', req: null, res: null });
      store.trimEntries();
      assert.equal(store.entries.length, startLen + 1);
      store.entries.pop();
    });
  });

  describe('detectSession – subagent attribution', () => {
    // Fresh store state for each test — we manipulate module-level globals
    // so we need to reset between tests.
    function resetSessionState(store) {
      // Clear mutable session state
      for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
      for (const k of Object.keys(store.activeRequests)) delete store.activeRequests[k];
    }

    function mainReq(sessionId, msgCount) {
      return {
        metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
        system: [{ text: 'Primary working directory: /home/user/project' }],
        messages: new Array(msgCount).fill({ role: 'user', content: 'hi' }),
        tools: new Array(90).fill({ name: 'Read' }),
      };
    }

    function bareSubagentReq() {
      return { messages: [{ role: 'user', content: 'do research' }] };
    }

    it('attributes bare subagent to the only inflight session', () => {
      const store = require('../server/store');
      resetSessionState(store);

      // Main agent request establishes session
      const r1 = store.detectSession(mainReq('aaa-111', 3));
      assert.equal(r1.sessionId, 'aaa-111');

      // Simulate inflight (index.js increments after detectSession)
      store.activeRequests['aaa-111'] = 1;
      store.sessionMeta['aaa-111'] = { cwd: '/home', lastSeenAt: Date.now() };

      // Bare subagent should be attributed to aaa-111
      const r2 = store.detectSession(bareSubagentReq());
      assert.equal(r2.sessionId, 'aaa-111');
      assert.equal(r2.isNewSession, false);
    });

    it('attributes subagent to inflight session over idle session in multi-session', () => {
      const store = require('../server/store');
      resetSessionState(store);

      // Session A: was active but now idle
      store.detectSession(mainReq('aaa-111', 3));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: Date.now() - 5000 };
      store.activeRequests['aaa-111'] = 0;

      // Session B: currently inflight
      store.detectSession(mainReq('bbb-222', 1));
      store.sessionMeta['bbb-222'] = { cwd: '/b', lastSeenAt: Date.now() };
      store.activeRequests['bbb-222'] = 1;

      const r = store.detectSession(bareSubagentReq());
      assert.equal(r.sessionId, 'bbb-222');
    });

    it('does not attribute when no session active within 30s', () => {
      const store = require('../server/store');
      resetSessionState(store);

      // Session exists but stale (60s ago)
      store.detectSession(mainReq('old-sess', 3));
      store.sessionMeta['old-sess'] = { cwd: '/old', lastSeenAt: Date.now() - 60000 };
      store.activeRequests['old-sess'] = 0;

      const r = store.detectSession(bareSubagentReq());
      // Should NOT create a new session, just reuse current
      assert.equal(r.isNewSession, false);
    });

    it('attributes non-subagent (with tools) to active session instead of creating phantom', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('aaa-111', 5));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: Date.now() };
      store.activeRequests['aaa-111'] = 1;

      // Request with tools → not a bare subagent, but active session exists within 30s.
      // Should be attributed to aaa-111 rather than creating a phantom direct-api session.
      const reqWithTools = {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'Read' }],
      };
      const r = store.detectSession(reqWithTools);
      assert.equal(r.isNewSession, false);
      assert.equal(r.sessionId, 'aaa-111');
    });

    it('attributes non-subagent with metadata to active session instead of creating phantom', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('aaa-111', 3));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: Date.now() };
      store.activeRequests['aaa-111'] = 1;

      // Request with custom metadata → fails isLikelySubagent, but active session exists.
      // Should be attributed to aaa-111 rather than creating a phantom direct-api session.
      const r = store.detectSession({
        metadata: { user_id: 'custom-app-v1' },
        messages: [{ role: 'user', content: 'hello' }],
      });
      assert.equal(r.isNewSession, false);
      assert.equal(r.sessionId, 'aaa-111');
    });

    it('never pollutes currentSessionId from subagent path', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('aaa-111', 3));
      // Merge in-place: replacing the object would clobber bookkeeping flags
      // (e.g. bannerPrinted) that detectSession set on this entry.
      Object.assign(store.sessionMeta['aaa-111'], { cwd: '/a', lastSeenAt: Date.now() });
      store.activeRequests['aaa-111'] = 1;

      store.detectSession(bareSubagentReq());
      assert.equal(store.getCurrentSessionId(), 'aaa-111');

      // Next main request should still see aaa-111 as current
      const r = store.detectSession(mainReq('aaa-111', 5));
      assert.equal(r.isNewSession, false);
    });

    it('picks inflight session even when two sessions are recent', () => {
      const store = require('../server/store');
      resetSessionState(store);

      const now = Date.now();
      // Session A: recent but NOT inflight
      store.detectSession(mainReq('aaa-111', 3));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: now - 2000 };
      store.activeRequests['aaa-111'] = 0;

      // Session B: recent AND inflight
      store.detectSession(mainReq('bbb-222', 3));
      store.sessionMeta['bbb-222'] = { cwd: '/b', lastSeenAt: now - 3000 };
      store.activeRequests['bbb-222'] = 1;

      // Even though A is more recent, B is inflight → B wins
      const r = store.detectSession(bareSubagentReq());
      assert.equal(r.sessionId, 'bbb-222');
    });

    it('attributes to most-recent when both sessions inflight', () => {
      const store = require('../server/store');
      resetSessionState(store);

      const now = Date.now();
      store.detectSession(mainReq('aaa-111', 3));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: now - 5000 };
      store.activeRequests['aaa-111'] = 1;

      store.detectSession(mainReq('bbb-222', 3));
      store.sessionMeta['bbb-222'] = { cwd: '/b', lastSeenAt: now - 1000 };
      store.activeRequests['bbb-222'] = 1;

      // Both inflight → most recent wins
      const r = store.detectSession(bareSubagentReq());
      assert.equal(r.sessionId, 'bbb-222');
    });

    it('falls back to idle recent session when nothing is inflight', () => {
      const store = require('../server/store');
      resetSessionState(store);

      // Session completed 10s ago (within 30s window)
      store.detectSession(mainReq('aaa-111', 3));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: Date.now() - 10000 };
      store.activeRequests['aaa-111'] = 0;

      const r = store.detectSession(bareSubagentReq());
      assert.equal(r.sessionId, 'aaa-111');
    });

    it('uses a stable provider-scoped fallback session for Codex traffic', () => {
      const store = require('../server/store');
      resetSessionState(store);

      const codexReq = {
        model: 'gpt-5.1-codex',
        input: 'hello',
      };
      const r1 = store.detectSession(codexReq, { provider: 'openai', cwdFallback: '/tmp/codex-project' });
      const r2 = store.detectSession(codexReq, { provider: 'openai', cwdFallback: '/tmp/codex-project' });

      assert.match(r1.sessionId, /^codex-[a-f0-9]{12}$/);
      assert.equal(r2.sessionId, r1.sessionId);
      assert.equal(r1.isNewSession, true);
      assert.equal(r2.isNewSession, false);
      assert.equal(store.sessionMeta[r1.sessionId].provider, 'openai');
    });

    it('extracts Codex cwd from request context and leaves Claude fallback isolated', () => {
      const store = require('../server/store');
      resetSessionState(store);

      const cwd = store.extractCwdForProvider({
        instructions: 'You are Codex.',
        input: [{
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/Users/shh/proj/ccxray</cwd>\n</environment_context>' }],
        }],
      }, 'openai');

      assert.equal(cwd, '/Users/shh/proj/ccxray');

      const codex = store.detectSession({ model: 'gpt-5.1-codex', input: 'hi' }, { provider: 'openai', cwdFallback: '/tmp/codex' });
      assert.match(codex.sessionId, /^codex-/);

      const claude = store.detectSession({ messages: [{ role: 'user', content: 'hi' }] }, { provider: 'anthropic' });
      assert.notEqual(claude.sessionId, codex.sessionId);
    });
  });

  describe('entry memory release', () => {
    it('releases req/res memory after nulling (requires --expose-gc)', async () => {
      if (typeof global.gc !== 'function') {
        // Skip if gc not exposed — this test must be run with: node --expose-gc --test
        return;
      }
      const store = require('../server/store');
      const startLen = store.entries.length;

      // Allocate large unique arrays on V8 heap (each ~1MB+)
      for (let i = 0; i < 20; i++) {
        store.entries.push({
          id: `mem-test-${i}`,
          req: { messages: new Array(50_000).fill(null).map((_, j) => ({ role: 'user', i, j })) },
          res: new Array(25_000).fill(null).map((_, j) => ({ type: 'delta', i, j })),
          _loaded: true,
        });
      }

      global.gc();
      const heapWithData = process.memoryUsage().heapUsed;

      for (let i = startLen; i < startLen + 20; i++) {
        store.entries[i].req = null;
        store.entries[i].res = null;
        store.entries[i]._loaded = false;
      }

      global.gc();
      const heapAfterRelease = process.memoryUsage().heapUsed;
      const freedBytes = heapWithData - heapAfterRelease;
      assert.ok(
        freedBytes >= 15 * 1024 * 1024,
        `expected at least 15MB freed, got ${(freedBytes / (1024 * 1024)).toFixed(2)}MB`
      );

      // Clean up
      store.entries.splice(startLen, 20);
    });
  });
});
