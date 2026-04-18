/**
 * viral-analyzer.ts
 * C v1: 爆款拆解 — URL→平台检测→抓取内容→LLM分析→结构化输出
 * Analyzes external viral posts by URL to extract hook patterns, selling points,
 * comment sentiment, and content structure.
 *
 * Pure functions for URL parsing + prompt building; I/O functions for fetching + persistence.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';

const execFileAsync = promisify(execFile);
import {
  PostPlatform,
  PostContent,
  PostAnalysisResult,
  PostAnalysisLog,
  PersonaConfig,
  EngagementSignals,   // used in computeEngagementSignals (C v2)
  PostAttribution,     // used in Task 3
} from '../utils/types';
import { LLMClient } from '../utils/llm-client';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_ANALYSIS_LOG_ENTRIES = 100;

// ─── Helper ──────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute platform engagement signals from raw post metrics.
 * Weights: collected×5 > share×4 > comment×3 > like×1 (XHS platform norms).
 * Uses (likes + 1) as denominator to prevent division by zero.
 */
export function computeEngagementSignals(post: PostContent): EngagementSignals {
  const likes = post.likes;
  const collected = post.collected_count;
  const shared = post.share_count;
  const commented = post.comment_count ?? 0;
  const base = likes + 1;

  return {
    save_rate: round2(collected / base),
    share_rate: round2(shared / base),
    comment_rate: round2(commented / base),
    engagement_score: likes * 1 + collected * 5 + shared * 4 + commented * 3,
  };
}

// ─── Pure functions (exported for testing) ───────────────────────────────────

/**
 * Detect platform from URL via regex matching.
 */
export function detectPlatform(url: string): PostPlatform {
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return 'xhs';
  if (/douyin\.com|v\.douyin\.com/i.test(url)) return 'douyin';
  return 'generic';
}

/**
 * Extract note ID and xsec_token from XHS URLs.
 * Supports: /explore/{id}, /discovery/item/{id}, ?xsec_token=...
 */
export function extractXhsNoteId(url: string): { noteId: string; xsecToken: string | null } | null {
  const noteMatch = url.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/);
  if (!noteMatch) return null;
  const noteId = noteMatch[1];
  const tokenMatch = url.match(/[?&]xsec_token=([^&]+)/);
  const xsecToken = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;
  return { noteId, xsecToken };
}

/**
 * Extract video ID from Douyin URLs.
 * Supports: /video/{id}
 */
export function extractDouyinVideoId(url: string): string | null {
  const match = url.match(/\/video\/(\d+)/);
  return match ? match[1] : null;
}

const VTT_MAX_CHARS = 3000;

/**
 * Strip VTT/SRT timestamps and headers, returning clean spoken text.
 * Caps output at 3000 characters; appends truncation indicator if cut.
 */
export function stripVttTimestamps(raw: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip WEBVTT header
    if (trimmed === 'WEBVTT' || trimmed.startsWith('WEBVTT ')) continue;
    // Skip timestamp lines: 00:00:00.000 --> 00:00:01.000
    if (/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(trimmed)) continue;
    // Skip pure numeric cue identifiers (SRT style)
    if (/^\d+$/.test(trimmed)) continue;
    // Skip empty lines
    if (trimmed === '') continue;
    kept.push(trimmed);
  }

  const joined = kept.join(' ');
  if (joined.length <= VTT_MAX_CHARS) return joined;
  return joined.slice(0, VTT_MAX_CHARS) + '…（已截断）';
}

/**
 * Fetch Douyin video transcript via yt-dlp subtitle download (no video download).
 * Returns clean spoken text or null on any failure.
 */
