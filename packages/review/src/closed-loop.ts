import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  scopeFromStudy,
  type ActionObservation,
  type DiscoveryProjectInput,
  type ReviewedModel,
  type RunContext,
  type Scope,
  type Workspace
} from "@behavior-map/contracts";
import {
  DefaultDiscoveryAdapter,
  loadStudy,
  playFromProbePlan
} from "@behavior-map/discovery";
import { generateAll } from "@behavior-map/export";
import { applyHumanReview, type HumanReviewSpec } from "./apply-review.js";
import { FIRST_DELIVERY_SCOPE_ID } from "./run-metadata.js";

/**
 * 官方 study runner。是函数，不是第五套公共接口。
 * 顺序固定：scan（可跳过）→ playFromProbePlan → applyHumanReview → generateAll。
 * 不得调用 ProjectAdapter.start，不得用 explore() 做产品动作，
 * 不得发明 bindings，不得把 proposals/ 当 bindings，不得把 Probe 拆成 N 次孤立 execute()。
 */
export interface RunClosedLoopOptions {
  analysisRoot: string;
  runId: string;
  project: DiscoveryProjectInput;
  context: RunContext;
  reviewSpec?: HumanReviewSpec;
  /** SessionProvider 引用；storageState 文件必须在 analysis/ 之外。 */
  sessionRefs?: Record<string, string>;
  scope?: Scope;
}

export interface RunClosedLoopResult {
  played: ActionObservation[];
  model: ReviewedModel;
  generatedPaths: string[];
}

export async function runClosedLoop(options: RunClosedLoopOptions): Promise<RunClosedLoopResult> {
  const { analysisRoot, runId, project, context } = options;
  const workspace = workspaceAt(analysisRoot);
  const scope = options.scope ?? scopeForStudy(analysisRoot);
  const discovery = new DefaultDiscoveryAdapter({
    runId,
    analysisRoot,
    sessionRefs: options.sessionRefs,
    scope
  });

  if (!hasStaticScan(analysisRoot, runId)) {
    await discovery.scan(workspace, scope);
  }

  const played = await playFromProbePlan(discovery, project, context, analysisRoot);
  const model = applyHumanReview({
    analysisRoot,
    runId,
    spec: options.reviewSpec
  });
  const generatedPaths = generateAll(model, analysisRoot);
  return { played, model, generatedPaths };
}

function hasStaticScan(analysisRoot: string, runId: string): boolean {
  const runRoot = join(analysisRoot, "runs", runId);
  return (
    existsSync(join(runRoot, "evidence", "static.jsonl")) && existsSync(join(runRoot, "candidates.jsonl"))
  );
}

function scopeForStudy(analysisRoot: string): Scope {
  const study = loadStudy(analysisRoot);
  if (!study) {
    return { id: FIRST_DELIVERY_SCOPE_ID, include_hints: [], exclude_hints: [] };
  }
  return scopeFromStudy(study, FIRST_DELIVERY_SCOPE_ID);
}

function workspaceAt(path: string): Workspace {
  return { path, read_only: false };
}
