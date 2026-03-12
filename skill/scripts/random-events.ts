// skill/scripts/random-events.ts
// Stochastic perturbation system — injects "life happens" randomness
// (digital-life-comparison §3.2)

import { RandomEvent, EmotionDelta, IntentCategory } from './types';

/**
 * Pool of possible random events.
 * Each has emotion effects, intent boosts, and a diary-worthy description.
 */
const EVENT_POOL: Omit<RandomEvent, 'id'>[] = [
  {
    description: '突然想起一个很喜欢的角色',
    emotion_delta: { valence: 0.2, creativity: 0.3, arousal: 0.2 },
    intent_boosts: [{ category: '创作', boost: 3.0 }],
    diary_entry: '刷手机的时候突然看到一张图，想起了好久没有cos的角色...好想再试试',
  },
  {
    description: '看到一个很有趣的评论',
    emotion_delta: { valence: 0.15, sociability: 0.2, arousal: 0.1 },
    intent_boosts: [{ category: '社交', boost: 2.0 }],
    diary_entry: '有个粉丝的评论也太好笑了吧哈哈哈哈哈',
  },
  {
    description: '天气特别好',
    emotion_delta: { valence: 0.1, energy: 0.15, creativity: 0.1 },
    intent_boosts: [{ category: '创作', boost: 1.0 }, { category: '表达', boost: 1.0 }],
    diary_entry: '今天天气好好！想出去拍点什么',
  },
  {
    description: '工作上遇到烦心事',
    emotion_delta: { valence: -0.2, stress: 0.3, energy: -0.1 },
    intent_boosts: [{ category: '休息', boost: 2.0 }],
    diary_entry: '今天工作好烦...需要做点开心的事来转换心情',
  },
  {
    description: '灵感枯竭期',
    emotion_delta: { creativity: -0.2, valence: -0.1 },
    intent_boosts: [{ category: '窥屏', boost: 2.0 }, { category: '学习', boost: 1.0 }],
    diary_entry: '最近好像没什么灵感...去刷刷别人的作品找找感觉吧',
  },
  {
    description: '收到同好的私信鼓励',
    emotion_delta: { valence: 0.25, sociability: 0.3, energy: 0.1 },
    intent_boosts: [{ category: '社交', boost: 2.5 }, { category: '表达', boost: 1.0 }],
    diary_entry: '有个同好给我发了好暖的私信...这种时候觉得做cos真的很值得',
  },
  {
    description: '刷到一个新番预告',
    emotion_delta: { valence: 0.15, arousal: 0.2, creativity: 0.2 },
    intent_boosts: [{ category: '创作', boost: 1.5 }, { category: '梦想', boost: 1.0 }],
    diary_entry: '新番预告也太绝了吧！！已经开始想cos谁了',
  },
  {
    description: '身体有点不舒服',
    emotion_delta: { energy: -0.25, valence: -0.1, arousal: -0.2 },
    intent_boosts: [{ category: '休息', boost: 4.0 }],
    diary_entry: '今天身体有点不舒服...还是安静待着吧',
  },
  {
    description: '看到其他coser的神仙作品',
    emotion_delta: { valence: 0.1, arousal: 0.15, creativity: 0.2, stress: 0.1 },
    intent_boosts: [{ category: '创作', boost: 2.0 }, { category: '学习', boost: 1.5 }],
    diary_entry: '看到大佬的作品...差距好大但是好想追上啊',
  },
  {
    description: '突然很想吃好吃的',
    emotion_delta: { valence: 0.05, sociability: 0.1 },
    intent_boosts: [{ category: '表达', boost: 0.5 }],
    diary_entry: '好想吃火锅...谁来一起啊aaaa',
  },
  {
    description: '漫展即将到来',
    emotion_delta: { valence: 0.3, arousal: 0.3, creativity: 0.3, energy: 0.1 },
    intent_boosts: [{ category: '创作', boost: 3.0 }, { category: '梦想', boost: 2.0 }],
    diary_entry: '漫展快到了！必须要准备新的cos才行！',
  },
  {
    description: '和朋友聊了很久',
    emotion_delta: { valence: 0.1, sociability: 0.2, energy: -0.1, stress: -0.2 },
    intent_boosts: [{ category: '社交', boost: 1.0 }],
    diary_entry: '和朋友聊了好久...虽然有点累但是心情好了很多',
  },
];

/**
 * Roll for random events this tick.
 * Base probability: 10% per tick (roughly 1-2 events per day during active hours).
 * Returns 0 or 1 events per call.
 */
export function rollRandomEvent(options?: {
  probability?: number;
  excludeCategories?: IntentCategory[];
}): RandomEvent | null {
  const prob = options?.probability ?? 0.10;

  if (Math.random() > prob) return null;

  // Weighted random selection (equal weights for now)
  let pool = [...EVENT_POOL];

  // Filter out events that boost excluded categories
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
    id: `rnd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  };
}
