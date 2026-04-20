import { describe, expect, it } from 'vitest';
import { createCountingLLMClient } from '../../e2e/harness/counting-llm';

function mock(): any {
  return {
    call: async (_p: string, _mt?: number) => 'reply',
    callJSON: async <T>(_p: string, _mt?: number) => ({ ok: true } as unknown as T),
  };
}

describe('counting-llm wrapper', () => {
  it('counts call() invocations with prompt/response chars', async () => {
    const wrapped = createCountingLLMClient(mock());
    await wrapped.call('hello', 100);
    await wrapped.call('world!!', 100);
    const snap = wrapped.snapshot();
    expect(snap.calls).toBe(2);
    expect(snap.successfulCalls).toBe(2);
    expect(snap.failedCalls).toBe(0);
    expect(snap.promptChars).toBe('hello'.length + 'world!!'.length);
    expect(snap.responseChars).toBe('reply'.length * 2);
    expect(snap.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('counts callJSON with stringified response length', async () => {
    const wrapped = createCountingLLMClient(mock());
    await wrapped.callJSON('p');
    const snap = wrapped.snapshot();
    expect(snap.calls).toBe(1);
    expect(snap.responseChars).toBe(JSON.stringify({ ok: true }).length);
  });

  it('tracks failedCalls when inner throws', async () => {
    const errorClient: any = {
      call: async () => { throw new Error('boom'); },
      callJSON: async () => { throw new Error('boom'); },
    };
    const wrapped = createCountingLLMClient(errorClient);
    await expect(wrapped.call('p')).rejects.toThrow('boom');
    await expect(wrapped.callJSON('p')).rejects.toThrow('boom');
    const snap = wrapped.snapshot();
    expect(snap.calls).toBe(2);
    expect(snap.failedCalls).toBe(2);
    expect(snap.successfulCalls).toBe(0);
  });

  it('reset() clears all counters', async () => {
    const wrapped = createCountingLLMClient(mock());
    await wrapped.call('x');
    expect(wrapped.snapshot().calls).toBe(1);
    wrapped.reset();
    expect(wrapped.snapshot()).toEqual({
      calls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      promptChars: 0,
      responseChars: 0,
      elapsedMs: 0,
    });
  });
});
