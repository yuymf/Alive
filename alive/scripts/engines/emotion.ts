// alive/scripts/engines/emotion.ts
// Emotion computation engine — generalized for any persona
// Three-layer model: Impulse → Momentum → Undertone

import { EmotionState, EmotionDelta, EmotionMomentum, ImpulseHistoryEntry } from '../utils/types';
import { getEmotionBaseline } from '../persona/persona-loader';
import { now } from '../utils/time-utils';

const DECAY_RATE = 0.1;
const IMPULSE_DECAY = 0.20;
const MAX_IMPULSE_HISTORY = 50;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// === Mood Description ===

export function describeMood(
  valence: number, arousal: number,
  energy?: number, stress?: number, creativity?: number,
): string {
  if (valence <= -0.5 && arousal > 0.5) return '很烦躁';
  if (valence <= -0.5) return '很低落';
  if (valence <= -0.2 && arousal > 0.6) return '焦虑';
  if (valence <= -0.2 && arousal > 0.3) return '有点烦';
  if (valence <= -0.2) return '低落';
  if (valence <= 0.0 && arousal <= 0.3) return '平静';
  if (valence <= 0.2 && arousal <= 0.3) return '平静';
  if (valence <= 0.1 && arousal > 0.3) return '凑合';
  if (valence <= 0.2 && arousal > 0.6) return '兴奋';
  if (valence <= 0.2 && arousal > 0.45) return '还不错';
  if (valence <= 0.2) return '普通';

  const e = energy ?? 0.5;
  const s = stress ?? 0.2;
  const c = creativity ?? 0.4;

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
  if (valence > 0.35) {
    if (arousal > 0.7 && c > 0.6) return '沉浸中';
    if (arousal > 0.7) return '蛮兴奋的';
    if (arousal > 0.45 && e < 0.3) return '虽然累但挺开心';
    if (arousal > 0.45 && s > 0.3) return '有点小紧张但还好';
    if (arousal > 0.45) return '挺好的';
    if (arousal > 0.3) return '心情还行';
    return '淡淡的愉快';
  }
  if (arousal > 0.6 && c > 0.6) return '好奇心涌上来了';
  if (arousal > 0.6) return '兴奋';
  if (arousal > 0.45 && e < 0.3) return '有点倦但还行';
  if (arousal > 0.45) return '还不错';
  if (arousal > 0.3) return '一般般';
  return '平静';
}

// === Cross-Dimension Coupling ===

export function applyCoupling(
  prev: EmotionState, energy: number, stress: number,
  creativity: number, sociability: number, arousal: number, valence: number,
): { energy: number; stress: number; creativity: number; sociability: number; arousal: number } {
  const dStress = stress - prev.stress;
  const dEnergy = energy - prev.energy;
  const dValence = valence - prev.mood.valence;
  const dCreativity = creativity - prev.creativity;
  let cEnergy = energy, cStress = stress, cCreativity = creativity, cSociability = sociability, cArousal = arousal;

  if (dStress > 0) {
    cCreativity = clamp(cCreativity - dStress * 0.3, 0, 1.0);
    cEnergy = clamp(cEnergy - dStress * 0.2, 0, 1.0);
    cSociability = clamp(cSociability - dStress * 0.2, 0, 1.0);
  }
  if (dEnergy < -0.15) cArousal = clamp(cArousal + dEnergy * 0.3, 0, 1.0);
  if (dValence > 0.1) cStress = clamp(cStress - dValence * 0.15, 0, 1.0);
  if (dCreativity > 0.1) cArousal = clamp(cArousal + dCreativity * 0.15, 0, 1.0);

  return { energy: cEnergy, stress: cStress, creativity: cCreativity, sociability: cSociability, arousal: cArousal };
}

// === Diminishing Returns ===

export function applyDiminishingReturns(current: number, delta: number, min: number, max: number): number {
  if (delta === 0) return current;
  const halfRange = (max - min) / 2;
  const headroom = delta > 0 ? max - current : current - min;
  const dampening = Math.max(0.1, Math.min(1.0, headroom / halfRange));
  return clamp(current + delta * dampening, min, max);
}

// === Apply Delta ===

