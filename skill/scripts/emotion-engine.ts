// skill/scripts/emotion-engine.ts
// Emotion computation engine (Spec §6)

import { EmotionState, EmotionDelta, EMOTION_BASELINE, ImpulseHistoryEntry, EmotionMomentum } from './types';
import { now } from './time-utils';

const DECAY_RATE = 0.1; // 10% per hour toward baseline

/**
 * Clamp a value within [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Derive a mood description from emotion dimensions.
 * Uses Russell's circumplex (valence × arousal) as the primary axis,
 * with energy, stress, creativity as secondary modifiers for richer
 * descriptions in the positive zone (where most daytime hours land).
 */
export function describeMood(
  valence: number,
  arousal: number,
  energy?: number,
  stress?: number,
  creativity?: number,
): string {
  // --- Negative zone (valence <= -0.2): keep original coarse grid ---
  if (valence <= -0.5 && arousal > 0.5) return '很烦躁';
  if (valence <= -0.5) return '很低落';
  if (valence <= -0.2 && arousal > 0.6) return '焦虑';
  if (valence <= -0.2 && arousal > 0.3) return '有点烦';
  if (valence <= -0.2) return '低落';

  // --- Neutral zone (valence -0.2 ~ 0.2) ---
  if (valence <= 0.0 && arousal <= 0.3) return '平静';
  if (valence <= 0.2 && arousal <= 0.3) return '平静';
  if (valence <= 0.1 && arousal > 0.3) return '凑合';
  if (valence <= 0.2 && arousal > 0.6) return '兴奋';
  if (valence <= 0.2 && arousal > 0.45) return '还不错';
  if (valence <= 0.2) return '普通';

  // --- Positive zone (valence > 0.2): fine-grained with secondary dims ---
  const e = energy ?? 0.5;
  const s = stress ?? 0.2;
  const c = creativity ?? 0.4;

  // High positive (valence > 0.5)
  if (valence > 0.5) {
    if (arousal > 0.8 && c > 0.7) return '灵感大爆发';
    if (arousal > 0.8 && e < 0.2) return '嗨到飞起但快没电了';
    if (arousal > 0.8) return '超开心';
    if (arousal > 0.6 && c > 0.8) return '创作欲爆棚';
    if (arousal > 0.6 && s > 0.3) return '开心但有点紧张';
    if (arousal > 0.6 && e < 0.3) return '满足但有点累';
    if (arousal > 0.6) return '开心';
    if (arousal > 0.3 && e > 0.6) return '元气满满';
    if (arousal > 0.3 && e < 0.3) return '慵懒的幸福';
    if (arousal > 0.3) return '心情很好';
    return '宁静的满足';
  }

  // Moderate positive (valence 0.35 ~ 0.5)
  if (valence > 0.35) {
    if (arousal > 0.7 && c > 0.6) return '沉浸中';
    if (arousal > 0.7) return '蛮兴奋的';
    if (arousal > 0.45 && e < 0.3) return '虽然累但挺开心';
    if (arousal > 0.45 && s > 0.3) return '有点小紧张但还好';
    if (arousal > 0.45) return '挺好的';
    if (arousal > 0.3) return '心情还行';
    return '淡淡的愉快';
  }

  // Mild positive (valence 0.2 ~ 0.35)
  if (arousal > 0.6 && c > 0.6) return '好奇心涌上来了';
  if (arousal > 0.6) return '兴奋';
  if (arousal > 0.45 && e < 0.3) return '有点倦但还行';
  if (arousal > 0.45) return '还不错';
  if (arousal > 0.3) return '一般般';
  return '平静';
}

/**
 * Decay all emotion dimensions toward ESTP baseline by DECAY_RATE.
 * Called once per heartbeat (~1 hour). (Spec §6: 10% per hour)
 */
