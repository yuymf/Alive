/**
 * inspiration-consumption.test.ts
 * Task 9: Verify that brief-generator and night-reflect consume inspiration-state.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths, PATHS, writeJSON } from '../../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../../scripts/utils/time-utils';
import { formatBriefCard } from '../../scripts/ops/brief-generator';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-inspo-consume-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-03T09:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  clearTimeOverride();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('brief-generator consumes inspiration-state', () => {
  it('includes feed highlights when refreshed today', () => {
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: '2026-04-03T08:30:00Z',
      feed_highlights: [
        { title: 'AI虚拟偶像新玩法', likes: 12000, topic: '虚拟偶像' },
        { title: '赛车Vlog拍摄技巧', likes: 8500, topic: '赛车' },
      ],
      trending_topics: ['AI', '赛车'],
      domain_insights: ['AI虚拟偶像赛道竞争加剧'],
      saved_inspirations: [],
    });

    const card = formatBriefCard('2026-04-03', [], [], []);
    expect(card).toContain('今日灵感');
    expect(card).toContain('AI虚拟偶像新玩法');
    expect(card).toContain('赛车Vlog拍摄技巧');
    expect(card).toContain('12000');
  });

  it('skips inspiration section when not refreshed today', () => {
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: '2026-04-02T08:30:00Z',
      feed_highlights: [
        { title: '昨天的灵感', likes: 5000, topic: '过期' },
      ],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    const card = formatBriefCard('2026-04-03', [], [], []);
    expect(card).not.toContain('今日灵感');
    expect(card).not.toContain('昨天的灵感');
  });

  it('skips when inspiration-state does not exist', () => {
    const card = formatBriefCard('2026-04-03', [], [], []);
    expect(card).not.toContain('今日灵感');
  });

  it('limits to top 3 highlights', () => {
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: '2026-04-03T08:30:00Z',
      feed_highlights: [
        { title: 'A', likes: 100, topic: 't1' },
        { title: 'B', likes: 200, topic: 't2' },
        { title: 'C', likes: 300, topic: 't3' },
        { title: 'D', likes: 400, topic: 't4' },
      ],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    const card = formatBriefCard('2026-04-03', [], [], []);
    expect(card).toContain('A');
    expect(card).toContain('B');
    expect(card).toContain('C');
    expect(card).not.toContain('D');
  });
});
