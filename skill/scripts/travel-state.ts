// skill/scripts/travel-state.ts
// Travel state machine helpers for the digital nomad persona.

import { TravelState, TravelPhase } from './types';

/** Parse YYYY-MM-DD string to integer days since epoch (UTC) */
function toDays(dateStr: string): number {
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 86_400_000);
}

/**
 * Determine the travel phase for a given day.
 * Priority order: arriving > departing > exploring > shooting
 */
export function calcTravelPhase(
  arrivedAt: string,
  plannedDeparture: string,
  today: string
): TravelPhase {
  const travelDay = toDays(today) - toDays(arrivedAt) + 1;
  const totalDays = toDays(plannedDeparture) - toDays(arrivedAt) + 1;

  if (travelDay === 1) return 'arriving';
  if (travelDay >= totalDays) return 'departing';
  if (travelDay <= 2) return 'exploring';
  return 'shooting';
}

/**
 * Advance travel state to today.
 * Returns a new TravelState (immutable).
 * Handles destination switching when today >= planned_departure.
 */
export function advanceTravelState(state: TravelState, today: string): TravelState {
  const todayDays = toDays(today);
  const departureDays = toDays(state.planned_departure);

  // Destination switch: we've reached or passed departure date
  if (state.planned_departure && todayDays >= departureDays) {
    if (state.next_destination) {
      // Switch to next destination, default 3-day stay
      const newDeparture = new Date((todayDays + 3) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return {
        ...state,
        current_city: state.next_destination,
        arrived_at: today,
        planned_departure: newDeparture,
        travel_day: 1,
        phase: 'arriving',
        next_destination: '',
        visited_spots: [],
      };
    } else {
      // No next destination — stay, switch to shooting
      return {
        ...state,
        travel_day: toDays(today) - toDays(state.arrived_at) + 1,
        phase: 'shooting',
      };
    }
  }

  // Normal day advancement
  const travelDay = todayDays - toDays(state.arrived_at) + 1;
  const phase = calcTravelPhase(state.arrived_at, state.planned_departure, today);
  return { ...state, travel_day: travelDay, phase };
}
