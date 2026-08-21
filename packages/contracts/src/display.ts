import {
  DISPLAY_COLUMNS,
  UNOBSERVED,
  type DisplayCell,
  type DisplayProjection,
  type Effect,
  type Journey,
  type Observation
} from "./types.js";

export function projectDisplay(journeys: Journey[], effects: Effect[]): DisplayProjection {
  const effectById = new Map(effects.map((effect) => [effect.id, effect]));
  return {
    columns: DISPLAY_COLUMNS.map((column) => column.label),
    rows: journeys.map((journey) => {
      const journeyEffects = journey.effect_ids
        .map((id) => effectById.get(id))
        .filter((effect): effect is Effect => Boolean(effect));
      const cells: DisplayCell[] = DISPLAY_COLUMNS.map((column) => {
        const match = journeyEffects.find((effect) => {
          if (effect.observation.kind !== column.observation_kind) {
            return false;
          }
          if ("subtype" in column && column.subtype) {
            return effect.observation.subtype === column.subtype;
          }
          return true;
        });
        const observed = Boolean(match?.observation.observed);
        return {
          column: column.label,
          observation_kind: column.observation_kind,
          value: observed
            ? match?.observation.display_value || match?.name || UNOBSERVED
            : UNOBSERVED,
          observed
        };
      });
      return { journey_id: journey.id, cells };
    })
  };
}

export function assertDisplayIncludesOtherSurface(display: DisplayProjection): void {
  if (!display.columns.includes("他面")) {
    throw new Error("六列投影必须包含「他面」");
  }
}

export function hasRequiredObservedCells(display: DisplayProjection): boolean {
  return display.rows.every((row) => {
    const current = row.cells.find((cell) => cell.column === "本面")?.observed;
    const other = row.cells.find((cell) => cell.column === "他面")?.observed;
    const list = row.cells.find((cell) => cell.column === "列表")?.observed;
    const backend = row.cells.find((cell) => cell.column === "后台")?.observed;
    return Boolean(current && (other || list) && backend);
  });
}

/**
 * 把通用 Observation 投影到六列（本面/他面/列表/未读/通知/后台）。
 * 缺列填「未观察到」。永不省略他面。未读/通知不必实际发生。
 */
export function displayObservations(
  observations: Observation[],
  journeyId = "jny-probe"
): DisplayProjection {
  const cells: DisplayCell[] = DISPLAY_COLUMNS.map((column) => {
    const match = observations.find((observation) => {
      if (observation.kind !== column.observation_kind) {
        return false;
      }
      if ("subtype" in column && column.subtype) {
        return observation.subtype === column.subtype;
      }
      return true;
    });
    const observed = Boolean(match?.observed);
    return {
      column: column.label,
      observation_kind: column.observation_kind,
      value: observed ? match?.display_value || UNOBSERVED : UNOBSERVED,
      observed
    };
  });
  const display: DisplayProjection = {
    columns: DISPLAY_COLUMNS.map((column) => column.label),
    rows: [{ journey_id: journeyId, cells }]
  };
  assertDisplayIncludesOtherSurface(display);
  return display;
}
