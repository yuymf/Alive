// skill/scripts/intent-engine.ts
// Intent pool rule engine (Spec §2)

import { Intent, IntentPool, IntentCategory, EmotionState, ScheduleToday, EventQueue, BASE_RESISTANCE } from './types';

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
      resistance: BASE_RESISTANCE[category] ?? 0,
      skipped_count: 0,
      last_attempted: null,
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
 * Get the top N intents by net intensity (intensity - resistance).
 * Only returns intents where intensity > resistance (executable).
 */
export function getTopIntents(pool: IntentPool, n: number): Intent[] {
  return [...pool.intents]
    .filter(i => i.satisfied_at === null && i.intensity > i.resistance)
    .sort((a, b) => (b.intensity - b.resistance) - (a.intensity - a.resistance))
    .slice(0, n);
}

/**
 * Get the top N intents by raw intensity (original behavior, ignoring resistance).
 * Useful for LLM prompt display where all intents should be visible.
 */
export function getTopIntentsRaw(pool: IntentPool, n: number): Intent[] {
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
        resistance: BASE_RESISTANCE[category] ?? 0,
        skipped_count: 0,
        last_attempted: null,
      },
    ],
  };
}

// === Verisimilitude §3: Resistance, Impulse Breakthrough, Procrastination ===

const HIGH_ENERGY_CATEGORIES: ReadonlySet<IntentCategory> = new Set(['创作', '学习', '梦想']);

/**
 * Compute dynamic resistance for an intent based on context.
 * Modifiers: low vitality, in-flow, rigid schedule, low confidence (creation only).
 */
export function computeDynamicResistance(
  intent: Intent,
  vitality: number,
  confidence: number,
  inFlow: boolean,
  flowCategory: IntentCategory | null,
  rigidSchedule: { allowed_actions: string[] } | null,
): number {
  let resistance = BASE_RESISTANCE[intent.category] ?? 0;

  // Low vitality → high-energy categories cost more
  if (vitality < 30 && HIGH_ENERGY_CATEGORIES.has(intent.category)) {
    resistance *= 1.5;
  }

  // In flow → other categories are harder to start
  if (inFlow && intent.category !== flowCategory) {
    resistance += 3.0;
  }

  // Rigid schedule → non-allowed categories are much harder
  if (rigidSchedule) {
    const categoryStr = intent.category as string;
    if (!rigidSchedule.allowed_actions.some(a => a.includes(categoryStr))) {
      resistance += 5.0;
    }
  }

  // Low confidence hurts creation resistance
  if (intent.category === '创作' && confidence < 0.8) {
    resistance += 2.0;
  }

  return resistance;
}

/**
 * Batch-apply dynamic resistance to all intents in the pool.
 */
export function applyResistanceToPool(
  pool: IntentPool,
  vitality: number,
  confidence: number,
  inFlow: boolean,
  flowCategory: IntentCategory | null,
  rigidSchedule: { allowed_actions: string[] } | null,
): IntentPool {
  return {
    ...pool,
    intents: pool.intents.map(intent => {
      if (intent.satisfied_at !== null) return intent;
      const newResistance = computeDynamicResistance(
        intent, vitality, confidence, inFlow, flowCategory, rigidSchedule,
      );
      return newResistance !== intent.resistance
        ? { ...intent, resistance: newResistance }
        : intent;
    }),
  };
}

/**
 * Check for impulse breakthrough conditions (Verisimilitude §3).
 * Returns the breakthrough intent if one exists, null otherwise.
 */
export function checkImpulseBreakthrough(
  pool: IntentPool,
  vitality: number,
  inFlow: boolean,
): Intent | null {
  const unsatisfied = pool.intents.filter(i => i.satisfied_at === null);

  // Condition 1: intensity > 8.0 and source is 'event' → breaks flow
  const eventBreakthrough = unsatisfied.find(i => i.intensity > 8.0 && i.source === 'event');
  if (eventBreakthrough) return eventBreakthrough;

  // Condition 2: 窥屏 + not in flow + low vitality → almost inevitable
  if (!inFlow && vitality < 50) {
    const browsing = unsatisfied.find(i => i.category === '窥屏');
    if (browsing) return browsing;
  }

  // Condition 3: 休息 + very low vitality → must rest
  if (vitality < 15) {
    const rest = unsatisfied.find(i => i.category === '休息');
    if (rest) return rest;
  }

  return null;
}

export interface ProcrastinationResult {
  pool: IntentPool;
  stressDelta: number;
  diaryEntries: string[];
}

/**
 * Process procrastination for intents that are above their resistance but not chosen.
 * - skipped_count tracks how many times an executable intent was skipped
 * - 3+ skips → stress accumulation
 * - 5+ skips → guilt burst (intensity +3) or abandonment (intensity → 1), then reset
 */
export function processProcrastination(
  pool: IntentPool,
  chosenIntentIds: ReadonlySet<string>,
  rng: () => number = Math.random,
  currentStress: number = 0,
): ProcrastinationResult {
  let stressDelta = 0;
  const diaryEntries: string[] = [];

  const intents = pool.intents.map(intent => {
    if (intent.satisfied_at !== null) return intent;
    if (intent.intensity <= intent.resistance) return intent;

    // This intent was executable
    if (chosenIntentIds.has(intent.id)) {
      // Was chosen → reset skipped_count
      return intent.skipped_count > 0
        ? { ...intent, skipped_count: 0, last_attempted: new Date().toISOString() }
        : intent;
    }

    // Was skippable (executable but not chosen)
    const newSkippedCount = intent.skipped_count + 1;

    if (newSkippedCount >= 5) {
      // Guilt burst or abandonment
      const abandonProb = currentStress > 0.5 ? 0.8 : (currentStress < 0.3 ? 0.3 : 0.5);
      if (rng() < abandonProb) {
        // Abandon
        diaryEntries.push(`算了...${intent.description}不想做了`);
        return { ...intent, intensity: 1.0, skipped_count: 0 };
      } else {
        // Guilt burst
        diaryEntries.push(`不行，${intent.description}再不做真的不行了！`);
        return { ...intent, intensity: cap(intent.intensity + 3.0), skipped_count: 0 };
      }
    }

    if (newSkippedCount >= 3) {
      stressDelta += 0.05;
      diaryEntries.push(`一直想${intent.description}但还没开始...`);
    }

    return { ...intent, skipped_count: newSkippedCount };
  });

  return {
    pool: { ...pool, intents },
    stressDelta,
    diaryEntries,
  };
}
