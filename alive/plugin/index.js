import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default definePluginEntry({
  id: 'alive-admin',
  name: 'Alive Admin',
  description: '/alive 管理命令处理器',
  register(api) {
    api.registerCommand({
      name: 'alive',
      description: 'Alive 管理面板 — 查看/修改角色状态，不影响人设和记忆',
      acceptsArgs: true,
      handler: async (ctx) => {
        const handlerPath = path.resolve(__dirname, '../../skills/alive/scripts/admin/command-handler.js');
        const args = ctx.args?.trim() ?? '';
        try {
          const output = execFileSync('node', [handlerPath, args], {
            timeout: 30000,
            encoding: 'utf8',
            env: { ...process.env },
          });
          return { text: output.trim() || '✅ Done.' };
        } catch (err) {
          const stderr = err.stderr?.toString().trim() ?? '';
          const message = stderr || err.message;
          return { text: `❌ ${message}` };
        }
      },
    });
  },
});
