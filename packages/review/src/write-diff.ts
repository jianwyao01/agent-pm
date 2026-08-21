import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  findPreviousCompletedRun,
  loadReviewedModel,
  readJson,
  writeJson,
  type ComparisonMode,
  type DiffBaselineSource,
  type DiffFile,
  type SourceRecord,
  type StatusFile
} from "@behavior-map/contracts";
import { loadRunProposals } from "./apply-review.js";
import { ensureCompletedRunMetadata, markRunCompleted } from "./run-metadata.js";

export interface WriteRunDiffOptions {
  analysisRoot: string;
  runId: string;
  /**
   * 其它基线只能通过此显式参数指定。
   * 省略时永远使用同一 study + scope 的上一完成 run。
   */
  baselineRunId?: string;
}

export function resolveBaselineRunId(options: WriteRunDiffOptions): {
  baselineRunId: string;
  source: DiffBaselineSource;
} {
  const meta = ensureCompletedRunMetadata(options.analysisRoot, options.runId);
  const previous = findPreviousCompletedRun(
    options.analysisRoot,
    meta.studyId,
    meta.scopeId,
    options.runId
  );
  if (options.baselineRunId !== undefined) {
    if (!options.baselineRunId.trim()) {
      throw new Error("显式 --baseline 不能为空");
    }
    if (!existsSync(join(options.analysisRoot, "runs", options.baselineRunId, "status.json"))) {
      throw new Error(`显式基线 run 不存在: ${options.baselineRunId}`);
    }
    return { baselineRunId: options.baselineRunId, source: "explicit" };
  }
  if (!previous) {
    return { baselineRunId: options.runId, source: "self" };
  }
  return { baselineRunId: previous, source: "previous_completed" };
}

export function writeRunDiff(options: WriteRunDiffOptions): DiffFile {
  const meta = ensureCompletedRunMetadata(options.analysisRoot, options.runId);
  const resolved = resolveBaselineRunId(options);
  const comparison_mode = comparisonMode(
    options.analysisRoot,
    resolved.baselineRunId,
    options.runId,
    meta.snapshot
  );
  const model = loadReviewedModel(options.analysisRoot);
  const proposals = loadRunProposals(options.analysisRoot, options.runId);
  const diff: DiffFile = {
    schema_version: SCHEMA_VERSION,
    baseline_run_id: resolved.baselineRunId,
    current_run_id: options.runId,
    comparison_mode,
    study_id: meta.studyId,
    scope_id: meta.scopeId,
    baseline_source: resolved.source,
    new_proposals: proposals.map((proposal) => ({
      task_id: proposal.task_id,
      proposal_id: proposal.id,
      kind: proposal.kind,
      proposed_journey_names: proposal.proposed_journeys.map((item) => item.name),
      proposed_effect_names: proposal.proposed_effects.map((item) => item.name)
    })),
    missing_support: model.journeys.flatMap((journey) => {
      if (journey.status !== "stale" && journey.status !== "not_observed") {
        return [];
      }
      return [{ journey_id: journey.id, status: journey.status }];
    })
  };
  writeJson(join(options.analysisRoot, "runs", options.runId, "diff.json"), diff);
  markRunCompleted(options.analysisRoot, options.runId);
  return diff;
}

function comparisonMode(
  analysisRoot: string,
  baselineRunId: string,
  currentRunId: string,
  currentSnapshot: string
): ComparisonMode {
  const baselineSource = join(analysisRoot, "runs", baselineRunId, "source.json");
  if (!existsSync(baselineSource) || baselineRunId === currentRunId) {
    return "same_snapshot";
  }
  const prev = readJson<SourceRecord>(baselineSource);
  return prev.snapshot === currentSnapshot ? "same_snapshot" : "changed_snapshot";
}

export function readRunStatus(analysisRoot: string, runId: string): StatusFile | undefined {
  const file = join(analysisRoot, "runs", runId, "status.json");
  return existsSync(file) ? readJson<StatusFile>(file) : undefined;
}
