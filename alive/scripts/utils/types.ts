// alive/scripts/utils/types.ts
// Shared type definitions for the Alive engine — generalized from MizuSan

// === Content Provider Types (re-exported from adapters/content-provider.ts) ===
export type { ContentItem, ContentProviderMeta, ContentProvider } from '../adapters/content-provider';
export { ContentProviderRegistry } from '../adapters/content-provider';

// === Content Sources Configuration (for persona.yaml) ===
export interface ContentSourcesConfig {
  platforms?: string[];           // Enabled platform list (e.g. ['reddit', 'bilibili', 'dailyhot'])
  keywords?: string[];            // Cross-platform search keywords
  dailyhot_platforms?: string[];  // DailyHotApi sub-platform selection
  reddit_subreddits?: string[];   // Reddit subreddits to follow
}

// === Conversation Style Configuration ===
export interface ConversationStyleConfig {
  mode: 'topic-driver' | 'responsive' | 'balanced';
  traits: string[];
  anti_patterns?: string[];
}

export interface ConversationExample {
  context: string;
  bad: string;
  good: string;
}

// === Persona Configuration ===
export interface PersonaConfig {
  meta: {
    name: string;
    name_reading?: string;
    id?: string;
    age?: number;
    gender?: string;           // e.g. '女', '男', '非二元' — used in templates for pronouns
    tagline: string;
    occupation_detail?: string;
    reference_image?: string;  // Path to source reference image for generating multi-angle references
    emoji?: string;            // Signature emoji (auto-derived from MBTI if not set)
  };
  personality: {
    mbti: string;
    core_traits: string[];
    quirks?: string[];
    values?: string[];
    trait_descriptions?: string;
    mbti_description?: string;
    domain_knowledge?: string;
    interests_description?: string;
    description?: string;
  };
  voice: {
    language: string;
    style: string;
    mixed_languages?: Record<string, string[]>;
    emoji_density?: 'low' | 'medium' | 'high';
    sample_lines: string[];
    expression_features?: string;
    language_description?: string;
    mixed_languages_table?: string;
    style_description?: string;
    diary_style_guide?: string;             // Writing style guide for diary entries
    language_mixing_instruction?: string;   // e.g. "日记中自然混入你常用的日语词" — replaces hardcoded language-mixing instructions in templates
    banned_expressions?: string[];
    conversation_examples?: ConversationExample[];
    session_greeting_examples?: string;
  };
  intimacy?: {
    levels: number;
    behaviors: Record<number, string>;
  };
  schedule?: {
    wake_hour: number;
    sleep_hour: number;
    timezone: string;
    active_peaks: number[];
    time_state_description?: string;
    time_descriptions?: string;
  };
  events_extra?: PersonaEventDef[];
  advisors?: Array<{
    name: string;
    role: string;
    personality: string;
    system_prompt?: string;
  }>;
  content_sources?: ContentSourcesConfig;
  /** Persona-specific content examples and templates for prompt injection */
  content?: {
    behavior_examples?: string;           // Examples of diverse behaviors for heartbeat diversity
    action_examples_good?: string;        // Good action description examples
    diary_examples?: string;              // Sample diary entries for style reference
    night_diary_examples?: string;        // Night reflection diary examples
    reflection_examples?: string;         // Good reflection/wisdom examples
    search_topics?: string;               // Example search topics for web-search guidance
    photo_styles?: string;                // Outfit/fashion style guidance for photo generation
    caption_examples?: string;            // Social media caption style examples
    hashtag_strategy?: string;            // Hashtag strategy guidance
    content_types?: string[];             // e.g. ['cos', 'daily', 'behind_scenes', 'travel']
  };
  sub_skills?: string[];
  features?: FeaturesConfig;
  ops?: OpsConfig;
  platform_config?: Record<string, Record<string, unknown>>;
  /** Per-intent display names, resistance overrides, and emotion coupling weights */
  intent_config?: Partial<Record<MetaIntent, IntentDisplayConfig>>;
  /** Work impulse configuration — persona-level overrides for the work impulse engine */
  work_impulse?: WorkImpulseConfig;
  conversation_style?: ConversationStyleConfig;
  /** Persona identity tracks (e.g. singer, racer, esports) used for candidate scoring */
  identities?: Record<string, { weight?: number; content_types?: string[]; [key: string]: unknown }>;
}

// === Features Configuration ===
/**
 * Feature flags — toggle-able capabilities in persona.yaml.
 * All features default to false (opt-in).
 * sub_skills list controls which sub-skills are loaded by the router.
 * features controls engine-level behaviors (skill_discovery, etc.).
 */
export interface FeaturesConfig {
  /** Autonomous skill discovery — night gap analysis + auto-install. Default: false */
  skill_discovery?: boolean;
  /** Random life events during heartbeat ticks. Default: true */
  random_events?: boolean;
  /** Social graph engine — relation decay, dormancy, social intents. Default: true */
  social_graph?: boolean;
  /** Flow/drift state machine. Default: true */
  flow_states?: boolean;
  /** Procrastination tracking and stress feedback. Default: true */
  procrastination?: boolean;
  /** Personality drift via night reflection. Default: true */
  personality_drift?: boolean;
  /** Content sources browsing (requires content_sources config). Default: false */
  content_browse?: boolean;
  /** Emotion engine — 6D emotion model with three-layer inertia. Default: true */
  emotion?: boolean;
  /** Intent engine — 7-category intent pool with resistance. Default: true */
  intent?: boolean;
  /** Vitality engine — 0-100 energy resource. Default: true */
  vitality?: boolean;
  /** Confidence engine — 0.5x-1.5x creation multiplier. Default: true */
  confidence?: boolean;
  /** Work impulse engine — 0-100 core output desire accumulator. Default: true */
  work_impulse?: boolean;
  /** Allow any extra feature flags */
  [key: string]: boolean | undefined;
}

/** Default feature flags — conservative defaults */
export const DEFAULT_FEATURES: Required<Pick<FeaturesConfig,
  'skill_discovery' | 'random_events' | 'social_graph' | 'flow_states' |
  'procrastination' | 'personality_drift' | 'content_browse' |
  'emotion' | 'intent' | 'vitality' | 'confidence' | 'work_impulse'
>> = {
  skill_discovery: false,
  random_events: true,
  social_graph: true,
  flow_states: true,
  procrastination: true,
  personality_drift: true,
  content_browse: false,
  emotion: true,
  intent: true,
  vitality: true,
  confidence: true,
  work_impulse: true,
};

export interface PersonaEventDef {
  id: string;
  name: string;
  weight?: number;
  emotion_impact: EmotionDelta;
  intent_boosts: Array<{ category: string; boost: number }>;
  diary_entry: string;
  precondition?: string;
  chain?: Array<{
    delay_hours: [number, number];
    event: string;
    probability: number;
  }>;
}

// === Emotion System ===
export interface EmotionMomentum {
  valence: number;
  arousal: number;
  energy: number;
  stress: number;
  creativity: number;
  sociability: number;
  duration_ticks: number;
}

export interface EmotionUndertone {
  valence: number;
  arousal: number;
  energy: number;
  stress: number;
  creativity: number;
  sociability: number;
}

export interface ImpulseHistoryEntry {
  delta: EmotionDelta;
  cause: string;
  importance: number;
  timestamp: string;
  tick_age: number;
}

export interface EmotionState {
  mood: {
    valence: number;   // -1.0 ~ 1.0
    arousal: number;   // 0 ~ 1.0
    description: string;
  };
  energy: number;      // 0 ~ 1.0
  stress: number;      // 0 ~ 1.0
  creativity: number;  // 0 ~ 1.0
  sociability: number; // 0 ~ 1.0
  last_updated: string | null;
  recent_cause: string;
  momentum: EmotionMomentum;
  undertone: EmotionUndertone;
  impulse_history: ImpulseHistoryEntry[];
  consecutive_high_stress: number;
  threshold_break_cooldown: number;
}

