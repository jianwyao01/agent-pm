import { join } from "node:path";
import type { ReviewedModel } from "@behavior-map/contracts";
import { generateDiagrams } from "./diagrams.js";
import { generateProductMap } from "./product-map.js";
import { generateTests } from "./tests.js";
import { generateWeb } from "./web.js";

export function generateAll(model: ReviewedModel, analysisRoot: string): string[] {
  const generatedRoot = join(analysisRoot, "generated");
  generateProductMap(model, generatedRoot);
  generateDiagrams(model, generatedRoot);
  generateWeb(model, generatedRoot);
  generateTests(model, generatedRoot);
  return [
    join(generatedRoot, "product-map", "product-map.json"),
    join(generatedRoot, "product-map", "product-map.md"),
    join(generatedRoot, "diagrams", "journeys.mmd"),
    join(generatedRoot, "diagrams", "journeys.md"),
    join(generatedRoot, "web", "index.html"),
    join(generatedRoot, "tests", "journeys.spec.ts")
  ];
}
