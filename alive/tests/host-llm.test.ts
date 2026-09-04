import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyHostLlmToEnv, harvestHostLlm } from '../scripts/host/host-llm';
import { loadAliveEnv } from '../scripts/utils/file-utils';

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alive-host-llm-'));
}

describe('harvestHostLlm', () => {
  it('reads OpenClaw skills.entries.alive.env', () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({
      skills: { entries: { alive: { env: {
        LLM_API_KEY: 'sk-alive',
        LLM_API_BASE: 'https://api.example.com/v1',
        LLM_MODEL: 'alive-model',
      } } } },
    }));
    expect(harvestHostLlm(home)).toEqual({
      apiKey: 'sk-alive',
      apiBase: 'https://api.example.com/v1',
      model: 'alive-model',
      source: 'openclaw skills.entries.alive.env',
    });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reads OpenClaw models.providers plus primary model', () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), `{
      agents: { defaults: { model: { primary: "acme/mini" } } },
      models: { providers: { acme: {
        baseUrl: "https://acme.example/v1",
        apiKey: "sk-acme",
        models: [{ id: "mini" }],
      } } },
    }`);
    expect(harvestHostLlm(home)).toEqual({
      apiKey: 'sk-acme',
      apiBase: 'https://acme.example/v1',
      model: 'mini',
      source: 'openclaw models.providers.acme',
    });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('resolves OpenClaw ${ENV} apiKey from host .env', () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaw', '.env'), 'OPENAI_API_KEY=sk-from-env\n');
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({
      agents: { defaults: { model: { primary: 'openai/gpt-4o-mini' } } },
      models: { providers: { openai: { apiKey: '${OPENAI_API_KEY}' } } },
    }));
    expect(harvestHostLlm(home)).toMatchObject({
      apiKey: 'sk-from-env',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reads Hermes .env + config.yaml provider', () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
    fs.writeFileSync(path.join(home, '.hermes', '.env'), 'OPENROUTER_API_KEY=sk-or-test\n');
    fs.writeFileSync(path.join(home, '.hermes', 'config.yaml'), [
      'model:',
      '  default: anthropic/claude-sonnet-4',
      '  provider: openrouter',
      '',
    ].join('\n'));
    expect(harvestHostLlm(home)).toEqual({
      apiKey: 'sk-or-test',
      apiBase: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4',
      source: 'hermes OPENROUTER_API_KEY',
    });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('prefers the requested host when both exist', () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({
      skills: { entries: { alive: { env: { LLM_API_KEY: 'sk-claw' } } } },
    }));
    fs.writeFileSync(path.join(home, '.hermes', '.env'), 'OPENAI_API_KEY=sk-hermes\n');
    expect(harvestHostLlm(home, ['hermes'])?.apiKey).toBe('sk-hermes');
    expect(harvestHostLlm(home, ['openclaw'])?.apiKey).toBe('sk-claw');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('loadAliveEnv host reuse', () => {
  const prev = {
    HOME: process.env.HOME,
    ALIVE_HOME: process.env.ALIVE_HOME,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_API_BASE: process.env.LLM_API_BASE,
    LLM_MODEL: process.env.LLM_MODEL,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('fills LLM_API_KEY from Hermes when .env has none', () => {
    const home = makeHome();
    const aliveHome = path.join(home, '.alive');
    fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
    fs.mkdirSync(aliveHome, { recursive: true });
    fs.writeFileSync(path.join(home, '.hermes', '.env'), 'OPENAI_API_KEY=sk-hermes-load\n');
    fs.writeFileSync(path.join(aliveHome, '.env'), 'ALIVE_PERSONA=minase\n');
    process.env.HOME = home;
    process.env.ALIVE_HOME = aliveHome;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_API_BASE;
    delete process.env.LLM_MODEL;
    loadAliveEnv();
    expect(process.env.LLM_API_KEY).toBe('sk-hermes-load');
    expect(process.env.LLM_API_BASE).toBe('https://api.openai.com/v1');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('does not override an existing LLM_API_KEY', () => {
    process.env.LLM_API_KEY = 'sk-already';
    applyHostLlmToEnv({ apiKey: 'sk-other', source: 'test' });
    expect(process.env.LLM_API_KEY).toBe('sk-already');
  });
});
