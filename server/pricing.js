'use strict';

const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ── Pricing ─────────────────────────────────────────────────────────
const PRICING_CACHE_PATH = path.join(__dirname, '..', 'pricing-cache.json');
const PRICING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Hardcoded fallback (per 1M tokens, USD)
const DEFAULT_PRICING = {
  'claude-opus-4-6':   { input: 5,  output: 25, cache_create: 6.25,  cache_read: 0.50 },
  'claude-sonnet-4-6': { input: 3,  output: 15, cache_create: 3.75,  cache_read: 0.30 },
  'claude-opus-4-5':   { input: 5,  output: 25, cache_create: 6.25,  cache_read: 0.50 },
  'claude-opus-4-1':   { input: 5,  output: 25, cache_create: 6.25,  cache_read: 0.50 },
  'claude-opus-4':     { input: 15, output: 75, cache_create: 18.75, cache_read: 1.50 },
  'claude-sonnet-4':   { input: 3,  output: 15, cache_create: 3.75,  cache_read: 0.30 },
  'claude-haiku-4':    { input: 0.80, output: 4, cache_create: 1,    cache_read: 0.08 },
  'claude-3-5-sonnet': { input: 3,  output: 15, cache_create: 3.75,  cache_read: 0.30 },
  'claude-3-5-haiku':  { input: 0.80, output: 4, cache_create: 1,    cache_read: 0.08 },
  'claude-3-opus':     { input: 15, output: 75, cache_create: 18.75, cache_read: 1.50 },

  // OpenAI Responses / Codex fallback pricing (per 1M tokens, USD).
  // Responses input_tokens includes cached input; OpenAI usage is normalized
  // before cost calculation so cached input is charged at cache_read only.
  'gpt-5.2-codex':       { input: 1.75, output: 14,  cache_create: 0, cache_read: 0.175 },
  'gpt-5.1-codex-max':   { input: 1.25, output: 10,  cache_create: 0, cache_read: 0.125 },
  'gpt-5.1-codex-mini':  { input: 0.25, output: 2,   cache_create: 0, cache_read: 0.025 },
  'gpt-5.1-codex':       { input: 1.25, output: 10,  cache_create: 0, cache_read: 0.125 },
  'gpt-5-codex':         { input: 1.25, output: 10,  cache_create: 0, cache_read: 0.125 },
  'gpt-5.2-chat-latest': { input: 1.75, output: 14,  cache_create: 0, cache_read: 0.175 },
  'gpt-5.1-chat-latest': { input: 1.25, output: 10,  cache_create: 0, cache_read: 0.125 },
  'gpt-5-chat-latest':   { input: 1.25, output: 10,  cache_create: 0, cache_read: 0.125 },
  'gpt-5.2':             { input: 1.75, output: 14,  cache_create: 0, cache_read: 0.175 },
  'gpt-5.1':             { input: 1.25, output: 10,  cache_create: 0, cache_read: 0.125 },
  'gpt-5-mini':          { input: 0.25, output: 2,   cache_create: 0, cache_read: 0.025 },
  'gpt-5-nano':          { input: 0.05, output: 0.4, cache_create: 0, cache_read: 0.005 },
  'gpt-5':               { input: 1.25, output: 10,  cache_create: 0, cache_read: 0.125 },
  'gpt-4.1-mini':        { input: 0.40, output: 1.60, cache_create: 0, cache_read: 0.10 },
  'gpt-4.1-nano':        { input: 0.10, output: 0.40, cache_create: 0, cache_read: 0.025 },
  'gpt-4.1':             { input: 2,    output: 8,    cache_create: 0, cache_read: 0.50 },
  'gpt-4o-mini':         { input: 0.15, output: 0.60, cache_create: 0, cache_read: 0.075 },
  'gpt-4o':              { input: 2.50, output: 10,   cache_create: 0, cache_read: 1.25 },
};

