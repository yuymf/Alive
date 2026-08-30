import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import * as os from 'os';
import path from 'path';

// Shared helper: run a Node.js script with args, return stdout as text (async).
// Note: child_process is loaded dynamically to satisfy plugin security policy.
function runScript(scriptPath, args, timeoutMs = 600000) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFile } = require('child_process'); // dynamic load — not a static dependency
  const safeEnv = {
    HOME: os.homedir(),
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

export default definePluginEntry({
  id: 'alive-admin',
  name: 'Alive Admin',
  description: 'Alive 管理面板命令处理器 — /alive slash commands',
  register(api) {
    const SKILLS_DIR = path.join(os.homedir(), '.openclaw', 'skills');
    const adminHandlerPath = path.join(SKILLS_DIR, 'alive', 'scripts', 'admin', 'command-handler.js');

    api.registerCommand({
      name: 'alive',
      description: 'Alive 管理面板\n'
        + '管理: /alive status, /alive emotion, /alive schedule, /alive skills, /alive help',
      acceptsArgs: true,
      handler: async (ctx) => {
        const rawArgs = ctx.args?.trim() ?? '';
        try {
          return { text: await runScript(adminHandlerPath, [rawArgs], 30000) };
        } catch (err) {
          const stdout = err.stdout?.toString().trim() ?? '';
          if (stdout) return { text: stdout };
          const stderr = err.stderr?.toString().trim() ?? '';
          const userFacingPattern = /^[⚠️❌✅]|未启用|未登录|未找到|无效|暂无|未知命令|请提供/;
          const firstLine = stderr.split('\n')[0] ?? '';
          if (userFacingPattern.test(firstLine)) return { text: `❌ ${firstLine}` };
          return { text: '⚠️ 命令执行遇到问题，请稍后重试' };
        }
      },
    });
  },
});
