// tests/social-graph-engine.test.ts
import { describe, it, expect } from 'vitest';
import {
  classifyTier,
  applyClosenessChange,
  decayRelation,
  decayAllRelations,
  processDormancy,
  rebalanceTiers,
  generateSocialIntents,
  updateMetaStats,
  reactivateRelation,
} from '../skill/scripts/social-graph-engine';
import { SocialRelation, SocialMeta } from '../skill/scripts/types';

function makeRelation(overrides: Partial<SocialRelation> = {}): SocialRelation {
  return {
    id: 'test_1',
    name: 'TestUser',
    platform: 'instagram',
    type: '粉丝',
    relationship: { closeness: 5.0, sentiment: 'positive', tags: [] },
    known_info: [],
    interaction_history: [],
    last_interaction: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMeta(): SocialMeta {
  return {
    instagram_following: [],
    xiaohongshu_following: [],
    stats: { core: 0, familiar: 0, cognitive: 0, dormant: 0 },
  };
}

describe('classifyTier', () => {
  it('returns core for closeness > 7', () => {
    expect(classifyTier(7.1)).toBe('core');
    expect(classifyTier(10)).toBe('core');
  });

  it('returns familiar for closeness 4-7', () => {
    expect(classifyTier(4)).toBe('familiar');
    expect(classifyTier(7)).toBe('familiar');
  });

  it('returns cognitive for closeness 1-3.9', () => {
    expect(classifyTier(1)).toBe('cognitive');
    expect(classifyTier(3.9)).toBe('cognitive');
  });

  it('returns dormant for closeness < 1', () => {
    expect(classifyTier(0.9)).toBe('dormant');
    expect(classifyTier(0)).toBe('dormant');
  });
});

describe('applyClosenessChange', () => {
  it('increases closeness for comment_received', () => {
    const r = makeRelation({ relationship: { closeness: 3.0, sentiment: 'neutral', tags: [] } });
    const updated = applyClosenessChange(r, 'comment_received', '2026-01-01T00:00:00Z');
    expect(updated.relationship.closeness).toBe(3.5);
    expect(updated.last_interaction).toBe('2026-01-01T00:00:00Z');
    expect(updated.interaction_history).toHaveLength(1);
  });

  it('clamps closeness at 10', () => {
    const r = makeRelation({ relationship: { closeness: 9.8, sentiment: 'positive', tags: [] } });
    const updated = applyClosenessChange(r, 'shared_interest', '2026-01-01T00:00:00Z');
    expect(updated.relationship.closeness).toBe(10);
  });

  it('does not mutate the original relation', () => {
    const r = makeRelation({ relationship: { closeness: 5.0, sentiment: 'neutral', tags: [] } });
    const updated = applyClosenessChange(r, 'like_received', '2026-01-01T00:00:00Z');
    expect(r.relationship.closeness).toBe(5.0);
    expect(updated.relationship.closeness).toBe(5.1);
  });
});

describe('decayRelation', () => {
  it('does not decay within 7 days', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const r = makeRelation({ last_interaction: '2026-03-05T12:00:00Z' });
    const decayed = decayRelation(r, now);
    expect(decayed.relationship.closeness).toBe(r.relationship.closeness);
  });

  it('decays 0.2 after 7-29 days', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const r = makeRelation({
      last_interaction: '2026-03-01T12:00:00Z',
      relationship: { closeness: 5.0, sentiment: 'positive', tags: [] },
    });
    const decayed = decayRelation(r, now);
    expect(decayed.relationship.closeness).toBe(4.8);
  });

  it('decays 1.0 after 30+ days', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const r = makeRelation({
      last_interaction: '2026-02-01T12:00:00Z',
      relationship: { closeness: 5.0, sentiment: 'positive', tags: [] },
    });
    const decayed = decayRelation(r, now);
    expect(decayed.relationship.closeness).toBe(4.0);
  });

  it('clamps at 0', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const r = makeRelation({
      last_interaction: '2026-01-01T12:00:00Z',
      relationship: { closeness: 0.5, sentiment: 'neutral', tags: [] },
    });
    const decayed = decayRelation(r, now);
    expect(decayed.relationship.closeness).toBe(0);
  });
});

describe('decayAllRelations', () => {
  it('decays all relations immutably', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const relations = [
      makeRelation({ id: 'a', last_interaction: '2026-03-01T12:00:00Z', relationship: { closeness: 5, sentiment: 'positive', tags: [] } }),
      makeRelation({ id: 'b', last_interaction: '2026-03-09T12:00:00Z', relationship: { closeness: 3, sentiment: 'neutral', tags: [] } }),
    ];
    const decayed = decayAllRelations(relations, now);
    expect(decayed[0].relationship.closeness).toBe(4.8);
    expect(decayed[1].relationship.closeness).toBe(3);
    expect(relations[0].relationship.closeness).toBe(5);
  });
});

