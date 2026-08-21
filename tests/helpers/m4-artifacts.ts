import { join } from "node:path";
import {
  SCHEMA_VERSION,
  approvedReadsForRun,
  stableCandidateId,
  writeJson,
  writeJsonl,
  writeYaml,
  readJsonl,
  type Candidate,
  type EvidenceRecord
} from "@behavior-map/contracts";
import { DefaultDiscoveryAdapter, snapshotDigestFor } from "@behavior-map/discovery";
import { copyTwoSurfaceFixture, fixtureScope, workspaceAt } from "./two-surface.js";

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

function candidate(
  snapshot: string,
  item: {
    kind: Candidate["kind"];
    key: string;
    label: string;
    discovered_by: string;
    execution_status: Candidate["execution_status"];
    evidence: string[];
    scope_status?: Candidate["scope_status"];
  }
): Candidate {
  return {
    schema_version: SCHEMA_VERSION,
    id: stableCandidateId(snapshot, item.key),
    kind: item.kind,
    scope_id: "scope-message-sync",
    discovered_by: item.discovered_by,
    evidence_refs: item.evidence,
    execution_status: item.execution_status,
    scope_status: item.scope_status ?? "in_scope",
    review_status: "unreviewed",
    rejection_reason: null,
    discovery_key: item.key,
    label: item.label
  };
}

/**
 * 用 M4 双 Surface 夹具生成分析输入：真实 scan + 测试内补齐的 runtime 证据。
 * 不启动产品、不调用 Discovery execute、不走 Mock 假数据走查。
 */
export async function writeM4AnalysisArtifacts(dir: string, runId: string): Promise<void> {
  copyTwoSurfaceFixture(dir);
  const discovery = new DefaultDiscoveryAdapter({ runId });
  await discovery.scan(workspaceAt(dir), fixtureScope(dir));

  const snapshot = snapshotDigestFor(dir);
  const runtimeEvidence: EvidenceRecord[] = [
    evidence("ev-m4-runtime-send", "runtime", "backend-operation", {
      transport: "http",
      method: "POST",
      path: "/send"
    }),
    evidence("ev-m4-runtime-current", "runtime", "current-surface", {
      surface: "surface-target"
    }),
    evidence("ev-m4-runtime-other", "runtime", "other-surface", { surface: "surface-list" }),
    evidence("ev-m4-runtime-list", "runtime", "collection", { subtype: "list" }),
    evidence("ev-m4-runtime-unread", "runtime", "indicator-absent", {
      subtype: "unread",
      observed: false
    }),
    evidence("ev-m4-runtime-notification", "runtime", "notification-absent", { observed: false })
  ];

  const extra: Candidate[] = [
    candidate(snapshot, {
      kind: "interaction",
      key: "interaction:send-message",
      label: "发送一条消息",
      discovered_by: "execute",
      execution_status: "executed",
      evidence: ["ev-m4-runtime-send", "ev-m4-runtime-current"]
    }),
    candidate(snapshot, {
      kind: "effect",
      key: "effect:current_surface",
      label: "本面仍停留在撰写区",
      discovered_by: "execute",
      execution_status: "observed",
      evidence: ["ev-m4-runtime-current"]
    }),
    candidate(snapshot, {
      kind: "effect",
      key: "effect:other_surface",
      label: "他面列表出现该条",
      discovered_by: "explore",
      execution_status: "observed",
      evidence: ["ev-m4-runtime-other"]
    }),
    candidate(snapshot, {
      kind: "effect",
      key: "effect:collection:list",
      label: "列表刷新",
      discovered_by: "explore",
      execution_status: "observed",
      evidence: ["ev-m4-runtime-list"]
    }),
    candidate(snapshot, {
      kind: "effect",
      key: "effect:indicator:unread",
      label: "未读指示",
      discovered_by: "explore",
      execution_status: "not_executed",
      evidence: ["ev-m4-runtime-unread"]
    }),
    candidate(snapshot, {
      kind: "effect",
      key: "effect:notification",
      label: "通知",
      discovered_by: "explore",
      execution_status: "not_executed",
      evidence: ["ev-m4-runtime-notification"]
    }),
    candidate(snapshot, {
      kind: "effect",
      key: "effect:backend_operation:http",
      label: "后台 HTTP 写入",
      discovered_by: "execute",
      execution_status: "observed",
      evidence: ["ev-m4-runtime-send"]
    })
  ];

  const runRoot = join(dir, "runs", runId);
  const existing = readJsonl<Candidate>(join(runRoot, "candidates.jsonl"));
  writeJsonl(join(runRoot, "candidates.jsonl"), [...existing, ...extra]);
  writeJsonl(join(runRoot, "evidence", "runtime.jsonl"), runtimeEvidence);

  const draftPlan = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    secret_refs: [{ secret_ref: "env:STUDY_CREDENTIAL" }],
    components: [
      {
        id: "app",
        role: "app",
        depends_on: [],
        install: { command: "not_done" },
        start_order: 1,
        healthcheck: { kind: "http", url: "http://127.0.0.1:3000/health" },
        logs: "logs/app.log",
        seed: { status: "not_done" }
      }
    ],
    confirmation: { status: "draft" }
  };
  writeYaml(join(dir, "run-plan.yaml"), draftPlan);
  writeYaml(join(runRoot, "run-plan.yaml"), draftPlan);
  writeYaml(join(dir, "model", "capabilities.yaml"), {
    schema_version: SCHEMA_VERSION,
    capabilities: []
  });
  writeYaml(join(dir, "model", "journeys.yaml"), { schema_version: SCHEMA_VERSION, journeys: [] });
  writeYaml(join(dir, "model", "effects.yaml"), { schema_version: SCHEMA_VERSION, effects: [] });
  writeYaml(join(dir, "model", "review-decisions.yaml"), {
    schema_version: SCHEMA_VERSION,
    decisions: []
  });
  writeJson(join(runRoot, "project-profile.json"), {
    schema_version: SCHEMA_VERSION,
    faces: [{ id: "compose", name: "撰写面", clues: ["two-surface"] }],
    parts: [{ id: "app", role: "app", clues: ["generic_web"] }],
    frameworks: ["node"],
    how_to_run: []
  });
}

export function m4ApprovedReads(runId: string): string[] {
  return approvedReadsForRun(runId);
}
