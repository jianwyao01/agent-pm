import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  assertPlanConfirmed,
  readYaml,
  validateDocument,
  validateRunPlanShape,
  writeYaml,
  type ProjectAdapter,
  type ProjectProfile,
  type RunPlan,
  type Workspace
} from "@behavior-map/contracts";
import { DefaultProjectAdapter } from "@behavior-map/project";
import { DefaultSourceProvider } from "@behavior-map/source";
import { createMeteorComposeFixture } from "./helpers/meteor-compose.js";
import { createTinyGitRepo } from "./helpers/tiny-git.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function workspace(path: string): Workspace {
  return { path, read_only: true };
}

describe("M2 ProjectAdapter", () => {
  it("detect() 把 meteor + compose mongo 列为 app 与 database 两个 part", async () => {
    const dir = tmp("bm-m2-meteor-");
    createMeteorComposeFixture(dir);
    const adapter: ProjectAdapter = new DefaultProjectAdapter();
    const profile = await adapter.detect(workspace(dir));

    expect(validateDocument("project-profile", profile).ok).toBe(true);
    expect(profile).not.toHaveProperty("projectType");
    expect(profile).not.toHaveProperty("detected_kind");
    expect(profile.parts.map((part) => part.role).sort()).toEqual(["app", "database"]);
    expect(profile.parts.map((part) => part.id).sort()).toEqual(["app", "database"]);
    expect(profile.frameworks).toEqual(expect.arrayContaining(["meteor", "docker-compose", "mongo"]));
    expect(profile.how_to_run.some((clue) => /meteor/i.test(clue.hint))).toBe(true);
    expect(profile.how_to_run.some((clue) => /docker compose/i.test(clue.hint))).toBe(true);
    expect(JSON.stringify(profile)).not.toMatch(/Rocket\.Chat|RocketChat/i);
  });

  it("createRunPlan() 产出 ≥2 组件，各有 healthcheck / start_order，database 先于 app", async () => {
    const dir = tmp("bm-m2-plan-");
    createMeteorComposeFixture(dir);
    const adapter = new DefaultProjectAdapter();
    const profile = await adapter.detect(workspace(dir));
    const plan = await adapter.createRunPlan(workspace(dir), profile);

    expect(plan.components.length).toBeGreaterThanOrEqual(2);
    expect(plan.confirmation.status).toBe("draft");
    expect(plan.components.every((component) => component.role !== "healthcheck")).toBe(true);
    expect(plan.components.every((component) => component.healthcheck && component.logs)).toBe(true);
    expect(plan.components.every((component) => component.seed.status === "not_done")).toBe(true);

    const app = plan.components.find((component) => component.role === "app");
    const database = plan.components.find((component) => component.role === "database");
    expect(app).toBeTruthy();
    expect(database).toBeTruthy();
    expect(database!.start_order).toBeLessThan(app!.start_order);
    expect(app!.depends_on).toContain(database!.id);

    const report = validateDocument("run-plan", plan);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);

    const planFile = join(dir, "run-plan.yaml");
    writeYaml(planFile, plan);
    expect(validateDocument("run-plan", readYaml(planFile), planFile).ok).toBe(true);
  });

  it("校验器拒绝仅含一条启动命令与一个健康 URL 的 plan", () => {
    const flat = {
      schema_version: SCHEMA_VERSION,
      start: "npm start",
      health_url: "http://localhost:3000"
    };
    const shape = validateRunPlanShape(flat);
    expect(shape.ok).toBe(false);
    expect(shape.issues.some((issue) => issue.code === "flat_start_health")).toBe(true);
    expect(validateDocument("run-plan", flat).ok).toBe(false);

    const sparse = {
      schema_version: SCHEMA_VERSION,
      secret_refs: [],
      confirmation: { status: "draft" },
      components: [
        {
          id: "app",
          start: "meteor",
          healthcheck: { url: "http://localhost:3000" }
        }
      ]
    };
    expect(validateRunPlanShape(sparse).issues.some((issue) => issue.code === "flat_start_health")).toBe(
      true
    );
  });

  it("M1 本地 git 夹具仍可 detect，且不需要克隆产品仓库", async () => {
    const repo = tmp("bm-m2-git-");
    const commit = await createTinyGitRepo(repo);
    const source = new DefaultSourceProvider({ workspaceRoot: tmp("bm-m2-src-") });
    const prepared = await source.prepare({ kind: "local", locator: repo });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(prepared.snapshot.id).toBe(commit);

    const adapter = new DefaultProjectAdapter();
    const profile = await adapter.detect(prepared.workspace);
    expect(profile.schema_version).toBe(SCHEMA_VERSION);
    expect(Array.isArray(profile.faces)).toBe(true);
    expect(Array.isArray(profile.parts)).toBe(true);
    expect(JSON.stringify(profile)).not.toMatch(/RocketChat\/Rocket\.Chat|github\.com\/RocketChat/i);
  });

  it("draft run-plan 被 assertPlanConfirmed 拒绝，confirmed 通过", async () => {
    const dir = tmp("bm-m2-confirm-");
    createMeteorComposeFixture(dir);
    const adapter = new DefaultProjectAdapter();
    const profile = await adapter.detect(workspace(dir));
    const draft = await adapter.createRunPlan(workspace(dir), profile);
    expect(() => assertPlanConfirmed(draft)).toThrow(/draft/i);

    const confirmed: RunPlan = {
      ...draft,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-21T00:00:00.000Z" }
    };
    expect(() => assertPlanConfirmed(confirmed)).not.toThrow();
  });

  it("start/stop 接口存在，draft plan 不得当作 success", async () => {
    const adapter = new DefaultProjectAdapter();
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.stop).toBe("function");
    expect(typeof adapter.detect).toBe("function");
    expect(typeof adapter.createRunPlan).toBe("function");

    const started = await adapter.start(workspace(tmp("bm-m2-start-")), {
      schema_version: SCHEMA_VERSION,
      secret_refs: [],
      components: [],
      confirmation: { status: "draft" }
    });
    expect(started.status).toBe("failed-runtime");
    expect("project" in started).toBe(false);
    expect(started.gaps.some((gap) => gap.reason === "plan_not_confirmed")).toBe(true);
  });

  it("run-plan.yaml 出现 password: 明文则 schema/校验失败", () => {
    const file = join(tmp("bm-m2-secret-"), "run-plan.yaml");
    writeYaml(file, {
      schema_version: SCHEMA_VERSION,
      secret_refs: [],
      confirmation: { status: "draft" },
      components: [
        {
          id: "app",
          role: "app",
          depends_on: [],
          install: { command: "npm install" },
          start_order: 1,
          healthcheck: { kind: "http", url: "http://localhost:3000" },
          logs: "logs/app.log",
          seed: { status: "not_done" },
          password: "hunter2"
        }
      ]
    });
    expect(readFileSync(file, "utf8")).toMatch(/password:/);
    const report = validateDocument("run-plan", readYaml(file), file);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes("明文"))).toBe(true);
  });

  it("ProjectProfile 以 faces/parts/frameworks 描述，不用 projectType 主键", () => {
    const profile: ProjectProfile = {
      schema_version: SCHEMA_VERSION,
      faces: [{ id: "web", name: "web" }],
      parts: [{ id: "app", role: "app" }],
      frameworks: ["node"],
      how_to_run: [{ source: "package.json", hint: "npm start" }]
    };
    expect(profile).not.toHaveProperty("projectType");
    expect(validateDocument("project-profile", profile).ok).toBe(true);
    expect(validateDocument("project-profile", { ...profile, projectType: "meteor" }).ok).toBe(false);
  });

  it("实现与夹具辅助不包含产品仓库克隆 URL", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = [
      ...readdirSync(join(root, "packages/project/src"))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(root, "packages/project/src", name)),
      join(root, "tests/helpers/meteor-compose.ts"),
      join(root, "tests/helpers/tiny-git.ts"),
      join(root, "tests/helpers/fake-walk.ts")
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/github\.com\/RocketChat\/Rocket\.Chat/);
      expect(text).not.toMatch(/RocketChat\/Rocket\.Chat/);
    }
  });
});
