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
