/**
 * competitor-memory.ts
 * Markdown-based competitor knowledge base — living profiles and hit
 * content breakdowns stored as individual .md files with YAML frontmatter.
 *
 * Supports both manual and automatic input, with retrieval filtered
 * by identity mode (赛道) for LLM prompt injection.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { PATHS } from '../utils/file-utils';
import { now, wallNow, getLocalDate } from '../utils/time-utils';
import {
  CompetitorProfile,
  CompetitorDoc,
  CompetitorDocFrontmatter,
  BreakdownDoc,
  BreakdownDocFrontmatter,
  BreakdownInput,
  CompetitorUpdate,
  CompetitorAnalysisStore,
  IdentityMode,
  OpsConfig,
} from '../utils/types';
import { matchesTaxonomy, OPS_IDENTITY_TAXONOMY } from './ops-taxonomy';
import { buildCompetitorKeyFromProfile } from './competitor-keys';
import { extractJSON, LLMClient } from '../utils/llm-client';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_OBSERVATION_NOTES = 30;
const BREAKDOWN_RETENTION_DAYS = 90;
const MAX_AUTO_ANALYSES_PER_RUN = 5;
const AUTO_ANALYZE_MULTIPLIER = 2;
const AUTO_ANALYZE_MIN_ENGAGEMENT = 5000;

// ─── Frontmatter parsing ────────────────────────────────────────────────────

export interface ParsedFrontmatter {
  readonly frontmatter: Record<string, string | number>;
  readonly body: string;
}

/**
 * Parse YAML frontmatter delimited by `---`.
 * Flat key-value only — no nested objects.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlBlock = match[1];
  const body = match[2];
  const frontmatter: Record<string, string | number> = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: string | number = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Try numeric coercion
    const num = Number(value);
    if (!isNaN(num) && value !== '') {
      frontmatter[key] = num;
    } else {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/**
 * Serialize a flat record into YAML frontmatter block.
 */
export function buildFrontmatter(data: Record<string, string | number>): string {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

/**
 * Replace characters unsafe for filenames, preserve CJK chars.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '-').trim();
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

export function buildBreakdownPostKey(
  update: CompetitorUpdate,
  post: CompetitorUpdate['recent_posts'][number],
): string {
  return `${update.account}|${update.platform}|${post.time}|${post.topic}`;
}

function buildBreakdownFilename(input: BreakdownInput, date: string): string {
  const base = sanitizeFilename(input.title).slice(0, 40) || 'untitled';
  const fingerprint = input.post_key ?? `${input.title}|${input.engagement}|${input.link ?? ''}`;
  return `${date}-${base}-${shortHash(fingerprint)}.md`;
}

// ─── Section extraction helpers ─────────────────────────────────────────────

function extractSection(content: string, heading: string): string[] {
  const pattern = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = content.match(pattern);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(Boolean);
}

// ─── File discovery helpers ─────────────────────────────────────────────────

function readMdFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...readMdFilesRecursive(full));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

// ─── Profile operations ─────────────────────────────────────────────────────

/**
 * Read all competitor profile docs, optionally filtered by track.
 * Returns profiles sorted: primary first, then by name.
 */
export function getCompetitorProfiles(track?: string): CompetitorDoc[] {
  const files = readMdFilesRecursive(PATHS.competitorsDir);
  const docs: CompetitorDoc[] = [];

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const fm = frontmatter as unknown as CompetitorDocFrontmatter;

    if (track && !matchesTaxonomy(track as IdentityMode, String(fm.track))) {
      continue;
    }

    docs.push({
      frontmatter: fm,
      content: body,
      takeaways: extractSection(raw, '借鉴要点'),
      avoids: extractSection(raw, '避坑提醒'),
      filePath,
    });
  }

  return [...docs].sort((a, b) => {
    // primary before secondary
    if (a.frontmatter.reference_type !== b.frontmatter.reference_type) {
      return a.frontmatter.reference_type === 'primary' ? -1 : 1;
    }
    return String(a.frontmatter.name).localeCompare(String(b.frontmatter.name));
  });
}

