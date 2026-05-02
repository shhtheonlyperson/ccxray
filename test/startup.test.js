'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const WebSocket = require('ws');

const SERVER_SCRIPT = path.resolve(__dirname, '..', 'server', 'index.js');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-startup-test-'));

after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── Helper: find an available port ─────────────────────────────────

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── Helper: spawn server and wait for ready ────────────────────────

function spawnServer(args, opts = {}) {
  const env = {
    ...process.env,
    CCXRAY_HOME: TEST_HOME,
    BROWSER: 'none', // never open browser in tests
    ...opts.env,
  };
  const child = spawn(process.execPath, [SERVER_SCRIPT, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.getOutput = () => ({ stdout, stderr });
  return child;
}

function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}/_api/health`, { timeout: 1000 }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            if (JSON.parse(data).ok) return resolve();
          } catch {}
          if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
          setTimeout(check, 200);
        });
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
        setTimeout(check, 200);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
        setTimeout(check, 200);
      });
    };
    check();
  });
}

function killAndWait(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
  });
}

// ── S4: standalone mode (ccxray without claude) ────────────────────

describe('S4: standalone mode', () => {
  let child;
  let port;

  before(async () => {
    port = await findFreePort();
    child = spawnServer(['--port', String(port)]);
    await waitForPort(port);
  });

  after(async () => {
    await killAndWait(child);
  });

  it('serves health endpoint', async () => {
    const data = await httpGet(port, '/_api/health');
    assert.deepEqual(data, { ok: true });
  });

  it('serves dashboard HTML at /', async () => {
    const html = await httpGetRaw(port, '/');
    assert.ok(html.includes('<!DOCTYPE html') || html.includes('<html'));
  });

  it('injects a configurable dashboard display name', async () => {
    const brandedPort = await findFreePort();
    const brandedChild = spawnServer(['--port', String(brandedPort)], {
      env: { CCXRAY_DISPLAY_NAME: 'customray' },
    });
    try {
      await waitForPort(brandedPort);
      const html = await httpGetRaw(brandedPort, '/');
      assert.ok(html.includes('"APP_NAME":"customray"'), html);
    } finally {
      await killAndWait(brandedChild);
    }
  });

  it('serves hub status', async () => {
    const data = await httpGet(port, '/_api/hub/status');
    assert.equal(data.app, 'ccxray');
    assert.ok(data.version);
  });
});

// ── S5: status subcommand ──────────────────────────────────────────

describe('S5: status subcommand', () => {
  it('reports no hub when nothing is running', async () => {
    // Ensure no lockfile
    try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}

    const { stdout, code } = await spawnAndCollect(['status']);
    assert.ok(stdout.includes('No hub running'));
    assert.equal(code, 0);
  });

  it('reports dead hub and cleans lockfile', async () => {
    // Write a fake lockfile with dead pid
    const lockPath = path.join(TEST_HOME, 'hub.json');
    fs.writeFileSync(lockPath, JSON.stringify({ port: 9999, pid: 999999, version: '1.0.0' }));

    const { stdout, code } = await spawnAndCollect(['status']);
    assert.ok(stdout.includes('dead') || stdout.includes('Cleaning'));
    assert.equal(code, 1);

    // Lockfile should be cleaned up
    assert.ok(!fs.existsSync(lockPath));
  });
});

// ── S6: hub mode startup ───────────────────────────────────────────

describe('S6: hub mode startup', () => {
  let child;
  let port;

  before(async () => {
    port = await findFreePort();
    child = spawnServer(['--port', String(port), '--hub-mode']);
    await waitForPort(port);
  });

  after(async () => {
    await killAndWait(child);
    try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}
  });

  it('writes lockfile after startup', () => {
    const lockPath = path.join(TEST_HOME, 'hub.json');
    assert.ok(fs.existsSync(lockPath));
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.port, port);
    assert.ok(lock.pid > 0);
    assert.ok(lock.version);
  });

  it('responds to health check', async () => {
    const data = await httpGet(port, '/_api/health');
    assert.deepEqual(data, { ok: true });
  });

  it('accepts client registration', async () => {
    const data = await httpPost(port, '/_api/hub/register', { pid: 77777, cwd: '/test' });
    assert.equal(data.ok, true);
    assert.equal(data.firstClient, true);

    // Cleanup
    await httpPost(port, '/_api/hub/unregister', { pid: 77777 });
  });
});

// ── E3: --port validation ──────────────────────────────────────────

describe('E3: --port validation', () => {
  it('rejects port 0', async () => {
    const { stderr, code } = await spawnAndCollect(['--port', '0']);
    assert.ok(stderr.includes('--port requires a valid port'));
    assert.equal(code, 1);
  });

  it('rejects non-numeric port', async () => {
    const { stderr, code } = await spawnAndCollect(['--port', 'abc']);
    assert.ok(stderr.includes('--port requires a valid port'));
    assert.equal(code, 1);
  });

  it('rejects port > 65535', async () => {
    const { stderr, code } = await spawnAndCollect(['--port', '99999']);
    assert.ok(stderr.includes('--port requires a valid port'));
    assert.equal(code, 1);
  });
});

describe('provider launcher selection', () => {
  it('rejects unsupported provider commands instead of silently starting standalone mode', async () => {
    const { stderr, code } = await spawnAndCollect(['unknown-ai'], 3000);

    assert.equal(code, 1);
    assert.ok(stderr.includes('unsupported provider "unknown-ai"'), stderr);
    assert.ok(stderr.includes('claude, codex, gemini'), stderr);
  });
});

describe('standard proxy tunnel', () => {
  let targetServer;
  let targetPort;
  let proxyChild;
  let proxyPort;

  before(async () => {
    targetServer = net.createServer(socket => {
      socket.once('data', chunk => socket.end(`echo:${chunk.toString('utf8')}`));
    });
    await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
    targetPort = targetServer.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)]);
    await waitForPort(proxyPort);
  });

  after(async () => {
    if (targetServer) targetServer.close();
    if (proxyChild) await killAndWait(proxyChild);
  });

  it('allows local CONNECT tunnels for standard HTTPS_PROXY clients', async () => {
    const response = await new Promise((resolve, reject) => {
      const client = net.connect(proxyPort, '127.0.0.1');
      let buffer = Buffer.alloc(0);
      let connected = false;
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('CONNECT tunnel timed out'));
      }, 3000);

      client.on('connect', () => {
        client.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
      });
      client.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!connected) {
          const text = buffer.toString('utf8');
          const headerEnd = text.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;
          if (!text.slice(0, headerEnd).includes('200 Connection Established')) {
            clearTimeout(timer);
            client.destroy();
            reject(new Error(text));
            return;
          }
          connected = true;
          buffer = Buffer.alloc(0);
          client.write('ping');
          return;
        }
        const text = buffer.toString('utf8');
        if (text.includes('echo:ping')) {
          clearTimeout(timer);
          client.end();
          resolve(text);
        }
      });
      client.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.ok(response.includes('echo:ping'));

    const { entries } = await httpGet(proxyPort, '/_api/entries');
    const tunnelEntry = entries.find(entry => entry.method === 'CONNECT' && entry.url === `127.0.0.1:${targetPort}`);
    assert.ok(tunnelEntry, 'CONNECT tunnel should be visible in dashboard entries');
    assert.equal(tunnelEntry.provider, 'google');
    assert.equal(tunnelEntry.agent, 'gemini');
    assert.equal(tunnelEntry.title, `CONNECT 127.0.0.1:${targetPort}`);
    assert.equal(tunnelEntry.stopReason, 'tunnel_established');

    const fullEntry = await httpGet(proxyPort, '/_api/entry/' + encodeURIComponent(tunnelEntry.id));
    assert.equal(fullEntry.req.method, 'CONNECT');
    assert.equal(fullEntry.req.target, `127.0.0.1:${targetPort}`);
    assert.equal(fullEntry.res.encrypted, true);
    assert.match(fullEntry.res.note, /not captured/);
  });

  it('rejects malformed CONNECT targets', async () => {
    const response = await new Promise((resolve, reject) => {
      const client = net.connect(proxyPort, '127.0.0.1');
      let data = '';
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('malformed CONNECT response timed out'));
      }, 3000);

      client.on('connect', () => {
        client.write('CONNECT not-a-target HTTP/1.1\r\nHost: not-a-target\r\n\r\n');
      });
      client.on('data', chunk => { data += chunk.toString('utf8'); });
      client.on('end', () => {
        clearTimeout(timer);
        resolve(data);
      });
      client.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.ok(response.includes('400 Bad Request'), response);
  });
});

// ── R4: EADDRINUSE handling ────────────────────────────────────────

describe('R4: port conflict', () => {
  let blocker;
  let port;

  before(async () => {
    port = await findFreePort();
    blocker = net.createServer();
    await new Promise(r => blocker.listen(port, r));
  });

  after(() => {
    blocker.close();
  });

  it('standalone mode reports port in use', async () => {
    const { stderr, code } = await spawnAndCollect(['--port', String(port)]);
    assert.ok(stderr.includes('already in use') || stderr.includes('EADDRINUSE'));
    assert.equal(code, 1);
  });
});

// ── R2: hub crash recovery (sequential fork → kill → re-fork) ──────

describe('R2: hub crash recovery', () => {
  let hubPid1 = null;
  let hubPid2 = null;
  let port;

  after(async () => {
    for (const pid of [hubPid1, hubPid2]) {
      if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}
  });

  it('re-forks hub after original hub is killed', async () => {
    port = await findFreePort();

    // 1. Fork first hub
    const child1 = spawnServer(['--port', String(port), '--hub-mode']);
    await waitForPort(port);
    const lock1 = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'hub.json'), 'utf8'));
    hubPid1 = lock1.pid;
    assert.ok(hubPid1 > 0);
    assert.equal(lock1.port, port);

    // 2. Kill first hub
    process.kill(hubPid1, 'SIGKILL');
    await new Promise(r => child1.on('exit', r));

    // 3. Delete lockfile (simulating what startHubMonitor does)
    try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}

    // 4. Wait for port to be released
    await new Promise(resolve => {
      const check = () => {
        const srv = net.createServer();
        srv.once('error', () => setTimeout(check, 200));
        srv.once('listening', () => srv.close(() => resolve()));
        srv.listen(port);
      };
      check();
    });

    // 5. Fork second hub on same port
    const child2 = spawnServer(['--port', String(port), '--hub-mode']);
    await waitForPort(port);
    const lock2 = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'hub.json'), 'utf8'));
    hubPid2 = lock2.pid;
    assert.ok(hubPid2 > 0);
    assert.equal(lock2.port, port);
    assert.notEqual(hubPid2, hubPid1);

    // 6. Verify new hub is healthy
    const health = await httpGet(port, '/_api/health');
    assert.deepEqual(health, { ok: true });

    await killAndWait(child2);
  });
});

// ── E2: claude not found (ENOENT) ──────────────────────────────────

describe('claude launcher mode', () => {
  function createFakeClaudeCapture() {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-fake-claude-'));
    const capturePath = path.join(fakeBin, 'capture.json');
    const claudePath = path.join(fakeBin, 'claude');
    fs.writeFileSync(claudePath, [
      '#!/bin/sh',
      'node -e \'const fs=require("fs"); fs.writeFileSync(process.env.CCXRAY_TEST_CLAUDE_CAPTURE, JSON.stringify({ argv: process.argv.slice(1), anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || null }));\' -- "$@"',
    ].join('\n'));
    fs.chmodSync(claudePath, 0o755);
    return { fakeBin, capturePath };
  }

  it('spawns claude through the provider registry and forwards user args', async () => {
    const port = await findFreePort();
    const { fakeBin, capturePath } = createFakeClaudeCapture();
    try {
      const nodeBin = path.dirname(process.execPath);
      const { code, stderr } = await spawnAndCollect(
        ['--port', String(port), 'claude', '--continue'],
        8000,
        {
          PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
          CCXRAY_TEST_CLAUDE_CAPTURE: capturePath,
        }
      );

      assert.equal(code, 0, stderr);
      const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      assert.deepEqual(capture.argv, ['--continue']);
      assert.equal(capture.anthropicBaseUrl, `http://localhost:${port}`);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('consumes --no-browser as a ccxray flag before launching claude', async () => {
    const port = await findFreePort();
    const { fakeBin, capturePath } = createFakeClaudeCapture();
    try {
      const nodeBin = path.dirname(process.execPath);
      const { code, stderr } = await spawnAndCollect(
        ['--port', String(port), 'claude', '--no-browser'],
        8000,
        {
          PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
          CCXRAY_TEST_CLAUDE_CAPTURE: capturePath,
        }
      );

      assert.equal(code, 0, stderr);
      const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      assert.deepEqual(capture.argv, []);
      assert.equal(capture.anthropicBaseUrl, `http://localhost:${port}`);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('uses hub discovery and registration for claude mode without explicit port', async () => {
    const port = await findFreePort();
    const hubChild = spawnServer(['--port', String(port), '--hub-mode']);
    await waitForPort(port);

    const { fakeBin, capturePath } = createFakeClaudeCapture();
    const nodeBin = path.dirname(process.execPath);
    try {
      const { code, stderr } = await spawnAndCollect(
        ['claude', '--continue'],
        8000,
        {
          PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
          CCXRAY_TEST_CLAUDE_CAPTURE: capturePath,
        }
      );

      assert.equal(code, 0, stderr);
      const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      assert.deepEqual(capture.argv, ['--continue']);
      assert.equal(capture.anthropicBaseUrl, `http://localhost:${port}`);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      await killAndWait(hubChild);
      try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}
    }
  });
});

