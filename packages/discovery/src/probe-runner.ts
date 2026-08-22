import {
  probePlanActions,
  type ActionObservation,
  type Control,
  type DiscoveryAdapter,
  type DiscoveryProjectInput,
  type ProbePlan,
  type ProbePlanAction,
  type RunContext,
  type RunningProject,
  type Scope
} from "@behavior-map/contracts";
import { closeSession, openSession } from "./driver.js";
import { executeAction, loadProbePlan, type RuntimeOptions } from "./runtime.js";

/**
 * ProbeRunner 是 discovery 内部模块，不是第五套公共接口。
 * 一次 Probe 打开一个 SessionProvider context，按序调用 execute 内部实现，
 * 首次导航后沿用同一 page。storageState / cookies 只注入这一次。
 */
export async function playActions(
  project: RunningProject,
  context: RunContext,
  actions: Control[],
  scope: Scope,
  options: RuntimeOptions
): Promise<ActionObservation[]> {
  if (actions.length === 0) {
    return [];
  }
  const session = await openSession(context, options);
  try {
    const results: ActionObservation[] = [];
    for (const action of actions) {
      const result = await executeAction(project, context, action, scope, options, session);
      results.push(result);
      if (result.status !== "success") {
        break;
      }
    }
    return results;
  } finally {
    await closeSession(session);
  }
}

/** 把人类批准的 ProbePlan.actions（或省略时的单步默认）编成 play 输入。 */
export function controlsFromProbePlan(plan: ProbePlan, actions?: ProbePlanAction[]): Control[] {
  return (actions ?? probePlanActions(plan)).map((step) => ({
    id: step.binding_id,
    surface_id: plan.target_surface,
    name: step.binding_id,
    action: step.action,
    binding_id: step.binding_id,
    ...(step.value !== undefined ? { value: step.value } : {})
  }));
}

/**
 * 官方 ProbePlan runner：加载 probe-plan.yaml 的 actions（或单步默认），再调用 play。
 * 不是第五套接口。Probe 序列不得拆成 N 次孤立 execute()。
 */
export async function playFromProbePlan(
  adapter: Pick<DiscoveryAdapter, "play">,
  project: DiscoveryProjectInput,
  context: RunContext,
  workspacePath: string
): Promise<ActionObservation[]> {
  const plan = loadProbePlan(workspacePath);
  if (!plan) {
    throw new Error("缺少人类批准的 probe-plan.yaml");
  }
  return adapter.play(project, context, controlsFromProbePlan(plan));
}
