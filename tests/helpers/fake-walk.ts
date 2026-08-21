import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_AGENT_POLICY,
  SCHEMA_VERSION,
  UNOBSERVED,
  type AgentRunner,
  type AgentTask,
  type Candidate,
  type Control,
  type DiffFile,
  type Effect,
  type EvidenceRecord,
  type Journey,
  type ReviewedModel,
  type SourceDescriptor,
  type StatusFile,
  type Surface,
  approvedReadsForRun,
  ensureDir,
  findPreviousCompletedRun,
  listRunIds,
  loadReviewedModel,
  readJson,
  snapshotModelFiles,
  stableCandidateId,
  writeJson,
  writeJsonl,
  writeText,
  writeYaml
} from "@behavior-map/contracts";
import { generateAll } from "@behavior-map/export";

export const FAKE_STUDY_ID = "study-m0-inbox";
export const FAKE_SCOPE_ID = "scope-send-probe";
export const FAKE_JOURNEY_ID = "jny-send-001";
export const FAKE_SNAPSHOT = "snap-m0-001";

export const SURFACES: Surface[] = [
  { id: "surface-composer", name: "撰写面", role: "current" },
  { id: "surface-peer-inbox", name: "对方收件面", role: "other" },
  { id: "surface-thread-list", name: "会话列表", role: "list" }
];

export const CONTROLS: Control[] = [
  {
    id: "control-send",
    surface_id: "surface-composer",
    name: "发送",
    action: "send",
    locator: { kind: "css", value: "[data-action=send]", reliable: false }
  }
];

const DISCOVERY: Array<{
  kind: Candidate["kind"];
  key: string;
  label: string;
  discovered_by: string;
  execution_status: Candidate["execution_status"];
  scope_status: Candidate["scope_status"];
  evidence: string[];
  review_status?: Candidate["review_status"];
  rejection_reason?: string | null;
}> = [
  {
    kind: "entry",
    key: "entry:composer",
    label: "撰写入口",
    discovered_by: "scan",
    execution_status: "observed",
    scope_status: "in_scope",
    evidence: ["ev-static-001"]
  },
  {
    kind: "surface",
    key: "surface:composer",
    label: "撰写面",
    discovered_by: "scan",
    execution_status: "observed",
    scope_status: "in_scope",
    evidence: ["ev-static-001"]
  },
  {
    kind: "surface",
    key: "surface:peer-inbox",
    label: "对方收件面",
    discovered_by: "explore",
    execution_status: "observed",
    scope_status: "in_scope",
    evidence: ["ev-runtime-002"]
  },
  {
    kind: "surface",
    key: "surface:thread-list",
    label: "会话列表",
    discovered_by: "scan",
    execution_status: "observed",
    scope_status: "in_scope",
    evidence: ["ev-static-002"]
  },
  {
    kind: "control",
    key: "control:send",
    label: "发送",
    discovered_by: "scan",
    execution_status: "executed",
    scope_status: "in_scope",
    evidence: ["ev-static-003", "ev-runtime-001"]
  },
  {
    kind: "interaction",
    key: "interaction:send-message",
    label: "发送一条消息",
    discovered_by: "execute",
    execution_status: "executed",
    scope_status: "in_scope",
    evidence: ["ev-runtime-001"]
  },
  {
    kind: "effect",
    key: "effect:current_surface",
    label: "本面仍停留在撰写区并显示已发送",
    discovered_by: "execute",
    execution_status: "observed",
    scope_status: "in_scope",
    evidence: ["ev-runtime-001"]
  },
  {
    kind: "effect",
    key: "effect:other_surface",
    label: "他面出现该条消息",
    discovered_by: "explore",
    execution_status: "observed",
    scope_status: "in_scope",
    evidence: ["ev-runtime-002"]
  },
  {
    kind: "effect",
    key: "effect:collection:list",
    label: "列表刷新出该会话",
    discovered_by: "explore",
    execution_status: "observed",
    scope_status: "in_scope",
    evidence: ["ev-runtime-003"]
  },
  {
    kind: "effect",
    key: "effect:indicator:unread",
    label: "未读指示",
    discovered_by: "explore",
    execution_status: "not_executed",
    scope_status: "in_scope",
    evidence: ["ev-runtime-004"]
  },
  {
    kind: "effect",
    key: "effect:notification",
    label: "通知",
    discovered_by: "explore",
    execution_status: "not_executed",
    scope_status: "in_scope",
    evidence: ["ev-runtime-005"]
  },
  {
    kind: "effect",
    key: "effect:backend_operation:http",
    label: "后台 HTTP 写入",
    discovered_by: "execute",
    execution_status: "observed",
    scope_status: "in_scope",
    evidence: ["ev-runtime-006"]
  },
  {
    kind: "surface",
    key: "surface:admin-console",
    label: "管理控制台",
    discovered_by: "scan",
    execution_status: "not_executed",
    scope_status: "out_of_scope",
    evidence: ["ev-static-004"],
    review_status: "rejected",
    rejection_reason: "不在本次探测范围内"
  }
];

