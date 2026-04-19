/**
 * content-analyzer.ts
 * Deep competitor content analysis — extracts reusable patterns from viral posts.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { ContentPatterns, ContentPattern, CompetitorInsight, CoverTrend } from '../utils/types';

export const DEFAULT_CONTENT_PATTERNS: ContentPatterns = {
  updated_at: '',
  patterns: [],
  competitor_insights: [],
  cover_trends: [],
};

const MAX_PATTERNS = 30;

/** Eviction threshold: patterns with success_rate < this AND times_used >= MIN_EVICT_USES are eligible */
const EVICT_SUCCESS_THRESHOLD = 0.15;
const MIN_EVICT_USES = 3;

export function loadContentPatterns(): ContentPatterns {
  return readJSON<ContentPatterns>(PATHS.contentPatterns, DEFAULT_CONTENT_PATTERNS);
}

export function saveContentPatterns(patterns: ContentPatterns): void {
  writeJSON(PATHS.contentPatterns, { ...patterns, updated_at: now().toISOString() });
}

/**
 * Evict stale/underperforming patterns.
 * Called periodically (e.g. after addPattern or from health-check).
 * Removes patterns with success_rate < 0.15 AND times_used >= 3.
 */
export function evictStalePatterns(maxPatterns?: number): number {
  const current = loadContentPatterns();
  const limit = maxPatterns ?? MAX_PATTERNS;
  const before = current.patterns.length;

  // Phase 1: remove truly stale patterns (low success + enough data)
  let patterns = current.patterns.filter(p => {
    if (p.times_used >= MIN_EVICT_USES && p.success_rate !== null && p.success_rate < EVICT_SUCCESS_THRESHOLD) {
      return false; // evict
    }
    return true;
  });

  // Phase 2: if still over limit, trim by combined score (lowest first)
  if (patterns.length > limit) {
    patterns.sort((a, b) => {
      const scoreA = (a.success_rate ?? 0.5) * Math.log2(a.times_used + 1);
      const scoreB = (b.success_rate ?? 0.5) * Math.log2(b.times_used + 1);
      return scoreB - scoreA;
    });
    patterns = patterns.slice(0, limit);
  }

  const evicted = before - patterns.length;
  if (evicted > 0) {
    saveContentPatterns({ ...current, patterns });
    console.log(`[content-analyzer] Evicted ${evicted} stale patterns (${before} → ${patterns.length})`);
  }
  return evicted;
}

interface AddPatternInput {
  type: string;
  source: string;
  source_post: string;
  formula: string;
  examples: string[];
}

export function addPattern(input: AddPatternInput): void {
  const current = loadContentPatterns();
  const newPattern: ContentPattern = {
    type: input.type,
    source: input.source,
    source_post: input.source_post,
    formula: input.formula,
    success_rate: null,
    times_used: 0,
    examples: input.examples,
    discovered_at: now().toISOString().slice(0, 10),
  };

  let patterns = [...current.patterns, newPattern];

  if (patterns.length > MAX_PATTERNS) {
    const used = patterns.filter(p => p.times_used > 0);
    const unused = patterns.filter(p => p.times_used === 0);
    // Sort unused: newest first (keep newer, evict older)
    const sortedUnused = [...unused].sort((a, b) => b.discovered_at.localeCompare(a.discovered_at));

    if (used.length >= MAX_PATTERNS) {
      // Force evict least-used pattern to make room for new one
      const sortedUsed = [...used].sort((a, b) => b.times_used - a.times_used);
      patterns = [...sortedUsed.slice(0, MAX_PATTERNS - 1), newPattern];
    } else {
      patterns = [...used, ...sortedUnused].slice(0, MAX_PATTERNS);
    }
  }

  // Inline eviction on the already-computed patterns array (avoid double load+save)
  const limit = MAX_PATTERNS;
  let finalPatterns = patterns.filter(p => {
    if (p.times_used >= MIN_EVICT_USES && p.success_rate !== null && p.success_rate < EVICT_SUCCESS_THRESHOLD) {
      return false;
    }
    return true;
  });
  if (finalPatterns.length > limit) {
    finalPatterns.sort((a, b) => {
      const scoreA = (a.success_rate ?? 0.5) * Math.log2(a.times_used + 1);
      const scoreB = (b.success_rate ?? 0.5) * Math.log2(b.times_used + 1);
      return scoreB - scoreA;
    });
    finalPatterns = finalPatterns.slice(0, limit);
  }

  saveContentPatterns({ ...current, patterns: finalPatterns });
}