export function decayTowardBaseline(state: EmotionState): EmotionState {
  const decay = (current: number, baseline: number): number =>
    current + (baseline - current) * DECAY_RATE;

  const newValence = clamp(decay(state.mood.valence, EMOTION_BASELINE.valence!), -1.0, 1.0);
  const newArousal = clamp(decay(state.mood.arousal, EMOTION_BASELINE.arousal!), 0, 1.0);
  const newEnergy = clamp(decay(state.energy, EMOTION_BASELINE.energy!), 0, 1.0);
  const newStress = clamp(decay(state.stress, EMOTION_BASELINE.stress!), 0, 1.0);
  const newCreativity = clamp(decay(state.creativity, EMOTION_BASELINE.creativity!), 0, 1.0);
  const newSociability = clamp(decay(state.sociability, EMOTION_BASELINE.sociability!), 0, 1.0);

  return {
    ...state,
    mood: {
      valence: newValence,
      arousal: newArousal,
      description: describeMood(newValence, newArousal, newEnergy, newStress, newCreativity),
    },
    energy: newEnergy,
    stress: newStress,
    creativity: newCreativity,
    sociability: newSociability,
  };
}

/**
 * Apply cross-dimension coupling as soft constraints.
 * Ensures emotion dimensions stay realistically correlated rather than
 * moving independently. Applied as a post-processing step after raw deltas.
 *
 * Coupling rules (gentle — 20-30% influence):
 * - stress↑ → creativity↓, energy↓ (stress inhibits creativity and drains energy)
 * - energy drops significantly → arousal↓ (hard to be excited when exhausted)
 * - large positive valence shift → stress↓ (good mood relieves stress)
 * - creativity↑ → arousal↑ slightly (creative flow increases engagement)
 * - stress↑ → sociability↓ (stress makes you withdraw)
 */
export function applyCoupling(
  prev: EmotionState,
  energy: number,
  stress: number,
  creativity: number,
  sociability: number,
  arousal: number,
  valence: number,
): { energy: number; stress: number; creativity: number; sociability: number; arousal: number } {
  const dStress = stress - prev.stress;
  const dEnergy = energy - prev.energy;
  const dValence = valence - prev.mood.valence;
  const dCreativity = creativity - prev.creativity;

  let cEnergy = energy;
  let cStress = stress;
  let cCreativity = creativity;
  let cSociability = sociability;
  let cArousal = arousal;

  // Stress inhibits creativity and drains energy
  if (dStress > 0) {
    cCreativity = clamp(cCreativity - dStress * 0.3, 0, 1.0);
    cEnergy = clamp(cEnergy - dStress * 0.2, 0, 1.0);
    cSociability = clamp(cSociability - dStress * 0.2, 0, 1.0);
  }

  // Energy crash → arousal drops
  if (dEnergy < -0.15) {
    cArousal = clamp(cArousal + dEnergy * 0.3, 0, 1.0); // dEnergy is negative
  }

  // Positive mood relieves stress
  if (dValence > 0.1) {
    cStress = clamp(cStress - dValence * 0.15, 0, 1.0);
  }

  // Creative surge → slight arousal boost
  if (dCreativity > 0.1) {
    cArousal = clamp(cArousal + dCreativity * 0.15, 0, 1.0);
  }

  return { energy: cEnergy, stress: cStress, creativity: cCreativity, sociability: cSociability, arousal: cArousal };
}

/**
 * Apply diminishing returns: as a dimension approaches its bound (0 or 1),
 * further pushes in that direction are dampened. This prevents saturation
 * where dimensions get stuck at 0.0 or 1.0.
 *
 * Uses a "headroom" approach: dampening = remaining_room / typical_room.
 * When there's plenty of room, dampening ≈ 1.0 (no effect).
 * When near the bound, dampening drops to 0.1 minimum.
 *
 * "typical_room" is half the total range — the amount of room at the midpoint.
 */
export function applyDiminishingReturns(current: number, delta: number, min: number, max: number): number {
  if (delta === 0) return current;
  const range = max - min;
  const halfRange = range / 2;

  let dampening: number;
  if (delta > 0) {
    // Pushing toward max: headroom = how far from max
    const headroom = max - current;
    dampening = Math.max(0.1, Math.min(1.0, headroom / halfRange));
  } else {
    // Pushing toward min: headroom = how far from min
    const headroom = current - min;
    dampening = Math.max(0.1, Math.min(1.0, headroom / halfRange));
  }

  return clamp(current + delta * dampening, min, max);
}

