import { join } from "node:path";
import {
  assertDisplayIncludesOtherSurface,
  projectDisplay,
  type ReviewedModel,
  writeJson,
  writeText
} from "@behavior-map/contracts";
import { journeyIdsOf, writeManifest } from "./shared.js";

export function generateWeb(model: ReviewedModel, generatedRoot: string): string {
  const outDir = join(generatedRoot, "web");
  const display = projectDisplay(model.journeys, model.effects);
  assertDisplayIncludesOtherSurface(display);
  const header = display.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const rows = display.rows
    .map((row) => {
      const cells = row.cells
        .map((cell) => `<td>${escapeHtml(cell.value)}</td>`)
        .join("");
      return `<tr><th>${escapeHtml(row.journey_id)}</th>${cells}</tr>`;
    })
    .join("\n");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>行为地图 · 只读投影</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; }
    table { border-collapse: collapse; }
    th, td { border: 1px solid #444; padding: 0.4rem 0.6rem; }
  </style>
</head>
<body>
  <h1>行为地图（离线只读）</h1>
  <p>本页由 reviewed model 生成，不发起网络请求，也不执行测试。</p>
  <table>
    <thead><tr><th>Journey ID</th>${header}</tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
  writeText(join(outDir, "index.html"), html);
  writeJson(join(outDir, "data.json"), { journey_ids: journeyIdsOf(model), display });
  writeManifest(outDir, "web", journeyIdsOf(model));
  return html;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
