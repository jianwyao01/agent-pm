import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  proposalIdForTask,
  readJson,
  readJsonl,
  readYaml,
  type AgentTask,
  type AgentTaskKind,
  type Candidate,
  type EvidenceRecord,
  type ObservationKind,
  type ProjectProfile,
  type Proposal,
  type ProposedEffect,
  type ProposedFeature,
  type ProposedJourney,
  type PrunedItem,
  type RunPlan,
  type Study,
  type Transport
} from "@behavior-map/contracts";
import { requireApprovedRead } from "./policy.js";

export interface AnalysisContext {
  task: AgentTask;
  candidates: Candidate[];
  evidence: Map<string, EvidenceRecord>;
  study?: Study;
}

export interface AgentAnalysisBackend {
  analyze(ctx: AnalysisContext): Promise<Proposal>;
}

const SEND_HINTS = ["send", "发送", "compose", "撰写", "submit", "type", "输入"];
const LIST_HINTS = ["list", "列表", "collection", "item-list", "inbox", "收件"];
const NAV_HINTS = ["nav", "打开", "entry", "导航"];
const GESTURE_HINTS = ["swipe", "long-press", "longpress", "long_press"];
const EXCLUDE_HINTS = ["admin", "管理后台", "话题", "thread", "container", "容器"];

function hay(candidate: Candidate): string {
  return `${candidate.discovery_key} ${candidate.label} ${candidate.kind}`.toLowerCase();
}

