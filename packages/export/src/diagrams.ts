import { join } from "node:path";
import { type ReviewedModel, writeText } from "@behavior-map/contracts";
import { journeyIdsOf, writeManifest } from "./shared.js";

export function generateDiagrams(model: ReviewedModel, generatedRoot: string): string {
  const outDir = join(generatedRoot, "diagrams");
  const lines = [
    "```mermaid",
    "flowchart LR",
    "  actor[Actor] --> control[SendControl]",
    "  control --> current[CurrentSurface]",
    "  control --> other[OtherSurface]",
    "  control --> backend[BackendOperation]"
  ];
  for (const journey of model.journeys) {
    lines.push(`  control --> ${safe(journey.id)}["${escapeLabel(journey.name)}\\n${journey.id}"]`);
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
