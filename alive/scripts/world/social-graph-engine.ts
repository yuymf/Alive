// alive/scripts/world/social-graph-engine.ts
// Social graph management engine — generalized (no platform-specific constants)
// Handles tier classification, closeness changes, decay, dormancy, and intent generation.

import { SocialRelation, SocialMeta, IntentCategory } from '../utils/types';
import { SOCIAL_GRAPH_CONFIG } from '../config';

// === Tier Classification ===

export type SocialTier = 'core' | 'familiar' | 'cognitive' | 'dormant';

const TIER_LIMITS: Record<SocialTier, number> = SOCIAL_GRAPH_CONFIG.TIER_LIMITS as Record<SocialTier, number>;

export function classifyTier(closeness: number): SocialTier {
  if (closeness > SOCIAL_GRAPH_CONFIG.TIER_THRESHOLDS.core) return 'core';
  if (closeness >= SOCIAL_GRAPH_CONFIG.TIER_THRESHOLDS.familiar) return 'familiar';
  if (closeness >= SOCIAL_GRAPH_CONFIG.TIER_THRESHOLDS.cognitive) return 'cognitive';
  return 'dormant';
}

// === Closeness Change Events ===

type ClosenessEventType =
  | 'comment_received'
  | 'reply_sent'
  | 'comment_sent'
  | 'like_received'
  | 'mutual_comment'
  | 'follow_received'
  | 'shared_interest';

const CLOSENESS_DELTAS: Record<ClosenessEventType, number> = {
  comment_received: 0.5,
  reply_sent: 0.3,
  comment_sent: 0.3,
  like_received: 0.1,
  mutual_comment: 1.0,
  follow_received: 0.5,
  shared_interest: 1.0,
};

function clampCloseness(value: number): number {
  return Math.min(10, Math.max(0, value));
}

export function applyClosenessChange(
  relation: SocialRelation,
  eventType: ClosenessEventType,
  timestamp: string,
): SocialRelation {
  const delta = CLOSENESS_DELTAS[eventType] ?? 0;
  return {
    ...relation,
    relationship: {
      ...relation.relationship,
      closeness: clampCloseness(relation.relationship.closeness + delta),
    },
    interaction_history: [
      ...relation.interaction_history,
      { date: timestamp, type: eventType, content: '' },
    ],
    last_interaction: timestamp,
  };
}

// === Time-based Decay ===

const MS_PER_DAY = 86_400_000;

function daysSince(isoDate: string, now: Date): number {
  return (now.getTime() - new Date(isoDate).getTime()) / MS_PER_DAY;
}

export function decayRelation(relation: SocialRelation, now: Date): SocialRelation {
  const days = daysSince(relation.last_interaction, now);

  let decayAmount = 0;
  if (days >= 30) {
    decayAmount = 1.0;
  } else if (days >= 7) {
    decayAmount = 0.2;
  }

  if (decayAmount === 0) return relation;

  const newCloseness = clampCloseness(relation.relationship.closeness - decayAmount);
  const minCloseness = relation.min_closeness ?? 0;
  const clampedCloseness = Math.max(newCloseness, minCloseness);
  return {
    ...relation,
    relationship: {
      ...relation.relationship,
      closeness: clampedCloseness,
    },
  };
}

export function decayAllRelations(
  relations: readonly SocialRelation[],
  now: Date,
): SocialRelation[] {
  return relations.map(r => decayRelation(r, now));
}

// === Dormancy Processing ===

export interface DormancyResult {
  active: SocialRelation[];
  removed: SocialRelation[];
}

export function processDormancy(
  relations: readonly SocialRelation[],
  now: Date,
): DormancyResult {
  const active: SocialRelation[] = [];
  const removed: SocialRelation[] = [];

  for (const relation of relations) {
    const days = daysSince(relation.last_interaction, now);
    if (days >= SOCIAL_GRAPH_CONFIG.DORMANCY_DAYS && classifyTier(relation.relationship.closeness) === 'dormant') {
      removed.push(relation);
    } else {
      active.push(relation);
    }
  }

  return { active, removed };
}

// === Tier Rebalancing ===

