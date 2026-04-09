/**
 * competitor-analyzer.ts
 * Layer 2 — Per-account LLM analysis for the competitor analysis pipeline.
 *
 * For each competitor account with sufficient post data, builds a structured
 * Chinese-language prompt and calls the LLM to extract hook patterns, topic
 * clusters, engagement patterns, and a key insight.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { wallNow } from '../utils/time-utils';
import type {
  CompetitorPostsStore,
  CompetitorProfile,
  CompetitorPost,
  AccountAnalysis,
  CompetitorAnalysisStore,
  HookFormula,
} from '../utils/types';
import type { LLMClient } from '../utils/llm-client';
import { buildAccountKey, parseAccountKey } from './competitor-fetcher';
import { loadFormulaStore, saveFormulaStore, mergeAccountFormulas } from './formula-store';
import { identityModeForLabel, ALL_IDENTITY_MODES } from './ops-taxonomy';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MIN_POSTS_FOR_ANALYSIS = 5;

// ─── Default store ────────────────────────────────────────────────────────────

function defaultStore(): CompetitorAnalysisStore {
  return {
    version: 1,
    analyses: {},
    insufficient_data: [],
    last_analyzed: wallNow().toISOString(),
  };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build a Chinese-language LLM prompt for per-account analysis.
 * Includes account metadata from the profile and a numbered post list.
 */
export function buildAnalysisPrompt(
  profile: CompetitorProfile,
  posts: readonly CompetitorPost[],
): string {
  const contentMixSection = profile.content_mix
    ? `\n- 历史内容标注 （历史参考，仅供背景了解，请勿以此限制聚类：${
        Object.entries(profile.content_mix)
          .map(([k, v]) => `${k} ${v}%`)
          .join('、')
      }）（请从帖子标题自行归纳内容簇）`
    : '';

  const postLines = posts
    .map((p, i) => {
      const date = p.posted_at ? ` | 发布时间: ${p.posted_at.slice(0, 10)}` : '';
      return `${i + 1}. 标题: ${p.title} | 互动量: ${p.engagement}${date}`;
    })
    .join('\n');

  return `你是一位专业的社交媒体内容分析师。请对以下竞品账号的近期内容进行深度分析。

## 账号基本信息

- 账号名称: ${profile.name}
- 平台: ${profile.platform}
- 内容定位: ${profile.tag_desc}${contentMixSection}${profile.audience ? `\n- 目标受众: ${profile.audience}` : ''}${profile.interaction_style ? `\n- 互动风格: ${profile.interaction_style}` : ''}

## 近期帖子列表 (共 ${posts.length} 条)

${postLines}

## 输出要求

请严格按照以下 JSON 格式输出分析结果，不要包含任何额外说明：

\`\`\`json
{
  "hook_patterns": [
    {
      "pattern": "分类名称（例如：数字冲击型、痛点直击型）",
      "formula": "可复用句式模板，用[占位符]标记变量部分，例如：[数字]个[身份]不会告诉你的[场景]秘密（必须是可直接套用的句式，不能是描述性文字）",
      "examples": ["原文标题1", "原文标题2"],
      "frequency": "高/中/低"
    }
  ],
  "cover_formulas": [
    {
      "formula": "封面公式描述",
      "usage_ratio": "使用比例（如：40%）",
      "effectiveness": "效果评估"
    }
  ],
  "topic_clusters": [
    {
      "cluster_name": "话题集群名称",
      "post_count": 0,
      "avg_engagement": 0,
      "representative_titles": ["代表性标题1", "代表性标题2"]
    }
  ],
  "engagement_pattern": {
    "best_performing_type": "最高互动内容类型",
    "avg_engagement": 0,
    "posting_frequency": "发布频率描述（如：每天1-2条）",
    "peak_days": ["周一", "周三"]
  },
  "key_insight": "最核心的一条竞品洞察，指出可借鉴或需规避的策略要点"
}
\`\`\``;
}

// ─── Response parser ──────────────────────────────────────────────────────────

/**
 * Parse the LLM's raw string response into an AccountAnalysis.
 * Strips markdown fences, validates required fields, and overrides
 * account_name, platform, and analyzed_at with canonical values.
 */
