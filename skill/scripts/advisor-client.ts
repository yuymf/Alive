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
const TIMEOUT_MS = 10_000;

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

  try {
    const result = await Promise.race([
      callLLM(prompt, 512, 'ins-advisor'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('advisor timeout')), TIMEOUT_MS)
      ),
    ]);
    return result.content?.trim() ?? '';
  } catch (err) {
    console.warn('[advisor-client] consultAdvisor failed:', (err as Error).message);
    return '';
  }
}