function matches(candidate: Candidate, needles: string[]): boolean {
  const text = hay(candidate);
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function evidenceUnion(candidates: Candidate[]): string[] {
  return unique(candidates.flatMap((item) => item.evidence_refs).filter(Boolean));
}

function explainFeature(name: string, who: string, combinations: string): string {
  return `${name}是本次分析保留的产品功能，描述一组已被证据支撑的界面与控件。它主要影响${who}，而不是范围外的管理或容器操作。需要同时关注的组合是${combinations}；缺观察只能记为未观察到或未执行，不得写成不存在。`;
}

function explainJourney(name: string, who: string, combinations: string): string {
  return `${name}把一次可执行动作串成旅程，入口与效果都来自 candidates.jsonl 中的既有 ID。受影响的行动者是${who}。有意义的组合是${combinations}；没有证据的边不会进入提案。`;
}

function explainEffect(name: string, who: string, combinations: string): string {
  return `${name}是对已记录证据的效果归类，不发明新的 candidate_id。它影响${who}在对应表面上的可见状态。需要对照的组合是${combinations}；未读或通知若未执行，只记未观察到，不表示该能力不存在。`;
}

function loadStudy(task: AgentTask): Study | undefined {
  if (!requireExists(task, "study.yaml")) {
    return undefined;
  }
  return readYaml<Study>(join(task.analysis_root, "study.yaml"));
}

function requireExists(task: AgentTask, relativePath: string): boolean {
  if (!task.approved_read_paths.map((item) => item.replaceAll("\\", "/")).includes(relativePath)) {
    return false;
  }
  return existsSync(join(task.analysis_root, relativePath));
}

export function loadAnalysisContext(task: AgentTask): AnalysisContext {
  const candidatesRel = `runs/${task.run_id}/candidates.jsonl`;
  requireApprovedRead(task, candidatesRel);
  const file = join(task.analysis_root, candidatesRel);
  if (!existsSync(file)) {
    throw new Error(`缺少 ${candidatesRel}`);
  }
  const candidates = readJsonl<Candidate>(file);
  const evidence = new Map<string, EvidenceRecord>();
  for (const name of ["static.jsonl", "runtime.jsonl"] as const) {
    const rel = `runs/${task.run_id}/evidence/${name}`;
    if (!task.approved_read_paths.map((item) => item.replaceAll("\\", "/")).includes(rel)) {
      continue;
    }
    const path = join(task.analysis_root, rel);
    if (!existsSync(path)) {
      continue;
    }
    for (const row of readJsonl<EvidenceRecord>(path)) {
      evidence.set(row.id, row);
    }
  }
  return { task, candidates, evidence, study: loadStudy(task) };
}

function existingEvidence(ctx: AnalysisContext, refs: string[]): string[] {
  return unique(refs.filter((ref) => ctx.evidence.has(ref)));
}

function withEvidence(ctx: AnalysisContext, candidates: Candidate[]): Candidate[] {
  return candidates.filter((item) => existingEvidence(ctx, item.evidence_refs).length > 0);
}

function shouldPrune(candidate: Candidate, study?: Study): string | undefined {
  if (candidate.evidence_refs.length === 0) {
    return `候选「${candidate.label}」没有 evidence_ref，按无证据边剪枝，不能把它写成功能不存在。`;
  }
  if (candidate.scope_status === "out_of_scope") {
    return `候选「${candidate.label}」的 scope_status 为范围外，不属于本次研究，予以剪枝。`;
  }
  if (matches(candidate, GESTURE_HINTS)) {
    return `候选「${candidate.label}」属于 swipe/long-press 等未执行手势，保留原因并剪枝，不得当作已探索。`;
  }
  const excludes = [...EXCLUDE_HINTS, ...(study?.exclude_hints ?? [])];
  if (matches(candidate, excludes) && !matches(candidate, SEND_HINTS) && !matches(candidate, NAV_HINTS)) {
    return `候选「${candidate.label}」命中排除提示（${excludes.filter((hint) => hay(candidate).includes(hint.toLowerCase())).join("、") || "范围外"}），从本轮提案中剪枝。`;
  }
  return undefined;
}

function classifyClusters(ctx: AnalysisContext): {
  features: ProposedFeature[];
  pruned: PrunedItem[];
  kept: Candidate[];
} {
  const pruned: PrunedItem[] = [];
  const kept: Candidate[] = [];
  for (const candidate of ctx.candidates) {
    const reason = shouldPrune(candidate, ctx.study);
    if (reason) {
      pruned.push({ candidate_id: candidate.id, reason });
      continue;
    }
    if (existingEvidence(ctx, candidate.evidence_refs).length === 0) {
      pruned.push({
        candidate_id: candidate.id,
        reason: `候选「${candidate.label}」引用的证据不存在，无证据边被拒绝。`
      });
      continue;
    }
    kept.push(candidate);
  }

  const groups: Array<{ name: string; who: string; combinations: string; pick: (c: Candidate) => boolean }> = [
    {
      name: "发送一条消息",
      who: "当前撰写面的发送者以及需要看见结果的他面读者",
      combinations: "撰写面提交控件、列表面刷新与任何已记录的后台写入",
      pick: (c) => matches(c, SEND_HINTS)
    },
    {
      name: "列表与他面同步",
      who: "停留在列表面或收件面的读者",
      combinations: "列表面集合、导航打开目标面之后的返回刷新",
      pick: (c) => matches(c, LIST_HINTS) && !matches(c, SEND_HINTS)
    },
    {
      name: "打开已有目标面",
      who: "从列表导航进入目标面的操作者",
      combinations: "入口种子、导航点击与目标撰写面同时在范围内",
      pick: (c) => matches(c, NAV_HINTS) && !matches(c, SEND_HINTS)
    }
  ];

  const assigned = new Set<string>();
  const features: ProposedFeature[] = [];
  for (const group of groups) {
    const members = kept.filter((item) => group.pick(item));
    const refs = existingEvidence(ctx, evidenceUnion(members));
    if (members.length === 0 || refs.length === 0) {
      continue;
    }
    members.forEach((item) => assigned.add(item.id));
    features.push({
      name: group.name,
      candidate_ids: members.map((item) => item.id),
      evidence_refs: refs,
      explanation: explainFeature(group.name, group.who, group.combinations)
    });
  }

  const leftovers = kept.filter((item) => !assigned.has(item.id) && item.scope_status === "in_scope");
  const leftoverRefs = existingEvidence(ctx, evidenceUnion(leftovers));
  if (leftovers.length > 0 && leftoverRefs.length > 0) {
    features.push({
      name: "范围内其它可见控件",
      candidate_ids: leftovers.map((item) => item.id),
      evidence_refs: leftoverRefs,
      explanation: explainFeature(
        "范围内其它可见控件",
        "仍在本次探测范围内的操作者",
        "这些控件与发送主路径的组合；未被归入主功能并不等于不存在"
      )
    });
  }

  return { features, pruned, kept };
}

function inferObservationKind(candidate: Candidate): ObservationKind {
  const text = hay(candidate);
  if (text.includes("current_surface") || text.includes("撰写") || text.includes("compose") || text.includes("target")) {
    return "current_surface";
  }
  if (text.includes("other_surface") || text.includes("peer") || text.includes("他面")) {
    return "other_surface";
  }
  if (text.includes("collection") || text.includes("list") || text.includes("列表")) {
    return "collection";
  }
  if (text.includes("unread") || text.includes("indicator") || text.includes("未读")) {
    return "indicator";
  }
  if (text.includes("notification") || text.includes("通知")) {
    return "notification";
  }
  return "backend_operation";
}

function inferSubtype(candidate: Candidate): string | undefined {
  const text = hay(candidate);
  if (text.includes("list") || text.includes("列表") || text.includes("collection")) return "list";
  if (text.includes("unread") || text.includes("未读")) return "unread";
  return undefined;
}

function inferTransport(candidate: Candidate, evidence: Map<string, EvidenceRecord>): Transport | undefined {
  const text = hay(candidate);
  if (text.includes("http") || text.includes("/send")) return "http";
  if (text.includes("websocket")) return "websocket";
  if (text.includes("rpc")) return "rpc";
  if (text.includes("event")) return "event";
  if (text.includes("database")) return "database";
  for (const ref of candidate.evidence_refs) {
    const payload = evidence.get(ref)?.payload ?? {};
    const blob = JSON.stringify(payload).toLowerCase();
    if (blob.includes("http") || blob.includes("post") || blob.includes("/send")) return "http";
  }
  if (text.includes("backend")) return "unknown";
  return undefined;
}

function observedFrom(candidate: Candidate): boolean {
  return candidate.execution_status === "observed" || candidate.execution_status === "executed";
}

function buildEffects(ctx: AnalysisContext, kept: Candidate[]): ProposedEffect[] {
  const effectRows = withEvidence(
    ctx,
    kept.filter((item) => item.kind === "effect")
  );
  const source = effectRows.length > 0
    ? effectRows
    : withEvidence(
        ctx,
        kept.filter((item) => item.kind === "surface" || item.kind === "interaction")
      );

  return source.map((candidate) => {
    const kind = inferObservationKind(candidate);
    const refs = existingEvidence(ctx, candidate.evidence_refs);
    return {
      name: candidate.label,
      candidate_id: candidate.id,
      observation_kind: kind,
      subtype: inferSubtype(candidate),
      transport: kind === "backend_operation" ? inferTransport(candidate, ctx.evidence) : undefined,
      observed: observedFrom(candidate),
      evidence_refs: refs,
      explanation: explainEffect(
        candidate.label,
        kind === "other_surface" || kind === "collection" ? "他面或列表上的读者" : "当前面上的操作者",
        `${kind} 与同一旅程中其它已取证效果`
      )
    };
  });
}

function buildJourneys(ctx: AnalysisContext, kept: Candidate[]): ProposedJourney[] {
  const interactions = withEvidence(
    ctx,
    kept.filter((item) => item.kind === "interaction")
  );
  const sendControls = withEvidence(
    ctx,
    kept.filter((item) => item.kind === "control" && matches(item, SEND_HINTS))
  );
  const effects = withEvidence(
    ctx,
    kept.filter((item) => item.kind === "effect")
  );
  const spine = interactions.length > 0 ? interactions : sendControls;
  if (spine.length === 0) {
    const surfaces = withEvidence(
      ctx,
      kept.filter((item) => item.kind === "surface" || item.kind === "entry")
    );
    if (surfaces.length === 0) {
      return [];
    }
    const refs = existingEvidence(ctx, evidenceUnion(surfaces));
    return [
      {
        name: "范围内可见路径",
        candidate_ids: surfaces.map((item) => item.id),
        effect_candidate_ids: effects.map((item) => item.id),
        evidence_refs: refs,
        explanation: explainJourney(
          "范围内可见路径",
          "当前探测会话中的操作者",
          "已取证表面与其效果候选；没有交互候选时不编造发送已完成"
        )
      }
    ];
  }

  const refs = existingEvidence(ctx, evidenceUnion([...spine, ...effects]));
  return [
    {
      name: "发送一条消息",
      candidate_ids: spine.map((item) => item.id),
      effect_candidate_ids: effects.map((item) => item.id),
      evidence_refs: refs,
      explanation: explainJourney(
        "发送一条消息",
        "撰写面发送者与列表面读者",
        "发送控件、本面停留、他面/列表刷新以及已记录的后台传输"
      )
    }
  ];
}

function proposeRunPlan(task: AgentTask): RunPlan | undefined {
  const runPlanRel = `runs/${task.run_id}/run-plan.yaml`;
  const rootPlanRel = "run-plan.yaml";
  const rel = [runPlanRel, rootPlanRel].find((path) => requireExists(task, path));
  if (rel) {
    const existing = readYaml<RunPlan>(join(task.analysis_root, rel));
    return {
      ...existing,
      confirmation: { status: "draft" }
    };
  }
  const profileRel = `runs/${task.run_id}/project-profile.json`;
  if (!requireExists(task, profileRel)) {
    return undefined;
  }
  const profile = readJson<ProjectProfile>(join(task.analysis_root, profileRel));
  if (!profile.parts?.length) {
    return undefined;
  }
  return {
    schema_version: SCHEMA_VERSION,
    run_id: task.run_id,
    secret_refs: [],
    components: profile.parts.map((part, index) => ({
      id: part.id,
      role: part.role,
      depends_on: [],
      install: { command: "not_done" },
      start_order: index + 1,
      healthcheck: { kind: "command", command: "true" },
      logs: `logs/${part.id}.log`,
      seed: { status: "not_done" }
    })),
    confirmation: { status: "draft" }
  };
}

function baseProposal(ctx: AnalysisContext, extras: Partial<Proposal>): Proposal {
  return {
    schema_version: SCHEMA_VERSION,
    id: proposalIdForTask(ctx.task.task_id),
    task_id: ctx.task.task_id,
    run_id: ctx.task.run_id,
    inputs: [...ctx.task.approved_read_paths],
    kind: ctx.task.kind,
    proposed_journeys: [],
    proposed_effects: [],
    ...extras
  };
}

export class DeterministicAnalysisBackend implements AgentAnalysisBackend {
  async analyze(ctx: AnalysisContext): Promise<Proposal> {
    const kind: AgentTaskKind = ctx.task.kind ?? "classify_features";
    const { features, pruned, kept } = classifyClusters(ctx);

    if (kind === "classify_features") {
      return baseProposal(ctx, {
        proposed_features: features,
        pruned,
        proposed_run_plan: proposeRunPlan(ctx.task)
      });
    }
    if (kind === "build_journeys") {
      return baseProposal(ctx, {
        proposed_journeys: buildJourneys(ctx, kept),
        pruned
      });
    }
    if (kind === "analyze_effects") {
      return baseProposal(ctx, {
        proposed_effects: buildEffects(ctx, kept),
        pruned
      });
    }
    return baseProposal(ctx, {
      proposed_features: features,
      pruned
    });
  }
}
