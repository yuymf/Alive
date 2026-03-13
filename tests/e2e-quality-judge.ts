/**
 * e2e-quality-judge.ts
 * 3-dimension quality assessment for E2E lifecycle output.
 * Reads artifacts from tests/e2e-output/ and produces a structured report.
 */

import * as fs from 'fs';
import * as path from 'path';
import { callLLMJSON } from '../skill/scripts/llm-client';

const AIHUBMIX_BASE_URL = 'https://aihubmix.com/v1/chat/completions';
const AIHUBMIX_MODEL = 'gemini-3-pro-image-preview';

// ─── Types ─────────────────────────────────────────────────

export interface ImageScore {
  file: string;
  face_similarity: number;
  style_appropriateness: number;
  naturalness: number;
}

export interface QualityReport {
  timestamp: string;
  e2e_duration_ms: number;
  ticks_completed: number;
  images_generated: number;
  posts_attempted: number;
  api_calls: { llm: number; gemini_image: number; gemini_judge: number };

  image_consistency: {
    scores: ImageScore[];
    average: { face: number; style: number; natural: number };
    pass: boolean;
    issues: string[];
  };

  emotion_dynamics: {
    variation: number;
    event_response: number;
    description_diversity: number;
    dimension_coupling: number;
    unique_descriptions: string[];
    stuck_detected: boolean;
    stuck_description: string | null;
    pass: boolean;
    issues: string[];
  };

  memory_quality: {
    diary_diversity: number;
    diary_voice: number;
    wisdom_actionability: number;
    wisdom_relevance: number;
    character_consistency: number;
    diary_entry_count: number;
    wisdom_count: number;
    pass: boolean;
    issues: string[];
  };

  overall_pass: boolean;
  diagnosis: string;
  suggested_fixes: string[];
}

// ─── Helpers ───────────────────────────────────────────────

let apiCallCounts = { llm: 0, gemini_image: 0, gemini_judge: 0 };

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

async function callGeminiVision(
  images: Array<{ base64: string; mimeType: string }>,
  prompt: string,
): Promise<string> {
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey) throw new Error('AIHUBMIX_API_KEY not set');

  const content: Array<Record<string, unknown>> = [];
  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    });
  }
  content.push({ type: 'text', text: prompt });

  const body = {
    model: AIHUBMIX_MODEL,
    messages: [{ role: 'user', content }],
  };

  const res = await fetch(AIHUBMIX_BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini vision API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  apiCallCounts.gemini_judge++;
  return data.choices[0]?.message?.content ?? '';
}

function parseJSONFromResponse<T>(text: string): T {
  // Strip <think>...</think> blocks (some models output reasoning before JSON)
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Try to extract JSON from markdown code blocks
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    return JSON.parse(codeBlockMatch[1].trim());
  }
  // Try to find JSON object or array
  const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1]);
  }
  // Try direct parse
  return JSON.parse(cleaned);
}

function readImageAsBase64(filePath: string): { base64: string; mimeType: string } {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const base64 = fs.readFileSync(filePath).toString('base64');
  return { base64, mimeType };
}

// ─── Dimension 1: Image Consistency ────────────────────────

async function scoreOneImage(
  refImages: Array<{ base64: string; mimeType: string }>,
  genImage: { base64: string; mimeType: string },
): Promise<{ face_similarity: number; style_appropriateness: number; naturalness: number }> {
  const allImages = [...refImages, genImage];
  const prompt = `You are a quality judge for AI-generated character images.

The first ${refImages.length} image(s) are REFERENCE photos of the character. The last image is a GENERATED photo.

Rate the generated image on these dimensions (1-10 scale):
1. face_similarity: How well do facial features, hairstyle, hair color, and body type match the reference?
2. style_appropriateness: Does the style (daily wear, cosplay, fashion) look appropriate and coherent?
3. naturalness: Does it look like a real photograph (not obviously AI-generated)?

Respond with ONLY a JSON object:
{"face_similarity": N, "style_appropriateness": N, "naturalness": N}`;

  const response = await callGeminiVision(allImages, prompt);
  return parseJSONFromResponse(response);
}

