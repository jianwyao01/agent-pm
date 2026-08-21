import { join } from "node:path";
import type { ReviewedModel } from "@behavior-map/contracts";
import { generateDiagrams } from "./diagrams.js";
import { generateProductMap } from "./product-map.js";
import { generateTests } from "./tests.js";
import { generateWeb } from "./web.js";

export function generateAll(model: ReviewedModel, analysisRoot: string): void {
  const generatedRoot = join(analysisRoot, "generated");
  generateProductMap(model, generatedRoot);
  generateDiagrams(model, generatedRoot);
  generateWeb(model, generatedRoot);
  generateTests(model, generatedRoot);
}
