import type {
  ProjectAdapter,
  ProjectProfile,
  RunningProject,
  RunPlan,
  StartResult,
  StopResult,
  Workspace
} from "@behavior-map/contracts";
import { detectProject } from "./detect.js";
import { buildRunPlan } from "./plan.js";
import { startProject } from "./start.js";
import { stopProject } from "./stop.js";

export interface ProjectAdapterOptions {
  healthcheckTimeoutMs?: number;
}

/**
 * ProjectAdapter：detect + createRunPlan + 多组件 start/stop。
 */
export class DefaultProjectAdapter implements ProjectAdapter {
  constructor(private readonly options: ProjectAdapterOptions = {}) {}

  async detect(workspace: Workspace): Promise<ProjectProfile> {
    return detectProject(workspace);
  }

  async createRunPlan(workspace: Workspace, profile: ProjectProfile): Promise<RunPlan> {
    return buildRunPlan(workspace, profile);
  }

  async start(workspace: Workspace, plan: RunPlan): Promise<StartResult> {
    return startProject(workspace, plan, this.options);
  }

  async stop(project: RunningProject): Promise<StopResult> {
    return stopProject(project);
  }
}