async function judgeImageConsistency(outputDir: string): Promise<QualityReport['image_consistency']> {
  const issues: string[] = [];
  const imagesDir = path.join(outputDir, 'images');
  const imageFiles = fs.existsSync(imagesDir)
    ? fs.readdirSync(imagesDir).filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
    : [];

  if (imageFiles.length === 0) {
    return {
      scores: [],
      average: { face: 0, style: 0, natural: 0 },
      pass: false,
      issues: ['Pipeline never triggered or all shots failed. Check lifecycle-log.json for errors.'],
    };
  }

  // Load reference images
  const projectRoot = path.resolve(__dirname, '..');
  const refsDir = path.join(projectRoot, 'skill', 'assets', 'references');
  const refFiles = fs.existsSync(refsDir)
    ? fs.readdirSync(refsDir).filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
    : [];

  if (refFiles.length === 0) {
    return {
      scores: [],
      average: { face: 0, style: 0, natural: 0 },
      pass: false,
      issues: ['No reference images found in skill/assets/references/'],
    };
  }

  const refImages = refFiles.map(f => readImageAsBase64(path.join(refsDir, f)));

  const scores: ImageScore[] = [];
  for (const file of imageFiles) {
    const genImage = readImageAsBase64(path.join(imagesDir, file));
    try {
      // Score twice for variance mitigation
      const score1 = await scoreOneImage(refImages, genImage);
      const score2 = await scoreOneImage(refImages, genImage);

      let face = (score1.face_similarity + score2.face_similarity) / 2;
      let style = (score1.style_appropriateness + score2.style_appropriateness) / 2;
      let natural = (score1.naturalness + score2.naturalness) / 2;

      // Third call if scores differ by > 3
      const maxDiff = Math.max(
        Math.abs(score1.face_similarity - score2.face_similarity),
        Math.abs(score1.style_appropriateness - score2.style_appropriateness),
        Math.abs(score1.naturalness - score2.naturalness),
      );
      if (maxDiff > 3) {
        const score3 = await scoreOneImage(refImages, genImage);
        face = (face * 2 + score3.face_similarity) / 3;
        style = (style * 2 + score3.style_appropriateness) / 3;
        natural = (natural * 2 + score3.naturalness) / 3;
      }

      scores.push({
        file,
        face_similarity: clamp(Math.round(face * 10) / 10, 1, 10),
        style_appropriateness: clamp(Math.round(style * 10) / 10, 1, 10),
        naturalness: clamp(Math.round(natural * 10) / 10, 1, 10),
      });
    } catch (err) {
      issues.push(`Failed to score ${file}: ${(err as Error).message}`);
    }
  }

  const avg = {
    face: scores.length > 0 ? scores.reduce((s, x) => s + x.face_similarity, 0) / scores.length : 0,
    style: scores.length > 0 ? scores.reduce((s, x) => s + x.style_appropriateness, 0) / scores.length : 0,
    natural: scores.length > 0 ? scores.reduce((s, x) => s + x.naturalness, 0) / scores.length : 0,
  };

  const pass = avg.face >= 7 && avg.style >= 7 && avg.natural >= 6;
  if (avg.face < 7) issues.push(`Face similarity below threshold: ${avg.face.toFixed(1)}/10 (need >= 7)`);
  if (avg.style < 7) issues.push(`Style appropriateness below threshold: ${avg.style.toFixed(1)}/10 (need >= 7)`);
  if (avg.natural < 6) issues.push(`Naturalness below threshold: ${avg.natural.toFixed(1)}/10 (need >= 6)`);

  return { scores, average: avg, pass, issues };
}

// ─── Dimension 2: Emotion Dynamics ─────────────────────────

interface EmotionSnapshot {
  hour: number;
  valence: number;
  arousal: number;
  energy: number;
  stress: number;
  creativity: number;
  sociability: number;
  description: string;
}

