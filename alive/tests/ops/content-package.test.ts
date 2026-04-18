import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { formatContentPackage } from '../../scripts/ops/brief-generator';
import { extractPlatformUrl, parsePublishIntent } from '../../sub-skills/ops-desk/scripts/message-parser';
import { QueueItem } from '../../scripts/utils/types';

const tmpDir = path.join(os.tmpdir(), 'alive-pkg-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-03-31T10:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sampleItem: QueueItem = {
  id: 'q_test_123',
  status: 'approved',
  topic: '蹭 电竞S16：女性视角赛场氛围感',
  trend_hook: '电竞S16 (douyin, 2.1x)',
  identity_mode: 'esports',
  created_at: '2026-03-31T08:00:00Z',
  updated_at: '2026-03-31T09:00:00Z',
  content: {
    xhs: {
      title: '有人说女生不懂电竞？排位赛不说谎。',
      body: 'BP阶段如何读懂选手思路？（测试正文300字）',
      tags: ['#电竞', '#KPL', '#女性视角'],
      cover_images: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
    },
    douyin: {
      script: '测试脚本200字',
      bgm_suggestion: '高燃电竞BGM',
      key_captions: ['BP = 英雄选禁', '职业选手耗时平均8秒'],
      cover_images: ['https://img.example.com/1.jpg'],
    },
  },
  edit_history: [],
  image_prompts: ['Chinese female, 21yo, silver-white long hair, esports commentary booth'],
};

describe('formatContentPackage', () => {
  it('formats complete content package with XHS and Douyin sections', () => {
    const result = formatContentPackage(sampleItem);
    expect(result).toContain('📦');
    expect(result).toContain('q_test_123');
    expect(result).toContain('小红书');
    expect(result).toContain('有人说女生不懂电竞');
    expect(result).toContain('抖音');
    expect(result).toContain('测试脚本200字');
    expect(result).toContain('#电竞');
  });

  it('includes image prompts section when present', () => {
    const result = formatContentPackage(sampleItem);
    expect(result).toContain('AI生图提示词');
    expect(result).toContain('esports commentary booth');
  });

  it('includes publish callback instructions', () => {
    const result = formatContentPackage(sampleItem);
    expect(result).toContain('已发');
    expect(result).toContain('xhs');
  });

  it('handles item without image_prompts', () => {
    const noPrompts = { ...sampleItem, image_prompts: undefined };
    const result = formatContentPackage(noPrompts);
    expect(result).not.toContain('AI生图提示词');
  });

  it('includes Seedance video_prompt, negative_prompt, lighting, style in shot details', () => {
    const withShots: QueueItem = {
      ...sampleItem,
      content: {
        ...sampleItem.content,
        douyin: {
          ...sampleItem.content.douyin,
          shots: [
            {
              index: 1,
              time_range: '0-3秒',
              description: '电竞解说台前，银发女孩紧盯屏幕',
              camera_move: 'push_in' as const,
              camera_angle: 'eye_level' as const,
              shot_size: 'medium' as const,
              transition: 'cut' as const,
              mood: '紧张专注',
              video_prompt: 'A young woman with silver hair in a gaming jersey, intensely staring at a monitor, her fingers rapidly pressing keyboard keys, in a dimly lit esports arena with neon blue and purple lights, dramatic side lighting with rim light, slow push-in camera, cinematic, 35mm, shallow depth of field',
              negative_prompt: 'jitter, bent limbs, deformed hands, blur, low quality, watermark',
              lighting: 'dramatic side lighting with rim light',
              style: 'cinematic, 35mm, shallow depth of field',
            },
          ],
          total_duration: '25-30秒',
          pacing: 'fast' as const,
        },
      },
    };
    const result = formatContentPackage(withShots);
    expect(result).toContain('video_prompt:');
    expect(result).toContain('negative:');
    expect(result).toContain('lighting:');
    expect(result).toContain('style:');
    expect(result).toContain('dramatic side lighting');
  });
});

describe('extractPlatformUrl', () => {
  it('extracts XHS URL from xiaohongshu.com', () => {
    const result = extractPlatformUrl('已发 xhs https://www.xiaohongshu.com/explore/abc123');
    expect(result).toEqual({ platform: 'xhs', url: 'https://www.xiaohongshu.com/explore/abc123' });
  });

  it('extracts XHS URL from xhslink.com', () => {
    const result = extractPlatformUrl('已发 https://xhslink.com/abc');
    expect(result).toEqual({ platform: 'xhs', url: 'https://xhslink.com/abc' });
  });

  it('extracts Douyin URL from douyin.com', () => {
    const result = extractPlatformUrl('已发 douyin https://www.douyin.com/video/123456');
    expect(result).toEqual({ platform: 'douyin', url: 'https://www.douyin.com/video/123456' });
  });

  it('extracts Douyin URL from v.douyin.com', () => {
    const result = extractPlatformUrl('https://v.douyin.com/abc123/');
    expect(result).toEqual({ platform: 'douyin', url: 'https://v.douyin.com/abc123/' });
  });

  it('returns null when no recognized URL found', () => {
    expect(extractPlatformUrl('随便说说')).toBeNull();
  });
});

describe('parsePublishIntent', () => {
  it('parses "已发 xhs URL" into publish intent', () => {
    const result = parsePublishIntent('已发 xhs https://www.xiaohongshu.com/explore/abc', 'q_123');
    expect(result).toEqual({
      action: 'publish',
      item_id: 'q_123',
      field: 'xhs',
      instruction: 'https://www.xiaohongshu.com/explore/abc',
    });
  });

  it('returns null for non-publish messages', () => {
    expect(parsePublishIntent('改一下标题', 'q_123')).toBeNull();
  });
});