export async function fetchDouyinTranscript(url: string): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const prefix = `alive-transcript-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outputTemplate = path.join(tmpDir, `${prefix}.%(id)s.%(ext)s`);

  let spawnedFiles: string[] = [];

  try {
    await execFileAsync(
      'yt-dlp',
      [
        '--write-auto-subs',
        '--sub-langs', 'zh-Hans,zh,en',
        '--skip-download',
        '--no-warnings',
        '-o', outputTemplate,
        url,
      ],
      { timeout: 30_000 },
    );

    // Only look at .vtt files with our prefix — avoids scanning all of /tmp
    spawnedFiles = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.vtt'))
      .map(f => path.join(tmpDir, f));

    // Priority order: zh-Hans → zh → en
    const langPriority = ['zh-Hans', 'zh', 'en'];
    for (const lang of langPriority) {
      const candidate = spawnedFiles.find(f => f.includes(`.${lang}.vtt`));
      if (candidate) {
        const raw = await fs.promises.readFile(candidate, 'utf8');
        return stripVttTimestamps(raw);
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    for (const f of spawnedFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

/**
 * Build LLM prompt for viral post analysis.
 */
export function buildAnalysisPrompt(
  post: PostContent,
  personaIdentities: string,
  signals?: EngagementSignals,
): string {
  const platformLabel = post.platform === 'xhs' ? '小红书'
    : post.platform === 'douyin' ? '抖音'
    : '通用平台';

  const commentSection = post.comments.length > 0
    ? `评论区精选（${post.comments.length}条）：\n${post.comments.slice(0, 20).map(c => `- ${c}`).join('\n')}`
    : '评论区：暂无评论数据';

  const transcriptSection = post.transcript
    ? `\n【视频转录（口播文字稿）】\n${post.transcript}\n`
    : '';

  const transcriptHint = post.transcript
    ? '（若有转录内容，请基于原文分析 hook_patterns 中的 example 和 content_structure）'
    : '';

  // C v2: engagement signal block (only when signals provided)
  const signalBlock = signals ? `
【互动信号解读】
- 收藏率: ${signals.save_rate.toFixed(2)}（${signals.save_rate > 0.3 ? '高' : signals.save_rate > 0.1 ? '中' : '低'} → ${signals.save_rate > 0.3 ? '实用/干货价值强' : signals.save_rate > 0.1 ? '有一定收藏价值' : '收藏意愿弱'}）
- 分享率: ${signals.share_rate.toFixed(2)}（${signals.share_rate > 0.2 ? '高' : signals.share_rate > 0.05 ? '中' : '低'} → ${signals.share_rate > 0.2 ? '情绪共鸣强，易传播' : signals.share_rate > 0.05 ? '有传播潜力' : '传播欲弱'}）
- 评论率: ${signals.comment_rate.toFixed(2)}（${signals.comment_rate > 0.1 ? '高' : signals.comment_rate > 0.03 ? '中' : '低'} → ${signals.comment_rate > 0.1 ? '话题争议性强' : signals.comment_rate > 0.03 ? '有一定互动深度' : '互动深度弱'}）
- 综合互动分: ${signals.engagement_score}

` : '';

  // C v2: attribution instruction section (only when signals provided)
  const attributionSection = signals ? `
5. attribution（基于以上互动信号，输出爆款因子归因，四项相加必须=100）：
   - cover_appeal: 封面吸引力贡献（整数 0-100）
   - hook_quality: 钩子质量贡献（整数 0-100）
   - content_value: 内容价值贡献（整数 0-100）
   - topic_fit: 话题契合度贡献（整数 0-100）
   - rationale: 一句话说明最主要的归因依据` : '';

  // C v2: attribution JSON example (only when signals provided)
  const attributionJson = signals ? `,
  "attribution": {"cover_appeal":40,"hook_quality":30,"content_value":25,"topic_fit":5,"rationale":"收藏率高说明内容实用价值是主因"}` : '';

  return `你是一个爆款内容分析师。请深度拆解以下${platformLabel}帖子：

【标题】${post.title}
【正文】${post.description.slice(0, 2000)}
【互动数据】点赞${post.likes} | 收藏${post.collected_count} | 分享${post.share_count}
${commentSection}${transcriptSection}
${signalBlock}
分析人设背景：${personaIdentities}

请从以下维度分析，返回 JSON${transcriptHint}：

1. hook_patterns: 钩子句式（2-4个），每个包含 formula（公式）、example（原文示例）、effectiveness_score（0-10）
2. core_selling_points: 核心卖点（3-5条）
3. comment_sentiment: 评论情绪分析
   - positive_ratio / negative_ratio / neutral_ratio（0-1，总和=1）
   - top_keywords: 高频关键词（3-5个）
   - emotional_triggers: 引发互动的情绪触发点（2-3个）
4. content_structure: 内容结构
   - opening_hook: 开头钩子策略
   - body_flow: 正文叙事流
   - closing_cta: 结尾行动号召
   - visual_strategy: 视觉策略（封面/图片/排版）${attributionSection}

\`\`\`json
{
  "hook_patterns": [{"formula":"...","example":"...","effectiveness_score":8}],
  "core_selling_points": ["..."],
  "comment_sentiment": {"positive_ratio":0.6,"negative_ratio":0.1,"neutral_ratio":0.3,"top_keywords":["..."],"emotional_triggers":["..."]},
  "content_structure": {"opening_hook":"...","body_flow":"...","closing_cta":"...","visual_strategy":"..."}${attributionJson}
}
\`\`\``;
}

/**
 * Format analysis result as WeChat Work card.
 */
