import type {
  ActionObservation,
  Control,
  RunContext,
  RunningProject,
  Scope
} from "@behavior-map/contracts";
import { closeSession, openSession } from "./driver.js";
import { executeAction, type RuntimeOptions } from "./runtime.js";

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
