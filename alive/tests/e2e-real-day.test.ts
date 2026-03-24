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

describe('parseActionTag', () => {
  it('parses standard skill tag: [instagram] desc', () => {
    const result = realDay.parseActionTag('[instagram] 精选了5张照片准备发carousel');
    expect(result).toEqual({ skill: 'instagram', fallback: false, error: false });
  });

  it('parses fallback tag: [fallback:instagram] desc', () => {
    const result = realDay.parseActionTag('[fallback:instagram] 发帖失败了');
    expect(result).toEqual({ skill: 'instagram', fallback: true, error: false });
  });

  it('parses error tag: [error:social-engagement] desc', () => {
    const result = realDay.parseActionTag('[error:social-engagement] 评论发送失败');
    expect(result).toEqual({ skill: 'social-engagement', fallback: false, error: true });
  });

  it('parses mock tag: [mock:content-browse] desc', () => {
    const result = realDay.parseActionTag('[mock:content-browse] 执行了 feed-browse');
    expect(result).toEqual({ skill: 'content-browse', fallback: false, error: false });
  });

  it('parses flow/drift tags', () => {
    expect(realDay.parseActionTag('[flow] 拍照修图')).toEqual({ skill: 'flow', fallback: false, error: false });
    expect(realDay.parseActionTag('[drift] 刷手机')).toEqual({ skill: 'drift', fallback: false, error: false });
  });

  it('returns null for plain text without tag', () => {
    expect(realDay.parseActionTag('在公园找角度拍cos外景')).toBeNull();
    expect(realDay.parseActionTag('继续拍摄，换了个有樱花的位置')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(realDay.parseActionTag('')).toBeNull();
  });
});
