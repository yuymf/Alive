/**
 * discovery-engine.ts
 * Two-layer discovery system:
 *
 * 1. Content Discovery (爆款发现闭环):
 *    Reads inspiration-state.json → scores high-engagement content → writes discovery-pool.json
 *    Consumed by: topic-generator (as additional trend signals), brief-generator (discovery card)
 *
 * 2. Account Discovery (对标自动发现):
 *    Tracks authors who appear frequently with high engagement → suggests as candidate competitors
 *    Writes: candidate-accounts.json
 *    Consumed by: brief-generator (new account suggestions), human approval → persona.yaml
 */

import * as fs from 'fs';
import YAML from 'yaml';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { clearPersonaCache } from '../persona/persona-loader';
import type { CompetitorProfile, PersonaConfig } from '../utils/types';
import { rankCandidates } from './candidate-scorer';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveryItem {
  /** Content title */
  title: string;
  /** Author/source user */
  author: string;
  /** Platform source (e.g. 'xhs', 'instagram', 'reddit') */
  source: string;
  /** Engagement metric (likes, upvotes, etc.) */
  engagement: number;
  /** Topic/category */
  topic: string;
  /** Discovery score: engagement × relevance */
  score: number;
  /** When this item was discovered */
  discovered_at: string;
}

export interface DiscoveryPool {
  items: DiscoveryItem[];
  last_updated: string;
}

export const DEFAULT_DISCOVERY_POOL: DiscoveryPool = {
  items: [],
  last_updated: '',
};

export interface CandidateAccount {
  /** Account name/handle */
  name: string;
  /** Platform */
  platform: string;
  /** Number of times this author appeared in high-engagement content */
  appearance_count: number;
  /** Average engagement of their content */
  avg_engagement: number;
  /** Highest engagement seen across all appearances (爆款帖指标) */
  peak_engagement: number;
  /** Optional score breakdown populated by candidate-scorer on demand */
  score_breakdown?: {
    track_overlap: number;
    burst_intensity: number;
    frequency: number;
    composite: number;
  };
  /** Topics they're associated with */
  topics: string[];
  /** First seen date */
  first_seen: string;
  /** Last seen date */
  last_seen: string;
  /** Status: pending = needs human review, approved = added to competitors, dismissed */
  status: 'pending' | 'approved' | 'dismissed';
}

export interface CandidateAccountsStore {
  candidates: CandidateAccount[];
  last_updated: string;
}

export const DEFAULT_CANDIDATES: CandidateAccountsStore = {
  candidates: [],
  last_updated: '',
};

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_DISCOVERY_ITEMS = 30;
const MAX_CANDIDATES = 20;
/** Minimum engagement to be considered "high engagement" */
const HIGH_ENGAGEMENT_THRESHOLD = 500;
/** Minimum appearances before suggesting as candidate */
const MIN_APPEARANCES_FOR_SUGGESTION = 2;

// ─── I/O ────────────────────────────────────────────────────────────────────

export function loadDiscoveryPool(): DiscoveryPool {
  return readJSON<DiscoveryPool>(PATHS.discoveryPool, DEFAULT_DISCOVERY_POOL);
}

export function saveDiscoveryPool(pool: DiscoveryPool): void {
  writeJSON(PATHS.discoveryPool, { ...pool, last_updated: now().toISOString() });
}

export function loadCandidateAccounts(): CandidateAccountsStore {
  return readJSON<CandidateAccountsStore>(PATHS.candidateAccounts, DEFAULT_CANDIDATES);
}

export function saveCandidateAccounts(store: CandidateAccountsStore): void {
  writeJSON(PATHS.candidateAccounts, { ...store, last_updated: now().toISOString() });
}

// ─── Inspiration State Types (matches content-browse sub-skill output) ──────

interface InspirationHighlight {
  title: string;
  likes: number;
  topic: string;
  takeaway?: string;
  /** Author/creator name (may be absent in older data) */
  author?: string;
}

