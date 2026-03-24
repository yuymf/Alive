// content-planner/scripts/advisor.ts
// Client for consulting the advisor skill.
// Migrated from skill/scripts/advisor-client.ts
//
// Changes from skill version:
// - Import callLLM from alive llm-client
// - Advice prompt loaded from sub-skill's own templates/ directory
// - Advisor personality loaded from persona.yaml advisors[] config
// - Non-critical path: always returns empty string on any error.

import * as fs from 'fs';
import * as path from 'path';
import { callLLM } from '../../../../scripts/utils/llm-client';
import { loadPersona } from '../../../../scripts/persona/persona-loader';

export interface AdvisorContext {
  currentCity: string;
  country: string;
  followerCount: number;
  recentPostsSummary: string;   // human-readable summary of last 7 days
  trendingTopics: string;       // comma-separated trending topics
}

// Resolve advice prompt from sub-skill templates directory
const ADVICE_PROMPT_PATH = path.join(__dirname, '..', 'templates', 'advice-prompt.md');
const DEFAULT_TIMEOUT_MS = 60_000;

function resolveAdvisorTimeoutMs(): number {
  const raw = process.env.ADVISOR_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[advisor-client] Invalid ADVISOR_TIMEOUT_MS="${raw}", fallback to ${DEFAULT_TIMEOUT_MS}ms`);
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.floor(parsed);
}

function loadAdvicePrompt(): string {
  try {
    return fs.readFileSync(ADVICE_PROMPT_PATH, 'utf-8');
  } catch {
    return '';
  }
}

function getAdvisorSystemPrompt(): string {
  try {
    const persona = loadPersona();
    const advisors = persona.advisors ?? [];
    if (advisors.length > 0 && advisors[0].system_prompt) {
      return advisors[0].system_prompt.trim();
    }
    // Fallback: build from advisor personality field
    if (advisors.length > 0) {
      return `你是${advisors[0].name}，${persona.meta.name}的${advisors[0].role}。\n${advisors[0].personality}`;
    }
  } catch {
    // persona not loaded, use empty
  }
  return '';
}

function renderPrompt(template: string, ctx: AdvisorContext): string {
  const persona = (() => { try { return loadPersona(); } catch { return null; } })();
  const name = persona?.meta.name ?? 'character';

  return template
    .replace('{advisor_system_prompt}', getAdvisorSystemPrompt())
    .replace(/{persona\.meta\.name}/g, name)
    .replace('{current_city}', ctx.currentCity)
    .replace('{country}', ctx.country)
    .replace('{follower_count}', String(ctx.followerCount))
    .replace('{recent_posts}', ctx.recentPostsSummary || '（暂无近期数据）')
    .replace('{trending_topics}', ctx.trendingTopics || '（无热点数据）');
}

/**
 * Ask advisor for today's posting advice.
 * Returns advice string, or '' on any error (graceful degradation).
 */
export async function consultAdvisor(ctx: AdvisorContext): Promise<string> {
  const template = loadAdvicePrompt();
  if (!template) return '';

  const prompt = renderPrompt(template, ctx);
  const timeoutMs = resolveAdvisorTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const advisorName = (() => {
      try {
        const persona = loadPersona();
        return persona.advisors?.[0]?.name ?? 'advisor';
      } catch {
        return 'advisor';
      }
    })();
    const result = await callLLM(prompt, undefined, advisorName, { signal: controller.signal });
    return (result.content ?? '').trim() || '';
  } catch (err) {
    const message = timedOut ? 'advisor timeout' : (err as Error).message;
    console.warn('[advisor-client] consultAdvisor failed:', message);
    return '';
  } finally {
    clearTimeout(timer);
  }
}
