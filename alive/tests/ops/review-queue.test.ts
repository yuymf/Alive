import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  loadQueue, saveQueue, addItem, updateItemStatus,
  getItem, cleanupOldItems, DEFAULT_REVIEW_QUEUE,
  getPendingItems, updateItemContent,
  markApproved, markDiscarded, markPublished, markPerformanceTracked,
} from '../../scripts/ops/review-queue';
import { QueueItem } from '../../scripts/utils/types';

const tmpDir = path.join(os.tmpdir(), 'alive-ops-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-03-30T10:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadQueue', () => {
  it('returns empty queue when file does not exist', async () => {
    const q = await loadQueue();
    expect(q.items).toEqual([]);
  });
});

describe('addItem', () => {
  it('adds an item with pending status and returns it', async () => {
    const item = await addItem({
      topic: '蹭#电竞女孩',
      trend_hook: '#电竞女孩 velocity=2.3x',
      identity_mode: 'esports',
      content: {
        xhs: { title: 'test', body: 'body', tags: ['#电竞'], cover_images: [] },
        douyin: { script: 'script', bgm_suggestion: 'none', key_captions: [], cover_images: [] },
      },
    });
    expect(item.status).toBe('pending');
    expect(item.id).toBeTruthy();
    const q = await loadQueue();
    expect(q.items).toHaveLength(1);
    expect(q.items[0].id).toBe(item.id);
  });
});

describe('updateItemStatus', () => {
  it('updates status of existing item', async () => {
    const item = await addItem({
      topic: 'test',
      trend_hook: 'hook',
      identity_mode: 'daily',
      content: {
        xhs: { title: '', body: '', tags: [], cover_images: [] },
        douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
    });
    const updated = await updateItemStatus(item.id, 'approved');
    expect(updated?.status).toBe('approved');
  });

  it('returns null for unknown id', async () => {
    const result = await updateItemStatus('nonexistent', 'approved');
    expect(result).toBeNull();
  });
});

describe('cleanupOldItems', () => {
  it('removes published and discarded items older than 7 days', async () => {
    // Add an old published item
    const item = await addItem({
      topic: 'old',
      trend_hook: 'hook',
      identity_mode: 'daily',
      content: {
        xhs: { title: '', body: '', tags: [], cover_images: [] },
        douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
    });
    await updateItemStatus(item.id, 'published');
    // Manually backdate updated_at
    const q = await loadQueue();
    await saveQueue({
      ...q,
      items: [{ ...q.items[0], updated_at: '2026-03-01T00:00:00Z' }],
    });

    await cleanupOldItems();
    const after = await loadQueue();
    expect(after.items).toHaveLength(0);
  });

  it('keeps pending items regardless of age', async () => {
    const item = await addItem({
      topic: 'keep',
      trend_hook: 'hook',
      identity_mode: 'daily',
      content: {
        xhs: { title: '', body: '', tags: [], cover_images: [] },
        douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
    });
    const q = await loadQueue();
    await saveQueue({
      ...q,
      items: [{ ...q.items[0], updated_at: '2026-03-01T00:00:00Z' }],
    });

    await cleanupOldItems();
    const after = await loadQueue();
    expect(after.items).toHaveLength(1);
  });
});

describe('getPendingItems', () => {
  it('returns only pending items', async () => {
    const item1 = await addItem({
      topic: 'a', trend_hook: 'h', identity_mode: 'daily',
      content: { xhs: { title: '', body: '', tags: [], cover_images: [] }, douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] } },
    });
    await addItem({
      topic: 'b', trend_hook: 'h', identity_mode: 'daily',
      content: { xhs: { title: '', body: '', tags: [], cover_images: [] }, douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] } },
    });
    await updateItemStatus(item1.id, 'approved');
    const pending = await getPendingItems();
    expect(pending).toHaveLength(1);
    expect(pending[0].topic).toBe('b');
  });
});

