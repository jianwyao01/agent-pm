import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  readJson,
  validateDocument,
  validateRunPlanShape,
  type RunningProject,
  type StartResult
} from "@behavior-map/contracts";
import { DefaultProjectAdapter, isProcessAlive } from "@behavior-map/project";
import { StubDiscoveryAdapter } from "./helpers/stub-discovery.js";
import {
  reservePort,
  tinyTwoProcessPlan,
  workspaceAt,
  writePlanFile,
  writeTrusted
} from "./helpers/tiny-processes.js";

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

describe("M3 ProjectAdapter.start / stop", () => {
  const adapter = new DefaultProjectAdapter({ healthcheckTimeoutMs: 2500 });
  const started: RunningProject[] = [];

  afterEach(async () => {
    while (started.length > 0) {
      const project = started.pop();
      if (project) {
        await adapter.stop(project);
      }
    }
  });

  it("confirmed + trusted 计划按 depends_on / start_order 启动两个进程，success 写 running-project.json，stop 拆除", async () => {
    const dir = tmp("bm-m3-ok-");
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = tinyTwoProcessPlan({
      runId: "run-ok",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-21T00:00:00.000Z" }
    });
    writeTrusted(dir);
    writePlanFile(dir, plan);

    const result = await adapter.start(workspaceAt(dir), plan);
    const project = toSuccess(result);
    started.push(project);

    expect(result.components.map((item) => item.id)).toEqual(["dep", "app"]);
    expect(result.components.every((item) => item.status === "started")).toBe(true);
    expect(result.components.every((item) => item.healthcheck === "passed")).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(project.usable_for_explore).toBe(true);
    expect(project.urls?.dep).toContain(String(depPort));
    expect(project.urls?.app).toContain(String(appPort));

    const dep = result.components.find((item) => item.id === "dep");
    const app = result.components.find((item) => item.id === "app");
    expect(dep?.started_at && app?.started_at).toBeTruthy();
    expect(Date.parse(dep!.started_at!)).toBeLessThanOrEqual(Date.parse(app!.started_at!));

    expect(existsSync(join(dir, "installed-dep"))).toBe(true);
    expect(existsSync(join(dir, "installed-app"))).toBe(true);
    expect(existsSync(join(dir, "runs", "run-ok", "logs", "dep.log"))).toBe(true);
    expect(existsSync(join(dir, "runs", "run-ok", "logs", "app.log"))).toBe(true);

    const written = readJson<RunningProject>(join(dir, "runs", "run-ok", "running-project.json"));
    expect(validateDocument("running-project", written).ok).toBe(true);
    expect(written.components?.map((item) => item.id)).toEqual(["dep", "app"]);
    expect(written.components?.every((item) => item.started_by === "project-adapter")).toBe(true);

    const depHealth = await fetch(`http://127.0.0.1:${depPort}/health`);
    const appHealth = await fetch(`http://127.0.0.1:${appPort}/health`);
    expect(depHealth.ok).toBe(true);
    expect(appHealth.ok).toBe(true);

    const pids = (written.components ?? []).map((item) => item.pid).filter((pid): pid is number => Boolean(pid));
    expect(pids.length).toBe(2);
    expect(pids.every((pid) => isProcessAlive(pid))).toBe(true);

    const stopped = await adapter.stop(project);
    expect(stopped.status).toBe("stopped");
    started.pop();
    expect(pids.every((pid) => !isProcessAlive(pid))).toBe(true);
    await expect(fetch(`http://127.0.0.1:${depPort}/health`, { signal: AbortSignal.timeout(400) })).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${appPort}/health`, { signal: AbortSignal.timeout(400) })).rejects.toThrow();
  }, 20_000);

  it("第二个组件 healthcheck 失败时为 partial/failed-runtime，点名失败组件，有日志，无 RunningProject", async () => {
    const dir = tmp("bm-m3-health-");
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = tinyTwoProcessPlan({
      runId: "run-health",
      depPort,
      appPort,
      failAppHealth: true,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-21T00:00:00.000Z" }
    });
    writeTrusted(dir);
    writePlanFile(dir, plan);

    const result = await adapter.start(workspaceAt(dir), plan);
    expect(result.status === "partial" || result.status === "failed-runtime").toBe(true);
    expect(result.status).not.toBe("success");
    expect("project" in result).toBe(false);
    expect(existsSync(join(dir, "runs", "run-health", "running-project.json"))).toBe(false);

    const app = result.components.find((item) => item.id === "app");
    expect(app).toBeTruthy();
    expect(app?.status).toBe("failed");
    expect(app?.healthcheck).toBe("failed");
    expect(result.gaps.some((gap) => gap.component_id === "app")).toBe(true);
    expect(existsSync(join(dir, "runs", "run-health", "logs", "app.log"))).toBe(true);
    expect(existsSync(join(dir, "runs", "run-health", "logs", "dep.log"))).toBe(true);
    expect(readFileSync(join(dir, "runs", "run-health", "logs", "app.log"), "utf8")).toMatch(
      /healthcheck/i
    );
  }, 20_000);

  it("未确认的 draft plan 不启动进程，也不是 success", async () => {
    const dir = tmp("bm-m3-draft-");
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = tinyTwoProcessPlan({
      runId: "run-draft",
      depPort,
      appPort,
      confirmation: { status: "draft" }
    });
    writeTrusted(dir);
    writePlanFile(dir, plan);

    const result = await adapter.start(workspaceAt(dir), plan);
    expect(result.status).toBe("failed-runtime");
    expect("project" in result).toBe(false);
    expect(result.gaps.some((gap) => gap.reason === "plan_not_confirmed")).toBe(true);
    expect(existsSync(join(dir, "installed-dep"))).toBe(false);
    expect(existsSync(join(dir, "installed-app"))).toBe(false);
    expect(existsSync(join(dir, "marker-dep"))).toBe(false);
    expect(existsSync(join(dir, "runs", "run-draft", "running-project.json"))).toBe(false);
    expect(result.components.map((item) => item.id).sort()).toEqual(["app", "dep"]);
    expect(result.components.every((item) => item.status === "refused")).toBe(true);
  });

  it("未信任目标不安装/不执行目标脚本，gap 为 refused-untrusted", async () => {
    const dir = tmp("bm-m3-untrust-");
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = tinyTwoProcessPlan({
      runId: "run-untrust",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-21T00:00:00.000Z" }
    });
    writePlanFile(dir, plan);

    const result = await adapter.start(workspaceAt(dir), plan);
    expect(result.status).toBe("failed-runtime");
    expect("project" in result).toBe(false);
    expect(result.gaps.some((gap) => gap.reason === "refused-untrusted")).toBe(true);
    expect(existsSync(join(dir, "installed-dep"))).toBe(false);
    expect(existsSync(join(dir, "installed-app"))).toBe(false);
    expect(existsSync(join(dir, "marker-dep"))).toBe(false);
    expect(existsSync(join(dir, "marker-app"))).toBe(false);
    expect(existsSync(join(dir, "runs", "run-untrust", "running-project.json"))).toBe(false);
    expect(result.components.every((item) => item.status === "refused")).toBe(true);
  });

  it("单命令 + 单健康检查的 plan 仍被拒绝", async () => {
    const dir = tmp("bm-m3-flat-");
    writeTrusted(dir);
    const flat = {
      schema_version: SCHEMA_VERSION,
      start: "npm start",
      health_url: "http://127.0.0.1:3000",
      secret_refs: [],
      confirmation: { status: "confirmed", confirmed_at: "2026-08-21T00:00:00.000Z" }
    };
    expect(validateRunPlanShape(flat).ok).toBe(false);
    writePlanFile(dir, flat as never);

    const result = await adapter.start(workspaceAt(dir), flat as never);
    expect(result.status).toBe("failed-runtime");
    expect("project" in result).toBe(false);
    expect(result.gaps.some((gap) => gap.reason === "flat_start_health")).toBe(true);
    expect(existsSync(join(dir, "runs", "run-flat", "running-project.json"))).toBe(false);
  });

  it("start 失败后 Discovery.scan 占位仍可调用", async () => {
    const dir = tmp("bm-m3-scan-");
    const plan = tinyTwoProcessPlan({
      runId: "run-scan",
      depPort: await reservePort(),
      appPort: await reservePort(),
      confirmation: { status: "draft" }
    });
    const result = await adapter.start(workspaceAt(dir), plan);
    expect(result.status).not.toBe("success");

    const discovery = new StubDiscoveryAdapter();
    const scanned = await discovery.scan(workspaceAt(dir), {
      id: "scope-1",
      include_hints: [],
      exclude_hints: []
    });
    expect(Array.isArray(scanned.candidates)).toBe(true);
    expect(Array.isArray(scanned.evidence)).toBe(true);
  });

  it("Agent 凭据不进入目标进程环境，secret_ref 保持引用", async () => {
    const dir = tmp("bm-m3-secret-");
    const dumpEnvFile = join(dir, "env-dump.json");
    const previous = process.env.AGENT_API_KEY;
    process.env.AGENT_API_KEY = "should-not-leak";
    try {
      const plan = tinyTwoProcessPlan({
        runId: "run-secret",
        depPort: await reservePort(),
        appPort: await reservePort(),
        dumpEnvFile,
        confirmation: { status: "confirmed", confirmed_at: "2026-08-21T00:00:00.000Z" }
      });
      writeTrusted(dir);
      writePlanFile(dir, plan);
      const result = await adapter.start(workspaceAt(dir), plan);
      const project = toSuccess(result);
      started.push(project);
      expect(plan.secret_refs).toEqual([{ secret_ref: "env:STUDY_CREDENTIAL" }]);
      expect(JSON.stringify(plan)).not.toMatch(/password|hunter2/i);
      expect(existsSync(dumpEnvFile)).toBe(true);
      const dumped = JSON.parse(readFileSync(dumpEnvFile, "utf8")) as { AGENT_API_KEY: string | null };
      expect(dumped.AGENT_API_KEY).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_API_KEY;
      } else {
        process.env.AGENT_API_KEY = previous;
      }
    }
  }, 20_000);

  it("实现与测试不克隆产品仓库", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = [
      ...readdirSync(join(root, "packages/project/src"))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(root, "packages/project/src", name)),
      join(root, "tests/project-start.test.ts"),
      join(root, "tests/helpers/tiny-processes.ts"),
      join(root, "tests/helpers/tiny-http-server.cjs")
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/github\.com\/RocketChat\/Rocket\.Chat/);
      expect(text).not.toMatch(/RocketChat\/Rocket\.Chat/);
    }
  });
});