let pricingTable = { ...DEFAULT_PRICING };
// Model → max_input_tokens from LiteLLM (populated by fetchPricing)
let contextTable = {};

async function fetchPricing() {
  // Check cache first
  try {
    const cached = JSON.parse(await fsp.readFile(PRICING_CACHE_PATH, 'utf8'));
    if (Date.now() - cached.fetchedAt < PRICING_TTL_MS) {
      pricingTable = { ...DEFAULT_PRICING, ...cached.pricing };
      if (cached.context) contextTable = cached.context;
      console.log(`\x1b[90m   Pricing loaded from cache (${new Date(cached.fetchedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })})\x1b[0m`);
      return;
    }
  } catch {}

  // Fetch from LiteLLM
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    const req = https.get(LITELLM_URL, (res) => {
      if (res.statusCode !== 200) {
        console.log(`\x1b[33m   ⚠ Pricing fetch failed (${res.statusCode}), using defaults\x1b[0m`);
        return done();
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const fetched = {};
          const fetchedCtx = {};
          for (const [key, val] of Object.entries(data)) {
            if (!/^(claude-|gpt-|o[0-9])/.test(key)) continue;
            if (val.input_cost_per_token) {
              fetched[key] = {
                input: (val.input_cost_per_token || 0) * 1_000_000,
                output: (val.output_cost_per_token || 0) * 1_000_000,
                cache_create: (val.cache_creation_input_token_cost || val.input_cost_per_token || 0) * 1_000_000,
                cache_read: (val.cache_read_input_token_cost || val.cache_read_cost_per_token || val.cached_input_cost_per_token || val.input_cost_per_token || 0) * 1_000_000,
              };
            }
            if (val.max_input_tokens) {
              fetchedCtx[key] = val.max_input_tokens;
            }
          }
          fsp.writeFile(PRICING_CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), pricing: fetched, context: fetchedCtx }, null, 2))
            .catch(e => console.error('Write pricing cache failed:', e.message));
          pricingTable = { ...DEFAULT_PRICING, ...fetched };
          contextTable = fetchedCtx;
          console.log(`\x1b[90m   Pricing fetched: ${Object.keys(fetched).length} models, ${Object.keys(fetchedCtx).length} context windows\x1b[0m`);
        } catch (e) {
          console.log(`\x1b[33m   ⚠ Pricing parse error, using defaults\x1b[0m`);
        }
        done();
      });
    }).on('error', () => {
      console.log(`\x1b[33m   ⚠ Pricing fetch error, using defaults\x1b[0m`);
      resolve();
    });
    req.setTimeout(5000, () => {
      req.destroy();
      console.log(`\x1b[33m   ⚠ Pricing fetch timeout, using defaults\x1b[0m`);
      resolve();
    });
  });
}

function getModelPricing(model) {
  if (!model) return null;
  if (pricingTable[model]) return pricingTable[model];
  const keys = Object.keys(pricingTable).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return pricingTable[key];
  }
  return null;
}

function calculateCost(usage, model) {
  if (!usage) return null;
  const rates = getModelPricing(model);
  if (!rates) return { cost: null, rates: null, warning: `Unknown model: ${model}` };
  const cost =
    ((usage.input_tokens || 0) / 1_000_000) * rates.input +
    ((usage.output_tokens || 0) / 1_000_000) * rates.output +
    ((usage.cache_creation_input_tokens || 0) / 1_000_000) * rates.cache_create +
    ((usage.cache_read_input_tokens || 0) / 1_000_000) * rates.cache_read;
  return { cost, rates };
}

function getModelContext(model) {
  if (!model) return null;
  if (contextTable[model]) return contextTable[model];
  const keys = Object.keys(contextTable).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return contextTable[key];
  }
  return null;
}

module.exports = {
  fetchPricing,
  getModelPricing,
  getModelContext,
  calculateCost,
  get pricingTable() { return pricingTable; },
};
