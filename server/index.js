#!/usr/bin/env node
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('./config');
const store = require('./store');
const helpers = require('./helpers');
const { fetchPricing, calculateCost } = require('./pricing');
const { restoreFromLogs, pruneLogs } = require('./restore');
const { warmUp: warmUpCosts } = require('./cost-budget');
const {
  forwardRequest,
  setStatusLineEnabled,
  getStatusLineEnabled,
  collectOpenAIStreamText,
  extractOpenAICompletedResponse,
  extractOpenAIStreamUsage,
} = require('./forward');
const { readSettings } = require('./settings');
const { broadcastSessionStatus, broadcastPendingRequest } = require('./sse-broadcast');
const { authMiddleware } = require('./auth');
const { extractAgentType, splitB2IntoBlocks } = require('./system-prompt');
const { findSharedPrefix } = require('./delta-helpers');
const providers = require('./providers');

// ── CLI: parse flags and detect provider launchers ──
const portIdx = process.argv.indexOf('--port');
let explicitPort = false;
if (portIdx !== -1) {
  const portVal = process.argv[portIdx + 1];
  const parsed = parseInt(portVal, 10);
  if (!portVal || isNaN(parsed) || parsed < 1 || parsed > 65535) {
    console.error('\x1b[31mError: --port requires a valid port number (1-65535)\x1b[0m');
    process.exit(1);
  }
  config.PORT = parsed;
  explicitPort = true;
  process.argv.splice(portIdx, 2);
}
const hubMode = process.argv.includes('--hub-mode');
if (hubMode) process.argv.splice(process.argv.indexOf('--hub-mode'), 1);
const noBrowser = process.argv.includes('--no-browser');
if (noBrowser) process.argv.splice(process.argv.indexOf('--no-browser'), 1);
const cliCommand = process.argv[2];
const unknownCommand = cliCommand
  && cliCommand !== 'status'
  && !cliCommand.startsWith('-')
  && !providers.isAgentProvider(cliCommand);
if (unknownCommand) {
  console.error(`\x1b[31mError: unsupported provider "${cliCommand}". Supported providers: ${providers.supportedProviderList()}\x1b[0m`);
  process.exit(1);
}
const agentCommand = providers.isAgentProvider(cliCommand) ? cliCommand : null;
const agentMode = Boolean(agentCommand);
const agentArgs = agentMode ? process.argv.slice(3) : [];
const DISPLAY_NAME = providers.getDisplayName(agentCommand, process.env);

// In agent/hub mode, mute startup logs so they don't pollute output.
const _origLog = console.log;
if (agentMode || hubMode) console.log = () => {};

// ── Delta log storage ────────────────────────────────────────────────
// sessionLastReq tracks the most recent req per session for delta writes.
// Only populated for sessions with explicit session_id (main orchestrator turns).
const sessionLastReq = new Map(); // sessionId → { id, messages, deltaCount }

// Route handlers
const { handleSSERoute } = require('./routes/sse');
const { handleApiRoutes } = require('./routes/api');
const { handleInterceptRoutes } = require('./routes/intercept');
const { handleCostRoutes } = require('./routes/costs');
const hub = require('./hub');

// ── Web UI: Static files from public/ ────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

// Load persisted settings and apply immediately
const settings = readSettings();
setStatusLineEnabled(settings.statusLine);

// index.html with config injection — built fresh per request so dynamic values (statusLine) stay current
let rawIndexHTML = '';
try { rawIndexHTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'); } catch {}
let serverPort = 0;

function rebuildIndexHTML(port) { serverPort = port; }

function serveStatic(url, clientRes) {
  const pathname = url.split('?')[0];
  if (pathname === '/' || pathname === '/index.html') {
    const script = `<script>window.__PROXY_CONFIG__=${JSON.stringify({ DEFAULT_CONTEXT: config.DEFAULT_CONTEXT, PORT: serverPort, statusLine: getStatusLineEnabled(), APP_NAME: DISPLAY_NAME })}</script>`;
    const html = rawIndexHTML ? rawIndexHTML.replace('<!--__PROXY_CONFIG__-->', script) : '<html><body>Error loading dashboard</body></html>';
    clientRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    clientRes.end(html);
    return true;
  }
  const ext = path.extname(pathname);
  const mime = MIME_TYPES[ext];
  if (!mime) return false;
  const filePath = path.join(PUBLIC_DIR, pathname);
  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  try {
    const content = fs.readFileSync(filePath);
    clientRes.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
    clientRes.end(content);
    return true;
  } catch {
    return false;
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function buildForwardHeaders(clientHeaders, upstream) {
  const fwdHeaders = { ...clientHeaders };
  const connectionTokens = String(clientHeaders.connection || '')
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);

  for (const header of HOP_BY_HOP_HEADERS) delete fwdHeaders[header];
  for (const header of connectionTokens) delete fwdHeaders[header];
  delete fwdHeaders['host'];
  delete fwdHeaders['accept-encoding'];
  fwdHeaders['host'] = upstream.host;
  return fwdHeaders;
}

const WS_CLIENT_HEADERS = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function buildWebSocketForwardHeaders(clientHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(clientHeaders || {})) {
    if (WS_CLIENT_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

function isLoopbackRemoteAddress(address) {
  return new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']).has(address);
}

function isValidTcpPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parseConnectTarget(target) {
  const raw = String(target || '').trim();
  const ipv6 = raw.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) {
    const port = parseInt(ipv6[2], 10);
    if (!isValidTcpPort(port)) return null;
    return { host: ipv6[1], port };
  }

  const idx = raw.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = raw.slice(0, idx);
  const port = parseInt(raw.slice(idx + 1), 10);
  if (!host || !isValidTcpPort(port)) return null;
  return { host, port };
}

function closeConnectSocket(socket, status, message) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
}

function sanitizeConnectHeaders(headers) {
  const clean = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === 'proxy-authorization') continue;
    clean[key] = value;
  }
  return clean;
}

