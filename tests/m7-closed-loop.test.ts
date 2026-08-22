import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  validateDocument,
  writeJsonl,
  writeYaml,
  type ProbePlan,
  type RunningProject,
  type StartResult
} from "@behavior-map/contracts";
import { DefaultDiscoveryAdapter, loadControls, loadProbePlan } from "@behavior-map/discovery";
import { DefaultProjectAdapter } from "@behavior-map/project";
import { runClosedLoop } from "@behavior-map/review";
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

function writeTreeProbePlan(dir: string, unique: string): ProbePlan {
  const plan: ProbePlan = {
    schema_version: SCHEMA_VERSION,
    human_approved: true,
    entry: "nav-tree-open-surface",
    session_slot: "primary",
    target_surface: "surface-target",
    send_action: "bind-send",
    other_surfaces_to_refresh: ["surface-list"],
    actions: [
      { binding_id: "bind-nav", action: "click" },
      { binding_id: "bind-type", action: "type", value: unique },
      { binding_id: "bind-send", action: "submit" }
    ]
  };
  writeYaml(join(dir, "probe-plan.yaml"), plan);
  return plan;
}

describe("M7 官方 study runner + 树入口", () => {
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

  it("夹具 probe-plan.entry 保持；actions 三步时 send_action 等于最后发送步", () => {
    const fixture = join(repoRoot(), "fixtures/m4-two-surface");
    const loaded = loadProbePlan(fixture);
    expect(loaded?.entry).toBe("nav-tree-open-surface");
    expect(loaded?.actions).toBeUndefined();

    const unique = "m7-probe-value";
    const dir = tmp("bm-m7-plan-");
    const plan = writeTreeProbePlan(dir, unique);
    expect(plan.entry).toBe("nav-tree-open-surface");
    expect(plan.actions).toEqual([
      { binding_id: "bind-nav", action: "click" },
      { binding_id: "bind-type", action: "type", value: unique },
      { binding_id: "bind-send", action: "submit" }
    ]);
    expect(plan.send_action).toBe("bind-send");
    expect(validateDocument("probe-plan", plan).ok).toBe(true);
  });

  it("storageState 绕过登录；runClosedLoop 在同一会话 play 树入口+type+submit；retarget 保持 journey_id；spec 发三条 locator", async () => {
    const dir = tmp("bm-m7-");
    const sessionDir = tmp("bm-m7-session-");
    copyTwoSurfaceFixture(dir);
    writeTrusted(dir);
    const unique = `m7-closed-${Date.now().toString(36)}`;
    writeTreeProbePlan(dir, unique);

    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = twoSurfacePlan({
      runId: "run-m7",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-22T00:00:00.000Z" }
    });
    writePlanFile(dir, plan);
    const storageState = join(sessionDir, "storageState.json");
    writeStorageState(storageState);

    const discovery = new DefaultDiscoveryAdapter({
      runId: "run-m7",
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

    const runRoot = join(dir, "runs", "run-m7");
    const controls = loadControls(runRoot);
    const nav = controls.find(
      (row) => row.observed.name === "打开已有目标 Surface" || row.observed.name === "打开目标面"
    );
    const send = controls.find(
      (row) => row.observed.name === "发送一条消息" || row.observed.name === "发送"
    );
    const input = controls.find((row) => row.observed.name === "输入" || row.observed.role === "textbox");
    expect(nav).toBeTruthy();
    expect(send).toBeTruthy();
    expect(input).toBeTruthy();

    const navLocator = { type: "role" as const, value: "link;name=打开已有目标 Surface" };
    const typeLocator = { type: "role" as const, value: "textbox;name=输入" };
    const sendLocator = { type: "role" as const, value: "button;name=发送一条消息" };
    writeJsonl(join(runRoot, "bindings.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-nav",
        control_id: nav!.control_id,
        approved_locator: navLocator,
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      },
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-type",
        control_id: input!.control_id,
        approved_locator: typeLocator,
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      },
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-send",
        control_id: send!.control_id,
        approved_locator: sendLocator,
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      }
    ]);
    expect(navLocator.value).not.toContain("#control-send");
    expect(typeLocator.value).not.toContain("#control-send");
    expect(sendLocator.value).not.toContain("#control-send");

    const staticBefore = readFileSync(join(runRoot, "evidence", "static.jsonl"), "utf8");
    const itemsBefore = (await fetch(`http://127.0.0.1:${appPort}/api/items`).then((res) =>
      res.json()
    )) as Array<{ text: string }>;

    const closed = await runClosedLoop({
      analysisRoot: dir,
      runId: "run-m7",
      project,
      context: liveContext,
      sessionRefs: { "secret:session-cookie": storageState },
      scope,
      reviewSpec: {
        addJourney: { name: "绑定发送", control_id: "control-send" },
        retarget: [{ journey_id: "jny-send", control_id: send!.control_id }]
      }
    });

    expect(readFileSync(join(runRoot, "evidence", "static.jsonl"), "utf8")).toBe(staticBefore);
    expect(closed.played).toHaveLength(3);
    expect(closed.played.every((row) => row.status === "success")).toBe(true);

    const itemsAfter = (await fetch(`http://127.0.0.1:${appPort}/api/items`).then((res) =>
      res.json()
    )) as Array<{ text: string }>;
    expect(itemsAfter.length).toBeGreaterThan(itemsBefore.length);
    expect(itemsAfter.some((item) => item.text.includes(unique))).toBe(true);

    const loginPosted = await fetch(`http://127.0.0.1:${appPort}/debug/login-posted`).then((res) =>
      res.json()
    );
    expect(loginPosted.posted).toBe(false);

    const journey = closed.model.journeys.find((item) => item.id === "jny-send");
    expect(journey).toBeDefined();
    expect(journey?.id).toBe("jny-send");
    expect(journey?.control_id).toBe(send!.control_id);
    expect(closed.model.journeys.filter((item) => item.name === "绑定发送")).toHaveLength(1);
    expect(journey?.steps).toEqual([
      { binding_id: "bind-nav", action: "click" },
      { binding_id: "bind-type", action: "type", value: unique },
      { binding_id: "bind-send", action: "submit" }
    ]);

    const spec = readFileSync(join(dir, "generated/tests/journeys.spec.ts"), "utf8");
    expect(closed.generatedPaths.some((path) => path.endsWith("journeys.spec.ts"))).toBe(true);
    expect(spec).toContain(navLocator.value);
    expect(spec).toContain(typeLocator.value);
    expect(spec).toContain(sendLocator.value);
    const navAt = spec.indexOf(navLocator.value);
    const typeAt = spec.indexOf(typeLocator.value);
    const sendAt = spec.indexOf(sendLocator.value);
    expect(navAt).toBeGreaterThan(-1);
    expect(typeAt).toBeGreaterThan(navAt);
    expect(sendAt).toBeGreaterThan(typeAt);
    expect(spec).toMatch(/getByRole\("link".*name:\s*"打开已有目标 Surface"/);
    expect(spec).toMatch(/getByRole\("textbox".*name:\s*"输入"/);
    expect(spec).toMatch(/getByRole\("button".*name:\s*"发送一条消息"/);
    expect(spec).toMatch(/\.fill\(/);
    expect(spec).not.toContain("#control-send");
  }, 80_000);

  it("runClosedLoop 是函数：不 start、不 explore 做产品动作、不把 Probe 拆成孤立 execute", () => {
    const source = readFileSync(join(repoRoot(), "packages/review/src/closed-loop.ts"), "utf8");
    expect(source).toMatch(/export async function runClosedLoop/);
    expect(source).toMatch(/playFromProbePlan/);
    expect(source).toMatch(/applyHumanReview/);
    expect(source).toMatch(/generateAll/);
    expect(source).not.toMatch(/ProjectAdapter/);
    expect(source).not.toMatch(/\.start\(/);
    expect(source).not.toMatch(/\.explore\(/);
    expect(source).not.toMatch(/\.execute\(/);
    expect(source).not.toMatch(/proposals\//);
  });

  it("packages/ 不把 Rocket.Chat / Room / Channel 当核心类型，也不写死产品选择器", () => {
    const packages = join(repoRoot(), "packages");
    for (const file of walkTsJson(packages)) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/Rocket\.Chat|RocketChat/);
      expect(text).not.toMatch(/(?:type|interface|enum)\s+(Room|Channel|RocketChat)\b/);
      expect(text).not.toMatch(/usernameOrEmail/);
      expect(text).not.toMatch(/\/channel\//);
      expect(text).not.toMatch(/study-send/);
      expect(text).not.toMatch(/aria-label\s*=\s*Send\b/);
    }
    expect(existsSync(join(repoRoot(), "docs/M7.md"))).toBe(true);
  });
});
