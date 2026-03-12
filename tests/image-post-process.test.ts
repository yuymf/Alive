import { describe, it, expect } from 'vitest';
import {
  getProcessingParams,
  mulberry32,
} from '../skill/scripts/image-post-process';

describe('mulberry32', () => {
  it('produces deterministic output for same seed', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    expect(rng1()).toBe(rng2());
    expect(rng1()).toBe(rng2());
  });

  it('produces different output for different seeds', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(99);
    expect(rng1()).not.toBe(rng2());
  });

  it('returns values between 0 and 1', () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      const val = rng();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });
});

describe('getProcessingParams', () => {
  it('returns no-op params for cos style', () => {
    const params = getProcessingParams('cos');
    expect(params.skip).toBe(true);
  });

  it('returns daily params with noise and blur', () => {
    const params = getProcessingParams('daily');
    expect(params.skip).toBe(false);
    expect(params.noisePercent).toBeGreaterThan(0);
    expect(params.blurRadius).toBeGreaterThan(0);
  });

  it('returns travel params with saturation and vignette', () => {
    const params = getProcessingParams('travel');
    expect(params.skip).toBe(false);
    expect(params.saturationDelta).toBeGreaterThan(0);
    expect(params.vignetteStrength).toBeGreaterThan(0);
  });

  it('returns behind_scenes params with reduced contrast', () => {
    const params = getProcessingParams('behind_scenes');
    expect(params.skip).toBe(false);
    expect(params.contrastDelta).toBeLessThan(0);
  });

  it('uses groupSeed for deterministic randomness within group', () => {
    const params1 = getProcessingParams('daily', 42);
    const params2 = getProcessingParams('daily', 42);
    expect(params1).toEqual(params2);
  });

  it('produces ±3% variation within group (groupSeed)', () => {
    const params1 = getProcessingParams('daily', 42);
    const params2 = getProcessingParams('daily', 43);
    expect(typeof params1.noisePercent).toBe('number');
  });

  it('defaults unknown style to daily processing', () => {
    const params = getProcessingParams('unknown_style' as any);
    expect(params.skip).toBe(false);
    expect(params.noisePercent).toBeGreaterThan(0);
  });
});
