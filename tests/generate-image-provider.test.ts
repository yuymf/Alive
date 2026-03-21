import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test getImageEntry directly (no mocks needed for that)
// For callFalAi / callImageProvider, we mock fetch.

describe('getImageEntry', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns AIHUBMIX when IMAGE_ENTRY is not set', async () => {
    delete process.env.IMAGE_ENTRY;
    const { getImageEntry } = await import('../skill/scripts/generate-image');
    expect(getImageEntry()).toBe('AIHUBMIX');
  });

  it('returns FAI when IMAGE_ENTRY is "FAI"', async () => {
    process.env.IMAGE_ENTRY = 'FAI';
    const { getImageEntry } = await import('../skill/scripts/generate-image');
    expect(getImageEntry()).toBe('FAI');
  });

  it('returns FAI when IMAGE_ENTRY is "fal" (case-insensitive)', async () => {
    process.env.IMAGE_ENTRY = 'fal';
    const { getImageEntry } = await import('../skill/scripts/generate-image');
    expect(getImageEntry()).toBe('FAI');
  });

  it('returns AIHUBMIX when IMAGE_ENTRY is "AIHUBMIX"', async () => {
    process.env.IMAGE_ENTRY = 'AIHUBMIX';
    const { getImageEntry } = await import('../skill/scripts/generate-image');
    expect(getImageEntry()).toBe('AIHUBMIX');
  });

  it('returns AIHUBMIX for empty string', async () => {
    process.env.IMAGE_ENTRY = '';
    const { getImageEntry } = await import('../skill/scripts/generate-image');
    expect(getImageEntry()).toBe('AIHUBMIX');
  });

  it('returns AIHUBMIX for unknown values', async () => {
    process.env.IMAGE_ENTRY = 'UNKNOWN';
    const { getImageEntry } = await import('../skill/scripts/generate-image');
    expect(getImageEntry()).toBe('AIHUBMIX');
  });
});

describe('getAIHubMixModel', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns default model when AIHUBMIX_MODEL is not set', async () => {
    delete process.env.AIHUBMIX_MODEL;
    const { getAIHubMixModel } = await import('../skill/scripts/generate-image');
    expect(getAIHubMixModel()).toBe('gemini-3.1-flash-image-preview');
  });

  it('returns custom model when AIHUBMIX_MODEL is set', async () => {
    process.env.AIHUBMIX_MODEL = 'gemini-2.0-flash-exp';
    const { getAIHubMixModel } = await import('../skill/scripts/generate-image');
    expect(getAIHubMixModel()).toBe('gemini-2.0-flash-exp');
  });
});

describe('getFalModel', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns default model when FAL_MODEL is not set', async () => {
    delete process.env.FAL_MODEL;
    const { getFalModel } = await import('../skill/scripts/generate-image');
    expect(getFalModel()).toBe('xai/grok-imagine-image/edit');
  });

  it('returns normalized model when FAL_MODEL is set', async () => {
    process.env.FAL_MODEL = '/xai/grok-imagine-image/edit';
    const { getFalModel } = await import('../skill/scripts/generate-image');
    expect(getFalModel()).toBe('xai/grok-imagine-image/edit');
  });
});



describe('callFalAi', () => {
  const originalEnv = { ...process.env };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.FAL_KEY = 'test-fal-key';
    delete process.env.FAL_MODEL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('throws when FAL_KEY is not set', async () => {
    delete process.env.FAL_KEY;
    const { callFalAi } = await import('../skill/scripts/generate-image');
    await expect(callFalAi('test prompt', [], '3:4')).rejects.toThrow('FAL_KEY not set');
  });

  it('sends correct request and parses URL-based image response', async () => {
    const fakeImageBuffer = Buffer.from('fake-png-data');
    let capturedRequest: { url: string; headers: Record<string, string>; body: string } | null = null;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('fal.run')) {
        capturedRequest = {
          url: urlStr,
          headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
          body: init?.body as string,
        };
        return {
          ok: true,
          json: () => Promise.resolve({
            images: [{ url: 'https://fal.media/test-image.png' }],
            revised_prompt: 'Enhanced prompt',
          }),
        };
      }
      // Image download
      return {
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeImageBuffer.buffer.slice(
          fakeImageBuffer.byteOffset,
          fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength,
        )),
      };
    }) as typeof fetch;

    const { callFalAi } = await import('../skill/scripts/generate-image');
    const result = await callFalAi('test prompt', ['base64data'], '3:4');

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.url).toContain('fal.run');
    expect(capturedRequest!.headers['Authorization']).toBe('Key test-fal-key');
    const body = JSON.parse(capturedRequest!.body);
    expect(body.prompt).toBe('test prompt');
    expect(body.image_urls).toHaveLength(1);
    expect(body.image_urls[0]).toContain('data:image/jpeg;base64,');
    expect(result.imageData).toBeInstanceOf(Buffer);
    expect(result.textResponse).toBe('Enhanced prompt');
  });

  it('handles data URI response', async () => {
    const fakeData = Buffer.from('data-uri-image').toString('base64');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: `data:image/png;base64,${fakeData}` }],
        revised_prompt: '',
      }),
    }) as typeof fetch;

    const { callFalAi } = await import('../skill/scripts/generate-image');
    const result = await callFalAi('test', [], '1:1');

    expect(result.imageData.toString()).toBe('data-uri-image');
  });

  it('throws on API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    }) as typeof fetch;

    const { callFalAi } = await import('../skill/scripts/generate-image');
    await expect(callFalAi('test', [], '1:1')).rejects.toThrow('fal.ai API returned 500');
  });

  it('throws when no images in response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ images: [], revised_prompt: '' }),
    }) as typeof fetch;

    const { callFalAi } = await import('../skill/scripts/generate-image');
    await expect(callFalAi('test', [], '1:1')).rejects.toThrow('No images in fal.ai response');
  });

  it('limits image_urls to 3 references', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fakeData = Buffer.from('img').toString('base64');
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('fal.run')) {
        capturedBody = JSON.parse(init?.body as string);
        return {
          ok: true,
          json: () => Promise.resolve({
            images: [{ url: `data:image/png;base64,${fakeData}` }],
            revised_prompt: '',
          }),
        };
      }
      return { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
    }) as typeof fetch;

    const { callFalAi } = await import('../skill/scripts/generate-image');
    await callFalAi('test', ['a', 'b', 'c', 'd', 'e'], '1:1');

    expect(capturedBody).not.toBeNull();
    expect((capturedBody!.image_urls as string[]).length).toBe(3);
  });

});