export function parseAnalysisResponse(
  raw: string,
  accountName: string,
  platform: string,
): AccountAnalysis | null {
  try {
    // Strip markdown fences
    const stripped = raw
      .replace(/^```(?:json)?\s*/im, '')
      .replace(/\s*```\s*$/im, '')
      .trim();

    const parsed = JSON.parse(stripped) as Record<string, unknown>;

    // Validate required fields
    const requiredFields = ['hook_patterns', 'topic_clusters', 'engagement_pattern', 'key_insight'];
    for (const field of requiredFields) {
      if (!(field in parsed)) {
        return null;
      }
    }

    // Normalize hook_patterns to guarantee formula field is always present
    const rawPatterns = Array.isArray(parsed['hook_patterns']) ? parsed['hook_patterns'] : [];
    const hook_patterns = rawPatterns.map((p: Record<string, unknown>) => ({
      pattern: (p['pattern'] as string) ?? '',
      formula: (p['formula'] as string) ?? '',
      examples: Array.isArray(p['examples']) ? p['examples'] as string[] : [],
      frequency: (p['frequency'] as string) ?? '低',
    }));

    const analysis: AccountAnalysis = {
      ...(parsed as Omit<AccountAnalysis, 'account_name' | 'platform' | 'analyzed_at' | 'hook_patterns'>),
      hook_patterns,
      account_name: accountName,
      platform,
      analyzed_at: wallNow().toISOString(),
    } as AccountAnalysis;

    return analysis;
  } catch {
    return null;
  }
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * For each account in postsStore, run LLM analysis if it has enough posts.
 * Accounts with fewer than MIN_POSTS_FOR_ANALYSIS posts are added to insufficient_data.
 */
export async function analyzeCompetitors(
  postsStore: CompetitorPostsStore,
  profiles: readonly CompetitorProfile[],
  llm: LLMClient,
): Promise<CompetitorAnalysisStore> {
  const analyses: Record<string, AccountAnalysis> = {};
  const insufficient_data: string[] = [];
  let formulaStore = loadFormulaStore();

  for (const [accountKey, posts] of Object.entries(postsStore.accounts)) {
    if (posts.length < MIN_POSTS_FOR_ANALYSIS) {
      insufficient_data.push(accountKey);
      continue;
    }

    // Derive account name and platform from the key ("name:platform")
    const { name: accountName, platform } = parseAccountKey(accountKey);

    // Find matching profile
    const profile = profiles.find(
      (p) => buildAccountKey(p.name, p.platform) === accountKey,
    ) ?? {
      name: accountName,
      platform: platform as CompetitorProfile['platform'],
      tag: '',
      tag_desc: accountName,
      reference_type: 'secondary' as const,
    };

    const prompt = buildAnalysisPrompt(profile, posts);

    try {
      const raw = await llm.call(prompt);
      const analysis = parseAnalysisResponse(raw, accountName, platform);
      if (analysis !== null) {
        analyses[accountKey] = { ...analysis, auto_cluster: true } as AccountAnalysis;

        // Determine identity mode(s) for this account
        const label = (profile as { group?: string }).group ?? profile.tag;
        const singleMode = identityModeForLabel(label);
        const modes = singleMode ? [singleMode] : ALL_IDENTITY_MODES;

        // Map HookPatternAnalysis → HookFormula (skip patterns with no formula)
        const formulas: HookFormula[] = analysis.hook_patterns
          .filter(p => p.formula && p.formula.trim() !== '')
          .map(p => ({
            formula: p.formula,
            examples: [...p.examples],
            frequency: p.frequency as '高' | '中' | '低',
            source_account: accountKey,
            source_platform: profile.platform,
            last_analyzed: analysis.analyzed_at,
          }));

        if (formulas.length > 0) {
          formulaStore = mergeAccountFormulas(formulaStore, modes, accountKey, formulas);
        }
      }
    } catch {
      // Individual account failure never blocks the rest
    }
  }

  saveFormulaStore(formulaStore);

  return {
    version: 1,
    analyses,
    insufficient_data,
    last_analyzed: wallNow().toISOString(),
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export function loadCompetitorAnalysis(): CompetitorAnalysisStore {
  return readJSON<CompetitorAnalysisStore>(PATHS.competitorAnalysis, defaultStore());
}

export function saveCompetitorAnalysis(store: CompetitorAnalysisStore): void {
  writeJSON(PATHS.competitorAnalysis, store);
}
