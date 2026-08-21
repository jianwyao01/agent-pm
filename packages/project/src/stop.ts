import { existsSync } from "node:fs";
import { readJson, type RunningProject, type StopResult } from "@behavior-map/contracts";
import { isProcessAlive, stopProcess } from "./processes.js";

function loadRecorded(project: RunningProject): RunningProject {
  if (project.pid_ref && existsSync(project.pid_ref) && !project.pid_ref.startsWith("proc:")) {
    try {
      return readJson<RunningProject>(project.pid_ref);
    } catch {
      return project;
    }
  }
  return project;
}

/**
 * 只拆除本工具写入 running-project.json 的组件进程。
 */
export async function stopProject(project: RunningProject): Promise<StopResult> {
  const recorded = loadRecorded(project);
  const ours = (recorded.components ?? []).filter(
    (component) => component.started_by === "project-adapter" && component.pid
  );
  await Promise.all(ours.map((component) => stopProcess(component.pid)));
  const leftover = ours.filter((component) => isProcessAlive(component.pid));
  if (leftover.length > 0) {
    await Promise.all(leftover.map((component) => stopProcess(component.pid, 500)));
  }
  return { status: "stopped" };
}