describe('E2: claude not found', () => {
  it('reports error when claude binary is missing', async () => {
    const port = await findFreePort();

    // Spawn with empty PATH so 'claude' cannot be found.
    // Keep node in PATH so the process itself can run.
    const nodeBin = path.dirname(process.execPath);
    const { stderr, code } = await spawnAndCollect(
      ['--port', String(port), 'claude'],
      8000,
      { PATH: nodeBin }
    );

    assert.ok(
      stderr.includes('not found') || stderr.includes('ENOENT'),
      `Expected ENOENT message, got: ${stderr.slice(0, 200)}`
    );
  });
});

describe('codex launcher mode', () => {
  function createFakeCodexCapture() {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-fake-codex-'));
    const capturePath = path.join(fakeBin, 'capture.json');
    const codexPath = path.join(fakeBin, 'codex');
    fs.writeFileSync(codexPath, [
      '#!/bin/sh',
      'node -e \'const fs=require("fs"); fs.writeFileSync(process.env.CCXRAY_TEST_CODEX_CAPTURE, JSON.stringify({ argv: process.argv.slice(1), anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || null }));\' -- "$@"',
    ].join('\n'));
    fs.chmodSync(codexPath, 0o755);
    return { fakeBin, capturePath };
  }

  it('spawns codex with OpenAI base URL override and forwards user args', async () => {
    const port = await findFreePort();
    const { fakeBin, capturePath } = createFakeCodexCapture();

    const nodeBin = path.dirname(process.execPath);
    const { code, stderr } = await spawnAndCollect(
      ['--port', String(port), 'codex', 'exec', 'hello', '--flag'],
      8000,
      {
        PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
        CCXRAY_TEST_CODEX_CAPTURE: capturePath,
      }
    );

    assert.equal(code, 0, stderr);
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.deepEqual(capture.argv, [
      '-c',
      `openai_base_url="http://localhost:${port}/v1"`,
      'exec',
      'hello',
      '--flag',
    ]);
    assert.equal(capture.anthropicBaseUrl, null);

    fs.rmSync(fakeBin, { recursive: true, force: true });
  });

  it('consumes --no-browser as a ccxray flag before launching codex', async () => {
    const port = await findFreePort();
    const { fakeBin, capturePath } = createFakeCodexCapture();

    const nodeBin = path.dirname(process.execPath);
    const { code, stderr } = await spawnAndCollect(
      ['--port', String(port), 'codex', '--no-browser'],
      8000,
      {
        PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
        CCXRAY_TEST_CODEX_CAPTURE: capturePath,
      }
    );

    assert.equal(code, 0, stderr);
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.deepEqual(capture.argv, [
      '-c',
      `openai_base_url="http://localhost:${port}/v1"`,
    ]);

    fs.rmSync(fakeBin, { recursive: true, force: true });
  });

  it('uses hub discovery and registration for codex mode without explicit port', async () => {
    const port = await findFreePort();
    const hubChild = spawnServer(['--port', String(port), '--hub-mode']);
    await waitForPort(port);

    const { fakeBin, capturePath } = createFakeCodexCapture();
    const nodeBin = path.dirname(process.execPath);
    try {
      const { code, stderr } = await spawnAndCollect(
        ['codex', 'exec', 'hello'],
        8000,
        {
          PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
          CCXRAY_TEST_CODEX_CAPTURE: capturePath,
        }
      );

      assert.equal(code, 0, stderr);
      const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      assert.deepEqual(capture.argv, [
        '-c',
        `openai_base_url="http://localhost:${port}/v1"`,
        'exec',
        'hello',
      ]);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      await killAndWait(hubChild);
      try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}
    }
  });

  it('forks a Codex-started hub with the default ccxray display name', async () => {
    const port = await findFreePort();
    const { fakeBin, capturePath } = createFakeCodexCapture();
    const nodeBin = path.dirname(process.execPath);
    try {
      const { code, stderr } = await spawnAndCollect(
        ['codex', 'exec', 'hello'],
        8000,
        {
          PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
          CCXRAY_TEST_CODEX_CAPTURE: capturePath,
          PROXY_PORT: String(port),
        }
      );

      assert.equal(code, 0, stderr);
      const html = await httpGetRaw(port, '/');
      assert.ok(html.includes('"APP_NAME":"ccxray"'), html);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      try {
        const lock = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'hub.json'), 'utf8'));
        process.kill(lock.pid, 'SIGTERM');
      } catch {}
      try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}
    }
  });

  it('reports a Codex-specific install hint when codex binary is missing', async () => {
    const port = await findFreePort();
    const nodeBin = path.dirname(process.execPath);
    const { stderr, code } = await spawnAndCollect(
      ['--port', String(port), 'codex'],
      8000,
      { PATH: nodeBin }
    );

    assert.equal(code, 1);
    assert.ok(stderr.includes('"codex" command not found'), stderr);
    assert.ok(stderr.includes('@openai/codex'), stderr);
  });
});

