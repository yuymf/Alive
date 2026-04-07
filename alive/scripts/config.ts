// alive/scripts/config.ts
// Centralized configuration — all tunable engine parameters in one place.
// Each engine imports from here instead of hardcoding values.

// ═══════════════════════════════════════════════════════════════════
// Emotion Engine
// ═══════════════════════════════════════════════════════════════════

export const EMOTION_CONFIG = {
  /** Impulse layer decay rate per tick (20% = fast fade) */
  IMPULSE_DECAY: 0.20,
  /** Max impulse history entries retained */
  MAX_IMPULSE_HISTORY: 50,
  /** Momentum update alpha when applying impulse */
  IMPULSE_ALPHA: 0.3,
  /** Stress threshold for threshold break detection */
  STRESS_THRESHOLD: 0.6,
  /** Consecutive high-stress ticks before emotional explosion */
  CONSECUTIVE_STRESS_TICKS: 3,
  /** Cooldown ticks after threshold break */
  THRESHOLD_BREAK_COOLDOWN: 5,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Intent Engine
// ═══════════════════════════════════════════════════════════════════

export const INTENT_CONFIG = {
  /** Maximum intent intensity value */
  INTENSITY_CAP: 10.0,
  /** Default decay rate for new intents */
  DEFAULT_DECAY_RATE: 0.5,
  /** Seed decay rate (morning plan seeds) */
  SEED_DECAY_RATE: 0.3,
  /** Procrastination resolve threshold (skip count) */
  PROCRASTINATION_RESOLVE_AT: 4,
  /** Max procrastination diary entries per tick */
  MAX_DIARY_PER_TICK: 3,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Flow Engine
// ═══════════════════════════════════════════════════════════════════

export const FLOW_CONFIG = {
  /** Initial interrupt chance when entering flow */
  INTERRUPT_CHANCE_INITIAL: 0.35,
  /** Max flow duration in ticks */
  MAX_FLOW_TICKS: 2,
  /** Max drift duration in ticks */
  MAX_DRIFT_TICKS: 2,
  /** Net intent intensity threshold for flow entry */
  FLOW_ENTRY_THRESHOLD: 2.5,
  /** Minimum energy to enter flow (0-1) */
  FLOW_MIN_ENERGY: 0.25,
  /** Cooldown ticks after flow exit */
  FLOW_COOLDOWN_TICKS: 1,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Vitality Engine
// ═══════════════════════════════════════════════════════════════════

export const VITALITY_CONFIG = {
  /** Maximum vitality value */
  VITALITY_MAX: 100,
  /** Base vitality drain per tick */
  BASE_DRAIN_PER_TICK: 2,
  /** Default initial vitality */
  DEFAULT_VITALITY: 70,
  /** Consecutive low days before emergency recovery */
  EMERGENCY_LOW_DAYS: 3,
  /** Emergency recovery minimum vitality guarantee */
  EMERGENCY_MIN_VITALITY: 60,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Confidence Engine
// ═══════════════════════════════════════════════════════════════════

export const CONFIDENCE_CONFIG = {
  /** Confidence range: min */
  CONFIDENCE_MIN: 0.5,
  /** Confidence range: max */
  CONFIDENCE_MAX: 1.5,
  /** Neutral confidence value */
  CONFIDENCE_NEUTRAL: 1.0,
  /** Daily decay rate toward neutral */
  DECAY_RATE: 0.0033,
  /** Delta per feedback event (positive or negative) */
  FEEDBACK_DELTA: 0.05,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Work Impulse Engine (core output desire accumulator)
// ═══════════════════════════════════════════════════════════════════

export const WORK_IMPULSE_CONFIG = {
  /** Per-tick base impulse decay */
  BASE_DECAY: 3,
  /** Impulse threshold to inject produce desire (0-100) */
  IMPULSE_THRESHOLD: 70,
  /** Days without core output before dormancy boost */
  DORMANCY_DAYS: 5,
  /** Impulse boost on dormancy trigger */
  DORMANCY_BOOST: 50,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Social Graph Engine
// ═══════════════════════════════════════════════════════════════════

export const SOCIAL_GRAPH_CONFIG = {
  /** Max relations per tier */
  TIER_LIMITS: { core: 5, familiar: 15, cognitive: 100, dormant: 500 } as Record<string, number>,
  /** Closeness thresholds for tier classification */
  TIER_THRESHOLDS: { core: 7, familiar: 4, cognitive: 1 } as Record<string, number>,
  /** Days inactive in core circle before social intent */
  CORE_INACTIVE_DAYS: 3,
  /** Days without interaction for dormancy removal */
  DORMANCY_DAYS: 90,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Random Events
// ═══════════════════════════════════════════════════════════════════

export const RANDOM_EVENTS_CONFIG = {
  /** Per-tick probability of a random event firing */
  EVENT_PROBABILITY: 0.10,
  /** Emotion resonance weight multiplier */
  RESONANCE_WEIGHT: 1.5,
  /** Low-vitality weight multiplier (when vitality < 40) */
  VITALITY_INVERSE_WEIGHT: 2.0,
  /** Dimension boost weight multiplier (when dim > 0.5) */
  DIMENSION_BOOST_WEIGHT: 2.0,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Heartbeat / Lifecycle
// ═══════════════════════════════════════════════════════════════════

export const HEARTBEAT_CONFIG = {
  /** Event queue max capacity */
  EVENT_QUEUE_MAX_SIZE: 50,
  /** Heartbeat log retention in days */
  LOG_RETENTION_DAYS: 7,
  /** Flow drain modifier (vitality drain multiplier during flow) */
  FLOW_DRAIN_MODIFIER: 0.7,
  /** Heartbeat log byte size limit before trimming */
  LOG_SIZE_LIMIT: 100_000,
  /** Number of log entries to keep after trimming */
  LOG_TRIM_KEEP: 50,
  /** Top-N intents passed to LLM */
  TOP_INTENTS_FOR_LLM: 7,
} as const;

// ═══════════════════════════════════════════════════════════════════
// LLM Client
// ═══════════════════════════════════════════════════════════════════

export const LLM_CONFIG = {
  /** Default API base URL */
  DEFAULT_API_BASE: 'https://aihubmix.com/v1',
  /** Default model name */
  DEFAULT_MODEL: 'claude-sonnet-4-20250514',
  /** Retry delay in ms */
  RETRY_DELAY_MS: 10_000 as number,
  /** Log file max size in bytes (auto-rotate) */
  LLM_LOG_MAX_BYTES: 500 * 1024,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Heartbeat Outreach (Proactive Messaging)
// ═══════════════════════════════════════════════════════════════════

export const OUTREACH_CONFIG = {
  /** Max proactive messages per day */
  MAX_DAILY_OUTREACH: 2,
  /** Minimum hours between messages */
  COOLDOWN_HOURS: 4,
  /** Active hours window (inclusive) */
  ACTIVE_HOURS: { start: 10, end: 21 },
  /** Min sociability to consider sending */
  MIN_SOCIABILITY: 0.35,
  /** Min valence (don't message when very upset) */
  MIN_VALENCE: -0.2,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Memory Reflection
// ═══════════════════════════════════════════════════════════════════

export const MEMORY_REFLECT_CONFIG = {
  /** Importance accumulation threshold to trigger reflection */
  DEFAULT_THRESHOLD: 100,
  /** Max core wisdom entries */
  MAX_WISDOM_ENTRIES: 20,
  /** Minimum importance score for high-importance filtering */
  MIN_IMPORTANCE: 6,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Skill Discovery & Lifecycle
// ═══════════════════════════════════════════════════════════════════

export const SKILL_LIFECYCLE_CONFIG = {
  /** Max skills installed per night cycle */
  MAX_INSTALL_PER_NIGHT: 2,
  /** Max total installed skills */
  MAX_TOTAL_SKILLS: 20,
  /** Max acquisition plans per evaluation */
  MAX_PLANS: 2,
  /** CLI timeout in ms */
  CLI_TIMEOUT_MS: 30_000,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Cron Sync
// ═══════════════════════════════════════════════════════════════════

export const CRON_CONFIG = {
  /** Default cron expressions (fallback when schedule is empty) */
  DEFAULT_MORNING: '0 7 * * *',
  DEFAULT_TICK: '0 8-22 * * *',
  DEFAULT_NIGHT: '0 23 * * *',
  /** CLI timeout in ms */
  CLI_TIMEOUT_MS: 10_000,
} as const;