function recordConnectTunnelEntry({ clientReq, target, status, statusText, startTime, errorMessage }) {
  const id = helpers.timestamp();
  const ts = helpers.taipeiTime();
  const cwd = hub.lookupClientCwd() || process.cwd();
  const sessionKey = cwd || 'standard-proxy';
  const sessionId = `gemini-${crypto.createHash('sha1').update(sessionKey).digest('hex').slice(0, 12)}`;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const title = `CONNECT ${target.host}:${target.port}`;
  const reqLog = {
    method: 'CONNECT',
    target: `${target.host}:${target.port}`,
    headers: sanitizeConnectHeaders(clientReq.headers),
  };
  const resLog = {
    status,
    statusText,
    encrypted: true,
    note: 'TLS payload is tunneled and not captured.',
    ...(errorMessage ? { error: errorMessage } : {}),
  };
  if (!store.sessionMeta[sessionId]) store.sessionMeta[sessionId] = {};
  store.sessionMeta[sessionId].provider = 'google';
  store.sessionMeta[sessionId].cwd = cwd || null;
  store.sessionMeta[sessionId].lastSeenAt = Date.now();

  const entry = {
    id, ts, sessionId, method: 'CONNECT', url: `${target.host}:${target.port}`,
    provider: 'google',
    agent: 'gemini',
    req: reqLog, res: resLog,
    elapsed, status, isSSE: false,
    tokens: null,
    usage: null, cost: null,
    responseMetadata: { provider: 'google', tunnel: true, encrypted: true },
    maxContext: null,
    cwd: cwd || null,
    receivedAt: startTime,
    thinkingDuration: null,
    duplicateToolCalls: null,
    model: null,
    msgCount: 0,
    toolCount: 0,
    toolCalls: {},
    isSubagent: false,
    sessionInferred: false,
    title,
    stopReason: status >= 200 && status < 300 ? 'tunnel_established' : 'tunnel_failed',
    toolFail: status < 200 || status >= 300,
    sysHash: null,
    toolsHash: null,
    coreHash: null,
    thinkingStripped: undefined,
    toolSources: {},
  };

  const reqWritePromise = config.storage.write(id, '_req.json', JSON.stringify(reqLog))
    .catch(e => console.error('Write CONNECT req.json failed:', e.message));
  const resWritePromise = config.storage.write(id, '_res.json', JSON.stringify(resLog))
    .catch(e => console.error('Write CONNECT res.json failed:', e.message));
  entry._writePromise = Promise.all([reqWritePromise, resWritePromise]);
  store.entries.push(entry);
  store.trimEntries();
  const { broadcast } = require('./sse-broadcast');
  broadcast(entry);

  const indexLine = JSON.stringify({
    id, ts, sessionId,
    method: entry.method,
    url: entry.url,
    provider: entry.provider,
    agent: entry.agent,
    model: entry.model, msgCount: entry.msgCount, toolCount: entry.toolCount,
    toolCalls: entry.toolCalls, isSubagent: entry.isSubagent, sessionInferred: entry.sessionInferred,
    cwd: entry.cwd, isSSE: false,
    usage: null, cost: null, maxContext: null,
    responseMetadata: entry.responseMetadata,
    stopReason: entry.stopReason, title, thinkingDuration: null,
    toolFail: entry.toolFail,
    elapsed, status,
    receivedAt: startTime,
    sysHash: null, toolsHash: null,
    coreHash: null,
    toolSources: entry.toolSources,
  });
  config.storage.appendIndex(indexLine + '\n').catch(e => console.error('Write CONNECT index failed:', e.message));
  entry.req = null;
  entry.res = null;
  entry._loaded = false;
}

function summarizeText(value, maxLen = 240) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return compact.slice(0, maxLen - 3) + '...';
}

function getOpenAIInputType(input) {
  if (Array.isArray(input)) return 'array';
  if (input == null) return null;
  return typeof input;
}

function parseCodexTurnMetadata(headers) {
  const raw = headers?.['x-codex-turn-metadata'];
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function cwdFromCodexTurnMetadata(meta) {
  const workspaces = meta?.workspaces;
  if (!workspaces || typeof workspaces !== 'object') return null;
  const first = Object.keys(workspaces)[0];
  return first || null;
}

function withCodexMetadata(parsedBody, headers) {
  if (!parsedBody || typeof parsedBody !== 'object') return parsedBody;
  const meta = parseCodexTurnMetadata(headers);
  const sessionId = headers?.session_id || meta?.session_id || null;
  const cwd = cwdFromCodexTurnMetadata(meta);
  if (!sessionId && !cwd) return parsedBody;
  const metadata = parsedBody.metadata && typeof parsedBody.metadata === 'object'
    ? { ...parsedBody.metadata }
    : {};
  if (sessionId && !metadata.session_id) metadata.session_id = sessionId;
  if (cwd && !metadata.cwd) metadata.cwd = cwd;
  return { ...parsedBody, metadata };
}

function summarizeCodexInputTitle(input) {
  if (typeof input === 'string') return summarizeText(input, 80);
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] || {};
    if (item.role && item.role !== 'user') continue;
    const content = item.content;
    if (typeof content === 'string') return summarizeText(content, 80);
    if (!Array.isArray(content)) continue;
    const text = content
      .map(part => part?.text || part?.content || '')
      .filter(Boolean)
      .join(' ')
      .trim();
    if (text) return summarizeText(text, 80);
  }
  return null;
}

