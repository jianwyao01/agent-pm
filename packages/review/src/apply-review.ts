import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  UNOBSERVED,
  loadReviewedModel,
  markMissingSupport,
  probePlanActions,
  readJson,
  readYaml,
  validateDocument,
  writeYaml,
  type Binding,
  type Candidate,
  type Capability,
  type Effect,
  type Journey,
  type JourneyStep,
  type ObservationKind,
  type ProbePlan,
  type Proposal,
  type ProposedEffect,
  type ProposedJourney,
  type ReviewDecision,
  type ReviewedModel,
  type Transport
} from "@behavior-map/contracts";
import { effectIdFor, nextJourneyId } from "./ids.js";
import { controlIdFrom, hydrateModel, loadRunBindings, loadRunCandidates } from "./hydrate.js";

export interface KeepJourneySpec {
  proposed_name: string;
  rename?: string;
  /** 仅在首次接受时使用；重命名不改 id。 */
  journey_id?: string;
}

export interface RejectSpec {
  candidate_id?: string;
  proposed_name?: string;
  discovery_key?: string;
  rejection_reason: string;
}

export interface RenameSpec {
  journey_id: string;
  name: string;
}

export interface AddedJourneySpec {
  name: string;
  control_id?: string;
  effect_ids?: string[];
}

export interface RetargetSpec {
  journey_id: string;
  control_id: string;
}

/**
 * 人类审定输入。可 keep / reject / rename，并可补录一条其认为有效的旅程。
 * retarget 必须显式给出；hydrateModel 不得发明重定位。
 */
export interface HumanReviewSpec {
  keep?: KeepJourneySpec[];
  reject?: RejectSpec[];
  rename?: RenameSpec[];
  addJourney?: AddedJourneySpec;
  retarget?: RetargetSpec[];
}

export interface ApplyHumanReviewOptions {
  analysisRoot: string;
  runId: string;
  spec?: HumanReviewSpec;
}

const CROSS_SURFACE_KINDS: Array<{
  kind: ObservationKind;
  subtype?: string;
  name: string;
}> = [
  { kind: "current_surface", name: "本面" },
  { kind: "other_surface", name: "他面" },
  { kind: "collection", subtype: "list", name: "列表" },
  { kind: "indicator", subtype: "unread", name: "未读" },
  { kind: "notification", name: "通知" },
  { kind: "backend_operation", name: "后台" }
];

/**
 * 把人类审定写入 analysis/model/。
 * 已有 keep / reject / rename 不被新 run 覆盖；journey_id 仅在接受时分配。
 */
export function applyHumanReview(options: ApplyHumanReviewOptions): ReviewedModel {
  const { analysisRoot, runId } = options;
  const spec = options.spec ?? {};
  const existing = loadReviewedModel(analysisRoot);
  const modelExisted = existsSync(join(analysisRoot, "model", "journeys.yaml"));
  const candidates = loadRunCandidates(analysisRoot, runId);
  const bindings = loadRunBindings(analysisRoot, runId);
  const probePlan = loadStudyProbePlan(analysisRoot);
  const proposals = loadRunProposals(analysisRoot, runId);
  const proposedJourneys = proposals.flatMap((item) => item.proposed_journeys);
  const proposedEffects = proposals.flatMap((item) => item.proposed_effects);

  const decisions = [...existing.decisions];
  const journeys = [...existing.journeys];
  let effects = [...existing.effects];
  const capabilities = [...existing.capabilities];

  effects = mergeEffects(effects, proposedEffects, candidates);
  effects = ensureCrossSurfaceEffects(effects);

  for (const keep of spec.keep ?? []) {
    applyKeep({
      keep,
      proposedJourneys,
      proposedEffects,
      candidates,
      journeys,
      effects,
      decisions,
      capabilities,
      probePlan
    });
  }

  for (const reject of spec.reject ?? []) {
    applyReject({ reject, candidates, proposedJourneys, decisions });
  }

  for (const rename of spec.rename ?? []) {
    applyRename(rename, journeys, decisions);
  }

  if (spec.addJourney) {
    applyAddJourney(spec.addJourney, journeys, decisions, capabilities, effects, probePlan);
  }

  for (const retarget of spec.retarget ?? []) {
    applyRetarget(retarget, journeys, bindings, probePlan);
  }

  const observedIds = observedJourneyIds(journeys, candidates, proposedJourneys);
  const reconciled = markMissingSupport(journeys, observedIds);
  for (const [index, journey] of journeys.entries()) {
    journeys[index] = { ...journey, status: reconciled[index]?.status ?? journey.status };
  }

  const model: ReviewedModel = {
    schema_version: SCHEMA_VERSION,
    capabilities,
    journeys,
    effects,
    decisions,
    surfaces: [],
    controls: []
  };

  if (modelExisted) {
    assertDecisionsPreserved(existing, model);
  }

  writeReviewedModel(analysisRoot, model);
  return hydrateModel(analysisRoot, runId, model);
}

