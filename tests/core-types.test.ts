import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  collectObservedJourneyIds,
  displayObservations,
  markMissingSupport,
  type Binding,
  type Candidate,
  type StartResult
} from "@behavior-map/contracts";

const contractsDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/contracts/src");
const projectDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/project/src");
const discoveryDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/discovery/src");

describe("核心类型边界", () => {
  it("contracts 与 project 源码不焊接产品域名词", () => {
    const files = ["types.ts", "interfaces.ts", "ids.ts", "display.ts", "run-plan.ts", "scope.ts"];
    expect(readFileSync(join(contractsDir, "types.ts"), "utf8")).toMatch(
      /SourceKind = "git" \| "local" \| "archive"/
    );
    expect(readFileSync(join(contractsDir, "types.ts"), "utf8")).not.toMatch(
      /(?:type|interface|enum)\s+ProjectType\b|projectType\s*:/
    );
    for (const file of files) {
      const text = readFileSync(join(contractsDir, file), "utf8");
      expect(text).not.toMatch(/Rocket\.Chat/);
      expect(text).not.toMatch(/\bRoom\b/);
      expect(text).not.toMatch(/\bChannel\b/);
    }
    const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/source/src");
    for (const file of ["provider.ts", "record.ts", "locator.ts"]) {
      const text = readFileSync(join(sourceDir, file), "utf8");
      expect(text).not.toMatch(/Rocket\.Chat/);
      expect(text).not.toMatch(/\bRoom\b/);
      expect(text).not.toMatch(/\bChannel\b/);
    }
    for (const file of readdirSync(projectDir).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(projectDir, file), "utf8");
      expect(text).not.toMatch(/Rocket\.Chat/);
      expect(text).not.toMatch(/RocketChat/);
      expect(text).not.toMatch(/\bRoom\b/);
      expect(text).not.toMatch(/\bChannel\b/);
    }
    for (const file of readdirSync(discoveryDir).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(discoveryDir, file), "utf8");
      expect(text).not.toMatch(/Rocket\.Chat/);
      expect(text).not.toMatch(/RocketChat/);
      expect(text).not.toMatch(/\bRoom\b/);
      expect(text).not.toMatch(/\bChannel\b/);
    }
    const agentDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/agent/src");
    for (const file of readdirSync(agentDir).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(agentDir, file), "utf8");
      expect(text).not.toMatch(/Rocket\.Chat/);
      expect(text).not.toMatch(/RocketChat/);
      expect(text).not.toMatch(/\bRoom\b/);
      expect(text).not.toMatch(/\bChannel\b/);
    }
    const reviewDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/review/src");
    const exportDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/export/src");
    for (const dir of [reviewDir, exportDir]) {
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
        const text = readFileSync(join(dir, file), "utf8");
        expect(text).not.toMatch(/Rocket\.Chat/);
        expect(text).not.toMatch(/RocketChat/);
        expect(text).not.toMatch(/\bRoom\b/);
        expect(text).not.toMatch(/\bChannel\b/);
      }
    }
  });

  it("只有 success 的 StartResult 带有 explore 可用的 RunningProject", () => {
    const success: StartResult = {
      status: "success",
      project: {
        schema_version: "0.1.0",
        usable_for_explore: true,
        base_url: "https://example.test"
      },
      components: [],
      gaps: []
    };
    const partial: StartResult = { status: "partial", components: [], gaps: [] };
    const failed: StartResult = { status: "failed-runtime", components: [], gaps: [] };
    expect("project" in success).toBe(true);
    expect("project" in partial).toBe(false);
    expect("project" in failed).toBe(false);
  });

  it("观察投影含六列且永不省略他面", () => {
    const display = displayObservations([]);
    expect(display.columns).toEqual(["本面", "他面", "列表", "未读", "通知", "后台"]);
    expect(display.rows[0].cells.find((cell) => cell.column === "他面")?.value).toBe("未观察到");
  });

  it("缺支持时标 stale/not_observed，不删除 journey_id", () => {
    const journeys = markMissingSupport(
      [
        {
          id: "jny-send-001",
          name: "发送一条消息（已审定）",
          status: "accepted",
          effect_ids: ["eff-current"]
        }
      ],
      []
    );
    expect(journeys).toHaveLength(1);
    expect(journeys[0].id).toBe("jny-send-001");
    expect(journeys[0].status).toBe("stale");
  });

  it("观察：候选 control_id、step binding_id 或 human 绑定任一成立即可，不要求 ctl-*-obs", () => {
    const journey = {
      id: "jny-new-item",
      name: "创建条目",
      status: "accepted" as const,
      effect_ids: [],
      control_id: "ctl-9f3c1a2b0d4e5f67-obs",
      steps: [{ binding_id: "bind-create-submit", action: "submit" as const }]
    };
    const scanCandidate = {
      schema_version: SCHEMA_VERSION,
      id: "cand-scan-create",
      kind: "control" as const,
      scope_id: "scope-new-item",
      discovered_by: "scan",
      evidence_refs: [],
      execution_status: "observed" as const,
      scope_status: "in_scope" as const,
      review_status: "unreviewed" as const,
      rejection_reason: null,
      discovery_key: "control:public/create.html:control-create-submit",
      label: "提交创建"
    } satisfies Candidate;
    const playCandidate = {
      ...scanCandidate,
      id: "cand-play-create",
      discovered_by: "play",
      discovery_key: "interaction:bind-create-submit"
    } satisfies Candidate;
    const humanBinding = {
      schema_version: SCHEMA_VERSION,
      binding_id: "bind-create-submit",
      control_id: "ctl-9f3c1a2b0d4e5f67-obs",
      approved_locator: { type: "role" as const, value: "button;name=提交创建" },
      approved_by: "human" as const,
      created_at: "2026-08-22T00:00:00.000Z"
    } satisfies Binding;

    expect(
      collectObservedJourneyIds([journey], {
        candidates: [scanCandidate],
        bindings: []
      })
    ).toEqual([]);
    expect(
      collectObservedJourneyIds([{ ...journey, control_id: "control-create-submit" }], {
        candidates: [scanCandidate],
        bindings: []
      })
    ).toEqual(["jny-new-item"]);
    expect(
      collectObservedJourneyIds([journey], {
        candidates: [playCandidate],
        bindings: []
      })
    ).toEqual(["jny-new-item"]);
    expect(
      collectObservedJourneyIds([journey], {
        candidates: [],
        bindings: [humanBinding]
      })
    ).toEqual(["jny-new-item"]);
    expect(
      collectObservedJourneyIds(
        [
          journey,
          { id: "jny-old-unsupported", name: "旧旅程", status: "accepted", effect_ids: [] }
        ],
        { candidates: [playCandidate], bindings: [humanBinding], alwaysObservedIds: ["jny-new-item"] }
      )
    ).toEqual(["jny-new-item"]);
  });
});
