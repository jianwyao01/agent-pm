import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CROSS_ACTOR_UNEXECUTED,
  UNOBSERVED,
  displayObservations,
  readJsonl,
  stableCandidateId,
  validateDocument,
  type Candidate,
  type Control,
  type RunningProject,
  type StartResult
} from "@behavior-map/contracts";
import { DefaultDiscoveryAdapter, snapshotDigestFor } from "@behavior-map/discovery";
import { DefaultProjectAdapter } from "@behavior-map/project";
import { writePlanFile, writeTrusted, reservePort } from "./helpers/tiny-processes.js";
import {
  copyTwoSurfaceFixture,
  fixtureContext,
  fixtureScope,
  twoSurfacePlan,
  workspaceAt
} from "./helpers/two-surface.js";

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

function sendAction(): Control {
  return {
    id: "control-send",
    surface_id: "surface-target",
    name: "发送一条消息",
    action: "submit",
    locator: { kind: "css", value: "#control-send", reliable: true }
  };
}

describe("M4 DiscoveryAdapter", () => {
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

  it("scan() 不依赖 start，发现控件并全部写入 candidates.jsonl", async () => {
    const dir = tmp("bm-m4-scan-");
    copyTwoSurfaceFixture(dir);
    const discovery = new DefaultDiscoveryAdapter({ runId: "run-scan" });
    const scanned = await discovery.scan(workspaceAt(dir), fixtureScope(dir));

    expect(scanned.status === "success" || scanned.status === "partial").toBe(true);
    expect(scanned.candidates.length).toBeGreaterThan(3);
    expect(existsSync(join(dir, "runs", "run-scan", "candidates.jsonl"))).toBe(true);
    const written = readJsonl<Candidate>(join(dir, "runs", "run-scan", "candidates.jsonl"));
    expect(written.length).toBe(scanned.candidates.length);
    expect(written.every((row) => validateDocument("candidate", row).ok)).toBe(true);
    expect(written.every((row) => row.execution_status !== ("out_of_scope" as string))).toBe(true);

    const send = written.find((row) => row.discovery_key.includes("control-send") || row.label.includes("发送"));
    expect(send).toBeTruthy();
    expect(send?.scope_status).toBe("in_scope");

    const extra = written.find((row) => row.label.includes("管理后台") || row.discovery_key.includes("admin"));
    expect(extra).toBeTruthy();
    expect(["observed", "not_executed"]).toContain(extra?.execution_status);

    const swipe = written.find((row) => /swipe/i.test(`${row.discovery_key} ${row.label}`));
    expect(swipe).toBeTruthy();
    expect(swipe?.execution_status).toBe("not_executed");
  });

  it("同一 snapshot + 同一发现的 candidate_id 稳定，不静默截断", async () => {
    const dir = tmp("bm-m4-stable-");
    copyTwoSurfaceFixture(dir);
    const scope = fixtureScope(dir);
    const first = await new DefaultDiscoveryAdapter({ runId: "run-a" }).scan(workspaceAt(dir), scope);
    const second = await new DefaultDiscoveryAdapter({ runId: "run-b" }).scan(workspaceAt(dir), scope);
    const keys = first.candidates.map((row) => row.discovery_key).sort();
    expect(second.candidates.map((row) => row.discovery_key).sort()).toEqual(keys);
    expect(first.candidates.map((row) => row.id).sort()).toEqual(second.candidates.map((row) => row.id).sort());
    const sample = first.candidates[0];
    expect(sample.id).toBe(stableCandidateId(snapshotDigestFor(dir), sample.discovery_key));
    expect(first.gaps.every((gap) => gap.reason !== "silent_drop")).toBe(true);
  });

  it("命中资源上限时 status=partial 且有明确 Gap", async () => {
    const dir = tmp("bm-m4-cap-");
    copyTwoSurfaceFixture(dir);
    const scanned = await new DefaultDiscoveryAdapter({ runId: "run-cap", candidateCap: 2 }).scan(
      workspaceAt(dir),
      fixtureScope(dir)
    );
    expect(scanned.status).toBe("partial");
    expect(scanned.gaps.some((gap) => gap.reason === "resource_cap")).toBe(true);
    expect(scanned.candidates.length).toBe(2);
    expect(readJsonl<Candidate>(join(dir, "runs", "run-cap", "candidates.jsonl"))).toHaveLength(2);
  });

  it("confirmed+trusted start 后按 probe type+submit 一次发送，写 evidence，六列含他面", async () => {
    const dir = tmp("bm-m4-send-");
    copyTwoSurfaceFixture(dir);
    writeTrusted(dir);
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = twoSurfacePlan({
      runId: "run-send",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-21T00:00:00.000Z" }
    });
    writePlanFile(dir, plan);

    const discovery = new DefaultDiscoveryAdapter({ runId: "run-send" });
    const scope = fixtureScope(dir);
    const scanned = await discovery.scan(workspaceAt(dir), scope);
    expect(scanned.candidates.some((row) => row.discovery_key.includes("control-send"))).toBe(true);

    const startedResult = await projectAdapter.start(workspaceAt(dir), plan);
    const project = toSuccess(startedResult);
    started.push(project);

    const context = fixtureContext(dir, `http://127.0.0.1:${appPort}/`);
    const explored = await discovery.explore(project, context, scope);
    expect(explored.status).not.toBe("refused");

    const executed = await discovery.execute(project, context, sendAction());
    expect(executed.status).toBe("success");
    expect(executed.cross_actor.display_value).toBe(CROSS_ACTOR_UNEXECUTED);
    expect(executed.cross_actor.executed).toBe(false);

    const current = executed.observations.find((row) => row.kind === "current_surface");
    const other = executed.observations.find((row) => row.kind === "other_surface");
    const collection = executed.observations.find((row) => row.kind === "collection");
    const backend = executed.observations.find((row) => row.kind === "backend_operation");
    expect(current?.observed).toBe(true);
    expect(other?.observed).toBe(true);
    expect(collection?.observed).toBe(true);
    expect(backend?.observed).toBe(true);
    expect(backend?.transport).toBe("http");
    expect(backend?.display_value).toMatch(/POST/i);
    expect(backend?.display_value).toMatch(/\/send/);
    expect(JSON.stringify(backend)).not.toMatch(/"method":\s*"PUT"/);

    const display = displayObservations(executed.observations);
    expect(display.columns).toEqual(["本面", "他面", "列表", "未读", "通知", "后台"]);
    expect(display.rows[0].cells.find((cell) => cell.column === "他面")).toBeTruthy();
    expect(display.rows[0].cells.find((cell) => cell.column === "他面")?.observed).toBe(true);
    expect(display.rows[0].cells.find((cell) => cell.column === "未读")?.value).toBe(UNOBSERVED);
    expect(display.rows[0].cells.find((cell) => cell.column === "通知")?.value).toBe(UNOBSERVED);

    const candidates = readJsonl<Candidate>(join(dir, "runs", "run-send", "candidates.jsonl"));
    expect(candidates.length).toBeGreaterThanOrEqual(scanned.candidates.length);
    const extra = candidates.find(
      (row) => row.label.includes("管理后台") || row.discovery_key.includes("admin")
    );
    expect(extra).toBeTruthy();
    expect(["observed", "not_executed"]).toContain(extra?.execution_status);
    const send = candidates.find((row) => row.discovery_key.includes("control-send"));
    expect(send?.execution_status).toBe("executed");
    expect(send?.scope_status).toBe("in_scope");

    const runtime = readFileSync(join(dir, "runs", "run-send", "evidence", "runtime.jsonl"), "utf8");
    expect(runtime.length).toBeGreaterThan(0);
    executed.evidence.forEach((row) => {
      expect(validateDocument("evidence", row).ok).toBe(true);
      expect(row.immutable).toBe(true);
    });
  }, 40_000);

  it("start 失败后 scan 仍可用，explore/execute 被拒绝", async () => {
    const dir = tmp("bm-m4-fail-");
    copyTwoSurfaceFixture(dir);
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = twoSurfacePlan({
      runId: "run-fail",
      depPort,
      appPort,
      confirmation: { status: "draft" }
    });
    writePlanFile(dir, plan);
    const start = await projectAdapter.start(workspaceAt(dir), plan);
    expect(start.status).not.toBe("success");
    expect("project" in start).toBe(false);

    const discovery = new DefaultDiscoveryAdapter({ runId: "run-fail" });
    const scope = fixtureScope(dir);
    const scanned = await discovery.scan(workspaceAt(dir), scope);
    expect(scanned.candidates.length).toBeGreaterThan(0);

    const context = fixtureContext(dir, `http://127.0.0.1:${appPort}/`);
    const explored = await discovery.explore(start, context, scope);
    expect(explored.status).toBe("refused");
    expect(explored.gaps.some((gap) => gap.reason === "start_not_success")).toBe(true);

    const executed = await discovery.execute(start, context, sendAction());
    expect(executed.status).toBe("refused");
    expect(executed.gaps.some((gap) => gap.reason === "start_not_success")).toBe(true);
    expect(executed.cross_actor.display_value).toBe(CROSS_ACTOR_UNEXECUTED);
  });

  it("核心实现不把 Room/Channel/Rocket.Chat 当类型，CI 不克隆产品仓库", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const discoveryDir = join(root, "packages/discovery/src");
    const files = [
      ...readdirSync(discoveryDir)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(discoveryDir, name)),
      join(root, "tests/discovery-adapter.test.ts"),
      join(root, "tests/helpers/two-surface.ts"),
      join(root, "fixtures/m4-two-surface/server.cjs")
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/github\.com\/RocketChat\/Rocket\.Chat/);
      expect(text).not.toMatch(/(?:type|interface|enum)\s+(Room|Channel|RocketChat)\b/);
      expect(text).not.toMatch(/git clone.*Rocket\.Chat/);
    }
  });
});
