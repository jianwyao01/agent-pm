import { DefaultAgentRunner } from "@behavior-map/agent";
import { snapshotDigestFor } from "@behavior-map/discovery";
import {
  applyHumanReview,
  ensureCompletedRunMetadata,
  type HumanReviewSpec
} from "@behavior-map/review";
import { makeAgentTask } from "./fake-walk.js";
import { writeM4AnalysisArtifacts } from "./m4-artifacts.js";

export const M6_KINDS = [
  "classify_features",
  "build_journeys",
  "analyze_effects",
  "prune_candidates"
] as const;

export const FIRST_DELIVERY_REVIEW: HumanReviewSpec = {
  keep: [
    {
      proposed_name: "发送一条消息",
      rename: "发送一条消息（已审定）",
      journey_id: "jny-send-001"
    }
  ],
  reject: [
    { proposed_name: "管理后台", rejection_reason: "不在本次探测范围内" },
    { proposed_name: "话题串", rejection_reason: "不在本次探测范围内" },
    { proposed_name: "创建容器", rejection_reason: "不在本次探测范围内" }
  ],
  addJourney: {
    name: "人工补录的同步确认",
    control_id: "control-send"
  }
};

export async function prepareM5Run(
  analysisRoot: string,
  runId: string
): Promise<{ snapshot: string }> {
  await writeM4AnalysisArtifacts(analysisRoot, runId);
  const snapshot = snapshotDigestFor(analysisRoot);
  ensureCompletedRunMetadata(analysisRoot, runId, {
    snapshot,
    scopeId: "scope-message-sync"
  });
  const runner = new DefaultAgentRunner();
  for (const kind of M6_KINDS) {
    const result = await runner.run(makeAgentTask(analysisRoot, runId, kind, { kind }));
    if (result.status === "failed") {
      throw new Error(result.errors?.join("; ") ?? `agent ${kind} failed`);
    }
  }
  return { snapshot };
}

export function applyFirstDeliveryReview(analysisRoot: string, runId: string) {
  return applyHumanReview({
    analysisRoot,
    runId,
    spec: FIRST_DELIVERY_REVIEW
  });
}