function buildStrippedRequestLog({ parsedBody, rawBody, clientReq, upstream, id, sysHash, toolsHash, instructionsHash, inputHash }) {
  if (upstream.provider === 'openai') {
    return {
      provider: 'openai',
      agent: 'codex',
      method: clientReq.method,
      path: clientReq.url,
      upstream: {
        provider: upstream.provider,
        source: upstream.source,
        basePath: upstream.basePath || '',
      },
      model: parsedBody.model || null,
      instructions: {
        summary: summarizeText(parsedBody.instructions),
        length: typeof parsedBody.instructions === 'string' ? parsedBody.instructions.length : null,
        hash: instructionsHash,
      },
      input: {
        type: getOpenAIInputType(parsedBody.input),
        summary: summarizeText(parsedBody.input),
        hash: inputHash,
      },
      toolsHash,
      toolCount: Array.isArray(parsedBody.tools) ? parsedBody.tools.length : 0,
      rawRequest: {
        id,
        sha256: crypto.createHash('sha256').update(rawBody).digest('hex'),
        bytes: rawBody.length,
      },
    };
  }

  return {
    model: parsedBody.model,
    max_tokens: parsedBody.max_tokens,
    messages: parsedBody.messages,
    sysHash,
    toolsHash,
  };
}

function buildOpenAIWebSocketResponseMetadata(completedResponse, statusCode) {
  const metadata = {
    provider: 'openai',
    id: completedResponse?.id || null,
    object: completedResponse?.object || null,
    model: completedResponse?.model || null,
    status: statusCode,
    streaming: true,
    websocket: true,
  };
  if (completedResponse?.status) metadata.responseStatus = completedResponse.status;
  if (Array.isArray(completedResponse?.output)) metadata.outputItems = completedResponse.output;
  return metadata;
}

function createOpenAIWebSocketEntry(ctx, statusCode) {
  const { id, ts, startTime, parsedBody, reqSessionId, events } = ctx;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const completedResponse = extractOpenAICompletedResponse(events);
  const responseUsage = extractOpenAIStreamUsage(events);
  const responseModel = completedResponse?.model || parsedBody?.model || null;
  const costInfo = responseUsage ? calculateCost(responseUsage, responseModel) : null;
  const responseMetadata = buildOpenAIWebSocketResponseMetadata(completedResponse || {}, statusCode);
  const sessionId = reqSessionId;
  const maxContext = config.getMaxContext(parsedBody?.model, parsedBody?.system);
  const title = collectOpenAIStreamText(events).trim().replace(/\s+/g, ' ').slice(0, 80)
    || summarizeCodexInputTitle(parsedBody?.input)
    || null;
  const stopReason = completedResponse?.status || '';
  const currMsgCount = Array.isArray(parsedBody?.input) ? parsedBody.input.length : 0;
  const entry = {
    id, ts, sessionId, method: 'WS', url: ctx.url,
    provider: 'openai',
    agent: 'codex',
    req: parsedBody, res: events,
    elapsed, status: statusCode, isSSE: true,
    tokens: helpers.tokenizeRequest(parsedBody),
    usage: responseUsage, cost: costInfo,
    responseMetadata,
    maxContext,
    cwd: store.sessionMeta[sessionId]?.cwd || null,
    receivedAt: startTime,
    thinkingDuration: null,
    duplicateToolCalls: null,
    model: responseModel,
    msgCount: currMsgCount,
    toolCount: Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
    toolCalls: {},
    isSubagent: false,
    sessionInferred: ctx.sessionInferred || false,
    title,
    stopReason,
    toolFail: false,
    sysHash: null,
    toolsHash: ctx.toolsHash || null,
    coreHash: null,
    thinkingStripped: undefined,
  };
  entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
  entry.toolSources = helpers.buildToolSources(entry) || undefined;

  const resWritePromise = config.storage.write(id, '_res.json', JSON.stringify(events))
    .catch(e => console.error('Write res.json failed:', e.message));
  entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
  store.entries.push(entry);
  store.trimEntries();
  const { broadcast } = require('./sse-broadcast');
  broadcast(entry);

  const indexLine = JSON.stringify({
    id, ts, sessionId,
    method: entry.method,
    url: entry.url,
    provider: entry.provider,
    agent: entry.agent,
    model: entry.model, msgCount: entry.msgCount, toolCount: entry.toolCount,
    toolCalls: entry.toolCalls, isSubagent: entry.isSubagent, sessionInferred: entry.sessionInferred,
    cwd: entry.cwd, isSSE: true,
    usage: entry.usage, cost: costInfo, maxContext,
    responseMetadata,
    stopReason, title, thinkingDuration: null,
    toolFail: entry.toolFail,
    elapsed, status: statusCode,
    receivedAt: startTime,
    sysHash: null, toolsHash: ctx.toolsHash || null,
    coreHash: null,
    hasCredential: entry.hasCredential,
    toolSources: entry.toolSources,
  });
  config.storage.appendIndex(indexLine + '\n').catch(e => console.error('Write index failed:', e.message));
  entry.req = null;
  entry.res = null;
  entry._loaded = false;

  if (costInfo?.cost != null && sessionId) {
    store.sessionCosts.set(sessionId, (store.sessionCosts.get(sessionId) || 0) + costInfo.cost);
  }
}

