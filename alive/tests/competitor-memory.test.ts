/**
 * competitor-memory.test.ts
 * Tests for the markdown-based competitor knowledge base.
 * Uses real filesystem (temp dir) for md read/write tests, mocks only LLM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setBasePaths, resetBasePaths, PATHS } from '../scripts/utils/file-utils';

import {
  parseFrontmatter,
  buildFrontmatter,
  sanitizeFilename,
  initProfilesFromPersona,
  getCompetitorProfiles,
  getHitBreakdowns,
  buildMemoryContext,
  writeBreakdown,
  appendObservation,
  shouldAutoAnalyze,
  cleanupOldBreakdowns,
  trimObservationNotes,
} from '../scripts/ops/competitor-memory';

import type { CompetitorProfile, CompetitorUpdate } from '../scripts/utils/types';

// ─── Mock time-utils ────────────────────────────────────────────────────────

vi.mock('../scripts/utils/time-utils', () => ({
  now: vi.fn(() => new Date('2026-04-02T10:00:00Z')),
  wallNow: vi.fn(() => new Date('2026-04-02T10:00:00Z')),
  getLocalDate: vi.fn(() => '2026-04-02'),
}));

// ─── Sandbox setup ──────────────────────────────────────────────────────────

let tmpDir: string;

function mkMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-cm-test-'));
  return dir;
}

beforeEach(() => {
  tmpDir = mkMemoryDir();
  setBasePaths(tmpDir, tmpDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Sample data ────────────────────────────────────────────────────────────

const sampleCompetitors: CompetitorProfile[] = [
  {
    name: '小田Elin',
    platform: 'xhs',
    tag: '硬核电竞解说',
    tag_desc: '电竞解说 + 赛事分析',
    followers: '50万',
    content_mix: { '赛事解说': 60, '日常': 40 },
    audience: '18-25岁男性电竞爱好者',
    interaction_style: '专业但亲和',
    reference_type: 'primary',
    group: '硬核电竞解说',
    takeaways: ['专业赛事分析吸引深度用户', '人设反差感强'],
    avoid: ['过于专业的术语'],
  },
  {
    name: '音乐小姐姐',
    platform: 'xhs',
    tag: '偶像歌手',
    tag_desc: '翻唱 + 原创音乐',
    reference_type: 'secondary',
    group: '偶像歌手',
    takeaways: ['翻唱热门歌曲引流'],
    avoid: ['版权问题'],
  },
  {
    name: '赛车达人',
    platform: 'douyin',
    tag: '赛道飒爽女车手',
    tag_desc: '赛车日常 + 改装分享',
    reference_type: 'primary',
    group: '赛道飒爽女车手',
    takeaways: ['真实赛道体验', '改装干货'],
    avoid: ['危险驾驶暗示'],
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses valid YAML header and returns frontmatter + body', () => {
    const content = `---
platform: xhs
track: 电竞解说
name: 小田Elin
---
# 小田Elin

> 电竞解说 + 赛事分析`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter.platform).toBe('xhs');
    expect(result.frontmatter.track).toBe('电竞解说');
    expect(result.frontmatter.name).toBe('小田Elin');
    expect(result.body).toContain('# 小田Elin');
  });

  it('handles missing frontmatter gracefully', () => {
    const content = '# Just a title\n\nSome content';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it('handles numeric values (engagement: 32000)', () => {
    const content = `---
engagement: 32000
name: test
---
body`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter.engagement).toBe(32000);
    expect(typeof result.frontmatter.engagement).toBe('number');
  });
});

describe('sanitizeFilename', () => {
  it('preserves Chinese chars, replaces illegal chars', () => {
    expect(sanitizeFilename('小田Elin')).toBe('小田Elin');
    expect(sanitizeFilename('test/file:name*"?')).toBe('test-file-name---');
    expect(sanitizeFilename('赛车达人<>|')).toBe('赛车达人---');
  });
});

describe('initProfilesFromPersona', () => {
  it('creates correct files with frontmatter from CompetitorProfile[]', () => {
    initProfilesFromPersona(sampleCompetitors);

    const xhsDir = path.join(PATHS.competitorsDir, 'xhs');
    const douyinDir = path.join(PATHS.competitorsDir, 'douyin');
    expect(fs.existsSync(xhsDir)).toBe(true);
    expect(fs.existsSync(douyinDir)).toBe(true);

    const elinFile = path.join(xhsDir, '小田Elin.md');
    expect(fs.existsSync(elinFile)).toBe(true);

    const content = fs.readFileSync(elinFile, 'utf8');
    expect(content).toContain('platform: xhs');
    expect(content).toContain('reference_type: primary');
    expect(content).toContain('## 借鉴要点');
    expect(content).toContain('专业赛事分析吸引深度用户');
    expect(content).toContain('## 避坑提醒');
    expect(content).toContain('过于专业的术语');
    expect(content).toContain('## 观察笔记');

    const racerFile = path.join(douyinDir, '赛车达人.md');
    expect(fs.existsSync(racerFile)).toBe(true);
  });

  it('skips existing files (no overwrite)', () => {
    initProfilesFromPersona(sampleCompetitors);

    // Modify the file
    const elinFile = path.join(PATHS.competitorsDir, 'xhs', '小田Elin.md');
    fs.appendFileSync(elinFile, '\n手动笔记');

    // Re-init
    initProfilesFromPersona(sampleCompetitors);

    const content = fs.readFileSync(elinFile, 'utf8');
    expect(content).toContain('手动笔记');
  });
});

describe('getCompetitorProfiles', () => {
  it('reads and filters by track via matchesTaxonomy', () => {
    initProfilesFromPersona(sampleCompetitors);

    // Get all profiles
    const all = getCompetitorProfiles();
    expect(all.length).toBe(3);

    // Filter by esports track
    const esports = getCompetitorProfiles('esports');
    expect(esports.length).toBe(1);
    expect(esports[0].frontmatter.name).toBe('小田Elin');

    // Filter by racer track
    const racer = getCompetitorProfiles('racer');
    expect(racer.length).toBe(1);
    expect(racer[0].frontmatter.name).toBe('赛车达人');
  });
});

describe('getHitBreakdowns', () => {
  it('filters by platform+track, sorts by engagement desc, respects limit', () => {
    // Write some breakdowns
    writeBreakdown({
      platform: 'xhs',
      track: '电竞解说',
      competitor: '小田Elin',
      title: '低互动帖',
      engagement: 100,
      content_type: '图文',
      source: 'auto',
      body: '## 钩子拆解\n\n- hook1\n\n## 可借鉴点\n\n- point1',
    });

    writeBreakdown({
      platform: 'xhs',
      track: '电竞解说',
      competitor: '小田Elin',
      title: '高互动帖',
      engagement: 5000,
      content_type: '图文',
      source: 'auto',
      body: '## 钩子拆解\n\n- hook2\n\n## 可借鉴点\n\n- point2',
    });

    writeBreakdown({
      platform: 'douyin',
      track: '赛道飒爽女车手',
      competitor: '赛车达人',
      title: '赛车视频',
      engagement: 3000,
      content_type: '视频',
      source: 'manual',
      body: '内容分析',
    });

    // All breakdowns
    const all = getHitBreakdowns();
    expect(all.length).toBe(3);
    // Sorted by engagement desc
    expect(all[0].frontmatter.engagement).toBe(5000);

    // Filter by platform
    const xhsOnly = getHitBreakdowns({ platform: 'xhs' });
    expect(xhsOnly.length).toBe(2);

    // Filter by track
    const esportsOnly = getHitBreakdowns({ track: 'esports' });
    expect(esportsOnly.length).toBe(2);

    // Limit
    const limited = getHitBreakdowns({ limit: 1 });
    expect(limited.length).toBe(1);
    expect(limited[0].frontmatter.engagement).toBe(5000);
  });
});

describe('buildMemoryContext', () => {
  it('returns formatted text with profiles + breakdowns', () => {
    initProfilesFromPersona(sampleCompetitors);

    writeBreakdown({
      platform: 'xhs',
      track: '电竞解说',
      competitor: '小田Elin',
      title: '爆款电竞帖',
      engagement: 5000,
      content_type: '图文',
      source: 'auto',
      body: '## 钩子拆解\n\n- 悬念开场\n- 数据冲击\n\n## 可借鉴点\n\n- 赛事数据可视化\n- 选手八卦引流',
    });

    const ctx = buildMemoryContext('esports', { maxProfiles: 5, maxBreakdowns: 3 });
    expect(ctx).toContain('【对标竞品画像】');
    expect(ctx).toContain('@小田Elin');
    expect(ctx).toContain('借鉴：');
    expect(ctx).toContain('【近期爆款参考】');
    expect(ctx).toContain('悬念开场');
  });

  it('returns empty string when no files exist', () => {
    const ctx = buildMemoryContext('esports');
    expect(ctx).toBe('');
  });
});

describe('writeBreakdown', () => {
  it('creates md file with correct frontmatter and path', () => {
    writeBreakdown({
      platform: 'xhs',
      track: '电竞解说',
      competitor: '小田Elin',
      title: '测试帖子标题',
      engagement: 3200,
      content_type: '图文',
      source: 'manual',
      body: '分析内容',
      link: 'https://example.com/post',
    });

    const dir = path.join(PATHS.hitBreakdownsDir, 'xhs');
    expect(fs.existsSync(dir)).toBe(true);

    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^2026-04-02-/);

    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    expect(content).toContain('engagement: 3200');
    expect(content).toContain('source: manual');
    expect(content).toContain('# 测试帖子标题');
    expect(content).toContain('原文：https://example.com/post');
  });
});

describe('appendObservation', () => {
  it('appends to 观察笔记 section with date prefix', () => {
    initProfilesFromPersona(sampleCompetitors);

    appendObservation('xhs', '小田Elin', '今天发了一条赛事预测帖，数据很好');

    const filePath = path.join(PATHS.competitorsDir, 'xhs', '小田Elin.md');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('- 2026-04-02: 今天发了一条赛事预测帖，数据很好');
    // Frontmatter should have updated_at
    expect(content).toContain('updated_at: 2026-04-02');
  });
});

describe('shouldAutoAnalyze', () => {
  it('returns true when engagement > 2x avg, false otherwise', () => {
    const history: CompetitorUpdate[] = [
      { account: 'test', platform: 'xhs', latest_post: { time: '', content_type: '图文', topic: 'a', engagement: 100, summary: '' }, days_since_last_post: 0, fetched_at: '2026-04-01T01:00:00Z' },
      { account: 'test', platform: 'xhs', latest_post: { time: '', content_type: '图文', topic: 'b', engagement: 200, summary: '' }, days_since_last_post: 0, fetched_at: '2026-04-01T02:00:00Z' },
      { account: 'test', platform: 'xhs', latest_post: { time: '', content_type: '图文', topic: 'c', engagement: 100, summary: '' }, days_since_last_post: 0, fetched_at: '2026-04-01T03:00:00Z' },
    ];
    // Average is ~133, so 2x = ~267

    // 300 > 267 → true
    const highUpdate: CompetitorUpdate = {
      account: 'test', platform: 'xhs',
      latest_post: { time: '', content_type: '图文', topic: 'viral', engagement: 300, summary: '' },
      days_since_last_post: 0, fetched_at: '2026-04-02T10:00:00Z',
    };
    expect(shouldAutoAnalyze(highUpdate, history)).toBe(true);

    // 200 < 267 → false
    const normalUpdate: CompetitorUpdate = {
      account: 'test', platform: 'xhs',
      latest_post: { time: '', content_type: '图文', topic: 'normal', engagement: 200, summary: '' },
      days_since_last_post: 0, fetched_at: '2026-04-02T11:00:00Z',
    };
    expect(shouldAutoAnalyze(normalUpdate, history)).toBe(false);

    // No latest post → false
    const noPost: CompetitorUpdate = {
      account: 'test', platform: 'xhs', latest_post: null, days_since_last_post: 5, fetched_at: '2026-04-02T12:00:00Z',
    };
    expect(shouldAutoAnalyze(noPost, history)).toBe(false);
  });
});

describe('cleanupOldBreakdowns', () => {
  it('deletes files > 90 days old', () => {
    // Write a breakdown with a date that looks old
    const dir = path.join(PATHS.hitBreakdownsDir, 'xhs');
    fs.mkdirSync(dir, { recursive: true });

    // Old file (fake date in frontmatter)
    const oldContent = `---
platform: xhs
track: 电竞解说
competitor: test
date: 2025-12-01
engagement: 100
content_type: 图文
source: auto
---
Old content`;
    fs.writeFileSync(path.join(dir, '2025-12-01-old.md'), oldContent);

    // Recent file
    const recentContent = `---
platform: xhs
track: 电竞解说
competitor: test
date: 2026-03-30
engagement: 200
content_type: 图文
source: auto
---
Recent content`;
    fs.writeFileSync(path.join(dir, '2026-03-30-recent.md'), recentContent);

    const deleted = cleanupOldBreakdowns();
    expect(deleted).toBe(1);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect(fs.readdirSync(dir)[0]).toContain('2026-03-30');
  });
});

describe('trimObservationNotes', () => {
  it('trims to 30 newest entries', () => {
    initProfilesFromPersona([sampleCompetitors[0]]);

    const filePath = path.join(PATHS.competitorsDir, 'xhs', '小田Elin.md');
    let content = fs.readFileSync(filePath, 'utf8');

    // Add 35 notes (prepended, so newest first)
    const notes = Array.from({ length: 35 }, (_, i) =>
      `- 2026-03-${String(i + 1).padStart(2, '0')}: 笔记 ${i + 1}`,
    ).join('\n');

    content = content.replace(
      '## 观察笔记\n',
      `## 观察笔记\n${notes}\n`,
    );
    fs.writeFileSync(filePath, content);

    trimObservationNotes();

    const updated = fs.readFileSync(filePath, 'utf8');
    const noteLines = updated
      .split('\n')
      .filter(l => l.startsWith('- 2026-03-'));
    expect(noteLines.length).toBe(30);
  });
});
