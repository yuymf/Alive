// tests/sanitize-image.test.ts
import { sanitizeForImageGen } from '../skill/scripts/generate-image';

describe('sanitizeForImageGen', () => {
  describe('original patterns still work', () => {
    it('replaces transparency terms', () => {
      expect(sanitizeForImageGen('透明面料')).toBe('轻薄面料');
      expect(sanitizeForImageGen('半透明')).toBe('轻盈');
    });

    it('replaces body terms', () => {
      expect(sanitizeForImageGen('身体轮廓')).toBe('身形线条');
      expect(sanitizeForImageGen('身材曲线')).toBe('优美体态');
    });

    it('replaces exposure terms', () => {
      expect(sanitizeForImageGen('性感')).toBe('时尚');
      expect(sanitizeForImageGen('暴露')).toBe('清凉');
    });

    it('replaces underwear terms', () => {
      expect(sanitizeForImageGen('内衣')).toBe('贴身衣物');
      expect(sanitizeForImageGen('比基尼')).toBe('泳装');
    });
  });

  describe('new patterns from E2E failures', () => {
    it('replaces 蕾丝内搭 (lace undergarment)', () => {
      expect(sanitizeForImageGen('黑色蕾丝内搭')).toBe('黑色深色打底');
    });

    it('replaces standalone 蕾丝', () => {
      expect(sanitizeForImageGen('蕾丝面料很好看')).toBe('花纹面料面料很好看');
    });

    it('replaces 乳沟 (cleavage)', () => {
      expect(sanitizeForImageGen('勒出明显的乳沟线条')).toBe('显出明显的领口');
    });

    it('replaces 事业线', () => {
      expect(sanitizeForImageGen('露出事业线')).toBe('展示穿搭');
    });

    it('replaces bra (case-insensitive)', () => {
      expect(sanitizeForImageGen('内搭黑色bra')).toBe('内搭黑色内搭');
      expect(sanitizeForImageGen('内搭黑色BRA')).toBe('内搭黑色内搭');
    });

    it('replaces crop top', () => {
      expect(sanitizeForImageGen('黑色紧身crop top')).toBe('黑色修身短上衣');
    });

    it('replaces 若隐若现', () => {
      expect(sanitizeForImageGen('若隐若现')).toBe('朦胧感');
    });

    it('replaces 胸部轮廓', () => {
      expect(sanitizeForImageGen('包裹胸部轮廓')).toBe('包裹上身线条');
    });

    it('replaces 紧身 and 紧紧包裹', () => {
      expect(sanitizeForImageGen('紧紧包裹')).toBe('贴合');
      expect(sanitizeForImageGen('紧身')).toBe('修身');
    });

    it('replaces 低腰', () => {
      expect(sanitizeForImageGen('低腰工装裤')).toBe('休闲腰线工装裤');
    });

    it('replaces 髋骨', () => {
      expect(sanitizeForImageGen('裤腰挂在髋骨上')).toBe('裤腰挂在腰部上');
    });

    it('replaces 慵懒', () => {
      expect(sanitizeForImageGen('眼神慵懒')).toBe('眼神随性');
    });

    it('replaces 挑逗', () => {
      expect(sanitizeForImageGen('眼神有些挑逗')).toBe('眼神有些俏皮');
    });

    it('replaces 前倾', () => {
      expect(sanitizeForImageGen('身体微微前倾')).toBe('身体微微微微倾身');
    });

    it('replaces 咬唇 / 咬下唇', () => {
      expect(sanitizeForImageGen('嘴唇轻咬下唇')).toBe('嘴唇轻微笑');
    });

    it('replaces 勒出', () => {
      expect(sanitizeForImageGen('勒出明显的线条')).toBe('显出明显的线条');
    });

    it('replaces 腰身', () => {
      expect(sanitizeForImageGen('露出一截纤细的腰身')).toBe('露出一截纤细的腰线');
    });
  });

  describe('real E2E shot descriptions', () => {
    it('sanitizes the "蕾丝内搭" shot from hour 9', () => {
      const original = '皮衣拉链拉到胸口露出里面的黑色蕾丝内搭，若隐若现';
      const sanitized = sanitizeForImageGen(original);
      expect(sanitized).not.toContain('蕾丝');
      expect(sanitized).not.toContain('若隐若现');
    });

    it('sanitizes the "乳沟/事业线" shot from hour 22', () => {
      const original = '紧紧包裹胸部轮廓，勒出明显的乳沟线条。露出事业线。眼神有些慵懒和挑逗，嘴唇轻咬下唇';
      const sanitized = sanitizeForImageGen(original);
      expect(sanitized).not.toContain('乳沟');
      expect(sanitized).not.toContain('事业线');
      expect(sanitized).not.toContain('挑逗');
      expect(sanitized).not.toContain('慵懒');
      expect(sanitized).not.toContain('咬');
    });

    it('sanitizes the "bra/低腰/髋骨" shot from hour 22', () => {
      const original = '穿搭是白色宽松T恤内搭黑色bra，下身换成了一条低腰工装裤，腰线很低，裤腰挂在髋骨上，露出一截纤细的腰身';
      const sanitized = sanitizeForImageGen(original);
      expect(sanitized).not.toContain('bra');
      expect(sanitized).not.toContain('低腰');
      expect(sanitized).not.toContain('髋骨');
    });
  });
});
