/**
 * ops-llm-dump.test.ts
 * 全链路 Ops prompt dump — 用真实平台热榜数据组装完整 LLM context，
 * 用 capture LLM 拦截输出但不调 API，供人工审查 prompt 质量。
 *
 * 运行方式：
 *   npx vitest run alive/tests/ops/ops-llm-dump.test.ts --reporter=verbose
 *
 * 加 LLM_API_KEY 环境变量可同时看 LLM 返回：
 *   LLM_API_KEY=xxx LLM_API_BASE=xxx LLM_MODEL=xxx \
 *     npx vitest run alive/tests/ops/ops-llm-dump.test.ts --reporter=verbose
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import YAML from 'yaml';
import { setBasePaths, resetBasePaths, writeJSON, PATHS } from '../../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../../scripts/utils/time-utils';
import { LLMClient } from '../../scripts/utils/llm-client';
import {
  buildRelevancePrompt, filterByThreshold, computeVelocityScore,
  FilteredTrend, buildPersonaIdentities, normalizeIdentityMode, VALID_IDENTITY_MODES,
} from '../../scripts/ops/trend-analyzer';
import {
  buildContentPrompt, buildTemplateConstraint, buildCompetitorBenchmarks,
  selectContentTemplate,
} from '../../scripts/ops/topic-generator';
import {
  buildCompetitorContext, buildCompetitorSummary,
} from '../../scripts/ops/competitor-tracker';
import { formatBriefCard } from '../../scripts/ops/brief-generator';
import { TrendItem, CompetitorUpdate, OpsConfig, PersonaConfig } from '../../scripts/utils/types';
import { fetchDailyHotPlatform, DailyHotFetchResult } from '../../scripts/utils/dailyhot-client';

// ═══════════════════════════════════════════════════════════════════
// Formatters
// ═══════════════════════════════════════════════════════════════════

const SEP = (t: string) => `\n${'═'.repeat(70)}\n  ${t}\n${'═'.repeat(70)}`;
const LINE = () => '─'.repeat(70);

function dumpPrompt(label: string, prompt: string): void {
  console.log(SEP(label));
  console.log(prompt);
  console.log(LINE());
}

function dumpPromptAndResponse(label: string, prompt: string, response: string): void {
  console.log(SEP(label));
  console.log('\n── PROMPT ──');
  console.log(prompt);
  console.log('\n── RESPONSE ──');
  console.log(response);
  console.log(LINE());
}

// ═══════════════════════════════════════════════════════════════════
// 1. 直接从公开 API 抓取真实热榜，转成 TrendItem[]
//    使用统一 dailyhot-client，主源 dailyhot-rho-nine.vercel.app
// ═══════════════════════════════════════════════════════════════════

interface TrendCollectionResult {
  items: TrendItem[];
  platformCounts: Record<string, number>;
  diagnostics: Array<{ platform: string; source: string; status: string; detail: string }>;
}

async function fetchRealBilibiliTrends(limit = 20): Promise<TrendItem[]> {
  const res = await fetch('https://api.bilibili.com/x/web-interface/ranking/v2', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const data = await res.json() as {
    data?: { list?: Array<{ title?: string; stat?: { view?: number }; bvid?: string }> };
  };
  return (data.data?.list ?? []).slice(0, limit).map((item, idx) => ({
    platform: 'bilibili',
    keyword: item.title ?? '',
    current_volume: item.stat?.view ?? 0,
    avg_7d: 0,
    velocity_score: 0,
    rank: idx + 1,
  }));
}

async function fetchViaDailyHotClient(platform: string, limit = 20): Promise<{ items: TrendItem[]; diag: DailyHotFetchResult }> {
  const result = await fetchDailyHotPlatform(platform, { maxRetries: 2 });
  if (result.status === 'failed' || result.items.length === 0) {
    return { items: [], diag: result };
  }
  const items = result.items.slice(0, limit).map((item, idx) => ({
    platform,
    keyword: item.title ?? '',
    current_volume: item.hot ?? 0,
    avg_7d: 0,
    velocity_score: 0,
    rank: idx + 1,
  }));
  return { items, diag: result };
}

/**
 * Fallback: fetch weibo hot search directly when dailyhot-client fails.
 */