export function formatAnalysisCard(result: PostAnalysisResult): string {
  const lines: string[] = [
    `🔍 爆款拆解  ${result.platform.toUpperCase()}`,
    `📝 ${result.title}`,
    '',
  ];

  // Hook patterns
  if (result.hook_patterns.length > 0) {
    lines.push('━━ 钩子句式 ━━');
    for (const h of result.hook_patterns) {
      const starCount = Math.min(Math.max(Math.round(h.effectiveness_score / 2), 1), 5);
      const stars = '⭐'.repeat(starCount);
      lines.push(`${stars} ${h.formula}`);
      lines.push(`   例：${h.example}`);
    }
    lines.push('');
  }

  // Core selling points
  if (result.core_selling_points.length > 0) {
    lines.push('━━ 核心卖点 ━━');
    result.core_selling_points.forEach(p => lines.push(`• ${p}`));
    lines.push('');
  }

  // Comment sentiment
  const cs = result.comment_sentiment;
  const hasCommentData = cs.top_keywords.length > 0 || cs.emotional_triggers.length > 0;
  lines.push('━━ 评论情绪 ━━');
  if (hasCommentData) {
    lines.push(`👍${(cs.positive_ratio * 100).toFixed(0)}%  👎${(cs.negative_ratio * 100).toFixed(0)}%  😐${(cs.neutral_ratio * 100).toFixed(0)}%`);
    if (cs.top_keywords.length > 0) {
      lines.push(`关键词：${cs.top_keywords.join('、')}`);
    }
    if (cs.emotional_triggers.length > 0) {
      lines.push(`触发点：${cs.emotional_triggers.join('、')}`);
    }
  } else {
    lines.push('暂无评论数据');
  }
  lines.push('');

  // Content structure
  const st = result.content_structure;
  lines.push('━━ 内容结构 ━━');
  lines.push(`🎣 开头：${st.opening_hook}`);
  lines.push(`📖 正文：${st.body_flow}`);
  lines.push(`📢 结尾：${st.closing_cta}`);
  lines.push(`🎨 视觉：${st.visual_strategy}`);

  // C v2: attribution block
  if (result.attribution) {
    const attr = result.attribution;
    lines.push('');
    lines.push('━━ 爆款归因 ━━');

    const renderBar = (label: string, emoji: string, pct: number): string => {
      const filled = Math.round(pct / 10);
      const empty = 10 - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);
      return `${emoji} ${label.padEnd(6)} ${bar}  ${pct}%`;
    };

    lines.push(renderBar('封面吸引力', '🎨', attr.cover_appeal));
    lines.push(renderBar('钩子质量',   '🎣', attr.hook_quality));
    lines.push(renderBar('内容价值',   '💡', attr.content_value));
    lines.push(renderBar('话题契合',   '🔥', attr.topic_fit));
    lines.push(`→ ${attr.rationale}`);
  }

  return lines.join('\n');
}

// ─── I/O functions ───────────────────────────────────────────────────────────

/**
 * Fetch XHS post content by URL.
 * Reuses xhs-client's search + detail API.
 */
