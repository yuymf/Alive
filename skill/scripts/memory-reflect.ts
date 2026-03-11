#!/usr/bin/env node
/**
 * memory-reflect.ts
 * Reads high-importance memories, generates Core Wisdom via LLM reflection.
 * Triggered when total_importance_since_reflection >= 100.
 *
 * Requires: ANTHROPIC_API_KEY or OPENAI_API_KEY in environment
 * Usage: node memory-reflect.js [--force]
 */

import * as fs from 'fs';
import * as path from 'path';
import { callLLMJSON } from './llm-client';

const MEMORY_BASE = path.join(process.env.HOME!, '.openclaw', 'workspace', 'memory', 'minase');
const WISDOM_PATH = path.join(MEMORY_BASE, 'core-wisdom.json');
const DIARY_PATH = path.join(MEMORY_BASE, 'diary.md');
const THRESHOLD = 100;
const MAX_WISDOM_ENTRIES = 20;

interface WisdomEntry {
  id: string;
  lesson: string;
  source: string;
  date: string;
  importance: number;
  tags: string[];
}

interface WisdomStore {
  version: number;
  wisdom: WisdomEntry[];
  total_importance_since_reflection: number;
}

function loadWisdom(): WisdomStore {
  if (!fs.existsSync(WISDOM_PATH)) {
    return { version: 1, wisdom: [], total_importance_since_reflection: 0 };
  }
  return JSON.parse(fs.readFileSync(WISDOM_PATH, 'utf8'));
}

function extractHighImportanceMemories(diaryContent: string, minImportance = 6): string[] {
  const blocks = diaryContent.split(/\n## /);
  return blocks
    .filter(block => {
      const match = block.match(/重要性: (\d+)/);
      return match && parseInt(match[1]) >= minImportance;
    })
    .slice(-20) // most recent 20 high-importance entries
    .map(b => b.trim());
}



async function reflect(force = false): Promise<void> {
  const wisdom = loadWisdom();

  if (!force && wisdom.total_importance_since_reflection < THRESHOLD) {
    console.log(`Reflection threshold not reached (${wisdom.total_importance_since_reflection}/${THRESHOLD}). Use --force to override.`);
    return;
  }

  if (!fs.existsSync(DIARY_PATH)) {
    console.log('No diary found. Skipping reflection.');
    return;
  }

  const diary = fs.readFileSync(DIARY_PATH, 'utf8');
  const highMemories = extractHighImportanceMemories(diary);

  if (highMemories.length === 0) {
    console.log('No high-importance memories found. Skipping.');
    return;
  }

  const template = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'reflection-prompt.md'),
    'utf8'
  );

  const prompt = template
    .replace('{high_importance_memories}', highMemories.join('\n\n---\n\n'))
    .replace(/```[\s\S]*?```/g, match => match.slice(3, -3).trim());

  console.log('Running reflection...');
  const newLessons = await callLLMJSON<WisdomEntry[]>(prompt);

  // Add new wisdom, deduplicate, trim to max
  const now = new Date().toISOString().split('T')[0];
  for (const lesson of newLessons) {
    const id = `w${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    wisdom.wisdom.push({ ...lesson, id, date: now, source: 'reflection' });
  }

  // Trim oldest low-importance if over limit
  if (wisdom.wisdom.length > MAX_WISDOM_ENTRIES) {
    wisdom.wisdom.sort((a, b) => b.importance - a.importance || b.date.localeCompare(a.date));
    wisdom.wisdom = wisdom.wisdom.slice(0, MAX_WISDOM_ENTRIES);
  }

  wisdom.total_importance_since_reflection = 0;
  fs.writeFileSync(WISDOM_PATH, JSON.stringify(wisdom, null, 2));

  console.log(`Reflection complete. Added ${newLessons.length} new wisdom entries.`);
}

const force = process.argv.includes('--force');
reflect(force).catch(console.error);
