// tests/reference-selector.test.ts
import { describe, it, expect } from 'vitest';
import { selectReferences, isSelfieType } from '../skill/scripts/reference-selector';

describe('isSelfieType', () => {
  it('returns true for daily style with selfie keywords', () => {
    expect(isSelfieType('daily', '在便利店里自拍')).toBe(true);
    expect(isSelfieType('daily', '镜子前的特写')).toBe(true);
    expect(isSelfieType('daily', '正脸照')).toBe(true);
  });

  it('returns false for daily style without selfie keywords', () => {
    expect(isSelfieType('daily', '街上看到的猫')).toBe(false);
    expect(isSelfieType('daily', '公园的风景')).toBe(false);
  });

  it('returns true for cos style by default (conservative)', () => {
    expect(isSelfieType('cos', '穿着制服在工作室')).toBe(true);
  });

  it('returns false for cos with explicit distant/landscape keywords', () => {
    expect(isSelfieType('cos', '远景全身照，背景是城堡')).toBe(false);
  });

  it('returns false for travel style by default', () => {
    expect(isSelfieType('travel', '海边的日落')).toBe(false);
  });

  it('returns true for travel with selfie keywords', () => {
    expect(isSelfieType('travel', '在海边自拍')).toBe(true);
  });

  it('returns false for behind_scenes by default', () => {
    expect(isSelfieType('behind_scenes', '工作台上的道具')).toBe(false);
  });
});

describe('selectReferences', () => {
  it('returns front + left-profile for selfie/closeup', () => {
    const refs = selectReferences('daily', '便利店自拍');
    expect(refs).toEqual(['front.png', 'left-profile.png']);
  });

  it('returns front + half-body for half-body cos', () => {
    const refs = selectReferences('cos', '穿着制服在工作室拍半身');
    expect(refs).toEqual(['front.png', 'half-body.png']);
  });

  it('returns half-body + full-body for full-body travel', () => {
    const refs = selectReferences('travel', '站在樱花树下的全身照');
    expect(refs).toEqual(['half-body.png', 'full-body.png']);
  });

  it('returns full-body only for distant/landscape scenes', () => {
    const refs = selectReferences('travel', '远处的海边风景，人很小');
    expect(refs).toEqual(['full-body.png']);
  });

  it('returns front + half-body + full-body for cos without specific angle cues', () => {
    const refs = selectReferences('cos', '穿着制服在工作室');
    expect(refs).toEqual(['front.png', 'half-body.png', 'full-body.png']);
  });

  it('returns filenames only (not full paths)', () => {
    const refs = selectReferences('daily', '自拍');
    refs.forEach(ref => {
      expect(ref).not.toContain('/');
      expect(ref).toMatch(/\.png$/);
    });
  });
});