async function fetchRealWeiboTrends(limit = 20): Promise<TrendItem[]> {
  try {
    const res = await fetch('https://weibo.com/ajax/side/hotSearch', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://weibo.com/',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      ok?: number;
      data?: { realtime?: Array<{ word?: string; raw_hot?: number; num?: number }> };
    };
    if (data.ok !== 1 || !data.data?.realtime) return [];
    return data.data.realtime.slice(0, limit).map((item, idx) => ({
      platform: 'weibo',
      keyword: item.word ?? '',
      current_volume: item.raw_hot ?? item.num ?? 0,
      avg_7d: 0,
      velocity_score: 0,
      rank: idx + 1,
    })).filter(i => i.keyword !== '');
  } catch {
    return [];
  }
}

/**
 * 采集所有平台真实热榜 → 计算 velocity → 返回 TrendItem[] + 健康诊断
 * 增强版：weibo 有直连 fallback，增加 baidu 数据源
 */
async function collectRealTrends(): Promise<TrendCollectionResult> {
  const [bilibili, douyin, weibo, baidu] = await Promise.allSettled([
    fetchRealBilibiliTrends(20),
    fetchViaDailyHotClient('douyin', 20),
    fetchViaDailyHotClient('weibo', 20),
    fetchViaDailyHotClient('baidu', 15),
  ]);

  const diagnostics: TrendCollectionResult['diagnostics'] = [];
  const all: TrendItem[] = [];

  // Bilibili (direct API)
  if (bilibili.status === 'fulfilled') {
    all.push(...bilibili.value);
    diagnostics.push({ platform: 'bilibili', source: 'direct API', status: bilibili.value.length > 0 ? 'ok' : 'empty', detail: `${bilibili.value.length} items` });
  } else {
    diagnostics.push({ platform: 'bilibili', source: 'direct API', status: 'failed', detail: bilibili.reason?.message ?? 'unknown' });
  }

  // Douyin (via dailyhot-client)
  if (douyin.status === 'fulfilled') {
    all.push(...douyin.value.items);
    diagnostics.push({ platform: 'douyin', source: douyin.value.diag.sourceUrl, status: douyin.value.diag.status, detail: douyin.value.diag.detail });
  } else {
    diagnostics.push({ platform: 'douyin', source: 'dailyhot-client', status: 'failed', detail: douyin.reason?.message ?? 'unknown' });
  }

  // Weibo (via dailyhot-client, with direct API fallback)
  if (weibo.status === 'fulfilled' && weibo.value.items.length > 0) {
    all.push(...weibo.value.items);
    diagnostics.push({ platform: 'weibo', source: weibo.value.diag.sourceUrl, status: weibo.value.diag.status, detail: weibo.value.diag.detail });
  } else {
    const dailyhotDetail = weibo.status === 'fulfilled'
      ? weibo.value.diag.detail
      : (weibo.reason?.message ?? 'unknown');
    // Fallback to direct weibo API
    const weiboFallback = await fetchRealWeiboTrends(20);
    if (weiboFallback.length > 0) {
      all.push(...weiboFallback);
      diagnostics.push({ platform: 'weibo', source: 'direct API (fallback)', status: 'ok', detail: `${weiboFallback.length} items (dailyhot failed: ${dailyhotDetail})` });
    } else {
      diagnostics.push({ platform: 'weibo', source: 'dailyhot + direct fallback', status: 'failed', detail: `both failed (dailyhot: ${dailyhotDetail})` });
    }
  }

  // Baidu (via dailyhot-client)
  if (baidu.status === 'fulfilled' && baidu.value.items.length > 0) {
    all.push(...baidu.value.items);
    diagnostics.push({ platform: 'baidu', source: baidu.value.diag.sourceUrl, status: baidu.value.diag.status, detail: baidu.value.diag.detail });
  } else {
    diagnostics.push({ platform: 'baidu', source: 'dailyhot-client', status: 'failed', detail: baidu.status === 'fulfilled' ? baidu.value.diag.detail : (baidu.reason?.message ?? 'unknown') });
  }

  // 无历史数据时模拟 7 日均值：头部热点涨幅大，尾部相对平稳
  const items = all.map(item => {
    const rankFactor = 0.3 + 0.5 * (item.rank / Math.max(all.length, 1));
    const baseline = Math.round(item.current_volume * rankFactor);
    const velocity = computeVelocityScore(item.current_volume, baseline);
    return { ...item, avg_7d: baseline, velocity_score: velocity };
  });

  const platformCounts: Record<string, number> = {};
  for (const t of items) platformCounts[t.platform] = (platformCounts[t.platform] ?? 0) + 1;

  return { items, platformCounts, diagnostics };
}