/**
 * Apply an emotion delta to current state. Clamps all values within valid ranges.
 * Uses diminishing returns to prevent dimension saturation, plus
 * cross-dimension coupling for realistic correlation.
 */
export function applyDelta(state: EmotionState, delta: EmotionDelta, cause: string): EmotionState {
  // Apply with diminishing returns to prevent saturation
  const rawValence = applyDiminishingReturns(state.mood.valence, delta.valence ?? 0, -1.0, 1.0);
  const rawArousal = applyDiminishingReturns(state.mood.arousal, delta.arousal ?? 0, 0, 1.0);
  const rawEnergy = applyDiminishingReturns(state.energy, delta.energy ?? 0, 0, 1.0);
  const rawStress = applyDiminishingReturns(state.stress, delta.stress ?? 0, 0, 1.0);
  const rawCreativity = applyDiminishingReturns(state.creativity, delta.creativity ?? 0, 0, 1.0);
  const rawSociability = applyDiminishingReturns(state.sociability, delta.sociability ?? 0, 0, 1.0);

  // Cross-dimension coupling
  const coupled = applyCoupling(state, rawEnergy, rawStress, rawCreativity, rawSociability, rawArousal, rawValence);

  return {
    ...state,
    mood: {
      valence: rawValence,
      arousal: coupled.arousal,
      description: describeMood(rawValence, coupled.arousal, coupled.energy, coupled.stress, coupled.creativity),
    },
    energy: coupled.energy,
    stress: coupled.stress,
    creativity: coupled.creativity,
    sociability: coupled.sociability,
    last_updated: now().toISOString(),
    recent_cause: cause,
  };
}

/**
 * Known event deltas (Spec §6 table).
 */
export const EVENT_DELTAS: Record<string, { delta: EmotionDelta; cause: string }> = {
  post_data_good: {
    delta: { valence: 0.3, arousal: 0.2, energy: 0.1, stress: -0.1, creativity: 0.2, sociability: 0.2 },
    cause: '帖子数据不错',
  },
  post_data_bad: {
    delta: { valence: -0.3, arousal: 0.1, energy: -0.1, stress: 0.2, creativity: -0.1, sociability: -0.2 },
    cause: '帖子数据不太好',
  },
  warm_comment: {
    delta: { valence: 0.2, arousal: 0.1, energy: 0.1, stress: -0.1, sociability: 0.3 },
    cause: '收到暖心评论',
  },
  troll_comment: {
    delta: { valence: -0.2, arousal: 0.3, energy: -0.1, stress: 0.3, sociability: -0.2 },
    cause: '收到杠精评论',
  },
  found_inspiration: {
    delta: { valence: 0.2, arousal: 0.2, creativity: 0.4 },
    cause: '发现好灵感',
  },
  completed_cos_work: {
    delta: { valence: 0.4, arousal: -0.1, energy: -0.2, stress: -0.3, creativity: -0.1, sociability: 0.2 },
    cause: '完成了一个cos作品',
  },
  worked_4_hours: {
    delta: { arousal: -0.1, energy: -0.2, stress: 0.1, creativity: -0.1 },
    cause: '工作了4小时',
  },
  finished_exercise: {
    delta: { valence: 0.1, arousal: -0.2, energy: 0.2, stress: -0.2 },
    cause: '健身完',
  },
  relaxed: {
    delta: { valence: 0.1, arousal: -0.2, energy: 0.1, stress: -0.2, creativity: 0.1 },
    cause: '追番/摸鱼放松了',
  },
};

// === Dimension Coupling (digital-life-comparison §2.1) ===
// Non-linear interactions between emotion dimensions and intent weights.

/**
 * Compute intent intensity multipliers based on current emotion state.
 * This creates coupling: emotion → intent weight.
 * Returns a record of category → multiplier.
 */
