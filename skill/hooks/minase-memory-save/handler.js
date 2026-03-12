// minase-memory-save hook handler
// Injects a memory-save reminder when session ends via /new or /reset.

const fs = require('fs');
const path = require('path');

const MEMORY_BASE = path.join(process.env.HOME, '.openclaw', 'workspace', 'memory', 'minase');

const handler = async (event) => {
  if (event.type !== 'command') return;
  if (event.action !== 'new' && event.action !== 'reset') return;

  // Only trigger if minase is installed
  if (!fs.existsSync(MEMORY_BASE)) return;

  const reminder = [
    '[Minase Memory Save — session ending]',
    '水瀬，这次对话要结束了。请完成以下操作：',
    '1. 将本次对话的重要内容写入 diary.md（附重要性评分和标签）',
    '2. 更新 relations/{user_id}.json（如果有新的关系信息）',
    '3. 更新 emotion-state.json（反映对话后的情绪变化）',
    '4. 如果有特别重要的领悟（importance >= 7），更新 core-wisdom.json',
  ].join('\n');

  if (event.messages) {
    event.messages.push(reminder);
  }
};

module.exports = handler;
module.exports.default = handler;
