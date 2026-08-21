import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UNOBSERVED,
  projectDisplay,
  readJson,
  readJsonl,
  snapshotModelFiles,
  stableCandidateId,
  validateAnalysisTree,
  validateSemantics,
  type Candidate,
  type DiffFile,
  type ProductMap
} from "@behavior-map/contracts";
import { MockAgentRunner } from "@behavior-map/agent";
import {
  FAKE_JOURNEY_ID,
  FAKE_SNAPSHOT,
  allRunIds,
  makeAgentTask,
  runFakeWalk
} from "./helpers/fake-walk.js";

function expectTree(root: string, runId: string): void {
  const required = [
    "study.yaml",
    "probe-plan.yaml",
    `runs/${runId}/source.json`,
    `runs/${runId}/project-profile.json`,
    `runs/${runId}/run-plan.yaml`,
    `runs/${runId}/run-context.yaml`,
    `runs/${runId}/status.json`,
    `runs/${runId}/running-project.json`,
    `runs/${runId}/logs`,
    `runs/${runId}/evidence/static.jsonl`,
    `runs/${runId}/evidence/runtime.jsonl`,
    `runs/${runId}/candidates.jsonl`,
    `runs/${runId}/proposals/task-${runId}.json`,
    `runs/${runId}/agent-scratch`,
    `runs/${runId}/diff.json`,
    "model/capabilities.yaml",
    "model/journeys.yaml",
    "model/effects.yaml",
    "model/review-decisions.yaml",
    "generated/product-map/product-map.json",
    "generated/diagrams/journeys.mmd",
    "generated/web/index.html",
    "generated/tests/journeys.spec.ts"
  ];
  for (const rel of required) {
    expect(existsSync(join(root, rel)), rel).toBe(true);
  }
}

describe("假数据走查", () => {
  it("写入完整 analysis/ 树并通过结构与语义校验", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-walk-"));
    const result = await runFakeWalk(root, new MockAgentRunner(), "run-001");
    expectTree(root, "run-001");
    expect(validateAnalysisTree(root).ok).toBe(true);
    expect(validateSemantics(root).ok).toBe(true);

    const source = readJson<{ snapshot: string; kind: string }>(join(root, "runs/run-001/source.json"));
    expect(source.snapshot).toBe(FAKE_SNAPSHOT);
    expect(source).not.toHaveProperty("scope");
    expect(JSON.stringify(source)).not.toMatch(/github\.com|rocketchat/i);

    const candidates = readJsonl<Candidate>(join(root, "runs/run-001/candidates.jsonl"));
    expect(candidates).toHaveLength(13);
    expect(new Set(candidates.map((row) => row.kind))).toEqual(
      new Set(["entry", "surface", "control", "interaction", "effect"])
    );
    expect(candidates.every((row) => row.execution_status !== ("out_of_scope" as string))).toBe(true);

    const display = projectDisplay(result.model.journeys, result.model.effects);
    expect(display.columns).toEqual(["本面", "他面", "列表", "未读", "通知", "后台"]);
    const row = display.rows[0];
    expect(row.cells.find((cell) => cell.column === "本面")?.observed).toBe(true);
    expect(row.cells.find((cell) => cell.column === "他面")?.observed).toBe(true);
    expect(row.cells.find((cell) => cell.column === "后台")?.observed).toBe(true);
    expect(row.cells.find((cell) => cell.column === "未读")?.value).toBe(UNOBSERVED);
    expect(row.cells.find((cell) => cell.column === "通知")?.value).toBe(UNOBSERVED);

    const map = readJson<ProductMap>(join(root, "generated/product-map/product-map.json"));
    expect(map.display.columns).toContain("他面");
    expect(map.journey_ids).toEqual([FAKE_JOURNEY_ID]);

    const spec = readFileSync(join(root, "generated/tests/journeys.spec.ts"), "utf8");
    expect(spec).toContain(`Journey ID: ${FAKE_JOURNEY_ID}`);
    expect(spec).toMatch(/test\.skip|TODO/);
    expect(spec).not.toMatch(/passed|已通过/);
    expect(spec).toContain("import { test } from '@playwright/test'");
  });

  it("同一 snapshot 的 candidate_id 稳定，且不静默截断", async () => {
    const a = mkdtempSync(join(tmpdir(), "bm-id-a-"));
    const b = mkdtempSync(join(tmpdir(), "bm-id-b-"));
    await runFakeWalk(a, new MockAgentRunner(), "run-001");
    await runFakeWalk(b, new MockAgentRunner(), "run-001");
    const left = readJsonl<Candidate>(join(a, "runs/run-001/candidates.jsonl"));
    const right = readJsonl<Candidate>(join(b, "runs/run-001/candidates.jsonl"));
    expect(left.map((row) => row.id)).toEqual(right.map((row) => row.id));
    expect(left[0].id).toBe(stableCandidateId(FAKE_SNAPSHOT, left[0].discovery_key));
    expect(left).toHaveLength(DISCOVERY_COUNT);
  });

  it("二次走查写入新 run，model 的 keep/reject/rename 存活", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-rerun-"));
    const first = await runFakeWalk(root, new MockAgentRunner(), "run-001");
    const modelAfterFirst = snapshotModelFiles(root);
    const second = await runFakeWalk(root, new MockAgentRunner(), "run-002");
    expect(allRunIds(root)).toEqual(["run-001", "run-002"]);
    expect(existsSync(join(root, "runs/run-002/candidates.jsonl"))).toBe(true);
    expect(second.model.journeys[0].id).toBe(FAKE_JOURNEY_ID);
    expect(second.model.journeys[0].name).toBe("发送一条消息（已审定）");
    expect(second.model.decisions.some((d) => d.review_status === "rejected")).toBe(true);
    expect(second.model.decisions.some((d) => d.rename)).toBe(true);
    expect(snapshotModelFiles(root)).toEqual(modelAfterFirst);
    expect(first.modelSnapshot).toEqual(modelAfterFirst);

    const diff = readJson<DiffFile>(join(root, "runs/run-002/diff.json"));
    expect(diff.baseline_run_id).toBe("run-001");
    expect(diff.current_run_id).toBe("run-002");
    expect(diff.comparison_mode).toBe("same_snapshot");
  });

  it("覆盖 proposals 不会改写 model", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-clobber-"));
    await runFakeWalk(root, new MockAgentRunner(), "run-001");
    const before = snapshotModelFiles(root);
    await new MockAgentRunner().run(makeAgentTask(root, "run-001", "task-run-001"));
    expect(snapshotModelFiles(root)).toEqual(before);
    expect(readdirSync(join(root, "runs/run-001/proposals"))).toContain("task-run-001.json");
  });

  it("snapshot 变化时 diff 使用 changed_snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-changed-"));
    await runFakeWalk(root, new MockAgentRunner(), "run-001", FAKE_SNAPSHOT);
    await runFakeWalk(root, new MockAgentRunner(), "run-002", "snap-m0-002");
    const diff = readJson<DiffFile>(join(root, "runs/run-002/diff.json"));
    expect(diff.comparison_mode).toBe("changed_snapshot");
    expect(diff.baseline_run_id).toBe("run-001");
    const journeys = snapshotModelFiles(root);
    expect(journeys["journeys.yaml"]).toContain(FAKE_JOURNEY_ID);
  });
});

const DISCOVERY_COUNT = 13;
