import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readYaml, validateDocument } from "@behavior-map/contracts";
import {
  MESSAGE_SYNC_PROBE_PLAN,
  MESSAGE_SYNC_RUN_CONTEXT,
  MESSAGE_SYNC_STUDY,
  readScopeDocuments,
  writeScopeDocuments
} from "@behavior-map/project";

describe("M2 study / probe-plan / run-context", () => {
  it("写入并读回首发 study，通过 schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-m2-scope-"));
    writeScopeDocuments(dir);
    const loaded = readScopeDocuments(dir);

    expect(validateDocument("study", loaded.study).ok).toBe(true);
    expect(validateDocument("probe-plan", loaded.probePlan).ok).toBe(true);
    expect(validateDocument("run-context", loaded.runContext).ok).toBe(true);

    expect(loaded.study).toEqual(MESSAGE_SYNC_STUDY);
    expect(loaded.probePlan).toEqual(MESSAGE_SYNC_PROBE_PLAN);
    expect(loaded.runContext).toEqual(MESSAGE_SYNC_RUN_CONTEXT);

    expect(loaded.study.name).toBe("消息发送与状态同步");
    expect(loaded.study.exploration_mode).toBe("approved_probe");
    expect(loaded.study.entry_seeds).toContain("send-message");
    expect(loaded.study.include_hints.some((hint) => hint.includes("发送一条消息"))).toBe(true);
    expect(loaded.study.include_hints.some((hint) => hint.includes("导航树"))).toBe(true);
    expect(loaded.study.exclude_hints).toEqual(
      expect.arrayContaining(["穷尽导航树", "创建容器", "容器管理", "穷尽私信", "话题串", "管理后台"])
    );
    expect(loaded.study.exclude_hints.join(" ")).not.toMatch(/发送一条消息|send-message/);

    expect(loaded.probePlan.human_approved).toBe(true);
    expect(loaded.probePlan.entry).toBe("nav-tree-open-surface");
    expect(loaded.probePlan.session_slot).toBe("primary");
    expect(loaded.probePlan.target_surface).toBe("surface-target");
    expect(loaded.probePlan.send_action).toBe("control-send");
    expect(loaded.probePlan.other_surfaces_to_refresh.length).toBeGreaterThan(0);

    expect(loaded.runContext.credential_ref).toMatch(/^secret:/);
    expect(loaded.runContext.cookie_ref).toMatch(/^secret:/);
    expect(loaded.runContext.entry_url).toMatch(/^https?:\/\//);
    expect(JSON.stringify(loaded.runContext)).not.toMatch(/password|token/i);

    const studyText = readFileSync(join(dir, "study.yaml"), "utf8");
    expect(studyText).not.toMatch(/\bRoom\b|\bChannel\b|Rocket\.Chat/);
    expect(readYaml(join(dir, "study.yaml"))).toEqual(MESSAGE_SYNC_STUDY);
  });

  it("仓库内 fixtures/m2-message-sync 通过 schema", () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/m2-message-sync");
    const study = readYaml(join(fixture, "study.yaml"));
    const probe = readYaml(join(fixture, "probe-plan.yaml"));
    const context = readYaml(join(fixture, "run-context.yaml"));
    expect(validateDocument("study", study).ok).toBe(true);
    expect(validateDocument("probe-plan", probe).ok).toBe(true);
    expect(validateDocument("run-context", context).ok).toBe(true);
    expect((study as { entry_seeds: string[] }).entry_seeds).toContain("send-message");
  });
});