export function incrementPatternUsage(type: string, source: string): void {
  const current = loadContentPatterns();
  const updatedPatterns = current.patterns.map(p =>
    p.type === type && p.source === source ? { ...p, times_used: p.times_used + 1 } : p,
  );
  saveContentPatterns({ ...current, patterns: updatedPatterns });
}

export function updatePatternSuccessRate(type: string, source: string, rate: number): void {
  const current = loadContentPatterns();
  const updatedPatterns = current.patterns.map(p =>
    p.type === type && p.source === source ? { ...p, success_rate: rate } : p,
  );
  saveContentPatterns({ ...current, patterns: updatedPatterns });
}

/**
 * @deprecated Use `syncCompetitorInsights()` from competitor-memory.ts instead.
 * Competitor insights are now managed as part of the MD knowledge surface
 * (competitor profiles) rather than stored in ContentPatterns JSON.
 * This function is retained for JSON backward compatibility only.
 */
export function saveCompetitorInsights(insights: CompetitorInsight[]): void {
  const current = loadContentPatterns();
  saveContentPatterns({ ...current, competitor_insights: insights });
}

export function saveCoverTrends(trends: CoverTrend[]): void {
  const current = loadContentPatterns();
  saveContentPatterns({ ...current, cover_trends: trends.slice(0, 10) });
}

export function getRelevantPatterns(): string {
  const current = loadContentPatterns();
  if (current.patterns.length === 0) return '';
  return current.patterns
    .slice(0, 5)
    .map(p => `- ${p.type}：${p.formula}（来源：${p.source}，使用${p.times_used}次${p.success_rate !== null ? `，成功率${(p.success_rate * 100).toFixed(0)}%` : ''}）`)
    .join('\n');
}

interface CompetitorInfo {
  name: string;
  platform: string;
  tag_desc: string;
  content_mix?: Record<string, number>;
}

interface PostInfo {
  title: string;
  content: string;
  likes: number;
  comments: number;
  saves?: number;
}

export function buildAnalysisPrompt(
  competitor: CompetitorInfo,
  post: PostInfo,
  personaSummary: string,
): string {
  const mixStr = competitor.content_mix
    ? Object.entries(competitor.content_mix).map(([k, v]) => `${k}${v}%`).join('、')
    : '未知';

  return `你是内容分析专家。深度拆解以下爆款帖子，提炼可复用的模式。

【帖子信息】
作者: ${competitor.name} (${competitor.platform})
标题: ${post.title}
正文/脚本: ${post.content}
互动: ${post.likes}赞 ${post.comments}评${post.saves ? ` ${post.saves}藏` : ''}

【作者人设】
${competitor.tag_desc}
内容比例: ${mixStr}

【我方人设参考】
${personaSummary}

请输出JSON:
{
  "title_formula": {
    "type": "反问句/数据hook/情绪对比/悬念/...",
    "pattern": "具体公式描述",
    "example": "原标题"
  },
  "content_structure": {
    "hook": "开头策略",
    "body": "论证方式",
    "cta": "结尾互动方式"
  },
  "viral_factors": ["爆款因素1", "爆款因素2"],
  "persona_adaptation": {
    "applicable_identity": "${personaSummary}",
    "angle": "可以怎么借鉴",
    "differentiation": "差异化切入点"
  }
}`;
}