describe('gemini launcher mode', () => {
  function createFakeGeminiCapture() {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-fake-gemini-'));
    const capturePath = path.join(fakeBin, 'capture.json');
    const geminiPath = path.join(fakeBin, 'gemini');
    fs.writeFileSync(geminiPath, [
      '#!/bin/sh',
      'node -e \'const fs=require("fs"); const keys=["HTTPS_PROXY","HTTP_PROXY","https_proxy","http_proxy","NO_PROXY","no_proxy","ANTHROPIC_BASE_URL"]; const env={}; for (const key of keys) env[key]=process.env[key]||null; fs.writeFileSync(process.env.CCXRAY_TEST_GEMINI_CAPTURE, JSON.stringify({ argv: process.argv.slice(1), env }));\' -- "$@"',
    ].join('\n'));
    fs.chmodSync(geminiPath, 0o755);
    return { fakeBin, capturePath };
  }

  it('spawns gemini with standard proxy env and forwards user args', async () => {
    const port = await findFreePort();
    const { fakeBin, capturePath } = createFakeGeminiCapture();
    try {
      const nodeBin = path.dirname(process.execPath);
      const { code, stderr } = await spawnAndCollect(
        ['--port', String(port), 'gemini', '--version'],
        8000,
        {
          PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
          CCXRAY_TEST_GEMINI_CAPTURE: capturePath,
          NO_PROXY: 'corp.internal',
        }
      );

      assert.equal(code, 0, stderr);
      const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      assert.deepEqual(capture.argv, ['--version']);
      assert.equal(capture.env.HTTPS_PROXY, `http://localhost:${port}`);
      assert.equal(capture.env.HTTP_PROXY, `http://localhost:${port}`);
      assert.equal(capture.env.https_proxy, `http://localhost:${port}`);
      assert.equal(capture.env.http_proxy, `http://localhost:${port}`);
      assert.equal(capture.env.NO_PROXY, 'corp.internal,localhost,127.0.0.1,::1');
      assert.equal(capture.env.no_proxy, 'corp.internal,localhost,127.0.0.1,::1');
      assert.equal(capture.env.ANTHROPIC_BASE_URL, null);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('reports a Gemini-specific install hint when gemini binary is missing', async () => {
    const port = await findFreePort();
    const nodeBin = path.dirname(process.execPath);
    const { stderr, code } = await spawnAndCollect(
      ['--port', String(port), 'gemini'],
      8000,
      { PATH: nodeBin }
    );

    assert.equal(code, 1);
    assert.ok(stderr.includes('"gemini" command not found'), stderr);
    assert.ok(stderr.includes('@google/gemini-cli'), stderr);
  });
});

// ── P0: Proxy end-to-end (request → forward → response → log) ──────

describe('P0: proxy end-to-end forwarding', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let receivedReq = null;

  before(async () => {
    // 1. Start mock "Anthropic API" server
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        receivedReq = { method: req.method, url: req.url, headers: req.headers, body };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_test123',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello from mock' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    // 2. Start proxy pointing to mock upstream
    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: 'localhost',
        ANTHROPIC_TEST_PORT: String(mockPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('forwards request to upstream and returns response', async () => {
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test' }],
    });

    const response = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
        },
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.end(requestBody);
    });

    // Verify proxy forwarded to mock upstream
    assert.ok(receivedReq, 'mock upstream should have received the request');
    assert.equal(receivedReq.method, 'POST');
    assert.equal(receivedReq.url, '/v1/messages');

    // Verify proxy returned upstream response to client
    assert.equal(response.status, 200);
    assert.equal(response.body.id, 'msg_test123');
    assert.equal(response.body.content[0].text, 'Hello from mock');
  });

  it('writes req/res log files', async () => {
    // Give a moment for async writes
    await new Promise(r => setTimeout(r, 500));

    const logsDir = path.join(TEST_HOME, 'logs');
    const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
    const reqFiles = files.filter(f => f.endsWith('_req.json'));
    const resFiles = files.filter(f => f.endsWith('_res.json'));

    assert.ok(reqFiles.length > 0, `Expected req log files, found: ${files.join(', ')}`);
    assert.ok(resFiles.length > 0, `Expected res log files, found: ${files.join(', ')}`);

    // Verify req log content
    const reqContent = reqFiles
      .map(file => JSON.parse(fs.readFileSync(path.join(logsDir, file), 'utf8')))
      .find(req => req.model === 'claude-sonnet-4-20250514');
    assert.ok(reqContent, 'Expected a Claude request log file');
    assert.equal(reqContent.model, 'claude-sonnet-4-20250514');
    assert.ok(reqContent.messages);
  });
});

