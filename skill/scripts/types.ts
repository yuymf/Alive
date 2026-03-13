// skill/scripts/types.ts
// Shared type definitions for the heartbeat protocol

// === Emotion Momentum/Undertone (Verisimilitude §1) ===
export interface EmotionMomentum {
  valence: number;
  arousal: number;
  energy: number;
  stress: number;
  creativity: number;
  sociability: number;
  duration_ticks: number;  // valence 主方向连续持续的 tick 数
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

// === Emotion System (Spec §6) ===
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
  // Verisimilitude upgrade §1
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

// ESTP baseline (Spec §6: valence/arousal/energy defined, others are plan defaults)
export const EMOTION_BASELINE: EmotionDelta = {
  valence: 0.3,
  arousal: 0.5,
  energy: 0.6,
  stress: 0.2,     // plan default (not in spec)
  creativity: 0.4,  // plan default (not in spec)
  sociability: 0.5,  // plan default (not in spec)
};

// === Intent Pool (Spec §2) ===
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
  // Verisimilitude upgrade §3
  resistance: number;
  skipped_count: number;
  last_attempted: string | null;
}

export interface IntentPool {
  intents: Intent[];
  last_updated: string | null;
}

// === Schedule (Spec §3) ===
export interface RigidSchedule {
  type: 'rigid';
  activity: string;
  start: string;       // HH:MM
  end: string;          // HH:MM
  weekdays: number[];   // 1=Mon..7=Sun
  allowed_actions: string[];
}

export interface FlexibleSchedule {
  type: 'flexible';
  activity: string;
  preferred_time: string; // HH:MM
  intent_boost: number;
  intent_category: IntentCategory; // which intent type this boosts
}

export interface ScheduleToday {
  date: string | null;
  rigid: RigidSchedule[];
  flexible: FlexibleSchedule[];
  generated_by: string | null;
}

// === Event Queue (Spec §4) ===
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

// === Growth System (Spec §7) ===
export interface CharacterPreference {
  name: string;
  affinity: number;
  times_created: number;
  best_performance?: number;
  source?: string;
}

export interface StylePreference {
  style: string;
  affinity: number;
}

export interface PlatformPreference {
  platform: string;
  engagement: number;
  note?: string;
}

export interface Preferences {
  cos_characters: CharacterPreference[];
  content_style: StylePreference[];
  active_hours: Array<{ period: string; productivity: number; learned_from?: string }>;
  social_platforms: PlatformPreference[];
}

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
  strength: number;  // 0 ~ 1.0
  origin: string;
  effect: string;
}

export interface PersonalityDrift {
  base: string;
  modifiers: PersonalityModifier[];
}