export function writeStudyAndProbe(analysisRoot: string): void {
  writeYaml(join(analysisRoot, "study.yaml"), {
    schema_version: SCHEMA_VERSION,
    id: FAKE_STUDY_ID,
    name: "协作收件箱发送",
    goal: "映射一次发送动作在本面、他面、列表与后台的可观察效果",
    entry_seeds: ["composer"],
    include_hints: ["send", "inbox"],
    exclude_hints: ["admin"],
    exploration_mode: "approved_probe"
  });
  writeYaml(join(analysisRoot, "probe-plan.yaml"), {
    schema_version: SCHEMA_VERSION,
    human_approved: true,
    entry: "composer",
    session_slot: "primary",
    target_surface: "surface-composer",
    send_action: "control-send",
    other_surfaces_to_refresh: ["surface-peer-inbox", "surface-thread-list"]
  });
}

export function buildCandidates(snapshot: string): Candidate[] {
  return DISCOVERY.map((item) => ({
    schema_version: SCHEMA_VERSION,
    id: stableCandidateId(snapshot, item.key),
    kind: item.kind,
    scope_id: FAKE_SCOPE_ID,
    discovered_by: item.discovered_by,
    evidence_refs: item.evidence,
    execution_status: item.execution_status,
    scope_status: item.scope_status,
    review_status: item.review_status ?? "unreviewed",
    rejection_reason: item.rejection_reason ?? null,
    discovery_key: item.key,
    label: item.label
  }));
}

export function buildEvidence(): { staticRows: EvidenceRecord[]; runtimeRows: EvidenceRecord[] } {
  const staticRows: EvidenceRecord[] = [
    evidence("ev-static-001", "static", "surface-markup", { surface_id: "surface-composer" }),
    evidence("ev-static-002", "static", "surface-markup", { surface_id: "surface-thread-list" }),
    evidence("ev-static-003", "static", "control-locator", {
      control_id: "control-send",
      locator: "[data-action=send]",
      reliable: false
    }),
    evidence("ev-static-004", "static", "surface-markup", { surface_id: "surface-admin-console" })
  ];
  const runtimeRows: EvidenceRecord[] = [
    evidence("ev-runtime-001", "runtime", "control-execute", { action: "send" }),
    evidence("ev-runtime-002", "runtime", "other-surface-refresh", {
      surface_id: "surface-peer-inbox"
    }),
    evidence("ev-runtime-003", "runtime", "collection-refresh", { subtype: "list" }),
    evidence("ev-runtime-004", "runtime", "indicator-absent", {
      subtype: "unread",
      observed: false
    }),
    evidence("ev-runtime-005", "runtime", "notification-absent", { observed: false }),
    evidence("ev-runtime-006", "runtime", "backend-operation", {
      transport: "http",
      path: "/messages"
    })
  ];
  return { staticRows, runtimeRows };
}

function evidence(
  id: string,
  source: EvidenceRecord["source"],
  kind: string,
  payload: Record<string, unknown>
): EvidenceRecord {
  return {
    schema_version: SCHEMA_VERSION,
    id,
    immutable: true,
    source,
    kind,
    payload
  };
}

