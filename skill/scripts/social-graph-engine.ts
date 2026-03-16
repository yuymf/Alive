// skill/scripts/social-graph-engine.ts
// Social graph management engine (Spec §8)
// Handles tier classification, closeness changes, decay, dormancy, and intent generation.

import { SocialRelation, SocialMeta, IntentCategory } from './types';

// === Tier Classification ===

export type SocialTier = 'core' | 'familiar' | 'cognitive' | 'dormant';

const TIER_LIMITS: Record<SocialTier, number> = {
  core: 5,
  familiar: 15,
  cognitive: 100,
  dormant: 500,
};

export function classifyTier(closeness: number): SocialTier {
  if (closeness > 7) return 'core';
  if (closeness >= 4) return 'familiar';
  if (closeness >= 1) return 'cognitive';
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
  // Respect min_closeness floor if set
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

    if (days >= 90 && classifyTier(relation.relationship.closeness) === 'dormant') {
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
    core: [],
    familiar: [],
    cognitive: [],
    dormant: [],
  };

  for (const r of relations) {
    byTier[classifyTier(r.relationship.closeness)].push({ ...r });
  }

  // Demote excess from familiar to cognitive
  if (byTier.familiar.length > TIER_LIMITS.familiar) {
    const sorted = [...byTier.familiar].sort(
      (a, b) => a.relationship.closeness - b.relationship.closeness,
    );
    const excess = sorted.slice(0, sorted.length - TIER_LIMITS.familiar);
    const kept = sorted.slice(sorted.length - TIER_LIMITS.familiar);

    byTier.familiar = kept;
    for (const r of excess) {
      byTier.cognitive.push({
        ...r,
        relationship: { ...r.relationship, closeness: Math.min(r.relationship.closeness, 3.9) },
      });
    }
  }

  // Demote excess from cognitive to dormant
  if (byTier.cognitive.length > TIER_LIMITS.cognitive) {
    const sorted = [...byTier.cognitive].sort(
      (a, b) => a.relationship.closeness - b.relationship.closeness,
    );
    const excess = sorted.slice(0, sorted.length - TIER_LIMITS.cognitive);
    const kept = sorted.slice(sorted.length - TIER_LIMITS.cognitive);

    byTier.cognitive = kept;
    for (const r of excess) {
      byTier.dormant.push({
        ...r,
        relationship: { ...r.relationship, closeness: Math.min(r.relationship.closeness, 0.9) },
      });
    }
  }

  // Trim dormant beyond limit (remove oldest)
  if (byTier.dormant.length > TIER_LIMITS.dormant) {
    byTier.dormant = [...byTier.dormant]
      .sort((a, b) => new Date(b.last_interaction).getTime() - new Date(a.last_interaction).getTime())
      .slice(0, TIER_LIMITS.dormant);
  }

  return [
    ...byTier.core,
    ...byTier.familiar,
    ...byTier.cognitive,
    ...byTier.dormant,
  ];
}

// === Social Intent Generation ===

export interface SocialIntentSeed {
  category: IntentCategory;
  description: string;
  intensity: number;
}

export function generateSocialIntents(
  relations: readonly SocialRelation[],
  meta: SocialMeta,
  now: Date,
): SocialIntentSeed[] {
  const intents: SocialIntentSeed[] = [];

  // Core circle members inactive for 3+ days → social intent
  for (const r of relations) {
    if (classifyTier(r.relationship.closeness) !== 'core') continue;
    const days = daysSince(r.last_interaction, now);
    if (days >= 3) {
      intents.push({
        category: '社交',
        description: `想去看看 @${r.name} 的最近动态`,
        intensity: Math.min(5, 2 + days * 0.5),
      });
    }
  }

  // Follower milestones
  const totalFollowing = (meta.instagram_following?.length ?? 0) + (meta.xiaohongshu_following?.length ?? 0);
  const totalRelations = relations.length;
  const milestones = [100, 500, 1000, 5000];
  for (const m of milestones) {
    if (totalRelations >= m && totalRelations < m + 5) {
      intents.push({
        category: '表达',
        description: `粉丝突破 ${m} 了！想做点什么特别的`,
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
  // Dormant relation reactivated → cognitive tier, closeness starts at 1.0
  if (classifyTier(relation.relationship.closeness) === 'dormant') {
    return {
      ...relation,
      relationship: {
        ...relation.relationship,
        closeness: 1.0,
      },
      last_interaction: timestamp,
      interaction_history: [
        ...relation.interaction_history,
        { date: timestamp, type: 'reactivated', content: '从休眠状态恢复' },
      ],
    };
  }
  return relation;
}
