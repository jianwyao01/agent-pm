import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, readYaml, type RunPlan, type Workspace } from "@behavior-map/contracts";

export interface TrustRecord {
  schema_version?: string;
  status?: "trusted" | "untrusted";
  trusted?: boolean;
  confirmed_by_user?: boolean;
  confirmed_at?: string;
}

const TRUST_FLAGS = new Set(["trusted", "user_confirmed_trusted"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isTrustedRecord(data: unknown): boolean {
  if (!isRecord(data)) {
    return false;
  }
  const trusted = data.status === "trusted" || data.trusted === true;
  return trusted && data.confirmed_by_user === true;
}

function loadStructured(file: string): unknown {
  if (!existsSync(file)) {
    return undefined;
  }
  if (file.endsWith(".json")) {
    return readJson(file);
  }
  return readYaml(file);
}

function runContextTrusted(data: unknown): boolean {
  if (!isRecord(data) || !Array.isArray(data.flags)) {
    return false;
  }
  return data.flags.some((flag) => typeof flag === "string" && TRUST_FLAGS.has(flag));
}

/**
 * phase-1 信任门：必须有用户确认的 trust 记录，或 run-context flags 标明已信任。
 * 默认不信任，不得据此声称可安全执行任意远程仓库。
 */
export function isTargetTrusted(workspace: Workspace, plan: RunPlan): boolean {
  const runDir = plan.run_id ? join(workspace.path, "runs", plan.run_id) : undefined;
  const files = [
    join(workspace.path, "trust.yaml"),
    join(workspace.path, "trust.json"),
    join(workspace.path, ".behavior-map", "trust.yaml"),
    runDir ? join(runDir, "trust.yaml") : undefined,
    runDir ? join(runDir, "trust.json") : undefined
  ].filter((file): file is string => Boolean(file));

  for (const file of files) {
    if (isTrustedRecord(loadStructured(file))) {
      return true;
    }
  }

  const contextFiles = [
    join(workspace.path, "run-context.yaml"),
    runDir ? join(runDir, "run-context.yaml") : undefined
  ].filter((file): file is string => Boolean(file));

  for (const file of contextFiles) {
    if (runContextTrusted(loadStructured(file))) {
      return true;
    }
  }

  return false;
}
