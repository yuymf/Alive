// alive/dashboard/server.js
// Minimal HTTP server for Alive Dashboard.
// Zero external dependencies — uses only Node.js built-ins.

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Helpers (exported for testing) ---

function resolveHome(dir) {
  return dir.startsWith('~') ? path.join(process.env.HOME, dir.slice(1)) : dir;
}

function readJsonSafe(filePath, defaultValue) {
  for (const suffix of ['', '.bak']) {
    const target = filePath + suffix;
    if (fs.existsSync(target)) {
      try {
        return JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch {
        // Try next
      }
    }
  }
  return defaultValue;
}

const STALENESS_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Resolve LLM call log path.
 * New canonical location: ~/.openclaw/workspace/runtime/llm-call-log.jsonl (shared across personas).
 * Falls back to legacy per-persona path if the new file doesn't exist yet.
 */
function resolveLlmLogForDashboard(memoryDir) {
  const runtimePath = resolveHome('~/.openclaw/workspace/runtime/llm-call-log.jsonl');
  if (fs.existsSync(runtimePath)) return runtimePath;
  const legacyPath = path.join(memoryDir, 'llm-call-log.jsonl');
  if (fs.existsSync(legacyPath)) return legacyPath;
  return runtimePath;
}

function extractDateKey(text) {
  if (!text) return null;
  const direct = String(text).match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (direct) return direct[1];
  const d = new Date(text);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function normalizePlatformTag(raw) {
  const value = String(raw || '').toLowerCase();
  if (/xiaohongshu|xhs|小红书/.test(value)) return 'xiaohongshu';
  if (/twitter|x\.com|推特|tweet/.test(value)) return 'twitter';
  if (/instagram|\bins\b|ig/.test(value)) return 'instagram';
  if (/search|搜索/.test(value)) return 'search';
  return 'unknown';
}

function inferPlatformFromText(prompt, caller) {
  const text = `${caller || ''} ${prompt || ''}`;
  const platform = normalizePlatformTag(text);
  if (platform !== 'unknown') return platform;
  if (String(caller || '').toLowerCase().includes('search')) return 'search';
  return 'unknown';
}

function inferFeedKind(prompt, caller) {
  const text = `${caller || ''} ${prompt || ''}`.toLowerCase();
  if (/刷帖|feed|timeline|for you|推荐流|浏览/.test(text)) return 'browse';
  return 'search';
}

function toTimestampMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function toIso(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return String(value);
}

function extractLogText(log) {
  const parts = [];
  if (log && log.tick_summary) parts.push(log.tick_summary);
  if (log && Array.isArray(log.chosen_actions) && log.chosen_actions.length > 0) {
    parts.push(log.chosen_actions.join('，'));
  }
  if (log && log.inner_monologue) parts.push(log.inner_monologue);
  return parts.join(' ').trim();
}

function parseDiaryMd(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const sections = content.split(/^## /m).filter(Boolean);
    return sections.map(section => {
      const newlineIdx = section.indexOf('\n');
      const header = newlineIdx === -1 ? section.trim() : section.slice(0, newlineIdx).trim();
      const body = newlineIdx === -1 ? '' : section.slice(newlineIdx + 1).trim();
      return {
        header,
        body,
        date: extractDateKey(header),
      };
    });
  } catch {
    return [];
  }
}

function parseLlmLog(filePath, limit, offset) {
  limit = Math.min(Math.max(1, limit || 50), 200);
  offset = Math.max(0, offset || 0);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    // Most recent first
    entries.reverse();
    const total = entries.length;
    const paged = entries.slice(offset, offset + limit);
    return { total, entries: paged };
  } catch {
    return { total: 0, entries: [] };
  }
}

function safeKillChildProcess(child) {
  if (!child || typeof child.kill !== 'function') return false;
  if (child.exitCode !== null || child.killed) return false;
  try {
    child.kill();
    return true;
  } catch {
    return false;
  }
}

function attachSseChildCleanup(req, res, child) {
  const killIfRunning = () => {
    safeKillChildProcess(child);
  };

  // SSE 连接是否断开以 response 的 close 事件为准，避免 request close 误触发。
  res.on('close', killIfRunning);
  req.on('aborted', killIfRunning);
}

/**
 * Extract meaningful content from a raw LLM prompt, stripping system
 * instructions / role-play preambles so the dashboard only shows
 * the actual feed items or search query.
 *
 * We preserve the original text (including newlines) for pattern matching,
 * then collapse whitespace only in the returned snippet.
 */
function extractContentFromPrompt(rawPrompt) {
  const raw = String(rawPrompt || '').trim();
  if (!raw) return '';

  // Helper: collapse whitespace in extracted snippet
  const clean = (s) => s.replace(/\s+/g, ' ').trim();

  // Helper: strip raw URLs and web-scraping noise from search results
  const stripUrls = (s) => s
    .replace(/https?:\/\/\S+/g, '')                       // remove all URLs
    .replace(/URL:\s*/g, '')                               // remove "URL:" labels
    .replace(/摘要:\s*(?:[^\-]*?(?:精选|推荐|关注|朋友|我的|小游戏|搜索|充值|客户端|壁纸|通知|私信|投稿|登录|综合|视频|用户|直播|多列|单列|筛选)\s*)+/g, '摘要: ') // strip nav boilerplate
    .replace(/摘要:\s*(?=摘要:|$)/g, '')                   // remove empty 摘要
    .replace(/\s{2,}/g, ' ');                              // collapse whitespace

  // Helper: strip system instructions that may leak into extracted content
  const stripInstructions = (s) => s
    .replace(/##\s*任务[\s\S]*/i, '')                // 截断在 "## 任务" 之前
    .replace(/##\s*收藏的灵感图[\s\S]*/i, '')        // 截断在 "## 收藏的灵感图" 之前
    .replace(/##\s*灵感参考图片[\s\S]*/i, '')         // 截断在 "## 灵感参考图片" 之前
    .replace(/你是一个\s*ESTP[\s\S]*/i, '')          // 截断在角色设定指令之前
    .replace(/###\s*事实约束[\s\S]*/i, '')           // 截断在约束指令之前
    .replace(/严禁编造[\s\S]*/i, '')                 // 截断在禁止指令之前
    .replace(/禁止使用[\s\S]*/i, '');                // 截断在禁止指令之前

  // --- 小红书 inspiration-collector: 提取 "- 帖子标题" 列表 ---
  const feedSectionMatch = raw.match(/推荐流内容[\s\S]*?(- .+)/is);
  if (feedSectionMatch) {
    return clean(feedSectionMatch[1]).slice(0, 500);
  }

  // --- 小红书 content-planner: 提取"最近的灵感"部分 ---
  const inspoMatch = raw.match(/最近的灵感\s*\n?([\s\S]+)/i);
  if (inspoMatch) {
    return clean(stripInstructions(inspoMatch[1])).slice(0, 500);
  }

  // --- heartbeat-tick (模拟行动): 提取"行动"描述 ---
  const actionMatch = raw.match(/\*\*行动[：:]\*\*\s*([\s\S]+?)(?=\s*\*\*当前情绪|$)/i);
  if (actionMatch) {
    return clean(actionMatch[1]).slice(0, 300);
  }

  // --- heartbeat-outreach: 提取"你在做的事" ---
  const doingMatch = raw.match(/\*\*你在做的事[：:]\*\*\s*([\s\S]+?)(?=\s*\*\*|\s*##|$)/i);
  if (doingMatch) {
    return clean(doingMatch[1]).slice(0, 300);
  }

  // --- heartbeat-tick (心跳决策): 提取"最近发生了什么"中的行动描述 ---
  const recentEventsMatch = raw.match(/最近发生了什么\s*\n?([\s\S]+?)(?=\s*##\s|$)/i);
  if (recentEventsMatch) {
    const events = clean(recentEventsMatch[1]);
    if (events.length > 15) return events.slice(0, 300);
  }

  // --- night-reflect: 提取日记内容（今日回顾之后，截断在指令之前） ---
  const diaryMatch = raw.match(/今日回顾\s*\n?([\s\S]+)/i);
  if (diaryMatch) {
    return clean(stripInstructions(diaryMatch[1])).slice(0, 400);
  }

  // --- morning-plan: 提取回顾+日程（截断在系统指令之前） ---
  const morningMatch = raw.match(/昨日回顾\s*\n?([\s\S]+)/i);
  if (morningMatch) {
    return clean(stripInstructions(morningMatch[1])).slice(0, 400);
  }

  // --- travel-inspo: 提取搜索查询 ---
  const queryMatch = raw.match(/请列出([\s\S]+?)(?:以\s*JSON|$)/i);
  if (queryMatch) {
    return clean(queryMatch[1]).slice(0, 300);
  }

  // --- search / inspiration-collector (搜索版): 结构化提取搜索结果 ---
  const searchResultMatch = raw.match(/搜索.*?结果[\s\S]*?(【[\s\S]+)/i);
  if (searchResultMatch) {
    const rawResults = searchResultMatch[1];
    const resultLines = rawResults.split('\n')
      .map(line => line.trim())
      .filter(line => {
        if (/^【/.test(line)) return true;
        if (/^- /.test(line)) return true;
        return false;
      });
    const extracted = resultLines.join(' ').replace(/\s+/g, ' ').trim();
    if (extracted.length > 10) {
      return extracted.slice(0, 500);
    }
  }
  // Fallback for other search-like prompts
  const searchFallback = raw.match(/搜索.*?结果[\s\S]*?(- .+)/i);
  if (searchFallback) {
    return clean(stripUrls(stripInstructions(searchFallback[1]))).slice(0, 500);
  }

  // --- 通用 fallback: 跳过系统指令前缀 ---
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const strippedPrompt = collapsed
    .replace(/^(?:#+\s*\S+\s*)?你是[^。]+[。.]\s*/i, '')
    .replace(/^(?:#+\s*\S+\s*)/i, '')
    .trim();

  if (strippedPrompt.length > 20) {
    return stripInstructions(strippedPrompt).slice(0, 300);
  }

  return collapsed.slice(0, 180);
}

/**
 * Callers that are NOT search/feed content — excluded from searchFeed pipeline.
 */
const EXCLUDED_CALLERS = new Set([
  'heartbeat-tick',
  'heartbeat-outreach',
  'morning-plan',
  'night-reflect',
]);

function parseSearchFeed(filePath, limit = 30) {
  const result = parseLlmLog(filePath, 200, 0);
  const entries = result.entries || [];

  const filtered = entries.filter((entry) => {
    const caller = String(entry.caller || '').toLowerCase();
    const prompt = String(entry.prompt || '').toLowerCase();

    if (EXCLUDED_CALLERS.has(caller)) return false;

    return (
      caller.includes('search') ||
      caller.includes('inspiration') ||
      caller.includes('trend') ||
      /小红书|xhs|xiaohongshu|instagram|\bins\b|twitter|推特|x\.com|search|搜索|刷帖|feed|timeline|浏览/.test(prompt)
    );
  });

  return filtered.slice(0, limit).map((entry) => {
    const rawPrompt = String(entry.prompt || '');
    const caller = String(entry.caller || '');
    const extracted = extractContentFromPrompt(rawPrompt);
    return {
      timestamp: entry.timestamp || null,
      caller,
      query: extracted,
      model: entry.model || '',
      error: entry.error_message || null,
      platform: inferPlatformFromText(rawPrompt, caller),
      kind: inferFeedKind(rawPrompt, caller),
      date: extractDateKey(entry.timestamp) || extractDateKey(rawPrompt),
    };
  });
}

function parseInsCommentFeed(memoryDir, limit = 60) {
  const events = [];
  const outbound = readJsonSafe(path.join(memoryDir, 'outbound-history.json'), { commented: [] });
  const outboundItems = (outbound && Array.isArray(outbound.commented)) ? outbound.commented : [];

  outboundItems.forEach((entry) => {
    const detail = [
      entry.comment_text,
      entry.reply_text,
      entry.text,
      entry.message,
      entry.content,
    ].find((value) => typeof value === 'string' && value.trim());

    if (!detail) return;

    const timestamp = toIso(entry.commented_at) || toIso(entry.timestamp);
    const targetRaw = entry.user_id || entry.target || entry.username || null;
    const normalizedTarget = targetRaw
      ? (String(targetRaw).startsWith('@') ? String(targetRaw) : `@${String(targetRaw)}`)
      : null;

    events.push({
      source: 'outbound-history',
      platform: 'instagram',
      kind: 'comment',
      target: normalizedTarget,
      detail: String(detail).trim(),
      timestamp,
      date: extractDateKey(timestamp) || extractDateKey(String(detail)),
    });
  });

  const seen = new Set();
  const deduped = [];
  for (const item of events) {
    const key = [item.timestamp || '', item.target || '', item.detail || '', item.source || ''].join('@@');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  deduped.sort((a, b) => toTimestampMs(b.timestamp) - toTimestampMs(a.timestamp));
  return deduped.slice(0, limit);
}

function deduplicateHeartbeat(logs) {
  const deduped = [];
  let prevKey = '';
  for (const log of logs) {
    const summary = String(log.tick_summary || '').trim();
    const actions = Array.isArray(log.chosen_actions) ? log.chosen_actions.join('|') : '';
    const ts = extractDateKey(log.timestamp) || '';
    const key = [ts, summary, actions].join('@@');
    if (!key || key === prevKey) continue;
    deduped.push(log);
    prevKey = key;
  }
  return deduped;
}

function parseWorldMd(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const sections = content.split(/^## /m).filter(Boolean);
    const trends = [];
    for (const section of sections) {
      const headerEnd = section.indexOf('\n');
      const header = headerEnd === -1 ? section.trim() : section.slice(0, headerEnd).trim();
      const dateKey = extractDateKey(header);
      if (!dateKey) continue;
      const body = headerEnd === -1 ? '' : section.slice(headerEnd + 1).trim();

      const subSections = body.split(/^### /m).filter(Boolean);
      for (const sub of subSections) {
        const subHeader = sub.split('\n')[0].trim();
        const subreddit = subHeader.replace(/^r\//, '');
        const postMatches = [...sub.matchAll(/\d+\.\s+\*\*(.+?)\*\*\s*\(↑(\d+)\)/g)];
        for (const match of postMatches) {
          trends.push({
            source: 'reddit',
            subreddit,
            title: match[1],
            score: parseInt(match[2], 10),
            date: dateKey,
          });
        }
      }
    }
    trends.sort((a, b) => {
      const dateCmp = b.date.localeCompare(a.date);
      if (dateCmp !== 0) return dateCmp;
      return b.score - a.score;
    });
    return trends.slice(0, 20);
  } catch {
    return [];
  }
}

function buildStateResponse(memoryDir, filterDate) {
  const read = (filename, def) => readJsonSafe(path.join(memoryDir, filename), def);

  // Heartbeat log: keep all completed entries, strip voice_directive
  const rawLog = read('heartbeat-log.json', null);
  const allLogs = (rawLog && Array.isArray(rawLog.logs)) ? rawLog.logs : [];
  const completedLogs = allLogs.filter(l => l.status === 'completed');
  const heartbeatLog = deduplicateHeartbeat(completedLogs.map(({ voice_directive, ...rest }) => ({
    ...rest,
    date: extractDateKey(rest.timestamp),
  })));

  // Active session with staleness guard
  const rawSession = read('active-session.json', null);
  let activeSession = null;
  if (rawSession && rawSession.startedAt) {
    const age = Date.now() - new Date(rawSession.startedAt).getTime();
    if (age < STALENESS_MS) {
      activeSession = rawSession;
    }
  }

  const postHistory = (read('post-history.json', { posts: [] }).posts || []).map((post) => {
    const timestamp = post.posted_at || post.timestamp || post.created_at || post.updated_at || null;

    function localToApiUrl(localPath) {
      if (!localPath) return null;
      const idx = localPath.indexOf('photo-roll/');
      if (idx === -1) return null;
      const relPath = localPath.slice(idx + 'photo-roll/'.length);
      return '/api/images/' + relPath.split('/').map(encodeURIComponent).join('/');
    }

    let imageUrl = post.image_url || '';
    if (imageUrl.includes('mock.imgurl.org') || !imageUrl) {
      const localPath = post.cover_local_path
        || (post.image_local_paths && post.image_local_paths[0])
        || '';
      imageUrl = localToApiUrl(localPath) || imageUrl;
    }

    const imageUrls = (post.image_local_paths || [])
      .map(localToApiUrl)
      .filter(Boolean);

    return {
      ...post,
      image_url: imageUrl,
      image_urls: imageUrls.length > 0 ? imageUrls : (imageUrl ? [imageUrl] : []),
      platform: normalizePlatformTag(post.platform || post.channel || post.source || 'instagram'),
      kind: 'post',
      date: extractDateKey(timestamp),
    };
  });
  const diaryEntries = parseDiaryMd(path.join(memoryDir, 'diary.md'));
  const searchFeed = parseSearchFeed(resolveLlmLogForDashboard(memoryDir));
  const insCommentFeed = parseInsCommentFeed(memoryDir);
  const redditTrends = parseWorldMd(path.join(memoryDir, 'world.md'));

  // Travel data
  const travelState = read('travel-state.json', null);
  const travelSpotsAll = read(path.join('inspiration-refs', 'travel-spots.json'), {});
  let travelSpots = [];
  if (travelState && travelState.current_city) {
    const cityKey = Object.keys(travelSpotsAll).find(k =>
      k.toLowerCase().includes(travelState.current_city.toLowerCase())
    );
    if (cityKey && travelSpotsAll[cityKey] && Array.isArray(travelSpotsAll[cityKey].spots)) {
      travelSpots = travelSpotsAll[cityKey].spots;
    }
  }

  const result = {
    timestamp: new Date().toISOString(),
    emotion: read('emotion-state.json', null),
    intents: read('intent-pool.json', null),
    vitality: read('vitality-state.json', null),
    confidence: read('confidence-state.json', null),
    flow: read('flow-state.json', null),
    postImpulse: read('post-impulse.json', null),
    schedule: read('schedule-today.json', null),
    heartbeatLog,
    activeSession,
    postHistory,
    inspiration: read('inspiration.json', null),
    diaryEntries,
    searchFeed,
    insCommentFeed,
    redditTrends,
    travelState,
    travelSpots,
  };

  // Apply date filter if provided
  if (filterDate) {
    const match = (d) => d === filterDate;
    result.heartbeatLog = result.heartbeatLog.filter(l => match(l.date));
    result.postHistory = result.postHistory.filter(p => match(p.date));
    result.diaryEntries = result.diaryEntries.filter(e => match(e.date));
    result.searchFeed = result.searchFeed.filter(s => match(s.date));
    result.insCommentFeed = result.insCommentFeed.filter(c => match(c.date));
    result.redditTrends = result.redditTrends.filter(r => match(r.date));
    const today = new Date().toISOString().slice(0, 10);
    if (filterDate !== today) {
      result.schedule = { date: filterDate, rigid: [], flexible: [], historical_notice: '历史日期暂无日程快照，仅展示轨迹/日记/刷帖内容。' };
    }
  }

  return result;
}

// --- Multi-persona helpers ---

/**
 * Scan ALIVE_MEMORY_BASE for subdirectories (each is a persona slug).
 */
function listPersonas(memoryBase) {
  try {
    const entries = fs.readdirSync(memoryBase, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Read the active persona slug from ~/.openclaw/openclaw.json
 * under skills.entries.alive.env.ALIVE_PERSONA.
 */
function readActivePersona() {
  const configPath = resolveHome('~/.openclaw/openclaw.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (
      config?.skills?.entries?.alive?.env?.ALIVE_PERSONA ||
      null
    );
  } catch {
    return null;
  }
}

/**
 * Find the first image (.jpg/.png) in ~/.openclaw/skills/{persona}/assets/
 * recursively. Returns the full absolute path or null.
 */
function findPersonaAvatar(personaSlug) {
  const assetsDir = resolveHome(`~/.openclaw/skills/${personaSlug}/assets`);
  if (!fs.existsSync(assetsDir)) return null;

  const imageExts = new Set(['.jpg', '.jpeg', '.png']);

  function scan(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Files first, then subdirectories — prefer shallow matches
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (!entry.isDirectory() && imageExts.has(path.extname(entry.name).toLowerCase())) {
        return fullPath;
      }
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      const found = scan(path.join(dir, entry.name));
      if (found) return found;
    }
    return null;
  }

  return scan(assetsDir);
}

// --- HTTP Server ---

const DEFAULT_PORT = 3901;
const DEFAULT_MEMORY_BASE = '~/.openclaw/workspace/memory';

function createServer(options = {}) {
  const port = options.port || parseInt(process.env.ALIVE_DASHBOARD_PORT, 10) || DEFAULT_PORT;
  const memoryBase = resolveHome(
    options.memoryBase ||
    process.env.ALIVE_MEMORY_BASE ||
    // Backward-compat: if user set MINASE_MEMORY_DIR pointing to a persona dir, use its parent
    (process.env.MINASE_MEMORY_DIR ? path.dirname(process.env.MINASE_MEMORY_DIR) : null) ||
    DEFAULT_MEMORY_BASE
  );
  const publicPath = options.publicPath || path.join(__dirname, 'public');

  function getPersonaDir(slug) {
    return path.join(memoryBase, slug);
  }

  const server = http.createServer((req, res) => {

    // --- Serve static HTML pages ---
    if (req.method === 'GET' && req.url === '/') {
      const dashboardPath = path.join(publicPath, 'index.html');
      try {
        const html = fs.readFileSync(dashboardPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dashboard file not found' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/photos') {
      const photosPath = path.join(publicPath, 'photos.html');
      try {
        const html = fs.readFileSync(photosPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Photos page not found' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/debug') {
      const debugPath = path.join(publicPath, 'debug.html');
      try {
        const html = fs.readFileSync(debugPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Debug page not found' }));
      }
      return;
    }

    if (req.method === 'GET' && (req.url === '/test' || req.url.startsWith('/test?'))) {
      const testPath = path.join(publicPath, 'test.html');
      try {
        const html = fs.readFileSync(testPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Test page not found' }));
      }
      return;
    }

    // --- API routes ---
    const urlObj = new URL(req.url, 'http://0.0.0.0');

    if (req.method === 'GET' && urlObj.pathname === '/api/personas') {
      try {
        const personas = listPersonas(memoryBase);
        const active = readActivePersona() || (personas[0] || null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ personas, active }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/api/state') {
      const personaSlug = urlObj.searchParams.get('persona') || '';
      const filterDate = urlObj.searchParams.get('date') || null;
      const memoryDir = personaSlug ? getPersonaDir(personaSlug) : memoryBase;

      if (!fs.existsSync(memoryDir)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Memory directory not found. Has Alive been installed and run at least once?' }));
        return;
      }

      try {
        const state = buildStateResponse(memoryDir, filterDate);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/api/avatar') {
      const personaSlug = urlObj.searchParams.get('persona') || '';
      if (!personaSlug) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'persona parameter required' }));
        return;
      }

      const avatarPath = findPersonaAvatar(personaSlug);
      if (!avatarPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Avatar not found' }));
        return;
      }

      try {
        const data = fs.readFileSync(avatarPath);
        const ext = path.extname(avatarPath).toLowerCase();
        const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(data);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/api/photos') {
      const personaSlug = urlObj.searchParams.get('persona') || '';
      const filterDate = urlObj.searchParams.get('date') || null;
      const memoryDir = personaSlug ? getPersonaDir(personaSlug) : memoryBase;
      const photoDir = path.join(memoryDir, 'photo-roll');

      if (!fs.existsSync(photoDir)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ photos: [], total: 0 }));
        return;
      }

      try {
        const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
        const photos = [];

        function scanDir(dir, prefix) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            const relativePath = prefix ? prefix + '/' + entry.name : entry.name;
            if (entry.isDirectory()) {
              scanDir(fullPath, relativePath);
            } else if (imageExts.has(path.extname(entry.name).toLowerCase())) {
              const stat = fs.statSync(fullPath);
              const parentFolder = path.basename(path.dirname(fullPath));
              const dateMatch = parentFolder.match(/^\d{4}-\d{2}-\d{2}$/);
              photos.push({
                filename: entry.name,
                path: relativePath,
                url: '/api/images/' + encodeURIComponent(relativePath) + (personaSlug ? '?persona=' + encodeURIComponent(personaSlug) : ''),
                size: stat.size,
                date: dateMatch ? parentFolder : extractDateKey(entry.name) || null,
                modified: stat.mtime.toISOString(),
              });
            }
          }
        }

        scanDir(photoDir, '');
        const filtered = filterDate ? photos.filter(p => p.date === filterDate) : photos;
        filtered.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ photos: filtered, total: filtered.length }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && urlObj.pathname.startsWith('/api/images/')) {
      const personaSlug = urlObj.searchParams.get('persona') || '';
      const filename = decodeURIComponent(urlObj.pathname.slice('/api/images/'.length));
      // Prevent path traversal
      if (filename.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid filename' }));
        return;
      }
      const memoryDir = personaSlug ? getPersonaDir(personaSlug) : memoryBase;
      const imgPath = path.join(memoryDir, 'photo-roll', filename);
      if (!fs.existsSync(imgPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Image not found' }));
        return;
      }
      try {
        const ext = path.extname(filename).toLowerCase();
        const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const data = fs.readFileSync(imgPath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(data);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/api/llm-log') {
      const personaSlug = urlObj.searchParams.get('persona') || '';
      const limit = Math.min(parseInt(urlObj.searchParams.get('limit') || '50', 10) || 50, 200);
      const offset = Math.max(parseInt(urlObj.searchParams.get('offset') || '0', 10) || 0, 0);
      const memoryDir = personaSlug ? getPersonaDir(personaSlug) : memoryBase;
      const logPath = resolveLlmLogForDashboard(memoryDir);
      try {
        const result = parseLlmLog(logPath, limit, offset);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // --- Test Runner API routes ---

    if (req.method === 'POST' && urlObj.pathname.startsWith('/api/test/')) {
      const subPath = urlObj.pathname.slice('/api/test/'.length);
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const personaSlug = urlObj.searchParams.get('persona') || readActivePersona() || '';
        let command = '';
        let extraArgs = [];

        if (subPath === 'heartbeat') {
          command = 'heartbeat';
        } else if (subPath === 'morning') {
          command = 'morning';
        } else if (subPath === 'night') {
          command = 'night';
        } else if (subPath === 'list-skills') {
          command = 'list-skills';
        } else if (subPath === 'get-state') {
          command = 'get-state';
        } else if (subPath === 'get-diary') {
          command = 'get-diary';
        } else if (subPath === 'get-heartbeat-log') {
          command = 'get-heartbeat-log';
        } else if (subPath === 'reset-state') {
          command = 'reset-state';
        } else if (subPath === 'set-state') {
          command = 'set-state';
          try {
            const parsed = JSON.parse(body || '{}');
            extraArgs = ['--param', JSON.stringify(parsed)];
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
        } else if (subPath === 'full-day') {
          command = 'full-day';
          try {
            const parsed = JSON.parse(body || '{}');
            extraArgs = ['--param', JSON.stringify(parsed)];
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
        } else if (subPath.startsWith('skill/')) {
          const skillParts = subPath.slice('skill/'.length);
          command = 'skill:' + skillParts.replace(/\//g, ':');
        }
        // ── Ops commands ──────────────────────────────────────────
        else if (subPath === 'ops-health') {
          command = 'ops-health';
        } else if (subPath === 'ops-trends') {
          command = 'ops-trends';
        } else if (subPath === 'ops-competitors') {
          command = 'ops-competitors';
        } else if (subPath === 'ops-idea') {
          command = 'ops-idea';
        } else if (subPath === 'ops-queue') {
          command = 'ops-queue';
        } else if (subPath === 'ops-queue-approve') {
          command = 'ops-queue-approve';
          try {
            const parsed = JSON.parse(body || '{}');
            extraArgs = ['--param', JSON.stringify(parsed)];
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
        } else if (subPath === 'ops-queue-discard') {
          command = 'ops-queue-discard';
          try {
            const parsed = JSON.parse(body || '{}');
            extraArgs = ['--param', JSON.stringify(parsed)];
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
        } else if (subPath === 'ops-queue-publish') {
          command = 'ops-queue-publish';
          try {
            const parsed = JSON.parse(body || '{}');
            extraArgs = ['--param', JSON.stringify(parsed)];
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
        } else if (subPath === 'ops-brief') {
          command = 'ops-brief';
        } else if (subPath === 'ops-analyze') {
          command = 'ops-analyze';
          try {
            const parsed = JSON.parse(body || '{}');
            extraArgs = ['--param', JSON.stringify(parsed)];
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
        } else if (subPath === 'ops-advice') {
          command = 'ops-advice';
        } else if (subPath === 'ops-strategy') {
          command = 'ops-strategy';
        } else if (subPath === 'ops-strategy-compute') {
          command = 'ops-strategy-compute';
        } else if (subPath === 'ops-strategy-confirm') {
          command = 'ops-strategy-confirm';
        } else if (subPath === 'ops-discovery') {
          command = 'ops-discovery';
        } else if (subPath === 'ops-candidate-approve') {
          command = 'ops-candidate-approve';
          try {
            const parsed = JSON.parse(body || '{}');
            extraArgs = ['--param', JSON.stringify(parsed)];
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
        } else if (subPath === 'ops-candidate-dismiss') {
          command = 'ops-candidate-dismiss';
          try {
            const parsed = JSON.parse(body || '{}');
            extraArgs = ['--param', JSON.stringify(parsed)];
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
        } else if (subPath === 'ops-keywords') {
          command = 'ops-keywords';
        } else if (subPath === 'ops-patterns') {
          command = 'ops-patterns';
        } else if (subPath === 'ops-viral-search') {
          command = 'ops-viral-search';
        } else if (subPath === 'ops-radar') {
          command = 'ops-radar';
        } else if (subPath === 'ops-auto-breakdown') {
          command = 'ops-auto-breakdown';
        } else if (subPath === 'ops-taste') {
          command = 'ops-taste';
        } else if (subPath === 'ops-performance') {
          command = 'ops-performance';
        } else if (subPath === 'ops-analysis-log') {
          command = 'ops-analysis-log';
        } else if (subPath === 'ops-verify-persona') {
          command = 'ops-verify-persona';
        } else if (subPath === 'ops-status') {
          command = 'ops-status';
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown test command: ' + subPath }));
          return;
        }

        // Check if client wants SSE streaming (for full-day)
        const wantSSE = urlObj.searchParams.get('stream') === '1';

        const runnerScript = path.join(__dirname, 'test-runner.ts');
        const tsxArgs = [runnerScript, command];
        if (personaSlug) {
          tsxArgs.push('--persona', personaSlug);
        }
        tsxArgs.push(...extraArgs);

        // Timeout for non-SSE mode: heavy ops 10 min, standard 5 min.
        // SSE mode relies on client-disconnect cleanup instead of spawn timeout.
        const heavyCommands = new Set(['full-day', 'ops-brief', 'ops-idea', 'ops-advice', 'ops-strategy-compute', 'ops-analyze']);
        const timeoutMs = heavyCommands.has(command) ? 600000 : 300000;

        // Find tsx binary: try npx tsx, then global tsx
        const { spawn } = require('child_process');
        const npxPath = process.platform === 'win32' ? 'npx.cmd' : 'npx';

        // For SSE streaming mode (full-day / ops-brief)
        const sseCommands = new Set(['full-day', 'ops-brief']);
        if (wantSSE && sseCommands.has(command)) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          // SSE mode: no spawn timeout — client-disconnect cleanup handles termination
          const child = spawn(npxPath, ['tsx', ...tsxArgs], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdout = '';
          let stderr = '';

          child.stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            // Parse progress events from stderr
            const lines = text.split('\n');
            for (const line of lines) {
              if (line.startsWith('__PROGRESS__')) {
                try {
                  const event = JSON.parse(line.slice('__PROGRESS__'.length));
                  res.write('event: progress\ndata: ' + JSON.stringify(event) + '\n\n');
                } catch { /* skip */ }
              }
            }
          });

          child.stdout.on('data', (data) => { stdout += data.toString(); });

          child.on('close', (code) => {
            const lines = stdout.trim().split('\n');
            const lastLine = lines[lines.length - 1] || '';
            let result;
            try {
              result = JSON.parse(lastLine);
            } catch {
              result = {
                ok: code === 0,
                output: stdout.trim(),
                error: code !== 0 ? (stderr.replace(/__PROGRESS__[^\n]*/g, '').trim() || `Process exited with code ${code}`) : undefined,
              };
            }
            const logLines = lines.slice(0, -1).join('\n');
            if (logLines) result.log = logLines;

            res.write('event: done\ndata: ' + JSON.stringify(result) + '\n\n');
            res.end();
          });

          child.on('error', (err) => {
            res.write('event: error\ndata: ' + JSON.stringify({ error: err.message }) + '\n\n');
            res.end();
          });

          // Handle client disconnect (SSE)
          attachSseChildCleanup(req, res, child);

          return;
        }

        // Use spawn for standard (non-SSE) output
        const child = spawn(npxPath, ['tsx', ...tsxArgs], {
          cwd: path.join(__dirname, '..'),
          env: { ...process.env },
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });

        child.on('close', (code) => {
          // Try to parse the last line of stdout as JSON result
          const lines = stdout.trim().split('\n');
          const lastLine = lines[lines.length - 1] || '';
          let result;
          try {
            result = JSON.parse(lastLine);
          } catch {
            result = {
              ok: code === 0,
              output: stdout.trim(),
              error: code !== 0 ? (stderr.trim() || `Process exited with code ${code}`) : undefined,
            };
          }

          // Include console output (non-JSON lines) as log
          const logLines = lines.slice(0, -1).join('\n');
          if (logLines) {
            result.log = logLines;
          }
          if (stderr.trim() && !result.error) {
            result.stderr = stderr.trim();
          }

          res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        });

        child.on('error', (err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to start test runner: ' + err.message }));
        });
      });
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return { server, port, memoryBase };
}

// --- Main ---

if (require.main === module) {
  const { server, port, memoryBase } = createServer();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Kill the existing process or set ALIVE_DASHBOARD_PORT.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Alive Dashboard: http://0.0.0.0:${port}`);
    console.log(`Reading personas from: ${memoryBase}`);
  });
}

// Export for testing
module.exports = {
  readJsonSafe,
  resolveHome,
  buildStateResponse,
  createServer,
  parseDiaryMd,
  parseLlmLog,
  parseSearchFeed,
  parseWorldMd,
  extractDateKey,
  deduplicateHeartbeat,
  listPersonas,
  readActivePersona,
  findPersonaAvatar,
  safeKillChildProcess,
  attachSseChildCleanup,
};
