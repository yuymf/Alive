// skill/scripts/random-events.ts
// Stochastic perturbation system — injects "life happens" randomness
// (Verisimilitude §4: context-aware events with preconditions, dynamic weights, chain events)

import {
  RandomEvent, RandomEventDef, EmotionDelta, EmotionState,
  IntentCategory, PendingChainEvent, ChainAndCooldownState,
  VitalityState, FlowState,
} from './types';
import { now } from './time-utils';

// === Extended Event Pool ===

const EVENT_POOL: RandomEventDef[] = [
  // Original 12 events, now with preconditions + chain events
  {
    description: '突然想起一个很喜欢的角色',
    emotion_delta: { valence: 0.2, creativity: 0.3, arousal: 0.2 },
    intent_boosts: [{ category: '创作', boost: 3.0 }],
    diary_entry: '刷手机的时候突然看到一张图，想起了好久没有cos的角色...好想再试试',
    preconditions: { excludes_flow: true },
    weight_modifiers: { dimension_boost: 'creativity' },
  },
  {
    description: '看到一个很有趣的评论',
    emotion_delta: { valence: 0.15, sociability: 0.2, arousal: 0.1 },
    intent_boosts: [{ category: '社交', boost: 2.0 }],
    diary_entry: '有个粉丝的评论也太好笑了吧哈哈哈哈哈',
    preconditions: {},
    weight_modifiers: { dimension_boost: 'sociability' },
  },
  {
    description: '天气特别好',
    emotion_delta: { valence: 0.1, energy: 0.15, creativity: 0.1 },
    intent_boosts: [{ category: '创作', boost: 1.0 }, { category: '表达', boost: 1.0 }],
    diary_entry: '今天天气好好！想出去拍点什么',
    preconditions: { excludes_schedule: '上班' },
    weight_modifiers: {},
  },
  {
    description: '工作上遇到烦心事',
    emotion_delta: { valence: -0.2, stress: 0.3, energy: -0.1 },
    intent_boosts: [{ category: '休息', boost: 2.0 }],
    diary_entry: '今天工作好烦...需要做点开心的事来转换心情',
    preconditions: { requires_schedule: '上班' },
    weight_modifiers: {},
    chain_events: [
      {
        description: '下班后工作余波',
        probability: 0.6,
        delay_ticks: [4, 8],
        emotion_delta: { valence: -0.1, stress: 0.15 },
        intent_boosts: [{ category: '休息', boost: 1.5 }],
        diary_entry: '下班了但是心情还是不太好...工作的事一直在脑子里转',
      },
      {
        description: '睡前工作反刍',
        probability: 0.3,
        delay_ticks: [8, 14],
        emotion_delta: { valence: -0.15, stress: 0.2, arousal: 0.1 },
        intent_boosts: [{ category: '休息', boost: 1.0 }],
        diary_entry: '躺在床上又开始想白天工作的事了...烦死了',
      },
    ],
  },
  {
    description: '灵感枯竭期',
    emotion_delta: { creativity: -0.2, valence: -0.1 },
    intent_boosts: [{ category: '窥屏', boost: 2.0 }, { category: '学习', boost: 1.0 }],
    diary_entry: '最近好像没什么灵感...去刷刷别人的作品找找感觉吧',
    preconditions: {},
    weight_modifiers: { vitality_inverse: true },
  },
  {
    description: '收到同好的私信鼓励',
    emotion_delta: { valence: 0.25, sociability: 0.3, energy: 0.1 },
    intent_boosts: [{ category: '社交', boost: 2.5 }, { category: '表达', boost: 1.0 }],
    diary_entry: '有个同好给我发了好暖的私信...这种时候觉得做cos真的很值得',
    preconditions: {},
    weight_modifiers: { dimension_boost: 'sociability' },
    chain_events: [
      {
        description: '聊了很久停不下来',
        probability: 0.5,
        delay_ticks: [1, 2],
        emotion_delta: { valence: 0.1, sociability: 0.2, energy: -0.1 },
        intent_boosts: [{ category: '社交', boost: 2.0 }],
        diary_entry: '和同好聊了好久停不下来...虽然有点累但是超开心',
      },
    ],
  },
  {
    description: '刷到一个新番预告',
    emotion_delta: { valence: 0.15, arousal: 0.2, creativity: 0.2 },
    intent_boosts: [{ category: '创作', boost: 1.5 }, { category: '梦想', boost: 1.0 }],
    diary_entry: '新番预告也太绝了吧！！已经开始想cos谁了',
    preconditions: {},
    weight_modifiers: { dimension_boost: 'creativity' },
  },
  {
    description: '身体有点不舒服',
    emotion_delta: { energy: -0.25, valence: -0.1, arousal: -0.2 },
    intent_boosts: [{ category: '休息', boost: 4.0 }],
    diary_entry: '今天身体有点不舒服...还是安静待着吧',
    preconditions: { max_vitality: 50 },
    weight_modifiers: { vitality_inverse: true },
  },
  {
    description: '看到其他coser的神仙作品',
    emotion_delta: { valence: 0.1, arousal: 0.15, creativity: 0.2, stress: 0.1 },
    intent_boosts: [{ category: '创作', boost: 2.0 }, { category: '学习', boost: 1.5 }],
    diary_entry: '看到大佬的作品...差距好大但是好想追上啊',
    preconditions: { requires_recent_action: '窥屏' },
    weight_modifiers: { dimension_boost: 'creativity' },
    chain_events: [
      {
        description: '忍不住研究技法',
        probability: 0.4,
        delay_ticks: [1, 3],
        emotion_delta: { creativity: 0.15, arousal: 0.1, energy: -0.05 },
        intent_boosts: [{ category: '学习', boost: 2.0 }],
        diary_entry: '开始研究大佬的构图和后期了...越看越有意思',
      },
      {
        description: '越看越焦虑',
        probability: 0.2,
        delay_ticks: [2, 4],
        emotion_delta: { valence: -0.15, stress: 0.2, creativity: -0.1 },
        intent_boosts: [{ category: '休息', boost: 1.0 }],
        diary_entry: '看了太多大佬的作品...感觉差距好大好焦虑',
      },
    ],
  },
  {
    description: '突然很想吃好吃的',
    emotion_delta: { valence: 0.05, sociability: 0.1 },
    intent_boosts: [{ category: '表达', boost: 0.5 }],
    diary_entry: '好想吃火锅...谁来一起啊aaaa',
    preconditions: {},
    weight_modifiers: {},
  },
  {
    description: '漫展即将到来',
    emotion_delta: { valence: 0.3, arousal: 0.3, creativity: 0.3, energy: 0.1 },
    intent_boosts: [{ category: '创作', boost: 3.0 }, { category: '梦想', boost: 2.0 }],
    diary_entry: '漫展快到了！必须要准备新的cos才行！',
    preconditions: { global_cooldown_days: 30 },
    weight_modifiers: {},
    chain_events: [
      {
        description: '盘算要cos谁',
        probability: 0.7,
        delay_ticks: [1, 2],
        emotion_delta: { creativity: 0.2, arousal: 0.1, valence: 0.1 },
        intent_boosts: [{ category: '创作', boost: 2.0 }, { category: '梦想', boost: 1.5 }],
        diary_entry: '开始盘算漫展要cos谁了...好纠结啊有好多想试的',
      },
      {
        description: '算预算有点慌',
        probability: 0.5,
        delay_ticks: [3, 5],
        emotion_delta: { stress: 0.2, valence: -0.1 },
        intent_boosts: [{ category: '休息', boost: 0.5 }],
        diary_entry: '算了一下漫展要花多少钱...有点慌',
      },
    ],
  },
  {
    description: '和朋友聊了很久',
    emotion_delta: { valence: 0.1, sociability: 0.2, energy: -0.1, stress: -0.2 },
    intent_boosts: [{ category: '社交', boost: 1.0 }],
    diary_entry: '和朋友聊了好久...虽然有点累但是心情好了很多',
    preconditions: {},
    weight_modifiers: { dimension_boost: 'sociability' },
  },

  // === New events (Verisimilitude §4) ===

  // Time awareness
  {
    description: '突然发现已经这个点了',
    emotion_delta: { arousal: 0.15, stress: 0.1 },
    intent_boosts: [{ category: '休息', boost: 0.5 }],
    diary_entry: '抬头一看时间...已经这个点了？？时间过得也太快了吧',
    preconditions: {},
    weight_modifiers: {},
  },
  {
    description: '感觉今天过得好慢',
    emotion_delta: { valence: -0.05, arousal: -0.1, energy: -0.05 },
    intent_boosts: [{ category: '窥屏', boost: 1.0 }],
    diary_entry: '感觉今天过得好慢...时间怎么走得这么慢',
    preconditions: {},
    weight_modifiers: { vitality_inverse: true },
  },

  // Small life details
  {
    description: '外卖到了',
    emotion_delta: { valence: 0.1, energy: 0.05, arousal: 0.05 },
    intent_boosts: [{ category: '休息', boost: 0.5 }],
    diary_entry: '外卖到了！终于可以吃饭了',
    preconditions: {},
    weight_modifiers: {},
  },
  {
    description: '手机快没电了',
    emotion_delta: { stress: 0.1, arousal: 0.05 },
    intent_boosts: [{ category: '休息', boost: 0.3 }],
    diary_entry: '手机快没电了...先找个地方充电',
    preconditions: {},
    weight_modifiers: {},
  },
  {
    description: '楼下在装修好吵',
    emotion_delta: { stress: 0.15, valence: -0.1, arousal: 0.1 },
    intent_boosts: [{ category: '休息', boost: 1.0 }],
    diary_entry: '楼下又在装修了...好吵啊根本没法集中注意力',
    preconditions: { excludes_schedule: '上班' },
    weight_modifiers: {},
  },

  // Social media
  {
    description: '看到让人不舒服的热搜',
    emotion_delta: { valence: -0.15, stress: 0.15, arousal: 0.2 },
    intent_boosts: [{ category: '表达', boost: 1.5 }, { category: '窥屏', boost: 0.5 }],
    diary_entry: '刷到一条让人很不舒服的热搜...不想看但是又忍不住点进去了',
    preconditions: {},
    weight_modifiers: { emotion_resonance: true },
  },
  {
    description: '刷到很有创意的短视频',
    emotion_delta: { valence: 0.1, creativity: 0.2, arousal: 0.1 },
    intent_boosts: [{ category: '创作', boost: 1.5 }, { category: '学习', boost: 1.0 }],
    diary_entry: '刷到一个超有创意的视频...好厉害啊我也想试试这种风格',
    preconditions: {},
    weight_modifiers: { dimension_boost: 'creativity' },
  },

  // Micro-mood events
  {
    description: '听到一首喜欢的歌',
    emotion_delta: { valence: 0.15, arousal: 0.1, creativity: 0.1 },
    intent_boosts: [{ category: '表达', boost: 1.0 }],
    diary_entry: '突然听到一首好好听的歌...单曲循环中',
    preconditions: {},
    weight_modifiers: {},
  },
  {
    description: '收到快递',
    emotion_delta: { valence: 0.1, arousal: 0.1, energy: 0.05 },
    intent_boosts: [{ category: '表达', boost: 0.5 }],
    diary_entry: '快递到了！拆快递的时候总是很开心',
    preconditions: {},
    weight_modifiers: {},
  },
];

