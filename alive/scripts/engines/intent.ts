// alive/scripts/engines/intent.ts
// Intent pool rule engine — generalized (no platform-specific event types)

import { Intent, IntentPool, IntentCategory, EmotionState, ScheduleToday, EventQueue, BASE_RESISTANCE } from '../utils/types';
import { now } from '../utils/time-utils';
import { INTENT_CONFIG } from '../config';

const INTENSITY_CAP = INTENT_CONFIG.INTENSITY_CAP;

function cap(value: number): number {
  return Math.min(INTENSITY_CAP, Math.max(0, value));
}

function generateId(): string {
  return `int_${now().getTime()}_${Math.random().toString(36).slice(2, 6)}`;
}

function isSlackPeriod(hour: number): boolean {
  return (hour >= 12 && hour < 13) || (hour >= 14 && hour < 16);
}

export function decaySatisfied(pool: IntentPool): IntentPool {
  const intents = pool.intents
    .map(intent => intent.satisfied_at === null ? intent : { ...intent, intensity: cap(intent.intensity - intent.decay_rate) })
    .filter(intent => intent.intensity >= 0.1);
  return { ...pool, intents };
}

export function accumulateIntents(
  pool: IntentPool, hour: number, lastActionHoursAgo: number,
  consecutiveActiveHeartbeats: number, hasUnreadEvents: boolean,
): IntentPool {
  const intents = pool.intents.map(intent => {
    if (intent.satisfied_at !== null) return intent;
    let boost = 0;
    switch (intent.category) {
      case '创作': boost = 0.3; if (lastActionHoursAgo > 48) boost += 1.0; break;
      case '社交': boost = hasUnreadEvents ? 2.0 : 0.2; break;
      case '窥屏': boost = isSlackPeriod(hour) ? 1.0 : 0.2; break;  // 降低窥屏 boost（从 1.5/0.3 → 1.0/0.2）避免单一技能垄断
      case '休息': boost = consecutiveActiveHeartbeats * 0.5; break;
      case '表达': boost = 0.2; break;
      case '学习': boost = 0.6; break;  // 从 0.2 提高到 0.6：让学习/搜索意图更容易积累
      case '梦想': boost = 0.1; break;
    }
    return { ...intent, intensity: cap(intent.intensity + boost) };
  });
  return { ...pool, intents };
}

/**
 * Generic event boost — sub-skills inject events with category + boost.
 */
export function applyEventBoosts(pool: IntentPool, events: EventQueue): IntentPool {
  let intents = [...pool.intents];
  for (const event of events.events) {
    if (event.processed) continue;
    const boosts = (event.data as { intent_boosts?: Array<{ category: string; boost: number }> }).intent_boosts;
    if (boosts) {
      for (const b of boosts) {
        intents = boostOrCreate(intents, b.category as IntentCategory, b.boost, `事件: ${event.type}`, 'event');
      }
    }
  }
  return { ...pool, intents };
}

function boostOrCreate(intents: Intent[], category: IntentCategory, boost: number, description: string, source: Intent['source']): Intent[] {
  const existing = intents.find(i => i.category === category && i.satisfied_at === null);
  if (existing) {
    return intents.map(i => i.id === existing.id ? { ...i, intensity: cap(i.intensity + boost) } : i);
  }
  return [...intents, {
    id: generateId(), category, description, intensity: cap(boost), source,
    born_at: now().toISOString(), decay_rate: INTENT_CONFIG.DEFAULT_DECAY_RATE, satisfied_at: null,
    resistance: BASE_RESISTANCE[category] ?? 0, skipped_count: 0, last_attempted: null,
  }];
}

export function injectScheduleIntents(pool: IntentPool, schedule: ScheduleToday, hour: number): IntentPool {
  let intents = [...pool.intents];
  for (const flex of schedule.flexible) {
    const prefHour = parseInt(flex.preferred_time.split(':')[0], 10);
    if (Math.abs(hour - prefHour) <= 1) {
      intents = boostOrCreate(intents, flex.intent_category, flex.intent_boost, flex.activity, 'schedule');
    }
  }
  return { ...pool, intents };
}

export function getTopIntents(pool: IntentPool, n: number): Intent[] {
  return [...pool.intents]
    .filter(i => i.satisfied_at === null && i.intensity > i.resistance)
    .sort((a, b) => (b.intensity - b.resistance) - (a.intensity - a.resistance))
    .slice(0, n);
}

export function getTopIntentsRaw(pool: IntentPool, n: number): Intent[] {
  return [...pool.intents].filter(i => i.satisfied_at === null).sort((a, b) => b.intensity - a.intensity).slice(0, n);
}

export function satisfyIntent(pool: IntentPool, intentId: string): IntentPool {
  return { ...pool, intents: pool.intents.map(i => i.id === intentId ? { ...i, satisfied_at: now().toISOString() } : i) };
}

export function addIntent(pool: IntentPool, category: IntentCategory, description: string, intensity: number, source: Intent['source']): IntentPool {
  return { ...pool, intents: [...pool.intents, {
    id: generateId(), category, description, intensity: cap(intensity), source,
    born_at: now().toISOString(), decay_rate: INTENT_CONFIG.DEFAULT_DECAY_RATE, satisfied_at: null,
    resistance: BASE_RESISTANCE[category] ?? 0, skipped_count: 0, last_attempted: null,
  }]};
}

