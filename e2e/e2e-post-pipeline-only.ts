#!/usr/bin/env npx tsx
/**
 * Focused E2E test: runs ONLY the post pipeline (photo + post creation).
 * Mocks Instagram, XHS, and ImgURL. Shows the prepared content without actually posting.
 *
 * Usage: npx tsx e2e/e2e-post-pipeline-only.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths, PATHS, readJSON } from '../skill/scripts/file-utils';
import { setTimeOverride, clearTimeOverride } from '../skill/scripts/time-utils';
import { runPipeline } from '../skill/scripts/post-pipeline';
import { DEFAULT_PHOTO_GALLERY } from '../skill/scripts/types';
import type { PostHistory, PhotoGallery } from '../skill/scripts/types';
import {
  initSandbox, loadApiKeys, applyApiKeys, setupMockEnv,
  SANDBOX_MEMORY, SKILL_DIR, OUTPUT_DIR,
} from './shared/setup';

async function main(): Promise<void> {
  console.log('=== Post Pipeline E2E (focused) ===\n');

  // Load and apply API keys (excluding IMGURL_TOKEN — let mock handle it)
  const keys = loadApiKeys();
  applyApiKeys(keys, ['IMGURL_TOKEN']);

  // Set mock environment
  const restoreEnv = setupMockEnv({ instagram: true, xhs: true, imgurl: true });

  // Init sandbox with pipeline-friendly overrides
  initSandbox({
    overrides: {
      'emotion-state.json': {
        mood: { valence: 0.7, arousal: 0.6, description: '心情不错，想拍照' },
        energy: 0.7, stress: 0.15, creativity: 0.8, sociability: 0.6,
        last_updated: null, recent_cause: '灵感涌来',
        momentum: { valence: 0, arousal: 0, energy: 0, stress: 0, creativity: 0, sociability: 0 },
        undertone: { valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
        impulse_history: [],
        consecutive_high_stress: 0,
        threshold_break_cooldown: 0,
      },
      'post-impulse.json': { value: 80, last_updated: null, dormancy_days: 0 },
      'preferences.json': {
        cos_characters: ['初音ミク', '明日香'],
        content_style: ['日系清新', '暖色调'],
        active_hours: [14, 15, 16],
        social_platforms: ['instagram'],
      },
      'inspiration.json': {
        instagram_trends: { hot_styles: ['制服cos', '日常穿搭'], high_engagement_patterns: ['自然光+浅景深'], trending_hashtags: ['#cosplay', '#animegirl', '#日系'], updated_at: Date.now() },
        acg_hotspots: { trending_characters: ['フリーレン', '推しの子'], upcoming_events: [], seasonal_themes: ['春季'], updated_at: Date.now() },
        visual_trends: { composition_styles: ['三分法构图'], color_palettes: ['樱花粉+白'], scene_ideas: ['樱花树下'], updated_at: Date.now() },
        self_performance: { best_style: 'cos', best_time_slots: ['14:00-16:00'], best_hashtag_combos: [['cosplay', 'anime']], engagement_by_style: { cos: 4.5 }, updated_at: Date.now() },
        xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: Date.now() },
      },
    },
  });

  setBasePaths(SANDBOX_MEMORY, SKILL_DIR);

  // Simulate afternoon time (good for posting)
  const simDate = new Date('2026-06-15T14:30:00');
  setTimeOverride(simDate);

  console.log(`Simulated time: ${simDate.toLocaleString('zh-CN')}`);
  console.log(`LLM_MODEL: ${process.env.LLM_MODEL ?? '(not set)'}`);
  console.log(`AIHUBMIX_API_KEY: ${process.env.AIHUBMIX_API_KEY ? '***set***' : '(not set)'}`);
  console.log('');

  // Run pipeline
  const startTime = Date.now();
  try {
    await runPipeline();
  } catch (err) {
    console.error(`Pipeline error:`, err);
  }
  const duration = Date.now() - startTime;

  // Collect and display results
  console.log('\n' + '='.repeat(60));
  console.log('=== RESULTS ===');
  console.log('='.repeat(60));

  // 1. Post history (shows what would have been posted)
  const postHistory = readJSON<PostHistory>(PATHS.postHistory, { posts: [] });
  if (postHistory.posts.length > 0) {
    const lastPost = postHistory.posts[postHistory.posts.length - 1];
    console.log('\n--- Instagram Post (准备发布的内容) ---');
    console.log(`Caption:\n${lastPost.caption}`);
    console.log(`\nHashtags: ${lastPost.hashtags.map(t => '#' + t).join(' ')}`);
    console.log(`Style: ${lastPost.style}`);
    console.log(`Photo count: ${lastPost.image_local_paths.length}`);
    for (const p of lastPost.image_local_paths) {
      console.log(`  ${p}`);
      // Copy to output
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, path.join(OUTPUT_DIR, path.basename(p)));
      }
    }
  } else {
    console.log('\n--- No post was created ---');
  }

  // 2. Photo gallery
  const gallery = readJSON<PhotoGallery>(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
  if (gallery.photos.length > 0) {
    console.log(`\n--- Photo Gallery (${gallery.photos.length} photos) ---`);
    for (const photo of gallery.photos) {
      console.log(`  [${photo.style}] ${photo.description}`);
      console.log(`    Tags: ${photo.tags.join(', ')}`);
      console.log(`    Path: ${photo.localPath}`);
      // Copy to output
      if (fs.existsSync(photo.localPath)) {
        fs.copyFileSync(photo.localPath, path.join(OUTPUT_DIR, path.basename(photo.localPath)));
      }
    }
  }

  // 3. Diary
  const diary = fs.readFileSync(path.join(SANDBOX_MEMORY, 'diary.md'), 'utf8');
  if (diary.length > 30) {
    console.log('\n--- Diary Entries ---');
    console.log(diary);
  }

  // 4. Summary
  console.log('\n--- Summary ---');
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log(`Posts created: ${postHistory.posts.length}`);
  console.log(`Gallery photos: ${gallery.photos.length}`);

  // List generated images
  const photoRoll = path.join(SANDBOX_MEMORY, 'photo-roll');
  if (fs.existsSync(photoRoll)) {
    let imageCount = 0;
    for (const dateDir of fs.readdirSync(photoRoll)) {
      const dirPath = path.join(photoRoll, dateDir);
      if (fs.statSync(dirPath).isDirectory()) {
        for (const file of fs.readdirSync(dirPath)) {
          if (file.endsWith('.png') || file.endsWith('.jpg')) {
            imageCount++;
            const srcPath = path.join(dirPath, file);
            fs.copyFileSync(srcPath, path.join(OUTPUT_DIR, file));
          }
        }
      }
    }
    console.log(`Generated images: ${imageCount}`);
  }

  console.log(`\nOutput saved to: ${OUTPUT_DIR}`);

  // Cleanup
  resetBasePaths();
  clearTimeOverride();
  restoreEnv();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
