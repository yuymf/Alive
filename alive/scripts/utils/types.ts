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
  platform_config?: Record<string, Record<string, unknown>>;
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
  /** Allow any extra feature flags */
  [key: string]: boolean | undefined;
}

/** Default feature flags — conservative defaults */
export const DEFAULT_FEATURES: Required<Pick<FeaturesConfig,
  'skill_discovery' | 'random_events' | 'social_graph' | 'flow_states' |
  'procrastination' | 'personality_drift' | 'content_browse'
>> = {
  skill_discovery: false,
  random_events: true,
  social_graph: true,
  flow_states: true,
  procrastination: true,
  personality_drift: true,
  content_browse: false,
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

// === Intent Pool ===
export type IntentCategory = '创作' | '社交' | '窥屏' | '表达' | '学习' | '休息' | '梦想';

export interface Intent {
  id: string;
  category: IntentCategory;
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
export const BASE_RESISTANCE: Record<IntentCategory, number> = {
  '创作': 4.0,
  '社交': 1.5,
  '窥屏': 1.5,  // 从 0.5 提高到 1.5：避免窥屏意图过于容易满足，导致 content-browse 垄断
  '表达': 2.0,
  '学习': 2.5,  // 从 5.0 降低到 2.5：让学习/搜索意图更容易突破门槛
  '休息': 0.3,
  '梦想': 6.0,
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
  const state = raw as Partial<EmotionState> & Pick<EmotionState, 'mood' | 'energy' | 'stress' | 'creativity' | 'sociability' | 'last_updated' | 'recent_cause'>;
  return {
    ...state,
    momentum: state.momentum ?? { ...DEFAULT_MOMENTUM },
    undertone: state.undertone ?? { ...DEFAULT_UNDERTONE },
    impulse_history: state.impulse_history ?? [],
    consecutive_high_stress: state.consecutive_high_stress ?? 0,
    threshold_break_cooldown: state.threshold_break_cooldown ?? 0,
  };
}

export function hydrateIntent(raw: Record<string, unknown>): Intent {
  const intent = raw as Partial<Intent> & Pick<Intent, 'id' | 'category' | 'description' | 'intensity' | 'source' | 'born_at' | 'decay_rate' | 'satisfied_at'>;
  return {
    ...intent,
    resistance: intent.resistance ?? (BASE_RESISTANCE[intent.category] ?? 0),
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

export interface PostImpulseState {
  value: number;
  last_post_at: number;
  posts_today_date: string;
  posts_today: number;
}

export const DEFAULT_POST_IMPULSE: PostImpulseState = {
  value: 0,
  last_post_at: 0,
  posts_today_date: '',
  posts_today: 0,
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
