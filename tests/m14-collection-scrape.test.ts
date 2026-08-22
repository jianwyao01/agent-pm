import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, writeJsonl, type RunningProject, type StartResult } from "@behavior-map/contracts";
import { DefaultDiscoveryAdapter, loadControls } from "@behavior-map/discovery";
import { DefaultProjectAdapter } from "@behavior-map/project";
import { writePlanFile, writeTrusted, reservePort } from "./helpers/tiny-processes.js";
import {
  copyTwoSurfaceFixture,
  fixtureContext,
  fixtureScope,
  twoSurfacePlan,
  workspaceAt
} from "./helpers/two-surface.js";
import { writeStorageState } from "./helpers/m4b-session.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function toSuccess(result: StartResult): RunningProject {
  expect(result.status).toBe("success");
  if (result.status !== "success") {
    throw new Error("expected success");
  }
  return result.project;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function walkTsJson(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...walkTsJson(full));
      continue;
    }
    if (name.name.endsWith(".ts") || name.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

describe("M14 collection 刮取不得拖死已成功的 play 点击", () => {
  const projectAdapter = new DefaultProjectAdapter({ healthcheckTimeoutMs: 2500 });
  const started: RunningProject[] = [];

  afterEach(async () => {
    while (started.length > 0) {
      const project = started.pop();
      if (project) {
        await projectAdapter.stop(project);
      }
    }
  });

  it("点击进入大量轮换链接的页面仍为 success，即使部分 link 读取失败", async () => {
    const dir = tmp("bm-m14-");
    const sessionDir = tmp("bm-m14-session-");
    copyTwoSurfaceFixture(dir);
    writeTrusted(dir);
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = twoSurfacePlan({
      runId: "run-m14",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-22T00:00:00.000Z" }
    });
    writePlanFile(dir, plan);
    const storageState = join(sessionDir, "storageState.json");
    writeStorageState(storageState);

    const discovery = new DefaultDiscoveryAdapter({
      runId: "run-m14",
      analysisRoot: dir,
      sessionRefs: { "secret:session-cookie": storageState }
    });
    const scope = fixtureScope(dir);
    await discovery.scan(workspaceAt(dir), scope);

    const startedResult = await projectAdapter.start(workspaceAt(dir), plan);
    const project = toSuccess(startedResult);
    started.push(project);

    const liveContext = fixtureContext(dir, `http://127.0.0.1:${appPort}/`);
    await discovery.explore(project, liveContext, scope);

    const runRoot = join(dir, "runs", "run-m14");
    const controls = loadControls(runRoot);
    const openInfo = controls.find((row) => row.observed.name === "打开信息面");
    expect(openInfo).toBeTruthy();

    writeJsonl(join(runRoot, "bindings.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-open-info",
        control_id: openInfo!.control_id,
        approved_locator: { type: "role", value: "button;name=打开信息面" },
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      }
    ]);

    const began = Date.now();
    const played = await discovery.play(project, liveContext, [
      {
        id: openInfo!.control_id,
        surface_id: "surface-list",
        name: "打开信息面",
        action: "click",
        binding_id: "bind-open-info"
      }
    ]);
    const elapsed = Date.now() - began;

    expect(played).toHaveLength(1);
    expect(played[0]?.status).toBe("success");
    expect(played[0]?.gaps.some((gap) => gap.reason === "execute_failed")).toBe(false);
    expect(elapsed).toBeLessThan(12_000);
  }, 20_000);

  it("packages/ 仍用 role+name 刮列表，不写夹具 CSS 或产品域字符串", () => {
    const packages = join(repoRoot(), "packages");
    for (const file of walkTsJson(packages)) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/Rocket\.Chat|RocketChat/);
      expect(text).not.toMatch(/data-item-id/);
      expect(text).not.toMatch(/#item-list/);
      expect(text).not.toMatch(/\/admin\/info/);
    }
  });
});
