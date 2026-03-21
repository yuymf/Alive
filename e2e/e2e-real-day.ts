#!/usr/bin/env npx tsx

import * as fs from 'fs';
import * as path from 'path';
import { PATHS, readJSON, readText, setBasePaths, resetBasePaths, writeJSON } from '../skill/scripts/file-utils';
import { setTimeOverride, clearTimeOverride, now, wallNow } from '../skill/scripts/time-utils';
import { runMorningPlan } from '../skill/scripts/morning-plan';
import { regularTick } from '../skill/scripts/heartbeat-tick';
import { runNightReflect } from '../skill/scripts/night-reflect';
import { getPendingReplies } from '../skill/scripts/comment-engine';
import { isXhsAvailable } from '../skill/scripts/xhs-bridge-client';
import type { InspirationData, PostHistory, SocialRelation } from '../skill/scripts/types';
import { DEFAULT_POST_IMPULSE } from '../skill/scripts/types';
import {
  initSandbox,
  loadApiKeys,
  applyApiKeys,
  setupMockEnv,
  captureConsole,
  PROJECT_ROOT,
  SANDBOX_MEMORY,
  SKILL_DIR,
  OUTPUT_DIR,
} from './shared/setup';

export type LiveChainStatus = 'success' | 'not_triggered' | 'failed';

export interface NaturalChainObservation {
  triggered: boolean;
  succeeded: boolean;
  errors: string[];
  evidence?: string[];
}

export interface LiveChainSummaryEntry extends NaturalChainObservation {
  status: LiveChainStatus;
}

export interface LiveChainSummary {
  instagramBrowse: LiveChainSummaryEntry;
  xhsBrowse: LiveChainSummaryEntry;
  instagramPost: LiveChainSummaryEntry;
  instagramOutboundComment: LiveChainSummaryEntry;
  instagramReplyComment: LiveChainSummaryEntry;
}

interface TickLog {
  hour: number;
  phase: 'morning' | 'regular' | 'night';
  label: string;
  logs: string[];
  durationMs: number;
  error?: string;
}

interface CounterSnapshot {
  posts: number;
  outboundComments: number;
  repliedCommentIds: number;
  duePendingReplies: number;
}

interface LiveRunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  sandboxMemory: string;
  outputDir: string;
  archiveDir: string;
  xhsAvailable: boolean;
  envStatus: Record<string, boolean>;
  counters: {
    before: CounterSnapshot;
    after: CounterSnapshot;
  };
  summary: LiveChainSummary;
  tickLogs: TickLog[];
}

const DEFAULT_INSPIRATION: InspirationData = {
  instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
  acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
  visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
  self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
  xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
};

const DEFAULT_POST_HISTORY: PostHistory = { posts: [] };

const HOURS = {
  morning: 7,
  regular: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
  night: 23,
} as const;

export function resolveNaturalChainStatus(observation: NaturalChainObservation): LiveChainStatus {
  if (observation.succeeded) return 'success';
  if (observation.errors.length > 0) return 'failed';
  return 'not_triggered';
}

export function buildLiveChainSummary(chains: {
  instagramBrowse: NaturalChainObservation;
  xhsBrowse: NaturalChainObservation;
  instagramPost: NaturalChainObservation;
  instagramOutboundComment: NaturalChainObservation;
  instagramReplyComment: NaturalChainObservation;
}): LiveChainSummary {
  return {
    instagramBrowse: { ...chains.instagramBrowse, status: resolveNaturalChainStatus(chains.instagramBrowse) },
    xhsBrowse: { ...chains.xhsBrowse, status: resolveNaturalChainStatus(chains.xhsBrowse) },
    instagramPost: { ...chains.instagramPost, status: resolveNaturalChainStatus(chains.instagramPost) },
    instagramOutboundComment: { ...chains.instagramOutboundComment, status: resolveNaturalChainStatus(chains.instagramOutboundComment) },
    instagramReplyComment: { ...chains.instagramReplyComment, status: resolveNaturalChainStatus(chains.instagramReplyComment) },
  };
}

function assertLiveRiskSwitch(): void {
  if (process.env.MINASE_REAL_E2E !== '1') {
    throw new Error('Refusing to run live E2E without MINASE_REAL_E2E=1');
  }
}