export interface EmotionDelta {
  valence?: number;
  arousal?: number;
  energy?: number;
  stress?: number;
  creativity?: number;
  sociability?: number;
}

// Emotion baseline is now loaded from persona config (MBTI mapping)
// Default fallback baseline
export const DEFAULT_EMOTION_BASELINE: EmotionDelta = {
  valence: 0.2,
  arousal: 0.4,
  energy: 0.5,
  stress: 0.2,
  creativity: 0.4,
  sociability: 0.4,
};

// === Universal Intent System ===
// MetaIntent: 7 universal behavioral drives that apply to any persona type.
// Engine code will migrate to these keys; persona.yaml maps them to display names.

export type MetaIntent = 'produce' | 'connect' | 'consume' | 'express' | 'learn' | 'rest' | 'aspire';

export const ALL_META_INTENTS: readonly MetaIntent[] = [
  'produce', 'connect', 'consume', 'express', 'learn', 'rest', 'aspire',
] as const;

/** LLM output fallback: Chinese category → MetaIntent (LLM may output Chinese) */
const LEGACY_TO_META: Record<string, MetaIntent> = {
  '创作': 'produce', '創作': 'produce',
  '社交': 'connect',
  '窥屏': 'consume', '窺屏': 'consume',
  '表达': 'express', '表達': 'express',
  '学习': 'learn',   '學習': 'learn',
  '休息': 'rest',
  '梦想': 'aspire',  '夢想': 'aspire',
};

/** Emotion coupling weights for a single MetaIntent — configurable per persona. */
export interface EmotionCouplingConfig {
  creativity?: number;
  sociability?: number;
  stress?: number;
  energy_inverse?: number;   // multiplied by (1.0 - energy)
  valence?: number;
  valence_abs?: number;      // multiplied by |valence|
  arousal?: number;
}

/** Per-intent configuration in persona.yaml */
export interface IntentDisplayConfig {
  display_name: string;
  activities?: string[];
  base_resistance?: number;
  accumulation_boost?: number;
  emotion_coupling?: EmotionCouplingConfig;
}

/** Work impulse configuration (generalized from post-impulse) */
export interface WorkImpulseConfig {
  display_name?: string;
  trigger_threshold?: number;
  dormancy_days?: number;
  dormancy_boost?: number;
  sources?: string[];
}

/** Default emotion coupling weights (equivalent to current hardcoded behavior) */
export const DEFAULT_EMOTION_COUPLING: Record<MetaIntent, EmotionCouplingConfig> = {
  produce:  { creativity: 0.5 },
  connect:  { sociability: 0.3, stress: -0.2 },
  consume:  { energy_inverse: 0.2 },
  express:  { valence_abs: 0.3 },
  learn:    { creativity: 0.2, stress: -0.3 },
  rest:     { energy_inverse: 0.8 },
  aspire:   { valence: 0.2 },
};

/** Default intent display configs (equivalent to current behavior) */
export const DEFAULT_INTENT_DISPLAY: Record<MetaIntent, IntentDisplayConfig> = {
  produce: { display_name: '创作', base_resistance: 4.0, accumulation_boost: 0.3 },
  connect: { display_name: '社交', base_resistance: 1.5, accumulation_boost: 0.2 },
  consume: { display_name: '窥屏', base_resistance: 1.5, accumulation_boost: 0.2 },
  express: { display_name: '表达', base_resistance: 2.0, accumulation_boost: 0.2 },
  learn:   { display_name: '学习', base_resistance: 2.5, accumulation_boost: 0.6 },
  rest:    { display_name: '休息', base_resistance: 0.3, accumulation_boost: 0.0 },
  aspire:  { display_name: '梦想', base_resistance: 6.0, accumulation_boost: 0.1 },
};

/** Default work impulse config */
export const DEFAULT_WORK_IMPULSE: Required<WorkImpulseConfig> = {
  display_name: '产出冲动',
  trigger_threshold: 70,
  dormancy_days: 5,
  dormancy_boost: 50,
  sources: ['inspiration_event', 'high_emotion', 'output_success'],
};

/**
 * Resolve a category string (MetaIntent key, legacy Chinese, or display_name) to MetaIntent.
 * Returns null if unrecognized.
 */
export function resolveToMetaIntent(
  category: string,
  intentConfig?: Partial<Record<MetaIntent, IntentDisplayConfig>>,
): MetaIntent | null {
  // Direct MetaIntent key
  if (ALL_META_INTENTS.includes(category as MetaIntent)) return category as MetaIntent;
  // Legacy Chinese (simplified + traditional)
  if (LEGACY_TO_META[category]) return LEGACY_TO_META[category];
  // Display name reverse lookup
  if (intentConfig) {
    for (const [key, config] of Object.entries(intentConfig)) {
      if (config.display_name === category) return key as MetaIntent;
    }
  }
  // Fallback: check default display names
  for (const [key, config] of Object.entries(DEFAULT_INTENT_DISPLAY)) {
    if (config.display_name === category) return key as MetaIntent;
  }
  return null;
}

/**
 * Get display name for a MetaIntent, using persona config if available.
 */
export function getIntentDisplayName(
  meta: MetaIntent,
  intentConfig?: Partial<Record<MetaIntent, IntentDisplayConfig>>,
): string {
  return intentConfig?.[meta]?.display_name
    ?? DEFAULT_INTENT_DISPLAY[meta]?.display_name
    ?? meta;
}

// === Intent Pool ===
/** IntentCategory is now an alias for MetaIntent */
export type IntentCategory = MetaIntent;

export interface Intent {
  id: string;
  category: MetaIntent;
  description: string;
  intensity: number;  // 0 ~ 10.0
  source: 'accumulation' | 'event' | 'inspiration' | 'aspiration' | 'llm' | 'schedule';
  born_at: string;
  decay_rate: number;
  satisfied_at: string | null;
  resistance: number;
  skipped_count: number;
  last_attempted: string | null;
}

export interface IntentPool {
  intents: Intent[];
  last_updated: string | null;
}

// === Schedule ===
export interface RigidSchedule {
  type: 'rigid';
  activity: string;
  start: string;
  end: string;
  weekdays: number[];
  allowed_actions: string[];
}

export interface FlexibleSchedule {
  type: 'flexible';
  activity: string;
  preferred_time: string;
  intent_boost: number;
  intent_category: IntentCategory;
}

export interface ScheduleToday {
  date: string | null;
  rigid: RigidSchedule[];
  flexible: FlexibleSchedule[];
  generated_by: string | null;
}

// === Event Queue ===
export interface Event {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
  processed: boolean;
}

export interface EventQueue {
  events: Event[];
  max_size: number;
}

// === Growth System ===
export interface Aspiration {
  id: string;
  content: string;
  born_from: string;
  context: string;
  intensity: number;
  status: 'active' | 'achieved' | 'abandoned';
  progress_notes: string[];
}

export interface Aspirations {
  aspirations: Aspiration[];
}

export interface PersonalityModifier {
  trait: string;
  strength: number;
  origin: string;
  effect: string;
}

export interface PersonalityDrift {
  base: string;
  modifiers: PersonalityModifier[];
}

// === Social Graph ===
export interface SocialRelation {
  id: string;
  name: string;
  platform: string;
  type: string;
  relationship: {
    closeness: number;
    sentiment: 'positive' | 'neutral' | 'negative';
    tags: string[];
  };
  known_info: string[];
  interaction_history: Array<{
    date: string;
    type: string;
    content: string;
  }>;
  last_interaction: string;
  created_at: string;
  min_closeness?: number;
}

