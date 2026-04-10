/**
 * ops-taxonomy.ts
 * Explicit mapping between identity modes, template categories,
 * and competitor group/tag labels. Eliminates brittle substring matching.
 */

import { IdentityMode } from '../utils/types';

/**
 * For each identity mode, lists the template categories AND competitor
 * group/tag labels that belong to it.
 * Used by buildCompetitorBenchmarks and buildCompetitorContext to filter
 * relevant profiles instead of relying on substring includes().
 */
export const OPS_IDENTITY_TAXONOMY: Record<IdentityMode, readonly string[]> = {
  esports: ['电竞解说', '硬核电竞解说'],
  singer:  ['音乐', '偶像歌手'],
  racer:   ['赛车', '赛道飒爽女车手'],
  daily:   ['生活日常', '低调轻奢富家千金'],
};

/**
 * Check whether a given label (template category or competitor group/tag)
 * belongs to a specific identity mode.
 */
export function matchesTaxonomy(identityMode: IdentityMode, label: string): boolean {
  const aliases = OPS_IDENTITY_TAXONOMY[identityMode];
  if (!aliases) return false;
  return aliases.some(alias =>
    alias === label || label.includes(alias) || alias.includes(label),
  );
}

/** All supported identity modes. Used for cross-mode writes (e.g. AI虚拟偶像 accounts). */
export const ALL_IDENTITY_MODES: IdentityMode[] = Object.keys(OPS_IDENTITY_TAXONOMY) as IdentityMode[];

/**
 * Topic keyword table for candidate track-overlap scoring.
 * Maps identity mode keys to topic terms that indicate content relevance.
 * Pre-computed lowercase version is generated at module load by candidate-scorer.
 */
export const IDENTITY_TOPIC_KEYWORDS: Record<string, readonly string[]> = {
  singer:  ['音乐', '唱歌', '歌曲', 'vocal', '翻唱', '原创', 'mv', '歌手', '单曲'],
  racer:   ['赛车', '漂移', '赛道', 'motorsport', 'gt', '超跑', '驾驶', '改装'],
  esports: ['电竞', '游戏', '直播', '战队', '解说', 'fps', 'moba', '比赛'],
  daily:   ['日常', 'vlog', '生活', '穿搭', '美食', '旅行', '打卡', '探店'],
};

/**
 * Given a competitor group/tag, find which identity mode it maps to.
 * Returns undefined if no match.
 */
export function identityModeForLabel(label: string): IdentityMode | undefined {
  for (const [mode, aliases] of Object.entries(OPS_IDENTITY_TAXONOMY)) {
    if ((aliases as readonly string[]).some(a => a === label || label.includes(a) || a.includes(label))) {
      return mode as IdentityMode;
    }
  }
  return undefined;
}
