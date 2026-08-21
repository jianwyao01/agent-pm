import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  ensureDir,
  readJson,
  readYaml,
  writeJson,
  writeText,
  writeYaml,
  type RunContext,
  type SourceRecord,
  type StatusFile,
  type Study
} from "@behavior-map/contracts";

export const FIRST_DELIVERY_SCOPE_ID = "scope-message-sync";

/**
 * 为审定 / diff 补齐 run 元数据。已有文件不覆盖；不改 model/。
 */
export function ensureCompletedRunMetadata(
  analysisRoot: string,
  runId: string,
  extras?: { snapshot?: string; scopeId?: string; completed?: boolean }
): { studyId: string; scopeId: string; snapshot: string } {
  const runDir = join(analysisRoot, "runs", runId);
  ensureDir(runDir);
  const study = existsSync(join(analysisRoot, "study.yaml"))
    ? readYaml<Study>(join(analysisRoot, "study.yaml"))
    : undefined;
  const studyId = study?.id ?? "study-unknown";
  const scopeId = extras?.scopeId ?? inferScopeId(analysisRoot, runId) ?? FIRST_DELIVERY_SCOPE_ID;

  const statusFile = join(runDir, "status.json");
  if (!existsSync(statusFile)) {
    const status: StatusFile = {
      schema_version: SCHEMA_VERSION,
      phase: extras?.completed ? "completed" : "analysis",
      start_status: "success",
      completed: extras?.completed ?? false,
      study_id: studyId,
      scope_id: scopeId
    };
    writeJson(statusFile, status);
  }

  const snapshot = extras?.snapshot ?? existingSnapshot(analysisRoot, runId) ?? `digest-${runId}`;
  const sourceFile = join(runDir, "source.json");
  if (!existsSync(sourceFile)) {
    const source: SourceRecord = {
      schema_version: SCHEMA_VERSION,
      kind: "local",
      locator: analysisRoot,
      revision: snapshot,
      snapshot
    };
    writeJson(sourceFile, source);
  }

  const profileFile = join(runDir, "project-profile.json");
  if (!existsSync(profileFile)) {
    writeJson(profileFile, {
      schema_version: SCHEMA_VERSION,
      faces: [],
      parts: [{ id: "app", role: "app", clues: [] }],
      frameworks: [],
      how_to_run: []
    });
  }

  const contextFile = join(runDir, "run-context.yaml");
  if (!existsSync(contextFile)) {
    const rootContext = join(analysisRoot, "run-context.yaml");
    const context: RunContext = existsSync(rootContext)
      ? readYaml<RunContext>(rootContext)
      : {
          schema_version: SCHEMA_VERSION,
          role: "member",
          locale: "zh-CN",
          flags: [],
          credential_ref: "secret:study-member",
          cookie_ref: "secret:session-cookie",
          entry_url: "http://127.0.0.1/compose"
        };
    writeYaml(contextFile, context);
  }

  const runningFile = join(runDir, "running-project.json");
  if (!existsSync(runningFile)) {
    writeJson(runningFile, {
      schema_version: SCHEMA_VERSION,
      usable_for_explore: true,
      base_url: "http://127.0.0.1",
      pid_ref: "proc:fixture"
    });
  }

  ensureDir(join(runDir, "logs"));
  const logFile = join(runDir, "logs", "review.log");
  if (!existsSync(logFile)) {
    writeText(logFile, `review metadata for ${runId}\n`);
  }

  return { studyId, scopeId, snapshot };
}

export function markRunCompleted(analysisRoot: string, runId: string): void {
  const statusFile = join(analysisRoot, "runs", runId, "status.json");
  const meta = ensureCompletedRunMetadata(analysisRoot, runId);
  const current = existsSync(statusFile)
    ? readJson<StatusFile>(statusFile)
    : {
        schema_version: SCHEMA_VERSION,
        phase: "analysis",
        start_status: "success" as const,
        completed: false,
        study_id: meta.studyId,
        scope_id: meta.scopeId
      };
  writeJson(statusFile, {
    ...current,
    phase: "completed",
    completed: true
  });
}

function inferScopeId(analysisRoot: string, runId: string): string | undefined {
  const statusFile = join(analysisRoot, "runs", runId, "status.json");
  if (existsSync(statusFile)) {
    return readJson<StatusFile>(statusFile).scope_id;
  }
  return undefined;
}

function existingSnapshot(analysisRoot: string, runId: string): string | undefined {
  const sourceFile = join(analysisRoot, "runs", runId, "source.json");
  if (existsSync(sourceFile)) {
    return readJson<SourceRecord>(sourceFile).snapshot;
  }
  return undefined;
}