export { EVENT_POOL };

// === Context-aware event selection ===

export interface EventContext {
  emotion: EmotionState;
  vitality: VitalityState;
  flow: FlowState;
  currentSchedule: string | null;
  recentActions: string[];
  cooldowns: Record<string, string>;
}

function checkPreconditions(event: RandomEventDef, ctx: EventContext): boolean {
  const p = event.preconditions;

  if (p.requires_schedule && ctx.currentSchedule !== p.requires_schedule) return false;
  if (p.excludes_schedule && ctx.currentSchedule === p.excludes_schedule) return false;
  if (p.min_vitality !== undefined && ctx.vitality.vitality < p.min_vitality) return false;
  if (p.max_vitality !== undefined && ctx.vitality.vitality > p.max_vitality) return false;
  if (p.excludes_flow && ctx.flow.status === 'flow') return false;

  if (p.requires_recent_action) {
    if (!ctx.recentActions.some(a => a.includes(p.requires_recent_action!))) return false;
  }

  if (p.global_cooldown_days) {
    const lastTriggered = ctx.cooldowns[event.description];
    if (lastTriggered) {
      const daysSince = (now().getTime() - new Date(lastTriggered).getTime()) / (86400000);
      if (daysSince < p.global_cooldown_days) return false;
    }
  }

  return true;
}