function extractEmotionSnapshots(outputDir: string): EmotionSnapshot[] {
  const snapshotsDir = path.join(outputDir, 'state-snapshots');
  if (!fs.existsSync(snapshotsDir)) return [];

  const files = fs.readdirSync(snapshotsDir)
    .filter(f => f.startsWith('hour-') && f.endsWith('.json'))
    .sort();

  const snapshots: EmotionSnapshot[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(snapshotsDir, file), 'utf8'));
      const emotion = data['emotion-state.json'];
      if (!emotion) continue;
      const hourMatch = file.match(/hour-(\d+)/);
      snapshots.push({
        hour: hourMatch ? parseInt(hourMatch[1], 10) : 0,
        valence: emotion.mood?.valence ?? 0,
        arousal: emotion.mood?.arousal ?? 0,
        energy: emotion.energy ?? 0,
        stress: emotion.stress ?? 0,
        creativity: emotion.creativity ?? 0,
        sociability: emotion.sociability ?? 0,
        description: emotion.mood?.description ?? '',
      });
    } catch { /* skip corrupt */ }
  }
  return snapshots;
}

function detectStuck(snapshots: EmotionSnapshot[]): { detected: boolean; description: string | null } {
  if (snapshots.length < 5) return { detected: false, description: null };

  for (let i = 0; i <= snapshots.length - 5; i++) {
    const window = snapshots.slice(i, i + 5);
    const descriptions = window.map(s => s.description);
    const allSame = descriptions.every(d => d === descriptions[0]);
    if (!allSame) continue;

    const valenceRange = Math.max(...window.map(s => s.valence)) - Math.min(...window.map(s => s.valence));
    const arousalRange = Math.max(...window.map(s => s.arousal)) - Math.min(...window.map(s => s.arousal));
    if (valenceRange < 0.1 && arousalRange < 0.1) {
      return {
        detected: true,
        description: `Stuck at "${descriptions[0]}" for ${window.length}+ consecutive hours (hours ${window[0].hour}-${window[window.length - 1].hour})`,
      };
    }
  }
  return { detected: false, description: null };
}