/**
 * Read hit breakdowns, filtered by platform/track, sorted by engagement desc.
 */
export function getHitBreakdowns(options?: {
  platform?: string;
  track?: string;
  limit?: number;
}): BreakdownDoc[] {
  const { platform, track, limit = 10 } = options ?? {};
  const baseDir = PATHS.hitBreakdownsDir;

  let dirs: string[];
  if (platform) {
    const platDir = path.join(baseDir, platform);
    dirs = fs.existsSync(platDir) ? [platDir] : [];
  } else {
    dirs = fs.existsSync(baseDir)
      ? fs.readdirSync(baseDir)
          .map(d => path.join(baseDir, d))
          .filter(d => fs.statSync(d).isDirectory())
      : [];
  }

  const docs: BreakdownDoc[] = [];
  for (const dir of dirs) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const raw = fs.readFileSync(filePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const fm = frontmatter as unknown as BreakdownDocFrontmatter;

      if (track && !matchesTaxonomy(track as IdentityMode, String(fm.track))) {
        continue;
      }

      docs.push({ frontmatter: fm, content: body, filePath });
    }
  }

  return [...docs]
    .sort((a, b) => Number(b.frontmatter.engagement) - Number(a.frontmatter.engagement))
    .slice(0, limit);
}

// ─── Context builder ────────────────────────────────────────────────────────

export interface MemoryContextOptions {
  readonly maxProfiles?: number;
  readonly maxBreakdowns?: number;
}

/**
 * Build a compressed prompt string with competitor profiles + hit breakdowns
 * for a given identity mode.
 */
export function buildMemoryContext(
  identityMode: IdentityMode,
  options?: MemoryContextOptions,
): string {
  const { maxProfiles = 5, maxBreakdowns = 3 } = options ?? {};

  // Map identity mode to track labels
  const trackLabels = OPS_IDENTITY_TAXONOMY[identityMode];
  if (!trackLabels || trackLabels.length === 0) return '';

  const profiles = getCompetitorProfiles(identityMode).slice(0, maxProfiles);
  const breakdowns = getHitBreakdowns({ track: identityMode, limit: maxBreakdowns });

  if (profiles.length === 0 && breakdowns.length === 0) return '';

  const sections: string[] = [];

  // Profile section
  if (profiles.length > 0) {
    const profileLines = profiles.map(p => {
      const takeaways = p.takeaways.length > 0
        ? `  借鉴：${p.takeaways.slice(0, 3).join('；')}`
        : '';
      const avoids = p.avoids.length > 0
        ? `  避坑：${p.avoids.slice(0, 2).join('；')}`
        : '';
      return `@${p.frontmatter.name}（${p.frontmatter.platform}）${p.frontmatter.track}\n${takeaways}\n${avoids}`.trim();
    });
    sections.push(`【对标竞品画像】\n${profileLines.join('\n\n')}`);
  }

  // Breakdown section
  if (breakdowns.length > 0) {
    const bdLines = breakdowns.map((bd, i) => {
      const hooks = extractSection(bd.content, '钩子拆解').slice(0, 2);
      const reuse = extractSection(bd.content, '可借鉴点').slice(0, 2);
      const hookStr = hooks.length > 0 ? `  钩子：${hooks.join('；')}` : '';
      const reuseStr = reuse.length > 0 ? `  可借鉴：${reuse.join('；')}` : '';
      return `${i + 1}. ${bd.frontmatter.competitor}「${bd.frontmatter.date}」互动${bd.frontmatter.engagement}（${bd.frontmatter.platform}）\n${hookStr}\n${reuseStr}`.trim();
    });
    sections.push(`【近期爆款参考】\n${bdLines.join('\n\n')}`);
  }

  return sections.join('\n\n');
}

// ─── Profile initialization from persona config ─────────────────────────────

/**
 * Initialize markdown profile docs from static CompetitorProfile[] in persona.yaml.
 * Skips if file already exists (preserves manual edits).
 */
