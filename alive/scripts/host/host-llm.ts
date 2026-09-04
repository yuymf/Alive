// Reuse Hermes / OpenClaw credentials so heartbeat does not need a second LLM_API_KEY.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';

export interface HostLlmCreds {
  apiKey: string;
  apiBase?: string;
  model?: string;
  source: string;
}

interface CompatProvider {
  env: string[];
  base: string;
}

const OPENAI_COMPAT: Record<string, CompatProvider> = {
  openrouter: { env: ['OPENROUTER_API_KEY'], base: 'https://openrouter.ai/api/v1' },
  openai: { env: ['OPENAI_API_KEY'], base: 'https://api.openai.com/v1' },
  'openai-api': { env: ['OPENAI_API_KEY'], base: 'https://api.openai.com/v1' },
  deepseek: { env: ['DEEPSEEK_API_KEY'], base: 'https://api.deepseek.com/v1' },
  groq: { env: ['GROQ_API_KEY'], base: 'https://api.groq.com/openai/v1' },
  together: { env: ['TOGETHER_API_KEY'], base: 'https://api.together.xyz/v1' },
  minimax: { env: ['MINIMAX_API_KEY'], base: 'https://api.minimaxi.com/v1' },
  'minimax-cn': { env: ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY'], base: 'https://api.minimaxi.com/v1' },
  zai: { env: ['GLM_API_KEY', 'ZAI_API_KEY'], base: 'https://open.bigmodel.cn/api/paas/v4' },
  glm: { env: ['GLM_API_KEY'], base: 'https://open.bigmodel.cn/api/paas/v4' },
  kimi: { env: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], base: 'https://api.moonshot.cn/v1' },
  'kimi-coding': { env: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], base: 'https://api.moonshot.cn/v1' },
  dashscope: { env: ['DASHSCOPE_API_KEY'], base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  qwen: { env: ['DASHSCOPE_API_KEY'], base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  novita: { env: ['NOVITA_API_KEY'], base: 'https://api.novita.ai/v3/openai' },
};

export function applyHostLlmToEnv(creds: HostLlmCreds | null): void {
  if (!creds) return;
  if (!process.env.LLM_API_KEY) process.env.LLM_API_KEY = creds.apiKey;
  if (creds.apiBase && !process.env.LLM_API_BASE) process.env.LLM_API_BASE = creds.apiBase;
  if (creds.model && !process.env.LLM_MODEL) process.env.LLM_MODEL = creds.model;
}

export function harvestHostLlm(home = os.homedir(), prefer: string[] = []): HostLlmCreds | null {
  const readers: Array<[string, (h: string) => HostLlmCreds | null]> = [
    ['openclaw', harvestOpenClaw],
    ['hermes', harvestHermes],
  ];
  const ordered = [
    ...readers.filter(([id]) => prefer.includes(id)),
    ...readers.filter(([id]) => !prefer.includes(id)),
  ];
  for (const [, read] of ordered) {
    const creds = read(home);
    if (creds) return creds;
  }
  return null;
}

function harvestOpenClaw(home: string): HostLlmCreds | null {
  const root = path.join(home, '.openclaw');
  const cfgPath = path.join(root, 'openclaw.json');
  const hostEnv = {
    ...readEnvFile(path.join(root, '.env')),
    ...readEnvIfExists(path.join(root, 'openclaw.env')),
  };
  const cfg = readJsonish(cfgPath);
  if (cfg && typeof cfg === 'object') {
    const aliveEnv = pickRecord(cfg, ['skills', 'entries', 'alive', 'env']);
    const fromAlive = credsFromMap(aliveEnv, hostEnv, 'openclaw skills.entries.alive.env');
    if (fromAlive) return fromAlive;

    const primary = stringAt(cfg, ['agents', 'defaults', 'model', 'primary'])
      || stringAt(cfg, ['agents', 'defaults', 'model']);
    const providers = pickRecord(cfg, ['models', 'providers']);
    if (primary) {
      const { provider, model } = splitModelRef(primary);
      const fromPrimary = credsFromProvider(provider, model, providers, hostEnv, 'openclaw');
      if (fromPrimary) return fromPrimary;
    }
    if (providers) {
      for (const [provider, raw] of Object.entries(providers)) {
        const fromProvider = credsFromProvider(provider, undefined, { [provider]: raw }, hostEnv, 'openclaw');
        if (fromProvider) return fromProvider;
      }
    }
  }
  return credsFromCompatEnv(hostEnv, 'openclaw .env');
}

function harvestHermes(home: string): HostLlmCreds | null {
  const root = path.join(home, '.hermes');
  if (!fs.existsSync(root)) return null;
  const hostEnv = readEnvFile(path.join(root, '.env'));
  const yamlPath = path.join(root, 'config.yaml');
  let model: Record<string, unknown> = {};
  if (fs.existsSync(yamlPath)) {
    try {
      const parsed = YAML.parse(fs.readFileSync(yamlPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.model && typeof parsed.model === 'object') {
        model = parsed.model as Record<string, unknown>;
      }
    } catch {
      // ignore malformed config
    }
  }
  const modelName = firstString(model.default, model.model);
  const provider = firstString(model.provider) || '';
  const baseUrl = firstString(model.base_url, model.baseUrl);
  const inlineKey = resolveSecret(model.api_key ?? model.apiKey, hostEnv);
  if (inlineKey && (baseUrl || OPENAI_COMPAT[provider])) {
    return {
      apiKey: inlineKey,
      apiBase: baseUrl || OPENAI_COMPAT[provider]?.base,
      model: modelName,
      source: 'hermes config.yaml',
    };
  }
  if (provider && (baseUrl || OPENAI_COMPAT[provider])) {
    const fromProvider = credsFromCompat(provider, modelName, hostEnv, baseUrl, 'hermes');
    if (fromProvider) return fromProvider;
  }
  if (baseUrl) {
    const key = firstCompatKey(hostEnv);
    if (key) {
      return { apiKey: key.value, apiBase: baseUrl, model: modelName, source: `hermes ${key.name}` };
    }
  }
  return credsFromCompatEnv(hostEnv, 'hermes .env', modelName);
}

function credsFromMap(
  map: Record<string, unknown> | null,
  env: Record<string, string>,
  source: string,
): HostLlmCreds | null {
  if (!map) return null;
  const apiKey = resolveSecret(map.LLM_API_KEY, env);
  if (!apiKey) return null;
  return {
    apiKey,
    apiBase: firstString(map.LLM_API_BASE) || undefined,
    model: firstString(map.LLM_MODEL) || undefined,
    source,
  };
}

function credsFromProvider(
  provider: string,
  model: string | undefined,
  providers: Record<string, unknown> | null,
  env: Record<string, string>,
  host: string,
): HostLlmCreds | null {
  const entry = providers?.[provider];
  const rec = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
  const baseUrl = firstString(rec.baseUrl, rec.base_url);
  const apiKey = resolveSecret(rec.apiKey ?? rec.api_key, env);
  if (apiKey && (baseUrl || OPENAI_COMPAT[provider])) {
    return {
      apiKey,
      apiBase: baseUrl || OPENAI_COMPAT[provider]?.base,
      model: model || firstProviderModel(rec),
      source: `${host} models.providers.${provider}`,
    };
  }
  return credsFromCompat(provider, model || firstProviderModel(rec), env, baseUrl, host);
}

function credsFromCompat(
  provider: string,
  model: string | undefined,
  env: Record<string, string | undefined>,
  baseUrl: string | undefined,
  host: string,
): HostLlmCreds | null {
  const compat = OPENAI_COMPAT[provider];
  if (!compat && !baseUrl) return null;
  const names = compat?.env ?? [];
  for (const name of names) {
    const apiKey = firstString(env[name], process.env[name]);
    if (apiKey) {
      return {
        apiKey,
        apiBase: baseUrl || compat?.base,
        model,
        source: `${host} ${name}`,
      };
    }
  }
  return null;
}

function credsFromCompatEnv(
  env: Record<string, string | undefined>,
  source: string,
  model?: string,
): HostLlmCreds | null {
  for (const [provider, compat] of Object.entries(OPENAI_COMPAT)) {
    for (const name of compat.env) {
      const apiKey = firstString(env[name]);
      if (apiKey) {
        return { apiKey, apiBase: compat.base, model, source: `${source} ${name} (${provider})` };
      }
    }
  }
  return null;
}

function firstCompatKey(env: Record<string, string>): { name: string; value: string } | null {
  for (const compat of Object.values(OPENAI_COMPAT)) {
    for (const name of compat.env) {
      const value = firstString(env[name]);
      if (value) return { name, value };
    }
  }
  return null;
}

function resolveSecret(value: unknown, env: Record<string, string>): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const interp = trimmed.match(/^\$\{([A-Z0-9_]+)\}$/);
    if (interp) return firstString(env[interp[1]], process.env[interp[1]]);
    if (/^secretref-/i.test(trimmed)) return null;
    return trimmed;
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (rec.source === 'env' && typeof rec.id === 'string') {
      return firstString(env[rec.id], process.env[rec.id]);
    }
    if (rec.source === 'file' && typeof rec.path === 'string') {
      const filePath = rec.path.replace(/^~(?=\/|$)/, os.homedir());
      try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        return raw || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function splitModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  if (i <= 0) return { provider: '', model: ref };
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

function firstProviderModel(rec: Record<string, unknown>): string | undefined {
  const models = rec.models;
  if (!Array.isArray(models) || models.length === 0) return undefined;
  const first = models[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && typeof (first as { id?: unknown }).id === 'string') {
    return (first as { id: string }).id;
  }
  return undefined;
}

function pickRecord(root: unknown, keys: string[]): Record<string, unknown> | null {
  let cur: unknown = root;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur as Record<string, unknown> : null;
}

function stringAt(root: unknown, keys: string[]): string | undefined {
  let cur: unknown = root;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return firstString(cur);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readEnvIfExists(filePath: string): Record<string, string> {
  return fs.existsSync(filePath) ? readEnvFile(filePath) : {};
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readJsonish(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(relaxJson(raw));
    } catch {
      return null;
    }
  }
}

function relaxJson(raw: string): string {
  let s = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  s = s.replace(/,(\s*[}\]])/g, '$1');
  s = s.replace(/([,{[]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  return s;
}
