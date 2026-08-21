import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  validateSemantics,
  writeJson,
  writeYaml
} from "@behavior-map/contracts";
import { MockAgentRunner } from "@behavior-map/agent";
import { FAKE_JOURNEY_ID, runFakeWalk } from "./helpers/fake-walk.js";

describe("语义校验器", () => {
  it("通过完整假数据走查", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-sem-"));
    await runFakeWalk(root, new MockAgentRunner(), "run-001");
    const report = validateSemantics(root);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("evidence_ref 必须存在", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-sem-ev-"));
    await runFakeWalk(root, new MockAgentRunner(), "run-001");
    writeYaml(join(root, "model", "effects.yaml"), {
      schema_version: SCHEMA_VERSION,
      effects: [
        {
          id: "eff-broken",
          name: "坏引用",
          observation: {
            kind: "current_surface",
            observed: true,
            display_value: "x",
            evidence_refs: ["ev-does-not-exist"]
          }
        }
      ]
    });
    writeYaml(join(root, "model", "journeys.yaml"), {
      schema_version: SCHEMA_VERSION,
      journeys: [
        {
          id: FAKE_JOURNEY_ID,
          name: "x",
          status: "accepted",
          effect_ids: ["eff-broken"]
        }
      ]
    });
    const report = validateSemantics(root);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "missing_evidence_ref")).toBe(true);
  });

  it("generated/ 不得作为输入", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-sem-gen-"));
    await runFakeWalk(root, new MockAgentRunner(), "run-001");
    writeJson(join(root, "runs", "run-001", "proposals", "task-run-001.json"), {
      schema_version: SCHEMA_VERSION,
      id: "prop-bad",
      task_id: "task-run-001",
      run_id: "run-001",
      inputs: ["generated/product-map/product-map.json"],
      proposed_journeys: [],
      proposed_effects: []
    });
    const report = validateSemantics(root);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "generated_is_not_input")).toBe(true);
  });

  it("journey 的 effect 引用必须存在", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-sem-jny-"));
    await runFakeWalk(root, new MockAgentRunner(), "run-001");
    writeYaml(join(root, "model", "journeys.yaml"), {
      schema_version: SCHEMA_VERSION,
      journeys: [
        {
          id: FAKE_JOURNEY_ID,
          name: "x",
          status: "accepted",
          effect_ids: ["eff-missing"]
        }
      ]
    });
    const report = validateSemantics(root);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "missing_effect_ref")).toBe(true);
  });

  it("四份导出必须共享同一 journey_id", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-sem-exp-"));
    await runFakeWalk(root, new MockAgentRunner(), "run-001");
    writeJson(join(root, "generated", "web", "journey-ids.json"), {
      schema_version: SCHEMA_VERSION,
      kind: "web",
      journey_ids: ["jny-other"]
    });
    const report = validateSemantics(root);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "export_journey_mismatch")).toBe(true);
  });
});