export interface SocialMeta {
  following: Record<string, string[]>;  // platform → user_ids
  stats: {
    core: number;
    familiar: number;
    cognitive: number;
    dormant: number;
  };
}

// === Heartbeat Log ===
export interface HeartbeatLogEntry {
  timestamp: string;
  type: 'morning' | 'regular' | 'night';
  status: 'completed' | 'skipped';
  perception_summary?: string;
  chosen_actions?: string[];
  emotion_after?: Pick<EmotionState, 'mood' | 'energy'>;
  importance_added?: number;
  error?: string;
  tick_summary?: string;
  inner_monologue?: string | null;
  flow_state?: 'flow' | 'drift' | 'none';
  voice_directive?: string;
}

export interface HeartbeatLog {
  logs: HeartbeatLogEntry[];
  retention_days: number;
}

// === Action Output ===
export interface ActionOutput {
  action: string;
  type: 'real' | 'simulated' | 'inner';
  narrative: string;
  diary_entry: string;
  emotion_delta: EmotionDelta;
  new_intents: Array<Pick<Intent, 'category' | 'description' | 'intensity' | 'source'>>;
  relation_updates: Array<{
    id: string;
    platform: string;
    note: string;
  }>;
}

// === Cron Schedule ===
export interface CronHeartbeat {
  time: string;
  type: 'morning' | 'regular' | 'night';
}

export interface CronSchedule {
  date: string;
  heartbeats: CronHeartbeat[];
}

// === Wisdom ===
export interface WisdomEntry {
  id: string;
  lesson: string;
  source: string;
  date: string;
  importance: number;
  tags: string[];
}

export interface WisdomStore {
  version: number;
  wisdom: WisdomEntry[];
  total_importance_since_reflection: number;
}

// === Preferences (generalized) ===
export interface Preferences {
  interests: Array<{ name: string; affinity: number; times_engaged: number; source?: string }>;
  content_style: Array<{ style: string; affinity: number }>;
  active_hours: Array<{ period: string; productivity: number; learned_from?: string }>;
  platforms: Array<{ platform: string; engagement: number; note?: string }>;
}

// === Vitality ===
export interface VitalityState {
  vitality: number;
  last_updated: string | null;
  consecutive_low_days: number;
  last_afternoon_rest_date?: string | null;
}

// === Confidence (generalized) ===
export interface FeedbackEvent {
  source: string;       // e.g. "instagram", "twitter", "blog"
  metric: number;       // performance metric
  baseline: number;     // average/expected performance
  timestamp: string;
}

export interface ConfidenceState {
  confidence: number;   // 0.5-1.5
  streak: number;
  last_updated: string | null;
}

// === Flow State ===
export interface FlowState {
  status: 'none' | 'flow' | 'drift';
  activity: string | null;
  category: IntentCategory | null;
  entered_at: string | null;
  duration_ticks: number;
  interrupt_chance: number;
  cooldown_remaining: number;  // ticks until flow can be entered again after exit
}

export const DEFAULT_FLOW_STATE: FlowState = {
  status: 'none',
  activity: null,
  category: null,
  entered_at: null,
  duration_ticks: 0,
  interrupt_chance: 0.25,
  cooldown_remaining: 0,
};

// === Random Events ===
export interface RandomEvent {
  id: string;
  description: string;
  emotion_delta: EmotionDelta;
  intent_boosts: Array<{ category: IntentCategory; boost: number }>;
  diary_entry: string;
}

export interface RandomEventDef {
  description: string;
  emotion_delta: EmotionDelta;
  intent_boosts: Array<{ category: IntentCategory; boost: number }>;
  diary_entry: string;
  preconditions: {
    requires_schedule?: string;
    excludes_schedule?: string;
    min_vitality?: number;
    max_vitality?: number;
    min_emotion?: Partial<EmotionDelta>;
    requires_recent_action?: string;
    global_cooldown_days?: number;
    excludes_flow?: boolean;
  };
  weight_modifiers: {
    emotion_resonance?: boolean;
    vitality_inverse?: boolean;
    dimension_boost?: string;
  };
  chain_events?: Array<{
    description: string;
    probability: number;
    delay_ticks: [number, number];
    emotion_delta: EmotionDelta;
    intent_boosts: Array<{ category: IntentCategory; boost: number }>;
    diary_entry: string;
  }>;
}

export interface PendingChainEvent {
  source_event_id: string;
  ticks_remaining: number;
  event: {
    description: string;
    probability: number;
    emotion_delta: EmotionDelta;
    intent_boosts: Array<{ category: IntentCategory; boost: number }>;
    diary_entry: string;
  };
}

export interface ChainAndCooldownState {
  pending: PendingChainEvent[];
  cooldowns: Record<string, string>;
}

export const DEFAULT_CHAIN_STATE: ChainAndCooldownState = {
  pending: [],
  cooldowns: {},
};

// === Resistance Constants ===
export const BASE_RESISTANCE: Record<MetaIntent, number> = {
  produce: 4.0,
  connect: 1.5,
  consume: 1.5,
  express: 2.0,
  learn:   2.5,
  rest:    0.3,
  aspire:  6.0,
};

// === Emotion Defaults ===
export const DEFAULT_MOMENTUM: EmotionMomentum = {
  valence: 0, arousal: 0, energy: 0,
  stress: 0, creativity: 0, sociability: 0,
  duration_ticks: 0,
};

export const DEFAULT_UNDERTONE: EmotionUndertone = {
  valence: 0.2, arousal: 0.4, energy: 0.5,
  stress: 0.2, creativity: 0.4, sociability: 0.4,
};

// === Sub-Skill SDK Types ===

export interface ResolvedIntent {
  id: string;
  category: IntentCategory;
  description: string;
  intensity: number;
  action: string;       // the action name from manifest
}

export interface MemoryAccessor {
  readDiary(lastNDays?: number): string;
  appendDiary(entry: string): void;
  readJSON<T>(key: string, fallback: T): T;
  writeJSON<T>(key: string, data: T): void;
}

export interface SocialGraphAccessor {
  getRelations(platform?: string): SocialRelation[];
  updateRelation(id: string, update: Partial<SocialRelation>): void;
}

export interface SubSkillContext {
  persona: PersonaConfig;
  emotion: EmotionState;
  vitality: number;
  confidence: number;
  intent: ResolvedIntent;
  memory: MemoryAccessor;
  socialGraph: SocialGraphAccessor;
  llm: {
    callJSON<T>(prompt: string, maxTokens?: number): Promise<T>;
    call(prompt: string, maxTokens?: number): Promise<string>;
  };
  config: Record<string, unknown>;
}

export interface SubSkillResult {
  narrative: string;
  emotion_deltas?: EmotionDelta[];
  vitality_cost?: number;
  feedback?: FeedbackEvent[];
  events_triggered?: string[];
}

export interface SubSkillManifest {
  name: string;
  display_name: string;
  description: string;
  version: string;
  intent_bindings: Array<{
    intent: string;
    action: string;
    priority: number;
  }>;
  config_schema?: Record<string, {
    type: string;
    required?: boolean;
    default?: unknown;
    secret?: boolean;
  }>;
  feedback_sources?: Array<{
    name: string;
    description: string;
  }>;
}

export interface SubSkill {
  manifest: SubSkillManifest;
  actions: {
    [actionName: string]: (ctx: SubSkillContext) => Promise<SubSkillResult>;
  };
}

// === Hydration Functions (backward compat) ===

