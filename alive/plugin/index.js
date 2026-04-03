import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { execFileSync } from 'child_process';
import path from 'path';

// Shared helper: run a Node.js script with args, return stdout as text
function runScript(scriptPath, args, timeoutMs = 120000) {
  const output = execFileSync('node', [scriptPath, ...args], {
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { ...process.env },
  });
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error('Handler returned empty output — possible CLI entry point issue.');
  }
  return trimmed;
}

// Ops commands that should be routed to ops-command-handler.js
// NOTE: 'status' belongs to admin (角色综合状态), not ops.
const OPS_COMMANDS = new Set([
  'brief', 'trends', 'idea', 'post', 'analyze', 'advice', 'message',
]);

// Heuristic: detect free-text that should go to the ops review handler
// instead of the admin handler. Triggers when the text contains a platform URL
// or publish-intent keywords.
const REVIEW_URL_PATTERN = /https?:\/\/(www\.)?(xiaohongshu\.com|xhslink\.com|douyin\.com)/i;
const REVIEW_KEYWORDS = ['已发', '发了', '发布了', '上线了', '发出去了', '好', '发', '不要', '弃掉', '算了', '改成', '修改'];

function looksLikeReviewMessage(text) {
  if (REVIEW_URL_PATTERN.test(text)) return true;
  return REVIEW_KEYWORDS.some(kw => text.includes(kw));
}

export default definePluginEntry({
  id: 'alive-admin',
  name: 'Alive Admin',
  description: '/alive 管理面板 + 运营工作台（/alive brief、/alive trends 等）',
  register(api) {
    // Use absolute path based on HOME to avoid relative path issues
    // (e.g. double "skills/skills/" when plugin is installed via --link)
    const SKILLS_DIR = path.join(process.env.HOME, '.openclaw', 'skills');
    const adminHandlerPath = path.join(SKILLS_DIR, 'alive', 'scripts', 'admin', 'command-handler.js');
    const opsHandlerPath = path.join(SKILLS_DIR, 'alive', 'scripts', 'ops', 'ops-command-handler.js');

    api.registerCommand({
      name: 'alive',
      description: 'Alive 管理面板 + 运营工作台\n'
        + '管理: /alive status, /alive emotion, /alive schedule, /alive skills, /alive help\n'
        + '运营: /alive brief, /alive trends, /alive idea [方向], /alive post [N], '
        + '/alive analyze <URL>, /alive advice',
      acceptsArgs: true,
      handler: async (ctx) => {
        const rawArgs = ctx.args?.trim() ?? '';
        const firstWord = rawArgs.split(/\s+/)[0]?.toLowerCase() ?? '';

        // Route ops commands to ops-command-handler
        if (OPS_COMMANDS.has(firstWord)) {
          const opsArgs = rawArgs.split(/\s+/);
          try {
            return { text: runScript(opsHandlerPath, opsArgs) };
          } catch (err) {
            const stderr = err.stderr?.toString().trim() ?? '';
            return { text: `❌ ${stderr || err.message}` };
          }
        }

        // Route free-text review messages (publish confirmations, approvals, etc.)
        if (rawArgs && !rawArgs.startsWith('/') && looksLikeReviewMessage(rawArgs)) {
          try {
            return { text: runScript(opsHandlerPath, ['message', rawArgs]) };
          } catch (err) {
            const stderr = err.stderr?.toString().trim() ?? '';
            return { text: `❌ ${stderr || err.message}` };
          }
        }

        // Route everything else to admin command-handler
        try {
          return { text: runScript(adminHandlerPath, [rawArgs], 30000) };
        } catch (err) {
          const stderr = err.stderr?.toString().trim() ?? '';
          const message = stderr || err.message;
          return { text: `❌ ${message}` };
        }
      },
    });
  },
});
