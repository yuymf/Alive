// alive/tests/ops-browse.test.ts
// Integration tests for ops-browse lifecycle script:
// - buildBrowseSummary pure helper
// - Gate checks (ops.enabled, enable_heartbeat_cron)
// - Sub-skill routing + execution
// - Diary + heartbeat-log writes
// - Error handling on sub-skill failure

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PersonaConfig, HeartbeatLog } from '../scripts/utils/types';

// ─── Module mocks (hoisted) ────────────────────────────────────

const mockLoadPersona = vi.fn();
const mockGetContentSourcesConfig = vi.fn(() => ({
  platforms: ['xhs', 'bilibili', 'dailyhot'],
  keywords: [],
  dailyhot_platforms: [],
  reddit_subreddits: [],
}));
vi.mock('../scripts/persona/persona-loader', () => ({
  loadPersona: (...args: unknown[]) => mockLoadPersona(...args),
  getContentSourcesConfig: (...args: unknown[]) => mockGetContentSourcesConfig(...args),
}));

const mockCreateRealLLMClient = vi.fn(() => ({
  call: vi.fn(),
  callJSON: vi.fn(),
}));
vi.mock('../scripts/utils/llm-client', () => ({
  createRealLLMClient: (...args: unknown[]) => mockCreateRealLLMClient(...args),
}));

const mockBuildRouteTable = vi.fn();
const mockResolveRouteBySkillName = vi.fn();
const mockBuildContext = vi.fn(() => ({ config: {} }));
const mockExecuteSubSkill = vi.fn();
vi.mock('../scripts/router/skill-router', () => ({
  buildRouteTable: (...args: unknown[]) => mockBuildRouteTable(...args),
  resolveRouteBySkillName: (...args: unknown[]) => mockResolveRouteBySkillName(...args),
  buildContext: (...args: unknown[]) => mockBuildContext(...args),
  executeSubSkill: (...args: unknown[]) => mockExecuteSubSkill(...args),
}));

vi.mock('../scripts/utils/time-utils', () => ({
  wallNow: vi.fn(() => new Date('2026-04-07T14:00:00+08:00')),
  now: vi.fn(() => new Date('2026-04-07T14:00:00+08:00')),
  getLocalDate: vi.fn(() => '2026-04-07'),
}));

const mockRunKeywordSearch = vi.fn(async () => ({
  searched: 0,
  totalDiscovered: 0,
  keywords: [],
}));
vi.mock('../scripts/ops/keyword-tracker', () => ({
  runKeywordSearch: (...args: unknown[]) => mockRunKeywordSearch(...args),
}));

const mockFetchSearchKeywordTrends = vi.fn(async () => []);
vi.mock('../scripts/ops/trend-analyzer', () => ({
  // ops-browse.ts imports refreshSearchKeywordTrends after the async-decoupling
  // refactor. The alias fetchSearchKeywordTrends is kept exported for
  // back-compat with older callers/tests.
  refreshSearchKeywordTrends: (...args: unknown[]) => mockFetchSearchKeywordTrends(...args),
  fetchSearchKeywordTrends: (...args: unknown[]) => mockFetchSearchKeywordTrends(...args),
}));

// ─── Sandbox setup ──────────────────────────────────────────────

let sandbox: string;
let memoryDir: string;
let skillDir: string;

// Import real file-utils (not mocked — we test actual file writes)
import { setBasePaths, resetBasePaths, PATHS, readJSON, readText } from '../scripts/utils/file-utils';

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-ops-browse-'));
  memoryDir = path.join(sandbox, 'memory');
  skillDir = path.join(sandbox, 'skill');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  setBasePaths(memoryDir, skillDir);

  vi.clearAllMocks();
  delete process.env.ALIVE_OPS_BROWSE_PRECOMPUTE_SEARCH;
});


afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// ─── Import after mocks ─────────────────────────────────────────

import { buildBrowseSummary, main } from '../scripts/lifecycle/ops-browse';

// ─── Persona fixtures ───────────────────────────────────────────

function makeOpsPersona(overrides?: Partial<PersonaConfig['ops']>): PersonaConfig {
  return {
    meta: { name: 'TestV', id: 'test-v' },
    personality: { mbti: 'ENTJ', core_traits: [] },
    voice: { language: 'zh-CN', style: 'test', sample_lines: [] },
    schedule: { wake_hour: 9, sleep_hour: 1 },
    content_sources: { platforms: ['xhs'], keywords: ['电竞', '赛车'] },
    ops: {
      enabled: true,
      brief_time: '08:30',
      competitor_accounts: { xhs: [], douyin: [] },
      trend_score_threshold: 1.0,
      topic_count: 3,
      topic_filter_prompt: '',
      platforms: {},
      strategy_enabled: false,
      browse_interval: '0 */3 * * *',
      browse_sources: [
        { platform: 'xhs', count: 5 },
        { platform: 'bilibili', count: 3 },
      ],
      automation: {
        enable_heartbeat_cron: false,
        silent_background_jobs: false,
      },
      ...overrides,
    },
  } as unknown as PersonaConfig;
}