function handleOpenAIWebSocketUpgrade(clientReq, socket, head, upstream) {
  const ts = helpers.taipeiTime();
  const id = helpers.timestamp();
  const startTime = Date.now();
  const wss = new WebSocket.WebSocketServer({ noServer: true });

  wss.handleUpgrade(clientReq, socket, head, (clientWs) => {
    const upstreamPath = config.joinUpstreamPath(upstream, clientReq.url);
    const wsProtocol = upstream.protocol === 'http' ? 'ws' : 'wss';
    const portPart = (upstream.protocol === 'https' && upstream.port === 443) || (upstream.protocol === 'http' && upstream.port === 80)
      ? ''
      : `:${upstream.port}`;
    const upstreamUrl = `${wsProtocol}://${upstream.host}${portPart}${upstreamPath}`;
    const upstreamWs = new WebSocket(upstreamUrl, {
      headers: buildWebSocketForwardHeaders(clientReq.headers),
    });

    let upstreamOpen = false;
    const pendingClientMessages = [];
    const events = [];
    const turnMeta = parseCodexTurnMetadata(clientReq.headers);
    const cwdFallback = cwdFromCodexTurnMetadata(turnMeta) || hub.lookupClientCwd();
    const ctx = {
      id, ts, startTime,
      url: clientReq.url,
      parsedBody: null,
      reqSessionId: null,
      sessionInferred: false,
      toolsHash: null,
      reqWritePromise: null,
      events,
    };

    const captureClientMessage = (data, isBinary) => {
      if (isBinary || ctx.parsedBody) return;
      let parsedBody = null;
      const rawBody = Buffer.isBuffer(data) ? data : Buffer.from(data);
      try { parsedBody = JSON.parse(rawBody.toString('utf8')); } catch {}
      if (!parsedBody || parsedBody.type !== 'response.create') return;

      parsedBody = withCodexMetadata(parsedBody, clientReq.headers);
      ctx.parsedBody = parsedBody;
      const hashJson = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
      const instructionsHash = parsedBody.instructions != null ? hashJson(parsedBody.instructions) : null;
      const inputHash = parsedBody.input != null ? hashJson(parsedBody.input) : null;
      const toolsHash = parsedBody.tools ? hashJson(parsedBody.tools) : null;
      ctx.toolsHash = toolsHash;

      if (instructionsHash) config.storage.writeSharedIfAbsent(`openai_instructions_${instructionsHash}.json`, JSON.stringify(parsedBody.instructions))
        .catch(e => console.error('Write OpenAI instructions failed:', e.message));
      if (inputHash) config.storage.writeSharedIfAbsent(`openai_input_${inputHash}.json`, JSON.stringify(parsedBody.input))
        .catch(e => console.error('Write OpenAI input failed:', e.message));
      if (toolsHash) config.storage.writeSharedIfAbsent(`openai_tools_${toolsHash}.json`, JSON.stringify(parsedBody.tools))
        .catch(e => console.error('Write OpenAI tools failed:', e.message));

      const reqLog = buildStrippedRequestLog({
        parsedBody,
        rawBody,
        clientReq: { method: 'WS', url: clientReq.url },
        upstream,
        id,
        sysHash: null,
        toolsHash,
        instructionsHash,
        inputHash,
      });
      ctx.reqWritePromise = config.storage.write(id, '_req.json', JSON.stringify(reqLog))
        .catch(e => console.error('Write req.json failed:', e.message));

      const detected = store.detectSession(parsedBody, { provider: 'openai', cwdFallback });
      ctx.reqSessionId = detected.sessionId;
      ctx.sessionInferred = detected.inferred || false;
      if (ctx.reqSessionId) {
        if (!store.sessionMeta[ctx.reqSessionId]) store.sessionMeta[ctx.reqSessionId] = {};
        store.sessionMeta[ctx.reqSessionId].provider = 'openai';
        store.sessionMeta[ctx.reqSessionId].cwd = store.extractCwdForProvider(parsedBody, 'openai') || cwdFallback || null;
        store.sessionMeta[ctx.reqSessionId].lastSeenAt = Date.now();
        store.activeRequests[ctx.reqSessionId] = (store.activeRequests[ctx.reqSessionId] || 0) + 1;
        broadcastSessionStatus(ctx.reqSessionId);
      }
      if (detected.isNewSession) store.printSessionBanner(ctx.reqSessionId);

      helpers.printSeparator();
      console.log(`\x1b[36m📤 [${ts}]  [codex ws]  WS ${clientReq.url}\x1b[0m`);
      console.log(helpers.summarizeRequest(parsedBody));
    };

    const captureUpstreamMessage = (data, isBinary) => {
      if (isBinary) return;
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      let event = null;
      try { event = JSON.parse(text); } catch {}
      if (!event || typeof event !== 'object') return;
      events.push({ event: event.type || null, type: event.type || null, data: event, _ts: Date.now() });
    };

    upstreamWs.on('open', () => {
      upstreamOpen = true;
      for (const item of pendingClientMessages) upstreamWs.send(item.data, { binary: item.isBinary });
      pendingClientMessages.length = 0;
    });

    clientWs.on('message', (data, isBinary) => {
      captureClientMessage(data, isBinary);
      if (upstreamOpen) upstreamWs.send(data, { binary: isBinary });
      else pendingClientMessages.push({ data, isBinary });
    });

    upstreamWs.on('message', (data, isBinary) => {
      captureUpstreamMessage(data, isBinary);
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
    });

    upstreamWs.on('error', (err) => {
      console.error(`\x1b[31m❌ OPENAI WS UPSTREAM ERROR: ${err.message}\x1b[0m`);
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream_error');
    });
    if (!process.versions.bun) {
      upstreamWs.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          const summary = body ? `: ${body.slice(0, 240)}` : '';
          console.error(`\x1b[31m❌ OPENAI WS UPSTREAM STATUS: ${res.statusCode} ${res.statusMessage}${summary}\x1b[0m`);
        });
      });
    }
    clientWs.on('error', () => {});

    const finish = () => {
      if (ctx._finished) return;
      ctx._finished = true;
      if (ctx.reqSessionId) {
        store.activeRequests[ctx.reqSessionId] = Math.max(0, (store.activeRequests[ctx.reqSessionId] || 1) - 1);
        broadcastSessionStatus(ctx.reqSessionId);
      }
      if (!ctx.parsedBody) return;
      createOpenAIWebSocketEntry(ctx, 101);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const usage = extractOpenAIStreamUsage(events);
      const completed = extractOpenAICompletedResponse(events);
      const outTok = usage?.output_tokens ? `  out=${usage.output_tokens.toLocaleString()} tok` : '';
      const status = completed?.status || 'closed';
      console.log(`\x1b[32m📥 [${helpers.taipeiTime()}]  [codex ws]  ✓ ${status}  ${elapsed}s${outTok}\x1b[0m`);
      helpers.printSeparator();
      console.log();
    };

    upstreamWs.on('close', (code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
      finish();
    });
    clientWs.on('close', (code, reason) => {
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close(code, reason);
      finish();
    });
  });
}

