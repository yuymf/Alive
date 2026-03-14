// skill/scripts/flow-engine.ts
// Flow/Drift state machine (Verisimilitude §2)

import {
  FlowState, IntentPool, IntentCategory, EmotionState,
  DEFAULT_FLOW_STATE,
} from './types';
import { now } from './time-utils';

const INTERRUPT_CHANCE_INITIAL = 0.15;
const INTERRUPT_CHANCE_INCREMENT = 0.03;
const INTERRUPT_CHANCE_CAP = 0.40;

// === Flow Entry/Exit ===

export interface LastAction {
  category: IntentCategory;
  activity: string;
}

/**
 * Check if we should enter flow state.
 * Condition: last action's intent has intensity - resistance > 2.0
 * and we're not already in flow/drift.
 */
export function checkFlowEntry(
  currentFlow: FlowState,
  lastAction: LastAction | null,
  pool: IntentPool,
): FlowState {
  if (currentFlow.status !== 'none') return currentFlow;
  if (!lastAction) return currentFlow;

  const intent = pool.intents.find(
    i => i.category === lastAction.category && i.satisfied_at === null,
  );
  if (!intent) return currentFlow;

  const margin = intent.intensity - intent.resistance;
  if (margin <= 2.0) return currentFlow;

  return {
    status: 'flow',
    activity: lastAction.activity,
    category: lastAction.category,
    entered_at: now().toISOString(),
    duration_ticks: 0,
    interrupt_chance: INTERRUPT_CHANCE_INITIAL,
  };
}

/**
 * Check if we should enter drift state.
 * Conditions: vitality < 40 AND no intent has intensity - resistance >= 1.0 AND stress < 0.3.
 */
export function checkDriftEntry(
  currentFlow: FlowState,
  vitality: number,
  pool: IntentPool,
  stress: number,
): FlowState {
  if (currentFlow.status !== 'none') return currentFlow;
  if (vitality >= 40) return currentFlow;
  if (stress >= 0.3) return currentFlow;

  const hasStrongIntent = pool.intents.some(
    i => i.satisfied_at === null && (i.intensity - i.resistance) >= 1.0,
  );
  if (hasStrongIntent) return currentFlow;

  return {
    status: 'drift',
    activity: '刷手机',
    category: '窥屏',
    entered_at: now().toISOString(),
    duration_ticks: 0,
    interrupt_chance: INTERRUPT_CHANCE_INITIAL,
  };
}

/**
 * Check if we should exit flow state.
 * 4 exit conditions:
 * 1. Intent intensity - resistance < 0 (threshold gap closed)
 * 2. Vitality < 20
 * 3. Rigid schedule blocks the flow category
 * 4. Random interrupt (rng < interrupt_chance)
 */
export function checkFlowExit(
  flow: FlowState,
  pool: IntentPool,
  vitality: number,
  rigidSchedule: { allowed_actions: string[] } | null,
  hasNewEvent: boolean,
  rng: () => number = Math.random,
): { shouldExit: boolean; reason: string | null } {
  if (flow.status !== 'flow') return { shouldExit: false, reason: null };

  // Condition 1: intent gap closed
  if (flow.category) {
    const intent = pool.intents.find(
      i => i.category === flow.category && i.satisfied_at === null,
    );
    if (intent && intent.intensity - intent.resistance < 0) {
      return { shouldExit: true, reason: '做够了' };
    }
  }

  // Condition 2: vitality too low
  if (vitality < 20) {
    return { shouldExit: true, reason: '累到不行' };
  }

  // Condition 3: rigid schedule blocks current category
  if (rigidSchedule && flow.category) {
    const categoryStr = flow.category as string;
    if (!rigidSchedule.allowed_actions.some(a => a.includes(categoryStr))) {
      return { shouldExit: true, reason: '日程打断' };
    }
  }

  // Condition 4: random interrupt
  if (rng() < flow.interrupt_chance) {
    return { shouldExit: true, reason: '被打断了' };
  }

  return { shouldExit: false, reason: null };
}

/**
 * Check if we should exit drift state.
 * 3 exit conditions:
 * 1. Any intent has intensity - resistance > 2.0
 * 2. New external event arrived
 * 3. Vitality recovered to > 55
 */
export function checkDriftExit(
  flow: FlowState,
  pool: IntentPool,
  vitality: number,
  hasNewEvent: boolean,
): { shouldExit: boolean; reason: string | null } {
  if (flow.status !== 'drift') return { shouldExit: false, reason: null };

  // Condition 1: strong intent emerged
  const strongIntent = pool.intents.find(
    i => i.satisfied_at === null && (i.intensity - i.resistance) > 2.0,
  );
  if (strongIntent) {
    return { shouldExit: true, reason: `想${strongIntent.description}了` };
  }

  // Condition 2: new event
  if (hasNewEvent) {
    return { shouldExit: true, reason: '有新消息' };
  }

  // Condition 3: vitality recovered
  if (vitality > 55) {
    return { shouldExit: true, reason: '精神恢复了' };
  }

  return { shouldExit: false, reason: null };
}

