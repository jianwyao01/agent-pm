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
import { playActions } from "./probe-runner.js";
import { executeAction, exploreRuntime, type RuntimeOptions } from "./runtime.js";

export interface DiscoveryAdapterOptions extends ScanOptions, RuntimeOptions {
  analysisRoot?: string;
  sessionRefs?: Record<string, string>;
  /** 未先 scan / explore 时 play 使用的 scope；不是第五套接口。 */
  scope?: Scope;
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
    const scope = this.resolvedScope();
    return executeAction(running, context, action, scope, this.runtimeOptions());
  }

  async play(
    project: DiscoveryProjectInput,
    context: RunContext,
    actions: Control[]
  ): Promise<ActionObservation[]> {
    const running = usableProject(project);
    if (!running) {
      return [
        {
          status: "refused",
          observations: [],
          evidence: [],
          candidates: [],
          gaps: [refusedGap()],
          cross_actor: { executed: false, display_value: CROSS_ACTOR_UNEXECUTED }
        }
      ];
    }
    const scope = this.resolvedScope();
    return playActions(running, context, actions, scope, this.runtimeOptions());
  }

  private resolvedScope(): Scope {
    return (
      this.lastScope ??
      this.options.scope ?? {
        id: this.options.runId ?? "scope-discovery",
        include_hints: [],
        exclude_hints: []
      }
    );
  }

  private runtimeOptions(): RuntimeOptions {
    return {
      runId: this.options.runId,
      runRoot: this.options.runRoot,
      snapshotId: this.options.snapshotId,
      workspacePath: this.workspacePath ?? this.options.analysisRoot ?? this.options.workspacePath,
      analysisRoot: this.options.analysisRoot ?? this.workspacePath,
      sessionRefs: this.options.sessionRefs
    };
  }
}
