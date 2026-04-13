// alive/scripts/ops/ops-intent-recognizer.ts
// Keyword-based intent recognizer for ops commands.
// Maps keyword hits like "帮我出几个选题" → { command: 'idea', args: [] }
//
// This module provides ONLY fast keyword matching — no LLM calls.
// Natural-language messages that don't match any keyword will fall through
// to the OpenClaw agent, which uses SKILL.md to decide the correct command.

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecognizedIntent {
  /** The resolved /alive sub-command, or 'unknown' if unrecognizable */
  command: string;
  /** Extracted arguments (e.g. URL for analyze, direction for idea) */
  args: string[];
  /** Confidence score 0-1 */
  confidence: number;
  /** Brief explanation for debugging */
  reason: string;
}

// ─── Keyword-based fast path (no LLM needed) ────────────────────────────────

interface KeywordRule {
  command: string;
  keywords: string[];
  /** If a regex matches, extract group 1 as the first arg */
  argPattern?: RegExp;
}

const KEYWORD_RULES: KeywordRule[] = [
  {
    command: 'brief',
    keywords: ['简报', '日报', '今日简报', '今天简报', '运营简报', '看看简报', '每日简报', '工作台'],
  },
  {
    command: 'trends',
    keywords: ['热点', '趋势', '热门', '热搜', '有什么火的', '最近火什么', '什么热门', '流行什么'],
  },
  {
    command: 'idea',
    keywords: ['选题', '出选题', '想选题', '帮我出选题', '灵感', '内容方向', '写什么', '发什么', '出几个选题', '想想发什么'],
    argPattern: /(?:关于|方向|主题|围绕|聚焦)[：:]?\s*(.+)/,
  },
  {
    command: 'post',
    keywords: ['选题列表', '看选题', '查看选题', '待审核', '审核列表', '有什么选题'],
    argPattern: /(?:第|看第|查看第)\s*(\d+)/,
  },
  {
    command: 'analyze',
    keywords: ['拆解', '分析', '爆款分析', '帮我分析', '爆款拆解', '拆一下', '学习一下这个'],
    argPattern: /(https?:\/\/[^\s]+)/,
  },
  {
    command: 'advice',
    keywords: ['建议', '人设建议', '运营建议', '改进建议', '怎么改进', '怎么优化', '给点建议'],
  },
  {
    command: 'status',
    keywords: ['队列状态', '工作台状态', '运营状态', '现在什么状态'],
  },
  {
    command: 'candidates',
    keywords: ['对标', '对标账号', '候选账号', '竞品候选', '谁值得学'],
  },
  {
    command: 'health',
    keywords: ['健康检查', '系统检查', '检查一下', '诊断'],
  },
  {
    command: 'strategy',
    keywords: ['策略', '内容策略', '周策略', '本周策略'],
  },
  {
    command: 'insights',
    keywords: ['表现', '数据', '内容表现', '数据怎么样', '效果怎么样', '表现数据'],
  },
  {
    command: 'patterns',
    keywords: ['模式', '内容模式', '规律', '什么模式好'],
  },
  {
    command: 'kb search',
    keywords: ['知识库搜索', '爆款公式', '知识库里有'],
    argPattern: /(?:搜|查|找)[：:]?\s*(.+)/,
  },
  {
    command: 'help',
    keywords: ['帮助', '命令列表', '有什么命令', '能做什么', '都能干啥'],
  },
];

/**
 * Fast keyword-based intent recognition. No LLM call needed.
 * Returns null if no confident match.
 */
export function recognizeByKeywords(text: string): RecognizedIntent | null {
  const normalized = text.trim().toLowerCase();

  for (const rule of KEYWORD_RULES) {
    const matched = rule.keywords.some(kw => normalized.includes(kw));
    if (!matched) continue;

    const args: string[] = [];
    if (rule.argPattern) {
      const m = text.match(rule.argPattern);
      if (m?.[1]) args.push(m[1].trim());
    }

    return {
      command: rule.command,
      args,
      confidence: 0.9,
      reason: `keyword match: ${rule.keywords.find(kw => normalized.includes(kw))}`,
    };
  }

  // Special: if text contains a URL, likely wants analyze
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
  if (urlMatch) {
    const url = urlMatch[1];
    if (/xiaohongshu\.com|xhslink\.com|douyin\.com/i.test(url)) {
      return {
        command: 'analyze',
        args: [url],
        confidence: 0.8,
        reason: 'URL detected (platform link)',
      };
    }
  }

  return null;
}


