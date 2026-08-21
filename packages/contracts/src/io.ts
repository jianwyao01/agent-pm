import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import type {
  CapabilitiesFile,
  EffectsFile,
  JourneysFile,
  ReviewDecisionsFile,
  ReviewedModel
} from "./types.js";
import { SCHEMA_VERSION as VERSION } from "./types.js";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeText(file: string, contents: string): void {
  ensureDir(dirname(file));
  writeFileSync(file, contents, "utf8");
}

export function readText(file: string): string {
  return readFileSync(file, "utf8");
}

export function writeJson(file: string, data: unknown): void {
  writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJson<T>(file: string): T {
  return JSON.parse(readText(file)) as T;
}

export function writeYaml(file: string, data: unknown): void {
  writeText(file, yaml.dump(data, { lineWidth: 100, noRefs: true }));
}

export function readYaml<T>(file: string): T {
  return yaml.load(readText(file)) as T;
}

export function writeJsonl(file: string, rows: unknown[]): void {
  writeText(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) {
    return [];
  }
  return readText(file)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function listRunIds(analysisRoot: string): string[] {
  const runsDir = join(analysisRoot, "runs");
  if (!existsSync(runsDir)) {
    return [];
  }
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadReviewedModel(analysisRoot: string): ReviewedModel {
  const capabilities = existsSync(join(analysisRoot, "model", "capabilities.yaml"))
    ? readYaml<CapabilitiesFile>(join(analysisRoot, "model", "capabilities.yaml"))
    : { schema_version: VERSION, capabilities: [] };
  const journeys = existsSync(join(analysisRoot, "model", "journeys.yaml"))
    ? readYaml<JourneysFile>(join(analysisRoot, "model", "journeys.yaml"))
    : { schema_version: VERSION, journeys: [] };
  const effects = existsSync(join(analysisRoot, "model", "effects.yaml"))
    ? readYaml<EffectsFile>(join(analysisRoot, "model", "effects.yaml"))
    : { schema_version: VERSION, effects: [] };
  const decisions = existsSync(join(analysisRoot, "model", "review-decisions.yaml"))
    ? readYaml<ReviewDecisionsFile>(join(analysisRoot, "model", "review-decisions.yaml"))
    : { schema_version: VERSION, decisions: [] };

  return {
    schema_version: VERSION,
    capabilities: capabilities.capabilities,
    journeys: journeys.journeys,
    effects: effects.effects,
    decisions: decisions.decisions,
    surfaces: [],
    controls: []
  };
}

export function snapshotModelFiles(analysisRoot: string): Record<string, string> {
  const names = [
    "capabilities.yaml",
    "journeys.yaml",
    "effects.yaml",
    "review-decisions.yaml"
  ];
  const out: Record<string, string> = {};
  for (const name of names) {
    const file = join(analysisRoot, "model", name);
    out[name] = existsSync(file) ? readText(file) : "";
  }
  return out;
}

export { VERSION as SCHEMA_VERSION_VALUE };
