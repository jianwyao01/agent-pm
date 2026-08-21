import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_TASK_KINDS,
  SCHEMA_VERSION,
  assertPlanConfirmed,
  hasChineseExplanation,
  readJson,
  snapshotModelFiles,
  validateDocument,
  validateSemantics,
  writeJson,
  writeYaml,
  type AgentRunner,
  type Proposal
} from "@behavior-map/contracts";
import {
  DefaultAgentRunner,
  MockAgentRunner,
  assertAllowedAgentWritePath,
  isAllowedAgentWritePath,
  isOptionalLlmEnabled,
  type AgentAnalysisBackend
} from "@behavior-map/agent";
import { DefaultProjectAdapter, loadStartPlan, officialStartPlanFiles } from "@behavior-map/project";
import { makeAgentTask } from "./helpers/fake-walk.js";
import { writeM4AnalysisArtifacts } from "./helpers/m4-artifacts.js";
import { reservePort, tinyTwoProcessPlan, workspaceAt, writePlanFile, writeTrusted } from "./helpers/tiny-processes.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const KINDS = ["classify_features", "build_journeys", "analyze_effects", "prune_candidates"] as const;

describe("M5 DefaultAgentRunner", () => {
  it("四种任务产出通过 schema 与语义校验的提案，保留项至少三句中文说明", async () => {
    const root = tmp("bm-m5-ok-");
    const runId = "run-m5";
    await writeM4AnalysisArtifacts(root, runId);
    const runner = new DefaultAgentRunner();

    for (const kind of KINDS) {
      const result = await runner.run(makeAgentTask(root, runId, kind, { kind }));
      expect(result.status).toBe("success");
      expect(result.proposal_id).toBe(`prop-${kind}`);
      const file = join(root, "runs", runId, "proposals", `${kind}.json`);
      expect(existsSync(file)).toBe(true);
      const proposal = readJson<Proposal>(file);
      expect(validateDocument("proposal", proposal).ok).toBe(true);
      expect(proposal.kind).toBe(kind);

      const keptExplanations = [
        ...(proposal.proposed_features ?? []).map((item) => item.explanation),
        ...proposal.proposed_journeys.map((item) => item.explanation),
        ...proposal.proposed_effects.map((item) => item.explanation)
      ].filter((text): text is string => Boolean(text));
      expect(keptExplanations.length).toBeGreaterThan(0);
      for (const text of keptExplanations) {
        expect(hasChineseExplanation(text, 3)).toBe(true);
      }
    }

    const classify = readJson<Proposal>(join(root, "runs", runId, "proposals", "classify_features.json"));
    expect(classify.proposed_features?.some((item) => item.name.includes("发送"))).toBe(true);
    expect(classify.proposed_run_plan?.confirmation.status).toBe("draft");
    expect(classify.proposed_run_plan?.components[0]?.seed.status).toBe("not_done");

    const journeys = readJson<Proposal>(join(root, "runs", runId, "proposals", "build_journeys.json"));
    expect(journeys.proposed_journeys.length).toBeGreaterThan(0);

    const effects = readJson<Proposal>(join(root, "runs", runId, "proposals", "analyze_effects.json"));
    expect(effects.proposed_effects.length).toBeGreaterThan(0);
    expect(effects.proposed_effects.every((item) => (item.evidence_refs?.length ?? 0) > 0)).toBe(true);

    const pruned = readJson<Proposal>(join(root, "runs", runId, "proposals", "prune_candidates.json"));
    expect(pruned.pruned?.length).toBeGreaterThan(0);
    expect(pruned.pruned?.every((item) => item.reason.trim().length > 0)).toBe(true);

    const semantic = validateSemantics(root);
    expect(semantic.issues).toEqual([]);
    expect(semantic.ok).toBe(true);
  });

  it("伪造缺少 evidence_ref 的边会被语义校验拒绝，且不改 model/", async () => {
    const root = tmp("bm-m5-forge-");
    const runId = "run-forge";
    await writeM4AnalysisArtifacts(root, runId);
    const before = snapshotModelFiles(root);
    const result = await new DefaultAgentRunner().run(
      makeAgentTask(root, runId, "analyze_effects", { kind: "analyze_effects" })
    );
    expect(result.status).toBe("success");

    const good = readJson<Proposal>(join(root, "runs", runId, "proposals", "analyze_effects.json"));
    const forged: Proposal = {
      ...good,
      task_id: "forged-missing-evidence",
      proposed_effects: [
        {
          name: "伪造无证据边",
          candidate_id: good.proposed_effects[0]?.candidate_id ?? "missing",
          observation_kind: "current_surface",
          observed: true,
          evidence_refs: ["ev-does-not-exist"]
        }
      ]
    };
    writeJson(join(root, "runs", runId, "proposals", "forged-missing-evidence.json"), forged);
    const report = validateSemantics(root);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "missing_evidence_ref")).toBe(true);
    expect(snapshotModelFiles(root)).toEqual(before);
  });

  it("write_paths 拒绝写到 proposals/agent-scratch 之外", async () => {
    expect(isAllowedAgentWritePath("run-1", "t1", "runs/run-1/proposals/t1.json")).toBe(true);
    expect(isAllowedAgentWritePath("run-1", "t1", "runs/run-1/agent-scratch/note.txt")).toBe(true);
    expect(isAllowedAgentWritePath("run-1", "t1", "model/journeys.yaml")).toBe(false);
    expect(isAllowedAgentWritePath("run-1", "t1", "runs/run-1/run-plan.yaml")).toBe(false);
    expect(() => assertAllowedAgentWritePath("run-1", "t1", "model/journeys.yaml")).toThrow(/拒绝/);

    const root = tmp("bm-m5-write-");
    const runId = "run-write";
    await writeM4AnalysisArtifacts(root, runId);
    const before = snapshotModelFiles(root);
    const result = await new DefaultAgentRunner().run(
      makeAgentTask(root, runId, "force-write-model", { kind: "classify_features" })
    );
    expect(result.status).toBe("failed");
    expect(result.errors?.join(" ")).toMatch(/拒绝/);
    expect(snapshotModelFiles(root)).toEqual(before);
    expect(existsSync(join(root, "runs", runId, "proposals", "force-write-model.json"))).toBe(false);
  });

  it("Mock 与真实 runner 满足同一 AgentRunner 类型，Source/start/Discovery 导入不变", async () => {
    const mock: AgentRunner = new MockAgentRunner();
    const real: AgentRunner = new DefaultAgentRunner();
    for (const runner of [mock, real]) {
      expect(runner.inherit_host_credentials).toBe(false);
      expect(runner.load_project_agent_config).toBe(false);
      expect(runner.workspace).toBe("read_only");
      expect(runner.network).toBe("denied_or_explicit");
    }

    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = [
      join(root, "packages/source/src/index.ts"),
      join(root, "packages/source/src/provider.ts"),
      join(root, "packages/project/src/index.ts"),
      join(root, "packages/project/src/start.ts"),
      join(root, "packages/project/src/adapter.ts"),
      join(root, "packages/discovery/src/index.ts"),
      join(root, "packages/discovery/src/adapter.ts"),
      join(root, "packages/export/src/index.ts")
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/@behavior-map\/agent/);
      expect(text).not.toMatch(/MockAgentRunner|DefaultAgentRunner/);
    }
  });

  it("失败与超时不写 model/，也不把未完成写成不存在", async () => {
    const root = tmp("bm-m5-fail-");
    const runId = "run-fail";
    await writeM4AnalysisArtifacts(root, runId);
    const before = snapshotModelFiles(root);

    const failed = await new DefaultAgentRunner().run(
      makeAgentTask(root, runId, "force-fail", { kind: "classify_features" })
    );
    expect(failed.status).toBe("failed");
    expect(snapshotModelFiles(root)).toEqual(before);
    expect(existsSync(join(root, "runs", runId, "proposals", "force-fail.json"))).toBe(false);

    const slow: AgentAnalysisBackend = {
      async analyze() {
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw new Error("should have timed out");
      }
    };
    const timed = await new DefaultAgentRunner({ backend: slow }).run(
      makeAgentTask(root, runId, "classify_features", { kind: "classify_features", timeout_ms: 15 })
    );
    expect(["partial", "failed"]).toContain(timed.status);
    expect(timed.errors?.join(" ")).toMatch(/timeout/);
    expect(snapshotModelFiles(root)).toEqual(before);
    expect(existsSync(join(root, "runs", runId, "proposals", "classify_features.json"))).toBe(false);
    expect(JSON.stringify(timed)).not.toMatch(/does not exist|不存在/);
  });

  it("提案中的 run-plan 被 start/assertPlanConfirmed 忽略", async () => {
    const dir = tmp("bm-m5-plan-");
    const depPort = await reservePort();
    const appPort = await reservePort();
    const official = tinyTwoProcessPlan({
      runId: "run-plan",
      depPort,
      appPort,
      confirmation: { status: "draft" }
    });
    const proposed = {
      ...tinyTwoProcessPlan({
        runId: "run-plan",
        depPort,
        appPort,
        confirmation: { status: "confirmed", confirmed_at: "2026-08-21T00:00:00.000Z" }
      })
    };
    writeTrusted(dir);
    writePlanFile(dir, official);
    writeYaml(join(dir, "runs", "run-plan", "proposals", "run-plan.yaml"), proposed);
    writeYaml(join(dir, "runs", "run-plan", "agent-scratch", "run-plan.yaml"), proposed);

    const files = officialStartPlanFiles(workspaceAt(dir), official);
    expect(files.every((file) => !file.includes("/proposals/") && !file.includes("/agent-scratch/"))).toBe(
      true
    );

    const loaded = loadStartPlan(workspaceAt(dir), proposed);
    expect(loaded.confirmation.status).toBe("draft");
    expect(() => assertPlanConfirmed(loaded)).toThrow(/confirmed run-plan.yaml/);

    const result = await new DefaultProjectAdapter({ healthcheckTimeoutMs: 800 }).start(
      workspaceAt(dir),
      proposed
    );
    expect(result.status).toBe("failed-runtime");
    expect("project" in result).toBe(false);
    expect(result.gaps.some((gap) => gap.reason === "plan_not_confirmed")).toBe(true);
    expect(existsSync(join(dir, "installed-dep"))).toBe(false);
    expect(existsSync(join(dir, "marker-dep"))).toBe(false);
  });

  it("LLM 默认关闭，无 API key / 未显式允许网络时不启用", () => {
    expect(isOptionalLlmEnabled({ env: {} })).toBe(false);
    expect(isOptionalLlmEnabled({ apiKey: "sk-test", allowNetwork: false, env: {} })).toBe(false);
    expect(isOptionalLlmEnabled({ apiKey: "", allowNetwork: true, env: {} })).toBe(false);
    expect(isOptionalLlmEnabled({ apiKey: "sk-test", allowNetwork: true, env: {} })).toBe(true);
  });

  it("不接受 guide/action/explore 任务 kind，核心不引入 Room/Channel/Rocket.Chat", () => {
    expect(AGENT_TASK_KINDS).toEqual([
      "classify_features",
      "build_journeys",
      "analyze_effects",
      "prune_candidates"
    ]);
    for (const kind of ["guide", "action", "explore"]) {
      expect(
        validateDocument("agent-task", {
          schema_version: SCHEMA_VERSION,
          task_id: "x",
          run_id: "r",
          analysis_root: "/tmp",
          approved_read_paths: ["study.yaml"],
          policy: {
            inherit_host_credentials: false,
            load_project_agent_config: false,
            workspace: "read_only",
            network: "denied_or_explicit"
          },
          timeout_ms: 1000,
          kind
        }).ok
      ).toBe(false);
    }

    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const agentDir = join(root, "packages/agent/src");
    for (const name of readdirSync(agentDir).filter((file) => file.endsWith(".ts"))) {
      const text = readFileSync(join(agentDir, name), "utf8");
      expect(text).not.toMatch(/Rocket\.Chat|RocketChat/);
      expect(text).not.toMatch(/(?:type|interface|enum)\s+(Room|Channel|RocketChat)\b/);
      expect(text).not.toMatch(/@behavior-map\/discovery/);
      expect(text).not.toMatch(/explore\(|\.execute\(/);
    }
  });
});