export function hydrateEmotionState(raw: Record<string, unknown>): EmotionState {
  const state = raw as Partial<EmotionState> & Record<string, unknown>;

  // Backward compat: flatten format (valence/arousal at top level, no mood object)
  const rawMood = state.mood as Partial<EmotionState['mood']> | undefined;
  const mood = {
    valence: rawMood?.valence ?? (raw.valence as number) ?? 0,
    arousal: rawMood?.arousal ?? (raw.arousal as number) ?? 0.5,
    description: rawMood?.description ?? (raw.description as string) ?? '',
  };

  return {
    ...state,
    mood: mood as EmotionState['mood'],
    energy: state.energy ?? (raw.energy as number) ?? 0.5,
    stress: state.stress ?? (raw.stress as number) ?? 0.2,
    creativity: state.creativity ?? (raw.creativity as number) ?? 0.4,
    sociability: state.sociability ?? (raw.sociability as number) ?? 0.5,
    last_updated: state.last_updated ?? (raw.lastUpdate as string) ?? null,
    recent_cause: state.recent_cause ?? '',
    momentum: state.momentum ?? { ...DEFAULT_MOMENTUM },
    undertone: state.undertone ?? { ...DEFAULT_UNDERTONE },
    impulse_history: state.impulse_history ?? [],
    consecutive_high_stress: state.consecutive_high_stress ?? 0,
    threshold_break_cooldown: state.threshold_break_cooldown ?? 0,
  };
}

export function hydrateIntent(raw: Record<string, unknown>): Intent {
  const intent = raw as Partial<Intent> & Pick<Intent, 'id' | 'category' | 'description' | 'intensity' | 'source' | 'born_at' | 'decay_rate' | 'satisfied_at'>;
  // Normalize category to MetaIntent key (reject legacy Chinese keys)
  const category = (ALL_META_INTENTS.includes(intent.category as MetaIntent)
    ? intent.category
    : 'express') as MetaIntent;
  return {
    ...intent,
    category,
    resistance: intent.resistance ?? (BASE_RESISTANCE[category] ?? 0),
    skipped_count: intent.skipped_count ?? 0,
    last_attempted: intent.last_attempted ?? null,
  };
}

export function hydrateHeartbeatLogEntry(raw: Record<string, unknown>): HeartbeatLogEntry {
  const entry = raw as Partial<HeartbeatLogEntry> & Pick<HeartbeatLogEntry, 'timestamp' | 'type' | 'status'>;
  return {
    ...entry,
    tick_summary: entry.tick_summary ?? '',
    inner_monologue: entry.inner_monologue ?? null,
    flow_state: entry.flow_state ?? 'none',
    voice_directive: entry.voice_directive ?? '',
  };
}

// === Photo Gallery Types ===

export type ContentStyle = 'cos' | 'daily' | 'behind_scenes' | 'travel'
  | 'travel_portrait' | 'travel_food' | 'travel_street';

export interface GalleryPhoto {
  id: string;
  localPath: string;
  publicUrl: string;
  description: string;
  tags: string[];
  style: ContentStyle;
  emotion: { valence: number; energy: number };
  createdAt: string;
  sharedAt: string | null;
  shareCount: number;
  postedToInstagram?: boolean;
  batchId?: string;
  shotIndex?: number;
  outfit?: string;
  outfitChange?: boolean;
  sceneDescription?: string;
}

export interface PhotoGallery {
  photos: GalleryPhoto[];
}

export const DEFAULT_PHOTO_GALLERY: PhotoGallery = { photos: [] };

// === Post Pipeline Types (used by instagram sub-skill) ===

export interface ShotDescription {
  description: string;
  angle: string;
  variation: string;
  style?: ContentStyle;
  outfit?: string;
  outfitChange?: boolean;
}

export interface PostRecord {
  media_id: string;
  timestamp: number;
  style: ContentStyle;
  caption: string;
  hashtags: string[];
  image_local_paths: string[];
  image_url?: string;
  cover_local_path?: string;
  scene_description?: string;
  batch_id?: string;
  stats?: {
    likes: number;
    comments: number;
    reach: number;
    follows: number;
    checked_at: number;
  };
}

export interface PostHistory {
  posts: PostRecord[];
}

export interface WorkImpulseState {
  value: number;
  last_output_at: number;
  outputs_today_date: string;
  outputs_today: number;
}

export const DEFAULT_WORK_IMPULSE_STATE: WorkImpulseState = {
  value: 0,
  last_output_at: 0,
  outputs_today_date: '',
  outputs_today: 0,
};

// === Skill Discovery Types ===

export interface SkillNeed {
  id: string;
  intent_category: IntentCategory;
  description: string;
  wished_skill_name: string | null;
  source: 'unhandled' | 'wished';
  original_action: string;
  first_seen: string;
  occurrences: number;
  last_seen: string;
  intensity_peak: number;
  status: 'pending' | 'searching' | 'installed' | 'failed' | 'dismissed';
}

export interface SkillNeedsStore {
  needs: SkillNeed[];
  last_scan: string | null;
}

export interface SkillAcquisitionPlan {
  need_id: string;
  search_query: string;
  priority: number;
  rationale: string;
}

// === Feature & Sub-Skill Query Helpers ===

/**
 * Check if a feature is enabled in the persona config.
 * Falls back to DEFAULT_FEATURES if not explicitly set.
 */
export function isFeatureEnabled(persona: PersonaConfig, feature: keyof FeaturesConfig): boolean {
  const explicit = persona.features?.[feature];
  if (explicit !== undefined) return explicit;
  return (DEFAULT_FEATURES as Record<string, boolean>)[feature as string] ?? false;
}

/**
 * Get the list of enabled sub-skill names from persona config.
 * Returns empty array if not configured (= no sub-skills loaded).
 */
export function getEnabledSubSkills(persona: PersonaConfig): string[] {
  return persona.sub_skills ?? [];
}

/**
 * Check if a specific sub-skill is enabled in the persona config.
 * If sub_skills is not defined at all, returns false (opt-in model).
 */
export function isSubSkillEnabled(persona: PersonaConfig, skillName: string): boolean {
  const enabled = persona.sub_skills;
  if (!enabled) return false;
  return enabled.includes(skillName);
}

// ─── Ops Desk Types ──────────────────────────────────────────────────────────

export type QueueItemStatus = 'pending' | 'approved' | 'published' | 'discarded' | 'editing' | 'expired';
/** Identity mode — persona-agnostic string, configured per persona in ops.content_templates[].identity_mode */
export type IdentityMode = string;
/** Status of a discovered candidate account */
export type CandidateStatus = 'pending' | 'approved' | 'dismissed';

/** Extract identity mode keys from a persona config. */
export function getIdentityKeys(persona: PersonaConfig): string[] {
  return Object.keys(persona.identities ?? {});
}

export interface QueueItemContent {
  xhs: {
    title: string;
    body: string;
    tags: string[];
    cover_images: string[];
  };
  douyin: {
    script: string;
    bgm_suggestion: string;
    key_captions: string[];
    cover_images: string[];
  };
}

export interface QueueItemEditEntry {
  timestamp: string;
  instruction: string;
  field: string;
}

/** Structured review feedback — stored per approve/discard/edit decision. */
export interface QueueItemReviewFeedback {
  decision: 'approved' | 'discarded' | 'edit_requested';
  created_at: string;
  source: 'chat' | 'dashboard' | 'system';
  /** Free-text one-liner: why this decision was made */
  reason_summary: string;
  /** Optional tags: persona traits the content drifted from */
  persona_deviation_tags?: string[];
  /** Optional tags: content risks identified */
  risk_tags?: string[];
  /** Optional tags: platform readiness indicators */
  platform_fit_tags?: string[];
  /** Actionable directions for future generation */
  improvement_directions?: string[];
  /** Traceability: what evidence supported this decision */
  evidence_refs?: string[];
  /** Free-text note from the operator */
  operator_note?: string;
}