// ═══════════════════════════════════════════════════════════════════
// 2. 读取真实 Miss V persona 配置
// ═══════════════════════════════════════════════════════════════════

function loadMissVPersona(): PersonaConfig {
  const raw = fs.readFileSync(
    path.join(__dirname, '../../personas/miss-v.yaml'), 'utf8',
  );
  return YAML.parse(raw) as PersonaConfig;
}

// ═══════════════════════════════════════════════════════════════════
// 3. Capture LLM — 拦截 prompt，可选调真实 API
// ═══════════════════════════════════════════════════════════════════

interface CapturedCall { label: string; prompt: string; response: string | null }

function createCaptureLLM(realLLM?: LLMClient): LLMClient & { captured: CapturedCall[] } {
  const captured: CapturedCall[] = [];
  return {
    captured,
    async call(prompt: string, maxTokens?: number): Promise<string> {
      if (realLLM) {
        const resp = await realLLM.call(prompt, maxTokens);
        captured.push({ label: 'call', prompt, response: resp });
        return resp;
      }
      captured.push({ label: 'call', prompt, response: null });
      return '{}';
    },
    async callJSON<T>(prompt: string, maxTokens?: number): Promise<T> {
      if (realLLM) {
        try {
          const resp = await realLLM.callJSON<T>(prompt, maxTokens);
          captured.push({ label: 'callJSON', prompt, response: JSON.stringify(resp, null, 2) });
          return resp;
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          captured.push({ label: 'callJSON:REFUSED', prompt, response: msg });
          console.error(`\n⚠️ LLM REFUSAL/ERROR:\n${msg}\n`);
          // Return empty result so test continues
          if (prompt.includes('JSON 数组') || prompt.includes('topics')) return [] as unknown as T;
          return {} as T;
        }
      }
      captured.push({ label: 'callJSON', prompt, response: null });
      if (prompt.includes('JSON 数组') || prompt.includes('topics')) return [] as unknown as T;
      return {} as T;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-llm-dump-'));
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-01T09:00:00+08:00'));
  writeJSON(path.join(tmpDir, 'trend-history.json'), []);
  writeJSON(path.join(tmpDir, 'review-queue.json'), { items: [], last_cleanup: '' });
  writeJSON(path.join(tmpDir, 'competitor-log.json'), { entries: [], last_updated: '' });
});

afterEach(() => {
  clearTimeOverride();
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// A. 热点采集 + 相关度筛选 Prompt
// ═══════════════════════════════════════════════════════════════════

describe('A. 热点采集 → 相关度筛选 Prompt', () => {
  it('真实热榜数据 → velocity 过滤 → LLM relevance prompt', async () => {
    const persona = loadMissVPersona();
    const ops = persona.ops!;
    const identities = buildPersonaIdentities(persona);

    // ── 1. 真实采集 ──
    const { items: allTrends, platformCounts, diagnostics } = await collectRealTrends();
    console.log(SEP(`A-1. 真实热榜采集（${allTrends.length} 条）`));
    console.log('平台分布:', JSON.stringify(platformCounts));
    console.log('\n📋 数据源健康:');
    for (const d of diagnostics) {
      console.log(`  [${d.status.toUpperCase()}] ${d.platform} ← ${d.source} (${d.detail})`);
    }
    console.log('\nTOP 10:');
    for (const t of allTrends.slice(0, 10)) {
      console.log(`  ${t.velocity_score.toFixed(2)}x  [${t.platform}]  ${t.keyword}  (vol=${t.current_volume})`);
    }

    // ── 2. Velocity 过滤 ──
    const aboveThreshold = filterByThreshold(allTrends, ops.trend_score_threshold);
    console.log(SEP(`A-2. Velocity 过滤（阈值 ${ops.trend_score_threshold}）→ ${aboveThreshold.length} 条`));
    for (const t of aboveThreshold.slice(0, 15)) {
      console.log(`  ${t.velocity_score.toFixed(2)}x  [${t.platform}]  ${t.keyword}`);
    }

    // ── 3. 组装 LLM relevance prompt ──
    const prompt = buildRelevancePrompt(aboveThreshold, identities, ops.topic_count);
    dumpPrompt('A-3. LLM 相关度筛选 Prompt（真实数据）', prompt);

    expect(allTrends.length).toBeGreaterThan(0);
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// B. 竞品上下文（真实 persona config）
// ═══════════════════════════════════════════════════════════════════

describe('B. 竞品上下文（真实 persona 竞品画像）', () => {
  it('用 Miss V 全部竞品画像构建 LLM context', () => {
    const persona = loadMissVPersona();
    const ops = persona.ops!;
    const competitors = ops.competitors ?? [];

    // 用空的 live updates（竞品 API 不可用时不影响 prompt 结构）
    const emptyUpdates: CompetitorUpdate[] = [];
    const ctx = buildCompetitorContext(competitors, emptyUpdates);

    console.log(SEP(`B-1. 竞品上下文（${competitors.length} 个竞品画像）`));
    console.log(ctx);
    console.log(LINE());

    // 分 identity 看竞品基准
    for (const mode of ['esports', 'singer', 'racer', 'daily'] as const) {
      const benchmarks = buildCompetitorBenchmarks(competitors, mode, ops.content_templates);
      if (benchmarks.length > 0) {
        console.log(`\n📊 竞品基准 [${mode}]: ${benchmarks.length} 个`);
        for (const b of benchmarks) {
          console.log(`  @${b.name}（${b.platform}）内容=${b.content_mix_relevant} 受众=${b.audience}`);
        }
      }
    }
    console.log(LINE());

    expect(competitors.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// C. 内容生成 Prompt（真实热榜 + 真实 persona 配置）
// ═══════════════════════════════════════════════════════════════════

describe('C. 内容生成 Prompt（真实热榜 + 真实 persona）', () => {
  it('XHS + Douyin prompts from real trends × real config', async () => {
    const persona = loadMissVPersona();
    const ops = persona.ops!;
    const competitors = ops.competitors ?? [];
    const templates = ops.content_templates ?? [];

    // ── 采集真实热榜 ──
    const { items: allTrends } = await collectRealTrends();
    let above = filterByThreshold(allTrends, ops.trend_score_threshold);
    // 如果阈值过高导致为空，降级使用所有数据（按 velocity 降序取前 5）
    if (above.length === 0) {
      above = [...allTrends].sort((a, b) => b.velocity_score - a.velocity_score).slice(0, 5);
      console.log(`⚠️ 阈值 ${ops.trend_score_threshold} 过滤后为空，降级取 velocity TOP ${above.length}`);
    }

    // 取前 3 条作为 FilteredTrend（模拟 LLM 筛选结果，赋予 hook_angle）
    const identityModes = ['esports', 'singer', 'racer', 'daily'] as const;
    const simulatedFiltered: FilteredTrend[] = above.slice(0, 3).map((t, i) => ({
      ...t,
      hook_angle: `以${persona.meta.name}${identityModes[i % 4]}身份切入「${t.keyword}」`,
      identity_mode: identityModes[i % 4],
    }));

    // ── 竞品上下文（一次性构建）──
    const competitorCtx = buildCompetitorContext(competitors, []);

    // ── 逐条生成 prompt ──
    for (const [idx, trend] of simulatedFiltered.entries()) {
      const mode = trend.identity_mode;
      const template = selectContentTemplate(templates, mode, trend.keyword);
      const templateConstraint = template ? buildTemplateConstraint(template) : '';
      const benchmarks = buildCompetitorBenchmarks(competitors, mode, templates);

      const contextParts: string[] = [];
      if (templateConstraint) contextParts.push(templateConstraint);
      if (competitorCtx) contextParts.push(`【对标竞品参考】\n${competitorCtx}`);
      const extra = contextParts.join('\n\n');

      // XHS
      const xhsStyle = ops.platforms.xhs?.style ?? '图文为主';
      const xhsPrompt = buildContentPrompt(
        trend, `${persona.meta.name}，${persona.meta.age}岁，${(persona.personality?.core_traits ?? []).slice(0, 2).join('，')}`,
        'xhs', xhsStyle, extra,
      );
      dumpPrompt(`C-${idx + 1}a. 小红书图文 [${mode}] 「${trend.keyword}」`, xhsPrompt);

      // Douyin
      const douyinStyle = ops.platforms.douyin?.style ?? '视频脚本';
      const douyinPrompt = buildContentPrompt(
        trend, `${persona.meta.name}，${persona.meta.age}岁，${(persona.personality?.core_traits ?? []).slice(0, 2).join('，')}`,
        'douyin', douyinStyle, extra,
      );
      dumpPrompt(`C-${idx + 1}b. 抖音脚本 [${mode}] 「${trend.keyword}」`, douyinPrompt);

      console.log(`📐 模板: ${template ? template.type : '无匹配'} | 竞品基准: ${benchmarks.length} 个`);
    }

    expect(simulatedFiltered.length).toBeGreaterThan(0);
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// D. 每日简报（真实热榜 + 真实 persona → 完整卡片）
// ═══════════════════════════════════════════════════════════════════

describe('D. 每日简报（真实热榜 → 完整卡片）', () => {
  it('真实数据组装企业微信推送卡片', async () => {
    const persona = loadMissVPersona();
    const ops = persona.ops!;

    const { items: allTrends } = await collectRealTrends();
    const above = filterByThreshold(allTrends, ops.trend_score_threshold);
    const identityModes = ['esports', 'singer', 'racer', 'daily'] as const;
    const filtered: FilteredTrend[] = above.slice(0, 5).map((t, i) => ({
      ...t,
      hook_angle: `用${identityModes[i % 4]}身份切入`,
      identity_mode: identityModes[i % 4],
    }));

    // 模拟 review queue 里的待审选题
    const mockQueue = filtered.slice(0, ops.topic_count).map((t, i) => ({
      id: `q-${String(i + 1).padStart(3, '0')}`,
      topic: `蹭 ${t.keyword}：${t.hook_angle}`,
      trend_hook: `${t.keyword} (${t.platform}, ${t.velocity_score.toFixed(1)}x)`,
      identity_mode: t.identity_mode as 'esports' | 'singer' | 'racer' | 'daily',
      status: 'pending' as const,
      content: {
        xhs: { title: `[待生成] ${t.keyword}`, body: '', tags: [], cover_images: [] },
        douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    const brief = formatBriefCard('2026-04-01', filtered, [], mockQueue);
    dumpPrompt('D. 每日简报卡片（真实热榜 → 企业微信推送）', brief);

    expect(brief).toContain('今日简报');
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// E. 端到端 Real LLM（需要 LLM_API_KEY）
// ═══════════════════════════════════════════════════════════════════

describe('E. 端到端 Real LLM（真实热榜 + 真实 LLM）', () => {
  const apiKey = process.env.LLM_API_KEY;
  const shouldRun = !!apiKey;

  // Shared relevance results for E-2/E-3
  let relevanceTopics: FilteredTrend[] = [];
  let sharedTrends: TrendItem[] = [];

  it.skipIf(!shouldRun)('热点筛选 → LLM 返回', async () => {
    const { createRealLLMClient } = await import('../../scripts/utils/llm-client');
    const persona = loadMissVPersona();
    const ops = persona.ops!;
    const identities = buildPersonaIdentities(persona);

    const { items: allTrends, diagnostics } = await collectRealTrends();
    sharedTrends = allTrends;
    console.log('📋 E-1 数据源健康:');
    for (const d of diagnostics) {
      console.log(`  [${d.status.toUpperCase()}] ${d.platform} ← ${d.source} (${d.detail})`);
    }

    const above = filterByThreshold(allTrends, ops.trend_score_threshold);
    const prompt = buildRelevancePrompt(above, identities, ops.topic_count);

    const llm = createCaptureLLM(createRealLLMClient('ops-dump-test'));
    const result = await llm.callJSON<{ topics?: Array<{ keyword: string; platform: string; velocity_score: number; hook_angle: string; identity_mode: string }> }>(prompt, 4000);

    // Parse relevance results — support both envelope and legacy array
    const topics = Array.isArray(result) ? result : (result.topics ?? []);
    relevanceTopics = topics.map(t => {
      const match = above.find(a => a.keyword === t.keyword && a.platform === t.platform);
      // Normalize identity_mode (catches LLM hallucinations like "women_power")
      const validMode = normalizeIdentityMode(t.identity_mode ?? 'esports');
      return {
        ...(match ?? above[0]),
        hook_angle: t.hook_angle ?? '专业视角解读',
        identity_mode: validMode,
      };
    });

    // Validate: all identity_modes must be valid after normalization
    for (const topic of relevanceTopics) {
      expect(VALID_IDENTITY_MODES).toContain(topic.identity_mode);
    }

    dumpPromptAndResponse('E-1. 热点相关度筛选 (Real LLM + 真实热榜)', prompt, JSON.stringify(result, null, 2));
  }, 120_000);

  it.skipIf(!shouldRun)('内容生成 → LLM 返回（XHS）', async () => {
    const { createRealLLMClient } = await import('../../scripts/utils/llm-client');
    const persona = loadMissVPersona();
    const ops = persona.ops!;
    const competitors = ops.competitors ?? [];
    const templates = ops.content_templates ?? [];

    // Use relevance-driven topic if available, otherwise deterministic fallback
    let trend: FilteredTrend;
    if (relevanceTopics.length > 0) {
      trend = relevanceTopics[0];
      console.log(`✅ 使用 E-1 relevance 结果: [${trend.identity_mode}] ${trend.keyword}`);
    } else {
      // Fallback: use shared trends with deterministic identity
      if (sharedTrends.length === 0) {
        const { items } = await collectRealTrends();
        sharedTrends = items;
      }
      const above = filterByThreshold(sharedTrends, ops.trend_score_threshold);
      if (above.length === 0) { console.log('⚠️ 无高 velocity 热点，跳过'); return; }
      trend = { ...above[0], hook_angle: `以专业视角解读「${above[0].keyword}」`, identity_mode: 'esports' };
      console.log(`⚠️ E-1 无结果，使用 fallback: [${trend.identity_mode}] ${trend.keyword}`);
    }

    const mode = trend.identity_mode;
    const template = selectContentTemplate(templates, mode, trend.keyword);
    const templateConstraint = template ? buildTemplateConstraint(template) : '';
    const competitorCtx = buildCompetitorContext(competitors, [], { identityMode: mode, maxProfiles: 3, maxBulletsPerSection: 3 });
    const extra = [templateConstraint, competitorCtx ? `【对标竞品参考】\n${competitorCtx}` : ''].filter(Boolean).join('\n\n');
    const xhsStyle = ops.platforms.xhs?.style ?? '图文为主';

    const prompt = buildContentPrompt(
      trend, `${persona.meta.name}，${persona.meta.age}岁电竞解说/歌手/赛车手`,
      'xhs', xhsStyle, extra,
    );

    const llm = createCaptureLLM(createRealLLMClient('ops-dump-test'));
    const result = await llm.callJSON<unknown>(prompt, 1500);
    dumpPromptAndResponse(`E-2. 小红书图文 [${mode}] (Real LLM + 真实热榜)`, prompt, JSON.stringify(result, null, 2));
  }, 120_000);

  it.skipIf(!shouldRun)('内容生成 → LLM 返回（Douyin）', async () => {
    const { createRealLLMClient } = await import('../../scripts/utils/llm-client');
    const persona = loadMissVPersona();
    const ops = persona.ops!;
    const templates = ops.content_templates ?? [];
    const competitors = ops.competitors ?? [];

    // Use second relevance topic if available
    let trend: FilteredTrend;
    if (relevanceTopics.length >= 2) {
      trend = relevanceTopics[1];
      console.log(`✅ 使用 E-1 relevance 结果 #2: [${trend.identity_mode}] ${trend.keyword}`);
    } else if (relevanceTopics.length === 1) {
      trend = relevanceTopics[0];
      console.log(`⚠️ E-1 只有 1 个结果，复用: [${trend.identity_mode}] ${trend.keyword}`);
    } else {
      if (sharedTrends.length === 0) {
        const { items } = await collectRealTrends();
        sharedTrends = items;
      }
      const above = filterByThreshold(sharedTrends, ops.trend_score_threshold);
      if (above.length < 2) { console.log('⚠️ 热点不足，跳过'); return; }
      trend = { ...above[1], hook_angle: `真实体验 vs 网络热议：「${above[1].keyword}」`, identity_mode: 'daily' };
      console.log(`⚠️ E-1 无结果，使用 fallback: [${trend.identity_mode}] ${trend.keyword}`);
    }

    const mode = trend.identity_mode;
    const template = selectContentTemplate(templates, mode, trend.keyword);
    const templateConstraint = template ? buildTemplateConstraint(template) : '';
    const competitorCtx = buildCompetitorContext(competitors, [], { identityMode: mode, maxProfiles: 3, maxBulletsPerSection: 3 });
    const extra = [templateConstraint, competitorCtx ? `【对标竞品参考】\n${competitorCtx}` : ''].filter(Boolean).join('\n\n');
    const douyinStyle = ops.platforms.douyin?.style ?? '视频脚本';

    const prompt = buildContentPrompt(
      trend, `${persona.meta.name}，${persona.meta.age}岁电竞解说/歌手/赛车手`,
      'douyin', douyinStyle, extra,
    );

    const llm = createCaptureLLM(createRealLLMClient('ops-dump-test'));
    const result = await llm.callJSON<unknown>(prompt, 1500);
    dumpPromptAndResponse(`E-3. 抖音脚本 [${mode}] (Real LLM + 真实热榜)`, prompt, JSON.stringify(result, null, 2));
  }, 120_000);
});
