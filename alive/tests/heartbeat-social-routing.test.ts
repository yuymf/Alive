import { describe, it, expect } from 'vitest';
import * as heartbeatTick from '../scripts/lifecycle/heartbeat-tick';

describe('heartbeat social routing helpers', () => {
  it('reads hashtags from instagram_trends and normalizes # prefixes', () => {
    const hashtags = heartbeatTick.getOutboundHashtagsFromInspiration({
      instagram_trends: {
        hot_styles: [],
        high_engagement_patterns: [],
        trending_hashtags: ['#cosplay', 'animegirl', ' #dailylook '],
        updated_at: 0,
      },
      acg_hotspots: {
        trending_characters: [],
        upcoming_events: [],
        seasonal_themes: [],
        updated_at: 0,
      },
      visual_trends: {
        composition_styles: [],
        color_palettes: [],
        scene_ideas: [],
        updated_at: 0,
      },
      self_performance: {
        best_style: 'cos',
        best_time_slots: [],
        best_hashtag_combos: [['fallback_tag']],
        engagement_by_style: {},
        updated_at: 0,
      },
      xiaohongshu_trends: {
        feed_highlights: [],
        cosplay_notes: [],
        trending_topics: [],
        cosplay_insights: [],
        saved_inspirations: [],
      },
    } as any);

    expect(hashtags).toEqual(['cosplay', 'animegirl', 'dailylook']);
  });

  it('falls back to best hashtag combos when instagram trends are empty', () => {
    const hashtags = heartbeatTick.getOutboundHashtagsFromInspiration({
      instagram_trends: {
        hot_styles: [],
        high_engagement_patterns: [],
        trending_hashtags: [],
        updated_at: 0,
      },
      acg_hotspots: {
        trending_characters: [],
        upcoming_events: [],
        seasonal_themes: [],
        updated_at: 0,
      },
      visual_trends: {
        composition_styles: [],
        color_palettes: [],
        scene_ideas: [],
        updated_at: 0,
      },
      self_performance: {
        best_style: 'cos',
        best_time_slots: [],
        best_hashtag_combos: [['#fallback_a', ' fallback_b '], ['fallback_b', 'fallback_c']],
        engagement_by_style: {},
        updated_at: 0,
      },
      xiaohongshu_trends: {
        feed_highlights: [],
        cosplay_notes: [],
        trending_topics: [],
        cosplay_insights: [],
        saved_inspirations: [],
      },
    } as any);

    expect(hashtags).toEqual(['fallback_a', 'fallback_b', 'fallback_c']);
  });

  it('returns an empty array when no hashtags are available', () => {
    const hashtags = heartbeatTick.getOutboundHashtagsFromInspiration({
      instagram_trends: {
        hot_styles: [],
        high_engagement_patterns: [],
        trending_hashtags: [],
        updated_at: 0,
      },
      acg_hotspots: {
        trending_characters: [],
        upcoming_events: [],
        seasonal_themes: [],
        updated_at: 0,
      },
      visual_trends: {
        composition_styles: [],
        color_palettes: [],
        scene_ideas: [],
        updated_at: 0,
      },
      self_performance: {
        best_style: 'cos',
        best_time_slots: [],
        best_hashtag_combos: [],
        engagement_by_style: {},
        updated_at: 0,
      },
      xiaohongshu_trends: {
        feed_highlights: [],
        cosplay_notes: [],
        trending_topics: [],
        cosplay_insights: [],
        saved_inspirations: [],
      },
    } as any);

    expect(hashtags).toEqual([]);
  });
});