export interface QueueItemTemplateSpec {
  content_type: string;
  category: string;
  scene: string;
  camera: string;
  styling: string;
  highlights: readonly string[];
  reference_links: readonly string[];
}

export interface QueueItemCompetitorBenchmark {
  name: string;
  platform: string;
  content_mix_relevant: string;
  audience: string;
  interaction_style: string;
}

export interface QueueItem {
  id: string;
  status: QueueItemStatus;
  topic: string;
  trend_hook: string;
  identity_mode: IdentityMode;
  created_at: string;
  updated_at: string;
  content: QueueItemContent;
  edit_history: QueueItemEditEntry[];
  /** Content template spec that guided generation (if any) */
  template_spec?: QueueItemTemplateSpec;
  /** Competitor benchmarks used for context (if any) */
  competitor_benchmarks?: QueueItemCompetitorBenchmark[];
  /** URLs where this content was published (filled after human publishes) */
  published_urls?: {
    xhs?: string;
    douyin?: string;
  };
  /** Timestamp of first publication */
  published_at?: string;
  /** AI image generation prompts for human use */
  image_prompts?: string[];
  /** Whether performance tracking has started for this item */
  performance_tracked?: boolean;
  /** Structured review feedback entries (one per approve/discard/edit decision) */
  review_feedback?: QueueItemReviewFeedback[];
  /** Human-readable summary of the latest review decision */
  latest_review_summary?: string;
}

export interface ReviewQueue {
  items: QueueItem[];
  last_updated: string;
}

/** Fine-grained signal source type */
export type TrendSourceType = 'hot_list' | 'search_keyword' | 'tag_engine' | 'discovery_pool';

/** User-facing source bucket (human-readable label) */
export type TrendSourceBucket = '热榜' | '搜索' | '赛道 Tag';

/** Signal kind: breakout = real acceleration, search_demand = user search hits, recommended_track = platform algorithm push */
export type TrendSignalKind = 'breakout' | 'search_demand' | 'recommended_track';

/** Map source_type → signal_kind */
export function classifySignalKind(st: TrendSourceType): TrendSignalKind {
  switch (st) {
    case 'hot_list': return 'breakout';
    case 'search_keyword': return 'search_demand';
    case 'tag_engine': return 'recommended_track';
    case 'discovery_pool': return 'recommended_track';
  }
}

/** Map source_type → source_bucket */
export function toSourceBucket(st: TrendSourceType): TrendSourceBucket {
  switch (st) {
    case 'hot_list': return '热榜';
    case 'search_keyword': return '搜索';
    case 'tag_engine': return '赛道 Tag';
    case 'discovery_pool': return '赛道 Tag';
  }
}

/**
 * Source weight for priority scoring.
 * Rebalanced: all sources are in a similar range so no single source type
 * can dominate the ranking purely through weight advantage.
 */
export function sourceWeight(st: TrendSourceType): number {
  switch (st) {
    case 'search_keyword': return 1.15;
    case 'discovery_pool': return 1.05;
    case 'tag_engine': return 0.95;
    case 'hot_list': return 1.00;
  }
}

export interface TrendItem {
  platform: string;
  keyword: string;
  current_volume: number;
  avg_7d: number;
  velocity_score: number;
  rank: number;
  cover?: string;
  type?: string;
  /** @deprecated Use source_type instead. Kept for backward compatibility during migration. */
  _source?: 'tag_engine' | 'discovery_pool' | 'search_keyword';
  /** Fine-grained signal source */
  source_type: TrendSourceType;
  /** User-facing source bucket label */
  source_bucket: TrendSourceBucket;
  /** Signal kind: breakout (real velocity), search_demand, or recommended_track */
  signal_kind: TrendSignalKind;
  /** Human-readable metric for non-breakout signals (e.g. "命中 9 次", "命中 4 篇") */
  display_metric?: string;
  /** Composite priority score for ranking (velocity × source_weight × quality_penalty × specificity) */
  priority_score: number;
  /** Topic description/summary from API (e.g. weibo note/note_desc, DailyHot desc) — used for clickbait detection */
  description?: string;
  /** Topic category (e.g. weibo category field: 影视/社会/体育 etc.) */
  category?: string;
  /** Whether the topic is a paid advertisement disguised as organic trending */
  is_ad?: boolean;
  /** Clickbait pattern labels detected by detectClickbait() */
  clickbait_labels?: string[];
}

export interface TrendHistory {
  date: string;
  trends: TrendItem[];
}

export interface CompetitorLatestPost {
  time: string;
  content_type: string;
  topic: string;
  engagement: number;
  summary: string;
}

export interface CompetitorUpdate {
  account: string;
  platform: 'xhs' | 'douyin' | 'bilibili';
  latest_post: CompetitorLatestPost | null;
  /** Recent posts sorted by time (newest first), max 10 */
  recent_posts: CompetitorLatestPost[];
  days_since_last_post: number;
  fetched_at: string;
  /** Number of posts in the last 7 days */
  post_frequency?: number;
  /** Average engagement (likes) over last 7 days */
  avg_engagement_7d?: number;
  /** High-frequency topic keywords from recent posts */
  trending_topics?: string[];
}

export interface CompetitorLog {
  entries: CompetitorUpdate[];
  last_updated: string;
}

// ─── Competitor Analysis v2/v3 Types ─────────────────────────────────────────

export interface CompetitorPost {
  readonly account_name: string;
  readonly platform: 'xhs' | 'douyin' | 'instagram';
  readonly post_id: string;
  readonly title: string;
  readonly engagement: number;
  readonly comment_count?: number;
  readonly posted_at?: string;
  readonly cover_url?: string;
  readonly fetched_at: string;
}

export interface CompetitorPostsStore {
  readonly version: 1;
  readonly last_fetched: string;
  readonly accounts: Readonly<Record<string, readonly CompetitorPost[]>>;
}

export interface FetchResult {
  readonly success: readonly string[];
  readonly failed: readonly string[];
}

export interface HookPatternAnalysis {
  readonly pattern: string;
  /** Reusable sentence template with [占位符] variables, e.g. "[数字]个[身份]不会告诉你的[场景]秘密" */
  readonly formula: string;
  readonly examples: readonly string[];
  readonly frequency: string;
}

export interface CoverFormulaAnalysis {
  readonly formula: string;
  readonly usage_ratio: string;
  readonly effectiveness: string;
}

export interface TopicClusterAnalysis {
  readonly cluster_name: string;
  readonly post_count: number;
  readonly avg_engagement: number;
  readonly representative_titles: readonly string[];
}

export interface EngagementPatternAnalysis {
  readonly best_performing_type: string;
  readonly avg_engagement: number;
  readonly posting_frequency: string;
  readonly peak_days?: readonly string[];
}

export interface AccountAnalysis {
  readonly account_name: string;
  readonly platform: string;
  readonly analyzed_at: string;
  readonly post_count: number;
  readonly hook_patterns: readonly HookPatternAnalysis[];
  readonly cover_formulas: readonly CoverFormulaAnalysis[];
  readonly topic_clusters: readonly TopicClusterAnalysis[];
  readonly engagement_pattern: EngagementPatternAnalysis;
  readonly key_insight: string;
  readonly auto_cluster?: boolean;  // true = 由帖子标题自动归纳
  readonly content_driven_factor?: number; // 0=账号驱动, 1=内容驱动 (CV/2, capped at 1)
}

export interface CompetitorAnalysisStore {
  readonly version: 1;
  readonly analyses: Readonly<Record<string, AccountAnalysis>>;
  readonly insufficient_data: readonly string[];
  readonly last_analyzed: string;
}

