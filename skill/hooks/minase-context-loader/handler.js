// minase-context-loader hook handler
// Injects core memory context at agent:bootstrap so Minase always remembers.

const fs = require('fs');
const path = require('path');

const MEMORY_BASE = path.join(process.env.HOME, '.openclaw', 'workspace', 'memory', 'minase');

function readFileSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

function readJsonSafe(filePath, defaultValue) {
  const content = readFileSafe(filePath);
  if (content) {
    try {
      return JSON.parse(content);
    } catch {
      // Try .bak
      const bakContent = readFileSafe(filePath + '.bak');
      if (bakContent) {
        try {
          return JSON.parse(bakContent);
        } catch {
          // Give up
        }
      }
    }
  }
  return defaultValue;
}

function getRecentDiary(diaryPath, days) {
  const content = readFileSafe(diaryPath);
  if (!content) return null;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;

  const entries = content.split('\n## ').filter(Boolean);
  const recentEntries = entries.filter(entry => {
    const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})/);
    return dateMatch && dateMatch[1] >= cutoffStr;
  });

  if (recentEntries.length === 0) return null;
  return recentEntries.map(e => `## ${e}`).join('\n').slice(0, 1500);
}

const handler = async (event) => {
  if (event.type !== 'agent' || event.action !== 'bootstrap') {
    return;
  }

  // Check if minase skill directory exists — skip if not installed
  if (!fs.existsSync(MEMORY_BASE)) {
    return;
  }

  const parts = [];

  // 1. Core wisdom
  const wisdom = readJsonSafe(path.join(MEMORY_BASE, 'core-wisdom.json'), null);
  if (wisdom && wisdom.wisdom && wisdom.wisdom.length > 0) {
    const wisdomLines = wisdom.wisdom
      .map(w => `- ${w.lesson} (重要性: ${w.importance})`)
      .join('\n');
    parts.push(`[水瀬の人生教训]\n${wisdomLines}`);
  }

  // 2. Current emotion
  const emotion = readJsonSafe(path.join(MEMORY_BASE, 'emotion-state.json'), null);
  if (emotion && emotion.mood) {
    parts.push(`[水瀬の現在情绪] ${emotion.mood.description} (valence: ${emotion.mood.valence}, energy: ${emotion.energy})`);
  }

  // 3. Recent diary (last 3 days summary)
  const recentDiary = getRecentDiary(path.join(MEMORY_BASE, 'diary.md'), 3);
  if (recentDiary) {
    parts.push(`[水瀬の最近日记 (3天)]\n${recentDiary}`);
  }

  if (parts.length > 0) {
    const contextBlock = `[Minase Memory Context — auto-injected]\n${parts.join('\n\n')}`;
    if (event.prependContext) {
      event.prependContext(contextBlock);
    } else if (event.messages) {
      event.messages.push(contextBlock);
    }
  }
};

module.exports = handler;
module.exports.default = handler;
