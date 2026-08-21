import { createHash, randomUUID } from "node:crypto";

/** evidence_id 一旦写入即不可变；新证据只追加新 id。 */
export function newEvidenceId(prefix = "ev"): string {
  return `${prefix}-${randomUUID()}`;
}

/** 同一 snapshot + 同一 discovery_key 必须得到同一 candidate_id。 */
export function stableCandidateId(snapshot: string, discoveryKey: string): string {
  const digest = createHash("sha256")
    .update(`${snapshot}::${discoveryKey}`)
    .digest("hex")
    .slice(0, 16);
  return `cand-${digest}`;
}

/** proposal_id 按 agent task 分配。 */
export function proposalIdForTask(taskId: string): string {
  return `prop-${taskId}`;
}

/**
 * journey_id 仅在人工接受时分配，之后稳定。
 * 重命名只改 name，不改 id。
 */
export function assignJourneyId(slug: string): string {
  return `jny-${slug}`;
}