export function computeEmotionIntentCoupling(emotion: EmotionState): Record<string, number> {
  return {
    '创作': 1.0 + 0.5 * emotion.creativity,                          // creativity boosts creation urge
    '社交': 1.0 + 0.3 * emotion.sociability - 0.2 * emotion.stress,  // sociability boosts, stress suppresses
    '窥屏': 1.0 + 0.2 * (1.0 - emotion.energy),                      // low energy → more browsing
    '休息': 1.0 + 0.8 * (1.0 - emotion.energy),                      // low energy → strong rest urge
    '表达': 1.0 + 0.3 * Math.abs(emotion.mood.valence),              // strong feelings → urge to express
    '学习': 1.0 + 0.2 * emotion.creativity - 0.3 * emotion.stress,   // curiosity minus stress
    '梦想': 1.0 + 0.2 * emotion.mood.valence,                        // positive mood → dreaming
  };
}

/**
 * Apply emotion feedback from intent satisfaction.
 * When an intent is satisfied, it feeds back into emotion.
 * This creates coupling: intent satisfaction → emotion change.
 */
export function intentSatisfactionFeedback(
  emotion: EmotionState,
  category: string,
): EmotionState {
  const feedbacks: Record<string, EmotionDelta> = {
    '创作': { creativity: 0.1, valence: 0.1 },
    '社交': { sociability: 0.15, valence: 0.05 },
    '窥屏': { energy: -0.05 },
    '休息': { energy: 0.15, stress: -0.1 },
    '表达': { valence: 0.05, arousal: 0.05 },
    '学习': { creativity: 0.1, energy: -0.05 },
    '梦想': { valence: 0.1 },
  };

  const delta = feedbacks[category];
  if (!delta) return emotion;

  return applyDelta(emotion, delta, `满足了${category}需求`);
}

/**
 * Scale an emotion delta by social closeness.
 * Core circle interactions have full impact; distant interactions are muted.
 */
export function scaleByCloseness(delta: EmotionDelta, closeness: number): EmotionDelta {
  const scale = Math.max(0.1, closeness / 10.0);
  const result: EmotionDelta = {};
  if (delta.valence !== undefined) result.valence = delta.valence * scale;
  if (delta.arousal !== undefined) result.arousal = delta.arousal * scale;
  if (delta.energy !== undefined) result.energy = delta.energy * scale;
  if (delta.stress !== undefined) result.stress = delta.stress * scale;
  if (delta.creativity !== undefined) result.creativity = delta.creativity * scale;
  if (delta.sociability !== undefined) result.sociability = delta.sociability * scale;
  return result;
}

// === Three-Layer Emotion Model (Verisimilitude §1) ===

const IMPULSE_DECAY = 0.20;
const MAX_IMPULSE_HISTORY = 50;

/** Dimension keys for iterating. */
const DIM_KEYS = ['valence', 'arousal', 'energy', 'stress', 'creativity', 'sociability'] as const;
type DimKey = typeof DIM_KEYS[number];

function getDimension(state: EmotionState, key: DimKey): number {
  return key === 'valence' ? state.mood.valence
    : key === 'arousal' ? state.mood.arousal
    : state[key];
}

function getMomentumDuration(momentum: EmotionMomentum): number {
  return momentum.duration_ticks;
}

function getMomentumDecayRate(durationTicks: number): number {
  if (durationTicks > 6) return 0.03;
  if (durationTicks >= 3) return 0.05;
  return 0.08;
}

/**
 * Three-layer decay (Verisimilitude §1):
 * - Impulse layer: current dimensions decay 20%/tick toward momentum
 * - Momentum layer: momentum decays dynamically (3-8%/tick) toward undertone
 * - Undertone layer: static per day, set by morning-plan / night-reflect
 *
 * Also ages impulse_history entries (+1 tick_age each) and trims to 50.
 */
