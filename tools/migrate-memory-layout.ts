#!/usr/bin/env npx tsx
/**
 * One-time migration script: restructure memory directory layout.
 *
 * Moves flat files in ~/.openclaw/workspace/memory/{persona}/
 * into persona/, state/, queues/ subdirectories.
 *
 * Usage:
 *   npx tsx scripts/migrate-memory-layout.ts [persona-id]
 *   npx tsx scripts/migrate-memory-layout.ts miss-v
 *   npx tsx scripts/migrate-memory-layout.ts          # defaults to ALIVE_PERSONA or 'miss-v'
 *
 * The script is idempotent: files already at the target location are skipped.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── File → subdirectory mapping ────────────────────────────────────────────

const PERSONA_FILES = [
  'persona.yaml',
  'core-wisdom.json',
  'preferences.json',
  'aspirations.json',
  'skill-needs.json',
];

const STATE_FILES = [
  'emotion-state.json',
  'confidence-state.json',
  'flow-state.json',
  'vitality-state.json',
  'inspiration-state.json',
  'keyword-state.json',
  'search-state.json',
  'content-patterns.json',
  'personality-drift.json',
  'schedule-today.json',
  'content-taste.json',
  'travel-state.json',
  'voice-state.json',
  'outreach-state.json',
  'work-impulse.json',
  'post-impulse.json',
  'viral-search-state.json',
  'content-strategy.json',
];

const QUEUE_FILES = [
  'event-queue.json',
  'heartbeat-log.json',
  'intent-pool.json',
  'pending-chains.json',
  'review-queue.json',
  'post-analysis-log.json',
  'persona-report-log.json',
  'competitor-log.json',
  'discovery-pool.json',
  'ops-brief-log.json',
  'performance-log.json',
  'analysis-log.json',
  'trend-history.json',
  'competitor-posts.json',
  'competitor-analysis.json',
  'candidate-accounts.json',
  'post-history.json',
  'pending-engagement.json',
  'outbound-history.json',
  'health-report.json',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function moveFile(src: string, dest: string, dryRun: boolean): boolean {
  if (!fs.existsSync(src)) return false;
  if (fs.existsSync(dest)) {
    console.log(`  SKIP (exists): ${path.basename(dest)}`);
    return false;
  }
  if (dryRun) {
    console.log(`  WOULD MOVE: ${path.basename(src)} → ${path.relative(memoryDir, dest)}`);
    return true;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  console.log(`  MOVED: ${path.basename(src)} → ${path.relative(memoryDir, dest)}`);
  return true;
}

function moveWithBak(base: string, filename: string, subdir: string, dryRun: boolean): number {
  let count = 0;
  const src = path.join(base, filename);
  const dest = path.join(base, subdir, filename);
  if (moveFile(src, dest, dryRun)) count++;

  // Also move .bak if it exists
  const bakSrc = src + '.bak';
  const bakDest = dest + '.bak';
  if (moveFile(bakSrc, bakDest, dryRun)) count++;

  return count;
}

// ─── Main ───────────────────────────────────────────────────────────────────

const personaId = process.argv[2] || process.env.ALIVE_PERSONA || 'miss-v';
const dryRun = process.argv.includes('--dry-run');
const memoryDir = path.join(
  process.env.HOME!,
  '.openclaw',
  'workspace',
  'memory',
  personaId,
);

console.log(`\n📦 Memory Layout Migration`);
console.log(`   Persona: ${personaId}`);
console.log(`   Directory: ${memoryDir}`);
console.log(`   Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}\n`);

if (!fs.existsSync(memoryDir)) {
  console.error(`❌ Memory directory not found: ${memoryDir}`);
  process.exit(1);
}

let totalMoved = 0;

// 1. Move persona files
console.log('── persona/ ──');
for (const file of PERSONA_FILES) {
  totalMoved += moveWithBak(memoryDir, file, 'persona', dryRun);
}

// 2. Move state files
console.log('\n── state/ ──');
for (const file of STATE_FILES) {
  totalMoved += moveWithBak(memoryDir, file, 'state', dryRun);
}

// 3. Move queue files
console.log('\n── queues/ ──');
for (const file of QUEUE_FILES) {
  totalMoved += moveWithBak(memoryDir, file, 'queues', dryRun);
}

// 4. Archive ops-*.md reports into ops/ subdirectories
console.log('\n── ops/ (report archival) ──');
const opsDir = path.join(memoryDir, 'ops');
const rootFiles = fs.readdirSync(memoryDir);

for (const file of rootFiles) {
  if (!file.startsWith('ops-') || !file.endsWith('.md')) continue;

  let targetSubdir = 'ops/misc';
  if (file.includes('trends')) targetSubdir = 'ops/trends';
  else if (file.includes('competitor')) targetSubdir = 'ops/competitor-analysis';
  else if (file.includes('performance')) targetSubdir = 'ops/performance';
  else if (file.includes('brief')) targetSubdir = 'ops/briefs';
  else if (file.includes('strategy')) targetSubdir = 'ops/strategy';

  const src = path.join(memoryDir, file);
  const dest = path.join(memoryDir, targetSubdir, file);
  if (moveFile(src, dest, dryRun)) totalMoved++;
}

// 5. Summary
console.log(`\n${dryRun ? '🔍 Dry run complete' : '✅ Migration complete'}: ${totalMoved} file(s) ${dryRun ? 'would be moved' : 'moved'}`);

if (dryRun) {
  console.log('\nRun without --dry-run to apply changes:');
  console.log(`  npx tsx scripts/migrate-memory-layout.ts ${personaId}\n`);
}
