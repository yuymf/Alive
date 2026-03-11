// skill/scripts/types.ts
// Shared type definitions for the heartbeat protocol

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

export interface PostRecord {
  media_id: string;
  timestamp: number;
  style: ContentStyle;
  caption: string;
  hashtags: string[];
  image_local_path: string;
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
}

export interface PhotoIntent {
  wantToShoot: boolean;
  sceneDescription: string;
  style: ContentStyle;
  mood: string;
  reason: string;
}

export interface PostIntent {
  wantToPost: boolean;
  selectedPhoto?: string;
  caption: string;
  hashtags: string[];
  reason: string;
}
