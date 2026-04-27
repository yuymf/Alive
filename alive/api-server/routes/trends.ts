import { Router, Request, Response } from 'express';
import { loadSkillEnvVars, readJSON, PATHS } from '../../scripts/utils/file-utils';
import { loadPersona } from '../../scripts/persona/persona-loader';
import { readCachedTrendsWithMeta, buildPersonaIdentities } from '../../scripts/ops/trend-analyzer';
import type { FilteredTrend } from '../../scripts/ops/trend-analyzer';

loadSkillEnvVars('alive');

const router = Router();

const MIN_TRENDS_BEFORE_FALLBACK = 8;

interface DiscoveryPoolItem {
  title: string;
  author?: string;
  source: string;          // e.g. "search:xhs", "douyin"
  engagement: number;
  topic: string;
  score: number;
  discovered_at: string;
}

interface DiscoveryPoolFile {
  items: DiscoveryPoolItem[];
  last_updated?: string;
}

/**
 * Convert a discovery-pool item into a FilteredTrend-shaped object so the
 * /trends page can render a unified list. Tagged with source_type so the
 * frontend can visually distinguish "backfill" entries from live velocity.
 */
function adaptDiscoveryItem(item: DiscoveryPoolItem): FilteredTrend {
  const platformRaw = (item.source || '').replace(/^search:/, '');
  const platform = platformRaw || 'unknown';
  return {
    platform,
    keyword: item.topic || item.title,
    current_volume: item.engagement ?? 0,
    avg_7d: 0,
    velocity_score: 1.0,
    rank: 999,
    _source: 'discovery_pool',
    source_type: 'discovery_pool',
    source_bucket: '发现池补充',
    signal_kind: 'recommended_track',
    display_metric: `❤️${(item.engagement ?? 0).toLocaleString('zh-CN')}`,
    priority_score: Math.max(1.0, (item.score ?? 0) / 100),
    description: item.title,
    category: item.topic,
    hook_angle: `基于「${item.title}」（@${item.author ?? '?'}，${platform}）— 从 V姐赛道切入，借势发现池热帖做差异化表达`,
    identity_mode: inferIdentityMode(item.topic),
  };
}

function inferIdentityMode(topic: string): FilteredTrend['identity_mode'] {
  const t = (topic || '').toLowerCase();
  if (/赛车|f1|车手|driving|驾驶/i.test(t)) return 'racer';
  if (/电竞|kpl|lpl|valorant|无畏契约|选手|战队/i.test(t)) return 'esports';
  if (/歌|音乐|singer|爱豆|偶像/i.test(t)) return 'singer';
  return 'daily';
}

router.get('/', (_req: Request, res: Response) => {
  try {
    const persona = loadPersona();
    const identities = buildPersonaIdentities(persona);
    const meta = readCachedTrendsWithMeta(identities);

    // Backfill from discovery pool if the cache has fewer than N results.
    if (meta.results.length < MIN_TRENDS_BEFORE_FALLBACK) {
      const pool = readJSON<DiscoveryPoolFile>(PATHS.discoveryPool, { items: [] });
      const existingKeywords = new Set(meta.results.map(r => `${r.platform}::${r.keyword}`));
      const backfill = (pool.items ?? [])
        .slice() // copy
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .map(adaptDiscoveryItem)
        .filter(r => !existingKeywords.has(`${r.platform}::${r.keyword}`))
        .slice(0, MIN_TRENDS_BEFORE_FALLBACK * 2 - meta.results.length);

      res.json({
        ...meta,
        results: [...meta.results, ...backfill],
        backfill_count: backfill.length,
        backfill_source: 'discovery_pool',
      });
      return;
    }

    res.json(meta);
  } catch (err) {
    console.error('[trends GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
