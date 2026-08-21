import type {
  AgentResult,
  AgentTask,
  Control,
  ProbePlan,
  ProjectProfile,
  RunningProject,
  RunContext,
  RunPlan,
  Scope,
  SourcePrepareResult,
  SourceRequest,
  StartResult,
  Workspace
} from "./types.js";
import type { Candidate, EvidenceRecord } from "./types.js";

/**
 * 四接口。M1 实现 SourceProvider（git + local；archive 接口保留未交付）。
 * boot / discovery 只消费 Workspace + SourceSnapshot，不得依赖 source.kind。
 * 替换 AgentRunner 时，Source / Project / Discovery / Export 代码无需改动。
 */

export interface SourceProvider {
  prepare(source: SourceRequest): Promise<SourcePrepareResult>;
}

export interface ProjectAdapter {
  detect(workspace: Workspace): Promise<ProjectProfile>;
  createRunPlan(profile: ProjectProfile, context: RunContext): Promise<RunPlan>;
  /** 仅 status === "success" 时携带可用于 explore 的 RunningProject。 */
  start(plan: RunPlan): Promise<StartResult>;
  stop(project: RunningProject): Promise<void>;
}

export interface DiscoveryAdapter {
  /** scan 只依赖 workspace + scope，不依赖 StartResult。 */
  scan(
    workspace: Workspace,
    scope: Scope
  ): Promise<{ candidates: Candidate[]; evidence: EvidenceRecord[] }>;
  explore(
    running: RunningProject,
    plan: ProbePlan
  ): Promise<{ candidates: Candidate[]; evidence: EvidenceRecord[] }>;
  execute(
    running: RunningProject,
    action: Control
  ): Promise<{ candidates: Candidate[]; evidence: EvidenceRecord[] }>;
}

export interface AgentRunner {
  readonly inherit_host_credentials: false;
  readonly load_project_agent_config: false;
  readonly workspace: "read_only";
  readonly network: "denied_or_explicit";
  run(task: AgentTask): Promise<AgentResult>;
}

/**
 * 导出是函数，不是第五套插件协议。
 * 签名留在 export 包；此处仅标记依赖倒置边界。
 */
export interface ExportFns {
  generateProductMap: unknown;
  generateDiagrams: unknown;
  generateWeb: unknown;
  generateTests: unknown;
}
