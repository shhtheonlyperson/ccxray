'use strict';

// Provider launchers are centralized here so startup and hub recovery stay
// provider-agnostic. Each CLI has its own routing contract for pointing at the
// ccxray proxy, so new launchers should be additive registry entries instead
// of new command-specific branches in server/index.js.

function mergeNoProxy(currentValue, additions) {
  const values = String(currentValue || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  for (const value of additions) {
    if (!values.some(existing => existing.toLowerCase() === value.toLowerCase())) {
      values.push(value);
    }
  }
  return values.join(',');
}

function withStandardProxyEnv(env, port) {
  const proxyUrl = `http://localhost:${port}`;
  const noProxy = mergeNoProxy(env.NO_PROXY || env.no_proxy, ['localhost', '127.0.0.1', '::1']);
  return {
    ...env,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

const AGENT_PROVIDERS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    displayName: 'ccxray',
    upstream: 'anthropic',
    installHint: '  npm install -g @anthropic-ai/claude-code',
    createLaunch({ port, args, env }) {
      return {
        bin: 'claude',
        args: [...args],
        env: { ...env, ANTHROPIC_BASE_URL: `http://localhost:${port}` },
      };
    },
  }),

  codex: Object.freeze({
    id: 'codex',
    label: 'Codex CLI',
    displayName: 'ccxray',
    upstream: 'openai',
    installHint: '  npm install -g @openai/codex',
    createLaunch({ port, args, env }) {
      return {
        bin: 'codex',
        args: ['-c', `openai_base_url="http://localhost:${port}/v1"`, ...args],
        env: { ...env },
      };
    },
  }),

  gemini: Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    displayName: 'ccxray',
    upstream: 'google',
    installHint: '  npm install -g @google/gemini-cli',
    createLaunch({ port, args, env }) {
      return {
        bin: 'gemini',
        args: [...args],
        env: withStandardProxyEnv(env, port),
      };
    },
  }),
});

function listAgentProviderIds() {
  return Object.keys(AGENT_PROVIDERS);
}

function getAgentProvider(id) {
  return AGENT_PROVIDERS[id] || null;
}

function isAgentProvider(id) {
  return Boolean(getAgentProvider(id));
}

function supportedProviderList() {
  return listAgentProviderIds().join(', ');
}

function getDisplayName(id, env = process.env) {
  if (env.CCXRAY_DISPLAY_NAME) return env.CCXRAY_DISPLAY_NAME;
  return getAgentProvider(id)?.displayName || 'ccxray';
}

function getAgentLaunch(id, port, args = [], env = process.env) {
  const provider = getAgentProvider(id);
  if (!provider) return null;
  const launch = provider.createLaunch({ port, args, env });
  return {
    provider: provider.id,
    label: provider.label,
    displayName: provider.displayName,
    upstream: provider.upstream,
    installHint: provider.installHint,
    ...launch,
  };
}

module.exports = {
  AGENT_PROVIDERS,
  getAgentLaunch,
  getAgentProvider,
  getDisplayName,
  isAgentProvider,
  listAgentProviderIds,
  mergeNoProxy,
  supportedProviderList,
  withStandardProxyEnv,
};
