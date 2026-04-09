import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import path from 'path';

// Shared helper: run a Node.js script with args, return stdout as text (async).
// Note: child_process is loaded dynamically to satisfy plugin security policy.
function runScript(scriptPath, args, timeoutMs = 600000) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFile } = require('child_process'); // dynamic load — not a static dependency
  // Only forward the minimal set of env vars needed for the script to run.
  // Avoid spreading all of process.env to prevent false-positive credential-harvesting warnings.
  const safeEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    NODE_PATH: process.env.NODE_PATH,
    ALIVE_PERSONA: process.env.ALIVE_PERSONA,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_API_BASE: process.env.LLM_API_BASE,
    LLM_MODEL: process.env.LLM_MODEL,
  };
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath, ...args], {
      timeout: timeoutMs,
      encoding: 'utf8',
      env: safeEnv,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        // Attach stdout/stderr to the error for upstream handlers
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      const trimmed = (stdout ?? '').trim();
      if (!trimmed) {
        return reject(new Error('Handler returned empty output — possible CLI entry point issue.'));
      }
      resolve(trimmed);
    });
  });
}

// Ops commands that should be routed to ops-command-handler.js
// NOTE: 'status' belongs to admin (角色综合状态), not ops.
const OPS_COMMANDS = new Set([
  'brief', 'trends', 'idea', 'post', 'analyze', 'advice', 'message', 'health',
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
            return { text: await runScript(opsHandlerPath, opsArgs) };
          } catch (err) {
            // Prefer stdout (ops-command-handler writes user-facing message to stdout even on failure).
            // Never expose raw stderr — it contains internal logs, not user-facing content.
            const stdout = err.stdout?.toString().trim() ?? '';
            if (stdout) return { text: stdout };
            return { text: '⚠️ 命令执行遇到问题，请稍后重试' };
          }
        }

        // Route free-text review messages (publish confirmations, approvals, etc.)
        if (rawArgs && !rawArgs.startsWith('/') && looksLikeReviewMessage(rawArgs)) {
          try {
            return { text: await runScript(opsHandlerPath, ['message', rawArgs]) };
          } catch (err) {
            const stdout = err.stdout?.toString().trim() ?? '';
            if (stdout) return { text: stdout };
            return { text: '⚠️ 命令执行遇到问题，请稍后重试' };
          }
        }

        // Route everything else to admin command-handler
        try {
          return { text: await runScript(adminHandlerPath, [rawArgs], 30000) };
        } catch (err) {
          const stdout = err.stdout?.toString().trim() ?? '';
          if (stdout) return { text: stdout };
          const stderr = err.stderr?.toString().trim() ?? '';
          // Only surface stderr if it looks like a user-facing error (not a technical log).
          const userFacingPattern = /^[⚠️❌✅]|未启用|未登录|未找到|无效|暂无|未知命令|请提供/;
          const firstLine = stderr.split('\n')[0] ?? '';
          if (userFacingPattern.test(firstLine)) return { text: `❌ ${firstLine}` };
          return { text: '⚠️ 命令执行遇到问题，请稍后重试' };
        }
      },
    });
  },
});
