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

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';

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
      author: '', // feed_highlights don't have author; filled by saved_inspirations
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
    topics: Set<string>;
    platform: string;
  }>();

  // From discovery pool items (which have engagement data)
  for (const item of pool.items) {
    if (!item.author || item.author === '') continue;
    const key = `${item.author}:${item.source}`;
    const existing = authorData.get(key) ?? {
      count: 0, totalEngagement: 0, topics: new Set(), platform: item.source,
    };
    existing.count++;
    existing.totalEngagement += item.engagement;
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
 * Only includes pending candidates with enough evidence.
 */
export function buildCandidateContext(): string {
  const store = loadCandidateAccounts();
  const pending = store.candidates
    .filter(c => c.status === 'pending' && c.appearance_count >= MIN_APPEARANCES_FOR_SUGGESTION)
    .sort((a, b) => b.avg_engagement - a.avg_engagement)
    .slice(0, 3);

  if (pending.length === 0) return '';

  const lines = ['━━ 🔍 发现候选对标 ━━'];
  for (const c of pending) {
    lines.push(`  @${c.name}（${c.platform}）出现${c.appearance_count}次 均互动${c.avg_engagement}`);
    if (c.topics.length > 0) {
      lines.push(`    话题: ${c.topics.slice(0, 3).join('、')}`);
    }
  }
  lines.push('  回复 /competitor add @名称 平台 来添加');

  return lines.join('\n');
}

// ─── Candidate Management ───────────────────────────────────────────────────

/**
 * Approve a candidate account (mark as approved).
 * The human should then add it to persona.yaml competitors.
 */
export function approveCandidate(name: string, platform: string): boolean {
  const store = loadCandidateAccounts();
  const candidate = store.candidates.find(
    c => c.name === name && c.platform === platform && c.status === 'pending',
  );
  if (!candidate) return false;
  candidate.status = 'approved';
  saveCandidateAccounts(store);
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