function computeWeight(event: RandomEventDef, ctx: EventContext): number {
  let weight = 1.0;
  const wm = event.weight_modifiers;

  if (wm.emotion_resonance) {
    // Event and current emotion share direction
    const eventValence = event.emotion_delta.valence ?? 0;
    const currentValence = ctx.emotion.mood.valence;
    if (Math.sign(eventValence) === Math.sign(currentValence) && currentValence !== 0) {
      weight *= 1.5;
    }
  }

  if (wm.vitality_inverse) {
    // Low vitality boosts this event
    if (ctx.vitality.vitality < 40) weight *= 2.0;
  }

  if (wm.dimension_boost) {
    const dim = wm.dimension_boost;
    const dimValue = dim === 'valence' ? ctx.emotion.mood.valence
      : dim === 'arousal' ? ctx.emotion.mood.arousal
      : dim === 'energy' ? ctx.emotion.energy
      : dim === 'stress' ? ctx.emotion.stress
      : dim === 'creativity' ? ctx.emotion.creativity
      : dim === 'sociability' ? ctx.emotion.sociability
      : 0;
    if (dimValue > 0.5) weight *= 2.0;
  }

  return weight;
}

function weightedRandomSelect(pool: Array<{ event: RandomEventDef; weight: number }>, rng: () => number): RandomEventDef {
  const totalWeight = pool.reduce((sum, e) => sum + e.weight, 0);
  let roll = rng() * totalWeight;
  for (const entry of pool) {
    roll -= entry.weight;
    if (roll <= 0) return entry.event;
  }
  return pool[pool.length - 1].event;
}

