/**
 * kb-query.ts
 * Handles /alive kb <subcommand> [flags] for querying the viral content knowledge base.
 *
 * Subcommands:
 *   status                       — overall KB statistics
 *   search <keyword>             — full-text search across entries
 *   list [--platform X] [--type Y] — list entries with optional filters
 *   formulas [--platform X]      — list UniversalFormulas
 *   top [--platform X] [--limit N] — top entries by likes
 *   (unknown / empty)            — show help text
 */

import {
  getStats,
  queryAll,
  queryFormulas,
  KBStats,
} from '../../../scripts/ops/viral-kb-store';
import { ViralEntry, UniversalFormula } from '../../../scripts/utils/types';

// ─── Markdown formatters ──────────────────────────────────────────────────────

function formatStats(stats: KBStats): string {
  const platformRows = Object.entries(stats.by_platform)
    .map(([p, n]) => `| ${p} | ${n} |`)
    .join('\n');

  const tierRows = Object.entries(stats.by_tier)
    .map(([t, n]) => `| ${t} | ${n} |`)
    .join('\n');

  return [
    '## 📚 Viral KB 统计',
    '',
    `- 总条目：${stats.total}`,
    `- 通用公式：${stats.formula_count}`,
    `- 待拆解队列：${stats.queue_length}`,
    '',
    '### 平台分布',
    '',
    '| 平台 | 条目数 |',
    '|------|--------|',
    platformRows || '| — | — |',
    '',
    '### 分类分布',
    '',
    '| 分类 | 条目数 |',
    '|------|--------|',
    tierRows || '| — | — |',
  ].join('\n');
}

function formatEntries(entries: ViralEntry[], title: string): string {
  if (entries.length === 0) {
    return `## ${title}\n\n暂无匹配记录。`;
  }

  const rows = entries.map(e => {
    const d = e.dissection;
    const contentType = d?.content_type ?? '—';
    const hookType = d?.hook_type ?? '—';
    const emotionArc = d?.emotion_arc ?? '—';
    const likes = e.likes.toLocaleString();
    const summary = d?.summary ?? '—';
    return `| ${contentType} | ${hookType} | ${emotionArc} | ${likes} | ${summary} |`;
  }).join('\n');

  return [
    `## ${title}（${entries.length} 条）`,
    '',
    '| content_type | hook_type | emotion_arc | likes | summary |',
    '|-------------|-----------|-------------|-------|---------|',
    rows,
  ].join('\n');
}

function formatFormulas(formulas: UniversalFormula[]): string {
  if (formulas.length === 0) {
    return '## 🔮 通用爆款公式\n\n暂无公式（需要同一组合出现 ≥3 次才会升级）。';
  }

  const rows = formulas.map(f => {
    const injected = f.injected_to_templates ? '✅' : '—';
    return `| ${f.platform} | ${f.content_type} | ${f.hook_type} | ${f.occurrence_count} | ${injected} | ${f.formula_summary} |`;
  }).join('\n');

  return [
    `## 🔮 通用爆款公式（${formulas.length} 条）`,
    '',
    '| 平台 | content_type | hook_type | 次数 | 已注入 | 公式摘要 |',
    '|------|-------------|-----------|------|--------|---------|',
    rows,
  ].join('\n');
}

function helpText(): string {
  return [
    '## 📖 /alive kb — 爆款知识库查询',
    '',
    '| 子命令 | 说明 |',
    '|--------|------|',
    '| `kb status` | 统计信息（总条数/平台分布/队列） |',
    '| `kb search <关键词>` | 全文搜索 summary + content_type |',
    '| `kb list [--platform douyin/xhs] [--type 种草类]` | 按平台/类型列出 |',
    '| `kb formulas [--platform douyin/xhs]` | 列出通用爆款公式 |',
    '| `kb top [--platform douyin/xhs] [--limit N]` | 按点赞排 Top N |',
  ].join('\n');
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Handle /alive kb subcommand.
 *
 * @param args    Positional arguments after "kb" (e.g. ["search", "赛车"])
 * @param flags   Named flags (e.g. { platform: "douyin", limit: "5" })
 * @param basePath Memory base directory for this persona
 * @returns Markdown-formatted string to display to the user
 */
export function handleKbCommand(
  args: string[],
  flags: Record<string, string>,
  basePath: string,
): string {
  const sub = args[0] ?? '';

  switch (sub) {
    case 'status': {
      const stats = getStats(basePath);
      return formatStats(stats);
    }

    case 'search': {
      const keyword = args.slice(1).join(' ').trim();
      if (!keyword) return '⚠️ 请提供搜索关键词，例如：`/alive kb search 赛车`';
      const entries = queryAll(basePath, { keyword });
      return formatEntries(entries, `搜索结果：「${keyword}」`);
    }

    case 'list': {
      const platform = flags['platform'] as 'douyin' | 'xhs' | undefined;
      const type = flags['type'];
      const entries = queryAll(basePath, { platform, type });
      const titleParts = ['条目列表'];
      if (platform) titleParts.push(platform);
      if (type) titleParts.push(type);
      return formatEntries(entries, titleParts.join(' · '));
    }

    case 'formulas': {
      const platform = flags['platform'] as 'douyin' | 'xhs' | undefined;
      const formulas = queryFormulas(basePath, { platform });
      return formatFormulas(formulas);
    }

    case 'top': {
      const platform = flags['platform'] as 'douyin' | 'xhs' | undefined;
      const limit = flags['limit'] ? parseInt(flags['limit'], 10) : 10;
      const entries = queryAll(basePath, { platform, sort: 'likes', limit });
      const titleParts = ['Top 点赞榜'];
      if (platform) titleParts.push(platform);
      return formatEntries(entries, titleParts.join(' · '));
    }

    default:
      return helpText();
  }
}
