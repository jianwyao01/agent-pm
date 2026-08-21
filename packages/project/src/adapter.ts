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

/**
 * M2 ProjectAdapter：detect + createRunPlan。
 * start / stop 接口存在，实现未交付（not_shipped），同 Source.archive。
 */
export class DefaultProjectAdapter implements ProjectAdapter {
  async detect(workspace: Workspace): Promise<ProjectProfile> {
    return detectProject(workspace);
  }

  async createRunPlan(workspace: Workspace, profile: ProjectProfile): Promise<RunPlan> {
    return buildRunPlan(workspace, profile);
  }

  async start(_workspace: Workspace, _plan: RunPlan): Promise<StartResult> {
    return {
      status: "not_shipped",
      message: "ProjectAdapter.start interface is present; implementation not shipped"
    };
  }

  async stop(_project: RunningProject): Promise<StopResult> {
    return {
      status: "not_shipped",
      message: "ProjectAdapter.stop interface is present; implementation not shipped"
    };
  }
}