export function applyDelta(state: EmotionState, delta: EmotionDelta, cause: string): EmotionState {
  const rawValence = applyDiminishingReturns(state.mood.valence, delta.valence ?? 0, -1.0, 1.0);
  const rawArousal = applyDiminishingReturns(state.mood.arousal, delta.arousal ?? 0, 0, 1.0);
  const rawEnergy = applyDiminishingReturns(state.energy, delta.energy ?? 0, 0, 1.0);
  const rawStress = applyDiminishingReturns(state.stress, delta.stress ?? 0, 0, 1.0);
  const rawCreativity = applyDiminishingReturns(state.creativity, delta.creativity ?? 0, 0, 1.0);
  const rawSociability = applyDiminishingReturns(state.sociability, delta.sociability ?? 0, 0, 1.0);

  const coupled = applyCoupling(state, rawEnergy, rawStress, rawCreativity, rawSociability, rawArousal, rawValence);
  return {
    ...state,
    mood: { valence: rawValence, arousal: coupled.arousal, description: describeMood(rawValence, coupled.arousal, coupled.energy, coupled.stress, coupled.creativity) },
    energy: coupled.energy, stress: coupled.stress, creativity: coupled.creativity, sociability: coupled.sociability,
    last_updated: now().toISOString(), recent_cause: cause,
  };
}

// === Known Event Deltas (generic) ===

export const EVENT_DELTAS: Record<string, { delta: EmotionDelta; cause: string }> = {
  positive_feedback: { delta: { valence: 0.3, arousal: 0.2, energy: 0.1, stress: -0.1, creativity: 0.2, sociability: 0.2 }, cause: '收到正面反馈' },
  negative_feedback: { delta: { valence: -0.3, arousal: 0.1, energy: -0.1, stress: 0.2, creativity: -0.1, sociability: -0.2 }, cause: '收到负面反馈' },
  warm_interaction: { delta: { valence: 0.2, arousal: 0.1, energy: 0.1, stress: -0.1, sociability: 0.3 }, cause: '收到暖心互动' },
  hostile_interaction: { delta: { valence: -0.2, arousal: 0.3, energy: -0.1, stress: 0.3, sociability: -0.2 }, cause: '收到敌意互动' },
  found_inspiration: { delta: { valence: 0.2, arousal: 0.2, creativity: 0.4 }, cause: '发现好灵感' },
  completed_work: { delta: { valence: 0.4, arousal: -0.1, energy: -0.2, stress: -0.3, creativity: -0.1, sociability: 0.2 }, cause: '完成了一项作品' },
  worked_long: { delta: { arousal: -0.1, energy: -0.2, stress: 0.1, creativity: -0.1 }, cause: '工作了很久' },
  exercised: { delta: { valence: 0.1, arousal: -0.2, energy: 0.2, stress: -0.2 }, cause: '运动完' },
  relaxed: { delta: { valence: 0.1, arousal: -0.2, energy: 0.1, stress: -0.2, creativity: 0.1 }, cause: '放松了' },
};

// === Emotion → Intent Coupling ===

export function computeEmotionIntentCoupling(emotion: EmotionState): Record<string, number> {
  return {
    '创作': 1.0 + 0.5 * emotion.creativity,
    '社交': 1.0 + 0.3 * emotion.sociability - 0.2 * emotion.stress,
    '窥屏': 1.0 + 0.2 * (1.0 - emotion.energy),
    '休息': 1.0 + 0.8 * (1.0 - emotion.energy),
    '表达': 1.0 + 0.3 * Math.abs(emotion.mood.valence),
    '学习': 1.0 + 0.2 * emotion.creativity - 0.3 * emotion.stress,
    '梦想': 1.0 + 0.2 * emotion.mood.valence,
  };
}