export function writeRunArtifacts(
  analysisRoot: string,
  runId: string,
  snapshot = FAKE_SNAPSHOT
): Candidate[] {
  const runDir = join(analysisRoot, "runs", runId);
  const source: SourceDescriptor = {
    schema_version: SCHEMA_VERSION,
    kind: "fixture",
    locator: "fixtures/m0-fake-study",
    revision: "fake-rev-1",
    snapshot
  };
  writeJson(join(runDir, "source.json"), source);
  writeJson(join(runDir, "project-profile.json"), {
    schema_version: SCHEMA_VERSION,
    detected_kind: "generic_web",
    entrypoints: ["composer"],
    notes: "M0 假数据画像，不是产品适配器"
  });
  writeYaml(join(runDir, "run-plan.yaml"), {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    study_id: FAKE_STUDY_ID,
    scope_id: FAKE_SCOPE_ID,
    secret_refs: [{ secret_ref: "env:STUDY_CREDENTIAL" }],
    steps: ["scan", "explore", "execute"]
  });
  writeYaml(join(runDir, "run-context.yaml"), {
    schema_version: SCHEMA_VERSION,
    role: "member",
    locale: "zh-CN",
    flags: [],
    credential_ref: "secret:study-member",
    cookie_ref: "secret:session-cookie",
    entry_url: "https://example.test/composer"
  });
  const status: StatusFile = {
    schema_version: SCHEMA_VERSION,
    phase: "completed",
    start_status: "success",
    completed: true,
    study_id: FAKE_STUDY_ID,
    scope_id: FAKE_SCOPE_ID
  };
  writeJson(join(runDir, "status.json"), status);
  writeJson(join(runDir, "running-project.json"), {
    schema_version: SCHEMA_VERSION,
    usable_for_explore: true,
    base_url: "https://example.test",
    pid_ref: "proc:fake"
  });
  ensureDir(join(runDir, "logs"));
  writeText(join(runDir, "logs", "walk.log"), `fake walk ${runId}\n`);
  const { staticRows, runtimeRows } = buildEvidence();
  writeJsonl(join(runDir, "evidence", "static.jsonl"), staticRows);
  writeJsonl(join(runDir, "evidence", "runtime.jsonl"), runtimeRows);
  const candidates = buildCandidates(snapshot);
  writeJsonl(join(runDir, "candidates.jsonl"), candidates);
  ensureDir(join(runDir, "agent-scratch"));
  writeDiff(analysisRoot, runId, snapshot);
  return candidates;
}

export function writeDiff(analysisRoot: string, runId: string, snapshot: string): void {
  const previous = findPreviousCompletedRun(analysisRoot, FAKE_STUDY_ID, FAKE_SCOPE_ID, runId);
  let comparison_mode: DiffFile["comparison_mode"] = "same_snapshot";
  if (previous) {
    const prevSource = readJson<SourceDescriptor>(
      join(analysisRoot, "runs", previous, "source.json")
    );
    comparison_mode =
      prevSource.snapshot === snapshot ? "same_snapshot" : "changed_snapshot";
  }
  const diff: DiffFile = {
    schema_version: SCHEMA_VERSION,
    baseline_run_id: previous ?? runId,
    current_run_id: runId,
    comparison_mode,
    study_id: FAKE_STUDY_ID,
    scope_id: FAKE_SCOPE_ID
  };
  writeJson(join(analysisRoot, "runs", runId, "diff.json"), diff);
}

