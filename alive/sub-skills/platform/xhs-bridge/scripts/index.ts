/**
 * xhs-bridge sub-skill — 小红书 (Xiaohongshu/RED) platform API layer.
 *
 * Service sub-skill: provides API wrappers for other sub-skills
 * to import directly, rather than binding to intents.
 */

import type { SubSkillContext, SubSkillResult } from '../../../../scripts/utils/types';
import {
  isXhsAvailable,
  listXhsFeed,
  searchXhsNotes,
  getXhsNoteDetail,
} from './xhs-client';

// Re-export all client functions for direct import by other sub-skills
export {
  isXhsAvailable,
  listXhsFeed,
  searchXhsNotes,
  getXhsNoteDetail,
} from './xhs-client';

// Re-export types
export type {
  XhsNote,
  XhsNoteDetail,
  XhsSearchOptions,
} from './xhs-client';

// Actions (for router-based invocation if needed)
export const actions: Record<string, (ctx: SubSkillContext) => Promise<SubSkillResult>> = {
  async 'xhs-check-login'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const available = await isXhsAvailable();
    return {
      narrative: available ? '小红书已登录可用' : '小红书未登录或不可用',
    };
  },

  async 'xhs-list-feed'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const notes = await listXhsFeed();
    return {
      narrative: `Retrieved ${notes.length} notes from 小红书 homepage feed`,
    };
  },

  async 'xhs-search'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const keyword = ctx.config.keyword as string;
    const options = (ctx.config.options ?? {}) as Record<string, string>;
    const notes = await searchXhsNotes(keyword, options);
    return {
      narrative: `Found ${notes.length} notes for "${keyword}" on 小红书`,
    };
  },

  async 'xhs-note-detail'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const noteId = ctx.config.noteId as string;
    const xsecToken = ctx.config.xsecToken as string;
    const detail = await getXhsNoteDetail(noteId, xsecToken);
    return {
      narrative: `Retrieved note detail: "${detail.title}" (${detail.likes} likes, ${detail.comments.length} comments)`,
    };
  },
};

export const manifest = {
  name: 'xhs-bridge',
  display_name: '小红书桥接',
  version: '0.1.0',
  description: '小红书平台 API 封装',
  intent_bindings: [],
};