// ── Server ──────────────────────────────────────────────────────────
const server = http.createServer((clientReq, clientRes) => {

  // ── Hub API (health, register, unregister, status) ──
  // Placed before auth: these are local IPC endpoints, not user-facing
  if (hub.handleHubRoutes(clientReq, clientRes)) return;

  // ── Auth check (enabled via AUTH_TOKEN env var) ──
  if (!authMiddleware(clientReq, clientRes)) return;

  // ── Static files (HTML, CSS, JS) ──
  if (serveStatic(clientReq.url, clientRes)) return;

  // ── SSE ──
  if (handleSSERoute(clientReq, clientRes)) return;

  // ── API routes ──
  if (handleApiRoutes(clientReq, clientRes)) return;

  // ── Intercept API ──
  if (handleInterceptRoutes(clientReq, clientRes)) return;

  // ── Cost Budget API ──
  if (handleCostRoutes(clientReq, clientRes)) return;

  // ── Proxy logic ──
  const ts = helpers.taipeiTime();
  const id = helpers.timestamp();
  const startTime = Date.now();

  const reqChunks = [];
  clientReq.on('data', chunk => reqChunks.push(chunk));
  clientReq.on('end', () => {
    const rawBody = Buffer.concat(reqChunks);
    let parsedBody = null;
    try { parsedBody = JSON.parse(rawBody.toString()); } catch {}

    // Quota-check probes: forward to Anthropic (rate limit headers still captured)
    // but skip all logging, session tracking, and entry creation
    if (parsedBody && store.isQuotaCheck(parsedBody)) {
      const upstream = config.getUpstreamForRequestAndHeaders(clientReq.url, clientReq.headers);
      const fwdHeaders = buildForwardHeaders(clientReq.headers, upstream);
      forwardRequest({ id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId: null, reqWritePromise: null, skipEntry: true, upstream });
      return;
    }

    const upstream = config.getUpstreamForRequestAndHeaders(clientReq.url, clientReq.headers);
    const provider = upstream.provider || 'anthropic';
    const cwdFallback = provider === 'openai' ? hub.lookupClientCwd() : null;

    let reqWritePromise = null;
    let sysHash = null;
    let toolsHash = null;
    let instructionsHash = null;
    let inputHash = null;
    if (parsedBody) {
      const hashJson = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
      sysHash = parsedBody.system ? hashJson(parsedBody.system) : null;
      toolsHash = parsedBody.tools ? hashJson(parsedBody.tools) : null;
      instructionsHash = provider === 'openai' && parsedBody.instructions != null ? hashJson(parsedBody.instructions) : null;
      inputHash = provider === 'openai' && parsedBody.input != null ? hashJson(parsedBody.input) : null;

      if (provider === 'openai') {
        if (instructionsHash) config.storage.writeSharedIfAbsent(`openai_instructions_${instructionsHash}.json`, JSON.stringify(parsedBody.instructions))
          .catch(e => console.error('Write OpenAI instructions failed:', e.message));
        if (inputHash) config.storage.writeSharedIfAbsent(`openai_input_${inputHash}.json`, JSON.stringify(parsedBody.input))
          .catch(e => console.error('Write OpenAI input failed:', e.message));
        if (toolsHash) config.storage.writeSharedIfAbsent(`openai_tools_${toolsHash}.json`, JSON.stringify(parsedBody.tools))
          .catch(e => console.error('Write OpenAI tools failed:', e.message));
      } else {
        if (sysHash) config.storage.writeSharedIfAbsent(`sys_${sysHash}.json`, JSON.stringify(parsedBody.system))
          .catch(e => console.error('Write sys failed:', e.message));
        if (toolsHash) config.storage.writeSharedIfAbsent(`tools_${toolsHash}.json`, JSON.stringify(parsedBody.tools))
          .catch(e => console.error('Write tools failed:', e.message));
      }

      const currMessages = Array.isArray(parsedBody.messages) ? parsedBody.messages : [];
      const peekSid = store.extractSessionId(parsedBody);
      let stripped;

      if (upstream.provider === 'openai') {
        stripped = buildStrippedRequestLog({ parsedBody, rawBody, clientReq, upstream, id, sysHash, toolsHash, instructionsHash, inputHash });
      } else if (peekSid && config.storage.supportsDelta) {
        const prev = sessionLastReq.get(peekSid);
        const sharedCount = prev ? findSharedPrefix(prev.messages, currMessages) : 0;
        const forceFull = !prev ||
          (config.DELTA_SNAPSHOT_N > 0 && (prev.deltaCount || 0) >= config.DELTA_SNAPSHOT_N);

        if (!forceFull && sharedCount >= 2) {
          stripped = {
            model: parsedBody.model,
            max_tokens: parsedBody.max_tokens,
            prevId: prev.id,
            msgOffset: sharedCount,
            messages: currMessages.slice(sharedCount),
            sysHash,
            toolsHash,
          };
          sessionLastReq.set(peekSid, { id, messages: currMessages, deltaCount: (prev.deltaCount || 0) + 1 });
        } else {
          stripped = { model: parsedBody.model, max_tokens: parsedBody.max_tokens, messages: currMessages, sysHash, toolsHash };
          sessionLastReq.set(peekSid, { id, messages: currMessages, deltaCount: 0 });
        }
      } else {
        stripped = { model: parsedBody.model, max_tokens: parsedBody.max_tokens, messages: currMessages, sysHash, toolsHash };
      }

      reqWritePromise = config.storage.write(id, '_req.json', JSON.stringify(stripped))
        .catch(e => console.error('Write req.json failed:', e.message));
    }

    const { sessionId: reqSessionId, isNewSession, inferred: sessionInferred } = parsedBody
      ? store.detectSession(parsedBody, { provider, cwdFallback })
      : { sessionId: store.getCurrentSessionId(), isNewSession: false };

    // Extract and store cwd
    if (parsedBody && reqSessionId) {
      const cwd = store.extractCwdForProvider(parsedBody, provider) || cwdFallback;
      if (cwd) {
        if (!store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId] = {};
        store.sessionMeta[reqSessionId].provider = provider;
        store.sessionMeta[reqSessionId].cwd = cwd;
      }
    }

    // Detect new cc_version for live requests; compute coreHash for all qualifying requests
    let coreHash = null;
    if (parsedBody && Array.isArray(parsedBody.system) && parsedBody.system.length >= 3) {
      const b0 = (parsedBody.system[0].text || '');
      const b2 = (parsedBody.system[2].text || '');
      const liveM = b0.match(/cc_version=(\S+?)[; ]/);
      const liveVer = liveM ? liveM[1] : null;
      const { key: agentKey, label: agentLabel } = extractAgentType(parsedBody.system);
      if (b2.length >= 500) {
        const coreText = splitB2IntoBlocks(b2).coreInstructions || '';
        coreHash = crypto.createHash('md5').update(coreText).digest('hex').slice(0, 12);
        if (liveVer) {
          const coreLen = coreText.length;
          const idxKey = `${agentKey}::${coreHash}`;
          const existing = store.versionIndex.get(idxKey);
          if (existing) {
            // Same coreInstructions, just update to latest cc_version and shared file
            existing.version = liveVer;
            if (sysHash) existing.sharedFile = `sys_${sysHash}.json`;
          } else {
            const now = new Date().toISOString().slice(0, 10);
            const sharedFile = sysHash ? `sys_${sysHash}.json` : null;
            store.versionIndex.set(idxKey, { reqId: null, sharedFile, b2Len: b2.length, coreLen, coreHash, firstSeen: now, agentKey, agentLabel, version: liveVer });
            // Notify dashboard of new unique version
            const vData = JSON.stringify({ _type: 'version_detected', version: liveVer, b2Len: b2.length, agentKey, agentLabel });
            for (const res of store.sseClients) res.write(`data: ${vData}\n\n`);
          }
        }
      }
    }

    // Track active requests
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = (store.activeRequests[reqSessionId] || 0) + 1;
      if (!store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId] = {};
      store.sessionMeta[reqSessionId].provider = provider;
      store.sessionMeta[reqSessionId].lastSeenAt = Date.now();
      broadcastSessionStatus(reqSessionId);
    }

    // Session banner only here. REQUEST line + per-session counter +
    // attribution prefix are emitted from forwardRequest() at forward time
    // so intercepted-then-rejected requests do not advance the counter.
    if (isNewSession) store.printSessionBanner(reqSessionId);

    // Build context for forwarding
    const fwdHeaders = buildForwardHeaders(clientReq.headers, upstream);

    const ctx = { id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId, reqWritePromise, sysHash, toolsHash, instructionsHash, inputHash, coreHash, sessionInferred, upstream };

    // ── Intercept check ──
    const lastStop = store.sessionMeta[reqSessionId]?.lastStopReason;
    if (reqSessionId && store.interceptSessions.has(reqSessionId) && lastStop !== 'tool_use') {
      ctx.timer = setTimeout(() => {
        const p = store.pendingRequests.get(id);
        if (p) {
          store.pendingRequests.delete(id);
          const { broadcastInterceptRemoved } = require('./sse-broadcast');
          broadcastInterceptRemoved(id);
          console.log(`\x1b[33m⏰ INTERCEPT TIMEOUT [${helpers.taipeiTime()}] auto-forwarding ${id}\x1b[0m`);
          forwardRequest(p);
        }
      }, store.getInterceptTimeout() * 1000);
      ctx.originalBody = JSON.parse(JSON.stringify(parsedBody));
      store.pendingRequests.set(id, ctx);
      console.log(`\x1b[33m⏸ INTERCEPTED [${helpers.taipeiTime()}] ${id} — waiting for dashboard approval\x1b[0m`);
      broadcastPendingRequest(id, parsedBody, reqSessionId);
      return;
    }

    forwardRequest(ctx);
  });
});

