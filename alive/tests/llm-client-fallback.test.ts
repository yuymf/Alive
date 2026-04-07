import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';

// Mock execSync BEFORE importing the module under test
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

// Dynamic import so the mock is in place first
let callLLM: typeof import('../scripts/utils/llm-client').callLLM;
let callLLMJSON: typeof import('../scripts/utils/llm-client').callLLMJSON;

beforeEach(async () => {
  vi.clearAllMocks(); // reset call history between tests
  vi.resetModules();
  ({ callLLM, callLLMJSON } = await import('../scripts/utils/llm-client'));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LLM_API_KEY;
});

describe('llm-client openclaw fallback', () => {
  it('calls openclaw run when LLM_API_KEY is absent', async () => {
    delete process.env.LLM_API_KEY;
    mockExecSync.mockReturnValue('hello from openclaw');

    const result = await callLLM('say hello', 1000, 'test');

    expect(mockExecSync).toHaveBeenCalledOnce();
    const [cmd] = mockExecSync.mock.calls[0] as [string, ...unknown[]];
    expect(cmd).toContain('openclaw run');
    expect(result.content).toBe('hello from openclaw');
    expect(result.finishReason).toBe('stop');
  });

  it('callLLMJSON fallback parses JSON from openclaw output', async () => {
    delete process.env.LLM_API_KEY;
    mockExecSync.mockReturnValue('```json\n{"action":"rest"}\n```');

    const result = await callLLMJSON<{ action: string }>('decide', 1000, 'test');

    expect(result.action).toBe('rest');
  });

  it('fallback degrades gracefully when openclaw fails', async () => {
    delete process.env.LLM_API_KEY;
    mockExecSync.mockImplementation(() => { throw new Error('openclaw not found'); });

    await expect(callLLM('say hello', 1000, 'test')).rejects.toThrow('openclaw not found');
  });

  it('still uses HTTP path when LLM_API_KEY is set', async () => {
    process.env.LLM_API_KEY = 'test-key';
    // Mock setTimeout to be instant so retry doesn't delay the test
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    // Mock fetch to fail immediately (avoids real HTTP calls)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    await expect(callLLM('say hello', 100, 'test')).rejects.toThrow();
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