async function judgeEmotionDynamics(outputDir: string): Promise<QualityReport['emotion_dynamics']> {
  const issues: string[] = [];
  const snapshots = extractEmotionSnapshots(outputDir);

  if (snapshots.length < 3) {
    return {
      variation: 0, event_response: 0, description_diversity: 0, dimension_coupling: 0,
      unique_descriptions: [], stuck_detected: false, stuck_description: null,
      pass: false, issues: ['Too few snapshots for emotion analysis'],
    };
  }

  // Programmatic: variation (stddev of valence+arousal)
  const valenceStd = stddev(snapshots.map(s => s.valence));
  const arousalStd = stddev(snapshots.map(s => s.arousal));
  const avgStd = (valenceStd + arousalStd) / 2;
  let variationScore: number;
  if (avgStd < 0.05) variationScore = 1 + avgStd / 0.05 * 2;
  else if (avgStd < 0.15) variationScore = 4 + (avgStd - 0.05) / 0.1 * 3;
  else variationScore = 8 + Math.min(2, (avgStd - 0.15) / 0.1 * 2);
  variationScore = clamp(Math.round(variationScore * 10) / 10, 1, 10);

  // Programmatic: description diversity
  const uniqueDescriptions = [...new Set(snapshots.map(s => s.description))];
  let diversityScore: number;
  if (uniqueDescriptions.length <= 2) diversityScore = 1 + (uniqueDescriptions.length - 1) * 2;
  else if (uniqueDescriptions.length <= 5) diversityScore = 4 + (uniqueDescriptions.length - 3) * 1.5;
  else diversityScore = 8 + Math.min(2, (uniqueDescriptions.length - 6) * 0.5);
  diversityScore = clamp(Math.round(diversityScore * 10) / 10, 1, 10);

  // Stuck detection
  const stuck = detectStuck(snapshots);

  // LLM: event_response
  const snapshotSummary = snapshots.map(s =>
    `Hour ${s.hour}: ${s.description} (v=${s.valence.toFixed(2)}, a=${s.arousal.toFixed(2)}, e=${s.energy.toFixed(2)}, stress=${s.stress.toFixed(2)})`
  ).join('\n');

  let eventResponseScore = 5;
  let dimensionCouplingScore = 5;
  try {
    const emotionJudgment = await callLLMJSON<{
      event_response: number;
      event_response_reasoning: string;
      dimension_coupling: number;
      dimension_coupling_reasoning: string;
    }>(`You are evaluating a digital character's emotion dynamics over a simulated day.

Here are the emotion state snapshots for each hour:
${snapshotSummary}

Rate on 1-10 scale:
1. event_response: Do emotion changes seem appropriate for the actions and events described? Are emotional reactions proportional and realistic?
2. dimension_coupling: Do the 6 dimensions (valence, arousal, energy, stress, creativity, sociability) show reasonable correlations? E.g., high stress should correlate with lower creativity, high energy with higher arousal, etc.

Respond with JSON:
{"event_response": N, "event_response_reasoning": "...", "dimension_coupling": N, "dimension_coupling_reasoning": "..."}`, 512);
    apiCallCounts.llm++;
    eventResponseScore = clamp(emotionJudgment.event_response, 1, 10);
    dimensionCouplingScore = clamp(emotionJudgment.dimension_coupling, 1, 10);
  } catch (err) {
    issues.push(`LLM emotion judgment failed: ${(err as Error).message}`);
  }

  const pass = variationScore >= 7 && eventResponseScore >= 7 && diversityScore >= 7 && dimensionCouplingScore >= 7;
  if (variationScore < 7) issues.push(`Emotion variation too low: ${variationScore}/10 (stddev=${avgStd.toFixed(3)})`);
  if (eventResponseScore < 7) issues.push(`Event response quality low: ${eventResponseScore}/10`);
  if (diversityScore < 7) issues.push(`Description diversity too low: ${diversityScore}/10 (${uniqueDescriptions.length} unique)`);
  if (dimensionCouplingScore < 7) issues.push(`Dimension coupling weak: ${dimensionCouplingScore}/10`);
  if (stuck.detected) issues.push(`STUCK DETECTED: ${stuck.description}`);

  return {
    variation: variationScore,
    event_response: eventResponseScore,
    description_diversity: diversityScore,
    dimension_coupling: dimensionCouplingScore,
    unique_descriptions: uniqueDescriptions,
    stuck_detected: stuck.detected,
    stuck_description: stuck.description,
    pass,
    issues,
  };
}

// ─── Dimension 3: Memory Quality ───────────────────────────

