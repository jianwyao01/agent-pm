import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  SCHEMA_VERSION,
  snapshotModelFiles,
  validateDocument,
  validateSemantics,
  writeYaml
} from "@behavior-map/contracts";
import { MockAgentRunner, isAllowedAgentWritePath } from "@behavior-map/agent";
import type { AgentRunner } from "@behavior-map/contracts";
import { makeAgentTask, runFakeWalk, writeRunArtifacts, writeStudyAndProbe } from "./helpers/fake-walk.js";

describe("MockAgentRunner 合约", () => {
  it("策略常量符合依赖倒置合约", () => {
    const runner = new MockAgentRunner();
    expect(runner.inherit_host_credentials).toBe(false);
    expect(runner.load_project_agent_config).toBe(false);
    expect(runner.workspace).toBe("read_only");
    expect(runner.network).toBe("denied_or_explicit");
    expect(DEFAULT_AGENT_POLICY).toEqual({
      inherit_host_credentials: false,
      load_project_agent_config: false,
      workspace: "read_only",
      network: "denied_or_explicit"
    });
  });

  it("write_paths 只允许 proposals 与 agent-scratch", () => {
    expect(isAllowedAgentWritePath("run-1", "t1", "runs/run-1/proposals/t1.json")).toBe(true);
    expect(isAllowedAgentWritePath("run-1", "t1", "runs/run-1/agent-scratch/note.txt")).toBe(true);
    expect(isAllowedAgentWritePath("run-1", "t1", "model/journeys.yaml")).toBe(false);
    expect(isAllowedAgentWritePath("run-1", "t1", "generated/web/index.html")).toBe(false);
  });

  it("成功时只读批准文件，产物通过 schema 与语义校验", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-agent-ok-"));
    const first = await runFakeWalk(root, new MockAgentRunner(), "run-001");
    expect(["success", "partial"]).toContain(first.agentStatus);
    const proposal = join(root, "runs", "run-001", "proposals", "task-run-001.json");
    expect(existsSync(proposal)).toBe(true);
    const semantic = validateSemantics(root);
    expect(semantic.ok).toBe(true);
  });

  it("只读取 approved_read_paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-agent-read-"));
    writeStudyAndProbe(root);
    writeRunArtifacts(root, "run-001");
    const runner = new MockAgentRunner();
    const task = makeAgentTask(root, "run-001", "task-denied");
    task.approved_read_paths = ["study.yaml"];
    const result = await runner.run(task);
    expect(result.status).toBe("failed");
    expect(result.errors?.join(" ")).toMatch(/未批准读取/);
  });

  it("拒绝把 generated/ 当作输入", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-agent-gen-"));
    writeStudyAndProbe(root);
    writeRunArtifacts(root, "run-001");
    const task = makeAgentTask(root, "run-001", "task-gen");
    task.approved_read_paths = [...task.approved_read_paths, "generated/web/index.html"];
    const result = await new MockAgentRunner().run(task);
    expect(result.status).toBe("failed");
    expect(result.errors?.join(" ")).toMatch(/generated/);
  });

  it("失败时不修改 model/", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-agent-fail-"));
    await runFakeWalk(root, new MockAgentRunner(), "run-001");
    const before = snapshotModelFiles(root);
    const result = await new MockAgentRunner().run(makeAgentTask(root, "run-001", "force-fail"));
    expect(result.status).toBe("failed");
    expect(snapshotModelFiles(root)).toEqual(before);
  });

  it("AgentRunner 以接口注入，走查不依赖 Mock 类名", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-agent-di-"));
    writeStudyAndProbe(root);
    writeRunArtifacts(root, "run-001");
    writeYaml(join(root, "model", "journeys.yaml"), {
      schema_version: SCHEMA_VERSION,
      journeys: []
    });
    const before = snapshotModelFiles(root);
    const runner: AgentRunner = new MockAgentRunner();
    const result = await runner.run(makeAgentTask(root, "run-001", "task-di"));
    expect(result.status).toBe("success");
    const proposal = JSON.parse(
      await import("node:fs").then((fs) =>
        fs.readFileSync(join(root, "runs", "run-001", "proposals", "task-di.json"), "utf8")
      )
    );
    expect(validateDocument("proposal", proposal).ok).toBe(true);
    expect(snapshotModelFiles(root)).toEqual(before);
  });
});