// === Flow Tick ===

/**
 * Advance flow/drift by one tick: increment duration_ticks and interrupt_chance.
 */
export function tickFlow(flow: FlowState): FlowState {
  if (flow.status === 'none') return flow;

  return {
    ...flow,
    duration_ticks: flow.duration_ticks + 1,
    interrupt_chance: Math.min(
      INTERRUPT_CHANCE_CAP,
      flow.interrupt_chance + INTERRUPT_CHANCE_INCREMENT,
    ),
  };
}

/**
 * Reset flow state to none.
 */
export function resetFlow(): FlowState {
  return { ...DEFAULT_FLOW_STATE };
}

// === Diary Generation ===

const FLOW_DIARY_TEMPLATES = [
  '还在{activity}。不知不觉又过了一小时。',
  '{activity}中...时间过得好快。',
  '专注{activity}的感觉真好。',
  '继续{activity}。渐入佳境了。',
  '沉浸在{activity}里出不来了。',
];

const DRIFT_DIARY_TEMPLATES = [
  '刷了好久手机...也没看到什么有意思的...',
  '发呆中...脑子空空的。',
  '躺着刷手机...好无聊但是不想动...',
  '看了一圈朋友圈...没什么新鲜事。',
  '盯着天花板发呆...',
];

/**
 * Generate a diary entry for flow state.
 */
export function generateFlowDiary(
  flow: FlowState,
  emotion: EmotionState,
  rng: () => number = Math.random,
): string {
  const template = FLOW_DIARY_TEMPLATES[Math.floor(rng() * FLOW_DIARY_TEMPLATES.length)];
  const activity = flow.activity ?? '做事';
  let diary = template.replace(/{activity}/g, activity);

  // Add emotion color if notable
  if (emotion.stress > 0.5) {
    diary += '...虽然有点累。';
  } else if (emotion.mood.valence > 0.5) {
    diary += ' 心情很好！';
  }

  return diary;
}

/**
 * Generate a diary entry for drift state.
 */
export function generateDriftDiary(
  flow: FlowState,
  rng: () => number = Math.random,
): string {
  return DRIFT_DIARY_TEMPLATES[Math.floor(rng() * DRIFT_DIARY_TEMPLATES.length)];
}

// === Voice Directive ===

const CHARACTER_VOICE_SIGNATURE = `
你是18岁ESTP coser水瀬。口语化、带日语口癖：sugoi/すごい、kawaii/かわいい、yabai/やばい、maji/まじ、nani/なに、ganba/がんば。
常用：哈哈哈哈（兴奋）、等等（反应不过来）、对对对（共鸣）、啊啊啊（崩溃或激动）。感叹号随便用但不是每句。偶尔自我吐槽。
禁止：客服腔（"当然！""好的！"）、AI腔（"我理解您的..."）、过于正式的书面语。`;

/**
 * Compute the voice directive string that controls diary writing style.
 * Used as a template parameter in simulated-action.md.
 */
export function computeVoiceDirective(
  flowStatus: FlowState['status'],
  emotion: EmotionState,
  thresholdBroke: boolean,
): string {
  if (thresholdBroke) {
    return '用长句、情绪化的语气写。可以用语气词和感叹号。像是情绪积压后的爆发。' + CHARACTER_VOICE_SIGNATURE;
  }

  switch (flowStatus) {
    case 'flow':
      return '用简短、碎片化的句子。像是沉浸在做事中偶尔抬头记录一下。不需要完整叙事。' + CHARACTER_VOICE_SIGNATURE;
    case 'drift':
      return '用意识流、散漫的语气。句子可以不完整，像是无聊时随手记的。多用省略号。' + CHARACTER_VOICE_SIGNATURE;
    default:
      break;
  }

  // Normal state: adjust by emotion
  if (emotion.mood.valence > 0.5 && emotion.mood.arousal > 0.5) {
    return '语气轻快、积极。用短句和感叹。' + CHARACTER_VOICE_SIGNATURE;
  }
  if (emotion.mood.valence < -0.3) {
    return '语气低落、安静。句子可以简短。' + CHARACTER_VOICE_SIGNATURE;
  }
  if (emotion.stress > 0.5) {
    return '语气有些焦虑。句子之间可以有跳跃感。' + CHARACTER_VOICE_SIGNATURE;
  }

  return '正常叙事语气。像是在自言自语记录一天的事。' + CHARACTER_VOICE_SIGNATURE;
}
