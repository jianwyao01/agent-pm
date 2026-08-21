import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { markMissingSupport, type StartResult } from "@behavior-map/contracts";

const contractsDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/contracts/src");
const projectDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/project/src");

describe("核心类型边界", () => {
  it("contracts 与 project 源码不焊接产品域名词", () => {
    const files = ["types.ts", "interfaces.ts", "ids.ts", "display.ts", "run-plan.ts"];
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
});