export async function fetchXhsPost(url: string): Promise<PostContent> {
  const extracted = extractXhsNoteId(url);

  if (extracted?.xsecToken) {
    try {
      const { getXhsNoteDetail } = await import('../../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      const detail = await getXhsNoteDetail(extracted.noteId, extracted.xsecToken);
      return {
        platform: 'xhs',
        url,
        title: detail.title,
        description: detail.description,
        images: detail.images,
        likes: detail.likes,
        comments: detail.comments.map(c => c.content),
        collected_count: detail.collected_count,
        share_count: detail.share_count,
      };
    } catch {
      // Fall through to search fallback
    }
  }

  // Fallback: search by keyword
  try {
    const { searchXhsNotes, getXhsNoteDetail } = await import('../../sub-skills/platform/xhs-bridge/scripts/xhs-client');
    const keyword = extracted?.noteId ?? url.split('/').pop() ?? url;
    const results = await searchXhsNotes(keyword);
    if (results.length > 0) {
      const note = results[0];
      try {
        const detail = await getXhsNoteDetail(note.id, note.xsec_token);
        return {
          platform: 'xhs',
          url,
          title: detail.title,
          description: detail.description,
          images: detail.images,
          likes: detail.likes,
          comments: detail.comments.map(c => c.content),
          collected_count: detail.collected_count,
          share_count: detail.share_count,
        };
      } catch {
        return {
          platform: 'xhs',
          url,
          title: note.title,
          description: note.description ?? '',
          images: [],
          likes: note.likes,
          comments: [],
          collected_count: 0,
          share_count: 0,
        };
      }
    }
  } catch {
    // Fall through
  }

  return {
    platform: 'xhs',
    url,
    title: '获取失败',
    description: '',
    images: [],
    likes: 0,
    comments: [],
    collected_count: 0,
    share_count: 0,
  };
}

/**
 * Fetch Douyin post content by URL.
 * Uses yt-dlp-downloader ClawHub skill (same pattern as competitor-tracker).
 */
export async function fetchDouyinPost(url: string): Promise<PostContent> {
  try {
    const { execFileSync } = await import('child_process');
    const { homedir } = await import('os');
    const { join } = await import('path');
    const ytDlpDir = process.env.YTDLP_SKILLS_DIR ?? join(homedir(), '.openclaw', 'workspace', 'skills', 'yt-dlp-downloader');
    const raw = execFileSync('python3', [
      join(ytDlpDir, 'scripts', 'main.py'),
      '--url', url,
    ], { timeout: 45_000, encoding: 'utf8' });
    const info = JSON.parse(raw) as {
      title?: string;
      description?: string;
      like_count?: number;
      comment_count?: number;
      repost_count?: number;
    };
    const post: PostContent = {
      platform: 'douyin',
      url,
      title: info.title ?? '未知标题',
      description: info.description ?? '',
      images: [],
      likes: info.like_count ?? 0,
      comments: [],
      collected_count: 0,
      share_count: info.repost_count ?? 0,
    };

    const transcript = await fetchDouyinTranscript(url);
    if (transcript) {
      return { ...post, transcript };
    }
    return post;
  } catch {
    return {
      platform: 'douyin',
      url,
      title: '获取失败',
      description: '',
      images: [],
      likes: 0,
      comments: [],
      collected_count: 0,
      share_count: 0,
    };
  }
}

/**
 * Fetch generic URL content — minimal fallback.
 */
export async function fetchGenericPost(url: string): Promise<PostContent> {
  return {
    platform: 'generic',
    url,
    title: url.split('/').pop() ?? url,
    description: '',
    images: [],
    likes: 0,
    comments: [],
    collected_count: 0,
    share_count: 0,
  };
}

/**
 * Persist analysis result to log, trimming to max entries.
 */
export function persistAnalysis(result: PostAnalysisResult): void {
  const log = readJSON<PostAnalysisLog>(PATHS.postAnalysisLog, { entries: [] });
  const updated: PostAnalysisLog = {
    entries: [...log.entries, result].slice(-MAX_ANALYSIS_LOG_ENTRIES),
  };
  writeJSON(PATHS.postAnalysisLog, updated);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Analyze a post URL end-to-end: detect platform → fetch → LLM analyze → persist.
 */
export async function analyzePost(
  url: string,
  persona: PersonaConfig,
  llm: LLMClient,
): Promise<PostAnalysisResult> {
  const platform = detectPlatform(url);

  // Fetch content by platform
  let post: PostContent;
  switch (platform) {
    case 'xhs':
      post = await fetchXhsPost(url);
      break;
    case 'douyin':
      post = await fetchDouyinPost(url);
      break;
    default:
      post = await fetchGenericPost(url);
  }

  // C v2: compute engagement signals from fetched post
  const signals = computeEngagementSignals(post);

  // Build persona identities string
  const identities = [
    persona.meta.tagline,
    ...(persona.personality?.core_traits ?? []),
  ].filter(Boolean).join('、');

  // LLM analysis — pass signals for v2 attribution
  const prompt = buildAnalysisPrompt(post, identities, signals);
  const analysis = await llm.callJSON<{
    hook_patterns: PostAnalysisResult['hook_patterns'];
    core_selling_points: PostAnalysisResult['core_selling_points'];
    comment_sentiment: PostAnalysisResult['comment_sentiment'];
    content_structure: PostAnalysisResult['content_structure'];
    attribution?: PostAttribution;
  }>(prompt, 4000);

  const result: PostAnalysisResult = {
    url,
    platform,
    title: post.title,
    hook_patterns: analysis.hook_patterns ?? [],
    core_selling_points: analysis.core_selling_points ?? [],
    comment_sentiment: analysis.comment_sentiment ?? {
      positive_ratio: 0,
      negative_ratio: 0,
      neutral_ratio: 0,
      top_keywords: [],
      emotional_triggers: [],
    },
    content_structure: analysis.content_structure ?? {
      opening_hook: '',
      body_flow: '',
      closing_cta: '',
      visual_strategy: '',
    },
    analyzed_at: now().toISOString(),
    engagement_signals: signals,                      // ← new
    attribution: analysis.attribution ?? undefined,   // ← new
  };

  persistAnalysis(result);
  return result;
}