describe('OpenAI upstream routing', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let receivedReq = null;
  let receivedWsReq = null;
  let receivedWsMessage = null;
  let mockWss;
  const upstreamBody = {
    id: 'resp_openai_test',
    object: 'response',
    model: 'gpt-5.1-codex',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
    },
  };

  before(async () => {
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        receivedReq = { method: req.method, url: req.url, headers: req.headers, body };
        if (req.url.startsWith('/v1/models')) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'x-openai-mock': 'models' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.1-codex', object: 'model' }] }));
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json', 'x-openai-mock': 'responses' });
        res.end(JSON.stringify(upstreamBody));
      });
    });
    mockWss = new WebSocket.WebSocketServer({ noServer: true });
    mockUpstream.on('upgrade', (req, socket, head) => {
      mockWss.handleUpgrade(req, socket, head, (ws) => {
        receivedWsReq = { url: req.url, headers: req.headers };
        ws.on('message', data => {
          receivedWsMessage = JSON.parse(data.toString('utf8'));
          ws.send(JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_ws_ok', object: 'response', model: 'gpt-5.1-codex', status: 'in_progress' },
          }));
          ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hello ws' }));
          ws.send(JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_ws_ok',
              object: 'response',
              model: 'gpt-5.1-codex',
              status: 'completed',
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello ws' }] }],
              usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
            },
          }));
          ws.close(1000, 'done');
        });
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        OPENAI_BASE_URL: `http://localhost:${mockPort}/v1`,
        CHATGPT_BASE_URL: `http://localhost:${mockPort}/backend-api/codex`,
        OPENAI_TEST_HOST: '',
        OPENAI_TEST_PORT: '',
        OPENAI_TEST_PROTOCOL: '',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    await new Promise(r => mockWss.close(r));
    await new Promise(r => mockUpstream.close(r));
  });

  it('forwards Codex /v1/models probes to the OpenAI upstream', async () => {
    const response = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/models?client_version=0.125.0`, {
        method: 'GET',
        headers: { Authorization: 'Bearer test-key' },
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    assert.ok(receivedReq, 'mock OpenAI upstream should have received the models probe');
    assert.equal(receivedReq.method, 'GET');
    assert.equal(receivedReq.url, '/v1/models?client_version=0.125.0');
    assert.equal(receivedReq.headers.authorization, 'Bearer test-key');
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-openai-mock'], 'models');
    assert.equal(response.body.data[0].id, 'gpt-5.1-codex');
  });

  it('forwards /v1/responses to OPENAI_BASE_URL while preserving request and response details', async () => {
    const requestBody = JSON.stringify({
      model: 'gpt-5.1-codex',
      instructions: 'Answer concisely.',
      input: 'test openai routing',
    });

    const response = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/responses?trace=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          Authorization: 'Bearer test-key',
          Connection: 'keep-alive, x-remove-me',
          'x-remove-me': 'drop-me',
          'accept-encoding': 'gzip',
        },
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.end(requestBody);
    });

    assert.ok(receivedReq, 'mock OpenAI upstream should have received the request');
    assert.equal(receivedReq.method, 'POST');
    assert.equal(receivedReq.url, '/v1/responses?trace=1');
    assert.equal(receivedReq.body, requestBody);
    assert.equal(receivedReq.headers.host, 'localhost');
    assert.equal(receivedReq.headers.authorization, 'Bearer test-key');
    assert.equal(receivedReq.headers['x-remove-me'], undefined);
    assert.equal(receivedReq.headers['accept-encoding'], undefined);
    assert.equal(response.status, 201);
    assert.equal(response.headers['x-openai-mock'], 'responses');
    assert.deepEqual(response.body, upstreamBody);

    await new Promise(r => setTimeout(r, 300));
    const logsDir = path.join(TEST_HOME, 'logs');
    const reqFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('_req.json'));
    const openAIReqLogs = reqFiles
      .map(f => JSON.parse(fs.readFileSync(path.join(logsDir, f), 'utf8')))
      .filter(log => log.provider === 'openai' && log.model === 'gpt-5.1-codex');
    assert.ok(openAIReqLogs.length > 0, 'expected stripped OpenAI request log');
    const reqLog = openAIReqLogs.at(-1);
    assert.equal(reqLog.agent, 'codex');
    assert.equal(reqLog.path, '/v1/responses?trace=1');
    assert.equal(reqLog.instructions.summary, 'Answer concisely.');
    assert.equal(reqLog.input.summary, 'test openai routing');
    assert.match(reqLog.instructions.hash, /^[a-f0-9]{12}$/);
    assert.match(reqLog.input.hash, /^[a-f0-9]{12}$/);
    assert.equal(reqLog.toolsHash, null);
    assert.equal(reqLog.rawRequest.bytes, Buffer.byteLength(requestBody));
    assert.match(reqLog.rawRequest.sha256, /^[a-f0-9]{64}$/);

    const entriesPayload = await httpGet(proxyPort, '/_api/entries');
    const entry = entriesPayload.entries
      .filter(e => e.provider === 'openai' && e.model === 'gpt-5.1-codex')
      .at(-1);
    assert.ok(entry, 'expected OpenAI dashboard entry');
    const fullEntry = await httpGet(proxyPort, '/_api/entry/' + encodeURIComponent(entry.id));
    assert.equal(fullEntry.req.instructions, 'Answer concisely.');
    assert.equal(fullEntry.req.input, 'test openai routing');
  });

  it('persists structured Responses instructions, input, and tools for dashboard inspection', async () => {
    const structuredInput = [{
      role: 'user',
      content: [{ type: 'input_text', text: 'inspect this structured payload' }],
    }];
    const tools = [{
      type: 'function',
      name: 'shell',
      description: 'Run a command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    }];
    const requestBody = JSON.stringify({
      model: 'gpt-5.1-codex',
      instructions: 'You are Codex in inspection mode.',
      input: structuredInput,
      tools,
    });

    const response = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          Authorization: 'Bearer test-key',
        },
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.end(requestBody);
    });

    assert.equal(response.status, 201);

    await new Promise(r => setTimeout(r, 300));
    const logsDir = path.join(TEST_HOME, 'logs');
    const sharedDir = path.join(logsDir, 'shared');
    const reqFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('_req.json'));
    const reqLog = reqFiles
      .map(f => JSON.parse(fs.readFileSync(path.join(logsDir, f), 'utf8')))
      .filter(log => log.provider === 'openai' && log.input?.type === 'array')
      .at(-1);
    assert.ok(reqLog, 'expected structured OpenAI request log');
    assert.match(reqLog.instructions.hash, /^[a-f0-9]{12}$/);
    assert.match(reqLog.input.hash, /^[a-f0-9]{12}$/);
    assert.match(reqLog.toolsHash, /^[a-f0-9]{12}$/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(sharedDir, `openai_instructions_${reqLog.instructions.hash}.json`), 'utf8')),
      'You are Codex in inspection mode.'
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(sharedDir, `openai_input_${reqLog.input.hash}.json`), 'utf8')),
      structuredInput
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(sharedDir, `openai_tools_${reqLog.toolsHash}.json`), 'utf8')),
      tools
    );

    const entriesPayload = await httpGet(proxyPort, '/_api/entries');
    const entry = entriesPayload.entries
      .filter(e => e.provider === 'openai' && e.toolCount === 1)
      .at(-1);
    assert.ok(entry, 'expected inspectable OpenAI dashboard entry');
    const fullEntry = await httpGet(proxyPort, '/_api/entry/' + encodeURIComponent(entry.id));
    assert.equal(fullEntry.req.instructions, 'You are Codex in inspection mode.');
    assert.deepEqual(fullEntry.req.input, structuredInput);
    assert.deepEqual(fullEntry.req.tools, tools);
  });

  it('proxies Codex Responses WebSocket traffic and captures dashboard details', async () => {
    const turnMetadata = {
      session_id: 'codex-ws-session',
      thread_source: 'user',
      turn_id: 'codex-ws-turn',
      workspaces: { '/tmp/codex-ws-project': { has_changes: false } },
      sandbox: 'seatbelt',
    };
    const payload = {
      type: 'response.create',
      model: 'gpt-5.1-codex',
      instructions: 'Use the websocket path.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello from websocket' }] }],
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
    };

    const received = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
        headers: {
          Authorization: 'Bearer test-key',
          'chatgpt-account-id': 'acct-test',
          originator: 'codex_exec',
          'openai-beta': 'responses_websockets=2026-02-06',
          'x-codex-turn-metadata': JSON.stringify(turnMetadata),
          session_id: turnMetadata.session_id,
        },
      });
      ws.on('open', () => ws.send(JSON.stringify(payload)));
      ws.on('message', data => received.push(JSON.parse(data.toString('utf8'))));
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });

    assert.ok(receivedWsReq, 'mock OpenAI WebSocket upstream should receive an upgrade');
    assert.equal(receivedWsReq.url, '/backend-api/codex/responses');
    assert.equal(receivedWsReq.headers.authorization, 'Bearer test-key');
    assert.equal(receivedWsReq.headers['chatgpt-account-id'], 'acct-test');
    assert.equal(receivedWsReq.headers['openai-beta'], 'responses_websockets=2026-02-06');
    assert.equal(receivedWsMessage.model, 'gpt-5.1-codex');
    assert.deepEqual(receivedWsMessage.input, payload.input);
    assert.ok(received.some(e => e.type === 'response.completed'));

    await new Promise(r => setTimeout(r, 300));
    const entriesPayload = await httpGet(proxyPort, '/_api/entries');
    const entry = entriesPayload.entries
      .filter(e => e.provider === 'openai' && e.responseMetadata?.websocket)
      .at(-1);
    assert.ok(entry, 'expected OpenAI WebSocket dashboard entry');
    assert.equal(entry.agent, 'codex');
    assert.equal(entry.method, 'WS');
    assert.equal(entry.status, 101);
    assert.equal(entry.model, 'gpt-5.1-codex');
    assert.equal(entry.cwd, '/tmp/codex-ws-project');
    assert.equal(entry.responseMetadata.responseStatus, 'completed');
    assert.deepEqual(entry.usage, {
      input_tokens: 8,
      output_tokens: 2,
      total_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: 0,
      raw_input_tokens: 8,
      input_tokens_details: null,
      output_tokens_details: null,
    });

    const fullEntry = await httpGet(proxyPort, '/_api/entry/' + encodeURIComponent(entry.id));
    assert.equal(fullEntry.req.instructions, 'Use the websocket path.');
    assert.deepEqual(fullEntry.req.input, payload.input);
    assert.ok(fullEntry.res.some(e => e.event === 'response.output_text.delta' && e.data.delta === 'hello ws'));
  });
});

describe('OpenAI upstream failure handling', () => {
  let proxyChild;
  let proxyPort;

  after(async () => {
    if (proxyChild) await killAndWait(proxyChild);
  });

  it('returns a structured 502 proxy error when the OpenAI upstream is unreachable', async () => {
    const deadPort = await findFreePort();
    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        OPENAI_TEST_HOST: 'localhost',
        OPENAI_TEST_PORT: String(deadPort),
        OPENAI_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);

    const requestBody = JSON.stringify({
      model: 'gpt-5.1-codex',
      input: 'trigger upstream failure',
    });
    const response = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          Authorization: 'Bearer test-key',
        },
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.end(requestBody);
    });

    assert.equal(response.status, 502);
    assert.equal(response.body.error, 'proxy_error');
    assert.ok(response.body.message);

    const health = await httpGet(proxyPort, '/_api/health');
    assert.deepEqual(health, { ok: true });
  });
});

describe('Dual-provider regression coverage', () => {
  let anthropicUpstream;
  let openAIUpstream;
  let anthropicPort;
  let openAIPort;
  let proxyChild;
  let proxyPort;
  const received = { anthropic: [], openai: [] };

  before(async () => {
    anthropicUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        received.anthropic.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-provider-mock': 'anthropic' });
        res.end(JSON.stringify({
          id: 'msg_dual_provider',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'claude ok' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 11, output_tokens: 3 },
        }));
      });
    });
    await new Promise(r => anthropicUpstream.listen(0, r));
    anthropicPort = anthropicUpstream.address().port;

    openAIUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        received.openai.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-provider-mock': 'openai' });
        res.end(JSON.stringify({
          id: 'resp_dual_provider',
          object: 'response',
          model: 'gpt-5.1-codex',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'codex ok' }] }],
          usage: { input_tokens: 13, output_tokens: 5, total_tokens: 18 },
        }));
      });
    });
    await new Promise(r => openAIUpstream.listen(0, r));
    openAIPort = openAIUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: 'localhost',
        ANTHROPIC_TEST_PORT: String(anthropicPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
        OPENAI_TEST_HOST: 'localhost',
        OPENAI_TEST_PORT: String(openAIPort),
        OPENAI_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    await new Promise(r => anthropicUpstream.close(r));
    await new Promise(r => openAIUpstream.close(r));
  });

  it('routes Claude and Codex requests through their provider upstreams in the same proxy run', async () => {
    const claudeBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'dual claude request' }],
      metadata: { user_id: JSON.stringify({ session_id: '11112222-3333-4444-5555-666677778888' }) },
    });
    const codexBody = JSON.stringify({
      model: 'gpt-5.1-codex',
      instructions: 'Use the OpenAI Responses path.',
      input: 'dual codex request',
      metadata: { session_id: 'dual-codex-session', cwd: '/tmp/dual-provider' },
    });

    const claudeResponse = await sendProxyRequest(proxyPort, claudeBody);
    const codexResponse = await sendOpenAIResponsesRequest(proxyPort, codexBody);

    assert.equal(claudeResponse.status, 200);
    assert.equal(codexResponse.status, 200);
    assert.equal(JSON.parse(claudeResponse.body).content[0].text, 'claude ok');
    assert.equal(JSON.parse(codexResponse.body).output[0].content[0].text, 'codex ok');

    assert.equal(received.anthropic.length, 1, 'Anthropic upstream should receive only Claude traffic');
    assert.equal(received.openai.length, 1, 'OpenAI upstream should receive only Codex traffic');
    assert.equal(received.anthropic[0].url, '/v1/messages');
    assert.equal(received.openai[0].url, '/v1/responses');
    assert.equal(JSON.parse(received.anthropic[0].body).messages[0].content, 'dual claude request');
    assert.equal(JSON.parse(received.openai[0].body).input, 'dual codex request');

    await new Promise(r => setTimeout(r, 500));
    const { entries } = await httpGet(proxyPort, '/_api/entries');
    const claudeEntry = entries
      .filter(e => e.provider === 'anthropic' && e.sessionId === '11112222-3333-4444-5555-666677778888')
      .at(-1);
    const codexEntry = entries
      .filter(e => e.provider === 'openai' && e.responseMetadata?.id === 'resp_dual_provider')
      .at(-1);
    assert.ok(claudeEntry, 'expected Anthropic dashboard entry');
    assert.ok(codexEntry, 'expected OpenAI dashboard entry');
    assert.equal(claudeEntry.agent, 'claude');
    assert.equal(codexEntry.agent, 'codex');
    assert.equal(codexEntry.sessionId, 'codex-dual-codex-session');

    const logsDir = path.join(TEST_HOME, 'logs');
    const indexEntries = fs.readFileSync(path.join(logsDir, 'index.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.ok(indexEntries.some(e => e.provider === 'anthropic' && e.id === claudeEntry.id));
    assert.ok(indexEntries.some(e => e.provider === 'openai' && e.id === codexEntry.id));
  });
});

describe('Malformed OpenAI log restore regression', () => {
  let malformedHome;
  let proxyChild;
  let proxyPort;

  before(async () => {
    malformedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-malformed-openai-log-'));
    const logsDir = path.join(malformedHome, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const id = '2026-04-27T12-45-00-000';
    fs.writeFileSync(path.join(logsDir, 'index.ndjson'), JSON.stringify({
      id,
      ts: '12:45:00',
      provider: 'openai',
      agent: 'codex',
      sessionId: 'codex-malformed',
      method: 'POST',
      url: '/v1/responses',
      status: 200,
      model: 'gpt-5.1-codex',
      receivedAt: Date.now(),
    }) + '\n');
    fs.writeFileSync(path.join(logsDir, `${id}_req.json`), '{"provider":"openai",');
    fs.writeFileSync(path.join(logsDir, `${id}_res.json`), '{"not valid"');

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: { CCXRAY_HOME: malformedHome, RESTORE_DAYS: '0' },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    fs.rmSync(malformedHome, { recursive: true, force: true });
  });

  it('starts the dashboard and lazy-loads malformed OpenAI req/res as null/raw data', async () => {
    const health = await httpGet(proxyPort, '/_api/health');
    assert.deepEqual(health, { ok: true });

    const { entries } = await httpGet(proxyPort, '/_api/entries');
    const restored = entries.find(e => e.provider === 'openai' && e.id === '2026-04-27T12-45-00-000');
    assert.ok(restored, 'expected malformed OpenAI index entry to restore');
    assert.equal(restored.agent, 'codex');

    const fullEntry = await httpGet(proxyPort, '/_api/entry/' + encodeURIComponent(restored.id));
    assert.equal(fullEntry.req, null);
    assert.equal(fullEntry.res, '{"not valid"');
  });
});

describe('OpenAI Responses SSE streaming capture', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let sentStream = '';

  before(async () => {
    mockUpstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'x-openai-stream-test': 'yes',
        });

        const frames = [
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream_ok","model":"gpt-5.1-codex","status":"in_progress"}}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"Hello stream"}]}}\n\n',
          'event: response.output_text.delta\ndata: {"delta":\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream_ok","object":"response","model":"gpt-5.1-codex","status":"completed","output":[{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"Hello stream"}]}],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n',
        ];
        sentStream = frames.join('');

        let i = 0;
        const sendNext = () => {
          if (i >= frames.length) { res.end(); return; }
          res.write(frames[i]);
          i++;
          setTimeout(sendNext, 5);
        };
        sendNext();
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        OPENAI_BASE_URL: `http://localhost:${mockPort}/v1`,
        OPENAI_TEST_HOST: '',
        OPENAI_TEST_PORT: '',
        OPENAI_TEST_PROTOCOL: '',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('passes OpenAI Responses SSE through while logging parsed and malformed events', async () => {
    const requestBody = JSON.stringify({
      model: 'gpt-5.1-codex',
      stream: true,
      input: 'stream please',
    });

    const response = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          Authorization: 'Bearer test-key',
        },
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('error', reject);
      req.end(requestBody);
    });

    assert.equal(response.status, 200);
    assert.ok((response.headers['content-type'] || '').includes('text/event-stream'));
    assert.equal(response.headers['x-openai-stream-test'], 'yes');
    assert.equal(response.body, sentStream);

    await new Promise(r => setTimeout(r, 500));
    const logsDir = path.join(TEST_HOME, 'logs');
    const resFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('_res.json'));
    const matchingEvents = resFiles
      .map(f => JSON.parse(fs.readFileSync(path.join(logsDir, f), 'utf8')))
      .filter(events => Array.isArray(events) && events.some(e => e.data?.response?.id === 'resp_stream_ok'))
      .at(-1);

    assert.ok(matchingEvents, 'expected OpenAI stream response log');
    assert.ok(matchingEvents.some(e => e.event === 'response.created'));
    assert.ok(matchingEvents.some(e => e.event === 'response.output_text.delta' && e.data?.delta === 'Hello '));
    assert.ok(matchingEvents.some(e => e.event === 'response.output_item.done' && e.data?.item?.type === 'message'));
    assert.ok(matchingEvents.some(e => e.event === 'response.output_text.delta' && e.parseError && e.dataRaw === '{"delta":'));

    const completed = matchingEvents.find(e => e.event === 'response.completed');
    assert.equal(completed.data.response.status, 'completed');
    assert.deepEqual(completed.data.response.usage, {
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
    });

    const indexLines = fs.readFileSync(path.join(logsDir, 'index.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const indexEntry = indexLines
      .filter(line => line.provider === 'openai' && line.responseMetadata?.id === 'resp_stream_ok')
      .at(-1);
    assert.ok(indexEntry, 'expected OpenAI stream index entry');
    assert.equal(indexEntry.agent, 'codex');
    assert.equal(indexEntry.isSSE, true);
    assert.equal(indexEntry.responseMetadata.responseStatus, 'completed');
    assert.equal(indexEntry.responseMetadata.outputItems[0].type, 'message');
    assert.deepEqual(indexEntry.usage, {
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: 0,
      raw_input_tokens: 7,
      input_tokens_details: null,
      output_tokens_details: null,
    });
  });
});

