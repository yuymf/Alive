#!/usr/bin/env npx tsx

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

interface QualityReportLite {
  overall_pass?: boolean;
  diagnosis?: string;
  image_consistency?: {
    pass?: boolean;
    average?: { face?: number; style?: number; natural?: number };
    issues?: string[];
  };
  emotion_dynamics?: {
    pass?: boolean;
    variation?: number;
    event_response?: number;
    description_diversity?: number;
    dimension_coupling?: number;
    issues?: string[];
  };
  memory_quality?: {
    pass?: boolean;
    diary_diversity?: number;
    diary_voice?: number;
    wisdom_actionability?: number;
    wisdom_relevance?: number;
    character_consistency?: number;
    issues?: string[];
  };
}

interface DayRunResult {
  dayIndex: number;
  date: string;
  archiveDir: string;
  commandSuccess: boolean;
  commandDurationMs: number;
  commandError?: string;
  qualityReportExists: boolean;
  qualitySummaryExists: boolean;
  qualityOverallPass?: boolean;
  imagePass?: boolean;
  emotionPass?: boolean;
  memoryPass?: boolean;
  diagnosis?: string;
  topIssues: string[];
}

interface WeeklySummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  startDate: string;
  days: number;
  outputRoot: string;
  stats: {
    commandSuccessDays: number;
    commandFailedDays: number;
    qualityReportDays: number;
    qualityOverallPassDays: number;
  };
  averages: {
    image: { face: number | null; style: number | null; natural: number | null };
    emotion: { variation: number | null; eventResponse: number | null; descriptionDiversity: number | null; dimensionCoupling: number | null };
    memory: {
      diaryDiversity: number | null;
      diaryVoice: number | null;
      wisdomActionability: number | null;
      wisdomRelevance: number | null;
      characterConsistency: number | null;
    };
  };
  dayResults: DayRunResult[];
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
const E2E_OUTPUT_DIR = path.join(PROJECT_ROOT, 'e2e', 'e2e-output');
const WEEKLY_ROOT = path.join(PROJECT_ROOT, 'e2e', 'weekly-runs');

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function parseStartDate(input: string): Date {
  const d = new Date(`${input}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid MINASE_WEEK_START date: ${input}. Expected YYYY-MM-DD.`);
  }
  return d;
}

function parseDays(input: string | undefined): number {
  const parsed = Number(input ?? '7');
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 31) {
    throw new Error(`Invalid MINASE_WEEK_DAYS: ${input ?? ''}. Expected integer in [1, 31].`);
  }
  return parsed;
}

function toNumberOrNull(values: Array<number | undefined>): number | null {
  const valid = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (valid.length === 0) return null;
  const avg = valid.reduce((sum, v) => sum + v, 0) / valid.length;
  return Math.round(avg * 100) / 100;
}

function safeReadJSON<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function copyOutputTo(archiveDir: string): void {
  fs.mkdirSync(archiveDir, { recursive: true });
  if (!fs.existsSync(E2E_OUTPUT_DIR)) return;
  fs.cpSync(E2E_OUTPUT_DIR, archiveDir, { recursive: true, force: true });
}

function collectTopIssues(report: QualityReportLite | null): string[] {
  if (!report) return [];
  const issues: string[] = [];
  for (const item of report.image_consistency?.issues ?? []) issues.push(`[image] ${item}`);
  for (const item of report.emotion_dynamics?.issues ?? []) issues.push(`[emotion] ${item}`);
  for (const item of report.memory_quality?.issues ?? []) issues.push(`[memory] ${item}`);
  return issues.slice(0, 8);
}

function runOneDay(opts: { dayIndex: number; date: string; archiveDir: string }): DayRunResult {
  const startedAt = Date.now();
  const args = ['vitest', 'run', '--config', 'vitest.e2e.config.ts', 'e2e/e2e-lifecycle.test.ts'];

  let commandSuccess = true;
  let commandError: string | undefined;
  let stdout = '';
  let stderr = '';

  try {
    stdout = execFileSync('npx', args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        E2E_SIM_DATE: opts.date,
      },
      stdio: 'pipe',
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    commandSuccess = false;
    const e = err as {
      message?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout ? e.stdout.toString('utf8') : '');
    stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr ? e.stderr.toString('utf8') : '');
    commandError = [e.message, stderr.trim()].filter(Boolean).join('\n').slice(0, 2000);
  }

  copyOutputTo(opts.archiveDir);

  if (stdout) {
    fs.writeFileSync(path.join(opts.archiveDir, 'vitest.stdout.log'), stdout);
  }
  if (stderr) {
    fs.writeFileSync(path.join(opts.archiveDir, 'vitest.stderr.log'), stderr);
  }

  const qualityReportPath = path.join(opts.archiveDir, 'quality-report.json');
  const qualitySummaryPath = path.join(opts.archiveDir, 'quality-summary.md');
  const report = safeReadJSON<QualityReportLite>(qualityReportPath);

  const result: DayRunResult = {
    dayIndex: opts.dayIndex,
    date: opts.date,
    archiveDir: opts.archiveDir,
    commandSuccess,
    commandDurationMs: Date.now() - startedAt,
    commandError,
    qualityReportExists: fs.existsSync(qualityReportPath),
    qualitySummaryExists: fs.existsSync(qualitySummaryPath),
    qualityOverallPass: report?.overall_pass,
    imagePass: report?.image_consistency?.pass,
    emotionPass: report?.emotion_dynamics?.pass,
    memoryPass: report?.memory_quality?.pass,
    diagnosis: report?.diagnosis,
    topIssues: collectTopIssues(report),
  };

  fs.writeFileSync(path.join(opts.archiveDir, 'day-result.json'), JSON.stringify(result, null, 2));
  return result;
}