server.on('connect', (clientReq, clientSocket, head) => {
  const startTime = Date.now();
  if (!isLoopbackRemoteAddress(clientSocket.remoteAddress)) {
    closeConnectSocket(clientSocket, 403, 'Forbidden');
    return;
  }

  const target = parseConnectTarget(clientReq.url);
  if (!target) {
    closeConnectSocket(clientSocket, 400, 'Bad Request');
    return;
  }

  let connected = false;
  const upstreamSocket = net.connect(target.port, target.host, () => {
    connected = true;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    recordConnectTunnelEntry({ clientReq, target, status: 200, statusText: 'Connection Established', startTime });
    if (head && head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', (err) => {
    if (!connected) {
      recordConnectTunnelEntry({ clientReq, target, status: 502, statusText: 'Bad Gateway', startTime, errorMessage: err.message });
      closeConnectSocket(clientSocket, 502, 'Bad Gateway');
    } else clientSocket.destroy();
  });
  clientSocket.on('error', () => upstreamSocket.destroy());
});

server.on('upgrade', (clientReq, socket, head) => {
  const upstream = config.getUpstreamForRequestAndHeaders(clientReq.url, clientReq.headers);
  if (upstream.provider !== 'openai') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  handleOpenAIWebSocketUpgrade(clientReq, socket, head, upstream);
});


// ── Spawn agent CLI with proxy routing ──
function spawnAgent(command, port, args, onExit) {
  const { spawn } = require('child_process');
  const launch = providers.getAgentLaunch(command, port, args);
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    onExit(code);
  };
  if (!launch) {
    console.error(`\x1b[31mError: unsupported provider "${command}". Supported providers: ${providers.supportedProviderList()}\x1b[0m`);
    finish(1);
    return;
  }
  const child = spawn(launch.bin, launch.args, {
    stdio: 'inherit',
    env: launch.env,
  });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(`\x1b[31mError: "${launch.bin}" command not found. Install ${launch.label} first:\x1b[0m`);
      console.error(`\x1b[31m${launch.installHint}\x1b[0m`);
    } else {
      console.error(`\x1b[31mFailed to start ${launch.bin}: ${err.message}\x1b[0m`);
    }
    finish(1);
  });
  child.on('exit', (code, signal) => {
    finish(code ?? (signal === 'SIGINT' ? 130 : 1));
  });
  // SIGINT is already sent to the child by the terminal (same process group).
  // Just prevent Node's default exit so we wait for the child exit event.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