// ── SSE streaming proxy E2E ─────────────────────────────────────────

describe('SSE streaming proxy', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;

  before(async () => {
    // Mock upstream that returns SSE event stream (like real Anthropic API)
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });

        // Simulate Anthropic SSE response
        const events = [
          { type: 'message_start', message: { id: 'msg_sse_test', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-20250514', usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'from SSE' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ];

        let i = 0;
        const sendNext = () => {
          if (i >= events.length) { res.end(); return; }
          res.write(`event: ${events[i].type}\ndata: ${JSON.stringify(events[i])}\n\n`);
          i++;
          setTimeout(sendNext, 5);
        };
        sendNext();
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: 'localhost',
        ANTHROPIC_TEST_PORT: String(mockPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('streams SSE chunks from upstream through proxy to client', async () => {
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'test sse' }],
    });

    const { chunks, headers } = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
        },
      }, res => {
        const chunks = [];
        res.on('data', c => { chunks.push(c.toString()); });
        res.on('end', () => resolve({ chunks, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(requestBody);
    });

    // Verify SSE content-type preserved
    assert.ok(
      (headers['content-type'] || '').includes('text/event-stream'),
      'Response should be text/event-stream'
    );

    // Verify SSE events came through
    const fullResponse = chunks.join('');
    assert.ok(fullResponse.includes('message_start'), 'Should contain message_start event');
    assert.ok(fullResponse.includes('content_block_delta'), 'Should contain content_block_delta');
    assert.ok(fullResponse.includes('Hello '), 'Should contain streamed text "Hello "');
    assert.ok(fullResponse.includes('from SSE'), 'Should contain streamed text "from SSE"');
    assert.ok(fullResponse.includes('message_stop'), 'Should contain message_stop');
  });

  it('writes SSE response to log as parsed events array', async () => {
    // Wait for async log write
    await new Promise(r => setTimeout(r, 500));

    const logsDir = path.join(TEST_HOME, 'logs');
    const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
    const resFiles = files.filter(f => f.endsWith('_res.json'));

    // Find the SSE response log (most recent)
    assert.ok(resFiles.length > 0, 'Should have res log files');
    const lastResFile = resFiles.sort().pop();
    const resContent = JSON.parse(fs.readFileSync(path.join(logsDir, lastResFile), 'utf8'));

    // SSE responses are stored as parsed event arrays
    assert.ok(Array.isArray(resContent), 'SSE res log should be an array of events');
    assert.ok(resContent.length >= 5, `Expected >= 5 events, got ${resContent.length}`);

    // Verify event types are captured
    const types = resContent.map(e => e.type);
    assert.ok(types.includes('message_start'), 'Should log message_start');
    assert.ok(types.includes('content_block_delta'), 'Should log content_block_delta');
    assert.ok(types.includes('message_stop'), 'Should log message_stop');
  });
});

