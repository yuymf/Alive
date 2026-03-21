import { describe, it, expect, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockReturnValue([]),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(Buffer.from('fakeimage')),
    statSync: vi.fn().mockReturnValue({ size: 100, mtimeMs: 0 }),
  };
});

vi.mock('../skill/scripts/image-post-process', () => ({
  postProcessImage: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
}));

// Mock global fetch: return image data for generation calls, and "8" for quality checks
const fakeImageBase64 = Buffer.from('fakepng').toString('base64');
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({
    choices: [{
      message: {
        content: '8',
        multi_mod_content: [
          { text: '8' },
          { inline_data: { data: fakeImageBase64 } },
        ],
      },
    }],
  }),
  text: () => Promise.resolve(''),
}) as any;

process.env.IMAGE_ENTRY = 'AIHUBMIX';
process.env.AIHUBMIX_API_KEY = 'test-key';

import { generateImageSet } from '../skill/scripts/generate-image';
import { ShotDescription } from '../skill/scripts/types';

describe('generateImageSet', () => {
  it('generates one image per shot', async () => {
    const shots: ShotDescription[] = [
      { description: '正面特写', angle: '正面', variation: '主图' },
      { description: '侧面', angle: '左侧', variation: '侧脸' },
    ];
    const result = await generateImageSet({
      shots, baseReferenceDir: '/tmp/refs', style: 'cos',
    });
    expect(result.images.length + result.failed).toBe(2);
    expect(result.images.length).toBeGreaterThan(0);
  });

  it('returns failed count when generation throws', async () => {
    // Make fetch fail for all retry attempts (need enough for fallback chain x retries)
    for (let i = 0; i < 20; i++) {
      (global.fetch as any).mockRejectedValueOnce(new Error('API error'));
    }
    const result = await generateImageSet({
      shots: [{ description: '会失败的', angle: '正面', variation: '主图' }],
      baseReferenceDir: '/tmp/refs', style: 'daily',
    });
    expect(result.failed).toBe(1);
    expect(result.images).toHaveLength(0);
  }, 15_000);
});
