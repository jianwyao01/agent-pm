import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getSchema,
  listFileKinds,
  validateAnalysisTree,
  validateDocument
} from "@behavior-map/contracts";
import { MockAgentRunner } from "@behavior-map/agent";
import { runFakeWalk } from "./helpers/fake-walk.js";

describe("JSON Schema 结构校验", () => {
  it("为每一种分析文件提供 schema", () => {
    const kinds = listFileKinds();
    expect(kinds).toContain("study");
    expect(kinds).toContain("candidate");
    expect(kinds).toContain("proposal");
    expect(kinds).toContain("diff");
    for (const kind of kinds) {
      const schema = getSchema(kind) as { required?: string[] };
      expect(schema.required).toContain("schema_version");
    }
  });

  it("source.json 拒绝 scope 与 host-specific kind", () => {
    const base = {
      schema_version: "0.1.0",
      kind: "git",
      locator: "https://example.test/sample.git",
      revision: "abc",
      snapshot: "abc"
    };
    expect(validateDocument("source", base).ok).toBe(true);
    expect(validateDocument("source", { ...base, scope: "inbox" }).ok).toBe(false);
    expect(validateDocument("source", { ...base, kind: "github" }).ok).toBe(false);
    expect(validateDocument("source", { ...base, kind: "fixture" }).ok).toBe(false);
  });

  it("拒绝缺少 schema_version 的文档", () => {
    const report = validateDocument("study", {
      id: "x",
      name: "n",
      goal: "g",
      entry_seeds: [],
      include_hints: [],
      exclude_hints: [],
      exploration_mode: "approved_probe"
    });
    expect(report.ok).toBe(false);
  });

  it("candidate.execution_status 不得为 out_of_scope", () => {
    const report = validateDocument("candidate", {
      schema_version: "0.1.0",
      id: "cand-1",
      kind: "surface",
      scope_id: "s",
      discovered_by: "scan",
      evidence_refs: ["ev-1"],
      execution_status: "out_of_scope",
      scope_status: "in_scope",
      review_status: "unreviewed",
      rejection_reason: null,
      discovery_key: "surface:x",
      label: "x"
    });
    expect(report.ok).toBe(false);
  });

  it("run-plan 只允许 secret_ref，拒绝明文 password", () => {
    const report = validateDocument("run-plan", {
      schema_version: "0.1.0",
      run_id: "r1",
      study_id: "s",
      scope_id: "sc",
      secret_refs: [{ secret_ref: "env:X" }],
      steps: [],
      password: "hunter2"
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes("明文"))).toBe(true);
  });

  it("假数据走查产物通过全树结构校验", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-schema-"));
    await runFakeWalk(root, new MockAgentRunner(), "run-001");
    const report = validateAnalysisTree(root);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