// ─── buildBrowseSummary (pure helper) ───────────────────────────

describe('buildBrowseSummary', () => {
  it('formats browse results into diary entry', () => {
    const results = [
      { platform: 'xhs', items: [
        { title: '电竞女解说崛起', source: 'xhs' },
        { title: '赛车新手入门指南', source: 'xhs' },
      ]},
      { platform: 'bilibili', items: [
        { title: 'KPL春季赛回顾', source: 'bilibili' },
      ]},
    ];
    const summary = buildBrowseSummary(results);
    expect(summary).toContain('xhs');
    expect(summary).toContain('电竞女解说崛起');
    expect(summary).toContain('bilibili');
    expect(summary).toContain('KPL春季赛回顾');
  });

  it('returns empty string for empty results', () => {
    expect(buildBrowseSummary([])).toBe('');
  });

  it('skips platforms with no items', () => {
    const results = [
      { platform: 'xhs', items: [] },
      { platform: 'bilibili', items: [{ title: 'test', source: 'bilibili' }] },
    ];
    const summary = buildBrowseSummary(results);
    expect(summary).not.toContain('xhs');
    expect(summary).toContain('bilibili');
  });
});

// ─── Gate checks ────────────────────────────────────────────────

describe('ops-browse gate checks', () => {
  it('skips when ops.enabled is false', async () => {
    const persona = makeOpsPersona();
    persona.ops!.enabled = false;
    mockLoadPersona.mockResolvedValue(persona);
    const spy = vi.spyOn(console, 'log');

    await main();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ops.enabled is false'));
    expect(mockBuildRouteTable).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('skips when ops is undefined', async () => {
    const persona = makeOpsPersona();
    delete (persona as Record<string, unknown>).ops;
    mockLoadPersona.mockResolvedValue(persona);
    const spy = vi.spyOn(console, 'log');

    await main();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ops.enabled is false'));
    spy.mockRestore();
  });

  it('skips when enable_heartbeat_cron is true (heartbeat mode)', async () => {
    const persona = makeOpsPersona({
      automation: {
        enable_heartbeat_cron: true,
        silent_background_jobs: false,
      },
    });
    mockLoadPersona.mockResolvedValue(persona);
    const spy = vi.spyOn(console, 'log');

    await main();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('heartbeat is enabled'));
    expect(mockBuildRouteTable).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('skips when enable_heartbeat_cron is not explicitly false (default)', async () => {
    const persona = makeOpsPersona({
      automation: {
        silent_background_jobs: false,
      },
    });
    mockLoadPersona.mockResolvedValue(persona);
    const spy = vi.spyOn(console, 'log');

    await main();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('heartbeat is enabled'));
    spy.mockRestore();
  });

  it('skips when content-browse route is not found', async () => {
    const persona = makeOpsPersona();
    mockLoadPersona.mockResolvedValue(persona);
    mockResolveRouteBySkillName.mockReturnValue(null);
    const spy = vi.spyOn(console, 'log');

    await main();

    expect(mockBuildRouteTable).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('content-browse sub-skill not found'));
    spy.mockRestore();
  });
});

// ─── Successful execution ───────────────────────────────────────

describe('ops-browse execution', () => {
  const fakeRoute = { skillName: 'content-browse', action: 'feed-browse', priority: 4 };

  it('calls executeSubSkill for each browse source and writes diary + log', async () => {
    const persona = makeOpsPersona();
    mockLoadPersona.mockResolvedValue(persona);
    mockResolveRouteBySkillName.mockReturnValue(fakeRoute);
    mockExecuteSubSkill
      .mockResolvedValueOnce({ narrative: '发现电竞趋势：女性解说崛起，多个账号涨粉迅速' })
      .mockResolvedValueOnce({ narrative: 'B站KPL春季赛回顾视频热度上升' });

    await main();

    // Should call executeSubSkill for each browse source (xhs + bilibili)
    expect(mockExecuteSubSkill).toHaveBeenCalledTimes(2);

    // Should call buildContext with correct keywords from persona
    expect(mockBuildContext).toHaveBeenCalledTimes(2);

    // Diary should be written
    const diary = readText(PATHS.diary);
    expect(diary).toContain('ops-browse');
    expect(diary).toContain('xhs');
    expect(diary).toContain('bilibili');

    // Heartbeat log should be written
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    expect(log.logs).toHaveLength(1);
    expect(log.logs[0].type).toBe('regular');
    expect(log.logs[0].status).toBe('completed');
    expect(log.logs[0].chosen_actions).toEqual(['ops-browse:xhs', 'ops-browse:bilibili']);
  });

  it('uses default browse_sources when none configured', async () => {
    const persona = makeOpsPersona();
    delete persona.ops!.browse_sources;
    mockLoadPersona.mockResolvedValue(persona);
    mockResolveRouteBySkillName.mockReturnValue(fakeRoute);
    mockExecuteSubSkill.mockResolvedValue({ narrative: 'Daily hot trends' });

    await main();

    // Should fall back to default dailyhot source
    expect(mockExecuteSubSkill).toHaveBeenCalledTimes(1);
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    expect(log.logs[0].chosen_actions).toEqual(['ops-browse:dailyhot']);
  });

  it('does not write diary when all results are empty', async () => {
    const persona = makeOpsPersona();
    mockLoadPersona.mockResolvedValue(persona);
    mockResolveRouteBySkillName.mockReturnValue(fakeRoute);
    mockExecuteSubSkill.mockResolvedValue({ narrative: '' });

    await main();

    // Diary should not be written (or be empty)
    const diaryExists = fs.existsSync(PATHS.diary);
    if (diaryExists) {
      const diary = readText(PATHS.diary);
      expect(diary).not.toContain('ops-browse');
    }

    // Heartbeat log should still be written
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    expect(log.logs).toHaveLength(1);
    expect(log.logs[0].tick_summary).toBe('No browse results');
  });

  it('runs keyword search and optionally pre-computes search-keyword trends after browse', async () => {
    process.env.ALIVE_OPS_BROWSE_PRECOMPUTE_SEARCH = '1';
    const persona = makeOpsPersona();

    mockLoadPersona.mockResolvedValue(persona);
    mockResolveRouteBySkillName.mockReturnValue(fakeRoute);
    mockExecuteSubSkill.mockResolvedValue({ narrative: '发现新趋势' });
    mockRunKeywordSearch.mockResolvedValue({
      searched: 1,
      totalDiscovered: 2,
      keywords: ['电竞'],
    });
    mockFetchSearchKeywordTrends.mockResolvedValue([
      { keyword: '电竞', platform: 'xhs' },
    ]);

    await main();

    expect(mockRunKeywordSearch).toHaveBeenCalledTimes(1);
    expect(mockFetchSearchKeywordTrends).toHaveBeenCalledTimes(1);
  });
});

// ─── Error handling ─────────────────────────────────────────────

describe('ops-browse error handling', () => {
  const fakeRoute = { skillName: 'content-browse', action: 'feed-browse', priority: 4 };

  it('catches sub-skill errors gracefully and continues to next source', async () => {
    const persona = makeOpsPersona();
    mockLoadPersona.mockResolvedValue(persona);
    mockResolveRouteBySkillName.mockReturnValue(fakeRoute);
    mockExecuteSubSkill
      .mockRejectedValueOnce(new Error('XHS API timeout'))
      .mockResolvedValueOnce({ narrative: 'B站数据正常' });
    const errorSpy = vi.spyOn(console, 'error');

    await main();

    // First source fails, second succeeds — should still complete
    expect(mockExecuteSubSkill).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to browse xhs: XHS API timeout'));

    // Diary should only contain bilibili results
    const diary = readText(PATHS.diary);
    expect(diary).toContain('bilibili');
    expect(diary).not.toContain('xhs');

    // Heartbeat log should still record both
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    expect(log.logs).toHaveLength(1);
    expect(log.logs[0].chosen_actions).toContain('ops-browse:xhs');
    expect(log.logs[0].chosen_actions).toContain('ops-browse:bilibili');

    errorSpy.mockRestore();
  });

  it('handles all sources failing without crashing', async () => {
    const persona = makeOpsPersona();
    mockLoadPersona.mockResolvedValue(persona);
    mockResolveRouteBySkillName.mockReturnValue(fakeRoute);
    mockExecuteSubSkill.mockRejectedValue(new Error('Network down'));

    // Should not throw
    await expect(main()).resolves.toBeUndefined();

    // Heartbeat log should still be written
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    expect(log.logs).toHaveLength(1);
    expect(log.logs[0].tick_summary).toBe('No browse results');
  });
});