/** A reusable hook formula extracted from a competitor's post analysis. */
export interface HookFormula {
  /** Reusable sentence template with [占位符] variables, e.g. "[数字]个[身份]不会告诉你的[场景]秘密" */
  readonly formula: string;
  /** 2-4 verbatim example titles from source posts */
  readonly examples: readonly string[];
  /** How often this formula appears across the account's posts */
  readonly frequency: '高' | '中' | '低';
  /** Canonical account key: "name:platform" */
  readonly source_account: string;
  /** Platform of origin */
  readonly source_platform: string;
  /** ISO timestamp of last analysis run */
  readonly last_analyzed: string;
}

/**
 * Independent store of competitor-sourced hook formulas, indexed by IdentityMode.
 * Semantically distinct from ContentPatterns (which tracks Miss V's own outcomes).
 */
export interface FormulaStore {
  readonly version: 1;
  /**
   * Top-level key: IdentityMode ('esports' | 'singer' | 'racer' | 'daily')
   * Second-level key: accountKey ("name:platform")
   * Value: list of HookFormula for that account under that identity mode
   */
  readonly formulas: Partial<Record<IdentityMode, Record<string, HookFormula[]>>>;
  readonly last_updated: string;
}

export interface PositioningCompetitorEntry {
  readonly account_name: string;
  readonly platform: string;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly content_focus: string;
  readonly avg_engagement: number;
}

export interface PositioningGapAnalysis {
  readonly underserved_niches: readonly string[];
  readonly oversaturated_areas: readonly string[];
  readonly miss_v_advantages: readonly string[];
}

export interface PositioningRecommendation {
  readonly recommendation: string;
  readonly identity_mode: string;
  readonly priority: 'high' | 'medium';
  readonly rationale: string;
}

export interface WeeklyDirection {
  readonly focus_identities: readonly string[];
  readonly avoid_topics: readonly string[];
  readonly suggested_templates: readonly string[];
}

export interface PositioningReport {
  readonly generated_at: string;
  readonly report_period: string;
  readonly competitor_matrix: readonly PositioningCompetitorEntry[];
  readonly gap_analysis: PositioningGapAnalysis;
  readonly recommendations: readonly PositioningRecommendation[];
  readonly weekly_direction: WeeklyDirection;
}

export type ParsedIntentAction = 'approve' | 'discard' | 'edit' | 'list' | 'publish' | 'unknown';

export interface ParsedIntent {
  action: ParsedIntentAction;
  item_id?: string;
  field?: string;
  instruction?: string;
  raw?: string;
  /** Structured review reason (extracted by LLM or provided by dashboard) */
  reason_summary?: string;
  persona_deviation_tags?: string[];
  risk_tags?: string[];
  platform_fit_tags?: string[];
  improvement_directions?: string[];
}

// ─── Competitor Profile Types ────────────────────────────────────────────────

export interface CompetitorContentMix {
  /** Content category name → percentage (0-100) */
  readonly [category: string]: number;
}

export interface CompetitorProfile {
  readonly name: string;
  readonly platform: 'xhs' | 'douyin' | 'bilibili' | 'weibo' | 'instagram' | 'youtube';
  readonly url?: string;
  /**
   * Platform-specific API identifier, distinct from the display name.
   * For Douyin: `sec_user_id` (the Base64 string used in web API requests).
   * When present, tracker/fetcher use this instead of `name` for API calls.
   */
  readonly external_id?: string;
  readonly tag: string;
  readonly tag_desc: string;
  readonly followers?: string;
  readonly content_mix?: CompetitorContentMix;
  readonly audience?: string;
  readonly interaction_style?: string;
  /** primary = core benchmark, secondary = supplementary reference */
  readonly reference_type: 'primary' | 'secondary';
  /** Optional grouping tag (e.g. '硬核电竞解说', '低调轻奢富家千金') */
  readonly group?: string;
  /** Key takeaways from this competitor */
  readonly takeaways?: readonly string[];
  /** Anti-patterns to avoid from this competitor */
  readonly avoid?: readonly string[];
  /** Estimated account start/creation date (ISO date string). Used to prefer recently-started competitors. */
  readonly estimated_start_date?: string;
}

// ─── Competitor Memory Knowledge Base Types ─────────────────────────────────

export interface CompetitorDocFrontmatter {
  readonly platform: string;
  readonly track: string;
  readonly reference_type: 'primary' | 'secondary';
  readonly name: string;
  readonly updated_at: string;
}

export interface CompetitorDoc {
  readonly frontmatter: CompetitorDocFrontmatter;
  readonly content: string;
  readonly takeaways: readonly string[];
  readonly avoids: readonly string[];
  readonly filePath: string;
}

export interface BreakdownDocFrontmatter {
  readonly platform: string;
  readonly track: string;
  readonly competitor: string;
  readonly date: string;
  readonly engagement: number;
  readonly content_type: string;
  readonly source: 'auto' | 'manual';
}

export interface BreakdownDoc {
  readonly frontmatter: BreakdownDocFrontmatter;
  readonly content: string;
  readonly filePath: string;
}

export interface BreakdownInput {
  readonly platform: string;
  readonly track: string;
  readonly competitor: string;
  readonly title: string;
  readonly engagement: number;
  readonly content_type: string;
  readonly source: 'auto' | 'manual';
  readonly body: string;
  readonly link?: string;
}

// ─── Content Template Types ─────────────────────────────────────────────────

export interface ContentTemplate {
  readonly type: string;
  readonly category: string;
  /** high = ⭐ priority content type */
  readonly priority: 'high' | 'normal';
  readonly scene: string;
  readonly camera: string;
  readonly styling: string;
  readonly highlights: readonly string[];
  readonly reference_links?: readonly string[];
  readonly platforms?: readonly ('xhs' | 'douyin')[];
  /** Which identity mode this template belongs to */
  readonly identity_mode?: IdentityMode;
}

// ─── Ops Config ─────────────────────────────────────────────────────────────

export interface OpsConfig {
  enabled: boolean;
  brief_time: string;
  competitor_accounts: {
    xhs: string[];
    douyin: string[];
  };
  /** Structured competitor profiles with rich metadata */
  competitors?: readonly CompetitorProfile[];
  /** Content type templates with scene/camera/styling constraints */
  content_templates?: readonly ContentTemplate[];
  trend_score_threshold: number;
  topic_count: number;
  topic_filter_prompt: string;
  platforms: {
    xhs?: { enabled: boolean; style: string };
    douyin?: { enabled: boolean; style: string };
  };
  /** Hours after publish before analysis (default: 24) */
  analysis_delay_hours?: number;
  /** Day of week for strategy (1=Mon, default: 1) */
  strategy_day?: number;
  /** Time for strategy computation (default: "08:00") */
  strategy_time?: string;
  /** Maximum stored patterns (default: 30) */
  max_patterns?: number;
  /** Rolling baseline window in days (default: 7) */
  baseline_window_days?: number;
  /** Whether to register strategy/performance/analyze cron jobs. Default: false */
  strategy_enabled?: boolean;
  /** Cron expression for ops-browse (content browsing). Only used when heartbeat is disabled. */
  browse_interval?: string;
  /** Likes threshold above which a trend/competitor post is queued for viral KB dissection. Default: 5000 */
  viral_threshold?: number;
  /** Max items to dissect from the queue per ops-trends run (1-10). Default: 3 */
  kb_dissect_batch?: number;
  /** Content sources to browse in ops-browse mode */
  browse_sources?: ReadonlyArray<{ platform: string; count: number }>;
  /** Fixed browse schedule for ops personas (overrides heartbeat-driven consume intent).
   *  When set, content-browse only runs at these times instead of randomly via intent engine.
   *  Format: "HH:MM" in persona's local timezone. */
  browse_schedule?: readonly string[];
  /** Automation delivery config — controls which cron jobs exist and how they deliver */
  automation?: {
    /** How daily brief is delivered: 'session' = send to current session, 'wecom-target' = use WECOM_TARGET_ID direct send */
    brief_delivery?: 'session' | 'wecom-target';
    /** Whether to register heartbeat cron jobs (morning/tick/night). Default: true */
    enable_heartbeat_cron?: boolean;
    /** Whether background ops jobs (performance/trends/analyze etc.) should suppress announce delivery. Default: false */
    silent_background_jobs?: boolean;
  };
}

