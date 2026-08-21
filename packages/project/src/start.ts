import { appendFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import {
  SCHEMA_VERSION,
  assertPlanConfirmed,
  ensureDir,
  isAgentProposalPath,
  readYaml,
  validateDocument,
  validateRunPlanShape,
  writeJson,
  writeText,
  type ComponentStartResult,
  type Gap,
  type RunPlan,
  type RunPlanComponent,
  type RunningComponentState,
  type RunningProject,
  type StartResult,
  type Workspace
} from "@behavior-map/contracts";
import {
  isComposeUp,
  isNoopCommand,
  isProcessAlive,
  isUnimplementedSlot,
  resolveStartOrder,
  runForegroundCommand,
  sanitizeTargetEnv,
  spawnDetached,
  stopProcess,
  waitForHealthcheck
} from "./processes.js";
import { isTargetTrusted } from "./trust.js";

const INSTALL_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTHCHECK_MS = 5_000;

function resolveRunId(plan: RunPlan): string {
  if (plan.run_id && plan.run_id.trim()) {
    return plan.run_id;
  }
  return `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/**
 * start() 只读取官方 run-plan.yaml。
 * Agent 写在 proposals/ 或 agent-scratch/ 的提案计划一律忽略。
 */
export function officialStartPlanFiles(workspace: Workspace, plan: RunPlan): string[] {
  return [
    plan.run_id ? join(workspace.path, "runs", plan.run_id, "run-plan.yaml") : undefined,
    join(workspace.path, "run-plan.yaml")
  ].filter((file): file is string => Boolean(file) && !isAgentProposalPath(file));
}

export function loadStartPlan(workspace: Workspace, plan: RunPlan): RunPlan {
  for (const file of officialStartPlanFiles(workspace, plan)) {
    if (existsSync(file) && !isAgentProposalPath(file)) {
      return readYaml<RunPlan>(file);
    }
  }
  return plan;
}

function logPath(runRoot: string, component: RunPlanComponent): string {
  return join(runRoot, "logs", `${component.id}.log`);
}

function publicLogPath(workspace: Workspace, file: string): string {
  return relative(workspace.path, file) || file;
}

function appendLine(file: string, line: string): void {
  appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`);
}

function refuseAll(
  workspace: Workspace,
  plan: RunPlan,
  runRoot: string,
  reason: string,
  message: string
): StartResult {
  ensureDir(join(runRoot, "logs"));
  const components: ComponentStartResult[] = (plan.components ?? []).map((component) => {
    const logs = logPath(runRoot, component);
    writeText(logs, `refused: ${reason}\n${message}\n`);
    return {
      id: component.id,
      role: component.role,
      status: "refused",
      healthcheck: "not_run",
      logs: publicLogPath(workspace, logs),
      reason
    };
  });
  const gaps: Gap[] = [{ reason, message }];
  for (const component of components) {
    gaps.push({ reason, message, component_id: component.id });
  }
  return { status: "failed-runtime", components, gaps };
}

function componentUrl(component: RunPlanComponent): string | undefined {
  return component.healthcheck.kind === "http" ? component.healthcheck.url : undefined;
}

function pickBaseUrl(components: RunPlanComponent[], results: ComponentStartResult[]): string {
  const app = components.find((component) => component.role === "app");
  const fromApp = app ? componentUrl(app) : undefined;
  const fromResult = results.find((item) => item.url)?.url;
  const raw = fromApp ?? fromResult ?? "http://127.0.0.1";
  return raw.replace(/\/health\/?$/, "") || raw;
}

async function teardownStarted(pids: number[]): Promise<void> {
  await Promise.all(pids.map((pid) => stopProcess(pid)));
}

function missingDependency(
  component: RunPlanComponent,
  byId: Map<string, ComponentStartResult>
): string | undefined {
  for (const dep of component.depends_on) {
    const result = byId.get(dep);
    if (!result) {
      return dep;
    }
    if (result.status !== "started" || result.healthcheck !== "passed") {
      return dep;
    }
  }
  return undefined;
}