function assertInstagramCredentials(): void {
  const missing = ['INSTAGRAM_USERNAME', 'INSTAGRAM_PASSWORD'].filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required Instagram env: ${missing.join(', ')}`);
  }
}

function buildEnvStatus(): Record<string, boolean> {
  return {
    MINASE_REAL_E2E: process.env.MINASE_REAL_E2E === '1',
    IMAGE_ENTRY: Boolean(process.env.IMAGE_ENTRY),
    LLM_API_KEY: Boolean(process.env.LLM_API_KEY),
    LLM_API_BASE: Boolean(process.env.LLM_API_BASE),
    LLM_MODEL: Boolean(process.env.LLM_MODEL),
    AIHUBMIX_API_KEY: Boolean(process.env.AIHUBMIX_API_KEY),
    AIHUBMIX_MODEL: Boolean(process.env.AIHUBMIX_MODEL),
    FAL_KEY: Boolean(process.env.FAL_KEY),
    FAL_MODEL: Boolean(process.env.FAL_MODEL),
    IMGURL_TOKEN: Boolean(process.env.IMGURL_TOKEN),
    INSTAGRAM_USERNAME: Boolean(process.env.INSTAGRAM_USERNAME),
    INSTAGRAM_PASSWORD: Boolean(process.env.INSTAGRAM_PASSWORD),
    INSTAGRAM_TOTP_SECRET: Boolean(process.env.INSTAGRAM_TOTP_SECRET),
    XHS_SKILLS_DIR: Boolean(process.env.XHS_SKILLS_DIR),
  };
}

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function countRepliedCommentIds(): number {
  const pending = readJSON<{ pending_replies?: Array<{ replied_comment_ids?: string[] }> }>(PATHS.pendingEngagement, { pending_replies: [] });
  return (pending.pending_replies ?? []).reduce((sum, entry) => sum + (entry.replied_comment_ids?.length ?? 0), 0);
}

function readCounters(): CounterSnapshot {
  const postHistory = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const outboundHistory = readJSON<{ commented?: Array<unknown> }>(PATHS.outboundHistory, { commented: [] });
  return {
    posts: postHistory.posts.length,
    outboundComments: (outboundHistory.commented ?? []).length,
    repliedCommentIds: countRepliedCommentIds(),
    duePendingReplies: getPendingReplies().length,
  };
}

function captureSnapshot(label: string): void {
  const snapshot: Record<string, unknown> = {};
  for (const file of fs.readdirSync(SANDBOX_MEMORY)) {
    const fullPath = path.join(SANDBOX_MEMORY, file);
    if (!fs.statSync(fullPath).isFile()) continue;
    if (file.endsWith('.json')) {
      try {
        snapshot[file] = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch {
        snapshot[file] = fs.readFileSync(fullPath, 'utf8');
      }
    } else if (file.endsWith('.md')) {
      snapshot[file] = fs.readFileSync(fullPath, 'utf8');
    }
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'state-snapshots', `${label}.json`),
    JSON.stringify(snapshot, null, 2),
  );
}

function copyPhotoRollImages(): number {
  let imageCount = 0;
  const photoRoll = path.join(SANDBOX_MEMORY, 'photo-roll');
  if (!fs.existsSync(photoRoll)) return imageCount;

  for (const dateDir of fs.readdirSync(photoRoll)) {
    const dirPath = path.join(photoRoll, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.png') && !file.endsWith('.jpg') && !file.endsWith('.jpeg') && !file.endsWith('.webp')) continue;
      imageCount += 1;
      fs.copyFileSync(path.join(dirPath, file), path.join(OUTPUT_DIR, 'images', `${dateDir}-${file}`));
    }
  }

  return imageCount;
}

function collectOutput(): number {
  copyDir(SANDBOX_MEMORY, path.join(OUTPUT_DIR, 'final-state'));
  return copyPhotoRollImages();
}

function seedLiveSandbox(): void {
  initSandbox({
    overrides: {
      'emotion-state.json': {
        mood: { valence: 0.75, arousal: 0.62, description: '状态很好，今天想认真营业' },
        energy: 0.78,
        stress: 0.12,
        creativity: 0.84,
        sociability: 0.76,
        last_updated: null,
        recent_cause: 'live e2e init',
        momentum: { valence: 0, arousal: 0, energy: 0, stress: 0, creativity: 0, sociability: 0 },
        undertone: { valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
        impulse_history: [],
        consecutive_high_stress: 0,
        threshold_break_cooldown: 0,
      },
      'post-impulse.json': {
        ...DEFAULT_POST_IMPULSE,
        value: 82,
      },
      'preferences.json': {
        cos_characters: [
          { name: '初音ミク', affinity: 9, times_created: 2, source: 'seed' },
          { name: '明日香', affinity: 7, times_created: 1, source: 'seed' },
        ],
        content_style: [
          { style: '日系清新', affinity: 8 },
          { style: '暖色调', affinity: 7 },
        ],
        active_hours: [
          { period: '14:00-16:00', productivity: 9, learned_from: 'seed' },
          { period: '20:00-22:00', productivity: 7, learned_from: 'seed' },
        ],
        social_platforms: [
          { platform: 'instagram', engagement: 9, note: '主阵地' },
          { platform: 'xiaohongshu', engagement: 6, note: '只读灵感' },
        ],
      },
      'inspiration.json': {
        ...DEFAULT_INSPIRATION,
        instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
        xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
      },
    },
  });

  setBasePaths(SANDBOX_MEMORY, SKILL_DIR);

  const seededAt = wallNow().toISOString();
  const socialMetaPath = path.join(SANDBOX_MEMORY, 'relations', 'social', 'meta.json');
  fs.writeFileSync(
    socialMetaPath,
    JSON.stringify({
      instagram_following: ['38291234', '48392011'],
      xiaohongshu_following: [],
      stats: { core: 1, familiar: 1, cognitive: 0, dormant: 0 },
      follower_count: 860,
      following_count: 248,
      media_count: 42,
      follower_synced_at: seededAt,
    }, null, 2),
  );

  const relations: SocialRelation[] = [
    {
      id: '38291234',
      name: 'sora_cos',
      platform: 'instagram',
      type: '同行',
      relationship: { closeness: 8.2, sentiment: 'positive', tags: ['cos', '常互动'] },
      known_info: ['常发角色扮演和棚拍'],
      interaction_history: [{ date: seededAt, type: 'seed', content: '用于 live e2e 社交关系初始化' }],
      last_interaction: seededAt,
      created_at: seededAt,
    },
    {
      id: '48392011',
      name: 'mika_daily',
      platform: 'instagram',
      type: '用户',
      relationship: { closeness: 6.3, sentiment: 'positive', tags: ['穿搭', '街拍'] },
      known_info: ['偏日常日系穿搭'],
      interaction_history: [{ date: seededAt, type: 'seed', content: '用于 live e2e 社交关系初始化' }],
      last_interaction: seededAt,
      created_at: seededAt,
    },
  ];

  for (const relation of relations) {
    fs.writeFileSync(
      path.join(SANDBOX_MEMORY, 'relations', 'social', 'instagram', `${relation.id}.json`),
      JSON.stringify(relation, null, 2),
    );
  }
}

async function runPhase(hour: number, label: string, phase: TickLog['phase'], fn: () => Promise<void>, tickLogs: TickLog[]): Promise<void> {
  setTimeOverride(new Date(`2026-06-15T${String(hour).padStart(2, '0')}:00:00`));
  const capture = captureConsole();
  const started = wallNow().getTime();
  let error: string | undefined;

  try {
    await fn();
  } catch (err) {
    error = (err as Error).message;
    console.error(`[live-e2e] ${label} failed: ${error}`);
  } finally {
    capture.restore();
  }

  const tickLog: TickLog = {
    hour,
    label,
    phase,
    logs: capture.logs,
    durationMs: wallNow().getTime() - started,
    error,
  };
  tickLogs.push(tickLog);
  captureSnapshot(`hour-${String(hour).padStart(2, '0')}`);
}

function findErrors(logs: string[], patterns: RegExp[]): string[] {
  return logs.filter(line => patterns.some(pattern => pattern.test(line)));
}

function hasInstagramBrowseEvidence(inspiration: InspirationData): string[] {
  const evidence: string[] = [];
  if (inspiration.instagram_trends.trending_hashtags.length > 0) {
    evidence.push(`hashtags:${inspiration.instagram_trends.trending_hashtags.join(',')}`);
  }
  if (inspiration.instagram_trends.hot_styles.length > 0) {
    evidence.push(`styles:${inspiration.instagram_trends.hot_styles.join(',')}`);
  }
  if (inspiration.instagram_trends.high_engagement_patterns.length > 0) {
    evidence.push(`patterns:${inspiration.instagram_trends.high_engagement_patterns.join(',')}`);
  }
  return evidence;
}

function hasXhsBrowseEvidence(inspiration: InspirationData): string[] {
  const xhs = inspiration.xiaohongshu_trends;
  if (!xhs) return [];
  const evidence: string[] = [];
  if (xhs.feed_highlights.length > 0) evidence.push(`feed:${xhs.feed_highlights.length}`);
  if (xhs.trending_topics.length > 0) evidence.push(`topics:${xhs.trending_topics.join(',')}`);
  if (xhs.cosplay_insights.length > 0) evidence.push(`insights:${xhs.cosplay_insights.length}`);
  if (xhs.saved_inspirations.length > 0) evidence.push(`saved:${xhs.saved_inspirations.length}`);
  return evidence;
}

function formatSummaryMarkdown(report: LiveRunReport, imageCount: number): string {
  const lines = [
    '# Minase Real Day E2E Summary',
    '',
    `- Run ID: \`${report.runId}\``,
    `- Started: \`${report.startedAt}\``,
    `- Finished: \`${report.finishedAt}\``,
    `- Archive: \`${report.archiveDir}\``,
    `- Images copied: \`${imageCount}\``,
    '',
    '## Chain Status',
    '',
  ];

  for (const [name, entry] of Object.entries(report.summary)) {
    lines.push(`- **${name}**: ${entry.status}`);
    if (entry.evidence && entry.evidence.length > 0) lines.push(`  - evidence: ${entry.evidence.join(' | ')}`);
    if (entry.errors.length > 0) lines.push(`  - errors: ${entry.errors.join(' | ')}`);
  }

  lines.push('', '## Counters', '');
  lines.push(`- posts: ${report.counters.before.posts} -> ${report.counters.after.posts}`);
  lines.push(`- outbound comments: ${report.counters.before.outboundComments} -> ${report.counters.after.outboundComments}`);
  lines.push(`- replied comment ids: ${report.counters.before.repliedCommentIds} -> ${report.counters.after.repliedCommentIds}`);
  lines.push(`- due pending replies at start: ${report.counters.before.duePendingReplies}`);
  lines.push('', '## Env Presence', '');
  for (const [key, value] of Object.entries(report.envStatus)) {
    lines.push(`- ${key}: ${value ? 'set' : 'missing'}`);
  }

  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  console.log('=== Minase Real Day E2E ===\n');
  assertLiveRiskSwitch();

  const keys = loadApiKeys();
  applyApiKeys(keys);
  assertInstagramCredentials();

  const envStatus = buildEnvStatus();
  const xhsAvailable = await isXhsAvailable();
  const restoreEnv = setupMockEnv({
    instagram: false,
    xhs: false,
    cron: true,
    inlinePipeline: true,
  });

  const startedAt = wallNow().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-');
  const archiveDir = path.join(PROJECT_ROOT, 'e2e', 'real-day-runs', runId);
  const tickLogs: TickLog[] = [];

  try {
    seedLiveSandbox();

    console.log(`Simulated date: ${new Date('2026-06-15T07:00:00').toLocaleString('zh-CN')}`);
    console.log(`Sandbox: ${SANDBOX_MEMORY}`);
    console.log(`XHS CLI available: ${xhsAvailable ? 'yes' : 'no'}`);
    console.log(`IG creds: ${envStatus.INSTAGRAM_USERNAME && envStatus.INSTAGRAM_PASSWORD ? 'ready' : 'missing'}`);
    console.log('');

    setTimeOverride(new Date('2026-06-15T07:00:00'));
    const countersBefore = readCounters();

    await runPhase(HOURS.morning, 'morning-plan', 'morning', runMorningPlan, tickLogs);
    for (const hour of HOURS.regular) {
      await runPhase(hour, 'regular-tick', 'regular', regularTick, tickLogs);
    }
    await runPhase(HOURS.night, 'night-reflect', 'night', runNightReflect, tickLogs);

    const countersAfter = readCounters();
    const allLogs = tickLogs.flatMap(log => log.logs);
    const inspiration = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
    const instagramBrowseEvidence = hasInstagramBrowseEvidence(inspiration);
    const xhsBrowseEvidence = hasXhsBrowseEvidence(inspiration);

    const summary = buildLiveChainSummary({
      instagramBrowse: {
        triggered: true,
        succeeded: instagramBrowseEvidence.length > 0,
        errors: findErrors(allLogs, [/Recent hashtag search failed/i, /Instagram recent trend collection returned no live posts/i]),
        evidence: instagramBrowseEvidence,
      },
      xhsBrowse: {
        triggered: true,
        succeeded: xhsAvailable && xhsBrowseEvidence.length > 0,
        errors: xhsAvailable
          ? findErrors(allLogs, [/XHS feed fetch failed/i, /XHS search failed/i, /XHS detail fetch failed/i, /XHS live trend collection returned no notes/i])
          : ['XHS CLI not available'],
        evidence: xhsBrowseEvidence,
      },
      instagramPost: {
        triggered: allLogs.some(line => /Post pipeline started\.|Posting .* photo\(s\) to Instagram/i.test(line)),
        succeeded: countersAfter.posts > countersBefore.posts,
        errors: findErrors(allLogs, [/Post failed:/i, /Pipeline error:/i, /Inline post-pipeline failed/i]),
        evidence: countersAfter.posts > countersBefore.posts ? [`posts:${countersBefore.posts}->${countersAfter.posts}`] : [],
      },
      instagramOutboundComment: {
        triggered: allLogs.some(line => /Commented on @|No candidates for outbound engagement|Daily outbound quota reached/i.test(line)),
        succeeded: countersAfter.outboundComments > countersBefore.outboundComments,
        errors: findErrors(allLogs, [/Social engagement failed/i, /Failed to post on/i]),
        evidence: countersAfter.outboundComments > countersBefore.outboundComments
          ? [`outbound:${countersBefore.outboundComments}->${countersAfter.outboundComments}`]
          : [],
      },
      instagramReplyComment: {
        triggered: countersBefore.duePendingReplies > 0 || allLogs.some(line => /Checking comments for post|Replied to @/i.test(line)),
        succeeded: countersAfter.repliedCommentIds > countersBefore.repliedCommentIds,
        errors: findErrors(allLogs, [/Pending reply check failed/i, /Failed to reply to/i, /getComments failed/i]),
        evidence: countersAfter.repliedCommentIds > countersBefore.repliedCommentIds
          ? [`replied:${countersBefore.repliedCommentIds}->${countersAfter.repliedCommentIds}`]
          : countersBefore.duePendingReplies > 0 ? [`dueAtStart:${countersBefore.duePendingReplies}`] : [],
      },
    });

    const imageCount = collectOutput();
    const report: LiveRunReport = {
      runId,
      startedAt,
      finishedAt: wallNow().toISOString(),
      sandboxMemory: SANDBOX_MEMORY,
      outputDir: OUTPUT_DIR,
      archiveDir,
      xhsAvailable,
      envStatus,
      counters: {
        before: countersBefore,
        after: countersAfter,
      },
      summary,
      tickLogs,
    };

    writeJSON(path.join(OUTPUT_DIR, 'live-summary.json'), report);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'live-summary.md'), formatSummaryMarkdown(report, imageCount));
    copyDir(OUTPUT_DIR, archiveDir);

    console.log('=== Live Chain Summary ===');
    for (const [name, entry] of Object.entries(summary)) {
      console.log(`- ${name}: ${entry.status}`);
      if (entry.evidence && entry.evidence.length > 0) {
        console.log(`  evidence: ${entry.evidence.join(' | ')}`);
      }
      if (entry.errors.length > 0) {
        console.log(`  errors: ${entry.errors.join(' | ')}`);
      }
    }
    console.log(`\nArchive saved to: ${archiveDir}`);
  } finally {
    resetBasePaths();
    clearTimeOverride();
    restoreEnv();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