export function writeReviewedModel(analysisRoot: string, model: ReviewedModel): void {
  writeYaml(join(analysisRoot, "model", "capabilities.yaml"), {
    schema_version: SCHEMA_VERSION,
    capabilities: model.capabilities
  });
  writeYaml(join(analysisRoot, "model", "journeys.yaml"), {
    schema_version: SCHEMA_VERSION,
    journeys: model.journeys
  });
  writeYaml(join(analysisRoot, "model", "effects.yaml"), {
    schema_version: SCHEMA_VERSION,
    effects: model.effects
  });
  writeYaml(join(analysisRoot, "model", "review-decisions.yaml"), {
    schema_version: SCHEMA_VERSION,
    decisions: model.decisions
  });
}

export function loadRunProposals(analysisRoot: string, runId: string): Proposal[] {
  const dir = join(analysisRoot, "runs", runId, "proposals");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson<Proposal>(join(dir, name)));
}

function applyKeep(input: {
  keep: KeepJourneySpec;
  proposedJourneys: ProposedJourney[];
  proposedEffects: ProposedEffect[];
  candidates: Candidate[];
  journeys: Journey[];
  effects: Effect[];
  decisions: ReviewDecision[];
  capabilities: Capability[];
  probePlan?: ProbePlan;
}): void {
  const proposed = input.proposedJourneys.find((item) => item.name === input.keep.proposed_name);
  if (!proposed) {
    throw new Error(`没有名为「${input.keep.proposed_name}」的提案旅程可接受`);
  }
  const primaryCandidate = proposed.candidate_ids[0];
  const already = input.decisions.find(
    (item) => item.candidate_id === primaryCandidate && item.review_status === "kept"
  );
  if (already?.journey_id) {
    const journey = input.journeys.find((item) => item.id === already.journey_id);
    if (journey && input.keep.rename) {
      journey.name = input.keep.rename;
      already.rename = input.keep.rename;
    }
    return;
  }

  const existingByName = input.journeys.find(
    (item) => item.name === (input.keep.rename ?? proposed.name) || item.name === proposed.name
  );
  if (existingByName) {
    if (input.keep.rename) {
      existingByName.name = input.keep.rename;
    }
    if (primaryCandidate && !input.decisions.some((item) => item.candidate_id === primaryCandidate)) {
      input.decisions.push({
        candidate_id: primaryCandidate,
        review_status: "kept",
        journey_id: existingByName.id,
        rename: input.keep.rename ?? existingByName.name
      });
    }
    return;
  }

  const journeyId =
    input.keep.journey_id && !input.journeys.some((item) => item.id === input.keep.journey_id)
      ? input.keep.journey_id
      : nextJourneyId(input.keep.rename ?? proposed.name, input.journeys.map((item) => item.id));
  const control = inferControlId(proposed, input.candidates);
  const effectIds = effectIdsForProposed(proposed, input.effects);
  const name = input.keep.rename ?? proposed.name;
  input.journeys.push({
    id: journeyId,
    name,
    status: "accepted",
    effect_ids: effectIds,
    control_id: control,
    ...stepsField(input.probePlan)
  });
  if (primaryCandidate) {
    input.decisions.push({
      candidate_id: primaryCandidate,
      review_status: "kept",
      journey_id: journeyId,
      rename: input.keep.rename
    });
  }
  ensureSendCapability(input.capabilities, control);
}

function applyReject(input: {
  reject: RejectSpec;
  candidates: Candidate[];
  proposedJourneys: ProposedJourney[];
  decisions: ReviewDecision[];
}): void {
  const matches = input.candidates.filter((candidate) => {
    if (input.reject.candidate_id && candidate.id === input.reject.candidate_id) {
      return true;
    }
    if (input.reject.discovery_key && candidate.discovery_key.includes(input.reject.discovery_key)) {
      return true;
    }
    if (input.reject.proposed_name) {
      const hay = `${candidate.label} ${candidate.discovery_key}`;
      return hay.includes(input.reject.proposed_name);
    }
    return false;
  });
  const fallback = input.reject.candidate_id
    ? [{ id: input.reject.candidate_id } as Candidate]
    : matches;
  for (const candidate of fallback) {
    if (input.decisions.some((item) => item.candidate_id === candidate.id && item.review_status === "rejected")) {
      continue;
    }
    input.decisions.push({
      candidate_id: candidate.id,
      review_status: "rejected",
      rejection_reason: input.reject.rejection_reason
    });
  }
}