// ── Intercept lifecycle E2E ──────────────────────────────────────────

describe('Intercept lifecycle', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  const TEST_SESSION = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
  let mockUpstreamNextResponse = null;

  function makeRequestBody(content) {
    return JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content }],
      metadata: { user_id: JSON.stringify({ session_id: TEST_SESSION }) },
    });
  }

  before(async () => {
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (mockUpstreamNextResponse) {
          const r = mockUpstreamNextResponse;
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r.body));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_intercept',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'approved response' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: 'localhost',
        ANTHROPIC_TEST_PORT: String(mockPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);

    // Establish session by sending initial request
    const initBody = makeRequestBody('init session');
    await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(initBody), 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(initBody);
    });
  });

  after(async () => {
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('toggle intercept on/off', async () => {
    // Enable intercept
    const on = await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });
    assert.equal(on.enabled, true);
    assert.equal(on.sessionId, TEST_SESSION);

    // Disable intercept
    const off = await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });
    assert.equal(off.enabled, false);
  });

  it('intercept → approve → request forwarded', async () => {
    // Enable intercept
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });

    // Connect SSE to catch pending_request event
    const pendingIdPromise = waitForSSEEvent(proxyPort, 'pending_request');

    // Send request — should be held
    const body = makeRequestBody('intercept me');
    const responsePromise = sendProxyRequest(proxyPort, body);

    // Wait for SSE to tell us the pending request ID
    const pendingId = await pendingIdPromise;
    assert.ok(pendingId, 'Should receive pending_request via SSE');

    // Approve the request
    const approveResult = await httpPost(proxyPort, `/_api/intercept/${encodeURIComponent(pendingId)}/approve`, {});
    assert.equal(approveResult.ok, true);

    // Original request should complete
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.ok(response.body.includes('approved response'));

    // Disable intercept
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });
  });

  it('intercept → reject → client gets 499', async () => {
    // Enable intercept
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });

    const pendingIdPromise = waitForSSEEvent(proxyPort, 'pending_request');

    const body = makeRequestBody('reject me');
    const responsePromise = sendProxyRequest(proxyPort, body);

    const pendingId = await pendingIdPromise;
    assert.ok(pendingId, 'Should receive pending_request via SSE');

    // Reject the request
    const rejectResult = await httpPost(proxyPort, `/_api/intercept/${encodeURIComponent(pendingId)}/reject`, {});
    assert.equal(rejectResult.ok, true);

    // Client should get 499
    const response = await responsePromise;
    assert.equal(response.status, 499);
    assert.ok(response.body.includes('request_rejected'));

    // Cleanup
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });
  });

  it('intercept → approve → upstream 500 → state recovers', async () => {
    // Make upstream return 500 for next request
    mockUpstreamNextResponse = { status: 500, body: { type: 'error', error: { message: 'boom' } } };

    // Enable intercept
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });

    const pendingIdPromise = waitForSSEEvent(proxyPort, 'pending_request');
    const body = makeRequestBody('intercept then fail');
    const responsePromise = sendProxyRequest(proxyPort, body);

    const pendingId = await pendingIdPromise;
    assert.ok(pendingId);

    // Approve — proxy forwards to upstream which returns 500
    await httpPost(proxyPort, `/_api/intercept/${encodeURIComponent(pendingId)}/approve`, {});

    const response = await responsePromise;
    assert.equal(response.status, 500, 'Client should get the 500 from upstream');

    // Disable intercept
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });
    mockUpstreamNextResponse = null;

    // Verify proxy is still healthy
    const health = await httpGet(proxyPort, '/_api/health');
    assert.deepEqual(health, { ok: true });
  });
});

