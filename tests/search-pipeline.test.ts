import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../skill/scripts/file-utils', () => ({
  PATHS: { searchState: '/mock/search-state.json', diary: '/mock/diary.md' },
  readJSON: vi.fn(),
  writeJSON: vi.fn(),
  appendText: vi.fn(),
  readTemplate: vi.fn(),
}));

vi.mock('../skill/scripts/llm-client', () => ({
  callLLM: vi.fn(),
}));

vi.mock('../skill/scripts/exa-client', () => ({
  exaWebSearch: vi.fn(),
}));

vi.mock('../skill/scripts/vitality-engine', () => ({
  applyActionCost: vi.fn(),
}));

vi.mock('../skill/scripts/time-utils', () => ({
  getLocalDate: vi.fn(() => '2026-03-16'),
  getLocalTimeHHMM: vi.fn(() => '14:00'),
}));

import { checkSearchBudget, extractQuery, digestResults, executeSearch, DEFAULT_SEARCH_STATE } from '../skill/scripts/search-pipeline';
import { readJSON, writeJSON, appendText, readTemplate } from '../skill/scripts/file-utils';
import { callLLM } from '../skill/scripts/llm-client';
import { exaWebSearch } from '../skill/scripts/exa-client';
import { applyActionCost } from '../skill/scripts/vitality-engine';

const mockReadJSON = vi.mocked(readJSON);
const mockWriteJSON = vi.mocked(writeJSON);
const mockAppendText = vi.mocked(appendText);
const mockReadTemplate = vi.mocked(readTemplate);
const mockCallLLM = vi.mocked(callLLM);
const mockExaWebSearch = vi.mocked(exaWebSearch);
const mockApplyActionCost = vi.mocked(applyActionCost);

describe('checkSearchBudget', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should always allow search (no hard daily limit)', () => {
    expect(checkSearchBudget()).toBe(true);
  });

  it('should allow search regardless of count', () => {
    expect(checkSearchBudget()).toBe(true);
  });
});

describe('extractQuery', () => {
  it('should strip common search prefixes', () => {
    const query = extractQuery({ action: '搜索一下怎么画cos妆', type: 'real', skill: 'search-pipeline', satisfies_intent: null });
    expect(query).toBe('怎么画cos妆');
  });

  it('should strip shorter prefixes too', () => {
    const query = extractQuery({ action: '搜索转场特效', type: 'real', skill: 'search-pipeline', satisfies_intent: null });
    expect(query).toBe('转场特效');
  });

  it('should return original text when no prefix matches', () => {
    const query = extractQuery({ action: '转场特效技巧', type: 'real', skill: 'search-pipeline', satisfies_intent: null });
    expect(query).toBe('转场特效技巧');
  });
});

describe('digestResults', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should call LLM with template and search results', async () => {
    mockReadTemplate.mockReturnValue('你搜了"{query}"。\n{voice_directive}\n{search_results}\n总结。');
    mockCallLLM.mockResolvedValue({ content: '学到了很多关于化妆的技巧', finishReason: 'stop' });

    const result = await digestResults('cos化妆技巧', [
      { title: 'Guide', url: 'https://example.com', snippet: 'Step by step...' },
    ], '用日常口吻');

    expect(mockReadTemplate).toHaveBeenCalledWith('search-digest-prompt.md');
    expect(mockCallLLM).toHaveBeenCalled();
    expect(result).toBe('学到了很多关于化妆的技巧');
  });

  it('should handle empty results gracefully', async () => {
    mockReadTemplate.mockReturnValue('{query}\n{voice_directive}\n{search_results}');
    mockCallLLM.mockResolvedValue({ content: '什么都没搜到...', finishReason: 'stop' });

    const result = await digestResults('something', [], '');
    expect(result).toBe('什么都没搜到...');
  });
});

describe('executeSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJSON.mockReturnValue({ date: '2026-03-16', count: 0 });
    mockExaWebSearch.mockResolvedValue([
      { title: 'Result', url: 'https://example.com', snippet: 'Info...' },
    ]);
    mockReadTemplate.mockReturnValue('{query}\n{voice_directive}\n{search_results}');
    mockCallLLM.mockResolvedValue({ content: '搜到了有用的东西', finishReason: 'stop' });
    mockApplyActionCost.mockReturnValue({ vitality: 46, last_updated: null, consecutive_low_days: 0 });
  });

  it('should execute full pipeline and return updated vitality', async () => {
    const result = await executeSearch(
      { action: '搜索cos技巧', type: 'real', skill: 'search-pipeline', satisfies_intent: null },
      { vitality: 50, last_updated: null, consecutive_low_days: 0 },
      [],
      '',
    );

    expect(mockExaWebSearch).toHaveBeenCalled();
    expect(mockCallLLM).toHaveBeenCalled();
    expect(mockAppendText).toHaveBeenCalled();
    expect(mockWriteJSON).toHaveBeenCalled();
    expect(mockApplyActionCost).toHaveBeenCalledWith(
      { vitality: 50, last_updated: null, consecutive_low_days: 0 },
      'search',
    );
    expect(result.vitality).toBe(46);
  });

  it('should degrade to simulated when Exa fails', async () => {
    mockExaWebSearch.mockRejectedValue(new Error('Exa search timeout'));
    const actionResults: string[] = [];

    await executeSearch(
      { action: '搜索技巧', type: 'real', skill: 'search-pipeline', satisfies_intent: null },
      { vitality: 50, last_updated: null, consecutive_low_days: 0 },
      actionResults,
      '',
    );

    expect(actionResults[0]).toContain('手机');
    expect(mockAppendText).toHaveBeenCalled(); // diary written with degraded entry
  });
});
