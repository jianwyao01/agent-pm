import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  UNOBSERVED,
  loadReviewedModel,
  collectObservedJourneyIds,
  markMissingSupport,
  probePlanActions,
  readJson,
  readYaml,
  validateDocument,
  writeYaml,
  readJsonl,
  type Binding,
  type Candidate,
  type Capability,
  type Effect,
  type EvidenceRecord,
  type Journey,
  type JourneyStep,
  type ObservationKind,
  type ProbePlan,
  type Proposal,
  type ProposedEffect,
  type ProposedJourney,
  type ReviewDecision,
  type ReviewedModel,
  type RunContext,
  type Transport,
  isLoneUserParty,
  promoteMissingControlCandidates
} from "@behavior-map/contracts";
import { effectIdFor, nameToJourneySlug, nextJourneyId } from "./ids.js";
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
  /** 展示名。锁定形状可以只给 journey_id + control_id，缺省时用 journey_id。 */
  name?: string;
  /** 首次接受时可指定稳定 id；已存在则失败，应改用 retarget。 */
  journey_id?: string;
  control_id?: string;
  effect_ids?: string[];
}

export interface RetargetSpec {
  journey_id: string;
  control_id: string;
}

export interface ConfirmEffectSpec {
  journey_id: string;
  effect_id: string;
  evidence_ref: string;
  /** 人类点名的可见项。有非空值时直接写入 observation.display_value。 */
  display_value?: string;
}

export interface AnnotateJourneySpec {
  journey_id: string;
  affected_parties?: string;
  combinations?: string;
  keep_reason?: string;
}

/**
 * 人类审定输入。可 keep / reject / rename，并可补录一条其认为有效的旅程。
 * retarget 必须显式给出；hydrateModel 不得发明重定位。
 * confirmEffects 只确认已有六列槽位与本 run 已有 evidence，不得猜测。
 * annotate 只写 MAP-2/7/8 字段，不改 status / steps / entry_url / 六列 observed。
 * keep_reason 在 annotate 上，不在 KeepJourneySpec。
 */
export interface HumanReviewSpec {
  keep?: KeepJourneySpec[];
  reject?: RejectSpec[];
  rename?: RenameSpec[];
  /** 锁定形状为数组；兼容 M0–M7 的单个对象。 */
  addJourney?: AddedJourneySpec | AddedJourneySpec[];
  retarget?: RetargetSpec[];
  confirmEffects?: ConfirmEffectSpec[];
  annotate?: AnnotateJourneySpec[];
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
  promoteMissingControlCandidates(join(analysisRoot, "runs", runId));
  const candidates = loadRunCandidates(analysisRoot, runId);
  const bindings = loadRunBindings(analysisRoot, runId);
  const probePlan = loadStudyProbePlan(analysisRoot);
  const runContext = loadStudyRunContext(analysisRoot);
  const proposals = loadRunProposals(analysisRoot, runId);
  const proposedJourneys = proposals.flatMap((item) => item.proposed_journeys);
  const proposedEffects = proposals.flatMap((item) => item.proposed_effects);

  const decisions = [...existing.decisions];
  const journeys = [...existing.journeys];
  let effects = [...existing.effects];
  const capabilities = [...existing.capabilities];
  const justTouched = new Set<string>();

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

  for (const added of normalizeAddJourney(spec.addJourney)) {
    const addedId = applyAddJourney(
      added,
      journeys,
      decisions,
      capabilities,
      effects,
      probePlan,
      bindings,
      runContext
    );
    if (addedId) {
      justTouched.add(addedId);
    }
  }

  for (const retarget of spec.retarget ?? []) {
    applyRetarget(retarget, journeys, bindings, probePlan, runContext, capabilities);
    justTouched.add(retarget.journey_id);
  }

  const runEvidence = loadRunEvidence(analysisRoot, runId);
  for (const confirmed of spec.confirmEffects ?? []) {
    applyConfirmEffect(confirmed, journeys, effects, runEvidence);
  }

  const observedIds = collectObservedJourneyIds(journeys, {
    candidates,
    bindings,
    proposedNames: proposedJourneys.map((item) => item.name),
    alwaysObservedIds: justTouched
  });
  const reconciled = markMissingSupport(journeys, observedIds);
  for (const [index, journey] of journeys.entries()) {
    journeys[index] = { ...journey, status: reconciled[index]?.status ?? journey.status };
  }

