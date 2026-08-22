import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  hasValidStaticScan,
  promoteMissingControlCandidates,
  readJsonl,
  validateDocument,
  writeJsonl,
  type Binding,
  type Candidate,
  type ObservedControl,
  type RunningProject,
  type StartResult
} from "@behavior-map/contracts";
import { DefaultDiscoveryAdapter, loadControls } from "@behavior-map/discovery";
import { generateAll, generateDiagrams, renderProductMapProse } from "@behavior-map/export";
import { DefaultProjectAdapter } from "@behavior-map/project";
import { applyHumanReview, hydrateModel, writeReviewedModel } from "@behavior-map/review";
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

function toSuccess(result: StartResult): RunningProject {
  expect(result.status).toBe("success");
  if (result.status !== "success") {
    throw new Error("expected success");
  }
  return result.project;
}

function writeJourneyModel(
  dir: string,
  extras: {
    journeyName?: string;
    capabilityName?: string;
    entryUrl?: string;
    steps?: Array<{ binding_id: string; action: "click" | "type" | "submit"; value?: string }>;
    surfaces?: Array<{ id: string; name: string; role?: "current" | "other" | "list" }>;
    annotate?: { affected_parties?: string; combinations?: string; keep_reason?: string };
  } = {}
): void {
  writeReviewedModel(dir, {
    schema_version: SCHEMA_VERSION,
    capabilities: [
      {
        id: "cap-create-item",
        name: extras.capabilityName ?? "创建条目",
        control_ids: ["ctl-one"]
      }
    ],
    journeys: [
      {
        id: "jny-create-item",
        name: extras.journeyName ?? "创建条目",
        status: "accepted",
        effect_ids: [],
        control_id: "ctl-one",
        ...(extras.entryUrl ? { entry_url: extras.entryUrl } : {}),
        ...(extras.steps ? { steps: extras.steps } : {}),
        ...(extras.annotate?.affected_parties
          ? { affected_parties: extras.annotate.affected_parties }
          : {}),
        ...(extras.annotate?.combinations ? { combinations: extras.annotate.combinations } : {}),
        ...(extras.annotate?.keep_reason ? { keep_reason: extras.annotate.keep_reason } : {})
      }
    ],
    effects: [],
    decisions: [],
    surfaces: extras.surfaces ?? [],
    controls: []
  });
}

function writeThreeBindings(runRoot: string): Binding[] {
  const rows: Binding[] = [
    {
      schema_version: SCHEMA_VERSION,
      binding_id: "bind-open",
      control_id: "ctl-one",
      approved_locator: { type: "role", value: "button;name=打开创建" },
      approved_by: "human",
      created_at: "2026-08-22T00:00:00.000Z"
    },
    {
      schema_version: SCHEMA_VERSION,
      binding_id: "bind-name",
      control_id: "ctl-two",
      approved_locator: { type: "role", value: "textbox;name=名称" },
      approved_by: "human",
      created_at: "2026-08-22T00:00:00.000Z"
    },
    {
      schema_version: SCHEMA_VERSION,
      binding_id: "bind-submit",
      control_id: "ctl-three",
      approved_locator: { type: "title", value: "提交条目" },
      approved_by: "human",
      created_at: "2026-08-22T00:00:00.000Z"
    }
  ];
  writeJsonl(join(runRoot, "bindings.jsonl"), rows);
  return rows;
}

function observedControl(id: string, name: string): ObservedControl {
  return {
    schema_version: SCHEMA_VERSION,
    control_id: id,
    surface_id: "surface-target",
    kind: "button",
    observed: { name },
    locator_candidates: [{ type: "role", value: `button;name=${name}` }],
    evidence_refs: ["ev-dump"]
  };
}

function priorCandidate(id: string, key: string, label: string): Candidate {
  return {
    schema_version: SCHEMA_VERSION,
    id,
    kind: "interaction",
    scope_id: "scope-fixture",
    discovered_by: "execute",
    evidence_refs: [],
    execution_status: "executed",
    scope_status: "in_scope",
    review_status: "unreviewed",
    rejection_reason: null,
    discovery_key: key,
    label
  };
}