// === Resistance ===

const HIGH_ENERGY_CATEGORIES: ReadonlySet<IntentCategory> = new Set(['创作', '学习', '梦想']);

export function computeDynamicResistance(
  intent: Intent, vitality: number, confidence: number,
  inFlow: boolean, flowCategory: IntentCategory | null,
  rigidSchedule: { allowed_actions: string[] } | null,
): number {
  let resistance = BASE_RESISTANCE[intent.category] ?? 0;
  if (vitality < 30 && HIGH_ENERGY_CATEGORIES.has(intent.category)) resistance *= 1.5;
  if (inFlow && intent.category !== flowCategory) resistance += 3.0;
  if (rigidSchedule && !rigidSchedule.allowed_actions.some(a => a.includes(intent.category as string))) resistance += 5.0;
  if (intent.category === '创作' && confidence < 0.8) resistance += 2.0;
  return resistance;
}

export function applyResistanceToPool(pool: IntentPool, vitality: number, confidence: number, inFlow: boolean, flowCategory: IntentCategory | null, rigidSchedule: { allowed_actions: string[] } | null): IntentPool {
  return { ...pool, intents: pool.intents.map(intent => {
    if (intent.satisfied_at !== null) return intent;
    const newR = computeDynamicResistance(intent, vitality, confidence, inFlow, flowCategory, rigidSchedule);
    return newR !== intent.resistance ? { ...intent, resistance: newR } : intent;
  })};
}

export function checkImpulseBreakthrough(pool: IntentPool, vitality: number, inFlow: boolean): Intent | null {
  const unsatisfied = pool.intents.filter(i => i.satisfied_at === null);
  const eventBreak = unsatisfied.find(i => i.intensity > 8.0 && i.source === 'event');
  if (eventBreak) return eventBreak;
  if (!inFlow && vitality < 50) { const browsing = unsatisfied.find(i => i.category === '窥屏'); if (browsing) return browsing; }
  if (vitality < 15) { const rest = unsatisfied.find(i => i.category === '休息'); if (rest) return rest; }
  return null;
}

export interface ProcrastinationResult { pool: IntentPool; stressDelta: number; diaryEntries: string[]; }

// Varied procrastination diary templates to avoid repetitive entries
const PROCRASTINATION_TEMPLATES = [
  (desc: string) => `一直想${desc}但还没开始...`,
  (desc: string) => `又拖了一小时...${desc}什么时候才能动手啊`,
  (desc: string) => `${desc}的事还挂在心上呢...`,
  (desc: string) => `明明想${desc}，手却不听使唤`,
  (desc: string) => `脑子里一直转着${desc}，但就是没行动`,
];

export function processProcrastination(pool: IntentPool, chosenIntentIds: ReadonlySet<string>, rng = Math.random, currentStress = 0): ProcrastinationResult {
  let stressDelta = 0;
  const diaryEntries: string[] = [];
  // Track which descriptions we've already emitted this tick to avoid duplicates
  const emittedDescriptions = new Set<string>();
  // Global cap: max N procrastination diary entries per tick to avoid diary bloat
  const MAX_DIARY_PER_TICK = INTENT_CONFIG.MAX_DIARY_PER_TICK;

  const intents = pool.intents.map(intent => {
    if (intent.satisfied_at !== null || intent.intensity <= intent.resistance) return intent;
    if (chosenIntentIds.has(intent.id)) return intent.skipped_count > 0 ? { ...intent, skipped_count: 0, last_attempted: now().toISOString() } : intent;
    const newSkipped = intent.skipped_count + 1;
    if (newSkipped >= INTENT_CONFIG.PROCRASTINATION_RESOLVE_AT) {
      // Reduced threshold: resolve sooner (abandon or burst)
      const abandonProb = currentStress > 0.5 ? 0.8 : (currentStress < 0.3 ? 0.5 : 0.6);
      if (rng() < abandonProb) {
        // On abandon: set intensity below resistance so it won't re-trigger the cycle
        const newIntensity = Math.min(intent.resistance * 0.8, 0.5);
        if (diaryEntries.length < MAX_DIARY_PER_TICK) {
          diaryEntries.push(`算了...${intent.description}不想做了`);
        }
        return { ...intent, intensity: newIntensity, skipped_count: 0 };
      } else {
        if (diaryEntries.length < MAX_DIARY_PER_TICK) {
          diaryEntries.push(`不行，${intent.description}再不做真的不行了！`);
        }
        return { ...intent, intensity: cap(intent.intensity + 3.0), skipped_count: 0 };
      }
    }
    // Only emit diary entry at exactly skipped_count === 3 (not every tick >= 3)
    if (newSkipped === 3 && !emittedDescriptions.has(intent.description) && diaryEntries.length < MAX_DIARY_PER_TICK) {
      stressDelta += 0.05;
      const templateFn = PROCRASTINATION_TEMPLATES[Math.floor(rng() * PROCRASTINATION_TEMPLATES.length)];
      diaryEntries.push(templateFn(intent.description));
      emittedDescriptions.add(intent.description);
    }
    return { ...intent, skipped_count: newSkipped };
  });
  return { pool: { ...pool, intents }, stressDelta, diaryEntries };
}
