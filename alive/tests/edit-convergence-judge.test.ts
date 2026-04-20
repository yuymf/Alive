import { describe, expect, it } from 'vitest';
import { computeEditConvergence } from '../../e2e/harness/judges/edit-convergence';

function makeItem(overrides: {
  title?: string;
  body?: string;
  edit_history?: Array<{ timestamp: string; field: string; instruction: string }>;
  review_feedback?: Array<{ decision: string }>;
  status?: string;
}): any {
  return {
    content: {
      xhs: {
        title: overrides.title ?? 'T',
        body: overrides.body ?? 'B',
      },
    },
    edit_history: overrides.edit_history ?? [],
    review_feedback: overrides.review_feedback ?? [],
    status: overrides.status ?? 'pending',
  };
}

describe('edit-convergence judge', () => {
  it('returns baseline 50 when no edits and no approve', () => {
    const out = computeEditConvergence({
      initialItem: makeItem({ title: 'A', body: 'B' }),
      finalItem: makeItem({ title: 'A', body: 'B' }),
      reviewTranscript: [],
    });
    expect(out.score).toBe(50);
    expect(out.expectedEditTurns).toBe(0);
    expect(out.titleChanged).toBe(false);
  });

  it('rewards convergent edit + approve pattern', () => {
    const out = computeEditConvergence({
      initialItem: makeItem({ title: 'old', body: 'B' }),
      finalItem: makeItem({
        title: 'new',
        body: 'B',
        edit_history: [
          { timestamp: '2026-01-01T00:00:00Z', field: 'title', instruction: '更口语' },
        ],
        review_feedback: [{ decision: 'approved' }],
        status: 'published',
      }),
      reviewTranscript: [
        { step: 1, operatorMessage: '改标题', expectedIntent: 'edit', assistantReply: 'ok' },
        { step: 2, operatorMessage: '可以发', expectedIntent: 'approve', assistantReply: 'ok' },
      ],
    });
    // 50 (base) + 15 (1 convergent turn) + 10 (approve after edit) = 75
    expect(out.score).toBe(75);
    expect(out.titleChanged).toBe(true);
    expect(out.approvedAfterEdits).toBe(true);
    expect(out.approvalRecorded).toBe(true);
  });

  it('penalizes when edit was requested but final equals initial', () => {
    const out = computeEditConvergence({
      initialItem: makeItem({ title: 'same', body: 'same' }),
      finalItem: makeItem({
        title: 'same',
        body: 'same',
        edit_history: [],
      }),
      reviewTranscript: [
        { step: 1, operatorMessage: '改标题', expectedIntent: 'edit', assistantReply: 'ok' },
      ],
    });
    // 50 (base) - 15 (no change despite edit expected) = 35
    expect(out.score).toBe(35);
    expect(out.titleChanged).toBe(false);
    expect(out.bodyChanged).toBe(false);
  });

  it('penalizes oscillation when same (field, instruction) repeats', () => {
    const out = computeEditConvergence({
      initialItem: makeItem({ title: 'v0', body: 'B' }),
      finalItem: makeItem({
        title: 'v2',
        body: 'B',
        edit_history: [
          { timestamp: 't1', field: 'title', instruction: '更口语' },
          { timestamp: 't2', field: 'title', instruction: '更正式' },
          { timestamp: 't3', field: 'title', instruction: '更口语' }, // duplicate → oscillation
        ],
      }),
      reviewTranscript: [
        { step: 1, operatorMessage: '改1', expectedIntent: 'edit', assistantReply: 'ok' },
        { step: 2, operatorMessage: '改2', expectedIntent: 'edit', assistantReply: 'ok' },
        { step: 3, operatorMessage: '改3', expectedIntent: 'edit', assistantReply: 'ok' },
      ],
    });
    // 50 + 3*15 (min 3 convergent) - 20 (oscillation) = 75
    expect(out.score).toBe(75);
    expect(out.notes.some(n => n.includes('振荡'))).toBe(true);
  });

  it('clamps score into [0, 100]', () => {
    const out = computeEditConvergence({
      initialItem: makeItem({ title: 'x', body: 'y' }),
      finalItem: makeItem({
        title: 'X',
        body: 'Y',
        edit_history: Array.from({ length: 10 }, (_, i) => ({
          timestamp: `t${i}`,
          field: 'title',
          instruction: `distinct-${i}`, // all distinct → no oscillation
        })),
        review_feedback: [{ decision: 'approved' }],
      }),
      reviewTranscript: [
        ...Array.from({ length: 10 }, (_, i) => ({
          step: i + 1,
          operatorMessage: `edit ${i}`,
          expectedIntent: 'edit' as const,
          assistantReply: 'ok',
        })),
        { step: 11, operatorMessage: 'approve', expectedIntent: 'approve' as const, assistantReply: 'ok' },
      ],
    });
    expect(out.score).toBeLessThanOrEqual(100);
    expect(out.score).toBeGreaterThanOrEqual(0);
  });
});