function buildWeeklySummary(params: {
  runId: string;
  startedAt: string;
  finishedAt: string;
  startDate: string;
  days: number;
  outputRoot: string;
  dayResults: DayRunResult[];
}): WeeklySummary {
  const reports = params.dayResults.map(r =>
    safeReadJSON<QualityReportLite>(path.join(r.archiveDir, 'quality-report.json'))
  );

  const summary: WeeklySummary = {
    runId: params.runId,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    startDate: params.startDate,
    days: params.days,
    outputRoot: params.outputRoot,
    stats: {
      commandSuccessDays: params.dayResults.filter(d => d.commandSuccess).length,
      commandFailedDays: params.dayResults.filter(d => !d.commandSuccess).length,
      qualityReportDays: params.dayResults.filter(d => d.qualityReportExists).length,
      qualityOverallPassDays: params.dayResults.filter(d => d.qualityOverallPass === true).length,
    },
    averages: {
      image: {
        face: toNumberOrNull(reports.map(r => r?.image_consistency?.average?.face)),
        style: toNumberOrNull(reports.map(r => r?.image_consistency?.average?.style)),
        natural: toNumberOrNull(reports.map(r => r?.image_consistency?.average?.natural)),
      },
      emotion: {
        variation: toNumberOrNull(reports.map(r => r?.emotion_dynamics?.variation)),
        eventResponse: toNumberOrNull(reports.map(r => r?.emotion_dynamics?.event_response)),
        descriptionDiversity: toNumberOrNull(reports.map(r => r?.emotion_dynamics?.description_diversity)),
        dimensionCoupling: toNumberOrNull(reports.map(r => r?.emotion_dynamics?.dimension_coupling)),
      },
      memory: {
        diaryDiversity: toNumberOrNull(reports.map(r => r?.memory_quality?.diary_diversity)),
        diaryVoice: toNumberOrNull(reports.map(r => r?.memory_quality?.diary_voice)),
        wisdomActionability: toNumberOrNull(reports.map(r => r?.memory_quality?.wisdom_actionability)),
        wisdomRelevance: toNumberOrNull(reports.map(r => r?.memory_quality?.wisdom_relevance)),
        characterConsistency: toNumberOrNull(reports.map(r => r?.memory_quality?.character_consistency)),
      },
    },
    dayResults: params.dayResults,
  };

  return summary;
}

