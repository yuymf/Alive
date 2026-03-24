// content-planner/scripts/travel-state.ts
// Travel state machine helpers for the digital nomad persona.
// Migrated from skill/scripts/travel-state.ts
//
// Changes from skill version:
// - Import TravelPhase from local types (defined in planner.ts)
// - TravelState imported from local types

// === Platform-local types ===
export type TravelPhase = 'arriving' | 'exploring' | 'shooting' | 'departing';

export interface TravelSpot {
  name: string;
  description: string;
  best_time: string;       // e.g. "傍晚 golden hour"
  style_tags: string[];    // e.g. ["travel_portrait", "scenic"]
  visited: boolean;
}

export interface TravelState {
  current_city: string;
  country: string;
  arrived_at: string;          // YYYY-MM-DD
  travel_day: number;          // cached; source of truth is arrived_at + planned_departure
  planned_departure: string;   // YYYY-MM-DD
  phase: TravelPhase;
  visited_spots: string[];
  next_destination: string;
  travel_mode: 'solo' | 'group';
}

export const DEFAULT_TRAVEL_STATE: TravelState = {
  current_city: '东京',
  country: '日本',
  arrived_at: '2025-01-01',
  travel_day: 1,
  planned_departure: '2025-01-04',
  phase: 'arriving',
  visited_spots: [],
  next_destination: '',
  travel_mode: 'solo',
};

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
