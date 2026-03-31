// e2e/harness/reporter.ts
// Markdown 报告生成器 — 汇总所有交互、断言、状态 diff

import * as fs from 'fs';
import * as path from 'path';
import {
  getContext,
  type HarnessContext,
  type Interaction,
  type SuiteResult,
  type StateSnapshot,
  type Phase,
} from './harness-context';

function snapshotDiff(label: string, before: StateSnapshot | null, after: StateSnapshot | null): string {
  if (!before || !after) return `### ${label}\n\n_No snapshot available._\n`;

  const lines: string[] = [`### ${label}\n`];

  const eBefore = JSON.stringify(before.emotionState, null, 2);
  const eAfter = JSON.stringify(after.emotionState, null, 2);
  if (eBefore !== eAfter) {
    lines.push('#### Emotion State\n');
    lines.push('**Before:**\n```json\n' + eBefore + '\n```\n');
    lines.push('**After:**\n```json\n' + eAfter + '\n```\n');
  }

  const iBefore = JSON.stringify(before.intentPool, null, 2);
  const iAfter = JSON.stringify(after.intentPool, null, 2);
  if (iBefore !== iAfter) {
    lines.push('#### Intent Pool\n');
    lines.push('**Before:**\n```json\n' + iBefore + '\n```\n');
    lines.push('**After:**\n```json\n' + iAfter + '\n```\n');
  }

  if (after.diary.length > before.diary.length) {
    const newContent = after.diary.slice(before.diary.length).trim();
    if (newContent) {
      lines.push('#### New Diary Entries\n');
      lines.push('```markdown\n' + newContent + '\n```\n');
    }
  }

  return lines.join('\n');
}

function formatInteraction(interaction: Interaction, index: number): string {
  const lines: string[] = [];
  lines.push(`#### Interaction ${index + 1}: ${interaction.source}`);
  lines.push('');

  if (interaction.model || interaction.elapsed_ms) {
    const parts: string[] = [];
    if (interaction.model) parts.push(`Model: ${interaction.model}`);
    if (interaction.elapsed_ms) parts.push(`Duration: ${interaction.elapsed_ms}ms`);
    lines.push(`- ${parts.join(' | ')}`);
  }

  if (interaction.prompt) {
    lines.push('');
    lines.push('<details><summary>Prompt</summary>\n');
    lines.push('```');
    lines.push(interaction.prompt.slice(0, 2000));
    if (interaction.prompt.length > 2000) lines.push('\n... [truncated]');
    lines.push('```\n');
    lines.push('</details>\n');
  }

  lines.push('**Response:**\n');
  lines.push('```');
  lines.push(interaction.response);
  lines.push('```\n');

  return lines.join('\n');
}

function suiteStatusIcon(status: SuiteResult['status']): string {
  switch (status) {
    case 'pass': return '✅ PASS';
    case 'fail': return '❌ FAIL';
    case 'review': return '📝 REVIEW';
    case 'skip': return '⏭️ SKIP';
  }
}

export function generateReport(): string {
  const ctx = getContext();
  const lines: string[] = [];

  lines.push(`# Alive Harness Report — ${new Date().toISOString()}\n`);

  // Summary table
  lines.push('## Summary\n');
  lines.push('| Suite | Status | Duration | Assertions |');
  lines.push('|-------|--------|----------|------------|');
  for (const suite of ctx.suiteResults) {
    const dur = `${(suite.durationMs / 1000).toFixed(1)}s`;
    const assertions = `${suite.assertionsPassed}/${suite.assertionsTotal}`;
    lines.push(`| ${suite.name} | ${suiteStatusIcon(suite.status)} | ${dur} | ${assertions} |`);
  }
  lines.push('');

  // Per-phase interactions
  const phases: Phase[] = ['install', 'heartbeat', 'slash', 'chat', 'cleanup'];
  const phaseLabels: Record<Phase, string> = {
    install: '01-Install — 安装验证',
    heartbeat: '02-Heartbeat — 状态变化',
    slash: '03-Slash Commands — 斜杠命令',
    chat: '04-Chat — 聊天质量 (需人工审阅)',
    cleanup: '05-Cleanup — 卸载清理',
  };

  for (const phase of phases) {
    const phaseInteractions = ctx.interactions.filter(i => i.phase === phase);
    if (phaseInteractions.length === 0) continue;

    lines.push(`## ${phaseLabels[phase]}\n`);

    if (phase === 'heartbeat') {
      lines.push(snapshotDiff(
        'Post-Install → Post-Morning',
        ctx.snapshots.postInstall,
        ctx.snapshots.postMorning,
      ));
      for (let i = 0; i < ctx.snapshots.postTick.length; i++) {
        const before = i === 0 ? ctx.snapshots.postMorning : ctx.snapshots.postTick[i - 1];
        lines.push(snapshotDiff(
          `Tick ${i + 1} State Changes`,
          before,
          ctx.snapshots.postTick[i],
        ));
      }
    }

    lines.push('### LLM Interactions\n');
    phaseInteractions.forEach((interaction, idx) => {
      lines.push(formatInteraction(interaction, idx));
    });
  }

  lines.push('---\n');
  lines.push(`Generated at ${new Date().toISOString()} by Alive Harness`);

  return lines.join('\n');
}

export function writeReport(): string {
  const ctx = getContext();
  const reportDir = ctx.config.reportDir;
  fs.mkdirSync(reportDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `harness-report-${timestamp}.md`;
  const filePath = path.join(reportDir, fileName);

  const content = generateReport();
  fs.writeFileSync(filePath, content, 'utf8');

  console.log(`\n📋 Report written to: ${filePath}`);
  return filePath;
}
