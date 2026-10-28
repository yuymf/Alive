import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initMemory, repoRootFromHere } from '../scripts/host/install';
import { deliverText } from '../scripts/host/outbox';
import { loadChatContext, saveChatTurn } from '../scripts/host/chat';
import { writePresence } from '../scripts/host/presence';
import { clearPersonaCache } from '../scripts/persona/persona-loader';
import { loadAliveEnv, resetBasePaths, setPersonaName } from '../scripts/utils/file-utils';

describe('chat load/save loop', () => {
  const prevHome = process.env.ALIVE_HOME;
  const prevPersona = process.env.ALIVE_PERSONA;
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.ALIVE_HOME;
    else process.env.ALIVE_HOME = prevHome;
    if (prevPersona === undefined) delete process.env.ALIVE_PERSONA;
    else process.env.ALIVE_PERSONA = prevPersona;
    resetBasePaths();
    clearPersonaCache();
  });

  function boot() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-chat-'));
    process.env.ALIVE_HOME = tmp;
    delete process.env.ALIVE_PERSONA;
    resetBasePaths();
    setPersonaName('default');
    clearPersonaCache();
    initMemory(tmp, 'minase', repoRootFromHere());
  }

  it('load after init speaks as 水瀬 with seeded emotion', () => {
    boot();
    const ctx = loadChatContext();
    expect(ctx.personaName).toBe('水瀬');
    expect(ctx.mbti).toBe('ESTP');
    expect(ctx.markdown).toContain('水瀬');
    expect(ctx.relation).toBeNull();
    expect(ctx.diary).toBe('(empty)');
  });

  it('save writes diary, relation, emotion; next load sees them', () => {
    boot();
    const valenceBefore = loadChatContext().emotion.mood.valence;
    const saved = saveChatTurn({
      user: '今天去咖啡馆了吗',
      reply: '去了啦！光线超好我拍了一堆',
    });
    expect(saved.intimacy).toBe(1);
    const diary = fs.readFileSync(path.join(tmp, 'personas', 'minase', 'diary.md'), 'utf8');
    expect(diary).toContain('今天去咖啡馆了吗');
    expect(diary).toContain('光线超好');
    const relation = JSON.parse(
      fs.readFileSync(path.join(tmp, 'personas', 'minase', 'relations', 'user.json'), 'utf8'),
    );
    expect(relation.intimacy).toBe(1);
    expect(relation.recent_events[0].summary).toContain('咖啡馆');
    const again = loadChatContext();
    expect(again.diary).toContain('今天去咖啡馆了吗');
    expect(again.relation?.intimacy).toBe(1);
    expect(again.emotion.mood.valence).toBeGreaterThan(valenceBefore);
    expect(again.emotion.recent_cause).toContain('对话');
  });

  it('load shows what they are doing today', () => {
    boot();
    loadAliveEnv();
    setPersonaName('minase');
    writePresence({
      activity: '在改本子',
      inner: '想喝口茶',
      schedule: [{ time: '15:00', activity: '喝茶' }],
    });
    const ctx = loadChatContext();
    expect(ctx.presence.activity).toBe('在改本子');
    expect(ctx.markdown).toContain('正在做: 在改本子');
    expect(ctx.markdown).toContain('15:00 喝茶');
    expect(ctx.markdown).toContain('Right now');
  });

  it('load peeks outbox without deleting', () => {
    boot();
    deliverText('记得把照片发我');
    const first = loadChatContext();
    expect(first.outbox).toHaveLength(1);
    expect(first.outbox[0].text).toContain('照片');
    const second = loadChatContext();
    expect(second.outbox).toHaveLength(1);
    expect(second.markdown).toContain('照片');
  });

  it('save acks outbox and clears pending items', () => {
    boot();
    deliverText('记得把照片发我');
    expect(loadChatContext().outbox).toHaveLength(1);
    saveChatTurn({
      user: '收到了吗',
      reply: '收到啦，照片记得发我',
    });
    const after = loadChatContext();
    expect(after.outbox).toHaveLength(0);
    expect(after.markdown).toContain('(empty)');
  });

  it('chat diary stamp uses persona timezone', () => {
    boot();
    // System Asia/Shanghai; Minase Asia/Tokyo. Instant = JST Mar12 00:30 / CST Mar11 23:30.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 15, 30, 0)));
    try {
      saveChatTurn({ user: '还醒着吗', reply: '刚过零点啦' });
      const diary = fs.readFileSync(path.join(tmp, 'personas', 'minase', 'diary.md'), 'utf8');
      expect(diary).toContain('## 2026-03-12 00:30');
    } finally {
      vi.useRealTimers();
    }
  });
});
