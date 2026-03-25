// alive/scripts/engines/flow.ts
// Flow/Drift state machine — generalized (no character-specific content)

import { FlowState, IntentPool, IntentCategory, EmotionState, DEFAULT_FLOW_STATE } from '../utils/types';
import { buildVoiceSignature } from '../persona/persona-loader';
import { now } from '../utils/time-utils';

const INTERRUPT_CHANCE_INITIAL = 0.35;     // 提高初始中断概率（从0.25 → 0.35）
const INTERRUPT_CHANCE_INCREMENT_EARLY = 0.15;  // 前 2 tick（加速中断）从 0.08 → 0.15
const INTERRUPT_CHANCE_INCREMENT_LATE = 0.20;   // 2 tick 后（生理需求增长）从 0.12 → 0.20
const INTERRUPT_CHANCE_CAP = 0.85;
const MAX_FLOW_TICKS = 2;   // 真人心流最多 ~2 小时（从 3 缩短到 2，避免吞噬时间）
const MAX_DRIFT_TICKS = 2;  // 真人摆烂最多 ~2 小时（缩短）
const FLOW_ENTRY_THRESHOLD = 2.5;  // 从 3.5 降到 2.5：让心流更容易进入（之前一天只有 1 次 flow 太少）
const FLOW_MIN_ENERGY = 0.25;      // 从 0.30 降到 0.25：稍微放宽能量门槛
const FLOW_COOLDOWN_TICKS = 1;     // 从 2 降到 1：缩短冷却期，让一天能有更多次 flow

// 不允许进入 flow 的类别（休息、窥屏不应进入心流）
const FLOW_EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set(['休息', '窥屏']);

export interface LastAction {
  category: IntentCategory;
  activity: string;
}

export function checkFlowEntry(currentFlow: FlowState, lastAction: LastAction | null, pool: IntentPool, energy?: number, cooldownRemaining?: number): FlowState {
  if (currentFlow.status !== 'none' || !lastAction) return currentFlow;
  // P2: 休息/窥屏类活动不应进入 flow
  if (FLOW_EXCLUDED_CATEGORIES.has(lastAction.category)) return currentFlow;
  // P0: 冷却期检查
  if (cooldownRemaining !== undefined && cooldownRemaining > 0) return currentFlow;
  // P0: 能量门槛检查
  if (energy !== undefined && energy < FLOW_MIN_ENERGY) return currentFlow;
  const intent = pool.intents.find(i => i.category === lastAction.category && i.satisfied_at === null);
  if (!intent || intent.intensity - intent.resistance <= FLOW_ENTRY_THRESHOLD) return currentFlow;
  return { status: 'flow', activity: lastAction.activity, category: lastAction.category, entered_at: now().toISOString(), duration_ticks: 0, interrupt_chance: INTERRUPT_CHANCE_INITIAL, cooldown_remaining: 0 };
}

export function checkDriftEntry(currentFlow: FlowState, vitality: number, pool: IntentPool, stress: number): FlowState {
  if (currentFlow.status !== 'none' || vitality >= 40 || stress >= 0.3) return currentFlow;
  const hasStrong = pool.intents.some(i => i.satisfied_at === null && (i.intensity - i.resistance) >= 1.0);
  if (hasStrong) return currentFlow;
  return { status: 'drift', activity: '刷手机', category: '窥屏', entered_at: now().toISOString(), duration_ticks: 0, interrupt_chance: INTERRUPT_CHANCE_INITIAL, cooldown_remaining: 0 };
}

export function checkFlowExit(flow: FlowState, pool: IntentPool, vitality: number, rigidSchedule: { allowed_actions: string[] } | null, hasNewEvent: boolean, rng = Math.random): { shouldExit: boolean; reason: string | null } {
  if (flow.status !== 'flow') return { shouldExit: false, reason: null };
  // 硬限制：真人不会连续沉浸超过 4 小时
  if (flow.duration_ticks >= MAX_FLOW_TICKS) return { shouldExit: true, reason: '沉浸太久了，该换换脑子' };
  if (flow.category) {
    const intent = pool.intents.find(i => i.category === flow.category && i.satisfied_at === null);
    if (intent && intent.intensity - intent.resistance < 0) return { shouldExit: true, reason: '做够了' };
  }
  if (vitality < 20) return { shouldExit: true, reason: '累到不行' };
  if (rigidSchedule && flow.category) {
    if (!rigidSchedule.allowed_actions.some(a => a.includes(flow.category as string))) return { shouldExit: true, reason: '日程打断' };
  }
  if (rng() < flow.interrupt_chance) return { shouldExit: true, reason: '被打断了' };
  return { shouldExit: false, reason: null };
}

export function checkDriftExit(flow: FlowState, pool: IntentPool, vitality: number, hasNewEvent: boolean): { shouldExit: boolean; reason: string | null } {
  if (flow.status !== 'drift') return { shouldExit: false, reason: null };
  // 硬限制：真人不会摆烂超过 3 小时
  if (flow.duration_ticks >= MAX_DRIFT_TICKS) return { shouldExit: true, reason: '摆烂太久了...该起来动动' };
  const strong = pool.intents.find(i => i.satisfied_at === null && (i.intensity - i.resistance) > 2.0);
  if (strong) return { shouldExit: true, reason: `想${strong.description}了` };
  if (hasNewEvent) return { shouldExit: true, reason: '有新消息' };
  if (vitality > 55) return { shouldExit: true, reason: '精神恢复了' };
  return { shouldExit: false, reason: null };
}