export function initProfilesFromPersona(
  competitors: readonly CompetitorProfile[],
): void {
  for (const c of competitors) {
    const dir = path.join(PATHS.competitorsDir, c.platform);
    const filePath = path.join(dir, `${sanitizeFilename(c.name)}.md`);

    if (fs.existsSync(filePath)) continue;

    fs.mkdirSync(dir, { recursive: true });

    const track = c.group ?? c.tag;
    const frontmatter = buildFrontmatter({
      platform: c.platform,
      track,
      reference_type: c.reference_type,
      name: c.name,
      updated_at: getLocalDate(wallNow()),
    });

    const contentMix = c.content_mix
      ? Object.entries(c.content_mix).map(([k, v]) => `${k} ${v}%`).join('、')
      : '未知';

    const body = [
      `# ${c.name}`,
      '',
      `> ${c.tag_desc}`,
      '',
      `- 平台：${c.platform}`,
      c.followers ? `- 粉丝：${c.followers}` : null,
      `- 内容比例：${contentMix}`,
      c.audience ? `- 受众：${c.audience}` : null,
      c.interaction_style ? `- 互动风格：${c.interaction_style}` : null,
      c.url ? `- 主页：${c.url}` : null,
      '',
      '## 借鉴要点',
      '',
      ...(c.takeaways ?? []).map(t => `- ${t}`),
      '',
      '## 避坑提醒',
      '',
      ...(c.avoid ?? []).map(a => `- ${a}`),
      '',
      '## 观察笔记',
      '',
    ].filter(line => line !== null).join('\n');

    fs.writeFileSync(filePath, frontmatter + body);
  }
}

// ─── Observation notes ──────────────────────────────────────────────────────

/**
 * Append an observation note to a competitor profile.
 * Creates the 观察笔记 section if missing. Updates frontmatter updated_at.
 */