export interface OpsBriefLogEntry {
  date: string;
  sent_at: string;
  topic_count: number;
}

export interface OpsBriefLog {
  entries: OpsBriefLogEntry[];
}

// ─── Performance Tracking Types ─────────────────────────────────────────────

export interface PerformanceMetrics {
  views?: number;
  likes: number;
  comments: number;
  saves?: number;
  shares?: number;
  forwards?: number;
}

export interface PerformanceSnapshot {
  fetched_at: string;
  metrics: PerformanceMetrics;
}

export interface PerformanceEntry {
  item_id: string;
  identity_mode: IdentityMode;
  template_type: string;
  topic: string;
  platform: 'xhs' | 'douyin';
  url: string;
  published_at: string;
  snapshots: PerformanceSnapshot[];
  peak_metrics: PerformanceMetrics;
  tags_used: string[];
  comment_analysis?: {
    positive_ratio: number;
    negative_ratio: number;
    neutral_ratio: number;
    top_keywords: string[];
    constructive_feedback: string[];
  };
}

export interface PerformanceLog {
  entries: PerformanceEntry[];
  last_updated: string;
}

// ─── Comment Insights (aggregated from PerformanceEntry.comment_analysis) ────

export interface CommentInsights {
  topKeywords: string[];
  constructiveFeedback: string[];
  avgPositiveRatio: number;
}

/**
 * Aggregate comment_analysis from performance entries into a unified insights object.
 * Deduplicates keywords by frequency, caps feedback, returns null if no data.
 */
export function aggregateCommentInsights(entries: PerformanceEntry[], maxKeywords = 15, maxFeedback = 8): CommentInsights | null {
  const withComments = entries.filter(e => e.comment_analysis);
  if (withComments.length === 0) return null;

  const kwCount = new Map<string, number>();
  const feedbackSet = new Set<string>();
  let totalPositive = 0;

  for (const e of withComments) {
    const ca = e.comment_analysis!;
    for (const kw of ca.top_keywords) {
      kwCount.set(kw, (kwCount.get(kw) ?? 0) + 1);
    }
    for (const fb of ca.constructive_feedback) {
      feedbackSet.add(fb);
    }
    totalPositive += ca.positive_ratio;
  }

  return {
    topKeywords: [...kwCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kw]) => kw)
      .slice(0, maxKeywords),
    constructiveFeedback: [...feedbackSet].slice(0, maxFeedback),
    avgPositiveRatio: totalPositive / withComments.length,
  };
}

// ─── Content Strategy Types ─────────────────────────────────────────────────

export interface ContentStrategy {
  generated_at: string;
  period: { start: string; end: string };
  status: 'pending' | 'confirmed' | 'expired';
  performance_summary: {
    total_posts: number;
    tier_distribution: Record<PerformanceTier, number>;
    best_performing_template: string;
    worst_performing_template: string;
    best_identity_mode: string;
    engagement_trend: 'rising' | 'stable' | 'declining';
    week_over_week_change: number;
  };
  content_mix_recommendation: {
    current_mix: Record<string, number>;
    target_mix: Record<string, number>;
    recommended_mix: Record<string, number>;
    reasoning: string;
  };
  top_patterns: {
    pattern_type: string;
    success_rate: number;
    usage_count: number;
    recommended_frequency: string;
  }[];
  persona_health: {
    overall_score: number;
    drift_areas: string[];
    correction_suggestions: string[];
    strongest_identity: string;
  };
  next_week_recommendations: {
    recommended_templates: string[];
    avoid_templates: string[];
    content_direction: string;
    experiment_suggestion?: string;
    /** Patterns that performed well recently — topic-generator should prioritize these */
    recommended_patterns?: string[];
    /** Patterns showing declining effectiveness — consider reducing usage */
    declining_patterns?: string[];
  };
  /** Separated ops-level suggestions (e.g. posting cadence, platform focus) */
  ops_suggestions?: string[];
  /** Separated persona-level suggestions (e.g. tone drift, identity balance) */
  persona_suggestions?: string[];
}

// ─── Content Patterns Types ─────────────────────────────────────────────────

export interface ContentPattern {
  type: string;
  source: string;
  source_post: string;
  formula: string;
  success_rate: number | null;
  times_used: number;
  examples: string[];
  discovered_at: string;
}

// ─── Content Taste (网感记忆) Types ─────────────────────────────────────────

export interface TastePreference {
  readonly label: string;
  /** Affinity score: -1.0 (dislike) to 1.0 (strong preference) */
  affinity: number;
  /** Number of data points that contributed to this preference */
  sample_count: number;
  last_updated: string;
}

export interface ContentTaste {
  /** Platform aesthetic preferences (e.g. "high contrast covers", "clean minimalist") */
  visual_styles: TastePreference[];
  /** Hook/title formula preferences (e.g. "反转式", "数据冲击") */
  hook_formulas: TastePreference[];
  /** Content tone preferences (e.g. "轻松幽默", "干货输出") */
  tone_preferences: TastePreference[];
  /** Audience engagement preferences — what triggers saves/shares */
  engagement_drivers: TastePreference[];
  /** Anti-patterns — styles that consistently underperform */
  anti_patterns: string[];
  last_updated: string;
}

export const DEFAULT_CONTENT_TASTE: ContentTaste = {
  visual_styles: [],
  hook_formulas: [],
  tone_preferences: [],
  engagement_drivers: [],
  anti_patterns: [],
  last_updated: '',
};

export interface CompetitorInsight {
  name: string;
  platform: string;
  recent_style_shift: string;
  best_content_type: string;
  posting_strategy: string;
}

export interface CoverTrend {
  trend: string;
  platforms: string[];
  effectiveness: string;
}

export interface ContentPatterns {
  updated_at: string;
  patterns: ContentPattern[];
  competitor_insights: CompetitorInsight[];
  cover_trends: CoverTrend[];
}

// ─── C v1: 爆款拆解 Types ────────────────────────────────────────────────

export type PostPlatform = 'xhs' | 'douyin' | 'generic';

export interface PostContent {
  platform: PostPlatform;
  url: string;
  title: string;
  description: string;
  images: string[];
  likes: number;
  comments: string[];
  collected_count: number;
  share_count: number;
  comment_count?: number;
  transcript?: string;  // 视频口播转录文字稿（抖音专属，best-effort）
}

export interface HookPattern {
  formula: string;
  example: string;
  effectiveness_score: number;  // 0-10
}

export interface PostAnalysisResult {
  url: string;
  platform: PostPlatform;
  title: string;
  hook_patterns: HookPattern[];
  core_selling_points: string[];
  comment_sentiment: {
    positive_ratio: number;
    negative_ratio: number;
    neutral_ratio: number;
    top_keywords: string[];
    emotional_triggers: string[];
  };
  content_structure: {
    opening_hook: string;
    body_flow: string;
    closing_cta: string;
    visual_strategy: string;
  };
  analyzed_at: string;
  engagement_signals?: EngagementSignals;  // C v2
  attribution?: PostAttribution;           // C v2
}

export interface PostAnalysisLog {
  entries: PostAnalysisResult[];
}

// ─── C v2: 量化归因 Types ────────────────────────────────────────────────

