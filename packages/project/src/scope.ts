import { join } from "node:path";
import {
  SCHEMA_VERSION,
  readYaml,
  validateDocument,
  writeYaml,
  type ProbePlan,
  type RunContext,
  type Study
} from "@behavior-map/contracts";

/**
 * 首发 study：消息发送与状态同步。
 * 核心类型只有 Surface / Control / Journey / Observation。
 * 发送入口在范围内，不得标为 out of scope。
 */
export const MESSAGE_SYNC_STUDY: Study = {
  schema_version: SCHEMA_VERSION,
  id: "study-message-sync",
  name: "消息发送与状态同步",
  goal: "打开已有目标 Surface，经导航树点击进入该 Surface，并发送一条消息，观察状态同步",
  entry_seeds: ["nav-tree-open-surface", "send-message"],
  include_hints: [
    "打开已有目标 Surface",
    "导航树点击以打开该 Surface",
    "发送一条消息"
  ],
  exclude_hints: [
    "穷尽导航树",
    "创建容器",
    "容器管理",
    "穷尽私信",
    "话题串",
    "管理后台"
  ],
  exploration_mode: "approved_probe"
};

export const MESSAGE_SYNC_PROBE_PLAN: ProbePlan = {
  schema_version: SCHEMA_VERSION,
  human_approved: true,
  entry: "nav-tree-open-surface",
  session_slot: "primary",
  target_surface: "surface-target",
  send_action: "control-send",
  other_surfaces_to_refresh: ["surface-peer", "surface-list"]
};

export const MESSAGE_SYNC_RUN_CONTEXT: RunContext = {
  schema_version: SCHEMA_VERSION,
  role: "member",
  locale: "zh-CN",
  flags: [],
  credential_ref: "secret:study-member",
  cookie_ref: "secret:session-cookie",
  entry_url: "https://example.test/app"
};

export interface ScopeDocuments {
  study: Study;
  probePlan: ProbePlan;
  runContext: RunContext;
}

export function writeScopeDocuments(dir: string, docs: ScopeDocuments = {
  study: MESSAGE_SYNC_STUDY,
  probePlan: MESSAGE_SYNC_PROBE_PLAN,
  runContext: MESSAGE_SYNC_RUN_CONTEXT
}): void {
  writeYaml(join(dir, "study.yaml"), docs.study);
  writeYaml(join(dir, "probe-plan.yaml"), docs.probePlan);
  writeYaml(join(dir, "run-context.yaml"), docs.runContext);
}

export function readScopeDocuments(dir: string): ScopeDocuments {
  const study = readYaml<Study>(join(dir, "study.yaml"));
  const probePlan = readYaml<ProbePlan>(join(dir, "probe-plan.yaml"));
  const runContext = readYaml<RunContext>(join(dir, "run-context.yaml"));
  for (const [kind, data, file] of [
    ["study", study, "study.yaml"],
    ["probe-plan", probePlan, "probe-plan.yaml"],
    ["run-context", runContext, "run-context.yaml"]
  ] as const) {
    const report = validateDocument(kind, data, join(dir, file));
    if (!report.ok) {
      throw new Error(report.issues.map((issue) => issue.message).join("; "));
    }
  }
  return { study, probePlan, runContext };
}
