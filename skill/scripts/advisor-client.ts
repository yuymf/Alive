// skill/scripts/advisor-client.ts
// Client for consulting the ins-advisor skill (小慧).
// Non-critical path: always returns empty string on any error.

import * as fs from 'fs';
import * as path from 'path';
import { callLLM } from './llm-client';

export interface AdvisorContext {
  currentCity: string;
  country: string;
  followerCount: number;
  recentPostsSummary: string;   // human-readable summary of last 7 days
  trendingTopics: string;       // comma-separated trending topics
}

const ADVICE_PROMPT_PATH = path.join(__dirname, '../ins-advisor/advice-prompt.md');
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

function renderPrompt(template: string, ctx: AdvisorContext): string {
  return template
    .replace('{current_city}', ctx.currentCity)
    .replace('{country}', ctx.country)
    .replace('{follower_count}', String(ctx.followerCount))
    .replace('{recent_posts}', ctx.recentPostsSummary || '（暂无近期数据）')
    .replace('{trending_topics}', ctx.trendingTopics || '（无热点数据）');
}

/**
 * Ask 小慧 for today's posting advice.
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
    const result = await callLLM(prompt, undefined, 'ins-advisor', { signal: controller.signal });
    return (result.content ?? '').trim() || '';
  } catch (err) {
    const message = timedOut ? 'advisor timeout' : (err as Error).message;
    console.warn('[advisor-client] consultAdvisor failed:', message);
    return '';
  } finally {
    clearTimeout(timer);
  }
}
