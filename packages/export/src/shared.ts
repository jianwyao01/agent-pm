import { join } from "node:path";
import {
  SCHEMA_VERSION,
  type ExportManifest,
  type ReviewedModel,
  writeJson
} from "@behavior-map/contracts";

export function journeyIdsOf(model: ReviewedModel): string[] {
  return model.journeys.map((journey) => journey.id);
}

export function writeManifest(
  outDir: string,
  kind: ExportManifest["kind"],
  journeyIds: string[]
): void {
  const manifest: ExportManifest = {
    schema_version: SCHEMA_VERSION,
    kind,
    journey_ids: [...journeyIds]
  };
  writeJson(join(outDir, "journey-ids.json"), manifest);
}
