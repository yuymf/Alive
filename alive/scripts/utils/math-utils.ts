// alive/scripts/utils/math-utils.ts
// Shared mathematical and numeric utilities

/**
 * Clamp a number to a [min, max] range.
 * If value is not finite, returns min.
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