export function appendObservation(
  platform: string,
  name: string,
  note: string,
): void {
  const dir = path.join(PATHS.competitorsDir, platform);
  const filePath = path.join(dir, `${sanitizeFilename(name)}.md`);

  if (!fs.existsSync(filePath)) return;

  let content = fs.readFileSync(filePath, 'utf8');
  const dateStr = getLocalDate(now());
  const entry = `- ${dateStr}: ${note}`;

  if (content.includes('## 观察笔记')) {
    // Append after the section heading
    content = content.replace(
      /(## 观察笔记\n)/,
      `$1${entry}\n`,
    );
  } else {
    content = content.trimEnd() + `\n\n## 观察笔记\n${entry}\n`;
  }

  // Update frontmatter updated_at
  const { frontmatter, body } = parseFrontmatter(content);
  const newFm = { ...frontmatter, updated_at: dateStr };
  fs.writeFileSync(filePath, buildFrontmatter(newFm) + body);
}

// ─── Hit breakdown operations ───────────────────────────────────────────────

/**
 * Write a hit breakdown as a markdown file.
 */
export function writeBreakdown(input: BreakdownInput): void {
  const dir = path.join(PATHS.hitBreakdownsDir, input.platform);
  fs.mkdirSync(dir, { recursive: true });

  const date = getLocalDate(now());
  const filename = buildBreakdownFilename(input, date);
  const filePath = path.join(dir, filename);

  const frontmatter = buildFrontmatter({
    platform: input.platform,
    track: input.track,
    competitor: input.competitor,
    date,
    engagement: input.engagement,
    content_type: input.content_type,
    source: input.source,
    ...(input.post_key ? { post_key: input.post_key } : {}),
    ...(input.source_post_time ? { source_post_time: input.source_post_time } : {}),
  });

  const body = [
    `# ${input.title}`,
    '',
    input.link ? `> 原文：${input.link}` : null,
    '',
    input.body,
  ].filter(line => line !== null).join('\n');

  fs.writeFileSync(filePath, frontmatter + body);
}

export function writeBreakdownFromPostAnalysis(input: {
  title: string;
  platform: 'xhs' | 'douyin';
  engagement: number;
  coreSellingPoints: readonly string[];
  openingHook?: string;
  bodyFlow?: string;
  closingCta?: string;
  visualStrategy?: string;
  postKey: string;
  link?: string;
  competitor?: string;
  track?: string;
}): void {
  const sections = [
    '## 钩子拆解',
    '',
    `- ${input.openingHook || '见原文表现'}`,
    '',
    '## 内容结构',
    '',
    `- ${input.bodyFlow || input.visualStrategy || '结构信息缺失'}`,
    '',
    '## 可借鉴点',
    '',
    ...(input.coreSellingPoints.length > 0
      ? input.coreSellingPoints.map(point => `- ${point}`)
      : ['- 暂无结构化可借鉴点']),
    '',
    input.closingCta ? '## 结尾动作' : null,
    input.closingCta ? '' : null,
    input.closingCta ? `- ${input.closingCta}` : null,
  ].filter((line): line is string => line !== null);

  writeBreakdown({
    platform: input.platform,
    track: input.track ?? 'unknown',
    competitor: input.competitor ?? 'discovery-pool',
    title: input.title,
    engagement: input.engagement,
    content_type: input.platform === 'douyin' ? '视频' : '图文',
    source: 'auto',
    body: sections.join('\n'),
    link: input.link,
    post_key: input.postKey,
  });
}

// ─── Auto-analysis logic ────────────────────────────────────────────────────

/**
 * Determine whether a competitor update warrants automatic hit analysis.
 * Criteria: engagement > 2× historical average for same account.
 */
function getHistoricalAverageEngagement(
  update: CompetitorUpdate,
  historicalEntries: readonly CompetitorUpdate[],
): number | null {
  const sameAccount = historicalEntries
    .filter(e => e.account === update.account && e.platform === update.platform)
    .filter(e => e.latest_post && e.latest_post.engagement > 0)
    .filter(e => e.fetched_at !== update.fetched_at)
    .slice(-7);

  if (sameAccount.length === 0) return null;

  const avgEngagement = sameAccount.reduce(
    (sum, e) => sum + (e.latest_post?.engagement ?? 0), 0,
  ) / sameAccount.length;

  return avgEngagement > 0 ? avgEngagement : null;
}

function shouldAutoAnalyzePost(
  update: CompetitorUpdate,
  post: CompetitorUpdate['recent_posts'][number] | null,
  historicalEntries: readonly CompetitorUpdate[],
): boolean {
  if (!post || post.engagement <= 0) return false;

  const avgEngagement = getHistoricalAverageEngagement(update, historicalEntries);
  if (avgEngagement === null) {
    return post.engagement >= AUTO_ANALYZE_MIN_ENGAGEMENT;
  }

  return post.engagement > AUTO_ANALYZE_MULTIPLIER * avgEngagement;
}

export function shouldAutoAnalyze(
  update: CompetitorUpdate,
  historicalEntries: readonly CompetitorUpdate[],
): boolean {
  return shouldAutoAnalyzePost(update, update.latest_post, historicalEntries);
}

/**
 * Use LLM to analyze a high-performing post and write a breakdown.
 */
interface AutoAnalyzeResult {
  hook_analysis: string;
  structure: string;
  reusable_points: string[];
  non_reusable: string[];
  summary: string;
}

function normalizeAutoAnalyzeResult(input: Partial<Record<keyof AutoAnalyzeResult, unknown>>): AutoAnalyzeResult {
  return {
    hook_analysis: typeof input.hook_analysis === 'string' ? input.hook_analysis : '',
    structure: typeof input.structure === 'string' ? input.structure : '',
    reusable_points: Array.isArray(input.reusable_points) ? input.reusable_points.map(String) : [],
    non_reusable: Array.isArray(input.non_reusable) ? input.non_reusable.map(String) : [],
    summary: typeof input.summary === 'string' ? input.summary : '',
  };
}

export async function autoAnalyzeHit(
  update: CompetitorUpdate,
  profile: CompetitorProfile | undefined,
  llm: LLMClient,
  post: CompetitorUpdate['recent_posts'][number] = update.latest_post ?? update.recent_posts[0],
): Promise<void> {
  if (!post) return;

  const prompt = `分析以下竞品爆款内容，提取关键成功因素。

竞品：${update.account}（${update.platform}）
标题：${post.topic}
互动量：${post.engagement}
内容类型：${post.content_type}

请分析并返回 JSON：
{
  "hook_analysis": "钩子/标题吸引力分析（1-2句）",
  "structure": "内容结构亮点（1-2句）",
  "reusable_points": ["可借鉴点1", "可借鉴点2"],
  "non_reusable": ["不可复制因素1"],
  "summary": "一句话总结这条内容为什么火"
}`;

  let result: AutoAnalyzeResult;
  try {
    result = normalizeAutoAnalyzeResult(await llm.callJSON<AutoAnalyzeResult>(prompt, 800));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[competitor-memory] callJSON failed for ${update.account}, retrying with raw call: ${msg}`);
    const raw = await llm.call(prompt, 800);
    result = normalizeAutoAnalyzeResult(extractJSON<Partial<Record<keyof AutoAnalyzeResult, unknown>>>(raw));
  }

  const track = profile?.group ?? profile?.tag ?? 'unknown';
  const postKey = buildBreakdownPostKey(update, post);

  const body = [
    result.summary,
    '',
    '## 钩子拆解',
    '',
    `- ${result.hook_analysis}`,
    '',
    '## 内容结构',
    '',
    `- ${result.structure}`,
    '',
    '## 可借鉴点',
    '',
    ...result.reusable_points.map(p => `- ${p}`),
    '',
    '## 不可复制因素',
    '',
    ...result.non_reusable.map(p => `- ${p}`),
  ].join('\n');

  writeBreakdown({
    platform: update.platform,
    track,
    competitor: update.account,
    title: post.topic,
    engagement: post.engagement,
    content_type: post.content_type,
    source: 'auto',
    body,
    post_key: postKey,
    source_post_time: post.time,
  });
}

/**
 * Analyze new high-engagement posts from competitor updates.
 * Capped at MAX_AUTO_ANALYSES_PER_RUN per invocation.
 */
export async function analyzeNewHits(
  updates: CompetitorUpdate[],
  ops: OpsConfig,
  historicalEntries: readonly CompetitorUpdate[],
  llm: LLMClient,
): Promise<void> {
  let analyzed = 0;

  // Check existing breakdowns to avoid duplicates
  const existingBreakdowns = getHitBreakdowns({ limit: 500 });
  const existingKeys = new Set(
    existingBreakdowns.map(bd =>
      String(bd.frontmatter.post_key ?? `${bd.frontmatter.competitor}:${bd.frontmatter.date}`),
    ),
  );

  const candidates = updates.flatMap(update =>
    update.recent_posts.map(post => ({
      update,
      post,
      postKey: buildBreakdownPostKey(update, post),
      shouldAnalyze: shouldAutoAnalyzePost(update, post, historicalEntries),
    })),
  );

  const sortedCandidates = candidates
    .filter(candidate => candidate.shouldAnalyze)
    .sort((a, b) => {
      if (b.post.engagement !== a.post.engagement) return b.post.engagement - a.post.engagement;
      return new Date(b.post.time).getTime() - new Date(a.post.time).getTime();
    });

  for (const candidate of sortedCandidates) {
    if (analyzed >= MAX_AUTO_ANALYSES_PER_RUN) break;
    if (existingKeys.has(candidate.postKey)) continue;

    const profile = ops.competitors?.find(
      c => c.name === candidate.update.account && c.platform === candidate.update.platform,
    );

    try {
      await autoAnalyzeHit(candidate.update, profile, llm, candidate.post);
      analyzed++;
      existingKeys.add(candidate.postKey);
    } catch (err) {
      console.error(`[competitor-memory] autoAnalyzeHit failed for ${candidate.update.account}:`, err);
    }
  }

  if (analyzed > 0) {
    console.log(`[competitor-memory] Auto-analyzed ${analyzed} hit post(s)`);
  }
}

// ─── Cleanup operations ─────────────────────────────────────────────────────

/**
 * Delete breakdown files older than 90 days. Returns count deleted.
 */
export function cleanupOldBreakdowns(): number {
  const baseDir = PATHS.hitBreakdownsDir;
  if (!fs.existsSync(baseDir)) return 0;

  const cutoff = new Date(now().getTime() - BREAKDOWN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let deleted = 0;

  const files = readMdFilesRecursive(baseDir);
  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { frontmatter } = parseFrontmatter(raw);
    const dateStr = String(frontmatter.date ?? '');
    if (dateStr && dateStr < cutoffStr) {
      fs.unlinkSync(filePath);
      deleted++;
    }
  }

  return deleted;
}

/**
 * Trim observation notes in all profile files to keep only the newest 30 entries.
 */
export function trimObservationNotes(): void {
  const files = readMdFilesRecursive(PATHS.competitorsDir);

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.includes('## 观察笔记')) continue;

    const sectionMatch = raw.match(/(## 观察笔记\n)([\s\S]*?)(?=\n## |$)/);
    if (!sectionMatch) continue;

    const lines = sectionMatch[2]
      .split('\n')
      .filter(l => l.startsWith('- '));

    if (lines.length <= MAX_OBSERVATION_NOTES) continue;

    // Keep only newest entries (they're prepended, so first N are newest)
    const trimmed = lines.slice(0, MAX_OBSERVATION_NOTES);
    const newSection = `## 观察笔记\n${trimmed.join('\n')}\n`;
    const updated = raw.replace(/(## 观察笔记\n)([\s\S]*?)(?=\n## |$)/, newSection);
    fs.writeFileSync(filePath, updated);
  }
}

// ─── Insight sync: JSON → MD knowledge surface ──────────────────────────────

/** Negation words that indicate an insight should go to 避坑提醒 instead of 借鉴要点 */
const AVOID_KEYWORDS = ['避免', '不要', '切勿', '别再', '千万别', '不可', '禁止', '忌'];

/** Prefix length used for fuzzy dedup — avoids LLM rephrasing drift */
const DEDUP_PREFIX_LEN = 20;

function isAvoidInsight(text: string): boolean {
  return AVOID_KEYWORDS.some(kw => text.includes(kw));
}

/**
 * Extract existing bullet entries (without "- " prefix) from a heading section.
 * Used for dedup: only append entries whose prefix doesn't already exist.
 */
function existingEntryPrefixes(content: string, heading: string): Set<string> {
  const entries = extractSection(content, heading);
  return new Set(entries.map(e => e.slice(0, DEDUP_PREFIX_LEN)));
}

/**
 * Append entries to a heading section in a markdown file, deduplicating
 * by prefix match. Returns the number of entries actually added.
 */
function appendToSection(filePath: string, heading: string, entries: string[]): number {
  let content = fs.readFileSync(filePath, 'utf8');
  const existing = existingEntryPrefixes(content, heading);
  const newEntries = entries.filter(e => !existing.has(e.slice(0, DEDUP_PREFIX_LEN)));
  if (newEntries.length === 0) return 0;

  const bulletLines = newEntries.map(e => `- ${e}`).join('\n');

  if (content.includes(`## ${heading}`)) {
    const pattern = new RegExp(`(## ${heading}\\n)`);
    content = content.replace(
      pattern,
      `$1${bulletLines}\n`,
    );
  } else {
    content = content.trimEnd() + `\n\n## ${heading}\n${bulletLines}\n`;
  }

  // Update frontmatter updated_at
  const { frontmatter, body } = parseFrontmatter(content);
  const newFm = { ...frontmatter, updated_at: getLocalDate(wallNow()) };
  fs.writeFileSync(filePath, buildFrontmatter(newFm) + body);

  return newEntries.length;
}

/**
 * Upsert a single entry to the 借鉴要点 section of a competitor profile.
 * Deduplicates by prefix match.
 */
export function upsertTakeaway(platform: string, name: string, entry: string): void {
  const dir = path.join(PATHS.competitorsDir, platform);
  const filePath = path.join(dir, `${sanitizeFilename(name)}.md`);
  if (!fs.existsSync(filePath)) return;
  appendToSection(filePath, '借鉴要点', [entry]);
}

/**
 * Upsert a single entry to the 避坑提醒 section of a competitor profile.
 * Deduplicates by prefix match.
 */
export function upsertAvoid(platform: string, name: string, entry: string): void {
  const dir = path.join(PATHS.competitorsDir, platform);
  const filePath = path.join(dir, `${sanitizeFilename(name)}.md`);
  if (!fs.existsSync(filePath)) return;
  appendToSection(filePath, '避坑提醒', [entry]);
}

/** Result of syncing competitor insights from JSON to MD */
export interface SyncResult {
  updated: number;
  takeaways: number;
  avoids: number;
  observations: number;
}

/**
 * Sync competitor insights: aggregate analysis results from the JSON data layer
 * into the MD knowledge surface. Idempotent — existing entries are not duplicated.
 *
 * Data source → target mapping:
 *   key_insight        → 借鉴要点 (or 避坑提醒 if negation words present)
 *   hook_patterns(高)  → 借鉴要点 (as "高频钩子「pattern」：formula")
 *   engagement_pattern → 观察笔记 (as "发布频率X，Y表现最佳")
 */
export function syncCompetitorInsights(
  profiles: readonly CompetitorProfile[],
  analysisStore: CompetitorAnalysisStore,
): SyncResult {
  const result: SyncResult = { updated: 0, takeaways: 0, avoids: 0, observations: 0 };

  for (const profile of profiles) {
    const accountKey = buildCompetitorKeyFromProfile(profile);
    const analysis = analysisStore.analyses[accountKey];
    if (!analysis) continue;

    const dir = path.join(PATHS.competitorsDir, profile.platform);
    const filePath = path.join(dir, `${sanitizeFilename(profile.name)}.md`);
    if (!fs.existsSync(filePath)) continue;

    let profileUpdated = false;
    const takeawayEntries: string[] = [];
    const avoidEntries: string[] = [];
    const observationEntries: string[] = [];

    // 1. key_insight → 借鉴要点 or 避坑提醒
    if (analysis.key_insight) {
      const insight = analysis.key_insight;
      if (isAvoidInsight(insight)) {
        avoidEntries.push(insight);
      } else {
        takeawayEntries.push(insight);
      }
    }

    // 2. High-frequency hook patterns → 借鉴要点
    for (const hp of analysis.hook_patterns) {
      if (hp.frequency === '高' && hp.formula) {
        takeawayEntries.push(`高频钩子「${hp.pattern}」：${hp.formula}`);
      }
    }

    // 3. engagement_pattern → 观察笔记
    const ep = analysis.engagement_pattern;
    if (ep.posting_frequency || ep.peak_days?.length) {
      const parts: string[] = [];
      if (ep.posting_frequency) parts.push(`发布频率${ep.posting_frequency}`);
      if (ep.peak_days?.length) parts.push(`${ep.peak_days.join('、')}表现最佳`);
      observationEntries.push(parts.join('，'));
    }

    // Apply changes
    const takeawaysAdded = appendToSection(filePath, '借鉴要点', takeawayEntries);
    const avoidsAdded = appendToSection(filePath, '避坑提醒', avoidEntries);
    const observationsAdded = appendToSection(filePath, '观察笔记', observationEntries);

    if (takeawaysAdded + avoidsAdded + observationsAdded > 0) {
      profileUpdated = true;
      result.takeaways += takeawaysAdded;
      result.avoids += avoidsAdded;
      result.observations += observationsAdded;
    }

    if (profileUpdated) result.updated++;
  }

  return result;
}
