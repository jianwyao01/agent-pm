import { join } from "node:path";
import {
  assertDisplayIncludesOtherSurface,
  projectDisplay,
  type ReviewedModel,
  writeJson,
  writeText
} from "@behavior-map/contracts";
import { renderProductMapProse } from "./prose.js";
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
  const journeyList = model.journeys
    .map((journey) => `<li><code>${escapeHtml(journey.id)}</code> ${escapeHtml(journey.name)}</li>`)
    .join("\n");
  const proseHtml = renderProductMapProse(model)
    .split("\n")
    .map((line) => proseLineToHtml(line))
    .join("\n");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>行为地图 · 只读投影</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; color: #222; background: #fff; }
    table { border-collapse: collapse; margin: 1rem 0; }
    th, td { border: 1px solid #444; padding: 0.4rem 0.6rem; }
    code { background: #f4f4f4; padding: 0.1rem 0.3rem; }
    .note { color: #444; }
  </style>
</head>
<body>
  <h1>行为地图（离线只读）</h1>
  <p class="note">本页由 reviewed model 生成。不发起网络请求，不加载外部脚本或样式，也不执行测试。</p>
  <h2>已审定旅程</h2>
  <ul>
${journeyList}
  </ul>
  <table>
    <thead><tr><th>Journey ID</th>${header}</tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <section>
${proseHtml}
  </section>
</body>
</html>
`;
  writeText(join(outDir, "index.html"), html);
  writeJson(join(outDir, "data.json"), { journey_ids: journeyIdsOf(model), display });
  writeManifest(outDir, "web", journeyIdsOf(model));
  return html;
}

function proseLineToHtml(line: string): string {
  if (line.startsWith("# ")) {
    return `<h2>${escapeHtml(line.slice(2))}</h2>`;
  }
  if (line.startsWith("## ")) {
    return `<h3>${escapeHtml(line.slice(3))}</h3>`;
  }
  if (line.startsWith("### ")) {
    return `<h4>${escapeHtml(line.slice(4))}</h4>`;
  }
  if (line.startsWith("- ")) {
    return `<p>${inlineCode(escapeHtml(line.slice(2)))}</p>`;
  }
  if (!line.trim()) {
    return "";
  }
  return `<p>${inlineCode(escapeHtml(line))}</p>`;
}

function inlineCode(value: string): string {
  return value.replaceAll("`", "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
