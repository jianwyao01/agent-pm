import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  probePlanActions,
  validateDocument,
  validateSemantics,
  writeJsonl,
  writeYaml,
  type ProbePlan,
  type RunningProject,
  type StartResult
} from "@behavior-map/contracts";
import {
  DefaultDiscoveryAdapter,
  loadControls,
  loadProbePlan,
  playFromProbePlan
} from "@behavior-map/discovery";
import { generateAll, generateTests } from "@behavior-map/export";
import { DefaultProjectAdapter } from "@behavior-map/project";
import { applyHumanReview, hydrateModel } from "@behavior-map/review";
import { writePlanFile, writeTrusted, reservePort } from "./helpers/tiny-processes.js";
import {
  copyTwoSurfaceFixture,
  fixtureContext,
  fixtureScope,
  twoSurfacePlan,
  workspaceAt
} from "./helpers/two-surface.js";
import { writeHumanBinding, writeStorageState } from "./helpers/m4b-session.js";

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

function writeOfficialProbePlan(dir: string, unique: string): ProbePlan {
  const plan: ProbePlan = {
    schema_version: SCHEMA_VERSION,
    human_approved: true,
    entry: "nav-tree-open-surface",
    session_slot: "primary",
    target_surface: "surface-target",
    send_action: "bind-send",
    other_surfaces_to_refresh: ["surface-list"],
    actions: [
      { binding_id: "bind-type", action: "type", value: unique },
      { binding_id: "bind-send", action: "submit" }
    ]
  };
  writeYaml(join(dir, "probe-plan.yaml"), plan);
  return plan;
}

