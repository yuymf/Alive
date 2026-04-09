/**
 * discovery-engine.test.ts
 * Tests for the content discovery and account discovery engines.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { setBasePaths, resetBasePaths, PATHS } from '../../scripts/utils/file-utils';
import {
  loadDiscoveryPool,
  saveDiscoveryPool,
  scoreContent,
  processInspirationForDiscovery,
  processInspirationForAccountDiscovery,
  loadCandidateAccounts,
  saveCandidateAccounts,
  buildDiscoveryContext,
  buildCandidateContext,
  approveCandidate,
  dismissCandidate,
  addCompetitorToPersona,
  DEFAULT_DISCOVERY_POOL,
} from '../../scripts/ops/discovery-engine';
import type { CandidateAccount } from '../../scripts/ops/discovery-engine';
import { writeJSON } from '../../scripts/utils/file-utils';
import { clearPersonaCache } from '../../scripts/persona/persona-loader';
import YAML from 'yaml';
import type { PersonaConfig, CompetitorProfile } from '../../scripts/utils/types';

const TEST_DIR = path.join(__dirname, '__discovery_test_sandbox__');

function cleanSandbox() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setBasePaths(TEST_DIR, path.join(TEST_DIR, '_skills'));
}

beforeEach(() => {
  cleanSandbox();
});

afterEach(() => {
  resetBasePaths();
  clearPersonaCache();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('scoreContent', () => {
  it('scores high-engagement content higher', () => {
    const low = scoreContent({ title: 'low', likes: 100, topic: 'test' });
    const high = scoreContent({ title: 'high', likes: 10000, topic: 'test' });
    expect(high).toBeGreaterThan(low);
  });

  it('gives bonus for takeaway', () => {
    const without = scoreContent({ title: 'a', likes: 1000, topic: 'test' });
    const withTakeaway = scoreContent({ title: 'a', likes: 1000, topic: 'test', takeaway: 'good stuff' });
    expect(withTakeaway).toBeGreaterThan(without);
  });
});

describe('processInspirationForDiscovery', () => {
  it('returns 0 when no inspiration state', () => {
    expect(processInspirationForDiscovery()).toBe(0);
  });

  it('adds high-engagement highlights to discovery pool', () => {
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [
        { title: '爆款标题', likes: 5000, topic: '电竞' },
        { title: '普通标题', likes: 100, topic: '日常' },
        { title: '超级爆款', likes: 20000, topic: '音乐' },
      ],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    const added = processInspirationForDiscovery();
    expect(added).toBe(2); // only 5000 and 20000 pass threshold

    const pool = loadDiscoveryPool();
    expect(pool.items).toHaveLength(2);
    expect(pool.items[0].title).toBe('超级爆款'); // sorted by score desc
  });

  it('deduplicates on title', () => {
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [
        { title: '爆款标题', likes: 5000, topic: '电竞' },
      ],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    processInspirationForDiscovery();
    const pool1 = loadDiscoveryPool();
    const count1 = pool1.items.length;

    const added2 = processInspirationForDiscovery();
    expect(added2).toBe(0); // already exists

    const pool2 = loadDiscoveryPool();
    expect(pool2.items).toHaveLength(count1); // same count
  });
});

describe('processInspirationForAccountDiscovery', () => {
  it('creates candidate when author appears multiple times', () => {
    // Set up discovery pool with repeated author
    saveDiscoveryPool({
      items: [
        { title: 'A', author: 'creator1', source: 'xhs', engagement: 5000, topic: '电竞', score: 80, discovered_at: '' },
        { title: 'B', author: 'creator1', source: 'xhs', engagement: 8000, topic: '音乐', score: 90, discovered_at: '' },
        { title: 'C', author: 'creator2', source: 'douyin', engagement: 3000, topic: '日常', score: 70, discovered_at: '' },
      ],
      last_updated: '',
    });

    // Also set up empty inspiration state
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    const newCandidates = processInspirationForAccountDiscovery();
    expect(newCandidates).toBe(1); // only creator1 has >= 2 appearances

    const store = loadCandidateAccounts();
    expect(store.candidates).toHaveLength(1);
    expect(store.candidates[0].name).toBe('creator1');
    expect(store.candidates[0].avg_engagement).toBe(6500);
    expect(store.candidates[0].topics).toContain('电竞');
  });

  it('新候选首次出现时正确初始化 peak_engagement', () => {
    saveDiscoveryPool({
      items: [
        { title: 'A', author: 'newcreator', source: 'xhs', engagement: 3000, topic: '生活', score: 70, discovered_at: '' },
        { title: 'B', author: 'newcreator', source: 'xhs', engagement: 7000, topic: '电竞', score: 85, discovered_at: '' },
      ],
      last_updated: '',
    });

    // Explicitly seed empty candidate store to ensure clean state
    saveCandidateAccounts({ candidates: [], last_updated: '' });

    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    processInspirationForAccountDiscovery();

    const store = loadCandidateAccounts();
    const candidate = store.candidates.find(c => c.name === 'newcreator');
    expect(candidate).toBeDefined();
    // peak_engagement should be the maximum engagement among all items for this author
    expect(candidate!.peak_engagement).toBe(7000);
  });

  it('候选再次出现互动更高时 peak_engagement 更新', () => {
    // Seed an existing candidate with peak_engagement = 5000
    saveCandidateAccounts({
      candidates: [{
        name: 'creator_update', platform: 'xhs',
        appearance_count: 2, avg_engagement: 5000, peak_engagement: 5000,
        topics: ['音乐'],
        first_seen: '2026-04-01', last_seen: '2026-04-01',
        status: 'pending',
      }],
      last_updated: '',
    });

    // New pool items: same author with a higher engagement post
    saveDiscoveryPool({
      items: [
        { title: 'X', author: 'creator_update', source: 'xhs', engagement: 4000, topic: '音乐', score: 80, discovered_at: '' },
        { title: 'Y', author: 'creator_update', source: 'xhs', engagement: 9000, topic: '电竞', score: 95, discovered_at: '' },
      ],
      last_updated: '',
    });

    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    processInspirationForAccountDiscovery();

    const store = loadCandidateAccounts();
    const candidate = store.candidates.find(c => c.name === 'creator_update')!;
    expect(candidate.peak_engagement).toBe(9000);
  });

  it('候选再次出现互动更低时 peak_engagement 不变', () => {
    // Seed an existing candidate with peak_engagement = 10000
    saveCandidateAccounts({
      candidates: [{
        name: 'creator_stable', platform: 'xhs',
        appearance_count: 3, avg_engagement: 8000, peak_engagement: 10000,
        topics: ['生活'],
        first_seen: '2026-04-01', last_seen: '2026-04-02',
        status: 'pending',
      }],
      last_updated: '',
    });

    // New pool items: same author but lower engagement
    saveDiscoveryPool({
      items: [
        { title: 'P', author: 'creator_stable', source: 'xhs', engagement: 2000, topic: '生活', score: 60, discovered_at: '' },
        { title: 'Q', author: 'creator_stable', source: 'xhs', engagement: 3000, topic: '美食', score: 65, discovered_at: '' },
      ],
      last_updated: '',
    });

    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    processInspirationForAccountDiscovery();

    const store = loadCandidateAccounts();
    const candidate = store.candidates.find(c => c.name === 'creator_stable')!;
    // peak_engagement should remain 10000 (not updated by lower engagements)
    expect(candidate.peak_engagement).toBe(10000);
  });

  it('候选无 peak_engagement 字段时（旧存档），fallback 到 avg_engagement', () => {
    // Seed a candidate that is missing peak_engagement (simulates a legacy record).
    // The code runs: existing.avg_engagement = avgEngagement  (line A)
    //   then:        existing.peak_engagement = Math.max(existing.peak_engagement ?? existing.avg_engagement, data.maxEngagement)
    // Because line A fires first, the fallback uses the newly-computed avg from pool data.
    const legacyCandidate: CandidateAccount = {
      name: 'legacy_user',
      platform: 'xhs',
      avg_engagement: 9999, // will be overwritten by pool-derived avg; kept distinct for clarity
      appearance_count: 2,
      topics: ['赛车'],
      status: 'pending',
      first_seen: '2026-01-01',
      last_seen: '2026-01-01',
      // peak_engagement is intentionally absent (legacy record)
    } as unknown as CandidateAccount;
    saveCandidateAccounts({ candidates: [legacyCandidate], last_updated: '' });

    // Two pool items for the same author, both with engagement 3000.
    // pool-derived: avgEngagement = 3000, maxEngagement = 3000
    // After line A: existing.avg_engagement = 3000
    // peak_engagement = Math.max(undefined ?? 3000, 3000) = 3000
    saveDiscoveryPool({
      items: [
        { title: 'P1', author: 'legacy_user', source: 'xhs', engagement: 3000, topic: '漂移', score: 65, discovered_at: '' },
        { title: 'P2', author: 'legacy_user', source: 'xhs', engagement: 3000, topic: '漂移', score: 65, discovered_at: '' },
      ],
      last_updated: '',
    });

    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    processInspirationForAccountDiscovery();

    const updatedStore = loadCandidateAccounts();
    const candidate = updatedStore.candidates.find(c => c.name === 'legacy_user');
    expect(candidate).toBeDefined();
    // The ?? branch fires (peak_engagement was undefined); result must equal
    // Math.max(avg_engagement=3000, maxEngagement=3000) = 3000 — not undefined.
    expect(candidate!.peak_engagement).toBe(3000);
  });
});

describe('buildDiscoveryContext', () => {
  it('returns empty when pool has no items', () => {
    saveDiscoveryPool({ items: [], last_updated: '' });
    expect(buildDiscoveryContext()).toBe('');
  });

  it('returns formatted context with top items', () => {
    saveDiscoveryPool({
      items: [
        { title: '爆款1', author: '', source: 'xhs', engagement: 10000, topic: '电竞', score: 90, discovered_at: '' },
      ],
      last_updated: '',
    });
    const ctx = buildDiscoveryContext();
    expect(ctx).toContain('爆款发现');
    expect(ctx).toContain('爆款1');
  });
});

describe('buildCandidateContext', () => {
  it('returns empty when no pending candidates', () => {
    saveCandidateAccounts({ candidates: [], last_updated: '' });
    expect(buildCandidateContext()).toBe('');
  });

  it('shows pending candidates with composite score using provided identityKeys', () => {
    const store = {
      candidates: [
        {
          name: 'testuser', platform: 'xhs',
          appearance_count: 5, avg_engagement: 1000,
          peak_engagement: 5000,
          topics: ['音乐', '赛车', '电竞', '日常'],
          first_seen: '2026-04-01', last_seen: '2026-04-05',
          status: 'pending' as const,
        },
        {
          name: 'lowcount', platform: 'xhs',
          appearance_count: 1, avg_engagement: 500,
          peak_engagement: 500,
          topics: ['日常'],
          first_seen: '2026-04-01', last_seen: '2026-04-01',
          status: 'pending' as const,
        },
      ],
      last_updated: '',
    };
    writeJSON(PATHS.candidateAccounts, store);
    const ctx = buildCandidateContext(['singer', 'racer', 'esports', 'daily']);
    expect(ctx).toContain('候选对标');
    expect(ctx).toContain('testuser');
    // New format shows composite score
    expect(ctx).toContain('综合');
    // New format shows peak engagement
    expect(ctx).toContain('峰值');
    // lowcount candidate should be filtered out (appearance_count < MIN_APPEARANCES_FOR_SUGGESTION)
    expect(ctx).not.toContain('lowcount');
  });

  it('still works with no identityKeys argument (backward compatible)', () => {
    const store = {
      candidates: [{
        name: 'legacyuser', platform: 'douyin',
        appearance_count: 3, avg_engagement: 2000,
        peak_engagement: 2000,
        topics: ['日常'],
        first_seen: '2026-04-01', last_seen: '2026-04-03',
        status: 'pending' as const,
      }],
      last_updated: '',
    };
    writeJSON(PATHS.candidateAccounts, store);
    const ctx = buildCandidateContext(); // no args
    expect(ctx).toContain('候选对标');
    expect(ctx).toContain('legacyuser');
  });
});

describe('candidate management', () => {
  it('approves and dismisses candidates', () => {
    writeJSON(PATHS.candidateAccounts, {
      candidates: [
        { name: 'a', platform: 'xhs', appearance_count: 3, avg_engagement: 5000, peak_engagement: 5000, topics: [], first_seen: '', last_seen: '', status: 'pending' },
        { name: 'b', platform: 'douyin', appearance_count: 2, avg_engagement: 3000, peak_engagement: 3000, topics: [], first_seen: '', last_seen: '', status: 'pending' },
      ],
      last_updated: '',
    });

    expect(approveCandidate('a', 'xhs')).toBe(true);
    expect(dismissCandidate('b', 'douyin')).toBe(true);
    expect(approveCandidate('nonexistent', 'xhs')).toBe(false);

    const store = loadCandidateAccounts();
    expect(store.candidates.find(c => c.name === 'a')!.status).toBe('approved');
    expect(store.candidates.find(c => c.name === 'b')!.status).toBe('dismissed');
  });
});

// ─── P3-B: Auto-write to persona.yaml ──────────────────────────────────────

const MINIMAL_PERSONA: PersonaConfig = {
  meta: { name: 'Test', tagline: 'test persona' },
  personality: { mbti: 'ENTJ', core_traits: ['test'] },
  voice: { language: 'zh-CN', style: 'test', sample_lines: ['test'] },
  ops: {
    enabled: true,
    brief_time: '08:30',
    competitor_accounts: { xhs: [], douyin: [] },
    trend_score_threshold: 1.0,
    topic_count: 3,
    topic_filter_prompt: '',
    platforms: {},
  },
};

function writePersonaYaml(persona: PersonaConfig = MINIMAL_PERSONA) {
  fs.writeFileSync(PATHS.personaConfig, YAML.stringify(persona, { indent: 2 }));
  clearPersonaCache();
}

describe('addCompetitorToPersona', () => {
  it('adds a competitor to persona.yaml', () => {
    writePersonaYaml();

    const profile: CompetitorProfile = {
      name: 'test_creator',
      platform: 'xhs',
      tag: 'discovered',
      tag_desc: 'auto-discovered',
      reference_type: 'secondary',
    };

    expect(addCompetitorToPersona(profile)).toBe(true);

    // Verify persona.yaml was updated
    const raw = fs.readFileSync(PATHS.personaConfig, 'utf8');
    const persona = YAML.parse(raw) as PersonaConfig;
    expect(persona.ops?.competitors).toHaveLength(1);
    expect(persona.ops!.competitors![0].name).toBe('test_creator');
    expect(persona.ops!.competitors![0].reference_type).toBe('secondary');
  });

  it('prevents duplicate competitors (same name + platform)', () => {
    writePersonaYaml({
      ...MINIMAL_PERSONA,
      ops: {
        ...MINIMAL_PERSONA.ops!,
        competitors: [
          { name: 'existing', platform: 'douyin', tag: 'test', tag_desc: 'test', reference_type: 'primary' },
        ],
      },
    });

    const duplicate: CompetitorProfile = {
      name: 'existing',
      platform: 'douyin',
      tag: 'discovered',
      tag_desc: 'auto-discovered',
      reference_type: 'secondary',
    };

    expect(addCompetitorToPersona(duplicate)).toBe(false);

    // Verify no duplicate was added
    const raw = fs.readFileSync(PATHS.personaConfig, 'utf8');
    const persona = YAML.parse(raw) as PersonaConfig;
    expect(persona.ops?.competitors).toHaveLength(1);
  });

  it('returns false when persona.yaml does not exist', () => {
    // Don't create persona.yaml
    const profile: CompetitorProfile = {
      name: 'ghost',
      platform: 'xhs',
      tag: 'test',
      tag_desc: 'test',
      reference_type: 'secondary',
    };
    expect(addCompetitorToPersona(profile)).toBe(false);
  });

  it('creates .bak backup before writing', () => {
    writePersonaYaml();

    const profile: CompetitorProfile = {
      name: 'backup_test',
      platform: 'bilibili',
      tag: 'discovered',
      tag_desc: 'auto',
      reference_type: 'secondary',
    };

    addCompetitorToPersona(profile);
    expect(fs.existsSync(PATHS.personaConfig + '.bak')).toBe(true);
  });

  it('initializes ops.competitors when ops has no competitors array', () => {
    // Write persona with ops but no competitors key
    const personaNoCompetitors = { ...MINIMAL_PERSONA };
    const opsWithoutCompetitors = { ...personaNoCompetitors.ops! };
    delete (opsWithoutCompetitors as Record<string, unknown>).competitors;
    personaNoCompetitors.ops = opsWithoutCompetitors;
    writePersonaYaml(personaNoCompetitors);

    const profile: CompetitorProfile = {
      name: 'new_creator',
      platform: 'douyin',
      tag: 'discovered',
      tag_desc: 'auto',
      reference_type: 'secondary',
    };

    expect(addCompetitorToPersona(profile)).toBe(true);

    const raw = fs.readFileSync(PATHS.personaConfig, 'utf8');
    const persona = YAML.parse(raw) as PersonaConfig;
    expect(persona.ops?.competitors).toHaveLength(1);
    expect(persona.ops!.competitors![0].name).toBe('new_creator');
  });
});

describe('auto-approve: high-scoring candidates are automatically approved', () => {
  it('auto-approves a candidate with composite score ≥ 0.80', () => {
    writePersonaYaml();

    // Set up a candidate that will score very high:
    // - all 4 identity tracks hit (track_overlap = 1.0)
    // - peak/avg = 5 (burst_intensity = 1.0)
    // - appearance_count = 5 (frequency = 1.0)
    // → composite = 1.0 * 0.45 + 1.0 * 0.35 + 1.0 * 0.20 = 1.0 ≥ 0.80
    saveCandidateAccounts({
      candidates: [{
        name: 'superstar',
        platform: 'xhs',
        appearance_count: 5,
        avg_engagement: 1000,
        peak_engagement: 5000,
        topics: ['音乐', '赛车', '电竞', '日常'],
        first_seen: '2026-04-01',
        last_seen: '2026-04-05',
        status: 'pending',
      }],
      last_updated: '',
    });

    saveDiscoveryPool({
      items: [
        { title: 'T1', author: 'superstar', source: 'xhs', engagement: 5000, topic: '音乐', score: 90, discovered_at: '' },
        { title: 'T2', author: 'superstar', source: 'xhs', engagement: 5000, topic: '赛车', score: 90, discovered_at: '' },
        { title: 'T3', author: 'superstar', source: 'xhs', engagement: 5000, topic: '电竞', score: 90, discovered_at: '' },
        { title: 'T4', author: 'superstar', source: 'xhs', engagement: 5000, topic: '日常', score: 90, discovered_at: '' },
        { title: 'T5', author: 'superstar', source: 'xhs', engagement: 5000, topic: '音乐', score: 90, discovered_at: '' },
      ],
      last_updated: '',
    });

    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    // Call with identityKeys so scorer can compute track_overlap
    processInspirationForAccountDiscovery(['singer', 'racer', 'esports', 'daily']);

    const store = loadCandidateAccounts();
    const superstar = store.candidates.find(c => c.name === 'superstar')!;
    expect(superstar.status).toBe('approved');
  });

  it('does not auto-approve a candidate below 0.80 threshold', () => {
    writePersonaYaml();

    saveCandidateAccounts({
      candidates: [{
        name: 'mediocre',
        platform: 'xhs',
        appearance_count: 2,
        avg_engagement: 1000,
        peak_engagement: 1000,
        topics: ['未知话题'],
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        status: 'pending',
      }],
      last_updated: '',
    });
    saveDiscoveryPool({
      items: [
        { title: 'A', author: 'mediocre', source: 'xhs', engagement: 1000, topic: '未知话题', score: 50, discovered_at: '' },
        { title: 'B', author: 'mediocre', source: 'xhs', engagement: 1000, topic: '未知话题', score: 50, discovered_at: '' },
      ],
      last_updated: '',
    });
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [], trending_topics: [], domain_insights: [], saved_inspirations: [],
    });

    processInspirationForAccountDiscovery(['singer', 'racer', 'esports', 'daily']);

    const store = loadCandidateAccounts();
    const mediocre = store.candidates.find(c => c.name === 'mediocre')!;
    expect(mediocre.status).toBe('pending'); // not auto-approved
  });

  it('auto-approves at most 1 candidate per tick even if multiple qualify', () => {
    writePersonaYaml();

    // Two equally high-scoring candidates
    saveCandidateAccounts({
      candidates: [
        {
          name: 'star_a', platform: 'xhs',
          appearance_count: 5, avg_engagement: 1000, peak_engagement: 5000,
          topics: ['音乐', '赛车', '电竞', '日常'],
          first_seen: '2026-04-01', last_seen: '2026-04-05', status: 'pending',
        },
        {
          name: 'star_b', platform: 'xhs',
          appearance_count: 5, avg_engagement: 1000, peak_engagement: 5000,
          topics: ['音乐', '赛车', '电竞', '日常'],
          first_seen: '2026-04-01', last_seen: '2026-04-05', status: 'pending',
        },
      ],
      last_updated: '',
    });
    saveDiscoveryPool({
      items: [
        ...(['T1','T2','T3','T4','T5'] as const).map((t, i) => ({
          title: t, author: 'star_a', source: 'xhs' as const,
          engagement: 5000, topic: ['音乐','赛车','电竞','日常','音乐'][i], score: 90, discovered_at: '',
        })),
        ...(['U1','U2','U3','U4','U5'] as const).map((t, i) => ({
          title: t, author: 'star_b', source: 'xhs' as const,
          engagement: 5000, topic: ['音乐','赛车','电竞','日常','音乐'][i], score: 90, discovered_at: '',
        })),
      ],
      last_updated: '',
    });
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [], trending_topics: [], domain_insights: [], saved_inspirations: [],
    });

    processInspirationForAccountDiscovery(['singer', 'racer', 'esports', 'daily']);

    const store = loadCandidateAccounts();
    const approvedCount = store.candidates.filter(c => c.status === 'approved').length;
    expect(approvedCount).toBe(1); // max 1 per tick
  });
});

describe('approveCandidate auto-writes to persona.yaml', () => {
  it('auto-adds approved candidate to persona.yaml competitors', () => {
    writePersonaYaml();
    writeJSON(PATHS.candidateAccounts, {
      candidates: [
        { name: 'hot_creator', platform: 'xhs', appearance_count: 5, avg_engagement: 8000, peak_engagement: 10000, topics: ['电竞', '日常'], first_seen: '2026-04-01', last_seen: '2026-04-03', status: 'pending' },
      ],
      last_updated: '',
    });

    expect(approveCandidate('hot_creator', 'xhs')).toBe(true);

    // Verify candidate status
    const store = loadCandidateAccounts();
    expect(store.candidates[0].status).toBe('approved');

    // Verify persona.yaml was updated
    const raw = fs.readFileSync(PATHS.personaConfig, 'utf8');
    const persona = YAML.parse(raw) as PersonaConfig;
    expect(persona.ops?.competitors).toHaveLength(1);
    const comp = persona.ops!.competitors![0];
    expect(comp.name).toBe('hot_creator');
    expect(comp.platform).toBe('xhs');
    expect(comp.reference_type).toBe('secondary');
    expect(comp.group).toBe('auto-discovered');
    expect(comp.tag_desc).toContain('出现5次');
  });

  it('approve still succeeds even if persona.yaml is missing', () => {
    // No persona.yaml — approve should still work (candidate status changes)
    writeJSON(PATHS.candidateAccounts, {
      candidates: [
        { name: 'solo', platform: 'douyin', appearance_count: 2, avg_engagement: 3000, peak_engagement: 3000, topics: [], first_seen: '', last_seen: '', status: 'pending' },
      ],
      last_updated: '',
    });

    expect(approveCandidate('solo', 'douyin')).toBe(true);

    const store = loadCandidateAccounts();
    expect(store.candidates[0].status).toBe('approved');
    // persona.yaml doesn't exist, that's fine
    expect(fs.existsSync(PATHS.personaConfig)).toBe(false);
  });
});
