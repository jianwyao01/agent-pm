import type { Journey } from "./types.js";

/**
 * 缺支持时把已接受旅程标为 stale / not_observed，禁止静默删除。
 */
export function markMissingSupport(
  journeys: Journey[],
  observedJourneyIds: Iterable<string>
): Journey[] {
  const observed = new Set(observedJourneyIds);
  return journeys.map((journey) => {
    if (observed.has(journey.id)) {
      return journey;
    }
    return {
      ...journey,
      status: journey.status === "accepted" ? "stale" : "not_observed"
    };
  });
}