function spawnStandaloneAgent(port, command, args) {
  spawnAgent(command, port, args, (code) => {
    server.close();
    process.exit(code);
  });
}

// ── "status" subcommand ──
if (process.argv[2] === 'status') {
  const lock = hub.readHubLock();
  if (!lock) {
    console.log('No hub running.');
    process.exit(0);
  }
  if (!hub.isPidAlive(lock.pid)) {
    console.log('Hub lockfile exists but process is dead. Cleaning up.');
    hub.deleteHubLock();
    process.exit(1);
  }
  hub.checkHubHealth(lock.port).then(ok => {
    if (!ok) {
      console.log(`Hub pid ${lock.pid} alive but not responding on port ${lock.port}.`);
      console.log(`Check ${hub.HUB_LOG_PATH}`);
      process.exit(1);
    }
    const http = require('http');
    http.get(`http://localhost:${lock.port}/_api/hub/status`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const s = JSON.parse(data);
          console.log(`Hub: http://localhost:${s.port} (pid ${s.pid}, uptime ${s.uptime}s, v${s.version})`);
          if (s.clients.length === 0) {
            console.log('No connected clients.');
          } else {
            console.log(`Connected clients (${s.clients.length}):`);
            s.clients.forEach((c, i) => {
              console.log(`  [${i + 1}] pid ${c.pid} — ${c.cwd} (since ${c.connectedAt})`);
            });
          }
        } catch { console.log(data); }
        process.exit(0);
      });
    }).on('error', err => {
      console.error(`Failed to query hub: ${err.message}`);
      process.exit(1);
    });
  });
  return; // prevent falling through to startup
}