  for (const note of spec.annotate ?? []) {
    applyAnnotate(note, journeys);
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
  const kept: Journey = {
    id: journeyId,
    name,
    status: "accepted",
    effect_ids: effectIds,
    control_id: control,
    ...stepsField(input.probePlan)
  };
  input.journeys.push(kept);
  if (primaryCandidate) {
    input.decisions.push({
      candidate_id: primaryCandidate,
      review_status: "kept",
      journey_id: journeyId,
      rename: input.keep.rename
    });
  }
  ensureJourneyCapability(input.capabilities, kept);
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

function normalizeAddJourney(
  spec: AddedJourneySpec | AddedJourneySpec[] | undefined
): AddedJourneySpec[] {
  if (!spec) {
    return [];
  }
  return Array.isArray(spec) ? spec : [spec];
}

function applyAddJourney(
  added: AddedJourneySpec,
  journeys: Journey[],
  decisions: ReviewDecision[],
  capabilities: Capability[],
  effects: Effect[],
  probePlan: ProbePlan | undefined,
  bindings: Binding[],
  runContext: RunContext | undefined
): string | undefined {
  if (added.journey_id) {
    if (journeys.some((item) => item.id === added.journey_id)) {
      throw new Error(`旅程 ${added.journey_id} 已存在，请使用 retarget，不要再创建一条`);
    }
    if (!added.control_id) {
      throw new Error(`补录旅程 ${added.journey_id} 需要 control_id`);
    }
    assertHumanBinding(bindings, added.control_id, "补录");
    const name = added.name?.trim() || added.journey_id;
    const effectIds = added.effect_ids?.length ? added.effect_ids : effects.map((item) => item.id);
    const created: Journey = {
      id: added.journey_id,
      name,
      status: "accepted",
      effect_ids: effectIds,
      control_id: added.control_id,
      ...stepsField(probePlan),
      ...entryUrlField(runContext)
    };
    journeys.push(created);
    decisions.push({
      candidate_id: `human-added:${added.journey_id}`,
      review_status: "kept",
      journey_id: added.journey_id
    });
    ensureJourneyCapability(capabilities, created);
    return added.journey_id;
  }

  const existingAdded = decisions.find((item) => item.candidate_id.startsWith("human-added:"));
  if (existingAdded?.journey_id) {
    return existingAdded.journey_id;
  }
  const name = added.name?.trim();
  if (!name) {
    throw new Error("补录旅程需要 name 或 journey_id");
  }
  if (journeys.some((item) => item.name === name)) {
    return journeys.find((item) => item.name === name)?.id;
  }
  const journeyId = nextJourneyId(name, journeys.map((item) => item.id));
  const effectIds = added.effect_ids?.length ? added.effect_ids : effects.map((item) => item.id);
  const created: Journey = {
    id: journeyId,
    name,
    status: "accepted",
    effect_ids: effectIds,
    control_id: added.control_id,
    ...stepsField(probePlan),
    ...entryUrlField(runContext)
  };
  journeys.push(created);
  decisions.push({
    candidate_id: `human-added:${journeyId}`,
    review_status: "kept",
    journey_id: journeyId
  });
  ensureJourneyCapability(capabilities, created);
  return journeyId;
}

function applyRetarget(
  spec: RetargetSpec,
  journeys: Journey[],
  bindings: Binding[],
  probePlan: ProbePlan | undefined,
  runContext: RunContext | undefined,
  capabilities: Capability[]
): void {
  const journey = journeys.find((item) => item.id === spec.journey_id);
  if (!journey) {
    throw new Error(`重定位失败：不存在旅程 ${spec.journey_id}`);
  }
  assertHumanBinding(bindings, spec.control_id, "重定位");
  journey.control_id = spec.control_id;
  journey.status = "accepted";
  const steps = stepsFromProbePlan(probePlan);
  if (steps) {
    journey.steps = steps;
  }
  const entryUrl = entryUrlField(runContext);
  if (entryUrl.entry_url) {
    journey.entry_url = entryUrl.entry_url;
  }
  rewriteLeftoverSendCapabilities(capabilities, journey);
  ensureJourneyCapability(capabilities, journey);
}

function applyAnnotate(spec: AnnotateJourneySpec, journeys: Journey[]): void {
  const journey = journeys.find((item) => item.id === spec.journey_id);
  if (!journey) {
    throw new Error(`标注失败：不存在旅程 ${spec.journey_id}`);
  }
  if (spec.affected_parties !== undefined) {
    if (isLoneUserParty(spec.affected_parties)) {
      throw new Error("标注失败：affected_parties 不得为单独的「用户」");
    }
    journey.affected_parties = spec.affected_parties;
  }
  if (spec.combinations !== undefined) {
    journey.combinations = spec.combinations;
  }
  if (spec.keep_reason !== undefined) {
    journey.keep_reason = spec.keep_reason;
  }
}

function applyConfirmEffect(
  spec: ConfirmEffectSpec,
  journeys: Journey[],
  effects: Effect[],
  evidence: EvidenceRecord[]
): void {
  const journey = journeys.find((item) => item.id === spec.journey_id);
  if (!journey) {
    throw new Error(`确认效果失败：不存在旅程 ${spec.journey_id}`);
  }
  const effect = effects.find((item) => item.id === spec.effect_id);
  if (!effect) {
    throw new Error(`确认效果失败：不存在效果 ${spec.effect_id}`);
  }
  const record = evidence.find((item) => item.id === spec.evidence_ref);
  if (!record) {
    throw new Error(`确认效果失败：本 run 没有 evidence_ref ${spec.evidence_ref}`);
  }
  const named = spec.display_value?.trim();
  const display = named ? named : displayValueFromEvidence(record);
  effect.observation.observed = true;
  effect.observation.display_value = display;
  if (!effect.observation.evidence_refs.includes(spec.evidence_ref)) {
    effect.observation.evidence_refs.push(spec.evidence_ref);
  }
  if (!journey.effect_ids.includes(spec.effect_id)) {
    journey.effect_ids.push(spec.effect_id);
  }
}

function displayValueFromEvidence(record: EvidenceRecord): string {
  const payload = record.payload ?? {};
  for (const key of ["name", "label", "item", "title"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  if (Array.isArray(payload.delta)) {
    const first = payload.delta.find((item) => typeof item === "string" && item.trim());
    if (typeof first === "string") {
      return first.trim();
    }
  }
  if (Array.isArray(payload.list_after)) {
    const named = payload.list_after.filter((item) => typeof item === "string" && item.trim());
    const last = named.at(-1);
    if (typeof last === "string") {
      return last.trim();
    }
  }
  throw new Error(`确认效果失败：evidence ${record.id} 没有可展示的名称`);
}

function loadRunEvidence(analysisRoot: string, runId: string): EvidenceRecord[] {
  const runRoot = join(analysisRoot, "runs", runId);
  const out: EvidenceRecord[] = [];
  for (const name of ["static.jsonl", "runtime.jsonl"] as const) {
    const file = join(runRoot, "evidence", name);
    if (existsSync(file)) {
      out.push(...readJsonl<EvidenceRecord>(file));
    }
  }
  return out;
}

function assertHumanBinding(bindings: Binding[], controlId: string, action: string): void {
  const human = bindings.find((row) => row.control_id === controlId && row.approved_by === "human");
  if (!human) {
    throw new Error(
      `${action}失败：control_id ${controlId} 在本 run 的 bindings.jsonl 中没有 approved_by human 的绑定`
    );
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

function entryUrlField(context?: RunContext): { entry_url: string } | Record<string, never> {
  return context?.entry_url ? { entry_url: context.entry_url } : {};
}

function loadStudyRunContext(analysisRoot: string): RunContext | undefined {
  const file = join(analysisRoot, "run-context.yaml");
  if (!existsSync(file)) {
    return undefined;
  }
  const data = readYaml<RunContext>(file);
  const report = validateDocument("run-context", data, file);
  if (!report.ok) {
    throw new Error(report.issues.map((issue) => issue.message).join("; "));
  }
  return data;
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

function ensureJourneyCapability(capabilities: Capability[], journey: Journey): void {
  const identity = capabilityFromJourney(journey);
  let cap = capabilities.find((item) => item.id === identity.id);
  if (!cap) {
    cap = { id: identity.id, name: identity.name, control_ids: [] };
    capabilities.push(cap);
  }
  cap.name = identity.name;
  if (journey.control_id && !cap.control_ids.includes(journey.control_id)) {
    cap.control_ids.push(journey.control_id);
  }
}

/**
 * 挂在本次 control_id 上的能力：name 跟随旅程；
 * 非发送旅程上焊死的 cap-send 残留同时改 id。不删除无关能力。
 */
function rewriteLeftoverSendCapabilities(capabilities: Capability[], journey: Journey): void {
  const controlId = journey.control_id;
  if (!controlId) {
    return;
  }
  const identity = capabilityFromJourney(journey);
  const attached = capabilities.filter((item) => item.control_ids.includes(controlId));
  for (const cap of attached) {
    if (cap.id === "cap-send" && identity.id !== "cap-send") {
      remapLeftoverSendCapability(capabilities, cap, controlId, identity);
      continue;
    }
    cap.name = identity.name;
  }
}

function remapLeftoverSendCapability(
  capabilities: Capability[],
  leftover: Capability,
  controlId: string,
  identity: { id: string; name: string }
): void {
  const onlyThisControl = leftover.control_ids.length === 1 && leftover.control_ids[0] === controlId;
  const collision = capabilities.find((item) => item.id === identity.id && item !== leftover);
  if (onlyThisControl && !collision) {
    leftover.id = identity.id;
    leftover.name = identity.name;
    return;
  }
  leftover.control_ids = leftover.control_ids.filter((id) => id !== controlId);
  if (leftover.control_ids.length === 0) {
    const index = capabilities.indexOf(leftover);
    if (index >= 0) {
      capabilities.splice(index, 1);
    }
  }
  if (collision) {
    collision.name = identity.name;
    if (!collision.control_ids.includes(controlId)) {
      collision.control_ids.push(controlId);
    }
  }
}

function capabilityFromJourney(journey: Pick<Journey, "id" | "name">): { id: string; name: string } {
  const text = `${journey.id} ${journey.name}`;
  if (/发送/.test(text) || /(?:^|-)send(?:-|$)/i.test(journey.id.replace(/^jny-/, ""))) {
    return { id: "cap-send", name: "发送" };
  }
  const fromId = journey.id.replace(/^jny-/, "");
  const slug = fromId && fromId !== "journey" ? fromId : nameToJourneySlug(journey.name);
  return { id: `cap-${slug}`, name: journey.name };
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
