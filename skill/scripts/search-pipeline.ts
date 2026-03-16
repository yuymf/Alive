import { PATHS, readJSON, writeJSON, appendText, readTemplate } from './file-utils';
import { callLLM } from './llm-client';
import { exaWebSearch, SearchResult } from './exa-client';
import { applyActionCost } from './vitality-engine';
import { getLocalDate, getLocalTimeHHMM } from './time-utils';
import type { VitalityState } from './types';

export interface SearchState {
  date: string;
  count: number;
}

export const DEFAULT_SEARCH_STATE: SearchState = {
  date: '',
  count: 0,
};

const MAX_SEARCHES_PER_DAY = 5;

interface ActionLike {
  action: string;
  type: string;
  skill: string | null;
  satisfies_intent: string | null;
}

/**
 * Check if search budget allows another search today.
 * Reads search-state.json; resets count on new day.
 */
export function checkSearchBudget(): boolean {
  const state = readJSON<SearchState>(PATHS.searchState, DEFAULT_SEARCH_STATE);
  const today = getLocalDate();

  if (state.date !== today) {
    return true; // new day, budget resets
  }
  return state.count < MAX_SEARCHES_PER_DAY;
}

/**
 * Extract a search query from the action description.
 * Strips common prefixes to get the core topic.
 */
export function extractQuery(action: ActionLike): string {
  return action.action
    .replace(/^(搜索一下|搜一下|查一下|了解一下|研究一下|想知道|想了解|搜索|学习)/u, '')
    .replace(/^(search|look up|find out)\s*/i, '')
    .trim() || action.action;
}

/**
 * Use LLM to digest raw search results into a Minase-voice diary entry.
 */
export async function digestResults(
  query: string,
  results: SearchResult[],
  voiceDirective: string,
): Promise<string> {
  const template = readTemplate('search-digest-prompt.md');
  const formattedResults = results.length > 0
    ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n\n')
    : '（没有找到相关结果）';

  const prompt = template
    .replace('{query}', query)
    .replace('{voice_directive}', voiceDirective)
    .replace('{search_results}', formattedResults);

  const response = await callLLM(prompt, 512, 'search-pipeline');
  return response.content;
}

/**
 * Main entry point: execute a search action.
 * Returns updated VitalityState.
 */
export async function executeSearch(
  action: ActionLike,
  vitalityState: VitalityState,
  actionResults: string[],
  voiceDirective: string,
): Promise<VitalityState> {
  const query = extractQuery(action);
  const today = getLocalDate();
  const timeStr = getLocalTimeHHMM();

  // 1. Budget check
  if (!checkSearchBudget()) {
    console.log(`[SEARCH] Daily search limit reached (${MAX_SEARCHES_PER_DAY}), degrading to simulated`);
    actionResults.push(`[simulated:search-limit] ${action.action}`);
    return vitalityState;
  }

  // 2. Search via Exa
  let results: SearchResult[];
  try {
    results = await exaWebSearch(query);
  } catch (err) {
    console.error(`[SEARCH] Exa search failed: ${(err as Error).message}`);
    const degradedEntry = `\n### ${today} ${timeStr} 学习\n📱 想搜「${query}」但是手机信号不太好...算了下次再查吧\n`;
    appendText(PATHS.diary, degradedEntry);
    actionResults.push(`[simulated:search-failed] 手机信号不好，${action.action}`);
    return applyActionCost(vitalityState, 'search');
  }

  // 3. LLM digest
  let digest: string;
  try {
    digest = await digestResults(query, results, voiceDirective);
  } catch (err) {
    console.error(`[SEARCH] LLM digest failed: ${(err as Error).message}`);
    digest = results.length > 0
      ? `搜了一下${query}，找到了一些结果但是没来得及细看`
      : `搜了一下${query}，好像没什么有用的信息`;
  }

  // 4. Write diary
  const diaryEntry = `\n### ${today} ${timeStr} 学习\n📱 ${digest}\n`;
  appendText(PATHS.diary, diaryEntry);

  // 5. Update search state
  const currentState = readJSON<SearchState>(PATHS.searchState, DEFAULT_SEARCH_STATE);
  const updatedState: SearchState = {
    date: today,
    count: currentState.date === today ? currentState.count + 1 : 1,
  };
  writeJSON(PATHS.searchState, updatedState);

  // 6. Apply vitality cost
  const updatedVitality = applyActionCost(vitalityState, 'search');
  actionResults.push(`[real:search] ${action.action}`);
  console.log(`[SEARCH] Completed search for "${query}" (${results.length} results, budget: ${updatedState.count}/${MAX_SEARCHES_PER_DAY})`);

  return updatedVitality;
}