describe("M6b 官方闭环", () => {
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

  it("旧 probe-plan.yaml 无 actions 仍能加载；省略时按单步 click 解释", () => {
    const fixture = join(repoRoot(), "fixtures/m4-two-surface");
    const loaded = loadProbePlan(fixture);
    expect(loaded).toBeDefined();
    expect(loaded?.actions).toBeUndefined();
    expect(validateDocument("probe-plan", loaded).ok).toBe(true);
    expect(probePlanActions(loaded!)).toEqual([{ binding_id: "control-send", action: "click" }]);
  });

  it("写了 actions 时 send_action 必须等于最后发送步 binding_id；禁止 CSS 或语义目标", () => {
    const base = {
      schema_version: SCHEMA_VERSION,
      human_approved: true as const,
      entry: "nav-tree-open-surface",
      session_slot: "primary",
      target_surface: "surface-target",
      other_surfaces_to_refresh: ["surface-list"]
    };
    expect(
      validateDocument("probe-plan", {
        ...base,
        send_action: "bind-send",
        actions: [
          { binding_id: "bind-type", action: "type", value: "hi" },
          { binding_id: "bind-send", action: "submit" }
        ]
      }).ok
    ).toBe(true);
    expect(
      validateDocument("probe-plan", {
        ...base,
        send_action: "control-send",
        actions: [{ binding_id: "bind-send", action: "submit" }]
      }).ok
    ).toBe(false);
    expect(
      validateDocument("probe-plan", {
        ...base,
        send_action: "#control-send",
        actions: [{ binding_id: "#control-send", action: "click" }]
      }).ok
    ).toBe(false);
    expect(
      validateDocument("probe-plan", {
        ...base,
        send_action: "send_message",
        actions: [{ binding_id: "send_message", action: "click" }]
      }).ok
    ).toBe(false);
  });

  it("storageState 绕过登录；官方 play(type+submit) 共用会话；官方 retarget 后 generateAll 发出批准 locator", async () => {
    const dir = tmp("bm-m6b-");
    const sessionDir = tmp("bm-m6b-session-");
    copyTwoSurfaceFixture(dir);
    writeTrusted(dir);
    const unique = `m6b-closed-${Date.now().toString(36)}`;
    writeOfficialProbePlan(dir, unique);

    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = twoSurfacePlan({
      runId: "run-m6b",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-22T00:00:00.000Z" }
    });
    writePlanFile(dir, plan);
    const storageState = join(sessionDir, "storageState.json");
    writeStorageState(storageState);

    const discovery = new DefaultDiscoveryAdapter({
      runId: "run-m6b",
      analysisRoot: dir,
      sessionRefs: { "secret:session-cookie": storageState }
    });
    const scope = fixtureScope(dir);
    await discovery.scan(workspaceAt(dir), scope);

    const startedResult = await projectAdapter.start(workspaceAt(dir), plan);
    const project = toSuccess(startedResult);
    started.push(project);

    const liveContext = fixtureContext(dir, `http://127.0.0.1:${appPort}/compose-live`);
    const explored = await discovery.explore(project, liveContext, scope);
    expect(explored.status).toBe("success");

    const missing = await playFromProbePlan(discovery, project, liveContext, dir);
    expect(["failed", "unreachable"]).toContain(missing[0]?.status);
    expect(missing[0]?.gaps.some((gap) => gap.reason === "binding_missing")).toBe(true);

    const runRoot = join(dir, "runs", "run-m6b");
    const controls = loadControls(runRoot);
    const send = controls.find(
      (row) => row.observed.name === "发送一条消息" || row.observed.name === "发送"
    );
    const input = controls.find((row) => row.observed.name === "输入" || row.observed.role === "textbox");
    expect(send).toBeTruthy();
    expect(input).toBeTruthy();

    const typeBinding = writeHumanBinding(runRoot, {
      binding_id: "bind-type",
      control_id: input!.control_id,
      approved_locator: { type: "role", value: "textbox;name=输入" }
    });
    const sendBinding = {
      schema_version: SCHEMA_VERSION,
      binding_id: "bind-send",
      control_id: send!.control_id,
      approved_locator: { type: "role" as const, value: "button;name=发送一条消息" },
      approved_by: "human" as const,
      created_at: "2026-08-22T00:00:00.000Z"
    };
    writeJsonl(join(runRoot, "bindings.jsonl"), [typeBinding, sendBinding]);
    expect(sendBinding.approved_locator.value).not.toContain("#control-send");
    expect(typeBinding.approved_locator.value).not.toContain("#control-send");

    const itemsBefore = (await fetch(`http://127.0.0.1:${appPort}/api/items`).then((res) =>
      res.json()
    )) as Array<{ text: string }>;
    const played = await playFromProbePlan(discovery, project, liveContext, dir);
    expect(played.length).toBeGreaterThanOrEqual(2);
    expect(played.every((row) => row.status === "success")).toBe(true);

    const itemsAfter = (await fetch(`http://127.0.0.1:${appPort}/api/items`).then((res) =>
      res.json()
    )) as Array<{ text: string }>;
    expect(itemsAfter.length).toBeGreaterThan(itemsBefore.length);
    expect(itemsAfter.some((item) => item.text.includes(unique))).toBe(true);

    const loginPosted = await fetch(`http://127.0.0.1:${appPort}/debug/login-posted`).then((res) => res.json());
    expect(loginPosted.posted).toBe(false);

    const seeded = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m6b",
      spec: { addJourney: { name: "绑定发送", control_id: "control-send" } }
    });
    const journey = seeded.journeys.find((item) => item.name === "绑定发送");
    expect(journey).toBeDefined();
    expect(journey?.control_id).toBe("control-send");
    const journeyId = journey!.id;

    const hydrated = hydrateModel(dir, "run-m6b");
    expect(hydrated.journeys.find((item) => item.id === journeyId)?.control_id).toBe("control-send");

    expect(() =>
      applyHumanReview({
        analysisRoot: dir,
        runId: "run-m6b",
        spec: { retarget: [{ journey_id: journeyId, control_id: "ctl-missing-human" }] }
      })
    ).toThrow(/重定位失败/);

    const retargeted = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m6b",
      spec: { retarget: [{ journey_id: journeyId, control_id: send!.control_id }] }
    });
    const after = retargeted.journeys.find((item) => item.id === journeyId);
    expect(after).toBeDefined();
    expect(after?.id).toBe(journeyId);
    expect(after?.control_id).toBe(send!.control_id);
    expect(retargeted.journeys.filter((item) => item.name === "绑定发送")).toHaveLength(1);
    expect(after?.steps).toEqual([
      { binding_id: "bind-type", action: "type", value: unique },
      { binding_id: "bind-send", action: "submit" }
    ]);

    generateAll(retargeted, dir);
    const spec = readFileSync(join(dir, "generated/tests/journeys.spec.ts"), "utf8");
    expect(spec).toContain(typeBinding.approved_locator.value);
    expect(spec).toContain(sendBinding.approved_locator.value);
    expect(spec).toMatch(/getByRole\("textbox".*name:\s*"输入"/);
    expect(spec).toMatch(/getByRole\("button".*name:\s*"发送一条消息"/);
    expect(spec).toMatch(/\.fill\(/);
    expect(spec).not.toContain("#control-send");

    const semantic = validateSemantics(dir);
    expect(semantic.issues.filter((issue) => issue.code === "missing_binding_ref")).toEqual([]);
    expect(semantic.issues.filter((issue) => issue.code === "generated_locator_mismatch")).toEqual([]);
  }, 80_000);

  it("generateTests 不读 probe-plan.yaml；execute/play 不把 proposals 当 bindings", () => {
    const exportTests = readFileSync(join(repoRoot(), "packages/export/src/tests.ts"), "utf8");
    expect(exportTests).not.toMatch(/probe-plan\.yaml/);
    expect(exportTests).not.toMatch(/loadProbePlan/);

    const runtime = readFileSync(join(repoRoot(), "packages/discovery/src/runtime.ts"), "utf8");
    const store = readFileSync(join(repoRoot(), "packages/discovery/src/store.ts"), "utf8");
    const runner = readFileSync(join(repoRoot(), "packages/discovery/src/probe-runner.ts"), "utf8");
    expect(runtime).not.toMatch(/proposals\//);
    expect(store).not.toMatch(/proposals\//);
    expect(runner).toMatch(/adapter\.play\(/);
    expect(runner).not.toMatch(/\.execute\(/);

    const spec = generateTests(
      {
        schema_version: SCHEMA_VERSION,
        capabilities: [],
        journeys: [
          {
            id: "jny-bound-send",
            name: "绑定发送",
            status: "accepted",
            effect_ids: [],
            control_id: "control-send",
            steps: [
              { binding_id: "bind-type", action: "type", value: "hello" },
              { binding_id: "bind-send", action: "submit" }
            ]
          }
        ],
        effects: [],
        decisions: [],
        surfaces: [],
        controls: [
          {
            id: "ctl-input",
            surface_id: "surface-target",
            name: "输入",
            action: "type",
            binding_id: "bind-type",
            locator: { kind: "role", value: "textbox;name=输入", reliable: true }
          },
          {
            id: "ctl-send",
            surface_id: "surface-target",
            name: "发送一条消息",
            action: "submit",
            binding_id: "bind-send",
            locator: { kind: "role", value: "button;name=发送一条消息", reliable: true }
          }
        ]
      },
      tmp("bm-m6b-gen-")
    );
    expect(spec).toContain("textbox;name=输入");
    expect(spec).toContain("button;name=发送一条消息");
    expect(spec).toMatch(/getByRole\("textbox"/);
    expect(spec).toMatch(/getByRole\("button"/);
    expect(spec).not.toContain("#control-send");
  });

  it("packages/ 不把 Rocket.Chat / Room / Channel 当核心类型，也不写死产品选择器", () => {
    const packages = join(repoRoot(), "packages");
    for (const file of walkTsJson(packages)) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/Rocket\.Chat|RocketChat/);
      expect(text).not.toMatch(/(?:type|interface|enum)\s+(Room|Channel|RocketChat)\b/);
      expect(text).not.toMatch(/usernameOrEmail/);
      expect(text).not.toMatch(/\/channel\//);
      expect(text).not.toMatch(/aria-label\s*=\s*Send\b/);
    }
  });
});