interface InspirationSaved {
  source_id: string;
  source_title: string;
  visual_description: string;
  style_tags: string[];
}

interface InspirationState {
  last_refreshed_at: string | null;
  feed_highlights: InspirationHighlight[];
  trending_topics: string[];
  domain_insights: string[];
  saved_inspirations: InspirationSaved[];
}

// ─── Content Discovery (Task 16) ────────────────────────────────────────────

/**
 * Score a content item for discovery relevance.
 * Higher score = more worthy of entering the discovery pool.
 */
export function scoreContent(item: InspirationHighlight): number {
  const engagementScore = Math.log10(Math.max(item.likes, 1) + 1) * 20;
  const hasTakeaway = item.takeaway ? 1.5 : 1.0;
  return Math.round(engagementScore * hasTakeaway);
}

/**
 * Process inspiration-state.json → update discovery-pool.json.
 * Called after content-browse writes new inspiration data.
 * Returns number of new items added to discovery pool.
 */
export function processInspirationForDiscovery(): number {
  const inspoState = readJSON<InspirationState>(PATHS.inspirationState, {
    last_refreshed_at: null,
    feed_highlights: [],
    trending_topics: [],
    domain_insights: [],
    saved_inspirations: [],
  });

  if (!inspoState.last_refreshed_at || inspoState.feed_highlights.length === 0) {
    return 0;
  }

  const pool = loadDiscoveryPool();
  const existingTitles = new Set(pool.items.map(i => i.title));
  const timestamp = now().toISOString();
  let addedCount = 0;

  for (const highlight of inspoState.feed_highlights) {
    if (existingTitles.has(highlight.title)) continue;
    if (highlight.likes < HIGH_ENGAGEMENT_THRESHOLD) continue;

    const score = scoreContent(highlight);

    pool.items.push({
      title: highlight.title,
      author: highlight.author ?? '',
      source: 'content-browse',
      engagement: highlight.likes,
      topic: highlight.topic,
      score,
      discovered_at: timestamp,
    });
    addedCount++;
  }

  // Trim to max and sort by score desc
  pool.items.sort((a, b) => b.score - a.score);
  pool.items = pool.items.slice(0, MAX_DISCOVERY_ITEMS);

  if (addedCount > 0) {
    saveDiscoveryPool(pool);
  }

  return addedCount;
}

// ─── Account Discovery (Task 17) ────────────────────────────────────────────

/**
 * Extract author names from inspiration state and discovery pool.
 * Tracks frequency and engagement to identify potential competitor accounts.
 */