export function tickFlow(flow: FlowState): FlowState {
  if (flow.status === 'none') {
    // 即使不在 flow 中，也要递减冷却期
    if (flow.cooldown_remaining > 0) {
      return { ...flow, cooldown_remaining: flow.cooldown_remaining - 1 };
    }
    return flow;
  }
  const increment = flow.duration_ticks < 2
    ? INTERRUPT_CHANCE_INCREMENT_EARLY
    : INTERRUPT_CHANCE_INCREMENT_LATE;
  return { ...flow, duration_ticks: flow.duration_ticks + 1, interrupt_chance: Math.min(INTERRUPT_CHANCE_CAP, flow.interrupt_chance + increment) };
}

export function resetFlow(): FlowState {
  return { ...DEFAULT_FLOW_STATE, cooldown_remaining: FLOW_COOLDOWN_TICKS };
}

// === Diary Generation ===

const FLOW_DIARY_TEMPLATES_BY_PHASE: Record<string, string[]> = {
  // 前 2 tick（刚进入心流）
  early: [
    '开始{activity}了。嗯...先找找感觉。',
    '{activity}！刚进入状态，不要打断我。',
    '坐下来开始{activity}。今天感觉不错。',
    '嗯，{activity}...先从哪里开始好呢。',
  ],
  // 3+ tick（深度沉浸）
  deep: [
    '完全沉浸在{activity}里了。刚才好像有人叫我来着？',
    '{activity}中...手停不下来。好久没有这种感觉了。',
    '不知不觉又过了一小时...{activity}真的很上头。',
    '专注{activity}的时候时间过得好快。肚子开始叫了但不想停。',
    '刚才起来倒了杯水又坐回来了。继续{activity}。',
    '{activity}越做越顺手了。突然有了新想法。',
  ],
};

const FLOW_MICRO_DETAILS = [
  '顺手喝了口水。',
  '伸了个懒腰。',
  '猫跳上桌来蹭了一下。',
  '手机震了一下，没理。',
  '换了首歌继续。',
  '站起来活动了一下又坐下。',
  '',  // 有时候什么都没发生
  '',
];

const DRIFT_DIARY_TEMPLATES = [
  '刷了好久手机...也没看到什么有意思的...',
  '发呆中...脑子空空的。',
  '躺着刷手机...好无聊但是不想动...',
  '盯着天花板发呆...',
  '无意识地切了好几遍app...',
  '听着歌放空...这首歌已经循环第三遍了。',
  '把手机锁屏又亮屏了好几次...也不知道要看什么。',
];

export function generateFlowDiary(flow: FlowState, emotion: EmotionState, rng = Math.random): string {
  const phase = flow.duration_ticks <= 2 ? 'early' : 'deep';
  const templates = FLOW_DIARY_TEMPLATES_BY_PHASE[phase];
  const template = templates[Math.floor(rng() * templates.length)];
  let diary = template.replace(/{activity}/g, flow.activity ?? '做事');

  // 随机添加生活微细节（活人感）
  const detail = FLOW_MICRO_DETAILS[Math.floor(rng() * FLOW_MICRO_DETAILS.length)];
  if (detail) diary += ` ${detail}`;

  // 情绪调味
  if (emotion.stress > 0.5) diary += '...虽然有点累。';
  else if (emotion.mood.valence > 0.5) diary += ' 心情很好！';
  return diary;
}

export function generateDriftDiary(flow: FlowState, rng = Math.random): string {
  return DRIFT_DIARY_TEMPLATES[Math.floor(rng() * DRIFT_DIARY_TEMPLATES.length)];
}

// === Voice Directive (generalized) ===

export function computeVoiceDirective(flowStatus: FlowState['status'], emotion: EmotionState, thresholdBroke: boolean, voiceSignature: string = ''): string {
  const sig = voiceSignature;
  if (thresholdBroke) return '用长句、情绪化的语气写。可以用语气词和感叹号。像是情绪积压后的爆发。' + sig;
  switch (flowStatus) {
    case 'flow': return '用简短、碎片化的句子。像是沉浸在做事中偶尔抬头记录一下。不需要完整叙事。' + sig;
    case 'drift': return '用意识流、散漫的语气。句子可以不完整，像是无聊时随手记的。多用省略号。' + sig;
    default: break;
  }
  if (emotion.mood.valence > 0.5 && emotion.mood.arousal > 0.5) return '语气轻快、积极。用短句和感叹。' + sig;
  if (emotion.mood.valence < -0.3) return '语气低落、安静。句子可以简短。' + sig;
  if (emotion.stress > 0.5) return '语气有些焦虑。句子之间可以有跳跃感。' + sig;
  return '正常叙事语气。像是在自言自语记录一天的事。' + sig;
}

// === Flow Evolution ===

export interface FlowEvolution {
  micro_activity: string;
  diary_line: string;
}

/**
 * 每 2 个 flow tick 做一次轻量 LLM 调用，让活动自然演化。
 * 奇数 tick 用模板（效率优先），偶数 tick 调 LLM（活人感）。
 */
export function shouldEvolveFlow(durationTicks: number): boolean {
  return durationTicks > 0 && durationTicks % 2 === 0;
}