describe('callImageProvider routing', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('routes to AIHubMix when IMAGE_ENTRY is AIHUBMIX', async () => {
    process.env.IMAGE_ENTRY = 'AIHUBMIX';
    process.env.AIHUBMIX_API_KEY = 'test-key';

    const fakeImageBase64 = Buffer.from('fakepng').toString('base64');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{
          message: {
            multi_mod_content: [
              { text: 'test' },
              { inline_data: { data: fakeImageBase64 } },
            ],
          },
        }],
      }),
    }) as typeof fetch;

    const { callImageProvider } = await import('../skill/scripts/generate-image');
    const result = await callImageProvider('test', ['ref'], '3:4');
    expect(result.imageData).toBeInstanceOf(Buffer);

    // Verify the URL called was aihubmix
    const callUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callUrl).toContain('aihubmix.com');
  });

  it('routes to fal.ai when IMAGE_ENTRY is FAI', async () => {
    process.env.IMAGE_ENTRY = 'FAI';
    process.env.FAL_KEY = 'test-fal-key';

    const fakeData = Buffer.from('fal-image').toString('base64');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: `data:image/png;base64,${fakeData}` }],
        revised_prompt: 'revised',
      }),
    }) as typeof fetch;

    const { callImageProvider } = await import('../skill/scripts/generate-image');
    const result = await callImageProvider('test', ['ref'], '3:4');
    expect(result.imageData).toBeInstanceOf(Buffer);
    expect(result.textResponse).toBe('revised');

    // Verify the URL called was fal.ai
    const callUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callUrl).toContain('fal.run');
  });
});

// ─── Prompt routing integration tests ───────────────────────────────────────

describe('buildImagePrompt routing via IMAGE_ENTRY', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('produces Gemini structured [Tag] prompt when IMAGE_ENTRY=AIHUBMIX', async () => {
    process.env.IMAGE_ENTRY = 'AIHUBMIX';
    const { buildImagePrompt } = await import('../skill/scripts/generate-image');
    const prompt = buildImagePrompt('便利店前自拍', 'daily');
    expect(prompt).toContain('[Scene]');
    expect(prompt).toContain('[Camera]');
    expect(prompt).toContain('[Negative]');
  });

  it('produces Grok narrative prompt when IMAGE_ENTRY=FAI', async () => {
    process.env.IMAGE_ENTRY = 'FAI';
    const { buildImagePrompt } = await import('../skill/scripts/generate-image');
    const prompt = buildImagePrompt('便利店前自拍', 'daily');
    expect(prompt).not.toContain('[Scene]');
    expect(prompt).toContain('Instagram风格');
  });

  it('produces different prompts for Gemini vs Grok with same input', async () => {
    process.env.IMAGE_ENTRY = 'AIHUBMIX';
    const mod1 = await import('../skill/scripts/generate-image');
    const geminiPrompt = mod1.buildImagePrompt('COS摄影棚', 'cos');

    process.env.IMAGE_ENTRY = 'FAI';
    const mod2 = await import('../skill/scripts/generate-image');
    const grokPrompt = mod2.buildImagePrompt('COS摄影棚', 'cos');

    expect(geminiPrompt).not.toBe(grokPrompt);
    expect(geminiPrompt).toContain('[Scene]');
    expect(grokPrompt).not.toContain('[Scene]');
  });
});

describe('buildRealisticPrompt routing via IMAGE_ENTRY', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('Gemini realistic prompt has [Realism] tag', async () => {
    process.env.IMAGE_ENTRY = 'AIHUBMIX';
    const { buildRealisticPrompt } = await import('../skill/scripts/generate-image');
    const prompt = buildRealisticPrompt('日常穿搭', 'cos');
    expect(prompt).toContain('[Realism]');
    expect(prompt).toContain('[Scene]');
  });

  it('Grok realistic prompt has 真实感细节 without [Realism] tag', async () => {
    process.env.IMAGE_ENTRY = 'FAI';
    const { buildRealisticPrompt } = await import('../skill/scripts/generate-image');
    const prompt = buildRealisticPrompt('日常穿搭', 'cos');
    expect(prompt).toContain('真实感细节');
    expect(prompt).not.toContain('[Realism]');
  });
});