export function rebalanceTiers(
  relations: readonly SocialRelation[],
): SocialRelation[] {
  const byTier: Record<SocialTier, SocialRelation[]> = {
    core: [], familiar: [], cognitive: [], dormant: [],
  };

  for (const r of relations) {
    byTier[classifyTier(r.relationship.closeness)].push({ ...r });
  }

  if (byTier.core.length > TIER_LIMITS.core) {
    const sorted = [...byTier.core].sort((a, b) => a.relationship.closeness - b.relationship.closeness);
    const excess = sorted.slice(0, sorted.length - TIER_LIMITS.core);
    byTier.core = sorted.slice(sorted.length - TIER_LIMITS.core);
    for (const r of excess) {
      byTier.familiar.push({
        ...r,
        relationship: {
          ...r.relationship,
          closeness: Math.min(r.relationship.closeness, SOCIAL_GRAPH_CONFIG.TIER_THRESHOLDS.core),
        },
      });
    }
  }

  if (byTier.familiar.length > TIER_LIMITS.familiar) {
    const sorted = [...byTier.familiar].sort((a, b) => a.relationship.closeness - b.relationship.closeness);
    const excess = sorted.slice(0, sorted.length - TIER_LIMITS.familiar);
    byTier.familiar = sorted.slice(sorted.length - TIER_LIMITS.familiar);
    for (const r of excess) {
      byTier.cognitive.push({ ...r, relationship: { ...r.relationship, closeness: Math.min(r.relationship.closeness, 3.9) } });
    }
  }

  if (byTier.cognitive.length > TIER_LIMITS.cognitive) {
    const sorted = [...byTier.cognitive].sort((a, b) => a.relationship.closeness - b.relationship.closeness);
    const excess = sorted.slice(0, sorted.length - TIER_LIMITS.cognitive);
    byTier.cognitive = sorted.slice(sorted.length - TIER_LIMITS.cognitive);
    for (const r of excess) {
      byTier.dormant.push({ ...r, relationship: { ...r.relationship, closeness: Math.min(r.relationship.closeness, 0.9) } });
    }
  }

  if (byTier.dormant.length > TIER_LIMITS.dormant) {
    byTier.dormant = [...byTier.dormant]
      .sort((a, b) => new Date(b.last_interaction).getTime() - new Date(a.last_interaction).getTime())
      .slice(0, TIER_LIMITS.dormant);
  }

  return [...byTier.core, ...byTier.familiar, ...byTier.cognitive, ...byTier.dormant];
}

// === Social Intent Generation (generalized) ===

export interface SocialIntentSeed {
  category: IntentCategory;
  description: string;
  intensity: number;
}

export function generateSocialIntents(
  relations: readonly SocialRelation[],
  _meta: SocialMeta,
  now: Date,
): SocialIntentSeed[] {
  const intents: SocialIntentSeed[] = [];

  // Core circle members inactive for 3+ days → social intent
  for (const r of relations) {
    if (classifyTier(r.relationship.closeness) !== 'core') continue;
    const days = daysSince(r.last_interaction, now);
    if (days >= SOCIAL_GRAPH_CONFIG.CORE_INACTIVE_DAYS) {
      intents.push({
        category: 'connect',
        description: `想去看看 @${r.name} 的最近动态`,
        intensity: Math.min(5, 2 + days * 0.5),
      });
    }
  }

  // Milestone-based expression intents (generalized, no platform-specific following count)
  const totalRelations = relations.length;
  const milestones = [100, 500, 1000, 5000];
  for (const m of milestones) {
    if (totalRelations >= m && totalRelations < m + 5) {
      intents.push({
        category: 'express',
        description: `关注者突破 ${m} 了！想做点什么特别的`,
        intensity: 6,
      });
      break;
    }
  }

  return intents;
}

// === Meta Stats Update ===

export function updateMetaStats(
  meta: SocialMeta,
  relations: readonly SocialRelation[],
): SocialMeta {
  const stats = { core: 0, familiar: 0, cognitive: 0, dormant: 0 };
  for (const r of relations) {
    stats[classifyTier(r.relationship.closeness)] += 1;
  }
  return { ...meta, stats };
}

// === Reactivation ===

export function reactivateRelation(
  relation: SocialRelation,
  timestamp: string,
): SocialRelation {
  if (classifyTier(relation.relationship.closeness) === 'dormant') {
    return {
      ...relation,
      relationship: { ...relation.relationship, closeness: 1.0 },
      last_interaction: timestamp,
      interaction_history: [
        ...relation.interaction_history,
        { date: timestamp, type: 'reactivated', content: '从休眠状态恢复' },
      ],
    };
  }
  return relation;
}
