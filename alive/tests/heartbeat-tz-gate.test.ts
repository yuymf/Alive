import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { main, regularTick } from '../scripts/lifecycle/heartbeat-tick';
import { PATHS, readText, resetBasePaths, setBasePaths, writeJSON } from '../scripts/utils/file-utils';
import { clearTimeOverride, getLocalDate, getLocalHour, setTimezone } from '../scripts/utils/time-utils';
import { clearPersonaCache } from '../scripts/persona/persona-loader';
import { clearRouteTable } from '../scripts/router/skill-router';
import type { CronSchedule, PersonaConfig } from '../scripts/utils/types';

/**
 * System TZ on this box is Asia/Shanghai. Persona uses Asia/Tokyo.
 * Instant Date.UTC(2026, 2, 11, 15, 30) =
 *   Tokyo  2026-03-12 00:30
 *   Shanghai 2026-03-11 23:30
 */

const persona: PersonaConfig = {
  meta: { name: 'TestChar', tagline: 'tz test', id: 'tz-test' },
  personality: { mbti: 'INFP', core_traits: ['quiet'] },
  voice: { language: 'zh', style: '平静', sample_lines: [] },
  schedule: { wake_hour: 9, sleep_hour: 23, timezone: 'Asia/Tokyo', active_peaks: [14, 21] },
  features: {
    skill_discovery: false,
    random_events: false,
    social_graph: false,
    flow_states: false,
    procrastination: false,
    personality_drift: false,
    content_browse: false,
    emotion: false,
    intent: false,
    vitality: false,
    confidence: false,
    work_impulse: false,
  },
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-tz-gate-'));
  setBasePaths(tmpDir, tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'persona'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'persona', 'persona.yaml'), YAML.stringify(persona));
  fs.writeFileSync(path.join(tmpDir, 'templates', 'heartbeat-prompt.md'), 'heartbeat decision');
  clearPersonaCache();
  clearRouteTable();
  clearTimeOverride();
  setTimezone(null);
});

afterEach(() => {
  vi.useRealTimers();
  clearTimeOverride();
  setTimezone(null);
  clearPersonaCache();
  clearRouteTable();
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('heartbeat persona timezone gate', () => {
  it('getLocal* differs from system when persona TZ ≠ system TZ', () => {
    const instant = new Date(Date.UTC(2026, 2, 11, 15, 30, 0));
    setTimezone('Asia/Tokyo');
    expect(getLocalDate(instant)).toBe('2026-03-12');
    expect(getLocalHour(instant)).toBe(0);

    setTimezone(null);
    // System Asia/Shanghai on the audit box
    const sysDate = instant.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const sysHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        hour: 'numeric',
        hour12: false,
      })
        .formatToParts(instant)
        .find((p) => p.type === 'hour')?.value,
    ) % 24;
    expect(sysDate).toBe('2026-03-11');
    expect(sysHour).toBe(23);
  });

  it('main first-wake gate uses persona-local date, not system date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 15, 30, 0)));

    // Morning already ran in Tokyo for 2026-03-12; system still 2026-03-11.
    const cron: CronSchedule = {
      date: '2026-03-12',
      heartbeats: [{ time: '00:00', type: 'regular' }],
    };
    writeJSON(PATHS.cronSchedule, cron);

    let morningWouldHaveRun = false;
    const llm = {
      callJSON: async <T>() => {
        // regularTick decision (not morning plan shape)
        return {
          inner_monologue: '刚过零点，还醒着',
          new_impulses: [],
          suppressed_intents: [],
          chosen_actions: [],
        } as T;
      },
      call: async () => '',
    };

    // Spy: if main used system date, cron.date !== todayStr → runMorningPlan,
    // which calls llm.callJSON with a morning-plan prompt shape and writes wake diary.
    const beforeCron = JSON.parse(fs.readFileSync(PATHS.cronSchedule, 'utf8'));

    await main(llm);

    const afterCron = JSON.parse(fs.readFileSync(PATHS.cronSchedule, 'utf8'));
    // Morning plan rewrites cron for "today"; must not have treated system Mar11 as new day.
    expect(afterCron.date).toBe('2026-03-12');
    expect(afterCron.date).toBe(beforeCron.date);

    // regular tick at Tokyo hour 0 should have run (active heartbeat)
    const diary = readText(PATHS.diary);
    expect(diary).toContain('2026-03-12');
    expect(diary).toContain('00:30');
    void morningWouldHaveRun;
  });

  it('regularTick diary stamp uses persona-local hour/date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 15, 30, 0)));

    const llm = {
      callJSON: async <T>() =>
        ({
          inner_monologue: '东京刚过零点的独白',
          new_impulses: [],
          suppressed_intents: [],
          chosen_actions: [],
        }) as T,
      call: async () => '',
    };

    await regularTick(llm);
    const diary = readText(PATHS.diary);
    expect(diary).toMatch(/## 2026-03-12 00:30/);
    expect(diary).toContain('东京刚过零点的独白');
  });
});