describe("M17 产品地图八列与控件候选", () => {
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

  it("已接受旅程的三步 Binding locator 按顺序出现在地图正文", () => {
    const dir = tmp("bm-m17-steps-");
    writeJourneyModel(dir, {
      entryUrl: "http://127.0.0.1:9/create",
      steps: [
        { binding_id: "bind-open", action: "click" },
        { binding_id: "bind-name", action: "type", value: "条目甲" },
        { binding_id: "bind-submit", action: "submit" }
      ]
    });
    const runRoot = join(dir, "runs", "run-m17-steps");
    mkdirSync(runRoot, { recursive: true });
    writeThreeBindings(runRoot);
    writeJsonl(join(runRoot, "candidates.jsonl"), []);
    const model = hydrateModel(dir, "run-m17-steps");
    generateAll(model, dir, "run-m17-steps");
    const prose = readFileSync(join(dir, "generated/product-map/product-map.md"), "utf8");
    const openAt = prose.indexOf("button;name=打开创建");
    const nameAt = prose.indexOf("textbox;name=名称");
    const submitAt = prose.indexOf("提交条目");
    expect(openAt).toBeGreaterThan(-1);
    expect(nameAt).toBeGreaterThan(openAt);
    expect(submitAt).toBeGreaterThan(nameAt);
    expect(prose).toMatch(/click role button;name=打开创建/);
    expect(prose).toMatch(/type role textbox;name=名称/);
    expect(prose).toMatch(/submit title 提交条目/);
  });

  it("annotate 写入 MAP-2/7/8；单独的「用户」使 applyHumanReview 失败", () => {
    const dir = tmp("bm-m17-annotate-");
    writeJourneyModel(dir, { entryUrl: "http://127.0.0.1:9/create" });
    const runRoot = join(dir, "runs", "run-m17-ann");
    mkdirSync(runRoot, { recursive: true });
    writeJsonl(join(runRoot, "candidates.jsonl"), []);
    writeJsonl(join(runRoot, "bindings.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-keep",
        control_id: "ctl-one",
        approved_locator: { type: "role", value: "button;name=提交" },
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      }
    ]);

    const annotated = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m17-ann",
      spec: {
        annotate: [
          {
            journey_id: "jny-create-item",
            affected_parties: "作者与审阅者",
            combinations: "打开创建后提交",
            keep_reason: "首条创建路径"
          }
        ]
      }
    });
    expect(annotated.journeys[0]?.affected_parties).toBe("作者与审阅者");
    expect(annotated.journeys[0]?.combinations).toBe("打开创建后提交");
    expect(annotated.journeys[0]?.keep_reason).toBe("首条创建路径");
    expect(annotated.journeys[0]?.status).toBe("accepted");
    generateAll(annotated, dir, "run-m17-ann");
    const prose = readFileSync(join(dir, "generated/product-map/product-map.md"), "utf8");
    expect(prose).toContain("作者与审阅者");
    expect(prose).toContain("打开创建后提交");
    expect(prose).toContain("首条创建路径");

    expect(() =>
      applyHumanReview({
        analysisRoot: dir,
        runId: "run-m17-ann",
        spec: { annotate: [{ journey_id: "jny-create-item", affected_parties: " 用户 " }] }
      })
    ).toThrow(/用户/);
    expect(() =>
      applyHumanReview({
        analysisRoot: dir,
        runId: "run-m17-ann",
        spec: { annotate: [{ journey_id: "jny-missing", keep_reason: "x" }] }
      })
    ).toThrow(/jny-missing/);
  });

  it("省略 annotate 时导出 未识别 / 无 / 未写理由；hydrateModel 不发明这些字段", () => {
    const dir = tmp("bm-m17-omit-");
    writeJourneyModel(dir, { entryUrl: "http://127.0.0.1:9/create" });
    const runRoot = join(dir, "runs", "run-m17-omit");
    mkdirSync(runRoot, { recursive: true });
    writeJsonl(join(runRoot, "candidates.jsonl"), []);
    writeJsonl(join(runRoot, "bindings.jsonl"), [
      {
        schema_version: SCHEMA_VERSION,
        binding_id: "bind-keep",
        control_id: "ctl-one",
        approved_locator: { type: "role", value: "button;name=提交" },
        approved_by: "human",
        created_at: "2026-08-22T00:00:00.000Z"
      }
    ]);
    const applied = applyHumanReview({ analysisRoot: dir, runId: "run-m17-omit", spec: {} });
    expect(applied.journeys[0]?.affected_parties).toBeUndefined();
    expect(applied.journeys[0]?.combinations).toBeUndefined();
    expect(applied.journeys[0]?.keep_reason).toBeUndefined();
    const hydrated = hydrateModel(dir, "run-m17-omit");
    expect(hydrated.journeys[0]?.affected_parties).toBeUndefined();
    expect(hydrated.journeys[0]?.combinations).toBeUndefined();
    expect(hydrated.journeys[0]?.keep_reason).toBeUndefined();
    generateAll(hydrated, dir, "run-m17-omit");
    const prose = readFileSync(join(dir, "generated/product-map/product-map.md"), "utf8");
    expect(prose).toMatch(/受影响方：未识别/);
    expect(prose).toMatch(/组合：无/);
    expect(prose).toMatch(/保留理由：未写理由/);
    expect(prose).not.toMatch(/受影响方：用户$/m);
  });

  it("夹具 explore：每个落盘 Control 以 control:<id> 出现在 candidates.jsonl", async () => {
    const dir = tmp("bm-m17-explore-");
    const sessionDir = tmp("bm-m17-explore-session-");
    copyTwoSurfaceFixture(dir);
    writeTrusted(dir);
    const depPort = await reservePort();
    const appPort = await reservePort();
    const plan = twoSurfacePlan({
      runId: "run-m17-explore",
      depPort,
      appPort,
      confirmation: { status: "confirmed", confirmed_at: "2026-08-22T00:00:00.000Z" }
    });
    writePlanFile(dir, plan);
    const storageState = join(sessionDir, "storageState.json");
    writeStorageState(storageState);
    const discovery = new DefaultDiscoveryAdapter({
      runId: "run-m17-explore",
      analysisRoot: dir,
      sessionRefs: { "secret:session-cookie": storageState }
    });
    const scope = fixtureScope(dir);
    await discovery.scan(workspaceAt(dir), scope);
    const startedResult = await projectAdapter.start(workspaceAt(dir), plan);
    const project = toSuccess(startedResult);
    started.push(project);
    const explored = await discovery.explore(project, fixtureContext(dir, `http://127.0.0.1:${appPort}/`), scope);
    expect(explored.status).toBe("success");
    const runRoot = join(dir, "runs", "run-m17-explore");
    const controls = loadControls(runRoot);
    expect(controls.length).toBeGreaterThan(0);
    const candidates = readJsonl<Candidate>(join(runRoot, "candidates.jsonl"));
    for (const control of controls) {
      const key = `control:${control.control_id}`;
      const row = candidates.find((item) => item.discovery_key === key);
      expect(row, key).toBeTruthy();
      expect(row?.kind).toBe("control");
      expect(row?.review_status).toBe("unreviewed");
      if (control.observed.name) {
        expect(row?.label).toBe(control.observed.name);
      }
    }
  }, 20_000);

  it("加载缺 control 候选的 run 时确定性提升；数量 = controls + 此前非重复候选", () => {
    const dir = tmp("bm-m17-promote-");
    writeJourneyModel(dir);
    const runRoot = join(dir, "runs", "run-m17-promote");
    mkdirSync(join(runRoot, "evidence"), { recursive: true });
    const controls = [
      observedControl("ctl-alpha", "α"),
      observedControl("ctl-beta", "β"),
      observedControl("ctl-gamma", "γ")
    ];
    writeJsonl(join(runRoot, "controls.jsonl"), controls);
    const prior = [
      priorCandidate("cand-prior-1", "interaction:bind-open", "已有交互"),
      priorCandidate("cand-prior-2", "control:ctl-alpha", "α")
    ];
    writeJsonl(join(runRoot, "candidates.jsonl"), prior);
    const before = readJsonl<Candidate>(join(runRoot, "candidates.jsonl"));
    expect(before).toHaveLength(2);
    applyHumanReview({ analysisRoot: dir, runId: "run-m17-promote", spec: {} });
    const afterReview = readJsonl<Candidate>(join(runRoot, "candidates.jsonl"));
    expect(afterReview).toHaveLength(controls.length + 1);
    expect(afterReview.filter((row) => row.discovery_key.startsWith("control:ctl-"))).toHaveLength(3);

    const other = tmp("bm-m17-promote-gen-");
    writeJourneyModel(other);
    const otherRun = join(other, "runs", "run-m17-gen");
    mkdirSync(otherRun, { recursive: true });
    writeJsonl(join(otherRun, "controls.jsonl"), controls);
    writeJsonl(join(otherRun, "candidates.jsonl"), [prior[0]]);
    const model = hydrateModel(other, "run-m17-gen");
    generateAll(model, other, "run-m17-gen");
    const afterGen = readJsonl<Candidate>(join(otherRun, "candidates.jsonl"));
    expect(afterGen).toHaveLength(controls.length + 1);
    expect(promoteMissingControlCandidates(otherRun)).toHaveLength(controls.length + 1);
  });

  it("mermaid 节点不是 SendControl，而是能力或旅程名", () => {
    const dir = tmp("bm-m17-mermaid-");
    writeJourneyModel(dir, { journeyName: "创建条目", capabilityName: "创建条目" });
    const runRoot = join(dir, "runs", "run-m17-mmd");
    mkdirSync(runRoot, { recursive: true });
    writeJsonl(join(runRoot, "candidates.jsonl"), []);
    const model = hydrateModel(dir, "run-m17-mmd");
    generateAll(model, dir, "run-m17-mmd");
    const mermaid = readFileSync(join(dir, "generated/diagrams/journeys.mmd"), "utf8");
    expect(mermaid).not.toContain("SendControl");
    expect(mermaid).toContain("创建条目");
    const only = generateDiagrams(model, join(dir, "generated-only"));
    expect(only).not.toContain("SendControl");
    expect(only).toContain("创建条目");
  });

  it("Surface.name 为撰写面时入口节不印该词，只印 entry_url 或 未识别", () => {
    const withUrl = renderProductMapProse({
      schema_version: SCHEMA_VERSION,
      capabilities: [{ id: "cap-create-item", name: "创建条目", control_ids: ["ctl-one"] }],
      journeys: [
        {
          id: "jny-create-item",
          name: "创建条目",
          status: "accepted",
          effect_ids: [],
          control_id: "ctl-one",
          entry_url: "http://127.0.0.1:9/create"
        }
      ],
      effects: [],
      decisions: [],
      surfaces: [
        { id: "surface-target", name: "撰写面", role: "current" },
        { id: "surface-list", name: "列表面", role: "other" }
      ],
      controls: []
    });
    const entryBlock = withUrl.slice(withUrl.indexOf("## 入口"), withUrl.indexOf("## 创建条目控件"));
    expect(entryBlock).not.toContain("撰写面");
    expect(entryBlock).not.toContain("列表面");
    expect(entryBlock).toContain("http://127.0.0.1:9/create");

    const noUrl = renderProductMapProse({
      schema_version: SCHEMA_VERSION,
      capabilities: [{ id: "cap-create-item", name: "创建条目", control_ids: ["ctl-one"] }],
      journeys: [
        {
          id: "jny-create-item",
          name: "创建条目",
          status: "accepted",
          effect_ids: [],
          control_id: "ctl-one"
        }
      ],
      effects: [],
      decisions: [],
      surfaces: [{ id: "surface-target", name: "撰写面", role: "current" }],
      controls: []
    });
    const noUrlEntry = noUrl.slice(noUrl.indexOf("## 入口"), noUrl.indexOf("## 创建条目控件"));
    expect(noUrlEntry).not.toContain("撰写面");
    expect(noUrlEntry).toContain("未识别");
  });

  it("缺失 / 空 / 仅空白的 static.jsonl 不得视为已扫描", () => {
    const dir = tmp("bm-m17-static-");
    const missing = join(dir, "missing.jsonl");
    expect(hasValidStaticScan(missing)).toBe(false);
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(hasValidStaticScan(empty)).toBe(false);
    const space = join(dir, "space.jsonl");
    writeFileSync(space, "  \n\n  ");
    expect(hasValidStaticScan(space)).toBe(false);
    const valid = join(dir, "valid.jsonl");
    writeJsonl(valid, [
      {
        schema_version: SCHEMA_VERSION,
        id: "ev-static-1",
        immutable: true,
        source: "static",
        kind: "static-source",
        payload: { path: "public/index.html" }
      }
    ]);
    expect(hasValidStaticScan(valid)).toBe(true);
    expect(validateDocument("evidence", readJsonl(valid)[0]).ok).toBe(true);
  });

  it("拒绝 control 候选需要 rejection_reason 且不创建旅程", () => {
    const dir = tmp("bm-m17-reject-");
    writeJourneyModel(dir);
    const runRoot = join(dir, "runs", "run-m17-reject");
    mkdirSync(runRoot, { recursive: true });
    writeJsonl(join(runRoot, "controls.jsonl"), [observedControl("ctl-noise", "噪音")]);
    writeJsonl(join(runRoot, "candidates.jsonl"), []);
    const model = applyHumanReview({
      analysisRoot: dir,
      runId: "run-m17-reject",
      spec: {
        reject: [{ discovery_key: "control:ctl-noise", rejection_reason: "不在本次范围内" }]
      }
    });
    expect(model.journeys.filter((item) => item.id !== "jny-create-item")).toHaveLength(0);
    expect(model.decisions.some((item) => item.review_status === "rejected" && item.rejection_reason)).toBe(
      true
    );
  });

  it("packages/ 不含 Rocket.Chat /channel / study-send / usernameOrEmail / aria-label=Send", () => {
    const packages = join(repoRoot(), "packages");
    for (const file of walkTsJson(packages)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/Rocket\.Chat|RocketChat/);
      expect(text, file).not.toMatch(/\/channel/);
      expect(text, file).not.toMatch(/study-send/);
      expect(text, file).not.toMatch(/usernameOrEmail/);
      expect(text, file).not.toMatch(/aria-label=Send/);
    }
    expect(existsSync(join(repoRoot(), "docs", "M17.md"))).toBe(true);
  });

  it("journeys schema 接受 annotate 字段且 extraProperties 仍关闭", () => {
    const file = {
      schema_version: SCHEMA_VERSION,
      journeys: [
        {
          id: "jny-create-item",
          name: "创建条目",
          status: "accepted",
          effect_ids: [],
          affected_parties: "作者与审阅者",
          combinations: "打开后提交",
          keep_reason: "首条路径"
        }
      ]
    };
    expect(validateDocument("journeys", file).ok).toBe(true);
    expect(
      validateDocument("journeys", {
        schema_version: SCHEMA_VERSION,
        journeys: [
          {
            id: "jny-x",
            name: "x",
            status: "accepted",
            effect_ids: [],
            invented: true
          }
        ]
      }).ok
    ).toBe(false);
  });
});
