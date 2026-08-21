import { join } from "node:path";
import {
  snapshotModelFiles,
  validateDocument,
  validateSemantics,
  writeJson,
  writeText,
  writeYaml,
  type AgentResult,
  type AgentRunner,
  type AgentTask,
  type Proposal
} from "@behavior-map/contracts";
import {
  DeterministicAnalysisBackend,
  loadAnalysisContext,
  type AgentAnalysisBackend
} from "./deterministic.js";
import { isOptionalLlmEnabled, OptionalLlmBackend, type OptionalLlmOptions } from "./llm.js";
import { assertAgentTrustPolicy, assertApprovedReads } from "./policy.js";
import { assertAllowedAgentWritePath } from "./write-paths.js";

export interface DefaultAgentRunnerOptions extends OptionalLlmOptions {
  backend?: AgentAnalysisBackend;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("agent_timeout")), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * M5 真实 AgentRunner。
 * 对已批准的 M4 产物做确定性事后分析；不探索产品，不驱动 Discovery execute。
 * MockAgentRunner 仍用于 M0 合约测试，二者实现同一接口。
 */
export class DefaultAgentRunner implements AgentRunner {
  readonly inherit_host_credentials = false as const;
  readonly load_project_agent_config = false as const;
  readonly workspace = "read_only" as const;
  readonly network = "denied_or_explicit" as const;

  private readonly backend: AgentAnalysisBackend;

  constructor(options: DefaultAgentRunnerOptions = {}) {
    const deterministic = options.backend ?? new DeterministicAnalysisBackend();
    this.backend =
      !options.backend && isOptionalLlmEnabled(options)
        ? new OptionalLlmBackend(deterministic, options.complete)
        : deterministic;
  }

  async run(task: AgentTask): Promise<AgentResult> {
    const modelBefore = snapshotModelFiles(task.analysis_root);
    try {
      assertAgentTrustPolicy(task, { requireKind: true });
      assertApprovedReads(task);
      this.refuseForbiddenWrites(task);

      const proposal = await withTimeout(this.analyze(task), task.timeout_ms);
      this.writeProposal(task, proposal);
      this.assertValid(task, proposal);
      this.assertModelUntouched(task.analysis_root, modelBefore);

      const uncertain = loadAnalysisContext(task).candidates.some(
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
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: message === "agent_timeout" ? "partial" : "failed",
        write_paths: [],
        errors: [message]
      };
    }
  }

  private async analyze(task: AgentTask): Promise<Proposal> {
    return this.backend.analyze(loadAnalysisContext(task));
  }

  private refuseForbiddenWrites(task: AgentTask): void {
    if (task.task_id === "force-fail") {
      throw new Error("模拟失败：force-fail");
    }
    if (task.task_id === "force-write-model") {
      assertAllowedAgentWritePath(task.run_id, task.task_id, "model/journeys.yaml");
    }
  }

  private writeProposal(task: AgentTask, proposal: Proposal): void {
    const relativeProposal = `runs/${task.run_id}/proposals/${task.task_id}.json`;
    const relativeScratch = `runs/${task.run_id}/agent-scratch/${task.task_id}.log`;
    assertAllowedAgentWritePath(task.run_id, task.task_id, relativeProposal);
    assertAllowedAgentWritePath(task.run_id, task.task_id, relativeScratch);
    writeJson(join(task.analysis_root, relativeProposal), proposal);
    writeText(
      join(task.analysis_root, relativeScratch),
      `default-agent ${task.kind ?? ""} ${task.task_id} ${proposal.id}\n`
    );

    if (proposal.proposed_run_plan) {
      const relativePlan = `runs/${task.run_id}/agent-scratch/proposed-run-plan.yaml`;
      assertAllowedAgentWritePath(task.run_id, task.task_id, relativePlan);
      writeYaml(join(task.analysis_root, relativePlan), proposal.proposed_run_plan);
    }
  }

  private assertValid(task: AgentTask, proposal: Proposal): void {
    const proposalPath = join(
      task.analysis_root,
      `runs/${task.run_id}/proposals/${task.task_id}.json`
    );
    const schema = validateDocument("proposal", proposal, proposalPath);
    if (!schema.ok) {
      throw new Error(schema.issues.map((issue) => issue.message).join("; "));
    }
    const semantic = validateSemantics(task.analysis_root);
    if (!semantic.ok) {
      throw new Error(semantic.issues.map((issue) => issue.message).join("; "));
    }
  }

  private assertModelUntouched(analysisRoot: string, before: Record<string, string>): void {
    const after = snapshotModelFiles(analysisRoot);
    for (const [name, contents] of Object.entries(before)) {
      if (after[name] !== contents) {
        throw new Error(`DefaultAgentRunner 不得修改 model/${name}`);
      }
    }
  }
}