export function applyHumanReview(analysisRoot: string, snapshot = FAKE_SNAPSHOT): ReviewedModel {
  if (existsSync(join(analysisRoot, "model", "journeys.yaml"))) {
    const existing = loadReviewedModel(analysisRoot);
    return attachSurfaces(existing);
  }

  const candidates = buildCandidates(snapshot);
  const byKey = Object.fromEntries(candidates.map((item) => [item.discovery_key, item]));
  const effects: Effect[] = [
    effect("eff-current", "本面显示已发送", "current_surface", true, "撰写面保留已发送草稿", [
      "ev-runtime-001"
    ], "surface-composer"),
    effect("eff-other", "他面出现消息", "other_surface", true, "对方收件面出现该条", [
      "ev-runtime-002"
    ], "surface-peer-inbox"),
    effect(
      "eff-list",
      "列表更新",
      "collection",
      true,
      "会话列表出现该会话",
      ["ev-runtime-003"],
      "surface-thread-list",
      "list"
    ),
    effect("eff-unread", "未读", "indicator", false, UNOBSERVED, ["ev-runtime-004"], undefined, "unread"),
    effect("eff-notification", "通知", "notification", false, UNOBSERVED, ["ev-runtime-005"]),
    effect(
      "eff-backend",
      "后台写入",
      "backend_operation",
      true,
      "HTTP POST /messages",
      ["ev-runtime-006"],
      undefined,
      undefined,
      "http"
    )
  ];
  const journeys: Journey[] = [
    {
      id: FAKE_JOURNEY_ID,
      name: "发送一条消息（已审定）",
      status: "accepted",
      effect_ids: effects.map((item) => item.id),
      control_id: "control-send"
    }
  ];
  const model: ReviewedModel = {
    schema_version: SCHEMA_VERSION,
    capabilities: [{ id: "cap-send", name: "发送", control_ids: ["control-send"] }],
    journeys,
    effects,
    decisions: [
      {
        candidate_id: byKey["interaction:send-message"].id,
        review_status: "kept",
        journey_id: FAKE_JOURNEY_ID,
        rename: "发送一条消息（已审定）"
      },
      {
        candidate_id: byKey["surface:admin-console"].id,
        review_status: "rejected",
        rejection_reason: "不在本次探测范围内"
      }
    ],
    surfaces: SURFACES,
    controls: CONTROLS
  };
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
  return model;
}

function effect(
  id: string,
  name: string,
  kind: Effect["observation"]["kind"],
  observed: boolean,
  display_value: string,
  evidence_refs: string[],
  surface_id?: string,
  subtype?: string,
  transport?: Effect["observation"]["transport"]
): Effect {
  return {
    id,
    name,
    observation: {
      kind,
      observed,
      display_value,
      evidence_refs,
      surface_id,
      subtype,
      transport
    }
  };
}

function attachSurfaces(model: ReviewedModel): ReviewedModel {
  return { ...model, surfaces: SURFACES, controls: CONTROLS };
}

export function makeAgentTask(analysisRoot: string, runId: string, taskId: string): AgentTask {
  return {
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    run_id: runId,
    analysis_root: analysisRoot,
    approved_read_paths: approvedReadsForRun(runId),
    policy: { ...DEFAULT_AGENT_POLICY }
  };
}

export interface FakeWalkResult {
  runId: string;
  agentStatus: string;
  model: ReviewedModel;
  modelSnapshot: Record<string, string>;
}

/**
 * 假数据走查：写入 analysis 树、调用注入的 AgentRunner、人工审定 model、导出。
 * AgentRunner 以参数注入，替换 Mock 不必改走查/导出代码。
 */
export async function runFakeWalk(
  analysisRoot: string,
  agent: AgentRunner,
  runId: string,
  snapshot = FAKE_SNAPSHOT
): Promise<FakeWalkResult> {
  writeStudyAndProbe(analysisRoot);
  writeRunArtifacts(analysisRoot, runId, snapshot);
  const agentResult = await agent.run(makeAgentTask(analysisRoot, runId, `task-${runId}`));
  if (agentResult.status === "failed") {
    throw new Error(agentResult.errors?.join("; ") ?? "agent failed");
  }
  const model = attachSurfaces(applyHumanReview(analysisRoot, snapshot));
  generateAll(model, analysisRoot);
  writeDiff(analysisRoot, runId, snapshot);
  return {
    runId,
    agentStatus: agentResult.status,
    model,
    modelSnapshot: snapshotModelFiles(analysisRoot)
  };
}

export function allRunIds(analysisRoot: string): string[] {
  return listRunIds(analysisRoot);
}
