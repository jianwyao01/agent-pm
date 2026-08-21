import type { RunPlan } from "./types.js";

export interface RunPlanIssue {
  code: string;
  message: string;
  path?: string;
}

export interface RunPlanReport {
  ok: boolean;
  issues: RunPlanIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSingleHealthValue(value: unknown): boolean {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    return true;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return keys.length === 1 && (keys[0] === "url" || keys[0] === "health_url") && typeof value[keys[0]] === "string";
  }
  return false;
}

function isSparseStartHealthComponent(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const allowed = new Set(["id", "start", "command", "start_command", "health", "health_url", "healthcheck"]);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    return false;
  }
  const start = value.start ?? value.command ?? value.start_command;
  const health = value.health ?? value.health_url ?? value.healthcheck;
  return typeof start === "string" && isSingleHealthValue(health);
}

/**
 * 拒绝「一条启动命令 + 一个健康检查 URL」的扁平 run-plan。
 * Healthcheck 不得作为独立组件。
 */
export function validateRunPlanShape(data: unknown): RunPlanReport {
  const issues: RunPlanIssue[] = [];
  if (!isRecord(data)) {
    issues.push({ code: "invalid_run_plan", message: "run-plan 必须是对象" });
    return { ok: false, issues };
  }

  const startCmd = data.start ?? data.command ?? data.start_command;
  const flatHealth = data.health ?? data.health_url ?? data.healthcheck;
  const components = data.components;
  const hasStructuredComponents = Array.isArray(components) && components.length > 0;

  if (typeof startCmd === "string" && isSingleHealthValue(flatHealth) && !hasStructuredComponents) {
    issues.push({
      code: "flat_start_health",
      message: "仅含一条启动命令与一个健康检查 URL 的 run-plan 无效"
    });
  }

  if (!hasStructuredComponents && issues.every((issue) => issue.code !== "flat_start_health")) {
    if (typeof startCmd === "string" && (typeof flatHealth === "string" || isRecord(flatHealth))) {
      issues.push({
        code: "flat_start_health",
        message: "仅含一条启动命令与一个健康检查 URL 的 run-plan 无效"
      });
    }
  }

  if (Array.isArray(components)) {
    if (components.length === 1 && isSparseStartHealthComponent(components[0])) {
      issues.push({
        code: "flat_start_health",
        message: "仅含一条启动命令与一个健康检查 URL 的 run-plan 无效",
        path: "components[0]"
      });
    }
    for (const [index, component] of components.entries()) {
      if (!isRecord(component)) {
        issues.push({
          code: "invalid_component",
          message: "component 必须是对象",
          path: `components[${index}]`
        });
        continue;
      }
      if (component.role === "healthcheck") {
        issues.push({
          code: "healthcheck_not_component",
          message: "Healthcheck 不是独立组件",
          path: `components[${index}]`
        });
      }
      if (!isRecord(component.healthcheck)) {
        issues.push({
          code: "missing_component_healthcheck",
          message: "每个组件必须有自己的 healthcheck",
          path: `components[${index}]`
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * start() 只接受 confirmed 的 run-plan.yaml。
 * draft 必须被拒绝，不得启动进程。
 */
export function assertPlanConfirmed(plan: RunPlan): void {
  if (plan.confirmation?.status !== "confirmed") {
    throw new Error("run-plan confirmation is draft; start() reads only confirmed run-plan.yaml");
  }
}