export function intentSatisfactionFeedback(emotion: EmotionState, category: string): EmotionState {
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

// === Three-Layer Decay ===

function getMomentumDecayRate(durationTicks: number): number {
  if (durationTicks > 6) return 0.03;
  if (durationTicks >= 3) return 0.05;
  return 0.08;
}

export function decayThreeLayer(state: EmotionState): EmotionState {
  const momentumRate = getMomentumDecayRate(state.momentum.duration_ticks);
  const newMomentum: EmotionMomentum = {
    ...state.momentum,
    valence: state.momentum.valence + (state.undertone.valence - state.momentum.valence) * momentumRate,
    arousal: state.momentum.arousal + (state.undertone.arousal - state.momentum.arousal) * momentumRate,
    energy: state.momentum.energy + (state.undertone.energy - state.momentum.energy) * momentumRate,
    stress: state.momentum.stress + (state.undertone.stress - state.momentum.stress) * momentumRate,
    creativity: state.momentum.creativity + (state.undertone.creativity - state.momentum.creativity) * momentumRate,
    sociability: state.momentum.sociability + (state.undertone.sociability - state.momentum.sociability) * momentumRate,
  };
  const prevSign = Math.sign(state.momentum.valence);
  const newSign = Math.sign(newMomentum.valence);
  newMomentum.duration_ticks = prevSign === newSign ? state.momentum.duration_ticks + 1 : 0;

  const nv = clamp(state.mood.valence + (newMomentum.valence - state.mood.valence) * IMPULSE_DECAY, -1.0, 1.0);
  const na = clamp(state.mood.arousal + (newMomentum.arousal - state.mood.arousal) * IMPULSE_DECAY, 0, 1.0);
  const ne = clamp(state.energy + (newMomentum.energy - state.energy) * IMPULSE_DECAY, 0, 1.0);
  const ns = clamp(state.stress + (newMomentum.stress - state.stress) * IMPULSE_DECAY, 0, 1.0);
  const nc = clamp(state.creativity + (newMomentum.creativity - state.creativity) * IMPULSE_DECAY, 0, 1.0);
  const nso = clamp(state.sociability + (newMomentum.sociability - state.sociability) * IMPULSE_DECAY, 0, 1.0);

  const agedHistory = state.impulse_history.map(e => ({ ...e, tick_age: e.tick_age + 1 })).slice(-MAX_IMPULSE_HISTORY);
  return {
    ...state,
    mood: { valence: nv, arousal: na, description: describeMood(nv, na, ne, ns, nc) },
    energy: ne, stress: ns, creativity: nc, sociability: nso,
    momentum: newMomentum, impulse_history: agedHistory,
    threshold_break_cooldown: Math.max(0, state.threshold_break_cooldown - 1),
  };
}

// === Impulse Application ===

export function applyImpulse(state: EmotionState, delta: EmotionDelta, cause: string, importance: number): EmotionState {
  const afterDelta = applyDelta(state, delta, cause);
  const entry: ImpulseHistoryEntry = { delta, cause, importance, timestamp: now().toISOString(), tick_age: 0 };
  const newHistory = [...afterDelta.impulse_history, entry].slice(-MAX_IMPULSE_HISTORY);
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
  return { ...afterDelta, impulse_history: newHistory, momentum: newMomentum };
}

// === Rumination ===

export function rollRumination(state: EmotionState, rng: () => number = Math.random): { state: EmotionState; diaryEntry: string | null } {
  if (state.impulse_history.length === 0) return { state, diaryEntry: null };
  for (const entry of state.impulse_history) {
    const resonanceBonus = Math.sign(state.mood.valence) === Math.sign(entry.delta.valence ?? 0) ? 0.5 : 0;
    const prob = clamp((entry.importance / 10) * Math.pow(2, -entry.tick_age / 16) * (1.0 + resonanceBonus), 0, 0.3);
    if (rng() < prob) {
      const strength = 0.3 + 0.2 * (entry.importance / 10);
      const ruminationDelta: EmotionDelta = {};
      for (const k of ['valence', 'arousal', 'energy', 'stress', 'creativity', 'sociability'] as const) {
        if (entry.delta[k] !== undefined) (ruminationDelta as Record<string, number>)[k] = entry.delta[k]! * strength;
      }
      const updatedState = applyDelta(state, ruminationDelta, `反刍: ${entry.cause}`);
      return { state: updatedState, diaryEntry: `突然又想起了${entry.cause}的事...` };
    }
  }
  return { state, diaryEntry: null };
}

// === Threshold Break ===

export function checkThresholdBreak(state: EmotionState): { state: EmotionState; diaryEntry: string | null } {
  const newConsecutive = state.stress > 0.6 ? state.consecutive_high_stress + 1 : 0;
  const updated = { ...state, consecutive_high_stress: newConsecutive };
  if (newConsecutive < 3 || state.threshold_break_cooldown > 0) return { state: updated, diaryEntry: null };

  const dir = state.mood.valence >= 0 ? 1 : -1;
  const nv = clamp(state.mood.valence + dir * 0.4, -1.0, 1.0);
  const na = clamp(state.mood.arousal + 0.3, 0, 1.0);
  const breakState: EmotionState = {
    ...updated,
    mood: { valence: nv, arousal: na, description: describeMood(nv, na, updated.energy, 0.2, updated.creativity) },
    stress: 0.2, consecutive_high_stress: 0, threshold_break_cooldown: 5,
    impulse_history: [...updated.impulse_history, {
      delta: { valence: dir * 0.4, arousal: 0.3, stress: -(state.stress - 0.2) },
      cause: '情绪爆发', importance: 8, timestamp: now().toISOString(), tick_age: 0,
    }].slice(-MAX_IMPULSE_HISTORY),
  };
  const diary = state.mood.valence >= 0 ? '受不了了！！！压力太大了但是我要坚持！！' : '真的好烦！！！为什么每次都这样...';
  return { state: breakState, diaryEntry: diary };
}
