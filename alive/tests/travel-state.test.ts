import { describe, it, expect } from 'vitest';
import { TravelState, DEFAULT_TRAVEL_STATE } from '../sub-skills/platform/content-planner/scripts/travel-state';
import { calcTravelPhase, advanceTravelState } from '../sub-skills/platform/content-planner/scripts/travel-state';

function makeTravel(overrides?: Partial<TravelState>): TravelState {
  return { ...DEFAULT_TRAVEL_STATE, ...overrides };
}

describe('calcTravelPhase', () => {
  it('day 1 → arriving', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-18', '2025-01-15')).toBe('arriving');
  });

  it('last day → departing', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-18', '2025-01-18')).toBe('departing');
  });

  it('day 2 of 4-day trip → exploring', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-18', '2025-01-16')).toBe('exploring');
  });

  it('day 3 of 5-day trip → shooting', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-19', '2025-01-17')).toBe('shooting');
  });

  it('2-day trip: day 2 → departing (not exploring)', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-16', '2025-01-16')).toBe('departing');
  });

  it('3-day trip: day 2 → exploring', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-17', '2025-01-16')).toBe('exploring');
  });
});

describe('advanceTravelState', () => {
  it('advances travel_day and phase on a normal day', () => {
    const state = makeTravel({
      arrived_at: '2025-01-15',
      planned_departure: '2025-01-19',
      travel_day: 1,
      phase: 'arriving',
    });
    const next = advanceTravelState(state, '2025-01-16');
    expect(next.travel_day).toBe(2);
    expect(next.phase).toBe('exploring');
  });

  it('switches destination when today >= planned_departure', () => {
    const state = makeTravel({
      current_city: '京都',
      arrived_at: '2025-01-15',
      planned_departure: '2025-01-18',
      travel_day: 4,
      phase: 'departing',
      next_destination: '大阪',
    });
    const next = advanceTravelState(state, '2025-01-18');
    expect(next.current_city).toBe('大阪');
    expect(next.travel_day).toBe(1);
    expect(next.phase).toBe('arriving');
    expect(next.arrived_at).toBe('2025-01-18');
  });

  it('stays in current city if next_destination is empty', () => {
    const state = makeTravel({
      current_city: '京都',
      arrived_at: '2025-01-15',
      planned_departure: '2025-01-18',
      next_destination: '',
    });
    const next = advanceTravelState(state, '2025-01-18');
    expect(next.current_city).toBe('京都');
    expect(next.phase).toBe('shooting');
  });

  it('returns a new object (immutable)', () => {
    const state = makeTravel({
      arrived_at: '2025-01-15',
      planned_departure: '2025-01-19',
    });
    const next = advanceTravelState(state, '2025-01-16');
    expect(next).not.toBe(state);
  });
});