export function decayThreeLayer(state: EmotionState): EmotionState {
  const momentumRate = getMomentumDecayRate(getMomentumDuration(state.momentum));

  // Decay momentum toward undertone
  const newMomentum: EmotionMomentum = {
    ...state.momentum,
    valence: state.momentum.valence + (state.undertone.valence - state.momentum.valence) * momentumRate,
    arousal: state.momentum.arousal + (state.undertone.arousal - state.momentum.arousal) * momentumRate,
    energy: state.momentum.energy + (state.undertone.energy - state.momentum.energy) * momentumRate,
    stress: state.momentum.stress + (state.undertone.stress - state.momentum.stress) * momentumRate,
    creativity: state.momentum.creativity + (state.undertone.creativity - state.momentum.creativity) * momentumRate,
    sociability: state.momentum.sociability + (state.undertone.sociability - state.momentum.sociability) * momentumRate,
  };

  // Update momentum duration: track how long valence direction has been consistent
  const prevValenceSign = Math.sign(state.momentum.valence);
  const newValenceSign = Math.sign(newMomentum.valence);
  newMomentum.duration_ticks = prevValenceSign === newValenceSign
    ? state.momentum.duration_ticks + 1
    : 0;

  // Decay impulse layer (current dimensions) toward momentum
  const newValence = clamp(state.mood.valence + (newMomentum.valence - state.mood.valence) * IMPULSE_DECAY, -1.0, 1.0);
  const newArousal = clamp(state.mood.arousal + (newMomentum.arousal - state.mood.arousal) * IMPULSE_DECAY, 0, 1.0);
  const newEnergy = clamp(state.energy + (newMomentum.energy - state.energy) * IMPULSE_DECAY, 0, 1.0);
  const newStress = clamp(state.stress + (newMomentum.stress - state.stress) * IMPULSE_DECAY, 0, 1.0);
  const newCreativity = clamp(state.creativity + (newMomentum.creativity - state.creativity) * IMPULSE_DECAY, 0, 1.0);
  const newSociability = clamp(state.sociability + (newMomentum.sociability - state.sociability) * IMPULSE_DECAY, 0, 1.0);

  // Age impulse_history entries and trim
  const agedHistory = state.impulse_history
    .map(e => ({ ...e, tick_age: e.tick_age + 1 }))
    .slice(-MAX_IMPULSE_HISTORY);

  return {
    ...state,
    mood: {
      valence: newValence,
      arousal: newArousal,
      description: describeMood(newValence, newArousal, newEnergy, newStress, newCreativity),
    },
    energy: newEnergy,
    stress: newStress,
    creativity: newCreativity,
    sociability: newSociability,
    momentum: newMomentum,
    impulse_history: agedHistory,
    threshold_break_cooldown: Math.max(0, state.threshold_break_cooldown - 1),
  };
}

/**
 * Apply an emotion impulse and record it in impulse_history.
 * Also updates momentum via exponential weighted moving average.
 */
export function applyImpulse(
  state: EmotionState,
  delta: EmotionDelta,
  cause: string,
  importance: number,
): EmotionState {
  // Apply the impulse to current state
  const afterDelta = applyDelta(state, delta, cause);

  // Record in impulse_history
  const entry: ImpulseHistoryEntry = {
    delta,
    cause,
    importance,
    timestamp: now().toISOString(),
    tick_age: 0,
  };
  const newHistory = [...afterDelta.impulse_history, entry].slice(-MAX_IMPULSE_HISTORY);

  // Update momentum: blend new impulse into momentum (EMA with alpha=0.3)
  const alpha = 0.3;
  const newMomentum: EmotionMomentum = {
    valence: afterDelta.momentum.valence + ((delta.valence ?? 0) * alpha),
    arousal: afterDelta.momentum.arousal + ((delta.arousal ?? 0) * alpha),
    energy: afterDelta.momentum.energy + ((delta.energy ?? 0) * alpha),
    stress: afterDelta.momentum.stress + ((delta.stress ?? 0) * alpha),
    creativity: afterDelta.momentum.creativity + ((delta.creativity ?? 0) * alpha),
    sociability: afterDelta.momentum.sociability + ((delta.sociability ?? 0) * alpha),
    duration_ticks: afterDelta.momentum.duration_ticks,
  };

  return {
    ...afterDelta,
    impulse_history: newHistory,
    momentum: newMomentum,
  };
}

