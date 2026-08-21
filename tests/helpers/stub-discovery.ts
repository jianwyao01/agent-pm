import type {
  Control,
  DiscoveryAdapter,
  ProbePlan,
  RunningProject,
  Scope,
  Workspace
} from "@behavior-map/contracts";
import type { Candidate, EvidenceRecord } from "@behavior-map/contracts";

/**
 * scan 占位：可在 start 失败后仍被调用。
 * 不是真实 Discovery；explore / execute 未交付。
 */
export class StubDiscoveryAdapter implements DiscoveryAdapter {
  async scan(
    _workspace: Workspace,
    _scope: Scope
  ): Promise<{ candidates: Candidate[]; evidence: EvidenceRecord[] }> {
    return { candidates: [], evidence: [] };
  }

  async explore(
    _running: RunningProject,
    _plan: ProbePlan
  ): Promise<{ candidates: Candidate[]; evidence: EvidenceRecord[] }> {
    throw new Error("Discovery.explore is not shipped");
  }

  async execute(
    _running: RunningProject,
    _action: Control
  ): Promise<{ candidates: Candidate[]; evidence: EvidenceRecord[] }> {
    throw new Error("Discovery.execute is not shipped");
  }
}
