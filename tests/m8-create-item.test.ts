import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  loadReviewedModel,
  scopeFromStudy,
  writeJsonl,
  writeYaml,
  type ProbePlan,
  type RunningProject,
  type RunContext,
  type StartResult,
  type Study
} from "@behavior-map/contracts";
import { DefaultDiscoveryAdapter, loadControls } from "@behavior-map/discovery";
import { generateAll, generateTests, renderProductMapProse } from "@behavior-map/export";
import { DefaultProjectAdapter } from "@behavior-map/project";
import { applyHumanReview, hydrateModel, runClosedLoop, writeReviewedModel } from "@behavior-map/review";
import { writePlanFile, writeTrusted, reservePort } from "./helpers/tiny-processes.js";
import {
  copyTwoSurfaceFixture,
  fixtureContext,
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

const CREATE_JOURNEY_ID = "jny-new-item";

function writeCreateStudy(dir: string): Study {
  const study: Study = {
    schema_version: SCHEMA_VERSION,
    id: "study-new-item",
    name: "创建条目",
    goal: "打开创建面，填写名称并提交，观察导航与列表出现新项",
    entry_seeds: ["nav-open-create", "/create"],
    include_hints: ["打开创建面", "名称", "提交创建"],
    exclude_hints: ["穷尽导航树", "发送一条消息", "管理后台", "话题串", "创建容器"],
    exploration_mode: "approved_probe"
  };
  writeYaml(join(dir, "study.yaml"), study);
  return study;
}

function writeCreateProbePlan(dir: string, unique: string): ProbePlan {
  const plan: ProbePlan = {
    schema_version: SCHEMA_VERSION,
    human_approved: true,
    entry: "nav-open-create",
    session_slot: "primary",
    target_surface: "surface-new",
    send_action: "bind-create-submit",
    other_surfaces_to_refresh: ["surface-list"],
    actions: [
      { binding_id: "bind-create-open", action: "click" },
      { binding_id: "bind-create-name", action: "type", value: unique },
      { binding_id: "bind-create-submit", action: "submit" }
    ]
  };
  writeYaml(join(dir, "probe-plan.yaml"), plan);
  return plan;
}

function writeLiveRunContext(dir: string, entryUrl: string): RunContext {
  const context: RunContext = {
    schema_version: SCHEMA_VERSION,
    role: "member",
    locale: "zh-CN",
    flags: [],
    credential_ref: "secret:study-member",
    cookie_ref: "secret:session-cookie",
    entry_url: entryUrl
  };
  writeYaml(join(dir, "run-context.yaml"), context);
  return context;
}

describe("M8 创建面深化域", () => {
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

  it("addJourney 可指定稳定 journey_id；已存在则失败；control_id 必须有人类绑定；拷贝 entry_url 与 steps", () => {
    const dir = tmp("bm-m8-add-");
    writeCreateStudy(dir);
    writeCreateProbePlan(dir, "unit-name");
    writeLiveRunContext(dir, "http://127.0.0.1:4242/");
    writeJsonl(join(dir, "runs", "run-m8-unit", "bindings.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-create-submit",
        control_id: "ctl-create-submit",
        approved_locator: { type: "role", value: "button;name=提交创建" },
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      }
    ]);

    expect(() =>
      applyHumanReview({
        analysisRoot: dir,
        runId: "run-m8-unit",
        spec: { addJourney: [{ journey_id: CREATE_JOURNEY_ID, control_id: "ctl-missing" }] }
      })
    ).toThrow(/补录失败/);

    const added = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m8-unit",
      spec: {
        addJourney: [{ journey_id: CREATE_JOURNEY_ID, control_id: "ctl-create-submit", name: "创建条目" }]
      }
    });
    const journey = added.journeys.find((item) => item.id === CREATE_JOURNEY_ID);
    expect(journey).toBeDefined();
    expect(journey?.status).toBe("accepted");
    expect(journey?.id).not.toBe("jny-send");
    expect(journey?.name).toBe("创建条目");
    expect(journey?.control_id).toBe("ctl-create-submit");
    expect(added.capabilities.some((item) => item.name === "发送" || item.id === "cap-send")).toBe(false);
    expect(added.capabilities.some((item) => item.name === "创建条目")).toBe(true);
    expect(journey?.entry_url).toBe("http://127.0.0.1:4242/");
    expect(journey?.steps).toEqual([
      { binding_id: "bind-create-open", action: "click" },
      { binding_id: "bind-create-name", action: "type", value: "unit-name" },
      { binding_id: "bind-create-submit", action: "submit" }
    ]);

    expect(() =>
      applyHumanReview({
        analysisRoot: dir,
        runId: "run-m8-unit",
        spec: { addJourney: [{ journey_id: CREATE_JOURNEY_ID, control_id: "ctl-create-submit" }] }
      })
    ).toThrow(/已存在/);
  });

  it("兼容单个 addJourney 对象；retarget 也拷贝 entry_url；hydrateModel 不发明 entry_url", () => {
    const dir = tmp("bm-m8-legacy-");
    writeCreateStudy(dir);
    writeCreateProbePlan(dir, "legacy");
    writeLiveRunContext(dir, "http://127.0.0.1:4343/");
    writeJsonl(join(dir, "runs", "run-m8-legacy", "bindings.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-create-submit",
        control_id: "ctl-create-submit",
        approved_locator: { type: "role", value: "button;name=提交创建" },
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      }
    ]);

    const seeded = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m8-legacy",
      spec: { addJourney: { name: "绑定创建", control_id: "control-create-submit" } }
    });
    const journey = seeded.journeys.find((item) => item.name === "绑定创建");
    expect(journey).toBeDefined();
    expect(journey?.id).not.toBe("jny-send");
    expect(journey?.entry_url).toBe("http://127.0.0.1:4343/");

    const retargeted = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m8-legacy",
      spec: { retarget: [{ journey_id: journey!.id, control_id: "ctl-create-submit" }] }
    });
    const after = retargeted.journeys.find((item) => item.id === journey!.id);
    expect(after?.control_id).toBe("ctl-create-submit");
    expect(after?.entry_url).toBe("http://127.0.0.1:4343/");
    expect(after?.status).toBe("accepted");

    const stripped = {
      ...after!,
      entry_url: undefined
    };
    delete stripped.entry_url;
    const hydrated = hydrateModel(dir, "run-m8-legacy", {
      ...retargeted,
      journeys: [{ ...stripped }]
    });
    expect(hydrated.journeys[0]?.entry_url).toBeUndefined();
  });

  it("generateTests：有 steps+entry_url 则 goto 该 url；无 entry_url 则 about:blank；不读 yaml", () => {
    const exportTests = readFileSync(join(repoRoot(), "packages/export/src/tests.ts"), "utf8");
    expect(exportTests).not.toMatch(/probe-plan\.yaml/);
    expect(exportTests).not.toMatch(/run-context\.yaml/);

    const withUrl = generateTests(
      {
        schema_version: SCHEMA_VERSION,
        capabilities: [],
        journeys: [
          {
            id: CREATE_JOURNEY_ID,
            name: "创建条目",
            status: "accepted",
            effect_ids: [],
            control_id: "ctl-create-submit",
            entry_url: "http://127.0.0.1:5555/",
            steps: [
              { binding_id: "bind-create-open", action: "click" },
              { binding_id: "bind-create-name", action: "type", value: "n1" },
              { binding_id: "bind-create-submit", action: "submit" }
            ]
          }
        ],
        effects: [],
        decisions: [],
        surfaces: [],
        controls: [
          {
            id: "ctl-open",
            surface_id: "surface-list",
            name: "打开创建面",
            action: "click",
            binding_id: "bind-create-open",
            locator: { kind: "role", value: "button;name=打开创建面", reliable: true }
          },
          {
            id: "ctl-name",
            surface_id: "surface-new",
            name: "名称",
            action: "type",
            binding_id: "bind-create-name",
            locator: { kind: "role", value: "textbox;name=名称", reliable: true }
          },
          {
            id: "ctl-create-submit",
            surface_id: "surface-new",
            name: "提交创建",
            action: "submit",
            binding_id: "bind-create-submit",
            locator: { kind: "role", value: "button;name=提交创建", reliable: true }
          }
        ]
      },
      tmp("bm-m8-gen-")
    );
    expect(withUrl).toContain('page.goto("http://127.0.0.1:5555/")');
    expect(withUrl).toContain("button;name=打开创建面");
    expect(withUrl).toContain("textbox;name=名称");
    expect(withUrl).toContain("button;name=提交创建");
    expect(withUrl).not.toContain("about:blank");
    expect(withUrl).not.toContain("#control-send");

    const noUrl = generateTests(
      {
        schema_version: SCHEMA_VERSION,
        capabilities: [],
        journeys: [
          {
            id: CREATE_JOURNEY_ID,
            name: "创建条目",
            status: "accepted",
            effect_ids: [],
            steps: [{ binding_id: "bind-create-submit", action: "submit" }]
          }
        ],
        effects: [],
        decisions: [],
        surfaces: [],
        controls: [
          {
            id: "ctl-create-submit",
            surface_id: "surface-new",
            name: "提交创建",
            action: "submit",
            binding_id: "bind-create-submit",
            locator: { kind: "role", value: "button;name=提交创建", reliable: true }
          }
        ]
      },
      tmp("bm-m8-gen-blank-")
    );
    expect(noUrl).toContain("page.goto('about:blank')");
  });

  it("storageState 绕过登录；runClosedLoop 创建条目；journey_id 不是 jny-send；spec 含批准序列与 goto entry_url", async () => {
    const dir = tmp("bm-m8-");
    const sessionDir = tmp("bm-m8-session-");
    copyTwoSurfaceFixture(dir);
    writeTrusted(dir);
    const unique = `m8-new-${Date.now().toString(36)}`;
    const study = writeCreateStudy(dir);
    writeCreateProbePlan(dir, unique);

    const depPort = await reservePort();
    const appPort = await reservePort();
    const entryUrl = `http://127.0.0.1:${appPort}/`;
    writeLiveRunContext(dir, entryUrl);
    const plan = twoSurfacePlan({
      runId: "run-m8",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-22T00:00:00.000Z" }
    });
    writePlanFile(dir, plan);
    const storageState = join(sessionDir, "storageState.json");
    writeStorageState(storageState);

    const scope = scopeFromStudy(study, "scope-new-item");
    const discovery = new DefaultDiscoveryAdapter({
      runId: "run-m8",
      analysisRoot: dir,
      sessionRefs: { "secret:session-cookie": storageState },
      scope
    });
    await discovery.scan(workspaceAt(dir), scope);

    const startedResult = await projectAdapter.start(workspaceAt(dir), plan);
    const project = toSuccess(startedResult);
    started.push(project);

    const liveContext = fixtureContext(dir, entryUrl);
    const explored = await discovery.explore(project, liveContext, scope);
    expect(explored.status).toBe("success");

    const runRoot = join(dir, "runs", "run-m8");
    const controls = loadControls(runRoot);
    const openCreate = controls.find(
      (row) => row.observed.name === "打开创建面" || row.observed.name === "打开创建入口"
    );
    const nameField = controls.find((row) => row.observed.name === "名称");
    const submitCreate = controls.find(
      (row) => row.observed.name === "提交创建" || row.observed.name === "提交"
    );
    expect(openCreate).toBeTruthy();
    expect(nameField).toBeTruthy();
    expect(submitCreate).toBeTruthy();

    const openLocator = { type: "role" as const, value: "button;name=打开创建面" };
    const nameLocator = { type: "role" as const, value: "textbox;name=名称" };
    const submitLocator = { type: "role" as const, value: "button;name=提交创建" };
    writeJsonl(join(runRoot, "bindings.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-create-open",
        control_id: openCreate!.control_id,
        approved_locator: openLocator,
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      },
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-create-name",
        control_id: nameField!.control_id,
        approved_locator: nameLocator,
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      },
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-create-submit",
        control_id: submitCreate!.control_id,
        approved_locator: submitLocator,
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      }
    ]);
    expect(openLocator.value).not.toContain("#control-send");
    expect(nameLocator.value).not.toContain("#control-send");
    expect(submitLocator.value).not.toContain("#control-send");

    const createdBefore = (await fetch(`http://127.0.0.1:${appPort}/api/created`).then((res) =>
      res.json()
    )) as Array<{ name: string }>;

    const closed = await runClosedLoop({
      analysisRoot: dir,
      runId: "run-m8",
      project,
      context: liveContext,
      sessionRefs: { "secret:session-cookie": storageState },
      scope,
      reviewSpec: {
        addJourney: [{ journey_id: CREATE_JOURNEY_ID, control_id: submitCreate!.control_id, name: "创建条目" }]
      }
    });

    expect(closed.played).toHaveLength(3);
    expect(closed.played.every((row) => row.status === "success")).toBe(true);

    const createdAfter = (await fetch(`http://127.0.0.1:${appPort}/api/created`).then((res) =>
      res.json()
    )) as Array<{ name: string }>;
    expect(createdAfter.length).toBeGreaterThan(createdBefore.length);
    expect(createdAfter.some((item) => item.name.includes(unique))).toBe(true);

    const itemsAfter = (await fetch(`http://127.0.0.1:${appPort}/api/items`).then((res) =>
      res.json()
    )) as Array<{ text: string }>;
    expect(itemsAfter.some((item) => item.text.includes(unique))).toBe(true);

    const loginPosted = await fetch(`http://127.0.0.1:${appPort}/debug/login-posted`).then((res) =>
      res.json()
    );
    expect(loginPosted.posted).toBe(false);

    const journey = closed.model.journeys.find((item) => item.id === CREATE_JOURNEY_ID);
    expect(journey).toBeDefined();
    expect(journey?.status).toBe("accepted");
    expect(journey?.id).toBe(CREATE_JOURNEY_ID);
    expect(journey?.id).not.toBe("jny-send");
    expect(closed.model.journeys.some((item) => item.id === "jny-send")).toBe(false);
    expect(closed.model.capabilities.some((item) => item.name === "发送" || item.id === "cap-send")).toBe(
      false
    );
    expect(closed.model.capabilities.some((item) => item.name === "创建条目")).toBe(true);
    expect(journey?.control_id).toBe(submitCreate!.control_id);
    expect(journey?.entry_url).toBe(entryUrl);
    expect(journey?.steps).toEqual([
      { binding_id: "bind-create-open", action: "click" },
      { binding_id: "bind-create-name", action: "type", value: unique },
      { binding_id: "bind-create-submit", action: "submit" }
    ]);

    const spec = readFileSync(join(dir, "generated/tests/journeys.spec.ts"), "utf8");
    expect(closed.generatedPaths.some((path) => path.endsWith("journeys.spec.ts"))).toBe(true);
    expect(spec).toContain(`page.goto(${JSON.stringify(entryUrl)})`);
    expect(spec).toContain(openLocator.value);
    expect(spec).toContain(nameLocator.value);
    expect(spec).toContain(submitLocator.value);
    const openAt = spec.indexOf(openLocator.value);
    const nameAt = spec.indexOf(nameLocator.value);
    const submitAt = spec.indexOf(submitLocator.value);
    expect(openAt).toBeGreaterThan(-1);
    expect(nameAt).toBeGreaterThan(openAt);
    expect(submitAt).toBeGreaterThan(nameAt);
    expect(spec).toMatch(/getByRole\("button".*name:\s*"打开创建面"/);
    expect(spec).toMatch(/getByRole\("textbox".*name:\s*"名称"/);
    expect(spec).toMatch(/getByRole\("button".*name:\s*"提交创建"/);
    expect(spec).toMatch(/\.fill\(/);
    expect(spec).not.toContain("#control-send");
    expect(spec).not.toContain("about:blank");

    const mapMd = readFileSync(join(dir, "generated/product-map/product-map.md"), "utf8");
    expect(mapMd).toContain("## 创建条目控件");
    expect(mapMd).toContain("## 已接受的创建条目旅程");
    expect(mapMd).not.toMatch(/## 发送控件/);
    expect(mapMd).not.toMatch(/已接受的发送旅程/);
  }, 80_000);

  it("retarget 重写挂在该 control_id 上的 leftover cap-send；能力名不是 发送；旅程 accepted；地图标题跟随能力名", () => {
    const dir = tmp("bm-m8c-leftover-");
    writeCreateStudy(dir);
    writeCreateProbePlan(dir, "leftover-name");
    writeLiveRunContext(dir, "http://127.0.0.1:4545/");
    writeJsonl(join(dir, "runs", "run-m8c", "bindings.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-create-submit",
        control_id: "ctl-create-submit",
        approved_locator: { type: "role", value: "button;name=提交创建" },
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      }
    ]);
    writeReviewedModel(dir, {
      schema_version: SCHEMA_VERSION,
      capabilities: [
        { id: "cap-send", name: "发送", control_ids: ["ctl-create-submit"] },
        { id: "cap-other", name: "其它能力", control_ids: ["ctl-unrelated"] }
      ],
      journeys: [
        {
          id: CREATE_JOURNEY_ID,
          name: "创建条目",
          status: "accepted",
          effect_ids: [],
          control_id: "ctl-create-submit"
        }
      ],
      effects: [],
      decisions: [
        {
          candidate_id: `human-added:${CREATE_JOURNEY_ID}`,
          review_status: "kept",
          journey_id: CREATE_JOURNEY_ID
        }
      ],
      surfaces: [],
      controls: []
    });

    const retargeted = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m8c",
      spec: { retarget: [{ journey_id: CREATE_JOURNEY_ID, control_id: "ctl-create-submit" }] }
    });
    const journey = retargeted.journeys.find((item) => item.id === CREATE_JOURNEY_ID);
    expect(journey?.status).toBe("accepted");
    const attached = retargeted.capabilities.filter((item) => item.control_ids.includes("ctl-create-submit"));
    expect(attached.length).toBeGreaterThan(0);
    expect(attached.every((item) => item.name !== "发送")).toBe(true);
    expect(retargeted.capabilities.some((item) => item.name === "创建条目")).toBe(true);
    expect(
      retargeted.capabilities.some((item) => item.id === "cap-other" && item.name === "其它能力")
    ).toBe(true);
    expect(
      retargeted.capabilities.some(
        (item) => item.id === "cap-send" && item.control_ids.includes("ctl-create-submit")
      )
    ).toBe(false);

    generateAll(retargeted, dir);
    const mapMd = readFileSync(join(dir, "generated/product-map/product-map.md"), "utf8");
    expect(mapMd).toContain("## 创建条目控件");
    expect(mapMd).toContain("## 已接受的创建条目旅程");
    expect(mapMd).not.toMatch(/## 发送控件/);
    expect(mapMd).not.toMatch(/已接受的发送旅程/);
  });

  it("发送旅程 retarget 后仍可 cap-send / 发送；地图标题仍写 发送", () => {
    const dir = tmp("bm-m8c-send-");
    writeCreateStudy(dir);
    writeCreateProbePlan(dir, "send-keep");
    writeLiveRunContext(dir, "http://127.0.0.1:4646/");
    writeJsonl(join(dir, "runs", "run-m8c-send", "bindings.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-send",
        control_id: "ctl-send",
        approved_locator: { type: "role", value: "button;name=发送一条消息" },
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      }
    ]);
    writeReviewedModel(dir, {
      schema_version: SCHEMA_VERSION,
      capabilities: [{ id: "cap-send", name: "发送", control_ids: ["ctl-send"] }],
      journeys: [
        {
          id: "jny-send",
          name: "发送",
          status: "accepted",
          effect_ids: [],
          control_id: "ctl-send"
        }
      ],
      effects: [],
      decisions: [
        {
          candidate_id: "human-added:jny-send",
          review_status: "kept",
          journey_id: "jny-send"
        }
      ],
      surfaces: [],
      controls: []
    });

    const retargeted = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m8c-send",
      spec: { retarget: [{ journey_id: "jny-send", control_id: "ctl-send" }] }
    });
    expect(retargeted.journeys.find((item) => item.id === "jny-send")?.status).toBe("accepted");
    expect(retargeted.capabilities.some((item) => item.id === "cap-send" && item.name === "发送")).toBe(true);

    generateAll(retargeted, dir);
    const mapMd = readFileSync(join(dir, "generated/product-map/product-map.md"), "utf8");
    expect(mapMd).toContain("## 发送控件");
    expect(mapMd).toContain("## 已接受的发送旅程");
  });

  it("地图 markdown 标题跟随旅程或能力名；创建条目不得焊死 发送", () => {
    const createMap = renderProductMapProse({
      schema_version: SCHEMA_VERSION,
      capabilities: [{ id: "cap-new-item", name: "创建条目", control_ids: ["ctl-create-submit"] }],
      journeys: [
        {
          id: CREATE_JOURNEY_ID,
          name: "创建条目",
          status: "accepted",
          effect_ids: [],
          control_id: "ctl-create-submit"
        }
      ],
      effects: [],
      decisions: [],
      surfaces: [],
      controls: []
    });
    expect(createMap).toContain("## 创建条目控件");
    expect(createMap).toContain("## 已接受的创建条目旅程");
    expect(createMap).not.toMatch(/## 发送控件/);
    expect(createMap).not.toMatch(/已接受的发送旅程/);

    const sendMap = renderProductMapProse({
      schema_version: SCHEMA_VERSION,
      capabilities: [{ id: "cap-send", name: "发送", control_ids: ["control-send"] }],
      journeys: [
        {
          id: "jny-send",
          name: "发送一条消息（已审定）",
          status: "accepted",
          effect_ids: [],
          control_id: "control-send"
        }
      ],
      effects: [],
      decisions: [],
      surfaces: [],
      controls: []
    });
    expect(sendMap).toContain("## 发送控件");
    expect(sendMap).toContain("## 已接受的发送旅程");
  });

  it("同一 applyHumanReview：addJourney/retarget 保持 accepted；候选不必等于 ctl-*-obs；无支持的旧旅程标 stale", () => {
    const dir = tmp("bm-m8b-obs-");
    writeCreateStudy(dir);
    writeCreateProbePlan(dir, "obs-name");
    writeLiveRunContext(dir, "http://127.0.0.1:4444/");
    const humanControl = "ctl-9f3c1a2b0d4e5f67-obs";
    writeJsonl(join(dir, "runs", "run-m8b-obs", "candidates.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        id: "cand-scan-create",
        kind: "control",
        scope_id: "scope-new-item",
        discovered_by: "scan",
        evidence_refs: [],
        execution_status: "observed",
        scope_status: "in_scope",
        review_status: "unreviewed",
        rejection_reason: null,
        discovery_key: "control:public/create.html:control-create-submit",
        label: "提交创建"
      }
    ]);
    writeJsonl(join(dir, "runs", "run-m8b-obs", "bindings.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-create-submit",
        control_id: humanControl,
        approved_locator: { type: "role", value: "button;name=提交创建" },
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      }
    ]);

    const added = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m8b-obs",
      spec: {
        addJourney: [{ journey_id: CREATE_JOURNEY_ID, control_id: humanControl, name: "创建条目" }]
      }
    });
    const created = added.journeys.find((item) => item.id === CREATE_JOURNEY_ID);
    expect(created?.status).toBe("accepted");
    expect(created?.control_id).toBe(humanControl);
    expect(added.capabilities.some((item) => item.name === "发送")).toBe(false);

    const retargeted = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m8b-obs",
      spec: { retarget: [{ journey_id: CREATE_JOURNEY_ID, control_id: humanControl }] }
    });
    expect(retargeted.journeys.find((item) => item.id === CREATE_JOURNEY_ID)?.status).toBe("accepted");

    const existing = loadReviewedModel(dir);
    writeReviewedModel(dir, {
      ...existing,
      journeys: [
        ...existing.journeys,
        {
          id: "jny-old-unsupported",
          name: "旧的无支持旅程",
          status: "accepted",
          effect_ids: []
        }
      ]
    });
    const after = applyHumanReview({ analysisRoot: dir, runId: "run-m8b-obs", spec: {} });
    expect(after.journeys.find((item) => item.id === CREATE_JOURNEY_ID)?.status).toBe("accepted");
    expect(after.journeys.find((item) => item.id === "jny-old-unsupported")?.status).toBe("stale");
  });

  it("packages/ 不把产品域名词当核心类型，也不写死创建/发送选择器", () => {
    const packages = join(repoRoot(), "packages");
    for (const file of walkTsJson(packages)) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/Rocket\.Chat|RocketChat/);
      expect(text).not.toMatch(/(?:type|interface|enum)\s+(Room|Channel|RocketChat)\b/);
      expect(text).not.toMatch(/usernameOrEmail/);
      expect(text).not.toMatch(/\/channel\//);
      expect(text).not.toMatch(/study-send/);
      expect(text).not.toMatch(/aria-label\s*=\s*Send\b/);
      expect(text).not.toMatch(/create-surface/);
      expect(text).not.toMatch(/jny-create-channel/);
    }
    expect(existsSync(join(repoRoot(), "docs/M8.md"))).toBe(true);
    expect(existsSync(join(repoRoot(), "docs/M8b.md"))).toBe(true);
    expect(existsSync(join(repoRoot(), "docs/M8c.md"))).toBe(true);
  });
});
