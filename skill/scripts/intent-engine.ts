// skill/scripts/intent-engine.ts
// Intent pool rule engine (Spec §2)

import { Intent, IntentPool, IntentCategory, EmotionState, ScheduleToday, EventQueue } from './types';

const INTENSITY_CAP = 10.0;

function cap(value: number): number {
  return Math.min(INTENSITY_CAP, Math.max(0, value));
}

function generateId(): string {
  return `int_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Determine current time period for accumulation rules.
 */
function getTimePeriod(hour: number): 'morning' | 'work' | 'lunch' | 'afternoon' | 'evening' | 'night' {
  if (hour >= 7 && hour < 9) return 'morning';
  if (hour >= 9 && hour < 12) return 'work';
  if (hour >= 12 && hour < 13) return 'lunch';
  if (hour >= 13 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

function isSlackPeriod(hour: number): boolean {
  const period = getTimePeriod(hour);
  return period === 'lunch' || period === 'afternoon';
}

/**
 * Decay satisfied intents (Spec §2: decay_rate per hour).
 * Remove intents that have decayed below 0.1.
 */
export function decaySatisfied(pool: IntentPool): IntentPool {
  const intents = pool.intents
    .map(intent => {
      if (intent.satisfied_at === null) return intent;
      return { ...intent, intensity: cap(intent.intensity - intent.decay_rate) };
    })
    .filter(intent => intent.intensity >= 0.1);

  return { ...pool, intents };
}

/**
 * Accumulate unsatisfied intents based on category rules (Spec §2).
 */
export function accumulateIntents(
  pool: IntentPool,
  hour: number,
  lastPostHoursAgo: number,
  consecutiveActiveHeartbeats: number,
  hasUnreadEvents: boolean,
): IntentPool {
  const intents = pool.intents.map(intent => {
    if (intent.satisfied_at !== null) return intent;

    let boost = 0;
    switch (intent.category) {
      case '创作':
        boost = 0.3;
        if (lastPostHoursAgo > 48) boost += 1.0;
        break;
      case '社交':
        boost = hasUnreadEvents ? 2.0 : 0.2;
        break;
      case '窥屏':
        boost = isSlackPeriod(hour) ? 1.5 : 0.3;
        break;
      case '休息':
        boost = consecutiveActiveHeartbeats * 0.5;
        break;
      case '表达':
        boost = 0.2;
        break;
      case '学习':
        boost = 0.2;
        break;
      case '梦想':
        boost = 0.1;
        break;
    }

    return { ...intent, intensity: cap(intent.intensity + boost) };
  });

  return { ...pool, intents };
}

/**
 * Inject or boost intents from events (Spec §2: event boosts).
 */
export function applyEventBoosts(pool: IntentPool, events: EventQueue): IntentPool {
  let intents = [...pool.intents];

  for (const event of events.events) {
    if (event.processed) continue;

    switch (event.type) {
      case 'instagram_comment':
      case 'instagram_follower':
        intents = boostOrCreate(intents, '社交', 3.0, `收到${event.type}`, 'event');
        break;
      case 'trend_discovered':
        intents = boostOrCreate(intents, '创作', 2.0, '发现热点话题', 'event');
        intents = boostOrCreate(intents, '窥屏', 1.0, '想看看更多热点', 'event');
        break;
      case 'post_stats_up':
        intents = boostOrCreate(intents, '表达', 2.0, '数据涨了想分享', 'event');
        break;
    }
  }

  return { ...pool, intents };
}

function boostOrCreate(
  intents: Intent[],
  category: IntentCategory,
  boost: number,
  description: string,
  source: Intent['source'],
): Intent[] {
  const existing = intents.find(i => i.category === category && i.satisfied_at === null);
  if (existing) {
    return intents.map(i =>
      i.id === existing.id
        ? { ...i, intensity: cap(i.intensity + boost) }
        : i
    );
  }
  return [
    ...intents,
    {
      id: generateId(),
      category,
      description,
      intensity: cap(boost),
      source,
      born_at: new Date().toISOString(),
      decay_rate: 0.5,
      satisfied_at: null,
    },
  ];
}

/**
 * Inject flexible schedule items as high-intensity intents (Spec §3).
 */
export function injectScheduleIntents(pool: IntentPool, schedule: ScheduleToday, hour: number): IntentPool {
  let intents = [...pool.intents];

  for (const flex of schedule.flexible) {
    const prefHour = parseInt(flex.preferred_time.split(':')[0], 10);
    // Only inject if current hour matches preferred time (± 1 hour)
    if (Math.abs(hour - prefHour) <= 1) {
      intents = boostOrCreate(intents, flex.intent_category, flex.intent_boost, flex.activity, 'schedule');
    }
  }

  return { ...pool, intents };
}

/**
 * Get the top N intents by intensity, filtering by allowed actions if in rigid schedule.
 */
export function getTopIntents(pool: IntentPool, n: number): Intent[] {
  return [...pool.intents]
    .filter(i => i.satisfied_at === null)
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, n);
}

/**
 * Mark an intent as satisfied.
 */
export function satisfyIntent(pool: IntentPool, intentId: string): IntentPool {
  return {
    ...pool,
    intents: pool.intents.map(i =>
      i.id === intentId
        ? { ...i, satisfied_at: new Date().toISOString() }
        : i
    ),
  };
}

/**
 * Add a new intent to the pool.
 */
export function addIntent(
  pool: IntentPool,
  category: IntentCategory,
  description: string,
  intensity: number,
  source: Intent['source'],
): IntentPool {
  return {
    ...pool,
    intents: [
      ...pool.intents,
      {
        id: generateId(),
        category,
        description,
        intensity: cap(intensity),
        source,
        born_at: new Date().toISOString(),
        decay_rate: 0.5,
        satisfied_at: null,
      },
    ],
  };
}
