import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION, type Candidate, type ObservedControl } from "./types.js";
import { readJsonl, writeJsonl } from "./io.js";
import { stableCandidateId } from "./ids.js";
import { validateDocument } from "./schema-validator.js";

export const LONE_USER_PARTY = "用户" as const;

export function controlDiscoveryKey(controlId: string): string {
  return `control:${controlId}`;
}

export function labelFromObservedControl(control: ObservedControl): string {
  const name = control.observed.name;
  if (typeof name === "string") {
    return name;
  }
  return "";
}

export function candidateFromObservedControl(
  control: ObservedControl,
  extras: { scope_id: string; snapshot?: string }
): Candidate {
  const discovery_key = controlDiscoveryKey(control.control_id);
  const observedName = labelFromObservedControl(control);
  return {
    schema_version: SCHEMA_VERSION,
    id: stableCandidateId(extras.snapshot ?? "controls", discovery_key),
    kind: "control",
    scope_id: extras.scope_id,
    discovered_by: "explore",
    evidence_refs: control.evidence_refs,
    execution_status: "observed",
    scope_status: "in_scope",
    review_status: "unreviewed",
    rejection_reason: null,
    discovery_key,
    label: observedName
  };
}

export function candidatesFromObservedControls(
  controls: ObservedControl[],
  existing: Candidate[],
  extras: { scope_id: string; snapshot?: string }
): Candidate[] {
  const seen = new Set(existing.map((row) => row.discovery_key));
  const out: Candidate[] = [];
  for (const control of controls) {
    const key = controlDiscoveryKey(control.control_id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const row = candidateFromObservedControl(control, extras);
    if (!row.label) {
      row.label = control.control_id;
    }
    out.push(row);
  }
  return out;
}

/**
 * 若 controls.jsonl 有 Control 尚未出现在 candidates.jsonl，则按 discovery_key 去重后追加。
 * 不是一次新的 explore。
 */
export function promoteMissingControlCandidates(runRoot: string): Candidate[] {
  const candidatesFile = join(runRoot, "candidates.jsonl");
  const controlsFile = join(runRoot, "controls.jsonl");
  const existing = existsSync(candidatesFile) ? readJsonl<Candidate>(candidatesFile) : [];
  if (!existsSync(controlsFile)) {
    return existing;
  }
  const controls = readJsonl<ObservedControl>(controlsFile);
  const scopeId = existing.find((row) => row.scope_id)?.scope_id ?? "scope-unknown";
  const added = candidatesFromObservedControls(controls, existing, {
    scope_id: scopeId,
    snapshot: "controls"
  });
  if (added.length === 0) {
    return existing;
  }
  const merged = [...existing, ...added];
  writeJsonl(candidatesFile, merged);
  return merged;
}

export function countJsonlLines(file: string): number {
  if (!existsSync(file)) {
    return 0;
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

/** 仅当文件含 ≥1 条 schema 合法的 static 记录时为 true。缺失 / 空 / 仅空白必须为 false。 */
export function hasValidStaticScan(file: string): boolean {
  if (!existsSync(file)) {
    return false;
  }
  const text = readFileSync(file, "utf8");
  if (!text.trim()) {
    return false;
  }
  try {
    const rows = readJsonl<unknown>(file);
    return rows.some((row) => validateDocument("evidence", row).ok);
  } catch {
    return false;
  }
}

export function isLoneUserParty(value: string | undefined): boolean {
  return value?.trim() === LONE_USER_PARTY;
}