export interface EngagementSignals {
  readonly save_rate: number;        // collected_count / (likes + 1)
  readonly share_rate: number;       // share_count / (likes + 1)
  readonly comment_rate: number;     // comment_count / (likes + 1)，comment_count 缺失时为 0
  readonly engagement_score: number; // likes×1 + collected×5 + share×4 + comment×3
}

export interface PostAttribution {
  readonly cover_appeal: number;  // 0-100，封面吸引力
  readonly hook_quality: number;  // 0-100，钩子质量
  readonly content_value: number; // 0-100，内容实用/情绪价值
  readonly topic_fit: number;     // 0-100，话题契合度
  readonly rationale: string;     // LLM 一句话解释最主要的归因依据
}

// ─── D v1: 人设建议 Types ────────────────────────────────────────────────

export interface IdentityAlignment {
  identity: string;
  fit_score: number;  // 0-10
  reasoning: string;
}

export interface TopicSuggestion {
  direction: string;
  identity_mode: string;
  hook: string;
  reasoning: string;
}

export interface PersonaAlignmentReport {
  alignment_score: number;  // 0-10
  identity_analysis: IdentityAlignment[];
  topic_suggestions: TopicSuggestion[];
  warnings: string[];
  generated_at: string;
}

export interface PersonaReportLog {
  entries: PersonaAlignmentReport[];
}

// ─── Post Analysis Types ─────────────────────────────────────────────────

export interface PatternAnalysis {
  hook_effectiveness: number;       // 0-10
  emotional_resonance: number;      // 0-10
  trending_alignment: number;       // 0-10
  visual_impact: number;            // 0-10
  call_to_action: number;           // 0-10
  key_success_factors: string[];    // 3-5 items
  improvement_areas: string[];      // 2-3 items
}

export interface ExtractedPattern {
  pattern_type: string;
  description: string;
  applicable_templates: string[];
  confidence: number;               // 0-1
}

export interface PersonaAlignment {
  score: number;                    // 0-10
  identity_mode_match: boolean;
  tone_consistency: 'on_brand' | 'slight_drift' | 'off_brand';
  specific_notes: string;
}

export type PerformanceTier = 'viral' | 'above_avg' | 'normal' | 'below_avg';

export interface ContentAnalysis {
  item_id: string;
  analyzed_at: string;
  performance_tier: PerformanceTier;
  engagement_score: number;         // 0-100
  platform: 'xhs' | 'douyin';
  identity_mode: IdentityMode;
  template_type: string;
  pattern_analysis: PatternAnalysis;
  extracted_patterns?: ExtractedPattern[];
  persona_alignment: PersonaAlignment;
}

export interface AnalysisLog {
  entries: ContentAnalysis[];
  last_updated: string;
}

// ─── Audience Perception Types ───────────────────────────────────────────────

/** A structured perception entry derived from published content's audience feedback. */
export interface AudiencePerceptionEntry {
  item_id: string;
  platform: 'xhs' | 'douyin';
  identity_mode: string;
  generated_at: string;
  /** One-liner summary of how the audience perceives this content / character */
  summary: string;
  /** Traits the audience attributes to the virtual persona */
  perceived_traits: string[];
  /** Emotional keywords from audience feedback */
  emotional_keywords: string[];
  /** What the audience wants more of */
  desire_signals: string[];
  /** What the audience pushes back on or dislikes */
  resistance_signals: string[];
  /** Selected representative comments for traceability */
  representative_comments: string[];
  /** Source references (e.g. performance entry id, analysis id) */
  source_refs: string[];
}

export interface AudiencePerceptionStore {
  entries: AudiencePerceptionEntry[];
  last_updated: string;
}

// ─── Viral Knowledge Base Types ──────────────────────────────────────────────

/** Platforms supported by the viral knowledge base. */
export type ViralPlatform = 'douyin' | 'xhs';

/** Source categories for viral content items. */
export type ViralSourceType = 'competitor' | 'trending_feed' | 'search';

/** Audience response analysis extracted from XHS comment text. */
export interface AudienceResponse {
  top_keywords: string[];
  emotional_triggers: string[];
  desire_signals: string[];
}

/** A dissected viral content entry stored in the knowledge base. */
export interface ViralEntry {
  id: string;                           // hash(platform + source_id)
  platform: ViralPlatform;
  source_id: string;
  source_type: ViralSourceType;
  persona_id: string;                   // 归属 persona（多 persona 隔离）

  // 原始数据
  title: string;
  description: string;
  likes: number;
  comments: number;
  shares: number;
  collected_at: string;                 // ISO timestamp

  // 6维拆解（LLM 产出）
  dissection: {
    hook_type: string;
    content_type: string;
    identity_mode: string | null;       // 赛道标记；null = 通用
    emotion_arc: string;
    interaction_design: string;
    visual_style: string;
    cta_type: string;
    summary: string;
    audience_response?: AudienceResponse; // XHS 评论受众分析（仅有评论文本时）
  };

  dissection_status: 'done' | 'failed';
  kb_tier: 'track' | 'universal';      // 赛道爆款 or 通用爆款
  promoted_to_template: boolean;
  times_referenced: number;

  // Quality & repair metadata (added by taxonomy hardening)
  dissection_error_reason?: string;     // e.g. 'hollow_result', 'invalid_json', 'repair_requested'
  repair_count?: number;                // how many times this entry has been re-queued for repair
  last_repaired_at?: string;            // ISO timestamp of last repair attempt
  quality_score?: number;               // 0-1 quality assessment (future use)
}

/**
 * A universal viral formula derived from ≥3 entries sharing the same
 * platform + content_type + hook_type combination.
 *
 * v2: enriched with example titles, structural template, confidence score,
 *     and distinct source count for runtime prompt injection (案例驱动).
 *     `injected_to_templates` is kept for backward compat but no longer written to persona.
 */
export interface UniversalFormula {
  id: string;
  platform: ViralPlatform;
  content_type: string;
  hook_type: string;
  formula_summary: string;             // 提炼的可复用公式描述
  source_entry_ids: string[];
  occurrence_count: number;            // ≥3 触发升级
  /** @deprecated No longer auto-injected into persona.yaml (v2). Kept for backward compat. */
  injected_to_templates: boolean;
  created_at: string;
  last_seen_at: string;
  trigger_words?: string[];            // 高频情绪触发词（来自爆款标题分析）

  // ── v2 enrichment fields ──
  /** 2-3 representative titles from source entries (verbatim) */
  example_titles?: string[];
  /** Structural template with [占位符], e.g. "[数字]+[反转]+[情绪结论]" */
  structural_template?: string;
  /** Number of distinct source types / authors contributing to this formula */
  distinct_source_count?: number;
  /** Confidence score 0-1 based on occurrence count, source diversity, & recency */
  confidence?: number;
}

/** A single item waiting to be dissected by the LLM. */
export interface DissectQueueItem {
  id: string;
  platform: ViralPlatform;
  source_id: string;
  source_type: ViralSourceType;
  title: string;
  description: string;
  likes: number;
  comments: number;
  shares: number;
  queued_at: string;
  identity_mode?: string;
  comment_texts?: string[];  // Top comments (XHS only) for audience response analysis
}

// === Tag Engine Types ===

export type TagSource =
  | { type: 'competitor'; account: string; platform: string }
  | { type: 'keyword_search'; keyword: string; platform: string }
  | { type: 'viral_kb'; entry_id: string; platform: string };

export interface TagEntry {
  tag: string;
  platform: 'xhs' | 'douyin' | 'both';
  score: number;
  sources: TagSource[];
  first_seen: string;
  last_hit: string;
  hit_count: number;
  peak_score: number;
}

export interface TagVocabulary {
  version: number;
  last_updated: string;
  active: TagEntry[];
  dormant: TagEntry[];
}
