// alive/sub-skills/web-search/scripts/index.ts
// Web search sub-skill — curiosity-driven research and learning
//
// Generalized from skill/scripts/search-pipeline.ts + exa-client.ts
// Uses SubSkillContext.llm instead of direct LLM/Exa imports.

import * as fs from 'fs';
import * as path from 'path';
import type { SubSkillContext, SubSkillResult } from '../../../scripts/router/sub-skill-sdk';
import { createResult } from '../../../scripts/router/sub-skill-sdk';

// ── Types ────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchState {
  date: string;
  count: number;
}

const DEFAULT_SEARCH_STATE: SearchState = { date: '', count: 0 };

// ── Exa MCP Client ──────────────────────────────────────────────

const EXA_MCP_ENDPOINT = 'https://mcp.exa.ai/mcp';
const SEARCH_TIMEOUT_MS = 25_000;
const EXA_MIN_INTERVAL_MS = 1_500;
let lastExaCallAtMs = 0;

/** @internal Exported for test reset */
export function resetExaRateLimitForTests(): void {
  lastExaCallAtMs = 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value: string | null): number {
  const seconds = Number.parseInt(value ?? '5', 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5_000;
}

async function callExa(
  query: string,
  numResults: number,
  searchType: 'auto' | 'fast' | 'deep',
): Promise<Response> {
  const waitMs = EXA_MIN_INTERVAL_MS - (Date.now() - lastExaCallAtMs);
  if (waitMs > 0) await sleep(waitMs);
  lastExaCallAtMs = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    return await fetch(EXA_MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: { query, numResults, searchType },
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Parse Exa's SSE response into structured results. */
export function parseSearchResults(body: string): SearchResult[] {
  try {
    const dataLine = body.split('\n').find(l => l.startsWith('data:'));
    if (!dataLine) return [];

    const envelope = JSON.parse(dataLine.slice('data:'.length).trim()) as {
      result?: { content?: Array<{ type: string; text?: string }> };
      error?: { message: string };
    };

    if (envelope.error) throw new Error(`Exa error: ${envelope.error.message}`);

    const textBlock = envelope.result?.content?.find(c => c.type === 'text')?.text ?? '';
    if (!textBlock) return [];
    return extractResultsFromText(textBlock);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Exa error:')) throw err;
    throw new Error(`Exa response parse failed: ${(err as Error).message}`);
  }
}

function extractResultsFromText(text: string): SearchResult[] {
  const chunks = text.split(/(?=Title: )/);
  const results: SearchResult[] = [];

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const titleMatch = chunk.match(/^Title:\s*(.+)/m);
    const urlMatch = chunk.match(/^URL:\s*(https?:\/\/\S+)/m);
    const textMatch = chunk.match(/^Text:\s*([\s\S]+)/m);

    if (!titleMatch || !urlMatch) continue;
    const rawSnippet = textMatch ? textMatch[1].trim() : '';
    const snippet = rawSnippet.replace(/\s+/g, ' ').slice(0, 300).trim();

    results.push({
      title: titleMatch[1].trim(),
      url: urlMatch[1].trim(),
      snippet,
    });
  }
  return results;
}

export async function exaWebSearch(
  query: string,
  numResults = 5,
  searchType: 'auto' | 'fast' | 'deep' = 'auto',
): Promise<SearchResult[]> {
  let response = await callExa(query, numResults, searchType);

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    await response.text().catch(() => '');
    await sleep(retryAfterMs);
    response = await callExa(query, numResults, searchType);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Exa MCP HTTP ${response.status}${errBody ? ': ' + errBody.slice(0, 200) : ''}`);
  }

  const body = await response.text();
  return parseSearchResults(body);
}

// ── Query Extraction ─────────────────────────────────────────────

/**
 * Strip common search-intent prefixes from action description to get the core topic.
 */
export function extractQuery(actionDescription: string): string {
  return actionDescription
    .replace(/^(搜索一下|搜一下|查一下|了解一下|研究一下|想知道|想了解|搜索|学习)/u, '')
    .replace(/^(search|look up|find out)\s*/i, '')
    .trim() || actionDescription;
}

// ── Template Loader ──────────────────────────────────────────────

function loadTemplate(templateName: string): string {
  const templateDir = path.join(__dirname, '..', 'templates');
  const templatePath = path.join(templateDir, templateName);
  if (fs.existsSync(templatePath)) return fs.readFileSync(templatePath, 'utf8');
  throw new Error(`Template not found: ${templateName}`);
}

// ── Actions ──────────────────────────────────────────────────────

export const actions = {
  /**
   * Execute a web search and digest results into a persona-voice diary entry.
   */
  async 'search-pipeline'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { persona, intent, memory, llm } = ctx;
    const query = extractQuery(intent.description);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5);

    // 1. Search via Exa
    let results: SearchResult[];
    try {
      results = await exaWebSearch(query);
    } catch (err) {
      const degradedEntry = `\n### ${dateStr} ${timeStr} 学习\n📱 想搜「${query}」但是网络不太好...算了下次再查吧\n`;
      memory.appendDiary(degradedEntry);
      return createResult(
        `想搜「${query}」但搜索失败了`,
        { vitality_cost: 10, emotion_deltas: [{ stress: 0.05, valence: -0.05 }] },
      );
    }

    // 2. LLM digest
    let digest: string;
    try {
      const template = loadTemplate('search-digest-prompt.md');
      const formattedResults = results.length > 0
        ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n\n')
        : '（没有找到相关结果）';

      const voiceStyle = persona.voice?.style ?? '';
      const prompt = template
        .replace('{query}', query)
        .replace('{voice_directive}', voiceStyle)
        .replace('{search_results}', formattedResults)
        .replace(/\{persona\.meta\.name\}/g, persona.meta.name);

      digest = await llm.call(prompt, 500);
    } catch {
      digest = results.length > 0
        ? `搜了一下${query}，找到了一些结果但是没来得及细看`
        : `搜了一下${query}，好像没什么有用的信息`;
    }

    // 3. Write diary
    const diaryEntry = `\n### ${dateStr} ${timeStr} 学习\n📱 ${digest}\n`;
    memory.appendDiary(diaryEntry);

    // 4. Update search state
    const currentState = memory.readJSON<SearchState>('search-state', DEFAULT_SEARCH_STATE);
    const updatedState: SearchState = {
      date: dateStr,
      count: currentState.date === dateStr ? currentState.count + 1 : 1,
    };
    memory.writeJSON('search-state', updatedState);

    console.log(`[web-search] Completed search for "${query}" (${results.length} results, total today: ${updatedState.count})`);

    return createResult(
      `搜了「${query}」— ${digest.slice(0, 80)}`,
      {
        vitality_cost: 20,
        emotion_deltas: [
          { valence: 0.05, creativity: 0.08 },           // learning is mildly uplifting
          ...(results.length === 0 ? [{ valence: -0.05 }] : []),
        ],
      },
    );
  },
};
