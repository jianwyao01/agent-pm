import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  UNOBSERVED,
  loadReviewedModel,
  projectDisplay,
  readJson,
  snapshotModelFiles,
  validateAnalysisTree,
  validateDocument,
  validateSemantics,
  type DiffFile,
  type ProductMap
} from "@behavior-map/contracts";
import { generateAll } from "@behavior-map/export";
import {
  applyHumanReview,
  parseReviewCliArgs,
  runReviewCli,
  writeReviewedModel,
  writeRunDiff
} from "@behavior-map/review";
import { applyFirstDeliveryReview, prepareM5Run } from "./helpers/m6-review.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function parseSpec(source: string): readonly ts.Diagnostic[] {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true
    },
    reportDiagnostics: true,
    fileName: "journeys.spec.ts"
  });
  return (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
}

describe("M6 人工审定与四份导出", () => {
  it("把人类审定应用到 M4/M5 夹具提案，写出稳定 journey_id 与首发地图", async () => {
    const root = tmp("bm-m6-first-");
    await prepareM5Run(root, "run-001");
    const model = applyFirstDeliveryReview(root, "run-001");
    writeRunDiff({ analysisRoot: root, runId: "run-001" });
    generateAll(model, root);

    const send = model.journeys.find((item) => item.id === "jny-send-001");
    expect(send).toBeDefined();
    expect(send?.name).toBe("发送一条消息（已审定）");
    expect(send?.status).toBe("accepted");
    const added = model.journeys.find((item) => item.name === "人工补录的同步确认");
    expect(added).toBeDefined();
    expect(added?.status).toBe("accepted");
    expect(model.capabilities.some((item) => item.id === "cap-send" && item.name === "发送")).toBe(true);
    expect(model.decisions.some((item) => item.review_status === "kept" && item.journey_id === "jny-send-001")).toBe(
      true
    );
    expect(model.decisions.some((item) => item.review_status === "rejected")).toBe(true);
    expect(model.surfaces.length).toBeGreaterThan(0);
    expect(model.controls.some((item) => item.id.includes("control-send") || item.action === "send")).toBe(true);

    const kinds = new Set(model.effects.map((item) => item.observation.kind));
    expect(kinds).toEqual(
      new Set([
        "current_surface",
        "other_surface",
        "collection",
        "indicator",
        "notification",
        "backend_operation"
      ])
    );
    const display = projectDisplay(model.journeys, model.effects);
    expect(display.columns).toEqual(["本面", "他面", "列表", "未读", "通知", "后台"]);
    expect(display.columns).toContain("他面");
    const sendRow = display.rows.find((row) => row.journey_id === "jny-send-001");
    expect(sendRow).toBeDefined();
    expect(sendRow?.cells.find((cell) => cell.column === "未读")?.value).toBe(UNOBSERVED);
    expect(sendRow?.cells.find((cell) => cell.column === "通知")?.value).toBe(UNOBSERVED);

    const structural = validateAnalysisTree(root);
    expect(structural.issues).toEqual([]);
    expect(structural.ok).toBe(true);
    const semantic = validateSemantics(root);
    expect(semantic.issues).toEqual([]);
    expect(semantic.ok).toBe(true);
  });

  it("四份导出共用同一 journey_id，Web 可离线打开，Playwright 草稿可被解析", async () => {
    const root = tmp("bm-m6-export-");
    await prepareM5Run(root, "run-001");
    const model = applyFirstDeliveryReview(root, "run-001");
    writeRunDiff({ analysisRoot: root, runId: "run-001" });
    generateAll(model, root);

    const ids = ["jny-send-001"];
    const map = readJson<ProductMap>(join(root, "generated/product-map/product-map.json"));
    expect(map.journey_ids).toContain("jny-send-001");
    expect(validateDocument("product-map", map).ok).toBe(true);

    const prose = readFileSync(join(root, "generated/product-map/product-map.md"), "utf8");
    expect(prose).toMatch(/入口/);
    expect(prose).toMatch(/发送控件/);
    expect(prose).toMatch(/jny-send-001/);
    expect(prose).toMatch(/他面/);
    expect(prose).toMatch(/未观察到/);
    expect(prose).not.toMatch(/已通过|passed against the target/i);

    const mermaid = readFileSync(join(root, "generated/diagrams/journeys.mmd"), "utf8");
    expect(mermaid).toMatch(/flowchart/);
    expect(mermaid).toContain("jny-send-001");
    expect(mermaid).toContain("他面");

    const html = readFileSync(join(root, "generated/web/index.html"), "utf8");
    expect(html).toContain("jny-send-001");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/src=["']\/\//);
    expect(html).not.toMatch(/fonts\.google|cdn\.|unpkg|jsdelivr/i);

    const spec = readFileSync(join(root, "generated/tests/journeys.spec.ts"), "utf8");
    expect(spec).toContain("Journey ID: jny-send-001");
    expect(spec).toContain("import { test } from '@playwright/test'");
    expect(spec).toMatch(/test\.skip|TODO/);
    expect(spec).not.toMatch(/passed against the target/i);
    expect(parseSpec(spec)).toEqual([]);

    for (const kind of ["product-map", "diagrams", "web", "tests"] as const) {
      const manifest = readJson<{ journey_ids: string[] }>(
        join(root, "generated", kind, "journey-ids.json")
      );
      expect(manifest.journey_ids).toEqual(expect.arrayContaining(ids));
      expect(manifest.journey_ids).toEqual(map.journey_ids);
    }
  });

  it("同一 snapshot 二次运行：keep/reject/rename 不变，diff 必填字段齐全，用 stale/not_observed 而不是删除", async () => {
    const root = tmp("bm-m6-rerun-");
    const firstSnap = await prepareM5Run(root, "run-001");
    const first = applyFirstDeliveryReview(root, "run-001");
    writeRunDiff({ analysisRoot: root, runId: "run-001" });
    generateAll(first, root);
    const decisionsAfterFirst = first.decisions.map((item) => ({
      candidate_id: item.candidate_id,
      review_status: item.review_status,
      journey_id: item.journey_id,
      rename: item.rename,
      rejection_reason: item.rejection_reason
    }));
    const sendName = first.journeys.find((item) => item.id === "jny-send-001")?.name;
    const addedId = first.journeys.find((item) => item.name === "人工补录的同步确认")?.id;
    expect(addedId).toBeDefined();
    expect(first.journeys.find((item) => item.id === addedId)?.status).toBe("accepted");
    const unsupportedId = "jny-old-unsupported";
    const seeded = loadReviewedModel(root);
    writeReviewedModel(root, {
      ...seeded,
      journeys: [
        ...seeded.journeys,
        {
          id: unsupportedId,
          name: "旧的无支持旅程",
          status: "accepted",
          effect_ids: []
        }
      ]
    });
    const modelFiles = snapshotModelFiles(root);

    const secondSnap = await prepareM5Run(root, "run-002");
    expect(secondSnap.snapshot).toBe(firstSnap.snapshot);
    expect(readdirSync(join(root, "runs")).sort()).toEqual(["run-001", "run-002"]);
    expect(snapshotModelFiles(root)["review-decisions.yaml"]).toBe(modelFiles["review-decisions.yaml"]);

    const second = applyHumanReview({ analysisRoot: root, runId: "run-002", spec: {} });
    const diff = writeRunDiff({ analysisRoot: root, runId: "run-002" });

    expect(second.journeys.find((item) => item.id === "jny-send-001")?.name).toBe(sendName);
    expect(second.journeys.some((item) => item.id === addedId)).toBe(true);
    expect(second.journeys.find((item) => item.id === addedId)?.status).toBe("accepted");
    expect(second.journeys.some((item) => item.id === unsupportedId)).toBe(true);
    expect(second.journeys.find((item) => item.id === unsupportedId)?.status).toMatch(/stale|not_observed/);
    expect(second.decisions.map((item) => ({
      candidate_id: item.candidate_id,
      review_status: item.review_status,
      journey_id: item.journey_id,
      rename: item.rename,
      rejection_reason: item.rejection_reason
    }))).toEqual(expect.arrayContaining(decisionsAfterFirst));
    expect(second.decisions.filter((item) => item.review_status === "rejected").length).toBeGreaterThan(0);
    expect(second.journeys.map((item) => item.id).sort()).toEqual(
      [...first.journeys.map((item) => item.id), unsupportedId].sort()
    );

    expect(diff.baseline_run_id).toBe("run-001");
    expect(diff.current_run_id).toBe("run-002");
    expect(diff.comparison_mode).toBe("same_snapshot");
    expect(diff.baseline_source).toBe("previous_completed");
    expect(diff.new_proposals?.length).toBeGreaterThan(0);
    expect(diff.new_proposals?.some((item) => item.proposed_journey_names.includes("发送一条消息"))).toBe(true);
    expect(diff.missing_support?.some((item) => item.journey_id === unsupportedId)).toBe(true);
    expect(validateDocument("diff", diff).ok).toBe(true);
    expect(validateSemantics(root).ok).toBe(true);
  });

  it("改基线只能通过显式参数", async () => {
    const root = tmp("bm-m6-base-");
    await prepareM5Run(root, "run-001");
    applyFirstDeliveryReview(root, "run-001");
    writeRunDiff({ analysisRoot: root, runId: "run-001" });
    await prepareM5Run(root, "run-002");
    applyHumanReview({ analysisRoot: root, runId: "run-002", spec: {} });
    writeRunDiff({ analysisRoot: root, runId: "run-002" });
    await prepareM5Run(root, "run-003");
    applyHumanReview({ analysisRoot: root, runId: "run-003", spec: {} });

    const implicit = writeRunDiff({ analysisRoot: root, runId: "run-003" });
    expect(implicit.baseline_run_id).toBe("run-002");
    expect(implicit.baseline_source).toBe("previous_completed");

    const parsed = parseReviewCliArgs(["write-diff", "--analysis", root, "--run", "run-003"]);
    expect(parsed.baselineRunId).toBeUndefined();
    const viaCli = runReviewCli(["write-diff", "--analysis", root, "--run", "run-003"]);
    expect(viaCli.ok).toBe(true);
    const afterCli = readJson<DiffFile>(join(root, "runs/run-003/diff.json"));
    expect(afterCli.baseline_run_id).toBe("run-002");

    expect(() => parseReviewCliArgs(["write-diff", "--analysis", root, "--run", "run-003", "--other-base", "run-001"])).toThrow(
      /--baseline/
    );

    const explicit = writeRunDiff({
      analysisRoot: root,
      runId: "run-003",
      baselineRunId: "run-001"
    });
    expect(explicit.baseline_run_id).toBe("run-001");
    expect(explicit.baseline_source).toBe("explicit");
    expect(validateDocument("diff", explicit).ok).toBe(true);
    expect(validateSemantics(root).ok).toBe(true);

    const explicitCli = runReviewCli([
      "write-diff",
      "--analysis",
      root,
      "--run",
      "run-003",
      "--baseline",
      "run-001"
    ]);
    expect(explicitCli.ok).toBe(true);
    expect(readJson<DiffFile>(join(root, "runs/run-003/diff.json")).baseline_run_id).toBe("run-001");
  });

  it("不克隆 Rocket.Chat，核心不引入 Room/Channel 类型", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const dirs = [
      join(root, "packages/review/src"),
      join(root, "packages/export/src")
    ];
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
        const text = readFileSync(join(dir, name), "utf8");
        expect(text).not.toMatch(/Rocket\.Chat|RocketChat/);
        expect(text).not.toMatch(/(?:type|interface|enum)\s+(Room|Channel|RocketChat)\b/);
      }
    }
  });
});
