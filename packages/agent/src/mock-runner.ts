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
  proposalIdForTask,
  readJsonl,
  snapshotModelFiles,
  validateDocument,
  writeJson,
  writeText
} from "@behavior-map/contracts";
import { assertAgentTrustPolicy, assertApprovedReads, requireApprovedRead } from "./policy.js";
import { isAllowedAgentWritePath } from "./write-paths.js";

export { isAllowedAgentWritePath, assertAllowedAgentWritePath } from "./write-paths.js";

/**
 * M0 合约测试用的 AgentRunner。
 * 不是第二套引擎；真实分析由 DefaultAgentRunner 承担。
 * 替换实现时 Source / Project / Discovery / Export 不必改动。
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
      assertAgentTrustPolicy(task);
      assertApprovedReads(task);
      if (task.task_id === "force-fail") {
        throw new Error("模拟失败：force-fail");
      }
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

  private loadCandidates(task: AgentTask): Candidate[] {
    const candidatesRel = `runs/${task.run_id}/candidates.jsonl`;
    requireApprovedRead(task, candidatesRel);
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
