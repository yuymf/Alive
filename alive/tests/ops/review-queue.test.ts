import { describe, it, expect } from 'vitest';
import { QueueItem } from '../../scripts/utils/types';

describe('QueueItem type', () => {
  it('constructs a valid pending item', () => {
    const item: QueueItem = {
      id: 'test-id',
      status: 'pending',
      topic: '蹭#电竞女孩',
      trend_hook: '#电竞女孩 velocity=2.3x',
      identity_mode: 'esports',
      created_at: '2026-03-30T08:00:00Z',
      updated_at: '2026-03-30T08:00:00Z',
      content: {
        xhs: { title: '', body: '', tags: [], cover_images: [] },
        douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
      edit_history: [],
    };
    expect(item.status).toBe('pending');
    expect(item.identity_mode).toBe('esports');
  });
});
