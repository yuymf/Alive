/**
 * kb-query.test.ts
 * Unit tests for handleKbCommand (Phase 4).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { handleKbCommand } from '../sub-skills/ops-desk/scripts/kb-query';
import { upsertEntry, saveFormulas } from '../scripts/ops/viral-kb-store';
import { ViralEntry, UniversalFormula } from '../scripts/utils/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-query-test-'));
  fs.mkdirSync(path.join(dir, 'viral-kb'), { recursive: true });
  return dir;
}

function makeEntry(overrides: Partial<ViralEntry> = {}): ViralEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2)}`,
    platform: 'douyin',
    source_id: 'src1',
    source_type: 'trending_feed',
    persona_id: 'test-persona',
    title: '测试标题',
    description: '测试描述',
    likes: 10000,
    comments: 500,
    shares: 200,
    collected_at: new Date().toISOString(),
    dissection: {
      hook_type: '反问式',
      content_type: '工具类',
      identity_mode: null,
      emotion_arc: '焦虑→解脱',
      interaction_design: '评论区投票',
      visual_style: '大字报风格',
      cta_type: '关注解锁',
      summary: '用数字说话的职场攻略',
    },
    dissection_status: 'done',
    kb_tier: 'universal',
    promoted_to_template: false,
    times_referenced: 0,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handleKbCommand — status', () => {
  it('returns statistics including platform distribution', () => {
    const dir = makeTmpDir();
    upsertEntry(dir, makeEntry({ platform: 'douyin', id: 'e1', source_id: 'src-e1', title: 'douyin 条目' }));
    upsertEntry(dir, makeEntry({ platform: 'xhs', id: 'e2', source_id: 'src-e2', title: 'xhs 条目' }));

    const result = handleKbCommand(['status'], {}, dir);

    expect(result).toContain('总条目');
    expect(result).toContain('douyin');
    expect(result).toContain('xhs');
    expect(result).toContain('平台分布');
  });

  it('status shows hollow and usable counts', () => {
    const dir = makeTmpDir();
    upsertEntry(dir, makeEntry({ id: 'ok-1', source_id: 'src-ok-1', title: '正常条目' }));
    upsertEntry(dir, makeEntry({
      id: 'bad-1',
      source_id: 'src-bad-1',
      title: '空壳条目',
      dissection_status: 'done',
      dissection: { ...makeEntry().dissection!, summary: '' },
    }));

    const result = handleKbCommand(['status'], {}, dir);
    expect(result).toContain('可参考条目');
    expect(result).toContain('空壳条目');
  });

  it('shows zeros for empty KB', () => {
    const dir = makeTmpDir();
    const result = handleKbCommand(['status'], {}, dir);
    expect(result).toContain('总条目：0');
    expect(result).toContain('通用公式：0');
  });
});

describe('handleKbCommand — search', () => {
  it('returns entries matching the keyword', () => {
    const dir = makeTmpDir();
    upsertEntry(dir, makeEntry({ id: 'e1', dissection: { ...makeEntry().dissection!, summary: '职场必备技能' } }));
    upsertEntry(dir, makeEntry({ id: 'e2', dissection: { ...makeEntry().dissection!, summary: '美食探店' } }));

    const result = handleKbCommand(['search', '职场'], {}, dir);

    expect(result).toContain('职场');
    // Second entry should not appear
    expect(result).not.toContain('美食探店');
  });

  it('shows error message when no keyword given', () => {
    const dir = makeTmpDir();
    const result = handleKbCommand(['search'], {}, dir);
    expect(result).toContain('请提供搜索关键词');
  });
});

describe('handleKbCommand — list', () => {
  it('lists all entries when no filters applied', () => {
    const dir = makeTmpDir();
    upsertEntry(dir, makeEntry({ id: 'e1', source_id: 'src-e1', title: 'douyin 条目', platform: 'douyin' }));
    upsertEntry(dir, makeEntry({ id: 'e2', source_id: 'src-e2', title: 'xhs 条目', platform: 'xhs' }));

    const result = handleKbCommand(['list'], {}, dir);

    expect(result).toContain('条目列表');
    expect(result).toContain('工具类');
  });

  it('filters by platform flag', () => {
    const dir = makeTmpDir();
    upsertEntry(dir, makeEntry({ id: 'e1', source_id: 'src-e1', title: 'douyin 条目', platform: 'douyin' }));
    upsertEntry(dir, makeEntry({ id: 'e2', source_id: 'src-e2', title: 'xhs 条目', platform: 'xhs' }));

    const result = handleKbCommand(['list'], { platform: 'douyin' }, dir);

    expect(result).toContain('douyin');
    // Should show 1 entry
    expect(result).toContain('1 条');
  });

  it('filters by type flag', () => {
    const dir = makeTmpDir();
    upsertEntry(dir, makeEntry({ id: 'e1', source_id: 'src-e1', title: '种草条目', dissection: { ...makeEntry().dissection!, content_type: '种草类' } }));
    upsertEntry(dir, makeEntry({ id: 'e2', source_id: 'src-e2', title: '情绪条目', dissection: { ...makeEntry().dissection!, content_type: '情绪类' } }));

    const result = handleKbCommand(['list'], { type: '种草类' }, dir);
    expect(result).toContain('种草类');
    expect(result).toContain('1 条');
  });

  it('list can filter by status', () => {
    const dir = makeTmpDir();
    upsertEntry(dir, makeEntry({ id: 'ok-2', source_id: 'src-ok-2', title: '正常条目' }));
    upsertEntry(dir, makeEntry({
      id: 'failed-1',
      source_id: 'src-failed-1',
      title: '失败条目',
      dissection_status: 'failed',
      dissection_error_reason: 'hollow_result',
    }));

    const result = handleKbCommand(['list'], { status: 'failed' }, dir);
    expect(result).toContain('failed');
    expect(result).not.toContain('正常条目');
  });
});

describe('handleKbCommand — audit / repair', () => {
  it('audit shows hollow ids and quality summary', () => {
    const dir = makeTmpDir();
    upsertEntry(dir, makeEntry({
      id: 'bad-2',
      source_id: 'src-bad-2',
      title: '待审计空壳',
      dissection_status: 'done',
      dissection: { ...makeEntry().dissection!, hook_type: '', summary: '' },
    }));

    const result = handleKbCommand(['audit'], {}, dir);
    expect(result).toContain('bad-2');
    expect(result).toContain('hollow');
  });

  it('repair requeues hollow entries', () => {
    const dir = makeTmpDir();
    upsertEntry(dir, makeEntry({
      id: 'bad-3',
      source_id: 'src-bad-3',
      title: '待修复空壳',
      dissection_status: 'done',
      dissection: { ...makeEntry().dissection!, content_type: '', summary: '' },
    }));

    const result = handleKbCommand(['repair'], { limit: '5' }, dir);
    expect(result).toContain('已重新入队');
  });
});

describe('handleKbCommand — formulas', () => {
  it('lists all formulas', () => {
    const dir = makeTmpDir();
    const formula: UniversalFormula = {
      id: 'formula-1',
      platform: 'douyin',
      content_type: '工具类',
      hook_type: '反问式',
      formula_summary: '用问题引导进入内容',
      source_entry_ids: ['e1'],
      occurrence_count: 3,
      injected_to_templates: false,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      example_titles: ['测试标题1'],
      structural_template: '[数字] + [反转]',
      confidence: 0.65,
    };
    saveFormulas(dir, [formula]);

    const result = handleKbCommand(['formulas'], {}, dir);

    expect(result).toContain('工具类');
    expect(result).toContain('反问式');
    // v2: shows structural template and confidence instead of ✅ injected marker
    expect(result).toContain('[数字] + [反转]');
    expect(result).toContain('65%');
  });

  it('returns help message when no formulas exist', () => {
    const dir = makeTmpDir();
    const result = handleKbCommand(['formulas'], {}, dir);
    expect(result).toContain('暂无共性结构');
  });

  it('filters by platform flag', () => {
    const dir = makeTmpDir();
    const f1: UniversalFormula = {
      id: 'f1', platform: 'douyin', content_type: 'A', hook_type: 'B',
      formula_summary: 'douyin formula',
      source_entry_ids: [], occurrence_count: 3, injected_to_templates: false,
      created_at: '', last_seen_at: '',
    };
    const f2: UniversalFormula = {
      id: 'f2', platform: 'xhs', content_type: 'C', hook_type: 'D',
      formula_summary: 'xhs formula',
      source_entry_ids: [], occurrence_count: 3, injected_to_templates: false,
      created_at: '', last_seen_at: '',
    };
    saveFormulas(dir, [f1, f2]);

    const result = handleKbCommand(['formulas'], { platform: 'xhs' }, dir);
    expect(result).toContain('xhs formula');
    expect(result).not.toContain('douyin formula');
  });
});

describe('handleKbCommand — top', () => {
  it('returns entries sorted by likes descending', () => {
    const dir = makeTmpDir();
    upsertEntry(dir, makeEntry({ id: 'e1', source_id: 'src-e1', title: '低赞条目', likes: 5000 }));
    upsertEntry(dir, makeEntry({ id: 'e2', source_id: 'src-e2', title: '高赞条目', likes: 50000 }));
    upsertEntry(dir, makeEntry({ id: 'e3', source_id: 'src-e3', title: '更低赞条目', likes: 1000 }));

    const result = handleKbCommand(['top'], {}, dir);

    // Should start with highest likes
    const idx50k = result.indexOf('50,000');
    const idx5k = result.indexOf('5,000');
    expect(idx50k).toBeLessThan(idx5k);
  });

  it('respects --limit flag', () => {
    const dir = makeTmpDir();
    for (let i = 0; i < 5; i++) {
      upsertEntry(dir, makeEntry({ id: `e${i}`, source_id: `src-e${i}`, title: `条目-${i}`, likes: i * 1000 }));
    }

    const result = handleKbCommand(['top'], { limit: '2' }, dir);
    expect(result).toContain('2 条');
  });

  it('falls back to 10 when --limit is non-numeric (NaN)', () => {
    const dir = makeTmpDir();
    for (let i = 0; i < 15; i++) {
      upsertEntry(dir, makeEntry({ id: `e${i}`, source_id: `src-e${i}`, title: `条目-${i}`, likes: i * 1000 }));
    }

    // 'abc' parses to NaN — should fall back to default limit of 10
    const result = handleKbCommand(['top'], { limit: 'abc' }, dir);
    expect(result).toContain('10 条');
  });
});

describe('handleKbCommand — unknown subcommand', () => {
  it('returns help text for unknown subcommand', () => {
    const dir = makeTmpDir();
    const result = handleKbCommand(['unknown-cmd'], {}, dir);
    expect(result).toContain('/alive kb');
    expect(result).toContain('status');
    expect(result).toContain('search');
  });

  it('returns help text when no args given', () => {
    const dir = makeTmpDir();
    const result = handleKbCommand([], {}, dir);
    expect(result).toContain('/alive kb');
  });
});
