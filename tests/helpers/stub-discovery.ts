import type {
  ActionObservation,
  Control,
  DiscoveryAdapter,
  DiscoveryProjectInput,
  RunContext,
  RuntimeDiscoveryResult,
  Scope,
  StaticDiscoveryResult,
  Workspace
} from "@behavior-map/contracts";
import { CROSS_ACTOR_UNEXECUTED } from "@behavior-map/contracts";

/**
 * 接口占位。M4 真实实现见 @behavior-map/discovery。
 */
export class StubDiscoveryAdapter implements DiscoveryAdapter {
  async scan(_workspace: Workspace, _scope: Scope): Promise<StaticDiscoveryResult> {
    return { status: "success", candidates: [], evidence: [], gaps: [] };
  }

  async explore(
    _project: DiscoveryProjectInput,
    _context: RunContext,
    _scope: Scope
  ): Promise<RuntimeDiscoveryResult> {
    return {
      status: "refused",
      candidates: [],
      evidence: [],
      observations: [],
      gaps: [{ reason: "stub", message: "use DefaultDiscoveryAdapter" }]
    };
  }

  async execute(
    _project: DiscoveryProjectInput,
    _context: RunContext,
    _action: Control
  ): Promise<ActionObservation> {
    return {
      status: "refused",
      observations: [],
      evidence: [],
      candidates: [],
      gaps: [{ reason: "stub", message: "use DefaultDiscoveryAdapter" }],
      cross_actor: { executed: false, display_value: CROSS_ACTOR_UNEXECUTED }
    };
  }

  async play(
    project: DiscoveryProjectInput,
    context: RunContext,
    actions: Control[]
  ): Promise<ActionObservation[]> {
    if (actions.length === 0) {
      return [];
    }
    const first = await this.execute(project, context, actions[0]);
    return [first];
  }
}