describe('addItem with template_spec and competitor_benchmarks', () => {
  it('stores template_spec when provided', async () => {
    const item = await addItem({
      topic: '蹭 #电竞',
      trend_hook: '#电竞 (douyin, 3.0x)',
      identity_mode: 'esports',
      content: {
        xhs: { title: 'test', body: 'body', tags: [], cover_images: [] },
        douyin: { script: 'script', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
      template_spec: {
        content_type: '赛场高燃瞬间',
        category: '电竞解说',
        scene: '电竞比赛现场、解说台',
        camera: '眼神特写、战绩卡点',
        styling: '神情锐利、专业从容',
        highlights: ['高燃竞技感', '解说专业力'],
        reference_links: ['https://example.com'],
      },
    });
    expect(item.template_spec).toBeDefined();
    expect(item.template_spec!.content_type).toBe('赛场高燃瞬间');
    expect(item.template_spec!.highlights).toContain('高燃竞技感');

    // Verify persistence
    const loaded = await getItem(item.id);
    expect(loaded?.template_spec?.scene).toBe('电竞比赛现场、解说台');
  });

  it('stores competitor_benchmarks when provided', async () => {
    const item = await addItem({
      topic: 'test',
      trend_hook: 'hook',
      identity_mode: 'racer',
      content: {
        xhs: { title: '', body: '', tags: [], cover_images: [] },
        douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
      competitor_benchmarks: [
        {
          name: '谷爱凌',
          platform: 'xhs',
          content_mix_relevant: '运动40%、时尚20%',
          audience: '14-30岁学生',
          interaction_style: '夸竞技实力',
        },
      ],
    });
    expect(item.competitor_benchmarks).toHaveLength(1);
    expect(item.competitor_benchmarks![0].name).toBe('谷爱凌');
  });

  it('omits optional fields when not provided', async () => {
    const item = await addItem({
      topic: 'basic',
      trend_hook: 'hook',
      identity_mode: 'daily',
      content: {
        xhs: { title: '', body: '', tags: [], cover_images: [] },
        douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
    });
    expect(item.template_spec).toBeUndefined();
    expect(item.competitor_benchmarks).toBeUndefined();
  });
});

describe('updateItemContent', () => {
  it('merges content and appends edit_history entry', async () => {
    const item = await addItem({
      topic: 'test', trend_hook: 'h', identity_mode: 'esports',
      content: {
        xhs: { title: 'original', body: 'body', tags: [], cover_images: [] },
        douyin: { script: 'script', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
    });
    const updated = await updateItemContent(
      item.id,
      { xhs: { title: 'new title', body: 'new body', tags: ['#tag'], cover_images: [] } },
      { instruction: 'change title', field: 'xhs.title' },
    );
    expect(updated?.content.xhs.title).toBe('new title');
    expect(updated?.content.douyin.script).toBe('script'); // douyin unchanged
    expect(updated?.edit_history).toHaveLength(1);
    expect(updated?.edit_history[0].instruction).toBe('change title');
    expect(updated?.edit_history[0].timestamp).toBe(updated?.updated_at); // same instant
  });

  it('returns null for unknown id', async () => {
    const result = await updateItemContent('nonexistent', {}, { instruction: 'x', field: 'y' });
    expect(result).toBeNull();
  });
});

// ─── Lifecycle API tests ─────────────────────────────────────────────────────

const seedContent = {
  xhs: { title: '', body: '', tags: [] as string[], cover_images: [] as string[] },
  douyin: { script: '', bgm_suggestion: '', key_captions: [] as string[], cover_images: [] as string[] },
};

describe('markApproved', () => {
  it('transitions pending → approved', async () => {
    const item = await addItem({ topic: 'a', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    const result = await markApproved(item.id);
    expect(result?.status).toBe('approved');
  });

  it('rejects transition from discarded', async () => {
    const item = await addItem({ topic: 'a', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    await updateItemStatus(item.id, 'discarded');
    const result = await markApproved(item.id);
    expect(result).toBeNull();
  });

  it('returns null for unknown id', async () => {
    expect(await markApproved('nope')).toBeNull();
  });
});

describe('markDiscarded', () => {
  it('transitions pending → discarded', async () => {
    const item = await addItem({ topic: 'a', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    const result = await markDiscarded(item.id);
    expect(result?.status).toBe('discarded');
  });

  it('rejects discard of already published item', async () => {
    const item = await addItem({ topic: 'a', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    await markPublished(item.id, { platform: 'xhs', url: 'https://example.com' });
    const result = await markDiscarded(item.id);
    expect(result).toBeNull();
  });
});

describe('markPublished', () => {
  it('sets status, URL, published_at and performance_tracked on first publish', async () => {
    const item = await addItem({ topic: 'a', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    const result = await markPublished(item.id, {
      platform: 'xhs',
      url: 'https://www.xiaohongshu.com/explore/abc',
      publishedAt: '2026-04-03T10:00:00.000Z',
    });
    expect(result?.status).toBe('published');
    expect(result?.published_urls?.xhs).toBe('https://www.xiaohongshu.com/explore/abc');
    expect(result?.published_at).toBe('2026-04-03T10:00:00.000Z');
    expect(result?.performance_tracked).toBe(false);
  });

  it('merges URLs when publishing to a second platform', async () => {
    const item = await addItem({ topic: 'a', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    await markPublished(item.id, { platform: 'xhs', url: 'https://xhs.example.com/1' });
    const result = await markPublished(item.id, { platform: 'douyin', url: 'https://douyin.example.com/2' });
    expect(result?.published_urls?.xhs).toBe('https://xhs.example.com/1');
    expect(result?.published_urls?.douyin).toBe('https://douyin.example.com/2');
  });

  it('preserves original published_at on subsequent publishes', async () => {
    const item = await addItem({ topic: 'a', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    await markPublished(item.id, { platform: 'xhs', url: 'https://xhs.example.com/1', publishedAt: '2026-04-01T08:00:00Z' });
    const result = await markPublished(item.id, { platform: 'douyin', url: 'https://douyin.example.com/2', publishedAt: '2026-04-02T08:00:00Z' });
    expect(result?.published_at).toBe('2026-04-01T08:00:00Z');
  });

  it('rejects publishing a discarded item', async () => {
    const item = await addItem({ topic: 'a', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    await markDiscarded(item.id);
    const result = await markPublished(item.id, { platform: 'xhs', url: 'https://example.com' });
    expect(result).toBeNull();
  });
});

describe('markPerformanceTracked', () => {
  it('sets performance_tracked = true for published item', async () => {
    const item = await addItem({ topic: 'a', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    await markPublished(item.id, { platform: 'xhs', url: 'https://example.com' });
    const result = await markPerformanceTracked(item.id);
    expect(result?.performance_tracked).toBe(true);
  });

  it('rejects tracking for non-published item', async () => {
    const item = await addItem({ topic: 'a', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    const result = await markPerformanceTracked(item.id);
    expect(result).toBeNull();
  });
});
