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
  auditEntries,
  requeueEntriesForRepair,
  isHollowEntry,
  dedupEntries,
  clearEntries,
  KBStats,
  KBAuditReport,
  DedupResult,
} from '../../../scripts/ops/viral-kb-store';
import { ViralEntry, UniversalFormula, ViralPlatform, ViralSourceType } from '../../../scripts/utils/types';

// ─── Markdown formatters ──────────────────────────────────────────────────────

function formatStats(stats: KBStats): string {
  const platformRows = Object.entries(stats.by_platform)
    .map(([p, n]) => `| ${p} | ${n} |`)
    .join('\n');

  const tierRows = Object.entries(stats.by_tier)
    .map(([t, n]) => `| ${t} | ${n} |`)
    .join('\n');

  const contentTypeRows = Object.entries(stats.by_content_type)
    .map(([type, count]) => `| ${type} | ${count} |`)
    .join('\n');

  const hookTypeRows = Object.entries(stats.by_hook_type)
    .map(([type, count]) => `| ${type} | ${count} |`)
    .join('\n');

  return [
    '## 📚 Viral KB 统计',
    '',
    `- 总条目：${stats.total}`,
    `- 可参考条目：${stats.usable_count}`,
    `- 空壳条目：${stats.hollow_count}`,
    `- 失败条目：${stats.failed_count}`,
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
    '',
    '### 内容类型分布',
    '',
    '| content_type | 条目数 |',
    '|--------------|--------|',
    contentTypeRows || '| — | — |',
    '',
    '### 钩子类型分布',
    '',
    '| hook_type | 条目数 |',
    '|-----------|--------|',
    hookTypeRows || '| — | — |',
  ].join('\n');
}

function formatEntryStatus(entry: ViralEntry): string {
  if (isHollowEntry(entry)) return 'hollow';
  return entry.dissection_status;
}

function formatEntries(entries: ViralEntry[], title: string): string {
  if (entries.length === 0) {
    return `## ${title}\n\n暂无匹配记录。`;
  }

  const rows = entries.map(e => {
    const d = e.dissection;
    const status = formatEntryStatus(e);
    const contentType = d?.content_type ?? '—';
    const hookType = d?.hook_type ?? '—';
    const likes = e.likes.toLocaleString();
    const summary = d?.summary || '—';
    return `| ${status} | ${e.source_type} | ${e.kb_tier} | ${e.title} | ${contentType} | ${hookType} | ${likes} | ${summary} |`;
  }).join('\n');

  return [
    `## ${title}（${entries.length} 条）`,
    '',
    '| status | source_type | tier | title | content_type | hook_type | likes | summary |',
    '|--------|-------------|------|-------|--------------|-----------|-------|---------|',
    rows,
  ].join('\n');
}

function formatAudit(report: KBAuditReport): string {
  const hollowRows = report.hollow_entry_ids.length > 0
    ? report.hollow_entry_ids.map(id => `| ${id} | hollow |`).join('\n')
    : '| — | — |';

  return [
    '## 🩺 Viral KB 质量审计',
    '',
    `- 总条目：${report.total}`,
    `- 可参考条目：${report.usable_count}`,
    `- 空壳条目：${report.hollow_count}`,
    `- 失败条目：${report.failed_count}`,
    '',
    '### Hollow 条目',
    '',
    '| entry_id | status |',
    '|----------|--------|',
    hollowRows,
  ].join('\n');
}

