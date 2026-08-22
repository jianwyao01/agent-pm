import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  validateDocument,
  writeJsonl,
  type RunningProject,
  type StartResult
} from "@behavior-map/contracts";
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

const ICON_GLYPH = "\uE000";

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

describe("M16 dump 把 title 与 aria-label 记为 locator 候选", () => {
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

  it("图标按钮 observed.name 保持字形；人类批准 title 后 play 点击为 success", async () => {
    const dir = tmp("bm-m16-");
    const sessionDir = tmp("bm-m16-session-");
    copyTwoSurfaceFixture(dir);
    writeTrusted(dir);
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = twoSurfacePlan({
      runId: "run-m16",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-22T00:00:00.000Z" }
    });
    writePlanFile(dir, plan);
    const storageState = join(sessionDir, "storageState.json");
    writeStorageState(storageState);

    const discovery = new DefaultDiscoveryAdapter({
      runId: "run-m16",
      analysisRoot: dir,
      sessionRefs: { "secret:session-cookie": storageState }
    });
    const scope = fixtureScope(dir);
    await discovery.scan(workspaceAt(dir), scope);

    const startedResult = await projectAdapter.start(workspaceAt(dir), plan);
    const project = toSuccess(startedResult);
    started.push(project);

    const liveContext = fixtureContext(dir, `http://127.0.0.1:${appPort}/`);
    const explored = await discovery.explore(project, liveContext, scope);
    expect(explored.status).toBe("success");

    const runRoot = join(dir, "runs", "run-m16");
    const controls = loadControls(runRoot);
    const icon = controls.find((row) =>
      row.locator_candidates.some((item) => item.type === "title" && item.value === "Open item")
    );
    expect(icon).toBeTruthy();
    expect(icon?.observed.name).not.toBe("Open item");
    expect(icon?.observed.name === undefined || icon?.observed.name === "" || icon?.observed.name === ICON_GLYPH).toBe(
      true
    );
    expect(icon?.locator_candidates.some((item) => item.type === "label" && item.value === ICON_GLYPH)).toBe(true);
    expect(icon?.locator_candidates.some((item) => item.type === "role" && item.value.includes("Open item"))).toBe(
      false
    );

    const binding = {
      schema_version: SCHEMA_VERSION,
      binding_id: "bind-open-item",
      control_id: icon!.control_id,
      approved_locator: { type: "title" as const, value: "Open item" },
      approved_by: "human" as const,
      created_at: "2026-08-22T00:00:00.000Z"
    };
    expect(validateDocument("binding", binding).ok).toBe(true);
    writeJsonl(join(runRoot, "bindings.jsonl"), [binding]);

    const played = await discovery.play(project, liveContext, [
      {
        id: icon!.control_id,
        surface_id: icon!.surface_id,
        name: icon!.observed.name || ICON_GLYPH,
        action: "click",
        binding_id: "bind-open-item"
      }
    ]);
    expect(played).toHaveLength(1);
    expect(played[0]?.status).toBe("success");
    expect(played[0]?.gaps.some((gap) => gap.reason === "locator_not_found")).toBe(false);
  }, 20_000);

  it("packages/ 不发明产品域按钮名，也不把 name 改写成 title", () => {
    const packages = join(repoRoot(), "packages");
    for (const file of walkTsJson(packages)) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/Rocket\.Chat|RocketChat/);
      expect(text).not.toMatch(/\bThreads\b/);
      expect(text).not.toMatch(/\bMembers\b/);
      expect(text).not.toMatch(/Room Information/);
      expect(text).not.toMatch(/name=Threads/);
      expect(text).not.toMatch(/name=Open item/);
    }
  });
});