export async function startProject(
  workspace: Workspace,
  incoming: RunPlan,
  options?: { healthcheckTimeoutMs?: number }
): Promise<StartResult> {
  const plan = loadStartPlan(workspace, incoming);
  const runId = resolveRunId(plan);
  const runRoot = join(workspace.path, "runs", runId);
  const healthTimeout = options?.healthcheckTimeoutMs ?? DEFAULT_HEALTHCHECK_MS;
  const startedPids: number[] = [];

  ensureDir(join(runRoot, "logs"));

  try {
    assertPlanConfirmed(plan);
  } catch {
    return refuseAll(
      workspace,
      plan,
      runRoot,
      "plan_not_confirmed",
      "start() reads only a human-confirmed run-plan.yaml"
    );
  }

  const shape = validateRunPlanShape(plan);
  if (!shape.ok) {
    const message = shape.issues.map((issue) => issue.message).join("; ") || "invalid run-plan";
    const reason = shape.issues.some((issue) => issue.code === "flat_start_health")
      ? "flat_start_health"
      : "invalid_run_plan";
    return refuseAll(workspace, plan, runRoot, reason, message);
  }

  const schema = validateDocument("run-plan", plan, "run-plan.yaml");
  if (!schema.ok && (plan.components?.length ?? 0) === 0) {
    return refuseAll(
      workspace,
      plan,
      runRoot,
      "invalid_run_plan",
      schema.issues.map((issue) => issue.message).join("; ")
    );
  }

  if (!isTargetTrusted(workspace, plan)) {
    return refuseAll(
      workspace,
      plan,
      runRoot,
      "refused-untrusted",
      "target is not user-confirmed trusted; install/exec of target scripts refused"
    );
  }

  const declared = plan.components ?? [];
  if (declared.length === 0) {
    return refuseAll(workspace, plan, runRoot, "invalid_run_plan", "run-plan has no components");
  }

  const { order, cycle } = resolveStartOrder(declared);
  if (cycle) {
    return refuseAll(
      workspace,
      { ...plan, components: declared },
      runRoot,
      "dependency_cycle",
      "depends_on contains a cycle"
    );
  }

  const env = sanitizeTargetEnv(process.env);
  const results = new Map<string, ComponentStartResult>();

  try {
    for (const component of order) {
      const logs = logPath(runRoot, component);
      writeText(logs, `component=${component.id} role=${component.role}\n`);

      if (isUnimplementedSlot(component.role)) {
        results.set(component.id, {
          id: component.id,
          role: component.role,
          status: "skipped",
          healthcheck: "not_run",
          logs: publicLogPath(workspace, logs),
          reason: "unimplemented_slot"
        });
        appendLine(logs, "skipped: unimplemented slot");
        continue;
      }

      const blockedBy = missingDependency(component, results);
      if (blockedBy) {
        results.set(component.id, {
          id: component.id,
          role: component.role,
          status: "skipped",
          healthcheck: "not_run",
          logs: publicLogPath(workspace, logs),
          reason: `dependency_failed:${blockedBy}`
        });
        appendLine(logs, `skipped: dependency ${blockedBy} did not start`);
        continue;
      }

      const installCommand = component.install?.command;
      if (installCommand && !isNoopCommand(installCommand)) {
        try {
          const installed = await runForegroundCommand(installCommand, {
            cwd: workspace.path,
            env,
            logPath: logs,
            timeoutMs: INSTALL_TIMEOUT_MS
          });
          if (installed.code !== 0) {
            results.set(component.id, {
              id: component.id,
              role: component.role,
              status: "failed",
              healthcheck: "not_run",
              logs: publicLogPath(workspace, logs),
              reason: "install_failed"
            });
            continue;
          }
        } catch (error) {
          appendLine(
            logs,
            `install error: ${error instanceof Error ? error.message : String(error)}`
          );
          results.set(component.id, {
            id: component.id,
            role: component.role,
            status: "failed",
            healthcheck: "not_run",
            logs: publicLogPath(workspace, logs),
            reason: "install_failed"
          });
          continue;
        }
      }

      const startCommand = component.start?.command;
      const composeAlreadyUp = Boolean(installCommand && isComposeUp(installCommand));
      let pid: number | undefined;

      if (startCommand && !isNoopCommand(startCommand)) {
        const child = spawnDetached(startCommand, {
          cwd: workspace.path,
          env: sanitizeTargetEnv(env, component.start?.env),
          logPath: logs
        });
        pid = child.pid;
        if (pid) {
          startedPids.push(pid);
        }
      } else if (!composeAlreadyUp && !startCommand) {
        results.set(component.id, {
          id: component.id,
          role: component.role,
          status: "failed",
          healthcheck: "not_run",
          logs: publicLogPath(workspace, logs),
          reason: "missing_start_command"
        });
        continue;
      }

      const healthy = await waitForHealthcheck(component.healthcheck, {
        timeoutMs: healthTimeout,
        cwd: workspace.path,
        env,
        logPath: logs
      });

      if (!healthy) {
        if (pid) {
          await stopProcess(pid);
        }
        results.set(component.id, {
          id: component.id,
          role: component.role,
          status: "failed",
          healthcheck: "failed",
          logs: publicLogPath(workspace, logs),
          url: componentUrl(component),
          pid,
          reason: "healthcheck_failed"
        });
        continue;
      }

      if (pid && !isProcessAlive(pid) && !composeAlreadyUp) {
        results.set(component.id, {
          id: component.id,
          role: component.role,
          status: "failed",
          healthcheck: "failed",
          logs: publicLogPath(workspace, logs),
          reason: "process_exited"
        });
        continue;
      }

      results.set(component.id, {
        id: component.id,
        role: component.role,
        status: "started",
        healthcheck: "passed",
        logs: publicLogPath(workspace, logs),
        url: componentUrl(component),
        pid,
        started_at: new Date().toISOString()
      });
    }
  } catch (error) {
    await teardownStarted(startedPids);
    return refuseAll(
      workspace,
      plan,
      runRoot,
      "failed-runtime",
      error instanceof Error ? error.message : String(error)
    );
  }

  const components = declared.map((component) => {
    return (
      results.get(component.id) ?? {
        id: component.id,
        role: component.role,
        status: "failed" as const,
        healthcheck: "not_run" as const,
        logs: publicLogPath(workspace, logPath(runRoot, component)),
        reason: "not_started"
      }
    );
  });

  const gaps: Gap[] = components
    .filter((component) => component.status !== "started" || component.healthcheck !== "passed")
    .map((component) => ({
      reason: component.reason ?? component.status,
      message: `component ${component.id}: ${component.reason ?? component.status}`,
      component_id: component.id
    }));

  const allGreen = components.every(
    (component) => component.status === "started" && component.healthcheck === "passed"
  );

  if (allGreen) {
    const urls: Record<string, string> = {};
    for (const component of components) {
      if (component.url) {
        urls[component.id] = component.url;
      }
    }
    const runningComponents: RunningComponentState[] = components.map((component) => ({
      id: component.id,
      role: component.role,
      status: "started",
      url: component.url,
      pid: component.pid,
      logs: component.logs,
      started_by: "project-adapter"
    }));
    const projectFile = join(runRoot, "running-project.json");
    const project: RunningProject = {
      schema_version: SCHEMA_VERSION,
      usable_for_explore: true,
      base_url: pickBaseUrl(declared, components),
      pid_ref: projectFile,
      run_id: runId,
      urls,
      components: runningComponents
    };
    writeJson(projectFile, project);
    return { status: "success", project, components, gaps: [] };
  }

  await teardownStarted(startedPids.filter((pid) => isProcessAlive(pid)));
  const anyStarted = components.some(
    (component) => component.status === "started" && component.healthcheck === "passed"
  );
  return {
    status: anyStarted ? "partial" : "failed-runtime",
    components,
    gaps
  };
}
