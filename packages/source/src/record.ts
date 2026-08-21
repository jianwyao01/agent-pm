import {
  SCHEMA_VERSION,
  type SourceRecord,
  type SourceRequest,
  type SourceSnapshot
} from "@behavior-map/contracts";
import { recordLocator } from "./locator.js";

export function toSourceRecord(request: SourceRequest, snapshot: SourceSnapshot): SourceRecord {
  const record: SourceRecord = {
    schema_version: request.schema_version ?? SCHEMA_VERSION,
    kind: request.kind,
    locator: recordLocator(request.kind, request.locator),
    revision: snapshot.revision,
    snapshot: snapshot.id
  };
  if (snapshot.dirty !== undefined) {
    record.dirty = snapshot.dirty;
  }
  if (snapshot.content_digest) {
    record.content_digest = snapshot.content_digest;
  }
  return record;
}

export function snapshotHasNoKind(snapshot: SourceSnapshot): boolean {
  return !("kind" in snapshot);
}
