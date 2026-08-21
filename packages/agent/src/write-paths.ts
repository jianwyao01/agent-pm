export function isAllowedAgentWritePath(runId: string, taskId: string, relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const proposal = `runs/${runId}/proposals/${taskId}.json`;
  const scratchPrefix = `runs/${runId}/agent-scratch/`;
  return normalized === proposal || normalized === scratchPrefix || normalized.startsWith(scratchPrefix);
}

export function assertAllowedAgentWritePath(runId: string, taskId: string, relativePath: string): void {
  if (!isAllowedAgentWritePath(runId, taskId, relativePath)) {
    throw new Error(`write_paths 拒绝: ${relativePath}`);
  }
}
