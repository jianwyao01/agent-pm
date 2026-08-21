import { join } from "node:path";
import { type ReviewedModel, writeText } from "@behavior-map/contracts";
import { journeyIdsOf, writeManifest } from "./shared.js";

/**
 * 生成可发现的 Playwright spec。M0 只生成，不执行，也不声称测试已通过。
 * 不可靠 locator → test.skip 或 TODO。
 */
export function generateTests(model: ReviewedModel, generatedRoot: string): string {
  const outDir = join(generatedRoot, "tests");
  const blocks = model.journeys.map((journey) => {
    const control = model.controls.find((item) => item.id === journey.control_id);
    const reliable = control?.locator?.reliable === true;
    const locator = control?.locator?.value ?? "unknown";
    if (!reliable) {
      return `// Journey ID: ${journey.id}
test('${journey.id}: ${escapeTs(journey.name)}', async ({ page }) => {
  // TODO: 待人工提供可靠 locator 后再启用
  test.skip(true, 'Unreliable locator: ${escapeTs(locator)}');
  await page.goto('about:blank');
});`;
    }
    return `// Journey ID: ${journey.id}
test('${journey.id}: ${escapeTs(journey.name)}', async ({ page }) => {
  await page.goto('about:blank');
  await page.locator(${JSON.stringify(locator)}).click();
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

function escapeTs(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}
