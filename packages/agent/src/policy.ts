import { isGeneratedPath, type AgentTask, type AgentTaskKind, AGENT_TASK_KINDS } from "@behavior-map/contracts";

const TASK_KIND_SET = new Set<string>(AGENT_TASK_KINDS);

export function assertAgentTrustPolicy(task: AgentTask, options?: { requireKind?: boolean }): void {
  const { policy } = task;
  if (policy.inherit_host_credentials !== false) {
    throw new Error("inherit_host_credentials 必须为 false");
  }
  if (policy.load_project_agent_config !== false) {
    throw new Error("load_project_agent_config 必须为 false");
  }
  if (policy.workspace !== "read_only") {
    throw new Error("workspace 必须为 read_only");
  }
  if (policy.network !== "denied_or_explicit") {
    throw new Error("network 必须为 denied_or_explicit");
  }
  if (!Number.isFinite(task.timeout_ms) || task.timeout_ms <= 0) {
    throw new Error("timeout_ms 必须为正数");
  }
  if (options?.requireKind) {
    if (!task.kind) {
      throw new Error("真实 Agent 必须声明 task kind");
    }
    if (!TASK_KIND_SET.has(task.kind)) {
      throw new Error(`不支持的 task kind: ${task.kind}`);
    }
  } else if (task.kind && !TASK_KIND_SET.has(task.kind)) {
    throw new Error(`不支持的 task kind: ${task.kind}`);
  }
}

export function assertApprovedReads(task: AgentTask): void {
  if (task.approved_read_paths.length === 0) {
    throw new Error("必须声明 approved_read_paths");
  }
  for (const rel of task.approved_read_paths) {
    if (isGeneratedPath(rel)) {
      throw new Error(`generated/ 不得作为输入: ${rel}`);
    }
    if (rel.includes("..")) {
      throw new Error(`禁止读取越界路径: ${rel}`);
    }
  }
}

export function isApprovedRead(task: AgentTask, relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return task.approved_read_paths.some((item) => item.replaceAll("\\", "/") === normalized);
}

export function requireApprovedRead(task: AgentTask, relativePath: string): void {
  if (!isApprovedRead(task, relativePath)) {
    throw new Error(`未批准读取 ${relativePath}`);
  }
}

export function isKnownTaskKind(value: string): value is AgentTaskKind {
  return TASK_KIND_SET.has(value);
}
