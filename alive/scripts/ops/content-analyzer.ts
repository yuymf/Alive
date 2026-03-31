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

export function loadContentPatterns(): ContentPatterns {
  return readJSON<ContentPatterns>(PATHS.contentPatterns, DEFAULT_CONTENT_PATTERNS);
}

export function saveContentPatterns(patterns: ContentPatterns): void {
  writeJSON(PATHS.contentPatterns, { ...patterns, updated_at: now().toISOString() });
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
    // Sort: used patterns first (by times_used desc), then unused by discovered_at desc (newest first)
    // Remove from the end (oldest unused)
    const used = patterns.filter(p => p.times_used > 0);
    const unused = patterns.filter(p => p.times_used === 0);
    unused.sort((a, b) => b.discovered_at.localeCompare(a.discovered_at)); // newest first
    patterns = [...used, ...unused].slice(0, MAX_PATTERNS);
  }

  saveContentPatterns({ ...current, patterns });
}

export function incrementPatternUsage(type: string): void {
  const current = loadContentPatterns();
  const updatedPatterns = current.patterns.map(p =>
    p.type === type ? { ...p, times_used: p.times_used + 1 } : p,
  );
  saveContentPatterns({ ...current, patterns: updatedPatterns });
}

export function updatePatternSuccessRate(type: string, rate: number): void {
  const current = loadContentPatterns();
  const updatedPatterns = current.patterns.map(p =>
    p.type === type ? { ...p, success_rate: rate } : p,
  );
  saveContentPatterns({ ...current, patterns: updatedPatterns });
}

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
  "v_adaptation": {
    "applicable_identity": "esports/singer/racer/daily",
    "angle": "可以怎么借鉴",
    "differentiation": "差异化切入点"
  }
}`;
}
