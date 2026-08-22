import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  validateDocument,
  validateSemantics,
  writeJsonl,
  type RunningProject,
  type StartResult
} from "@behavior-map/contracts";
import { DefaultDiscoveryAdapter, loadControls } from "@behavior-map/discovery";
import { generateTests } from "@behavior-map/export";
import { DefaultProjectAdapter } from "@behavior-map/project";
import { writePlanFile, writeTrusted, reservePort } from "./helpers/tiny-processes.js";
import {
  copyTwoSurfaceFixture,
  fixtureContext,
  fixtureScope,
  twoSurfacePlan,
  workspaceAt
} from "./helpers/two-surface.js";
import { boundSubmitAction, writeHumanBinding, writeStorageState } from "./helpers/m4b-session.js";

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

describe("M4b Control / Binding / SessionProvider", () => {
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

  it("storageState 绕过登录墙，人类 binding 重放后列表更新；缺 binding / 错 locator 立即停止", async () => {
    const dir = tmp("bm-m4b-");
    const sessionDir = tmp("bm-m4b-session-");
    copyTwoSurfaceFixture(dir);
    writeTrusted(dir);
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = twoSurfacePlan({
      runId: "run-m4b",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-22T00:00:00.000Z" }
    });
    writePlanFile(dir, plan);
    const storageState = join(sessionDir, "storageState.json");
    writeStorageState(storageState);

    const discovery = new DefaultDiscoveryAdapter({
      runId: "run-m4b",
      analysisRoot: dir,
      sessionRefs: { "secret:session-cookie": storageState }
    });
    const scope = fixtureScope(dir);
    await discovery.scan(workspaceAt(dir), scope);

    const startedResult = await projectAdapter.start(workspaceAt(dir), plan);
    const project = toSuccess(startedResult);
    started.push(project);

    const listContext = fixtureContext(dir, `http://127.0.0.1:${appPort}/`);
    const composeContext = fixtureContext(dir, `http://127.0.0.1:${appPort}/compose`);
    const explored = await discovery.explore(project, listContext, scope);
    expect(explored.status).toBe("success");

    const runRoot = join(dir, "runs", "run-m4b");
    expect(existsSync(join(runRoot, "controls.jsonl"))).toBe(true);
    const controls = loadControls(runRoot);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((row) => validateDocument("control", row).ok)).toBe(true);
    expect(controls.every((row) => !("send_message" in row) && !("login" in row) && !("intent" in row))).toBe(
      true
    );
    const send = controls.find(
      (row) => row.observed.name === "发送一条消息" || row.observed.name === "发送"
    );
    expect(send).toBeTruthy();
    expect(send?.locator_candidates[0]?.type).toBe("accessibility");

    const firstId = send!.control_id;
    const again = await new DefaultDiscoveryAdapter({
      runId: "run-m4b-stable",
      analysisRoot: dir,
      sessionRefs: { "secret:session-cookie": storageState }
    }).explore(project, listContext, scope);
    expect(again.status).toBe("success");
    const againSend = loadControls(join(dir, "runs", "run-m4b-stable")).find(
      (row) => row.observed.name === send?.observed.name && row.surface_id === send?.surface_id
    );
    expect(againSend?.control_id).toBe(firstId);

    const missing = await discovery.execute(project, composeContext, {
      id: send!.control_id,
      surface_id: send!.surface_id,
      name: send!.observed.name ?? "发送一条消息",
      action: "submit"
    });
    expect(["failed", "unreachable"]).toContain(missing.status);
    expect(missing.gaps.some((gap) => gap.reason === "binding_missing")).toBe(true);

    const wrong = writeHumanBinding(runRoot, {
      binding_id: "bind-wrong",
      control_id: send!.control_id,
      approved_locator: { type: "role", value: "button;name=不存在的按钮" }
    });
    const wrongResult = await discovery.execute(project, composeContext, boundSubmitAction(wrong));
    expect(["failed", "unreachable"]).toContain(wrongResult.status);
    expect(wrongResult.gaps.some((gap) => gap.reason === "locator_not_found")).toBe(true);

    const itemsBefore = await fetch(`http://127.0.0.1:${appPort}/api/items`).then((res) => res.json());
    expect(itemsBefore).toHaveLength(1);

    const binding = {
      schema_version: SCHEMA_VERSION,
      binding_id: "bind-send",
      control_id: send!.control_id,
      approved_locator: { type: "role" as const, value: "button;name=发送一条消息" },
      approved_by: "human" as const,
      created_at: "2026-08-22T00:00:00.000Z"
    };
    writeJsonl(join(runRoot, "bindings.jsonl"), [wrong, binding]);
    expect(binding.approved_locator.value).not.toContain("#control-send");
    expect(validateDocument("binding", binding).ok).toBe(true);

    const executed = await discovery.execute(project, composeContext, boundSubmitAction(binding));
    expect(executed.status).toBe("success");
    expect(executed.observations.some((row) => row.kind === "collection" && row.observed)).toBe(true);
    expect(executed.evidence.some((row) => row.payload.binding_id === "bind-send")).toBe(true);

    const itemsAfter = await fetch(`http://127.0.0.1:${appPort}/api/items`).then((res) => res.json());
    expect(itemsAfter.length).toBeGreaterThan(itemsBefore.length);

    const loginPosted = await fetch(`http://127.0.0.1:${appPort}/debug/login-posted`).then((res) => res.json());
    expect(loginPosted.posted).toBe(false);
    expect(existsSync(join(dir, "login-posted.flag"))).toBe(false);

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
            control_id: send!.control_id
          }
        ],
        effects: [],
        decisions: [],
        surfaces: [],
        controls: [
          {
            id: send!.control_id,
            surface_id: send!.surface_id,
            name: send!.observed.name ?? "发送一条消息",
            action: "submit",
            binding_id: binding.binding_id,
            locator: {
              kind: binding.approved_locator.type,
              value: binding.approved_locator.value,
              reliable: true
            }
          }
        ]
      },
      dir
    );
    expect(spec).toContain(binding.approved_locator.value);
    expect(spec).not.toContain("#control-send");

    const semantic = validateSemantics(dir);
    expect(semantic.issues.filter((issue) => issue.code === "missing_binding_ref")).toEqual([]);
    expect(semantic.issues.filter((issue) => issue.code === "generated_locator_mismatch")).toEqual([]);
  }, 50_000);

  it("execute 等待 approved_locator 可见后才重放；永不出现则 locator_not_found，不回退", async () => {
    const dir = tmp("bm-m4b-late-");
    const sessionDir = tmp("bm-m4b-late-session-");
    copyTwoSurfaceFixture(dir);
    writeTrusted(dir);
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = twoSurfacePlan({
      runId: "run-m4b-late",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-22T00:00:00.000Z" }
    });
    writePlanFile(dir, plan);
    const storageState = join(sessionDir, "storageState.json");
    writeStorageState(storageState);

    const discovery = new DefaultDiscoveryAdapter({
      runId: "run-m4b-late",
      analysisRoot: dir,
      sessionRefs: { "secret:session-cookie": storageState }
    });
    const scope = fixtureScope(dir);
    await discovery.scan(workspaceAt(dir), scope);

    const startedResult = await projectAdapter.start(workspaceAt(dir), plan);
    const project = toSuccess(startedResult);
    started.push(project);

    const runRoot = join(dir, "runs", "run-m4b-late");
    const binding = writeHumanBinding(runRoot, {
      binding_id: "bind-late-send",
      control_id: "ctl-late-send",
      approved_locator: { type: "role", value: "button;name=发送一条消息" }
    });

    const itemsBefore = await fetch(`http://127.0.0.1:${appPort}/api/items`).then((res) => res.json());
    expect(itemsBefore).toHaveLength(1);

    const lateContext = fixtureContext(dir, `http://127.0.0.1:${appPort}/compose-late?delay=500`);
    const executed = await discovery.execute(project, lateContext, boundSubmitAction(binding));
    expect(executed.status).toBe("success");

    const itemsAfterWait = (await fetch(`http://127.0.0.1:${appPort}/api/items`).then((res) =>
      res.json()
    )) as Array<{ text: string }>;
    expect(itemsAfterWait.length).toBeGreaterThan(itemsBefore.length);
    expect(itemsAfterWait.some((item) => item.text.includes("decoy-fallback"))).toBe(false);

    const neverContext = fixtureContext(dir, `http://127.0.0.1:${appPort}/compose-late?paint=never`);
    const missed = await discovery.execute(project, neverContext, boundSubmitAction(binding));
    expect(["failed", "unreachable"]).toContain(missed.status);
    expect(missed.gaps.some((gap) => gap.reason === "locator_not_found")).toBe(true);

    const itemsAfterMiss = (await fetch(`http://127.0.0.1:${appPort}/api/items`).then((res) =>
      res.json()
    )) as Array<{ text: string }>;
    expect(itemsAfterMiss).toHaveLength(itemsAfterWait.length);
    expect(itemsAfterMiss.some((item) => item.text.includes("decoy-fallback"))).toBe(false);

    const loginPosted = await fetch(`http://127.0.0.1:${appPort}/debug/login-posted`).then((res) => res.json());
    expect(loginPosted.posted).toBe(false);
  }, 60_000);

  it("packages/ 不把 Rocket.Chat / Room / Channel 当核心类型，也不写死产品选择器", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const packages = join(root, "packages");
    const files: string[] = [];
    for (const pkg of readdirSync(packages)) {
      const src = join(packages, pkg, "src");
      if (!existsSync(src)) {
        continue;
      }
      for (const name of readdirSync(src)) {
        if (name.endsWith(".ts") || name.endsWith(".json")) {
          files.push(join(src, name));
        }
      }
    }
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/Rocket\.Chat|RocketChat/);
      expect(text).not.toMatch(/(?:type|interface|enum)\s+(Room|Channel|RocketChat)\b/);
      expect(text).not.toMatch(/usernameOrEmail/);
      expect(text).not.toMatch(/\/channel\//);
      expect(text).not.toMatch(/aria-label\s*=\s*Send\b/);
    }
  });
});
