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
import { usableProject, refusedGap } from "./project-guard.js";
import { scanWorkspace, type ScanOptions } from "./scan.js";
import { executeAction, exploreRuntime, type RuntimeOptions } from "./runtime.js";

export interface DiscoveryAdapterOptions extends ScanOptions, RuntimeOptions {
  analysisRoot?: string;
}

export class DefaultDiscoveryAdapter implements DiscoveryAdapter {
  private workspacePath?: string;
  private lastScope?: Scope;

  constructor(private readonly options: DiscoveryAdapterOptions = {}) {}

  async scan(workspace: Workspace, scope: Scope): Promise<StaticDiscoveryResult> {
    this.workspacePath = workspace.path;
    this.lastScope = scope;
    return scanWorkspace(workspace, scope, {
      runId: this.options.runId,
      runRoot: this.options.runRoot,
      snapshotId: this.options.snapshotId,
      candidateCap: this.options.candidateCap
    });
  }

  async explore(
    project: DiscoveryProjectInput,
    context: RunContext,
    scope: Scope
  ): Promise<RuntimeDiscoveryResult> {
    this.lastScope = scope;
    const running = usableProject(project);
    if (!running) {
      return {
        status: "refused",
        candidates: [],
        evidence: [],
        observations: [],
        gaps: [refusedGap()]
      };
    }
    return exploreRuntime(running, context, scope, this.runtimeOptions());
  }

  async execute(
    project: DiscoveryProjectInput,
    context: RunContext,
    action: Control
  ): Promise<ActionObservation> {
    const running = usableProject(project);
    if (!running) {
      return {
        status: "refused",
        observations: [],
        evidence: [],
        candidates: [],
        gaps: [refusedGap()],
        cross_actor: { executed: false, display_value: CROSS_ACTOR_UNEXECUTED }
      };
    }
    const scope = this.lastScope ?? {
      id: this.options.runId ?? "scope-discovery",
      include_hints: [],
      exclude_hints: []
    };
    return executeAction(running, context, action, scope, this.runtimeOptions());
  }

  private runtimeOptions(): RuntimeOptions {
    return {
      runId: this.options.runId,
      runRoot: this.options.runRoot,
      snapshotId: this.options.snapshotId,
      workspacePath: this.workspacePath ?? this.options.analysisRoot ?? this.options.workspacePath
    };
  }
}
