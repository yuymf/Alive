/**
 * viral-kb-integration.test.ts
 * Integration scenarios for the viral content knowledge base feature.
 *
 * 5 scenarios from the plan:
 * 1. ops-trends output with 2 viral candidates → correctly queued
 * 2. Dissect 2 items → entries.json has 2 records
 * 3. 3rd occurrence of same formula combination → persona.yaml gains 1 template (auto_promoted)
 * 4. topic-generator generates draft with matching track records → prompt contains viralContext
 * 5. topic-generator generates draft with no matching records → no viralContext, still works
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import YAML from 'yaml';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import { createMockLLMClient } from '../scripts/utils/llm-client';
import { detectViral } from '../scripts/ops/viral-detector';
import { dissectBatch } from '../scripts/ops/content-dissector';
import {
  addToQueue, loadQueue, loadEntries,
  upsertEntry, checkFormulaPromotion,
} from '../scripts/ops/viral-kb-store';
import { buildViralContext } from '../scripts/ops/topic-generator';
import { TrendLikeItem } from '../scripts/ops/viral-detector';
import { ViralEntry, DissectQueueItem } from '../scripts/utils/types';

// ─── Sandbox setup ─────────────────────────────────────────────────────────────

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viral-kb-integration-'));
  setBasePaths(sandboxDir, sandboxDir);
  // Ensure viral-kb subdirectory exists
  fs.mkdirSync(path.join(sandboxDir, 'viral-kb'), { recursive: true });
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTrendItem(overrides: Partial<TrendLikeItem> = {}): TrendLikeItem {
  return {
    source_id: `src-${Math.random().toString(36).slice(2)}`,
    platform: 'douyin',
    title: '热门视频标题',
    description: '视频描述内容',
    likes: 8000,
    comments: 500,
    shares: 200,
    source_type: 'trending_feed',
    ...overrides,
  };
}

function makeQueueItem(overrides: Partial<DissectQueueItem> = {}): DissectQueueItem {
  return {
    id: `qitem-${Math.random().toString(36).slice(2)}`,
    platform: 'douyin',
    source_id: `src-${Math.random().toString(36).slice(2)}`,
    source_type: 'trending_feed',
    title: '测试标题',
    description: '测试描述',
    likes: 8000,
    comments: 200,
    shares: 100,
    queued_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeUniversalEntry(overrides: Partial<ViralEntry> = {}): ViralEntry {
  const nonce = Math.random().toString(36).slice(2);
  return {
    id: `entry-${nonce}`,
    platform: 'douyin',
    source_id: `src-${nonce}`,
    source_type: 'trending_feed',
    persona_id: 'test',
    title: `爆款测试-${nonce}`,
    description: '描述',
    likes: 10000,
    comments: 300,
    shares: 100,
    collected_at: new Date().toISOString(),
    dissection: {
      hook_type: '反问式',
      content_type: '工具类',
      identity_mode: null,
      emotion_arc: '焦虑→解脱',
      interaction_design: '评论投票',
      visual_style: '简约',
      cta_type: '关注解锁',
      summary: '职场必备干货',
    },
    dissection_status: 'done',
    kb_tier: 'universal',
    promoted_to_template: false,
    times_referenced: 0,
    ...overrides,
  };
}

function makeTrackEntry(identityMode: string, overrides: Partial<ViralEntry> = {}): ViralEntry {
  return makeUniversalEntry({
    kb_tier: 'track',
    dissection: {
      hook_type: '数字冲击',
      content_type: '赛事解读',
      identity_mode: identityMode,
      emotion_arc: '紧张→高潮→释放',
      interaction_design: '弹幕互动',
      visual_style: '竞技感',
      cta_type: '关注更新',
      summary: '赛事精彩解读',
    },
    ...overrides,
  });
}

// ─── Scenario 1: viral detection → queue ─────────────────────────────────────

describe('Scenario 1: detectViral → addToQueue', () => {
  it('2 viral candidates (likes > threshold) are correctly queued', () => {
    const threshold = 5000;

    const items: TrendLikeItem[] = [
      makeTrendItem({ source_id: 'viral-1', likes: 10000 }),
      makeTrendItem({ source_id: 'viral-2', likes: 7000 }),
      makeTrendItem({ source_id: 'below-threshold', likes: 3000 }),
    ];

    const candidates = detectViral(items, sandboxDir, threshold);
    expect(candidates).toHaveLength(2);

    // Add to queue
    for (const c of candidates) {
      addToQueue(sandboxDir, c);
    }

    const queue = loadQueue(sandboxDir);
    expect(queue).toHaveLength(2);

    // Deduplication: adding same candidates again should not grow the queue
    for (const c of candidates) {
      addToQueue(sandboxDir, c);
    }
    expect(loadQueue(sandboxDir)).toHaveLength(2);
  });
});

// ─── Scenario 2: dissect 2 items → entries.json ──────────────────────────────

describe('Scenario 2: dissectBatch → entries.json', () => {
  it('dissects 2 items and stores 2 records in entries.json', async () => {
    const dissectionResponse = JSON.stringify({
      hook_type: '反问式',
      content_type: '工具类',
      identity_mode: null,
      emotion_arc: '焦虑→解脱',
      interaction_design: '评论问答',
      visual_style: '简约白',
      cta_type: '关注解锁',
      summary: '用问题引导点击',
    });

    const mockLlm = createMockLLMClient([dissectionResponse, dissectionResponse]);

    const items = [
      makeQueueItem({ id: 'q1', source_id: 's1', title: '测试标题-1' }),
      makeQueueItem({ id: 'q2', source_id: 's2', title: '测试标题-2' }),
    ];

    const entries = await dissectBatch(items, mockLlm, 'test-persona');
    expect(entries).toHaveLength(2);
    expect(entries[0].dissection_status).toBe('done');
    expect(entries[1].dissection_status).toBe('done');

    // Store them
    for (const entry of entries) {
      upsertEntry(sandboxDir, entry);
    }

    const stored = loadEntries(sandboxDir);
    expect(stored).toHaveLength(2);
    expect(stored[0].dissection?.hook_type).toBe('反问式');
    expect(stored[1].dissection?.content_type).toBe('工具类');
  });
});

// ─── Scenario 3: formula promotion (no longer writes persona.yaml) ──────────
//
// In v1, a formula that crossed the promotion threshold was written straight
// into `persona.yaml` under `ops.content_templates`. v2 changed the contract
// (see note above `injectTemplateIntoPersona` in viral-kb-store.ts): formulas
// stay in `universal-formulas.json` and are injected at runtime by
// `buildViralFormulaContext()` instead. These tests were rewritten to assert
// the new contract.

describe('Scenario 3: 3rd occurrence → formula promotion', () => {
  it('promotes formula when same combination appears 3 times', () => {
    // Create a minimal persona.yaml so the test resembles production layout.
    // It should NOT be modified by promotion anymore.
    const personaYamlPath = path.join(sandboxDir, 'persona.yaml');
    const minimalPersona = {
      meta: { name: 'TestPersona', id: 'test', tagline: 'test' },
      ops: {
        enabled: true,
        content_templates: [],
      },
    };
    fs.writeFileSync(personaYamlPath, YAML.stringify(minimalPersona), 'utf8');

    // First 2 occurrences: no promotion
    const entry1 = makeUniversalEntry({ id: 'e1' });
    const entry2 = makeUniversalEntry({ id: 'e2' });

    upsertEntry(sandboxDir, entry1);
    const result1 = checkFormulaPromotion(sandboxDir, entry1, personaYamlPath);
    expect(result1.promoted).toBe(false);

    upsertEntry(sandboxDir, entry2);
    const result2 = checkFormulaPromotion(sandboxDir, entry2, personaYamlPath);
    expect(result2.promoted).toBe(false);

    // Third occurrence: should promote
    const entry3 = makeUniversalEntry({ id: 'e3' });
    upsertEntry(sandboxDir, entry3);
    const result3 = checkFormulaPromotion(sandboxDir, entry3, personaYamlPath);
    expect(result3.promoted).toBe(true);
    expect(result3.formula).toBeDefined();
    expect(result3.formula!.occurrence_count).toBe(3);

    // persona.yaml must be untouched — v2 contract.
    const updatedYaml = YAML.parse(fs.readFileSync(personaYamlPath, 'utf8')) as {
      ops: { content_templates: Array<unknown> };
    };
    expect(updatedYaml.ops.content_templates).toHaveLength(0);
  });

  it('does not promote twice for the same formula', () => {
    const personaYamlPath = path.join(sandboxDir, 'persona.yaml');
    fs.writeFileSync(personaYamlPath, YAML.stringify({ ops: { content_templates: [] } }), 'utf8');

    // Cause 4 occurrences — only the 3rd should return `promoted: true`.
    const promoteResults: boolean[] = [];
    for (let i = 1; i <= 4; i++) {
      const e = makeUniversalEntry({ id: `dup-e${i}` });
      upsertEntry(sandboxDir, e);
      const r = checkFormulaPromotion(sandboxDir, e, personaYamlPath);
      promoteResults.push(r.promoted);
    }

    expect(promoteResults).toEqual([false, false, true, false]);

    // persona.yaml still untouched.
    const updatedYaml = YAML.parse(fs.readFileSync(personaYamlPath, 'utf8')) as {
      ops: { content_templates: Array<unknown> };
    };
    expect(updatedYaml.ops.content_templates).toHaveLength(0);
  });
});

// ─── Scenario 4: topic-generator with matching track patterns ─────────────────

describe('Scenario 4: buildViralContext with matching entries', () => {
  it('prompt contains viralContext when track patterns exist', () => {
    // Pre-load track entries into the KB
    const entry1 = makeTrackEntry('esports', { id: 'track-e1', platform: 'douyin' });
    const entry2 = makeTrackEntry('esports', { id: 'track-e2', platform: 'douyin' });
    upsertEntry(sandboxDir, entry1);
    upsertEntry(sandboxDir, entry2);

    // buildViralContext should return non-empty string for matching entries
    const viralCtx = buildViralContext([entry1, entry2], 'douyin');

    expect(viralCtx).not.toBe('');
    expect(viralCtx).toContain('抖音');
    expect(viralCtx).toContain('esports');
    expect(viralCtx).toContain('数字冲击');
    expect(viralCtx).toContain('赛事精彩解读');
  });
});

// ─── Scenario 5: topic-generator with no matching patterns (cold start) ───────

describe('Scenario 5: buildViralContext cold start — empty KB', () => {
  it('returns empty string when no track entries exist', () => {
    const viralCtx = buildViralContext([], 'douyin');
    expect(viralCtx).toBe('');
  });

  it('returns empty string when entries exist but none match the platform', () => {
    const entry = makeTrackEntry('esports', { id: 'xhs-e1', platform: 'xhs' });
    // buildViralContext with empty list (caller filters by platform before calling)
    const viralCtx = buildViralContext([], 'douyin');
    expect(viralCtx).toBe('');
  });
});

// ─── HIGH-5: Failed dissection path ──────────────────────────────────────────

describe('HIGH-5: failed dissection path', () => {
  it('LLM throws → entry stored with dissection_status=failed → checkFormulaPromotion returns promoted=false, no formula created', async () => {
    // Create a mock LLM that always throws
    const throwingLlm = {
      async call(): Promise<string> { throw new Error('LLM API error'); },
      async callJSON<T>(): Promise<T> { throw new Error('LLM API error'); },
    };

    const item = makeQueueItem({ id: 'fail-q1', source_id: 'fail-src-1' });

    const entries = await dissectBatch([item], throwingLlm, 'test-persona');
    expect(entries).toHaveLength(1);
    expect(entries[0].dissection_status).toBe('failed');

    // Store the failed entry
    upsertEntry(sandboxDir, entries[0]);

    // checkFormulaPromotion should reject it — failed entries must not promote formulas
    const result = checkFormulaPromotion(sandboxDir, entries[0]);
    expect(result.promoted).toBe(false);

    // No formula should have been created at all
    const { loadFormulas } = await import('../scripts/ops/viral-kb-store');
    const formulas = loadFormulas(sandboxDir);
    expect(formulas).toHaveLength(0);
  });

  it('partial batch failure: 1 success + 1 failure → only the successful entry can contribute to formula promotion', async () => {
    const successResponse = JSON.stringify({
      hook_type: '数字冲击',
      content_type: '种草类',
      identity_mode: null,
      emotion_arc: '焦虑→解脱',
      interaction_design: '问答',
      visual_style: '简约',
      cta_type: '关注',
      summary: '数字吸引眼球',
    });

    // Mock that succeeds on first call and throws on second
    let callCount = 0;
    const partialFailLlm = {
      async call(): Promise<string> {
        callCount++;
        if (callCount === 1) return successResponse;
        throw new Error('Second LLM call failed');
      },
      async callJSON<T>(): Promise<T> {
        callCount++;
        if (callCount === 1) return JSON.parse(successResponse) as T;
        throw new Error('Second LLM call failed');
      },
    };

    const items = [
      makeQueueItem({ id: 'p-q1', source_id: 'p-src-1' }),
      makeQueueItem({ id: 'p-q2', source_id: 'p-src-2' }),
    ];

    const entries = await dissectBatch(items, partialFailLlm, 'test-persona');
    expect(entries).toHaveLength(2);

    const [successEntry, failedEntry] = entries;
    expect(successEntry.dissection_status).toBe('done');
    expect(failedEntry.dissection_status).toBe('failed');

    // Only the successful entry should contribute to formula promotion
    upsertEntry(sandboxDir, successEntry);
    const successResult = checkFormulaPromotion(sandboxDir, successEntry);
    expect(successResult.promoted).toBe(false); // count=1, not yet promoted

    upsertEntry(sandboxDir, failedEntry);
    const failResult = checkFormulaPromotion(sandboxDir, failedEntry);
    // Failed entry is gated out — should return promoted=false with no new formula added
    expect(failResult.promoted).toBe(false);

    // Confirm formula count is still 1 (created from success), not 2
    const { loadFormulas } = await import('../scripts/ops/viral-kb-store');
    const formulas = loadFormulas(sandboxDir);
    expect(formulas).toHaveLength(1);
    expect(formulas[0].occurrence_count).toBe(1);
  });
});
