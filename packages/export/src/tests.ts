import { join } from "node:path";
import { type ReviewedModel, writeText } from "@behavior-map/contracts";
import { journeyIdsOf, writeManifest } from "./shared.js";

/**
 * 生成可发现的 Playwright spec。M0 只生成，不执行，也不声称测试已通过。
 * 有 steps 时按 approved_locator 顺序发出；无 steps 时沿用 journey.control_id。
 * 只读 model/ 上的 steps、entry_url 与 control locator。禁止默认 #control-send。
 * 有 steps 且有 entry_url 时第一行 page.goto(entry_url)；否则 about:blank。
 * 不可靠 locator → test.skip 或 TODO。
 */
export function generateTests(model: ReviewedModel, generatedRoot: string): string {
  const outDir = join(generatedRoot, "tests");
  const blocks = model.journeys.map((journey) => {
    const goto = gotoTarget(journey);
    const emitted = locatorsForJourney(model, journey);
    if (!emitted.ok) {
      return `// Journey ID: ${journey.id}
test('${journey.id}: ${escapeTs(journey.name)}', async ({ page }) => {
  // TODO: 待人工提供可靠 locator 后再启用
  test.skip(true, 'Unreliable locator: ${escapeTs(emitted.reason)}');
  await page.goto(${goto});
});`;
    }
    const calls = emitted.steps
      .map((step) => playwrightCall(step.kind, step.locator, step.action, step.value))
      .join("\n  ");
    return `// Journey ID: ${journey.id}
test('${journey.id}: ${escapeTs(journey.name)}', async ({ page }) => {
  await page.goto(${goto});
  ${calls}
});`;
  });

  const spec = `import { test } from '@playwright/test';

// 由 reviewed model 生成。本文件可被 Playwright 发现。
// 这是草稿：不运行目标应用，也不报告成功。

${blocks.join("\n\n")}
`;
  writeText(join(outDir, "journeys.spec.ts"), spec);
  writeManifest(outDir, "tests", journeyIdsOf(model));
  return spec;
}

function gotoTarget(journey: ReviewedModel["journeys"][number]): string {
  if (journey.steps && journey.steps.length > 0 && journey.entry_url) {
    return JSON.stringify(journey.entry_url);
  }
  return "'about:blank'";
}

function locatorsForJourney(
  model: ReviewedModel,
  journey: ReviewedModel["journeys"][number]
):
  | {
      ok: true;
      steps: Array<{ kind?: string; locator: string; action: string; value?: string }>;
    }
  | { ok: false; reason: string } {
  if (journey.steps && journey.steps.length > 0) {
    const steps: Array<{ kind?: string; locator: string; action: string; value?: string }> = [];
    for (const step of journey.steps) {
      const control = model.controls.find((item) => item.binding_id === step.binding_id);
      const locator = control?.locator;
      if (!locator || locator.reliable !== true || !locator.value || locator.value === "#control-send") {
        return { ok: false, reason: locator?.value ?? step.binding_id };
      }
      steps.push({
        kind: locator.kind,
        locator: locator.value,
        action: step.action,
        value: step.value
      });
    }
    return { ok: true, steps };
  }
  const control = model.controls.find((item) => item.id === journey.control_id);
  const reliable = control?.locator?.reliable === true;
  const locator = control?.locator?.value ?? "unknown";
  if (!reliable) {
    return { ok: false, reason: locator };
  }
  return {
    ok: true,
    steps: [
      {
        kind: control?.locator?.kind,
        locator,
        action: control?.action ?? "click",
        value: control?.value
      }
    ]
  };
}

function playwrightCall(kind: string | undefined, locator: string, action = "click", value?: string): string {
  const verb = action.trim().toLowerCase() === "type" ? "fill" : "click";
  const suffix =
    verb === "fill" ? `.fill(${JSON.stringify(value ?? "")})` : ".click()";
  if (kind === "role" || kind === "accessibility") {
    const roleName = locator.match(/^(?:role=)?([^;[\]]+);name=(.+)$/);
    if (roleName) {
      return `await page.getByRole(${JSON.stringify(roleName[1].trim())}, { name: ${JSON.stringify(roleName[2].trim())} })${suffix}; // ${JSON.stringify(locator)}`;
    }
  }
  if (kind === "title") {
    return `await page.getByTitle(${JSON.stringify(locator)}, { exact: true })${suffix}; // ${JSON.stringify(locator)}`;
  }
  if (kind === "label") {
    return `await page.getByLabel(${JSON.stringify(locator)}, { exact: true })${suffix}; // ${JSON.stringify(locator)}`;
  }
  return `await page.locator(${JSON.stringify(locator)})${suffix};`;
}

function escapeTs(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}
