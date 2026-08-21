import { join } from "node:path";
import { DISPLAY_COLUMNS, type ReviewedModel, writeText } from "@behavior-map/contracts";
import { journeyIdsOf, writeManifest } from "./shared.js";

export function generateDiagrams(model: ReviewedModel, generatedRoot: string): string {
  const outDir = join(generatedRoot, "diagrams");
  const lines = [
    "```mermaid",
    "flowchart LR",
    "  actor[操作者] --> control[SendControl]"
  ];
  for (const column of DISPLAY_COLUMNS) {
    const nodeId = safe(column.observation_kind);
    lines.push(`  control --> ${nodeId}["${column.label}"]`);
  }
  for (const journey of model.journeys) {
    lines.push(`  control --> ${safe(journey.id)}["${escapeLabel(journey.name)}\\n${journey.id}"]`);
    for (const column of DISPLAY_COLUMNS) {
      lines.push(`  ${safe(journey.id)} --> ${safe(column.observation_kind)}`);
    }
  }
  lines.push("```", "");
  const mermaid = `${lines.join("\n")}\n`;
  writeText(join(outDir, "journeys.mmd"), mermaid.replaceAll("```mermaid\n", "").replaceAll("\n```\n", "\n"));
  writeText(join(outDir, "journeys.md"), mermaid);
  writeManifest(outDir, "diagrams", journeyIdsOf(model));
  return mermaid;
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_");
}

function escapeLabel(value: string): string {
  return value.replaceAll('"', "'");
}