function formatFormulas(formulas: UniversalFormula[]): string {
  if (formulas.length === 0) {
    return '## 🔮 爆款共性结构\n\n暂无共性结构（需要同一组合出现 ≥3 次才会升级）。';
  }

  // Sort by confidence descending
  const sorted = [...formulas].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  const blocks = sorted.map(f => {
    const conf = f.confidence !== undefined ? `${Math.round(f.confidence * 100)}%` : '—';
    const sources = f.distinct_source_count ?? '—';
    const parts: string[] = [
      `**${f.content_type} × ${f.hook_type}**（${f.platform}）`,
      `- 出现次数：${f.occurrence_count} | 来源多样性：${sources} | 置信度：${conf}`,
    ];

    if (f.structural_template) {
      parts.push(`- 句式结构：\`${f.structural_template}\``);
    }

    if (f.example_titles && f.example_titles.length > 0) {
      const examples = f.example_titles.map(t => `  - 「${t}」`).join('\n');
      parts.push(`- 代表标题：`);
      parts.push(examples);
    }

    if (f.trigger_words && f.trigger_words.length > 0) {
      parts.push(`- 高频触发词：${f.trigger_words.join('、')}`);
    }

    parts.push(`- 摘要：${f.formula_summary}`);

    return parts.join('\n');
  }).join('\n\n');

  return [
    `## 🔮 爆款共性结构（${formulas.length} 条）`,
    '',
    '> 以下结构提炼自多个爆款案例，供运营参考。不再自动注入 persona 模板。',
    '',
    blocks,
  ].join('\n');
}

function helpText(): string {
  return [
    '## 📖 /alive kb — 爆款知识库查询',
    '',
    '| 子命令 | 说明 |',
    '|--------|------|',
    '| `kb status` | 统计信息（总条数/usable/hollow/failed/分布） |',
    '| `kb search <关键词>` | 全文搜索 summary + content_type |',
    '| `kb list [--platform douyin/xhs] [--type 种草类] [--status done|failed|hollow] [--source competitor|search|trending_feed]` | 按条件列出条目 |',
    '| `kb audit` | 查看空壳条目和质量摘要 |',
    '| `kb repair [--limit N]` | 将 hollow 条目重新入队修复 |',
    '| `kb dedup` | 去除重复条目（同平台+同标题保留 likes 最高的） |',
    '| `kb clear` | 清空所有条目 |',
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
      const platform = flags['platform'] as ViralPlatform | undefined;
      const type = flags['type'];
      const source = flags['source'] as ViralSourceType | undefined;
      const status = flags['status'] as 'done' | 'failed' | 'hollow' | undefined;
      const entries = queryAll(basePath, { platform, type, source, status });
      const titleParts = ['条目列表'];
      if (platform) titleParts.push(platform);
      if (type) titleParts.push(type);
      if (status) titleParts.push(status);
      if (source) titleParts.push(source);
      return formatEntries(entries, titleParts.join(' · '));
    }

    case 'audit': {
      const report = auditEntries(basePath);
      return formatAudit(report);
    }

    case 'repair': {
      const rawLimit = flags['limit'] ? parseInt(flags['limit'], 10) : 10;
      const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 10 : rawLimit;
      const result = requeueEntriesForRepair(basePath, { limit, reason: 'hollow_result' });
      return [
        '## 🛠️ Viral KB 修复',
        '',
        `- 扫描到可修复条目：${result.scanned}`,
        `- 已重新入队：${result.requeued}`,
        `- 本轮跳过：${result.skipped}`,
      ].join('\n');
    }

    case 'dedup': {
      const result = dedupEntries(basePath);
      return [
        '## 🧹 Viral KB 去重',
        '',
        `- 去重前：${result.before} 条`,
        `- 去重后：${result.after} 条`,
        `- 移除：${result.removed} 条`,
      ].join('\n');
    }

    case 'clear': {
      const count = clearEntries(basePath);
      return `## 🗑️ Viral KB 清空\n\n已清空 ${count} 条条目。`;
    }

    case 'formulas': {
      const platform = flags['platform'] as ViralPlatform | undefined;
      const formulas = queryFormulas(basePath, { platform });
      return formatFormulas(formulas);
    }

    case 'top': {
      const platform = flags['platform'] as ViralPlatform | undefined;
      const rawLimit = flags['limit'] ? parseInt(flags['limit'], 10) : 10;
      const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 10 : rawLimit;
      const entries = queryAll(basePath, { platform, sort: 'likes', limit });
      const titleParts = ['Top 点赞榜'];
      if (platform) titleParts.push(platform);
      return formatEntries(entries, titleParts.join(' · '));
    }

    default:
      return helpText();
  }
}