describe('processDormancy', () => {
  it('removes dormant relations inactive for 90+ days', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const relations = [
      makeRelation({ id: 'active', last_interaction: '2026-05-30T12:00:00Z', relationship: { closeness: 5, sentiment: 'positive', tags: [] } }),
      makeRelation({ id: 'dormant', last_interaction: '2026-02-01T12:00:00Z', relationship: { closeness: 0.5, sentiment: 'neutral', tags: [] } }),
    ];
    const result = processDormancy(relations, now);
    expect(result.active).toHaveLength(1);
    expect(result.active[0].id).toBe('active');
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].id).toBe('dormant');
  });

  it('keeps dormant relations under 90 days', () => {
    const now = new Date('2026-04-01T12:00:00Z');
    const relations = [
      makeRelation({ id: 'recent_dormant', last_interaction: '2026-03-01T12:00:00Z', relationship: { closeness: 0.5, sentiment: 'neutral', tags: [] } }),
    ];
    const result = processDormancy(relations, now);
    expect(result.active).toHaveLength(1);
    expect(result.removed).toHaveLength(0);
  });
});

describe('rebalanceTiers', () => {
  it('demotes excess familiar to cognitive', () => {
    const relations: SocialRelation[] = [];
    for (let i = 0; i < 18; i++) {
      relations.push(makeRelation({
        id: `fam_${i}`,
        relationship: { closeness: 4 + (i * 0.1), sentiment: 'positive', tags: [] },
      }));
    }
    const rebalanced = rebalanceTiers(relations);
    const familiar = rebalanced.filter(r => r.relationship.closeness >= 4 && r.relationship.closeness <= 7);
    const cognitive = rebalanced.filter(r => r.relationship.closeness >= 1 && r.relationship.closeness < 4);
    expect(familiar.length).toBeLessThanOrEqual(15);
    expect(cognitive.length).toBeGreaterThan(0);
  });
});

describe('generateSocialIntents', () => {
  it('generates social intent for core member inactive 3+ days', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const relations = [
      makeRelation({
        id: 'core_inactive',
        name: 'BestFriend',
        last_interaction: '2026-03-06T12:00:00Z',
        relationship: { closeness: 8.0, sentiment: 'positive', tags: [] },
      }),
    ];
    const intents = generateSocialIntents(relations, makeMeta(), now);
    expect(intents.length).toBeGreaterThanOrEqual(1);
    expect(intents[0].category).toBe('社交');
    expect(intents[0].description).toContain('BestFriend');
  });

  it('does not generate intent for recently active core member', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const relations = [
      makeRelation({
        id: 'core_active',
        name: 'ActiveFriend',
        last_interaction: '2026-03-09T12:00:00Z',
        relationship: { closeness: 8.0, sentiment: 'positive', tags: [] },
      }),
    ];
    const intents = generateSocialIntents(relations, makeMeta(), now);
    expect(intents).toHaveLength(0);
  });
});

describe('updateMetaStats', () => {
  it('counts relations by tier', () => {
    const relations = [
      makeRelation({ id: 'a', relationship: { closeness: 8, sentiment: 'positive', tags: [] } }),
      makeRelation({ id: 'b', relationship: { closeness: 5, sentiment: 'positive', tags: [] } }),
      makeRelation({ id: 'c', relationship: { closeness: 2, sentiment: 'neutral', tags: [] } }),
      makeRelation({ id: 'd', relationship: { closeness: 0.5, sentiment: 'neutral', tags: [] } }),
    ];
    const updated = updateMetaStats(makeMeta(), relations);
    expect(updated.stats.core).toBe(1);
    expect(updated.stats.familiar).toBe(1);
    expect(updated.stats.cognitive).toBe(1);
    expect(updated.stats.dormant).toBe(1);
  });
});

describe('reactivateRelation', () => {
  it('reactivates dormant relation to cognitive tier', () => {
    const r = makeRelation({
      relationship: { closeness: 0.3, sentiment: 'neutral', tags: [] },
    });
    const reactivated = reactivateRelation(r, '2026-03-10T12:00:00Z');
    expect(reactivated.relationship.closeness).toBe(1.0);
    expect(reactivated.last_interaction).toBe('2026-03-10T12:00:00Z');
    expect(reactivated.interaction_history).toHaveLength(1);
  });

  it('does not modify non-dormant relations', () => {
    const r = makeRelation({
      relationship: { closeness: 5.0, sentiment: 'positive', tags: [] },
    });
    const result = reactivateRelation(r, '2026-03-10T12:00:00Z');
    expect(result.relationship.closeness).toBe(5.0);
  });
});