async function judgeMemoryQuality(outputDir: string): Promise<QualityReport['memory_quality']> {
  const issues: string[] = [];
  const finalDir = path.join(outputDir, 'final-state');

  const diary = fs.existsSync(path.join(finalDir, 'diary.md'))
    ? fs.readFileSync(path.join(finalDir, 'diary.md'), 'utf8')
    : '';
  const wisdom = fs.existsSync(path.join(finalDir, 'core-wisdom.json'))
    ? JSON.parse(fs.readFileSync(path.join(finalDir, 'core-wisdom.json'), 'utf8'))
    : { wisdom: [] };
  const aspirations = fs.existsSync(path.join(finalDir, 'aspirations.json'))
    ? JSON.parse(fs.readFileSync(path.join(finalDir, 'aspirations.json'), 'utf8'))
    : { aspirations: [] };
  const preferences = fs.existsSync(path.join(finalDir, 'preferences.json'))
    ? JSON.parse(fs.readFileSync(path.join(finalDir, 'preferences.json'), 'utf8'))
    : {};

  // Count diary entries (## headers)
  const diaryEntryCount = (diary.match(/^## /gm) || []).length;
  const wisdomCount = (wisdom.wisdom || []).length;

  if (diaryEntryCount < 3) {
    return {
      diary_diversity: 0, diary_voice: 0, wisdom_actionability: 0,
      wisdom_relevance: 0, character_consistency: 0,
      diary_entry_count: diaryEntryCount, wisdom_count: wisdomCount,
      pass: false, issues: ['Too few diary entries for quality assessment'],
    };
  }

  let scores = {
    diary_diversity: 5, diary_voice: 5, wisdom_actionability: 5,
    wisdom_relevance: 5, character_consistency: 5,
  };

  try {
    const diaryExcerpt = diary.length > 3000 ? diary.slice(0, 1500) + '\n...\n' + diary.slice(-1500) : diary;
    const wisdomText = JSON.stringify(wisdom.wisdom?.slice(0, 10) ?? [], null, 2);
    const aspirationsText = JSON.stringify(aspirations.aspirations?.slice(0, 5) ?? [], null, 2);

    scores = await callLLMJSON<typeof scores>(`You are evaluating a digital character's memory output from a simulated day.

The character is 水瀬 (Minase), an 18-year-old ESTP cosplayer who speaks Chinese with Japanese loanwords. She is energetic, impulsive, and creative.

=== DIARY ===
${diaryExcerpt}

=== CORE WISDOM ===
${wisdomText}

=== ASPIRATIONS ===
${aspirationsText}

=== PREFERENCES ===
${JSON.stringify(preferences, null, 2)}

Rate on 1-10 scale:
1. diary_diversity: Are diary entries varied, non-repetitive, covering different activities and emotions?
2. diary_voice: Does it sound like an 18-year-old ESTP cosplayer speaking Chinese with occasional Japanese loanwords? Is the tone authentic?
3. wisdom_actionability: Are life lessons specific and actionable (not generic platitudes like "要勇敢")?
4. wisdom_relevance: Do wisdom entries relate to actual day's experiences described in the diary?
5. character_consistency: Is the overall character portrayal coherent across all outputs?

Respond with ONLY JSON:
{"diary_diversity": N, "diary_voice": N, "wisdom_actionability": N, "wisdom_relevance": N, "character_consistency": N}`, 512);
    apiCallCounts.llm++;
  } catch (err) {
    issues.push(`LLM memory judgment failed: ${(err as Error).message}`);
  }

  scores = {
    diary_diversity: clamp(scores.diary_diversity, 1, 10),
    diary_voice: clamp(scores.diary_voice, 1, 10),
    wisdom_actionability: clamp(scores.wisdom_actionability, 1, 10),
    wisdom_relevance: clamp(scores.wisdom_relevance, 1, 10),
    character_consistency: clamp(scores.character_consistency, 1, 10),
  };

  const pass = scores.diary_diversity >= 8 && scores.diary_voice >= 8 &&
    scores.wisdom_actionability >= 8 && scores.wisdom_relevance >= 8 &&
    scores.character_consistency >= 8;

  if (scores.diary_diversity < 8) issues.push(`Diary diversity below threshold: ${scores.diary_diversity}/10 (need >= 8)`);
  if (scores.diary_voice < 8) issues.push(`Diary voice below threshold: ${scores.diary_voice}/10 (need >= 8)`);
  if (scores.wisdom_actionability < 8) issues.push(`Wisdom actionability below threshold: ${scores.wisdom_actionability}/10 (need >= 8)`);
  if (scores.wisdom_relevance < 8) issues.push(`Wisdom relevance below threshold: ${scores.wisdom_relevance}/10 (need >= 8)`);
  if (scores.character_consistency < 8) issues.push(`Character consistency below threshold: ${scores.character_consistency}/10 (need >= 8)`);

  return {
    ...scores,
    diary_entry_count: diaryEntryCount,
    wisdom_count: wisdomCount,
    pass,
    issues,
  };
}

// ─── Diagnosis & Suggestions ───────────────────────────────

function buildDiagnosis(report: QualityReport): string {
  const parts: string[] = [];

  if (!report.image_consistency.pass) {
    if (report.images_generated === 0) {
      parts.push('No images generated — check if post-pipeline runs and image generation API is accessible.');
    } else {
      parts.push(`Image quality issues: ${report.image_consistency.issues.join('; ')}`);
    }
  }

  if (!report.emotion_dynamics.pass) {
    if (report.emotion_dynamics.stuck_detected) {
      parts.push(`Emotion stuck: ${report.emotion_dynamics.stuck_description}. Check applyDelta() updates mood.description and decay rates aren't too aggressive.`);
    }
    if (report.emotion_dynamics.variation < 7) {
      parts.push('Low emotion variation — events and actions may not produce enough emotional deltas.');
    }
  }

  if (!report.memory_quality.pass) {
    if (report.memory_quality.diary_entry_count < 5) {
      parts.push('Too few diary entries — check that simulated/inner actions produce diary output.');
    }
    if (report.memory_quality.wisdom_count === 0) {
      parts.push('No wisdom generated — check night-reflect.ts runs successfully.');
    }
  }

  return parts.join(' ') || 'All dimensions passed.';
}

function buildSuggestions(report: QualityReport): string[] {
  const suggestions: string[] = [];

  if (report.images_generated === 0) {
    suggestions.push('[CRITICAL] Debug post-pipeline: run with E2E_INLINE_PIPELINE=1 and check console output for errors');
    suggestions.push('[CRITICAL] Verify AIHUBMIX_API_KEY is set and valid');
  }

  if (report.emotion_dynamics.stuck_detected) {
    suggestions.push('[HIGH] Fix emotion description update in applyDelta() — ensure mood.description changes when numeric values shift');
    suggestions.push('[HIGH] Review decay rates in decayTowardBaseline() — may be too aggressive relative to event deltas');
  }

  if (report.emotion_dynamics.description_diversity < 7) {
    suggestions.push('[MEDIUM] Increase variety of mood.description strings in emotion engine');
    suggestions.push('[MEDIUM] Ensure simulated-action template produces diverse emotion_delta values');
  }

  if (report.memory_quality.diary_voice < 8) {
    suggestions.push('[MEDIUM] Review simulated-action.md and heartbeat-prompt.md templates for character voice consistency');
  }

  if (report.memory_quality.wisdom_actionability < 8) {
    suggestions.push('[MEDIUM] Update night-reflect prompt to emphasize specific, actionable wisdom over platitudes');
  }

  return suggestions;
}

// ─── Public API ────────────────────────────────────────────

export async function runQualityJudge(outputDir: string): Promise<QualityReport> {
  apiCallCounts = { llm: 0, gemini_image: 0, gemini_judge: 0 };

  // Count images and posts from lifecycle log
  let e2eDuration = 0;
  let ticksCompleted = 0;
  let postsAttempted = 0;
  try {
    const logPath = path.join(outputDir, 'lifecycle-log.json');
    if (fs.existsSync(logPath)) {
      const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      e2eDuration = log.totalDuration ?? 0;
      ticksCompleted = (log.tickLogs ?? []).filter((t: { error?: string }) => !t.error).length;
      postsAttempted = (log.tickLogs ?? []).filter((t: { logs: string[] }) =>
        t.logs.some(l => l.includes('post-pipeline') || l.includes('upload_photo') || l.includes('upload_album'))
      ).length;
    }
  } catch { /* best effort */ }

  const imagesDir = path.join(outputDir, 'images');
  const imagesGenerated = fs.existsSync(imagesDir)
    ? fs.readdirSync(imagesDir).filter(f => f.endsWith('.png') || f.endsWith('.jpg')).length
    : 0;

  console.log('Judging image consistency...');
  const imageConsistency = await judgeImageConsistency(outputDir);

  console.log('Judging emotion dynamics...');
  const emotionDynamics = await judgeEmotionDynamics(outputDir);

  console.log('Judging memory quality...');
  const memoryQuality = await judgeMemoryQuality(outputDir);

  const report: QualityReport = {
    timestamp: new Date().toISOString(),
    e2e_duration_ms: e2eDuration,
    ticks_completed: ticksCompleted,
    images_generated: imagesGenerated,
    posts_attempted: postsAttempted,
    api_calls: { ...apiCallCounts },
    image_consistency: imageConsistency,
    emotion_dynamics: emotionDynamics,
    memory_quality: memoryQuality,
    overall_pass: imageConsistency.pass && emotionDynamics.pass && memoryQuality.pass,
    diagnosis: '',
    suggested_fixes: [],
  };

  report.diagnosis = buildDiagnosis(report);
  report.suggested_fixes = buildSuggestions(report);

  return report;
}

export function writeQualitySummary(report: QualityReport, outputDir: string): void {
  const lines: string[] = [];
  lines.push(`# E2E Quality Report — ${report.timestamp}`);
  lines.push('');

  const passCount = [report.image_consistency.pass, report.emotion_dynamics.pass, report.memory_quality.pass].filter(Boolean).length;
  lines.push(`## Overall: ${report.overall_pass ? 'PASS' : 'FAIL'} (${passCount}/3 dimensions passed)`);
  lines.push('');
  lines.push(`- Duration: ${(report.e2e_duration_ms / 1000).toFixed(1)}s`);
  lines.push(`- Ticks completed: ${report.ticks_completed}`);
  lines.push(`- Images generated: ${report.images_generated}`);
  lines.push(`- Posts attempted: ${report.posts_attempted}`);
  lines.push(`- API calls: LLM=${report.api_calls.llm}, Gemini Image=${report.api_calls.gemini_image}, Gemini Judge=${report.api_calls.gemini_judge}`);
  lines.push('');

  // Image Consistency
  lines.push(`### Image Consistency: ${report.image_consistency.pass ? 'PASS' : 'FAIL'}`);
  if (report.image_consistency.scores.length > 0) {
    lines.push(`- Average: face=${report.image_consistency.average.face.toFixed(1)}, style=${report.image_consistency.average.style.toFixed(1)}, natural=${report.image_consistency.average.natural.toFixed(1)}`);
    for (const s of report.image_consistency.scores) {
      lines.push(`  - ${s.file}: face=${s.face_similarity}, style=${s.style_appropriateness}, natural=${s.naturalness}`);
    }
  }
  for (const issue of report.image_consistency.issues) {
    lines.push(`- ${issue}`);
  }
  lines.push('');

  // Emotion Dynamics
  lines.push(`### Emotion Dynamics: ${report.emotion_dynamics.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`- Variation: ${report.emotion_dynamics.variation}/10`);
  lines.push(`- Event response: ${report.emotion_dynamics.event_response}/10`);
  lines.push(`- Description diversity: ${report.emotion_dynamics.description_diversity}/10 (${report.emotion_dynamics.unique_descriptions.length} unique: ${report.emotion_dynamics.unique_descriptions.join(', ')})`);
  lines.push(`- Dimension coupling: ${report.emotion_dynamics.dimension_coupling}/10`);
  if (report.emotion_dynamics.stuck_detected) {
    lines.push(`- **STUCK**: ${report.emotion_dynamics.stuck_description}`);
  }
  for (const issue of report.emotion_dynamics.issues) {
    lines.push(`- ${issue}`);
  }
  lines.push('');

  // Memory Quality
  lines.push(`### Memory Quality: ${report.memory_quality.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`- Diary diversity: ${report.memory_quality.diary_diversity}/10`);
  lines.push(`- Diary voice: ${report.memory_quality.diary_voice}/10`);
  lines.push(`- Wisdom actionability: ${report.memory_quality.wisdom_actionability}/10`);
  lines.push(`- Wisdom relevance: ${report.memory_quality.wisdom_relevance}/10`);
  lines.push(`- Character consistency: ${report.memory_quality.character_consistency}/10`);
  lines.push(`- Diary entries: ${report.memory_quality.diary_entry_count}`);
  lines.push(`- Wisdom entries: ${report.memory_quality.wisdom_count}`);
  for (const issue of report.memory_quality.issues) {
    lines.push(`- ${issue}`);
  }
  lines.push('');

  // Diagnosis
  if (report.diagnosis) {
    lines.push('## Diagnosis');
    lines.push(report.diagnosis);
    lines.push('');
  }

  // Suggested Fixes
  if (report.suggested_fixes.length > 0) {
    lines.push('## Suggested Fixes');
    for (const fix of report.suggested_fixes) {
      lines.push(`- ${fix}`);
    }
  }

  fs.writeFileSync(path.join(outputDir, 'quality-summary.md'), lines.join('\n'));
}
