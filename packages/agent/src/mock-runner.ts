import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_AGENT_POLICY,
  type AgentResult,
  type AgentRunner,
  type AgentTask,
  type Candidate,
  type Proposal,
  SCHEMA_VERSION,
  isGeneratedPath,
  proposalIdForTask,
  readJsonl,
  snapshotModelFiles,
  validateDocument,
  writeJson,
  writeText
} from "@behavior-map/contracts";

export function isAllowedAgentWritePath(runId: string, taskId: string, relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const proposal = `runs/${runId}/proposals/${taskId}.json`;
  const scratchPrefix = `runs/${runId}/agent-scratch/`;
  return normalized === proposal || normalized === scratchPrefix || normalized.startsWith(scratchPrefix);
}

/**
 * M0 唯一的 AgentRunner 实现。
 * 后续真实 runner 只需实现同一接口；Source / Project / Discovery / Export 不依赖本类。
 */
export class MockAgentRunner implements AgentRunner {
  readonly inherit_host_credentials = false as const;
  readonly load_project_agent_config = false as const;
  readonly workspace = "read_only" as const;
  readonly network = "denied_or_explicit" as const;
  readonly policy = DEFAULT_AGENT_POLICY;

  async run(task: AgentTask): Promise<AgentResult> {
    const modelBefore = snapshotModelFiles(task.analysis_root);
    try {
      this.assertPolicy(task);
      this.assertApprovedReads(task);
      const proposal = this.buildProposal(task);
      const relativeProposal = `runs/${task.run_id}/proposals/${task.task_id}.json`;
      const relativeScratch = `runs/${task.run_id}/agent-scratch/${task.task_id}.log`;
      if (
        !isAllowedAgentWritePath(task.run_id, task.task_id, relativeProposal) ||
        !isAllowedAgentWritePath(task.run_id, task.task_id, relativeScratch)
      ) {
        throw new Error("write_paths 超出合约允许范围");
      }

      const proposalPath = join(task.analysis_root, relativeProposal);
      const scratchPath = join(task.analysis_root, relativeScratch);
      writeJson(proposalPath, proposal);
      writeText(scratchPath, `mock-agent ${task.task_id} ${proposal.id}\n`);

      const schema = validateDocument("proposal", proposal, proposalPath);
      if (!schema.ok) {
        throw new Error(schema.issues.map((issue) => issue.message).join("; "));
      }

      this.assertModelUntouched(task.analysis_root, modelBefore);

      const uncertain = this.loadCandidates(task).some(
        (candidate) => candidate.execution_status === "uncertain"
      );
      return {
        status: uncertain ? "partial" : "success",
        proposal_id: proposal.id,
        write_paths: [
          `runs/${task.run_id}/proposals/${task.task_id}.json`,
          `runs/${task.run_id}/agent-scratch/`
        ]
      };
    } catch (error) {
      this.assertModelUntouched(task.analysis_root, modelBefore);
      return {
        status: "failed",
        write_paths: [],
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  private assertPolicy(task: AgentTask): void {
    const { policy } = task;
    if (policy.inherit_host_credentials !== false) {
      throw new Error("inherit_host_credentials 必须为 false");
    }
    if (policy.load_project_agent_config !== false) {
      throw new Error("load_project_agent_config 必须为 false");
    }
    if (policy.workspace !== "read_only") {
      throw new Error("workspace 必须为 read_only");
    }
    if (policy.network !== "denied_or_explicit") {
      throw new Error("network 必须为 denied_or_explicit");
    }
    if (task.task_id === "force-fail") {
      throw new Error("模拟失败：force-fail");
    }
  }

  private assertApprovedReads(task: AgentTask): void {
    if (task.approved_read_paths.length === 0) {
      throw new Error("必须声明 approved_read_paths");
    }
    for (const rel of task.approved_read_paths) {
      if (isGeneratedPath(rel)) {
        throw new Error(`generated/ 不得作为输入: ${rel}`);
      }
      if (rel.includes("..")) {
        throw new Error(`禁止读取越界路径: ${rel}`);
      }
    }
  }

  private loadCandidates(task: AgentTask): Candidate[] {
    const allowed = new Set(task.approved_read_paths.map((p) => p.replaceAll("\\", "/")));
    const candidatesRel = `runs/${task.run_id}/candidates.jsonl`;
    if (!allowed.has(candidatesRel)) {
      throw new Error(`未批准读取 ${candidatesRel}`);
    }
    const file = join(task.analysis_root, candidatesRel);
    if (!existsSync(file)) {
      throw new Error(`缺少 ${candidatesRel}`);
    }
    return readJsonl<Candidate>(file);
  }

  private buildProposal(task: AgentTask): Proposal {
    const candidates = this.loadCandidates(task);
    const effects = candidates.filter((candidate) => candidate.kind === "effect");
    const interaction = candidates.find((candidate) => candidate.kind === "interaction");
    return {
      schema_version: SCHEMA_VERSION,
      id: proposalIdForTask(task.task_id),
      task_id: task.task_id,
      run_id: task.run_id,
      inputs: [...task.approved_read_paths],
      proposed_journeys: [
        {
          name: "发送一条消息",
          candidate_ids: interaction ? [interaction.id] : [],
          effect_candidate_ids: effects.map((effect) => effect.id)
        }
      ],
      proposed_effects: effects.map((effect) => ({
        name: effect.label,
        candidate_id: effect.id,
        observation_kind: inferObservationKind(effect.discovery_key),
        subtype: inferSubtype(effect.discovery_key),
        transport: inferTransport(effect.discovery_key),
        observed: effect.execution_status === "observed" || effect.execution_status === "executed"
      }))
    };
  }

  private assertModelUntouched(analysisRoot: string, before: Record<string, string>): void {
    const after = snapshotModelFiles(analysisRoot);
    for (const [name, contents] of Object.entries(before)) {
      if (after[name] !== contents) {
        throw new Error(`MockAgentRunner 不得修改 model/${name}`);
      }
    }
  }
}

function inferObservationKind(discoveryKey: string): Proposal["proposed_effects"][number]["observation_kind"] {
  if (discoveryKey.includes("current_surface")) return "current_surface";
  if (discoveryKey.includes("other_surface")) return "other_surface";
  if (discoveryKey.includes("collection") || discoveryKey.includes("list")) return "collection";
  if (discoveryKey.includes("indicator") || discoveryKey.includes("unread")) return "indicator";
  if (discoveryKey.includes("notification")) return "notification";
  return "backend_operation";
}

function inferSubtype(discoveryKey: string): string | undefined {
  if (discoveryKey.includes("list")) return "list";
  if (discoveryKey.includes("unread")) return "unread";
  return undefined;
}

function inferTransport(discoveryKey: string): Proposal["proposed_effects"][number]["transport"] | undefined {
  if (discoveryKey.includes("http")) return "http";
  if (discoveryKey.includes("websocket")) return "websocket";
  if (discoveryKey.includes("rpc")) return "rpc";
  if (discoveryKey.includes("event")) return "event";
  if (discoveryKey.includes("database")) return "database";
  if (discoveryKey.includes("backend")) return "unknown";
  return undefined;
}