function applyRename(rename: RenameSpec, journeys: Journey[], decisions: ReviewDecision[]): void {
  const journey = journeys.find((item) => item.id === rename.journey_id);
  if (!journey) {
    throw new Error(`无法重命名不存在的旅程 ${rename.journey_id}`);
  }
  journey.name = rename.name;
  const decision = decisions.find((item) => item.journey_id === rename.journey_id);
  if (decision) {
    decision.rename = rename.name;
  }
}

function applyAddJourney(
  added: AddedJourneySpec,
  journeys: Journey[],
  decisions: ReviewDecision[],
  capabilities: Capability[],
  effects: Effect[],
  probePlan?: ProbePlan
): void {
  const existingAdded = decisions.find((item) => item.candidate_id.startsWith("human-added:"));
  if (existingAdded?.journey_id) {
    return;
  }
  if (journeys.some((item) => item.name === added.name)) {
    return;
  }
  const journeyId = nextJourneyId(added.name, journeys.map((item) => item.id));
  const effectIds = added.effect_ids?.length ? added.effect_ids : effects.map((item) => item.id);
  journeys.push({
    id: journeyId,
    name: added.name,
    status: "accepted",
    effect_ids: effectIds,
    control_id: added.control_id,
    ...stepsField(probePlan)
  });
  decisions.push({
    candidate_id: `human-added:${journeyId}`,
    review_status: "kept",
    journey_id: journeyId
  });
  ensureSendCapability(capabilities, added.control_id);
}

function applyRetarget(
  spec: RetargetSpec,
  journeys: Journey[],
  bindings: Binding[],
  probePlan?: ProbePlan
): void {
  const journey = journeys.find((item) => item.id === spec.journey_id);
  if (!journey) {
    throw new Error(`重定位失败：不存在旅程 ${spec.journey_id}`);
  }
  const human = bindings.find(
    (row) => row.control_id === spec.control_id && row.approved_by === "human"
  );
  if (!human) {
    throw new Error(
      `重定位失败：control_id ${spec.control_id} 在本 run 的 bindings.jsonl 中没有 approved_by human 的绑定`
    );
  }
  journey.control_id = spec.control_id;
  const steps = stepsFromProbePlan(probePlan);
  if (steps) {
    journey.steps = steps;
  }
}

function stepsFromProbePlan(plan?: ProbePlan): JourneyStep[] | undefined {
  if (!plan) {
    return undefined;
  }
  return probePlanActions(plan);
}

function stepsField(plan?: ProbePlan): { steps: JourneyStep[] } | Record<string, never> {
  const steps = stepsFromProbePlan(plan);
  return steps ? { steps } : {};
}

function loadStudyProbePlan(analysisRoot: string): ProbePlan | undefined {
  const file = join(analysisRoot, "probe-plan.yaml");
  if (!existsSync(file)) {
    return undefined;
  }
  const data = readYaml<ProbePlan>(file);
  const report = validateDocument("probe-plan", data, file);
  if (!report.ok) {
    throw new Error(report.issues.map((issue) => issue.message).join("; "));
  }
  return data;
}

function mergeEffects(
  existing: Effect[],
  proposed: ProposedEffect[],
  candidates: Candidate[]
): Effect[] {
  const out = [...existing];
  const usedIds = new Set(out.map((item) => item.id));
  const kindCount = new Map<string, number>();
  for (const item of proposed) {
    if (out.some((effect) => sameObservation(effect, item))) {
      continue;
    }
    const key = `${item.observation_kind}:${item.subtype ?? ""}`;
    const index = kindCount.get(key) ?? 0;
    kindCount.set(key, index + 1);
    let id = effectIdFor(item.observation_kind, item.subtype, index);
    while (usedIds.has(id)) {
      id = `${id}-x`;
    }
    usedIds.add(id);
    const candidate = candidates.find((row) => row.id === item.candidate_id);
    out.push({
      id,
      name: item.name,
      observation: {
        kind: item.observation_kind,
        subtype: item.subtype,
        transport: item.transport as Transport | undefined,
        observed: item.observed,
        display_value: item.observed ? item.name : UNOBSERVED,
        evidence_refs: item.evidence_refs ?? candidate?.evidence_refs ?? [],
        surface_id: undefined
      }
    });
  }
  return out;
}

