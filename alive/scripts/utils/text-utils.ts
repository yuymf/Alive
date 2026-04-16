// alive/scripts/utils/text-utils.ts
// Shared text analysis utilities for keyword extraction and fuzzy matching.
// Extracted from skill-need-tracker.ts for reuse in wisdom dedup.

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'is', 'was', 'it',
  'and', 'or', 'but', 'with', 'that', 'this', 'from', 'not', 'no', 'be',
  'at', 'by', 'as', 'do', 'if', 'so', 'up',
]);

/**
 * Extract significant keywords from text for fuzzy matching.
 * Strips stop words, returns lowercased tokens ≥ 3 chars.
 * Supports both English words and CJK characters.
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Check if two keyword arrays share enough overlap for fuzzy dedup.
 * Requires ≥ 50% of the shorter set to overlap.
 */
export function keywordsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setB = new Set(b);
  const shared = a.filter(w => setB.has(w)).length;
  const threshold = Math.ceil(Math.min(a.length, b.length) * 0.5);
  return shared >= threshold;
}

// ─── Keyword Normalization for Search ──────────────────────────────────────

/** Maximum character length for a search keyword */
const KEYWORD_MAX_LENGTH = 16;

/** Chinese stop words that add noise but no value as search keywords */
const CHINESE_STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有',
  '看', '好', '自己', '这', '他', '她', '它', '什么', '怎么', '为什么',
  '如何', '可以', '因为', '所以', '但是', '然而', '还是', '或者', '以及',
  '关于', '对于', '通过', '进行', '已经', '应该', '需要', '成为', '来自',
]);

/**
 * Detect the primary language of a keyword string.
 * Returns: 'zh' (predominantly Chinese), 'en' (predominantly Latin), 'ja' (Japanese),
 *          'mixed' (significant mix), or 'other'.
 */
export function detectKeywordLanguage(text: string): 'zh' | 'en' | 'ja' | 'mixed' | 'other' {
  const trimmed = text.trim();
  if (!trimmed) return 'other';

  let cjkCount = 0;     // CJK Unified Ideographs (Chinese + Japanese kanji)
  let hiraganaCount = 0; // Japanese hiragana
  let katakanaCount = 0; // Japanese katakana
  let latinCount = 0;    // Latin letters
  let digitCount = 0;

  for (const ch of trimmed) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x4E00 && code <= 0x9FFF) cjkCount++;
    else if (code >= 0x3040 && code <= 0x309F) hiraganaCount++;
    else if (code >= 0x30A0 && code <= 0x30FF) katakanaCount++;
    else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) latinCount++;
    else if (code >= 0x30 && code <= 0x39) digitCount++;
  }

  const japaneseSpecific = hiraganaCount + katakanaCount;
  const totalChars = cjkCount + japaneseSpecific + latinCount;

  // If there are Japanese-specific characters (hiragana/katakana), it's Japanese
  if (japaneseSpecific > 0 && japaneseSpecific >= cjkCount * 0.3) return 'ja';
  // If predominantly CJK (without Japanese markers), it's Chinese
  if (cjkCount > 0 && cjkCount >= totalChars * 0.5) return 'zh';
  // If predominantly Latin, it's English
  if (latinCount > 0 && latinCount >= totalChars * 0.5) return 'en';
  // Significant mix of CJK and Latin
  if (cjkCount > 0 && latinCount > 0) return 'mixed';

  return 'other';
}

/**
 * Clean a keyword string: strip punctuation, emojis, hashtags, noise.
 */
function cleanKeywordRaw(text: string): string {
  return text
    // Remove hashtag prefixes
    .replace(/^#+/, '')
    // Remove "关联话题：" prefix
    .replace(/^关联话题[：:]\s*/, '')
    // Remove surrounding quotes
    .replace(/^[""「」『』]|[""「」『』]$/g, '')
    // Remove common noise patterns
    .replace(/[🥺😭❤️🔥✨👍💡📌🎯📈⚡🌟💪🎉👀💬🙏💕✅❌🏆👏😎🤔🙋‍♀️🫶]/g, '')
    // Trim whitespace
    .trim();
}

/**
 * Extract core noun phrases from a long Chinese sentence.
 * Uses simple heuristics: split on conjunctions/particles, pick the most substantive segment.
 */
function extractCorePhrase(text: string): string {
  // Split on common Chinese conjunctions/particles that separate clauses
  const segments = text
    .split(/[，。、！？；：但是然而而且并且或者以及虽然尽管]/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (segments.length <= 1) return text;

  // Pick the segment with the highest ratio of content words (CJK characters vs total)
  let bestSegment = segments[0];
  let bestRatio = 0;
  for (const seg of segments) {
    let cjk = 0;
    for (const ch of seg) {
      const code = ch.codePointAt(0)!;
      if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3040 && code <= 0x30FF)) cjk++;
    }
    const ratio = seg.length > 0 ? cjk / seg.length : 0;
    if (ratio > bestRatio && seg.length >= 2) {
      bestRatio = ratio;
      bestSegment = seg;
    }
  }
  return bestSegment;
}

