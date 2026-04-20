import type { CompetitorProfile } from '../utils/types';

const DOUYIN_USER_RE = /douyin\.com\/user\/([A-Za-z0-9_=-]+)/;
const XHS_USER_RE = /xiaohongshu\.com\/user\/profile\/([a-f0-9]{24})/;
const BILIBILI_USER_RE = /space\.bilibili\.com\/(\d+)/;

export function buildCompetitorKey(name: string, platform: string): string {
  return `${name}:${platform}`;
}

export function buildCompetitorKeyFromProfile(
  profile: Pick<CompetitorProfile, 'name' | 'platform'>,
): string {
  return buildCompetitorKey(profile.name, profile.platform);
}

export function getCompetitorFetchId(
  profile: Pick<CompetitorProfile, 'platform' | 'external_id' | 'url' | 'name'>,
): string {
  if (profile.external_id) return profile.external_id;

  if (profile.platform === 'douyin') {
    return profile.url?.match(DOUYIN_USER_RE)?.[1] ?? profile.name;
  }
  if (profile.platform === 'xhs') {
    return profile.url?.match(XHS_USER_RE)?.[1] ?? profile.name;
  }
  if (profile.platform === 'bilibili') {
    return profile.url?.match(BILIBILI_USER_RE)?.[1] ?? profile.name;
  }

  return profile.name;
}

export function findProfileByFetchId(
  profiles: readonly CompetitorProfile[],
  platform: CompetitorProfile['platform'],
  fetchId: string,
): CompetitorProfile | undefined {
  return profiles.find(profile => {
    if (profile.platform !== platform) return false;
    return getCompetitorFetchId(profile) === fetchId;
  });
}