function ensureCrossSurfaceEffects(effects: Effect[]): Effect[] {
  const out = [...effects];
  for (const column of CROSS_SURFACE_KINDS) {
    const found = out.find((effect) => {
      if (effect.observation.kind !== column.kind) {
        return false;
      }
      if (column.subtype) {
        return effect.observation.subtype === column.subtype;
      }
      return true;
    });
    if (found) {
      continue;
    }
    out.push({
      id: effectIdFor(column.kind, column.subtype),
      name: column.name,
      observation: {
        kind: column.kind,
        subtype: column.subtype,
        transport: column.kind === "backend_operation" ? "unknown" : undefined,
        observed: false,
        display_value: UNOBSERVED,
        evidence_refs: [],
        surface_id: undefined
      }
    });
  }
  return out;
}

function sameObservation(effect: Effect, proposed: ProposedEffect): boolean {
  if (effect.observation.kind !== proposed.observation_kind) {
    return false;
  }
  if ((effect.observation.subtype ?? "") !== (proposed.subtype ?? "")) {
    return false;
  }
  return effect.name === proposed.name || effect.observation.display_value === proposed.name;
}

function effectIdsForProposed(proposed: ProposedJourney, effects: Effect[]): string[] {
  if (effects.length === 0) {
    return [];
  }
  return effects.map((item) => item.id);
}

function inferControlId(proposed: ProposedJourney, candidates: Candidate[]): string | undefined {
  for (const id of proposed.candidate_ids) {
    const candidate = candidates.find((item) => item.id === id);
    if (candidate?.kind === "control") {
      return controlIdFrom(candidate);
    }
  }
  const send = candidates.find(
    (item) => item.kind === "control" && /send|发送|submit/.test(`${item.discovery_key} ${item.label}`)
  );
  return send ? controlIdFrom(send) : undefined;
}

function ensureSendCapability(capabilities: Capability[], controlId?: string): void {
  if (capabilities.some((item) => item.id === "cap-send")) {
    if (controlId && !capabilities[0]?.control_ids.includes(controlId)) {
      const cap = capabilities.find((item) => item.id === "cap-send");
      if (cap && !cap.control_ids.includes(controlId)) {
        cap.control_ids.push(controlId);
      }
    }
    return;
  }
  capabilities.push({
    id: "cap-send",
    name: "发送",
    control_ids: controlId ? [controlId] : []
  });
}

function observedJourneyIds(
  journeys: Journey[],
  candidates: Candidate[],
  proposed: ProposedJourney[]
): string[] {
  const candidateIds = new Set(candidates.map((item) => item.id));
  const proposedNames = new Set(proposed.map((item) => item.name));
  const observed: string[] = [];
  for (const journey of journeys) {
    if (journey.id.startsWith("jny-") && proposedNames.has(journey.name.replace(/（已审定）$/, ""))) {
      observed.push(journey.id);
      continue;
    }
    if (proposed.some((item) => item.name === journey.name || journey.name.startsWith(item.name))) {
      observed.push(journey.id);
      continue;
    }
    if (journey.control_id) {
      const controlSeen = candidates.some(
        (item) =>
          item.kind === "control" &&
          (controlIdFrom(item) === journey.control_id || item.discovery_key.includes(journey.control_id!))
      );
      if (controlSeen && candidateIds.size > 0 && !journey.id.includes("human") && !/人工|补录/.test(journey.name)) {
        observed.push(journey.id);
      }
    }
  }
  return observed;
}

function assertDecisionsPreserved(before: ReviewedModel, after: ReviewedModel): void {
  for (const decision of before.decisions) {
    const match = after.decisions.find((item) => item.candidate_id === decision.candidate_id);
    if (!match) {
      throw new Error(`审定不得删除已有决策 ${decision.candidate_id}`);
    }
    if (match.review_status !== decision.review_status) {
      throw new Error(`审定不得改写已有 ${decision.review_status} 决策`);
    }
    if (decision.journey_id && match.journey_id !== decision.journey_id) {
      throw new Error("重命名不得改变 journey_id");
    }
  }
}
