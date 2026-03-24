// alive/tests/tts-provider.test.ts
// Tests for the TTS provider abstraction layer

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { synthesize } from '../sub-skills/voice-tts/scripts/tts-provider';

// ── synthesize ───────────────────────────────────────────────────

describe('tts-provider/synthesize', () => {
  it('throws on empty text', async () => {
    await expect(synthesize('', { provider: 'noiz' })).rejects.toThrow('Empty text');
    await expect(synthesize('   ', { provider: 'noiz' })).rejects.toThrow('Empty text');
  });

  it('throws on unknown provider', async () => {
    await expect(synthesize('hello', { provider: 'unknown' as any })).rejects.toThrow('Unknown provider');
  });

  it('throws not-implemented for kokoro provider', async () => {
    await expect(synthesize('hello', { provider: 'kokoro' })).rejects.toThrow('not yet implemented');
  });

  // Note: Noiz API integration tests are not run in unit tests
  // (they require network access or E2E mock).
  // The Noiz path is tested through the action integration test.
});
