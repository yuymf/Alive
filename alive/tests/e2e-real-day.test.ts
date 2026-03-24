import { describe, it, expect } from 'vitest';
import * as realDay from '../../e2e/e2e-real-day';

describe('e2e real day summary helpers', () => {
  it('marks a naturally successful chain as success', () => {
    expect(realDay.resolveNaturalChainStatus({ triggered: true, succeeded: true, errors: [] })).toBe('success');
  });

  it('marks an untouched chain as not_triggered', () => {
    expect(realDay.resolveNaturalChainStatus({ triggered: false, succeeded: false, errors: [] })).toBe('not_triggered');
  });

  it('marks a triggered chain with errors as failed', () => {
    expect(realDay.resolveNaturalChainStatus({
      triggered: true,
      succeeded: false,
      errors: ['instagram timeout'],
    })).toBe('failed');
  });

  it('builds a chain summary that keeps not_triggered distinct from failed', () => {
    const summary = realDay.buildLiveChainSummary({
      instagramBrowse: { triggered: true, succeeded: true, errors: [] },
      xhsBrowse: { triggered: true, succeeded: true, errors: [] },
      instagramPost: { triggered: false, succeeded: false, errors: [] },
      instagramOutboundComment: { triggered: true, succeeded: false, errors: ['rate limited'] },
      instagramReplyComment: { triggered: false, succeeded: false, errors: [] },
    });

    expect(summary.instagramBrowse.status).toBe('success');
    expect(summary.xhsBrowse.status).toBe('success');
    expect(summary.instagramPost.status).toBe('not_triggered');
    expect(summary.instagramOutboundComment.status).toBe('failed');
    expect(summary.instagramReplyComment.status).toBe('not_triggered');
  });
});
