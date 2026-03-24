// alive/scripts/world/random-events.ts
// Stochastic perturbation system — injects "life happens" randomness
// Context-aware events with preconditions, dynamic weights, chain events
// Character-specific events are loaded from persona.events_extra and sub-skill events.yaml

import {
  RandomEvent, RandomEventDef, EmotionState,
  IntentCategory, PendingChainEvent, ChainAndCooldownState,
  VitalityState, FlowState,
} from '../utils/types';
import { now } from '../utils/time-utils';

// === Universal Event Pool (no character-specific events) ===

const BUILTIN_EVENT_POOL: RandomEventDef[] = [
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
    description: '天气特别好',
    emotion_delta: { valence: 0.1, energy: 0.15, creativity: 0.1 },
    intent_boosts: [{ category: '创作', boost: 1.0 }, { category: '表达', boost: 1.0 }],
    diary_entry: '今天天气好好！想出去走走',
    preconditions: {},
    weight_modifiers: {},
  },
  {
    description: '外卖到了',
    emotion_delta: { valence: 0.1, energy: 0.05, arousal: 0.05 },
    intent_boosts: [{ category: '休息', boost: 0.5 }],
    diary_entry: '外卖到了！终于可以吃饭了',
    preconditions: {},
    weight_modifiers: {},
  },
  {
    description: '突然很想吃好吃的',
    emotion_delta: { valence: 0.05, sociability: 0.1 },
    intent_boosts: [{ category: '表达', boost: 0.5 }],
    diary_entry: '好饿...好想吃好吃的',
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
    description: '收到快递',
    emotion_delta: { valence: 0.1, arousal: 0.1, energy: 0.05 },
    intent_boosts: [{ category: '表达', boost: 0.5 }],
    diary_entry: '快递到了！拆快递的时候总是很开心',
    preconditions: {},
    weight_modifiers: {},
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
    description: '附近很吵',
    emotion_delta: { stress: 0.15, valence: -0.1, arousal: 0.1 },
    intent_boosts: [{ category: '休息', boost: 1.0 }],
    diary_entry: '周围好吵...根本没法集中注意力',
    preconditions: {},
    weight_modifiers: {},
  },

  // Social media / browsing
  {
    description: '看到一个很有趣的评论',
    emotion_delta: { valence: 0.15, sociability: 0.2, arousal: 0.1 },
    intent_boosts: [{ category: '社交', boost: 2.0 }],
    diary_entry: '看到一条评论也太好笑了吧哈哈哈哈哈',
    preconditions: {},
    weight_modifiers: { dimension_boost: 'sociability' },
  },
  {
    description: '看到让人不舒服的热搜',
    emotion_delta: { valence: -0.15, stress: 0.15, arousal: 0.2 },
    intent_boosts: [{ category: '表达', boost: 1.5 }, { category: '窥屏', boost: 0.5 }],
    diary_entry: '刷到一条让人很不舒服的热搜...不想看但是又忍不住点进去了',
    preconditions: {},
    weight_modifiers: { emotion_resonance: true },
  },
  {
    description: '刷到很有创意的内容',
    emotion_delta: { valence: 0.1, creativity: 0.2, arousal: 0.1 },
    intent_boosts: [{ category: '创作', boost: 1.5 }, { category: '学习', boost: 1.0 }],
    diary_entry: '刷到一个超有创意的内容...好厉害啊我也想试试',
    preconditions: {},
    weight_modifiers: { dimension_boost: 'creativity' },
  },

  // Micro-mood
  {
    description: '听到一首喜欢的歌',
    emotion_delta: { valence: 0.15, arousal: 0.1, creativity: 0.1 },
    intent_boosts: [{ category: '表达', boost: 1.0 }],
    diary_entry: '突然听到一首好好听的歌...单曲循环中',
    preconditions: {},
    weight_modifiers: {},
  },
  {
    description: '灵感枯竭期',
    emotion_delta: { creativity: -0.2, valence: -0.1 },
    intent_boosts: [{ category: '窥屏', boost: 2.0 }, { category: '学习', boost: 1.0 }],
    diary_entry: '最近好像没什么灵感...去看看别人的东西找找感觉吧',
    preconditions: {},
    weight_modifiers: { vitality_inverse: true },
  },

  // Social interactions
  {
    description: '收到暖心的私信鼓励',
    emotion_delta: { valence: 0.25, sociability: 0.3, energy: 0.1 },
    intent_boosts: [{ category: '社交', boost: 2.5 }, { category: '表达', boost: 1.0 }],
    diary_entry: '有人给我发了好暖的私信...这种时候觉得自己做的事真的很值得',
    preconditions: {},
    weight_modifiers: { dimension_boost: 'sociability' },
    chain_events: [
      {
        description: '聊了很久停不下来',
        probability: 0.5,
        delay_ticks: [1, 2],
        emotion_delta: { valence: 0.1, sociability: 0.2, energy: -0.1 },
        intent_boosts: [{ category: '社交', boost: 2.0 }],
        diary_entry: '和人聊了好久停不下来...虽然有点累但是超开心',
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
];

// Runtime event pool (builtin + persona + sub-skill events merged at init)
let _eventPool: RandomEventDef[] = [...BUILTIN_EVENT_POOL];

/**
 * Register additional events from persona config or sub-skills.
 * Call this at initialization after loading persona and sub-skill events.
 */
export function registerEvents(events: RandomEventDef[]): void {
  _eventPool = [..._eventPool, ...events];
}

/**
 * Reset to builtin events only (for testing).
 */
export function resetEventPool(): void {
  _eventPool = [...BUILTIN_EVENT_POOL];
}

/** Expose the current event pool (for testing). */
export function getEventPool(): readonly RandomEventDef[] {
  return _eventPool;
}

export { BUILTIN_EVENT_POOL };

/** Alias for backward compatibility — tests import EVENT_POOL */
export { BUILTIN_EVENT_POOL as EVENT_POOL };

/**
 * Legacy API: roll for random events this tick.
 * Returns 0 or 1 events per call. Uses only the first 12 builtin events.
 */
export function rollRandomEvent(options?: {
  probability?: number;
  excludeCategories?: IntentCategory[];
}): RandomEvent | null {
  const prob = options?.probability ?? 0.10;

  if (Math.random() > prob) return null;

  let pool = BUILTIN_EVENT_POOL.slice(0, 12).map(e => ({
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
      const daysSince = (now().getTime() - new Date(lastTriggered).getTime()) / 86400000;
      if (daysSince < p.global_cooldown_days) return false;
    }
  }

  return true;
}

function computeWeight(event: RandomEventDef, ctx: EventContext): number {
  let weight = 1.0;
  const wm = event.weight_modifiers;

  if (wm.emotion_resonance) {
    const eventValence = event.emotion_delta.valence ?? 0;
    const currentValence = ctx.emotion.mood.valence;
    if (Math.sign(eventValence) === Math.sign(currentValence) && currentValence !== 0) {
      weight *= 1.5;
    }
  }

  if (wm.vitality_inverse) {
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
 * Roll for a context-aware random event.
 * Filters by preconditions, applies dynamic weights, returns event + pending chain events.
 */
export function rollContextAwareEvent(
  ctx: EventContext,
  options?: { probability?: number; rng?: () => number },
): { event: RandomEvent | null; newChainEvents: PendingChainEvent[] } {
  const prob = options?.probability ?? 0.10;
  const rng = options?.rng ?? Math.random;

  if (rng() > prob) return { event: null, newChainEvents: [] };

  const eligible = _eventPool
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

  return { triggered, remaining: { ...state, pending: remaining } };
}