export function processInspirationForAccountDiscovery(): number {
  const inspoState = readJSON<InspirationState>(PATHS.inspirationState, {
    last_refreshed_at: null,
    feed_highlights: [],
    trending_topics: [],
    domain_insights: [],
    saved_inspirations: [],
  });

  const pool = loadDiscoveryPool();
  const store = loadCandidateAccounts();
  const timestamp = now().toISOString();
  const dateStr = timestamp.slice(0, 10);

  // Build author frequency map from all available sources
  const authorData = new Map<string, {
    count: number;
    totalEngagement: number;
    maxEngagement: number;
    topics: Set<string>;
    platform: string;
  }>();

  // From discovery pool items (which have engagement data)
  for (const item of pool.items) {
    if (!item.author || item.author === '') continue;
    const key = `${item.author}:${item.source}`;
    const existing = authorData.get(key) ?? {
      count: 0, totalEngagement: 0, maxEngagement: 0, topics: new Set(), platform: item.source,
    };
    existing.count++;
    existing.totalEngagement += item.engagement;
    existing.maxEngagement = Math.max(existing.maxEngagement, item.engagement);
    existing.topics.add(item.topic);
    authorData.set(key, existing);
  }

  // From saved inspirations (extract platform from source_id prefix)
  for (const saved of inspoState.saved_inspirations) {
    const platform = saved.source_id.split('_')[0] || 'unknown';
    // Use source_title as a proxy for author (not perfect but available data)
    // Skip — saved_inspirations don't reliably have author info
    void platform;
  }

  let newCandidates = 0;

  for (const [key, data] of authorData) {
    if (data.count < MIN_APPEARANCES_FOR_SUGGESTION) continue;

    const [authorName] = key.split(':');
    const avgEngagement = Math.round(data.totalEngagement / data.count);

    // Check if already tracked
    const existing = store.candidates.find(
      c => c.name === authorName && c.platform === data.platform,
    );

    if (existing) {
      // Update existing candidate
      existing.appearance_count = Math.max(existing.appearance_count, data.count);
      existing.avg_engagement = avgEngagement;
      existing.peak_engagement = Math.max(existing.peak_engagement ?? existing.avg_engagement, data.maxEngagement);
      existing.last_seen = dateStr;
      const newTopics = [...data.topics].filter(t => !existing.topics.includes(t));
      existing.topics = [...existing.topics, ...newTopics].slice(0, 10);
    } else {
      // Add new candidate
      store.candidates.push({
        name: authorName,
        platform: data.platform,
        appearance_count: data.count,
        avg_engagement: avgEngagement,
        peak_engagement: data.maxEngagement,
        topics: [...data.topics].slice(0, 10),
        first_seen: dateStr,
        last_seen: dateStr,
        status: 'pending',
      });
      newCandidates++;
    }
  }

  // Trim pending candidates to max
  const pending = store.candidates.filter(c => c.status === 'pending');
  if (pending.length > MAX_CANDIDATES) {
    // Sort by avg_engagement desc, keep top MAX_CANDIDATES
    pending.sort((a, b) => b.avg_engagement - a.avg_engagement);
    const keep = new Set(pending.slice(0, MAX_CANDIDATES).map(c => `${c.name}:${c.platform}`));
    store.candidates = store.candidates.filter(
      c => c.status !== 'pending' || keep.has(`${c.name}:${c.platform}`),
    );
  }

  if (newCandidates > 0 || authorData.size > 0) {
    saveCandidateAccounts(store);
  }

  return newCandidates;
}

// ─── Discovery Context for Topic Generator ──────────────────────────────────

/**
 * Build a discovery context string for injection into topic generation prompts.
 * Returns empty string if no discoveries available.
 */
export function buildDiscoveryContext(): string {
  const pool = loadDiscoveryPool();

  if (pool.items.length === 0) return '';

  const top = pool.items.slice(0, 5);
  const lines = ['【近期爆款发现】'];
  for (const item of top) {
    lines.push(`- 「${item.title}」❤️${item.engagement} (${item.topic}) — score: ${item.score}`);
  }

  return lines.join('\n');
}

/**
 * Build a candidate accounts context for the daily brief.
 * Ranks by composite score when identityKeys provided; falls back to avg_engagement sort.
 *
 * @param identityKeys  Optional persona identity keys for track_overlap scoring
 */
export function buildCandidateContext(identityKeys?: string[]): string {
  const store = loadCandidateAccounts();
  const keys = identityKeys ?? [];

  const ranked = rankCandidates(store, keys, 'pending')
    .filter(c => c.appearance_count >= MIN_APPEARANCES_FOR_SUGGESTION)
    .slice(0, 3);

  if (ranked.length === 0) return '';

  const lines = ['━━ 🔍 发现候选对标 ━━'];
  for (const c of ranked) {
    const composite = c.score_breakdown.composite.toFixed(2);
    const peak = (c as { peak_engagement?: number }).peak_engagement ?? c.avg_engagement;
    lines.push(`  @${c.name}（${c.platform}）综合 ${composite}  出现${c.appearance_count}次  ❤️均值${c.avg_engagement} / 峰值${peak}`);
    if (c.topics.length > 0) {
      lines.push(`    话题: ${c.topics.slice(0, 3).join('、')}`);
    }
  }
  lines.push('  回复 /candidates 查看全部 | /competitor add @名称 平台 添加');

  return lines.join('\n');
}

// ─── Candidate Management ───────────────────────────────────────────────────