// ── Proxy error paths ───────────────────────────────────────────────

describe('Proxy error paths', () => {
  let proxyChild;
  let proxyPort;
  // No mock upstream — proxy points to a port with nothing listening
  const DEAD_PORT = 1; // privileged, guaranteed no listener

  before(async () => {
    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(DEAD_PORT),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
  });

  it('E1: upstream connection refused → 502 proxy_error', async () => {
    const response = await sendProxyRequest(proxyPort, JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test error' }],
    }));

    assert.equal(response.status, 502);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'proxy_error');
    assert.ok(body.message, 'Should have error message');
  });

  it('E1: proxy survives after upstream error (not crashed)', async () => {
    // Health check still works after error
    const health = await httpGet(proxyPort, '/_api/health');
    assert.deepEqual(health, { ok: true });
  });
});

describe('Proxy upstream error responses', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let nextResponse = null;

  before(async () => {
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (nextResponse) {
          const { status, headers, body: resBody, sse, destroyAfter } = nextResponse;
          res.writeHead(status, headers || { 'Content-Type': 'application/json' });
          if (sse) {
            // Send partial SSE then destroy connection
            for (const chunk of sse) {
              res.write(chunk);
            }
            if (destroyAfter) {
              setTimeout(() => res.end(), 50);
            } else if (nextResponse.socketDestroy) {
              setTimeout(() => res.socket.destroy(), 50);
            } else {
              res.end();
            }
          } else {
            res.end(typeof resBody === 'string' ? resBody : JSON.stringify(resBody));
          }
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg_ok', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
        }
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: 'localhost',
        ANTHROPIC_TEST_PORT: String(mockPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    nextResponse = null;
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('E2: upstream 500 → passthrough to client', async () => {
    nextResponse = {
      status: 500,
      body: { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
    };

    const response = await sendProxyRequest(proxyPort, JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test 500' }],
    }));

    assert.equal(response.status, 500);
    const body = JSON.parse(response.body);
    assert.equal(body.type, 'error');
    nextResponse = null;
  });

  it('E2: upstream 429 rate limit → passthrough to client', async () => {
    nextResponse = {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'retry-after': '30',
      },
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
    };

    const response = await sendProxyRequest(proxyPort, JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test 429' }],
    }));

    assert.equal(response.status, 429);
    const body = JSON.parse(response.body);
    assert.equal(body.error.type, 'rate_limit_error');
    nextResponse = null;
  });

  it('E3: SSE stream aborted mid-response → client gets partial data', async () => {
    nextResponse = {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      sse: [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_partial","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial "}}\n\n',
      ],
      destroyAfter: true, // destroy connection after sending partial events
    };

    const response = await sendProxyRequest(proxyPort, JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'test abort' }],
    }));

    // Client should receive partial SSE data (whatever was forwarded before disconnect)
    assert.ok(response.body.includes('message_start'), 'Should have received message_start');
    assert.ok(response.body.includes('partial '), 'Should have received partial text');
    // No message_stop — stream was cut
    nextResponse = null;
  });

  it('E3: proxy survives SSE abort (not crashed)', async () => {
    nextResponse = null;
    await new Promise(r => setTimeout(r, 200));
    const health = await httpGet(proxyPort, '/_api/health');
    assert.deepEqual(health, { ok: true });
  });

  it('E3b: upstream socket destroyed mid-SSE → proxy handles ECONNRESET', async () => {
    nextResponse = {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      sse: [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_reset","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"before reset"}}\n\n',
      ],
      socketDestroy: true,
    };

    const response = await sendProxyRequest(proxyPort, JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'test reset' }],
    }));

    // Client response should have ended (not hung)
    assert.ok(response.status >= 200, 'Should receive a response, not hang');
    nextResponse = null;
  });

  it('E3b: proxy survives socket destroy', async () => {
    await new Promise(r => setTimeout(r, 300));
    const health = await httpGet(proxyPort, '/_api/health');
    assert.deepEqual(health, { ok: true });
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

// ── State consistency after errors ──────────────────────────────────

describe('Store state consistency after errors', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let nextResponse = null;
  const SESSION_ID = 'bbbbcccc-dddd-eeee-ffff-000000000000';

  function makeBody(content) {
    return JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content }],
      metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) },
    });
  }

  before(async () => {
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (nextResponse) {
          const { status, headers, body: resBody } = nextResponse;
          res.writeHead(status, headers || { 'Content-Type': 'application/json' });
          res.end(typeof resBody === 'string' ? resBody : JSON.stringify(resBody));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_ok', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            model: 'claude-sonnet-4-20250514',
            usage: { input_tokens: 10, output_tokens: 5 },
          }));
        }
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: 'localhost',
        ANTHROPIC_TEST_PORT: String(mockPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);

    // Establish session
    await sendProxyRequest(proxyPort, makeBody('init'));
    await new Promise(r => setTimeout(r, 200));
  });

  after(async () => {
    nextResponse = null;
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('session becomes inactive after upstream 500', async () => {
    nextResponse = { status: 500, body: { type: 'error', error: { message: 'fail' } } };
    await sendProxyRequest(proxyPort, makeBody('trigger 500'));
    nextResponse = null;

    // Check session status via SSE — should be inactive
    await new Promise(r => setTimeout(r, 200));
    const sseData = await collectSSESnapshot(proxyPort);
    const sessionStatus = sseData.find(d => d._type === 'session_status' && d.sessionId === SESSION_ID);
    assert.ok(sessionStatus, 'Should have session_status event');
    assert.equal(sessionStatus.active, false, 'Session should be inactive after error');
  });

  it('subsequent request succeeds after previous error', async () => {
    nextResponse = null; // back to normal
    const response = await sendProxyRequest(proxyPort, makeBody('after error'));
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.content[0].text, 'ok');
  });

  it('entries count is consistent after mixed success/error', async () => {
    const { entries } = await httpGet(proxyPort, '/_api/entries');
    // Should have entries from: init, trigger 500, after error (at least 3)
    assert.ok(entries.length >= 3, `Expected >= 3 entries, got ${entries.length}`);
  });
});