// ── Client mode: connect to existing hub ──
async function startClientMode(lock) {
  const compat = hub.checkVersionCompat(lock.version);
  if (compat.fatal) {
    console.error(`\x1b[31m${compat.message}\x1b[0m`);
    process.exit(1);
  }
  if (compat.warning) {
    _origLog(`\x1b[33m${compat.warning}\x1b[0m`);
  }

  {
    const upstreamSuffix = config.ANTHROPIC_BASE_URL_SOURCE === 'ANTHROPIC_BASE_URL'
      ? `  →  ${config.ANTHROPIC_PROTOCOL}://${config.ANTHROPIC_HOST}:${config.ANTHROPIC_PORT} (from ANTHROPIC_BASE_URL)`
      : '';
    _origLog(`\x1b[90m${DISPLAY_NAME} → http://localhost:${lock.port} (hub)${upstreamSuffix}\x1b[0m`);
  }

  try {
    const reg = await hub.registerClient(lock.port, process.pid, process.cwd());
    if (!reg) {
      console.error('\x1b[31mHub rejected client registration.\x1b[0m');
      process.exit(1);
    }

    // Auto-open browser for the first client connecting to this hub
    if (reg.firstClient) {
      const noOpen = noBrowser
        || process.env.BROWSER === 'none'
        || process.env.CI
        || process.env.SSH_TTY;
      if (!noOpen) {
        const { exec } = require('child_process');
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${cmd} http://localhost:${lock.port}`);
      }
    }
  } catch (err) {
    console.error(`\x1b[31mFailed to register with hub: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  // Monitor hub health and auto-recover
  hub.startHubMonitor(lock.pid, lock.port, (newLock) => {
    // Re-register with new hub
    hub.registerClient(newLock.port, process.pid, process.cwd()).catch(() => {});
  });

  // Spawn agent pointing to hub
  spawnAgent(agentCommand, lock.port, agentArgs, (code) => {
    hub.unregisterClient(lock.port, process.pid).finally(() => {
      process.exit(code);
    });
  });
}

// ── Hub/Server startup ──
async function startServer() {
  await config.storage.init();
  await fetchPricing();
  await restoreFromLogs();
  await pruneLogs();
  warmUpCosts();

  // Agent mode (with --port, standalone): scan up to 10 ports.
  // Hub mode: fixed port, but retry if old hub is still releasing it (race with idle shutdown).
  // EADDRINUSE in hub mode usually means the previous hub process hasn't fully exited yet —
  // port release takes a few ms after process.exit(). Retry up to 5s before giving up.
  const maxAttempts = (agentMode && !hubMode) ? 10 : 0;
  let actualPort;
  if (hubMode) {
    const HUB_BIND_RETRIES = 5;
    const HUB_BIND_DELAY_MS = 1000;
    for (let i = 0; i <= HUB_BIND_RETRIES; i++) {
      try {
        actualPort = await hub.tryListen(server, config.PORT, 0);
        break;
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || i === HUB_BIND_RETRIES) {
          if (err.code === 'EADDRINUSE') {
            // Log the recovery hint to hub.log (console.error → stderr → hub.log).
            // Prefixed with "Error:" so the client's /error|EADDRINUSE/i filter picks it up.
            console.error(`Error: port ${config.PORT} still occupied after ${HUB_BIND_RETRIES}s — if a previous ccxray is stuck, run: kill $(lsof -t -i:${config.PORT})`);
          }
          throw err;
        }
        await new Promise(r => setTimeout(r, HUB_BIND_DELAY_MS));
      }
    }
  } else {
    actualPort = await hub.tryListen(server, config.PORT, maxAttempts);
  }
  rebuildIndexHTML(actualPort);

  // Hub mode only: write lockfile as readiness signal, start client lifecycle
  // Do NOT write lockfile in agent mode with --port (that's independent mode)
  if (hubMode) {
    hub.setHubPort(actualPort);
    hub.writeHubLock(actualPort, process.pid);
    hub.startDeadClientCheck();
    const cleanup = () => { hub.deleteHubLock(); process.exit(0); };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  }

  // Banner
  if (hubMode) {
    // Hub runs silently (logs go to hub.log)
  } else if (agentMode) {
    _origLog(`\x1b[90m${DISPLAY_NAME} → http://localhost:${actualPort}\x1b[0m`);
  } else {
    console.log();
    console.log(`\x1b[35m🔌 ${DISPLAY_NAME} proxy listening on http://localhost:${actualPort}\x1b[0m`);
    console.log(`\x1b[90m   Dashboard → http://localhost:${actualPort}/`);
    const upstreamUrl = `${config.ANTHROPIC_PROTOCOL}://${config.ANTHROPIC_HOST}:${config.ANTHROPIC_PORT}`;
    const upstreamNote = config.ANTHROPIC_BASE_URL_SOURCE === 'ANTHROPIC_BASE_URL' ? ' (from ANTHROPIC_BASE_URL)' : '';
    console.log(`   Upstream → ${upstreamUrl}${upstreamNote}`);
    const openaiUrl = `${config.OPENAI_PROTOCOL}://${config.OPENAI_HOST}:${config.OPENAI_PORT}${config.OPENAI_BASE_PATH}`;
    const openaiNote = config.OPENAI_BASE_URL_SOURCE === 'OPENAI_BASE_URL' ? ' (from OPENAI_BASE_URL)' : '';
    console.log(`   OpenAI Upstream → ${openaiUrl}${openaiNote}`);
    console.log(`   Logs → ${config.LOGS_DIR}`);
    console.log();
    console.log(`   Usage: ANTHROPIC_BASE_URL=http://localhost:${actualPort} claude\x1b[0m`);
    console.log('\x1b[0m');
  }

  // Auto-open dashboard in browser (not in hub mode)
  const noOpen = hubMode
    || noBrowser
    || process.env.BROWSER === 'none'
    || process.env.CI
    || process.env.SSH_TTY;
  if (!noOpen) {
    const { exec } = require('child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} http://localhost:${actualPort}`);
  }

  if (agentMode) spawnStandaloneAgent(actualPort, agentCommand, agentArgs);
}

// ── Main entry ──
(async () => {
  // Hub mode or explicit port or standalone: start server directly
  if (hubMode || explicitPort || !agentMode) {
    try {
      await startServer();
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.error(`\x1b[31mError: port ${config.PORT} is already in use\x1b[0m`);
      } else {
        console.error(`\x1b[31mStartup failed: ${err.message}\x1b[0m`);
      }
      process.exit(1);
    }
    return;
  }

  // Agent mode without explicit port: try hub discovery
  const existingHub = await hub.discoverHub(config.PORT);
  if (existingHub) {
    await startClientMode(existingHub);
    return;
  }

  // No hub found: acquire fork lock to prevent duplicate hub forks
  const acquired = hub.tryAcquireForkLock();
  if (acquired) {
    hub.forkHub(config.PORT, { displayName: DISPLAY_NAME });
  }
  try {
    const lock = await hub.waitForHubReady();
    if (acquired) hub.releaseForkLock();
    await startClientMode(lock);
  } catch (err) {
    if (acquired) hub.releaseForkLock();
    console.error(`\x1b[31m${err.message}\x1b[0m`);
    // Show last hub log lines so user doesn't have to open the file
    const fs = require('fs');
    try {
      const log = fs.readFileSync(hub.HUB_LOG_PATH, 'utf8');
      const lines = log.trim().split('\n');
      const lastErrors = lines.filter(l => /error|EADDRINUSE/i.test(l)).slice(-3);
      if (lastErrors.length) {
        console.error('\x1b[33mHub log:\x1b[0m');
        lastErrors.forEach(l => console.error(`  ${l.replace(/\x1b\[[0-9;]*m/g, '')}`));
      }
      if (lines.some(l => /EADDRINUSE|already in use/i.test(l))) {
        console.error(`\x1b[33mSuggestion: another process is using port ${config.PORT}. Use --port <other> or kill the process.\x1b[0m`);
      }
    } catch {}
    process.exit(1);
  }
})();