const VALID_PLATFORMS = new Set(['xhs', 'douyin', 'bilibili', 'weibo', 'instagram', 'youtube']);

/**
 * Convert a CandidateAccount to a CompetitorProfile for persona.yaml.
 * Uses 'secondary' reference_type and auto-generated tag/tag_desc from discovery data.
 */
function candidateToCompetitor(candidate: CandidateAccount): CompetitorProfile {
  const platform = VALID_PLATFORMS.has(candidate.platform)
    ? candidate.platform as CompetitorProfile['platform']
    : 'xhs'; // fallback for unknown platforms
  return {
    name: candidate.name,
    platform,
    tag: 'discovered',
    tag_desc: `通过内容发现自动追踪 — 出现${candidate.appearance_count}次，均互动${candidate.avg_engagement}`,
    reference_type: 'secondary',
    group: 'auto-discovered',
    takeaways: candidate.topics.length > 0
      ? [`关联话题：${candidate.topics.slice(0, 5).join('、')}`]
      : [],
  };
}

/**
 * Add a competitor profile to persona.yaml.
 * Follows the same write pattern as command-handler.ts modifySchedule():
 * 1. Read YAML → parse → modify → backup .bak → write → clearPersonaCache
 * Returns true if successfully written, false if persona.yaml not found or duplicate.
 */
export function addCompetitorToPersona(profile: CompetitorProfile): boolean {
  const yamlPath = PATHS.personaConfig;
  if (!fs.existsSync(yamlPath)) return false;

  const raw = fs.readFileSync(yamlPath, 'utf8');
  const persona = YAML.parse(raw) as PersonaConfig;

  // Ensure ops and competitors exist
  if (!persona.ops) {
    (persona as unknown as Record<string, unknown>).ops = { enabled: false, competitors: [] };
  }
  const ops = persona.ops!;
  const competitors: CompetitorProfile[] = [...(ops.competitors ?? [])];

  // Check for duplicate (name + platform)
  const isDuplicate = competitors.some(
    c => c.name === profile.name && c.platform === profile.platform,
  );
  if (isDuplicate) return false;

  // Append new competitor
  competitors.push(profile);
  (ops as unknown as Record<string, unknown>).competitors = competitors;

  // Write back with backup
  fs.copyFileSync(yamlPath, yamlPath + '.bak');
  fs.writeFileSync(yamlPath, YAML.stringify(persona, { indent: 2 }));

  // Clear persona cache so next load picks up changes
  clearPersonaCache();
  return true;
}

/**
 * Approve a candidate account (mark as approved).
 * Automatically adds the candidate to persona.yaml competitors as a secondary reference.
 * Returns true if candidate was found and approved, false otherwise.
 */
export function approveCandidate(name: string, platform: string): boolean {
  const store = loadCandidateAccounts();
  const candidate = store.candidates.find(
    c => c.name === name && c.platform === platform && c.status === 'pending',
  );
  if (!candidate) return false;
  candidate.status = 'approved';
  saveCandidateAccounts(store);

  // Auto-write to persona.yaml (best-effort, don't fail the approve if yaml write fails)
  try {
    const profile = candidateToCompetitor(candidate);
    const written = addCompetitorToPersona(profile);
    if (written) {
      console.log(`[discovery-engine] ✅ Auto-added @${name}（${platform}）to persona.yaml competitors`);
    } else {
      console.log(`[discovery-engine] ⚠️ Skipped @${name}（${platform}）— already in persona.yaml or config not found`);
    }
  } catch (err) {
    console.warn(`[discovery-engine] Failed to auto-write to persona.yaml: ${(err as Error).message}`);
  }

  return true;
}

/**
 * Dismiss a candidate account.
 */
export function dismissCandidate(name: string, platform: string): boolean {
  const store = loadCandidateAccounts();
  const candidate = store.candidates.find(
    c => c.name === name && c.platform === platform && c.status === 'pending',
  );
  if (!candidate) return false;
  candidate.status = 'dismissed';
  saveCandidateAccounts(store);
  return true;
}