// ── Concurrent requests ─────────────────────────────────────────────

describe('Concurrent proxy requests', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let requestLog = [];

  before(async () => {
    // Mock upstream: echo user message back. SSE mode when stream:true.
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const userMsg = parsed.messages?.[0]?.content || 'unknown';
        const delay = Math.floor(Math.random() * 50) + 10;
        setTimeout(() => {
          requestLog.push(userMsg);
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: `msg_${userMsg}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-20250514', usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`);
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `echo:${userMsg}` } })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
            res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: `msg_${userMsg}`, type: 'message', role: 'assistant',
              content: [{ type: 'text', text: `echo:${userMsg}` }],
              model: 'claude-sonnet-4-20250514',
              usage: { input_tokens: 10, output_tokens: 5 },
            }));
          }
        }, delay);
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: 'localhost',
        ANTHROPIC_TEST_PORT: String(mockPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('5 concurrent requests each get correct response', async () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

    const responses = await Promise.all(ids.map(id =>
      sendProxyRequest(proxyPort, JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: id }],
      }))
    ));

    // Each response should echo back its own request ID
    for (let i = 0; i < ids.length; i++) {
      assert.equal(responses[i].status, 200, `Request ${ids[i]} should succeed`);
      const body = JSON.parse(responses[i].body);
      assert.equal(body.content[0].text, `echo:${ids[i]}`, `Response for ${ids[i]} should match`);
    }
  });

  it('3 concurrent SSE streaming requests each get correct events', async () => {
    const ids = ['stream-a', 'stream-b', 'stream-c'];

    const responses = await Promise.all(ids.map(id =>
      sendProxyRequest(proxyPort, JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: id }],
      }))
    ));

    for (let i = 0; i < ids.length; i++) {
      assert.equal(responses[i].status, 200, `SSE request ${ids[i]} should succeed`);
      assert.ok(responses[i].body.includes(`echo:${ids[i]}`), `SSE response for ${ids[i]} should contain its echo`);
    }
  });

  it('all concurrent requests are logged separately', async () => {
    await new Promise(r => setTimeout(r, 500));
    const logsDir = path.join(TEST_HOME, 'logs');
    const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
    const reqFiles = files.filter(f => f.endsWith('_req.json'));
    // Should have at least 5 req files from concurrent test
    assert.ok(reqFiles.length >= 5, `Expected >= 5 req logs, got ${reqFiles.length}`);
  });

  it('upstream received all 8 requests (5 non-streaming + 3 streaming)', () => {
    assert.equal(requestLog.length, 8, 'Mock upstream should have received 8 requests');
    const sorted = [...requestLog].sort();
    assert.deepEqual(sorted, ['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'stream-a', 'stream-b', 'stream-c']);
  });
});

// ── Hub crash recovery race condition ────────────────────────────────

describe('Hub recovery race: two simultaneous forks', () => {
  let port;

  after(() => {
    // Kill any hub on port
    try {
      const lockPath = path.join(TEST_HOME, 'hub.json');
      if (fs.existsSync(lockPath)) {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        try { process.kill(lock.pid, 'SIGKILL'); } catch {}
        fs.unlinkSync(lockPath);
      }
    } catch {}
  });

  it('two concurrent forkHub calls → only one hub survives', async () => {
    port = await findFreePort();

    // Fork two hubs simultaneously on the same port
    const child1 = spawnServer(['--port', String(port), '--hub-mode']);
    const child2 = spawnServer(['--port', String(port), '--hub-mode']);

    // Wait for one to succeed (write lockfile)
    await waitForPort(port);

    // Only one hub should be listening
    const health = await httpGet(port, '/_api/health');
    assert.deepEqual(health, { ok: true });

    // Lockfile should exist with correct port
    const lockPath = path.join(TEST_HOME, 'hub.json');
    assert.ok(fs.existsSync(lockPath));
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.port, port);

    // Clean up both children
    await killAndWait(child1);
    await killAndWait(child2);

    // Wait for port release
    await new Promise(resolve => {
      const check = () => {
        const srv = net.createServer();
        srv.once('error', () => setTimeout(check, 200));
        srv.once('listening', () => srv.close(() => resolve()));
        srv.listen(port);
      };
      check();
    });
  });
});

function collectSSESnapshot(port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const events = [];
    const req = http.get(`http://localhost:${port}/_events`, res => {
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); resolve(events); }, timeoutMs);
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch {}
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve(events); });
    });
    req.on('error', () => resolve(events));
  });
}

function waitForSSEEvent(port, eventType, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}/_events`, res => {
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`SSE timeout waiting for ${eventType}`)); }, timeoutMs);
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data._type === eventType) {
              clearTimeout(timer);
              req.destroy();
              resolve(data.requestId || data.id || null);
              return;
            }
          } catch {}
        }
      });
    });
    req.on('error', () => {}); // ignore destroy errors
  });
}

function sendProxyRequest(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function sendOpenAIResponsesRequest(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer test-key' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad JSON: ${data}`)); }
      });
    }).on('error', reject);
  });
}

function httpGetRaw(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function httpPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request(`http://localhost:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad JSON: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.end(json);
  });
}

function spawnAndCollect(args, timeoutMs = 10000, envOverrides = {}) {
  return new Promise(resolve => {
    const child = spawnServer(args, { env: envOverrides });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      const { stdout, stderr } = child.getOutput();
      resolve({ stdout, stderr, code });
    };
    child.on('exit', (code) => finish(code));
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(null);
    }, timeoutMs);
  });
}
