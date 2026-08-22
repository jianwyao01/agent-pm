import type { Binding, Candidate, Journey } from "./types.js";

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

export interface ObservedJourneyInput {
  candidates: Candidate[];
  bindings: Binding[];
  proposedNames?: Iterable<string>;
  alwaysObservedIds?: Iterable<string>;
}

/**
 * 本 run 视为已观察到的旅程。任一成立即可，不得要求候选 control_id 等于人类分配的 ctl-*-obs：
 * - scan / play 候选的 control_id（或 discovery_key / id）对上 journey.control_id
 * - play 候选的 discovery_key / id 对上 journey.steps[].binding_id
 * - 该 run bindings.jsonl 有 human 绑定，对上 journey.control_id 或任一 steps[].binding_id
 */
export function collectObservedJourneyIds(
  journeys: Journey[],
  input: ObservedJourneyInput
): string[] {
  const always = new Set(input.alwaysObservedIds ?? []);
  const proposedNames = new Set(input.proposedNames ?? []);
  const observed: string[] = [];
  for (const journey of journeys) {
    if (always.has(journey.id) || journeyIsObserved(journey, input, proposedNames)) {
      observed.push(journey.id);
    }
  }
  return observed;
}

export function journeyIsObserved(
  journey: Journey,
  input: Pick<ObservedJourneyInput, "candidates" | "bindings">,
  proposedNames: ReadonlySet<string> = new Set()
): boolean {
  if (proposedNames.has(journey.name.replace(/（已审定）$/, ""))) {
    return true;
  }
  if (
    [...proposedNames].some((name) => journey.name === name || journey.name.startsWith(name))
  ) {
    return true;
  }
  const stepBindingIds = (journey.steps ?? []).map((step) => step.binding_id);
  if (journey.control_id && candidateMatchesControl(input.candidates, journey.control_id)) {
    return true;
  }
  if (stepBindingIds.some((bindingId) => candidateMatchesBinding(input.candidates, bindingId))) {
    return true;
  }
  return input.bindings.some(
    (row) =>
      row.approved_by === "human" &&
      ((journey.control_id !== undefined && row.control_id === journey.control_id) ||
        stepBindingIds.includes(row.binding_id))
  );
}

function candidateMatchesControl(candidates: Candidate[], controlId: string): boolean {
  return candidates.some((item) => {
    const derived = item.discovery_key.split(":").at(-1) ?? item.discovery_key;
    return derived === controlId || item.id === controlId || item.discovery_key.includes(controlId);
  });
}

function candidateMatchesBinding(candidates: Candidate[], bindingId: string): boolean {
  return candidates.some(
    (item) =>
      item.id === bindingId ||
      item.discovery_key === bindingId ||
      item.discovery_key.includes(bindingId)
  );
}