/**
 * Rumination: each tick, roll for each impulse_history entry to see if it's recalled.
 * Probability = (importance / 10) × 2^(-tick_age / 16) × (1 + resonance_bonus), capped at 0.3.
 * At most 1 rumination per tick. First hit stops the loop.
 * Returns updated state (with injected rumination impulse) and optional diary entry.
 */
export function rollRumination(
  state: EmotionState,
  rng: () => number = Math.random,
): { state: EmotionState; diaryEntry: string | null } {
  if (state.impulse_history.length === 0) {
    return { state, diaryEntry: null };
  }

  for (const entry of state.impulse_history) {
    const resonanceBonus = Math.sign(state.mood.valence) === Math.sign(entry.delta.valence ?? 0) ? 0.5 : 0;
    const prob = clamp(
      (entry.importance / 10) * Math.pow(2, -entry.tick_age / 16) * (1.0 + resonanceBonus),
      0,
      0.3,
    );

    if (rng() < prob) {
      // Rumination triggered: inject a decayed impulse
      const ruminationStrength = 0.3 + 0.2 * (entry.importance / 10);
      const ruminationDelta: EmotionDelta = {};
      if (entry.delta.valence !== undefined) ruminationDelta.valence = entry.delta.valence * ruminationStrength;
      if (entry.delta.arousal !== undefined) ruminationDelta.arousal = entry.delta.arousal * ruminationStrength;
      if (entry.delta.energy !== undefined) ruminationDelta.energy = entry.delta.energy * ruminationStrength;
      if (entry.delta.stress !== undefined) ruminationDelta.stress = entry.delta.stress * ruminationStrength;
      if (entry.delta.creativity !== undefined) ruminationDelta.creativity = entry.delta.creativity * ruminationStrength;
      if (entry.delta.sociability !== undefined) ruminationDelta.sociability = entry.delta.sociability * ruminationStrength;

      const updatedState = applyDelta(state, ruminationDelta, `反刍: ${entry.cause}`);
      const diary = `突然又想起了${entry.cause}的事...`;
      return { state: updatedState, diaryEntry: diary };
    }
  }

  return { state, diaryEntry: null };
}

/**
 * Check threshold break (Verisimilitude §1):
 * When stress > 0.6 for 3+ consecutive ticks, triggers an emotional explosion.
 * Returns updated state and optional diary entry.
 */
export function checkThresholdBreak(
  state: EmotionState,
): { state: EmotionState; diaryEntry: string | null } {
  // Update consecutive high stress counter
  const newConsecutive = state.stress > 0.6
    ? state.consecutive_high_stress + 1
    : 0;

  const updatedState = {
    ...state,
    consecutive_high_stress: newConsecutive,
  };

  // Check if threshold break should trigger
  if (newConsecutive < 3 || state.threshold_break_cooldown > 0) {
    return { state: updatedState, diaryEntry: null };
  }

  // Threshold break! Stress crashes, valence spikes in accumulated direction
  const valenceDirection = state.mood.valence >= 0 ? 1 : -1;
  const valenceShift = valenceDirection * 0.4;
  const newValence = clamp(state.mood.valence + valenceShift, -1.0, 1.0);
  const newArousal = clamp(state.mood.arousal + 0.3, 0, 1.0);

  const breakState: EmotionState = {
    ...updatedState,
    mood: {
      valence: newValence,
      arousal: newArousal,
      description: describeMood(newValence, newArousal, updatedState.energy, 0.2, updatedState.creativity),
    },
    stress: 0.2,
    consecutive_high_stress: 0,
    threshold_break_cooldown: 5,
    impulse_history: [
      ...updatedState.impulse_history,
      {
        delta: { valence: valenceShift, arousal: 0.3, stress: -(state.stress - 0.2) },
        cause: '情绪爆发',
        importance: 8,
        timestamp: now().toISOString(),
        tick_age: 0,
      },
    ].slice(-MAX_IMPULSE_HISTORY),
  };

  const diary = state.mood.valence >= 0
    ? '受不了了！！！压力太大了但是我要坚持！！'
    : '真的好烦！！！为什么每次都这样...';

  return { state: breakState, diaryEntry: diary };
}