function toMarkdown(summary: WeeklySummary): string {
  const lines: string[] = [];
  lines.push('# Minase Weekly Mock Simulation Summary');
  lines.push('');
  lines.push(`- Run ID: \`${summary.runId}\``);
  lines.push(`- Started: \`${summary.startedAt}\``);
  lines.push(`- Finished: \`${summary.finishedAt}\``);
  lines.push(`- Start Date: \`${summary.startDate}\``);
  lines.push(`- Days: \`${summary.days}\``);
  lines.push(`- Output Root: \`${summary.outputRoot}\``);
  lines.push('');

  lines.push('## Overall Stats');
  lines.push('');
  lines.push(`- Command success days: ${summary.stats.commandSuccessDays}/${summary.days}`);
  lines.push(`- Command failed days: ${summary.stats.commandFailedDays}/${summary.days}`);
  lines.push(`- Quality report days: ${summary.stats.qualityReportDays}/${summary.days}`);
  lines.push(`- Quality overall pass days: ${summary.stats.qualityOverallPassDays}/${summary.days}`);
  lines.push('');

  lines.push('## Average Scores');
  lines.push('');
  lines.push(`- Image: face=${summary.averages.image.face ?? 'N/A'}, style=${summary.averages.image.style ?? 'N/A'}, natural=${summary.averages.image.natural ?? 'N/A'}`);
  lines.push(`- Emotion: variation=${summary.averages.emotion.variation ?? 'N/A'}, event_response=${summary.averages.emotion.eventResponse ?? 'N/A'}, description_diversity=${summary.averages.emotion.descriptionDiversity ?? 'N/A'}, dimension_coupling=${summary.averages.emotion.dimensionCoupling ?? 'N/A'}`);
  lines.push(`- Memory: diary_diversity=${summary.averages.memory.diaryDiversity ?? 'N/A'}, diary_voice=${summary.averages.memory.diaryVoice ?? 'N/A'}, wisdom_actionability=${summary.averages.memory.wisdomActionability ?? 'N/A'}, wisdom_relevance=${summary.averages.memory.wisdomRelevance ?? 'N/A'}, character_consistency=${summary.averages.memory.characterConsistency ?? 'N/A'}`);
  lines.push('');

  lines.push('## Day-by-day');
  lines.push('');
  for (const day of summary.dayResults) {
    lines.push(`### Day ${String(day.dayIndex).padStart(2, '0')} — ${day.date}`);
    lines.push(`- command: ${day.commandSuccess ? 'success' : 'failed'} (${(day.commandDurationMs / 1000).toFixed(1)}s)`);
    lines.push(`- quality report: ${day.qualityReportExists ? 'yes' : 'no'}`);
    lines.push(`- overall pass: ${day.qualityOverallPass === undefined ? 'N/A' : String(day.qualityOverallPass)}`);
    lines.push(`- dimension pass: image=${day.imagePass === undefined ? 'N/A' : String(day.imagePass)}, emotion=${day.emotionPass === undefined ? 'N/A' : String(day.emotionPass)}, memory=${day.memoryPass === undefined ? 'N/A' : String(day.memoryPass)}`);
    if (day.commandError) {
      lines.push(`- command error: ${day.commandError.replace(/\n+/g, ' | ')}`);
    }
    if (day.diagnosis) {
      lines.push(`- diagnosis: ${day.diagnosis}`);
    }
    if (day.topIssues.length > 0) {
      lines.push('- top issues:');
      for (const issue of day.topIssues) {
        lines.push(`  - ${issue}`);
      }
    }
    lines.push(`- archive: \`${day.archiveDir}\``);
    lines.push('');
  }

  return lines.join('\n');
}

function main(): void {
  const days = parseDays(process.env.MINASE_WEEK_DAYS);
  const startDateText = process.env.MINASE_WEEK_START ?? '2026-06-15';
  const startDate = parseStartDate(startDateText);
  const runId = process.env.MINASE_WEEK_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = path.join(WEEKLY_ROOT, runId);
  const startedAt = new Date().toISOString();

  fs.mkdirSync(runRoot, { recursive: true });

  console.log('=== Minase Weekly Mock Simulation ===');
  console.log(`runId: ${runId}`);
  console.log(`startDate: ${startDateText}`);
  console.log(`days: ${days}`);
  console.log('mode: mock-only (uses e2e-lifecycle.test.ts)');
  console.log('');

  const dayResults: DayRunResult[] = [];

  for (let i = 0; i < days; i += 1) {
    const date = formatDate(addDays(startDate, i));
    const dayLabel = `day-${String(i + 1).padStart(2, '0')}-${date}`;
    const archiveDir = path.join(runRoot, dayLabel);

    console.log(`[${i + 1}/${days}] Running simulated day: ${date}`);
    const dayResult = runOneDay({
      dayIndex: i + 1,
      date,
      archiveDir,
    });

    dayResults.push(dayResult);

    console.log(`  command=${dayResult.commandSuccess ? 'success' : 'failed'} | qualityReport=${dayResult.qualityReportExists ? 'yes' : 'no'} | overallPass=${dayResult.qualityOverallPass === undefined ? 'N/A' : String(dayResult.qualityOverallPass)}`);
    if (dayResult.commandError) {
      console.log(`  error=${dayResult.commandError.split('\n')[0]}`);
    }
    console.log(`  archived=${archiveDir}`);
    console.log('');
  }

  const finishedAt = new Date().toISOString();
  const summary = buildWeeklySummary({
    runId,
    startedAt,
    finishedAt,
    startDate: startDateText,
    days,
    outputRoot: runRoot,
    dayResults,
  });

  const weeklyJsonPath = path.join(runRoot, 'weekly-summary.json');
  const weeklyMdPath = path.join(runRoot, 'weekly-summary.md');

  fs.writeFileSync(weeklyJsonPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(weeklyMdPath, toMarkdown(summary));

  console.log('=== Weekly Summary ===');
  console.log(`commandSuccessDays: ${summary.stats.commandSuccessDays}/${summary.days}`);
  console.log(`qualityOverallPassDays: ${summary.stats.qualityOverallPassDays}/${summary.days}`);
  console.log(`weekly-summary.json: ${weeklyJsonPath}`);
  console.log(`weekly-summary.md: ${weeklyMdPath}`);
}

main();
