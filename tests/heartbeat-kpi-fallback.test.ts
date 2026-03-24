import { afterEach, describe, expect, it } from 'vitest';
import * as heartbeatTick from '../skill/scripts/heartbeat-tick';

afterEach(() => {
  delete process.env.MINASE_ENABLE_KPI_FALLBACK;
  delete process.env.MINASE_REAL_E2E;
});

describe('heartbeat KPI fallback switch', () => {
  it('disables KPI fallback when explicitly turned off', () => {
    process.env.MINASE_ENABLE_KPI_FALLBACK = '0';
    expect(heartbeatTick.isKpiFallbackEnabled()).toBe(false);
  });

  it('disables KPI fallback by default in real-day E2E mode', () => {
    process.env.MINASE_REAL_E2E = '1';
    expect(heartbeatTick.isKpiFallbackEnabled()).toBe(false);
  });

  it('keeps KPI fallback enabled in normal runtime by default', () => {
    expect(heartbeatTick.isKpiFallbackEnabled()).toBe(true);
  });
});
