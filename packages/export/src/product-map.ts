import { join } from "node:path";
import {
  SCHEMA_VERSION,
  assertDisplayIncludesOtherSurface,
  projectDisplay,
  type ProductMap,
  type ReviewedModel,
  writeJson,
  writeText
} from "@behavior-map/contracts";
import { renderProductMapProse } from "./prose.js";
import { journeyIdsOf, writeManifest } from "./shared.js";
import type { ProductMapContext } from "./map-context.js";

export function generateProductMap(
  model: ReviewedModel,
  generatedRoot: string,
  extras?: ProductMapContext
): ProductMap {
  const outDir = join(generatedRoot, "product-map");
  const display = projectDisplay(model.journeys, model.effects);
  assertDisplayIncludesOtherSurface(display);
  const productMap: ProductMap = {
    schema_version: SCHEMA_VERSION,
    journey_ids: journeyIdsOf(model),
    surfaces: model.surfaces,
    controls: model.controls,
    journeys: model.journeys,
    effects: model.effects,
    display
  };
  writeJson(join(outDir, "product-map.json"), productMap);
  writeText(join(outDir, "product-map.md"), renderProductMapProse(model, extras));
  writeManifest(outDir, "product-map", productMap.journey_ids);
  return productMap;
}