/**
 * Normalize a keyword for search use.
 * Returns null if the keyword should be discarded.
 *
 * Processing:
 * 1. Strip noise (hashtags, emojis, punctuation prefixes)
 * 2. Filter by language (prefer Chinese, down-rank non-Chinese)
 * 3. Extract core phrase from long sentences
 * 4. Remove Chinese stop words from edges
 * 5. Enforce max length
 */
export function normalizeKeyword(
  raw: string,
  options: { allowNonChinese?: boolean; maxLength?: number } = {},
): string | null {
  const { allowNonChinese = true, maxLength = KEYWORD_MAX_LENGTH } = options;

  // Step 1: Clean noise
  let cleaned = cleanKeywordRaw(raw);
  if (!cleaned) return null;

  // Step 2: Language filter
  const lang = detectKeywordLanguage(cleaned);
  if (lang === 'ja') return null; // Always skip Japanese keywords
  if (lang === 'en' && !allowNonChinese) return null; // Skip English only when explicitly disallowed
  if (lang === 'other') return null; // Gibberish/symbols

  // Step 3: Extract core phrase if too long (only for CJK/mixed content)
  // For pure English, allow longer phrases since they work fine as search queries
  if (cleaned.length > maxLength && lang !== 'en') {
    cleaned = extractCorePhrase(cleaned);
  }

  // Step 4: Strip leading/trailing stop words
  while (CHINESE_STOP_WORDS.has(cleaned)) return null; // Entire keyword is a stop word
  // Strip leading stop words
  while (cleaned.length > 0) {
    let stripped = false;
    for (const sw of CHINESE_STOP_WORDS) {
      if (cleaned.startsWith(sw) && cleaned.length > sw.length) {
        cleaned = cleaned.slice(sw.length);
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }
  // Strip trailing stop words
  while (cleaned.length > 0) {
    let stripped = false;
    for (const sw of CHINESE_STOP_WORDS) {
      if (cleaned.endsWith(sw) && cleaned.length > sw.length) {
        cleaned = cleaned.slice(0, -sw.length);
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }

  // Step 5: Enforce max length (hard truncate as last resort, skip for English)
  // English phrases like "quantum computing" work fine as search queries even when long
  if (cleaned.length > maxLength && lang !== 'en') {
    cleaned = cleaned.slice(0, maxLength);
  }
  // For English, enforce a softer limit (e.g., 30 chars max)
  if (cleaned.length > 30 && lang === 'en') {
    cleaned = cleaned.slice(0, 30);
  }

  // Final check: must have at least 2 CJK characters or 2 alphanumeric characters
  const cjkCount = [...cleaned].filter(ch => {
    const code = ch.codePointAt(0)!;
    return (code >= 0x4E00 && code <= 0x9FFF);
  }).length;
  const alphaNumCount = [...cleaned].filter(ch => {
    const code = ch.codePointAt(0)!;
    return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A);
  }).length;

  if (cjkCount < 2 && alphaNumCount < 2) return null;

  return cleaned.trim().toLowerCase();
}

// ─── Trend Hook Keyword Extraction ───────────────────────────────────────────

/**
 * Extract the keyword portion from a trend_hook string.
 *
 * Supports formats:
 *   "keyword (platform, Nx)"
 *   "keyword (platform, Nx, 来源桶)"
 *   "keyword (platform, Nx, 来源桶) ⚠️疑似标题党"
 *   "keyword"
 *
 * Strips trailing warning/ad labels (⚠️, 📢) before extraction.
 */
export function extractTrendHookKeyword(trendHook: string): string {
  const cleaned = trendHook.replace(/\s*[⚠📢].+$/, '');
  const idx = cleaned.lastIndexOf(' (');
  return idx > 0 ? cleaned.slice(0, idx).trim() : cleaned.trim();
}
