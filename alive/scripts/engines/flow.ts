// alive/scripts/engines/flow.ts
// Flow/Drift state machine — generalized (no character-specific content)

import { FlowState, IntentPool, IntentCategory, EmotionState, DEFAULT_FLOW_STATE } from '../utils/types';
import { buildVoiceSignature } from '../persona/persona-loader';
import { now } from '../utils/time-utils';

const INTERRUPT_CHANCE_INITIAL = 0.15;
const INTERRUPT_CHANCE_INCREMENT = 0.03;
const INTERRUPT_CHANCE_CAP = 0.40;

export interface LastAction {
  category: IntentCategory;
  activity: string;
}

export function checkFlowEntry(currentFlow: FlowState, lastAction: LastAction | null, pool: IntentPool): FlowState {
  if (currentFlow.status !== 'none' || !lastAction) return currentFlow;
  const intent = pool.intents.find(i => i.category === lastAction.category && i.satisfied_at === null);
  if (!intent || intent.intensity - intent.resistance <= 2.0) return currentFlow;
  return { status: 'flow', activity: lastAction.activity, category: lastAction.category, entered_at: now().toISOString(), duration_ticks: 0, interrupt_chance: INTERRUPT_CHANCE_INITIAL };
}

export function checkDriftEntry(currentFlow: FlowState, vitality: number, pool: IntentPool, stress: number): FlowState {
  if (currentFlow.status !== 'none' || vitality >= 40 || stress >= 0.3) return currentFlow;
  const hasStrong = pool.intents.some(i => i.satisfied_at === null && (i.intensity - i.resistance) >= 1.0);
  if (hasStrong) return currentFlow;
  return { status: 'drift', activity: '刷手机', category: '窥屏', entered_at: now().toISOString(), duration_ticks: 0, interrupt_chance: INTERRUPT_CHANCE_INITIAL };
}

export function checkFlowExit(flow: FlowState, pool: IntentPool, vitality: number, rigidSchedule: { allowed_actions: string[] } | null, hasNewEvent: boolean, rng = Math.random): { shouldExit: boolean; reason: string | null } {
  if (flow.status !== 'flow') return { shouldExit: false, reason: null };
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
  const strong = pool.intents.find(i => i.satisfied_at === null && (i.intensity - i.resistance) > 2.0);
  if (strong) return { shouldExit: true, reason: `想${strong.description}了` };
  if (hasNewEvent) return { shouldExit: true, reason: '有新消息' };
  if (vitality > 55) return { shouldExit: true, reason: '精神恢复了' };
  return { shouldExit: false, reason: null };
}

export function tickFlow(flow: FlowState): FlowState {
  if (flow.status === 'none') return flow;
  return { ...flow, duration_ticks: flow.duration_ticks + 1, interrupt_chance: Math.min(INTERRUPT_CHANCE_CAP, flow.interrupt_chance + INTERRUPT_CHANCE_INCREMENT) };
}

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
  '盯着天花板发呆...',
  '无意识地切了好几遍app...',
  '听着歌放空...这首歌已经循环第三遍了。',
  '把手机锁屏又亮屏了好几次...也不知道要看什么。',
];

export function generateFlowDiary(flow: FlowState, emotion: EmotionState, rng = Math.random): string {
  const template = FLOW_DIARY_TEMPLATES[Math.floor(rng() * FLOW_DIARY_TEMPLATES.length)];
  let diary = template.replace(/{activity}/g, flow.activity ?? '做事');
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