/**
 * Roll for a context-aware random event (Verisimilitude §4).
 * Filters by preconditions, applies dynamic weights, returns event + pending chain events.
 */
export function rollContextAwareEvent(
  ctx: EventContext,
  options?: { probability?: number; rng?: () => number },
): { event: RandomEvent | null; newChainEvents: PendingChainEvent[] } {
  const prob = options?.probability ?? 0.10;
  const rng = options?.rng ?? Math.random;

  if (rng() > prob) return { event: null, newChainEvents: [] };

  // Filter by preconditions
  const eligible = EVENT_POOL
    .map(e => ({ event: e, weight: computeWeight(e, ctx) }))
    .filter(e => checkPreconditions(e.event, ctx));

  if (eligible.length === 0) return { event: null, newChainEvents: [] };

  const selected = weightedRandomSelect(eligible, rng);

  const event: RandomEvent = {
    id: `rnd_${now().getTime()}_${rng().toString(36).slice(2, 6)}`,
    description: selected.description,
    emotion_delta: selected.emotion_delta,
    intent_boosts: selected.intent_boosts,
    diary_entry: selected.diary_entry,
  };

  // Generate chain events
  const newChainEvents: PendingChainEvent[] = [];
  if (selected.chain_events) {
    for (const chain of selected.chain_events) {
      if (rng() < chain.probability) {
        const delay = chain.delay_ticks[0] + Math.floor(rng() * (chain.delay_ticks[1] - chain.delay_ticks[0] + 1));
        newChainEvents.push({
          source_event_id: event.id,
          ticks_remaining: delay,
          event: {
            description: chain.description,
            probability: chain.probability,
            emotion_delta: chain.emotion_delta,
            intent_boosts: chain.intent_boosts,
            diary_entry: chain.diary_entry,
          },
        });
      }
    }
  }

  return { event, newChainEvents };
}

/**
 * Process pending chain events: decrement timers, trigger those at 0.
 * Returns triggered events and remaining pending events.
 */
export function processChainEvents(
  state: ChainAndCooldownState,
): { triggered: PendingChainEvent[]; remaining: ChainAndCooldownState } {
  const triggered: PendingChainEvent[] = [];
  const remaining: PendingChainEvent[] = [];

  for (const chain of state.pending) {
    const updated = { ...chain, ticks_remaining: chain.ticks_remaining - 1 };
    if (updated.ticks_remaining <= 0) {
      triggered.push(updated);
    } else {
      remaining.push(updated);
    }
  }

  return {
    triggered,
    remaining: { ...state, pending: remaining },
  };
}

// === Legacy backward-compat wrapper ===

/**
 * Roll for random events this tick (legacy API).
 * Returns 0 or 1 events per call.
 */
export function rollRandomEvent(options?: {
  probability?: number;
  excludeCategories?: IntentCategory[];
}): RandomEvent | null {
  const prob = options?.probability ?? 0.10;

  if (Math.random() > prob) return null;

  // Use only the original 12 events (first 12 in pool) for backward compat
  let pool = EVENT_POOL.slice(0, 12).map(e => ({
    description: e.description,
    emotion_delta: e.emotion_delta,
    intent_boosts: e.intent_boosts,
    diary_entry: e.diary_entry,
  }));

  if (options?.excludeCategories) {
    const excluded = new Set(options.excludeCategories);
    pool = pool.filter(e =>
      !e.intent_boosts.every(b => excluded.has(b.category))
    );
  }

  if (pool.length === 0) return null;

  const idx = Math.floor(Math.random() * pool.length);
  const selected = pool[idx];

  return {
    ...selected,
    id: `rnd_${now().getTime()}_${Math.random().toString(36).slice(2, 6)}`,
  };
}