// === Social Graph (Spec §8) ===
export interface SocialRelation {
  id: string;
  name: string;
  platform: string;
  type: '用户' | '粉丝' | '同行' | '虚拟认知';
  relationship: {
    closeness: number;  // 0 ~ 10.0
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
}

export interface SocialMeta {
  instagram_following: string[];
  xiaohongshu_following: string[];
  stats: {
    core: number;
    familiar: number;
    cognitive: number;
    dormant: number;
  };
}

// === Heartbeat Log (Spec §10) ===
export interface HeartbeatLogEntry {
  timestamp: string;
  type: 'morning' | 'regular' | 'night';
  status: 'completed' | 'skipped';
  perception_summary?: string;
  chosen_actions?: string[];
  emotion_after?: Pick<EmotionState, 'mood' | 'energy'>;
  importance_added?: number;
  error?: string;
  // Verisimilitude upgrade §5
  tick_summary?: string;
  inner_monologue?: string | null;
  flow_state?: 'flow' | 'drift' | 'none';
  voice_directive?: string;
}

export interface HeartbeatLog {
  logs: HeartbeatLogEntry[];
  retention_days: number;
}

// === Action Output (Spec §5) ===
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

// === Cron Schedule (Spec §14) ===
export interface CronHeartbeat {
  time: string;   // HH:MM
  type: 'morning' | 'regular' | 'night';
}

export interface CronSchedule {
  date: string;
  heartbeats: CronHeartbeat[];
}

// === Wisdom (existing, from memory-reflect.ts) ===
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

// === Auto-Photo System (Spec: 2026-03-11-auto-photo-instagram) ===

export type ContentStyle = 'cos' | 'daily' | 'behind_scenes' | 'travel';

export interface ShotDescription {
  description: string;
  angle: string;
  variation: string;
}

export interface PostRecord {
  media_id: string;
  timestamp: number;
  style: ContentStyle;
  caption: string;
  hashtags: string[];
  image_local_paths: string[];
  image_url?: string;
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

export interface InspirationData {
  instagram_trends: {
    hot_styles: string[];
    high_engagement_patterns: string[];
    trending_hashtags: string[];
    updated_at: number;
  };
  acg_hotspots: {
    trending_characters: string[];
    upcoming_events: string[];
    seasonal_themes: string[];
    updated_at: number;
  };
  visual_trends: {
    composition_styles: string[];
    color_palettes: string[];
    scene_ideas: string[];
    updated_at: number;
  };
  self_performance: {
    best_style: string;
    best_time_slots: string[];
    best_hashtag_combos: string[][];
    engagement_by_style: Record<string, number>;
    updated_at: number;
  };
  xiaohongshu_trends?: {
    feed_highlights: Array<{ title: string; likes: number; topic: string }>;
    cosplay_notes: Array<{ title: string; likes: number; topic: string }>;
    trending_topics: string[];
    cosplay_insights: string[];
    saved_inspirations: Array<{
      source_note_id: string;
      source_title: string;
      visual_description: string;
      style_tags: string[];
      saved_at: number;
    }>;
    updated_at: number;
  };
  saved_references?: SavedReference[];
}

export interface PhotoIntent {
  wantToShoot: boolean;
  sceneDescription: string;
  style: ContentStyle;
  mood: string;
  reason: string;
  imageCount: number;
  shots: ShotDescription[];
  referenceInspiration?: string;
}

export interface PostIntent {
  wantToPost: boolean;
  selectedPhotos: string[];
  caption: string;
  hashtags: string[];
  reason: string;
}

// === Vitality / Metabolism System ===
export interface VitalityState {
  vitality: number;        // 0-100
  last_updated: string | null;
  consecutive_low_days: number;  // days where vitality stayed < 30
}

// === Confidence / Positive Feedback Loop ===
export interface ConfidenceState {
  confidence: number;       // 0.5-1.5 (1.0 = neutral)
  streak: number;           // consecutive positive/negative results
  last_updated: string | null;
}

// === Random Events ===
export interface RandomEvent {
  id: string;
  description: string;
  emotion_delta: EmotionDelta;
  intent_boosts: Array<{ category: IntentCategory; boost: number }>;
  diary_entry: string;
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

export interface SavedReference {
  url: string;
  local_path: string;
  source_hashtag: string;
  style_tags: string[];
  scene_description: string;
  saved_at: number;
}

// === Flow State (Verisimilitude §2) ===
export interface FlowState {
  status: 'none' | 'flow' | 'drift';
  activity: string | null;
  category: IntentCategory | null;
  entered_at: string | null;
  duration_ticks: number;
  interrupt_chance: number;  // 初始 0.15，每 tick +0.03，上限 0.40
}

export const DEFAULT_FLOW_STATE: FlowState = {
  status: 'none',
  activity: null,
  category: null,
  entered_at: null,
  duration_ticks: 0,
  interrupt_chance: 0.15,
};

// === Context-aware Random Events (Verisimilitude §4) ===
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
  cooldowns: Record<string, string>;  // event_description → last_triggered ISO date
}

export const DEFAULT_CHAIN_STATE: ChainAndCooldownState = {
  pending: [],
  cooldowns: {},
};

// === Resistance Constants (Verisimilitude §3) ===
export const BASE_RESISTANCE: Record<IntentCategory, number> = {
  '创作': 4.0,
  '社交': 1.5,
  '窥屏': 0.5,
  '表达': 2.0,
  '学习': 5.0,
  '休息': 0.3,
  '梦想': 6.0,
};

// === Emotion Defaults (Verisimilitude §1) ===
export const DEFAULT_MOMENTUM: EmotionMomentum = {
  valence: 0, arousal: 0, energy: 0,
  stress: 0, creativity: 0, sociability: 0,
  duration_ticks: 0,
};

export const DEFAULT_UNDERTONE: EmotionUndertone = {
  valence: 0.3, arousal: 0.5, energy: 0.6,
  stress: 0.2, creativity: 0.4, sociability: 0.5,
};

// === Hydration Functions (backward compat) ===

/** Fill missing verisimilitude fields on an old EmotionState JSON. */
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

/** Fill missing verisimilitude fields on an old Intent JSON. */
export function hydrateIntent(raw: Record<string, unknown>): Intent {
  const intent = raw as Partial<Intent> & Pick<Intent, 'id' | 'category' | 'description' | 'intensity' | 'source' | 'born_at' | 'decay_rate' | 'satisfied_at'>;
  return {
    ...intent,
    resistance: intent.resistance ?? (BASE_RESISTANCE[intent.category] ?? 0),
    skipped_count: intent.skipped_count ?? 0,
    last_attempted: intent.last_attempted ?? null,
  };
}

/** Fill missing verisimilitude fields on an old HeartbeatLogEntry JSON. */
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
