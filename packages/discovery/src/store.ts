import { join } from "node:path";
import {
  ensureDir,
  listRunIds,
  promoteMissingControlCandidates,
  readJsonl,
  writeJsonl,
  type Binding,
  type Candidate,
  type EvidenceRecord,
  type ObservedControl
} from "@behavior-map/contracts";

export function resolveRunRoot(
  workspacePath: string,
  options: { runId?: string; runRoot?: string }
): string {
  if (options.runRoot) {
    return options.runRoot;
  }
  if (options.runId) {
    return join(workspacePath, "runs", options.runId);
  }
  const existing = listRunIds(workspacePath);
  if (existing.length > 0) {
    return join(workspacePath, "runs", existing.at(-1)!);
  }
  return join(workspacePath, "runs", "discovery");
}

export function candidatesPath(runRoot: string): string {
  return join(runRoot, "candidates.jsonl");
}

export function evidencePath(runRoot: string, source: "static" | "runtime"): string {
  return join(runRoot, "evidence", `${source}.jsonl`);
}

export function loadCandidates(runRoot: string): Candidate[] {
  return readJsonl<Candidate>(candidatesPath(runRoot));
}

export function loadEvidence(runRoot: string, source: "static" | "runtime"): EvidenceRecord[] {
  return readJsonl<EvidenceRecord>(evidencePath(runRoot, source));
}

export function controlsPath(runRoot: string): string {
  return join(runRoot, "controls.jsonl");
}

export function bindingsPath(runRoot: string): string {
  return join(runRoot, "bindings.jsonl");
}

export function loadControls(runRoot: string): ObservedControl[] {
  return readJsonl<ObservedControl>(controlsPath(runRoot));
}

export function loadBindings(runRoot: string): Binding[] {
  return readJsonl<Binding>(bindingsPath(runRoot));
}

export function mergeControls(existing: ObservedControl[], incoming: ObservedControl[]): ObservedControl[] {
  const byId = new Map(existing.map((row) => [row.control_id, row]));
  for (const row of incoming) {
    const prev = byId.get(row.control_id);
    if (!prev) {
      byId.set(row.control_id, row);
      continue;
    }
    byId.set(row.control_id, {
      ...prev,
      ...row,
      evidence_refs: [...new Set([...prev.evidence_refs, ...row.evidence_refs])],
      locator_candidates: mergeLocatorCandidates(prev.locator_candidates, row.locator_candidates),
      control_id: prev.control_id
    });
  }
  return [...byId.values()];
}

function mergeLocatorCandidates(
  existing: ObservedControl["locator_candidates"],
  incoming: ObservedControl["locator_candidates"]
): ObservedControl["locator_candidates"] {
  const seen = new Set(existing.map((item) => `${item.type}:${item.value}`));
  const out = [...existing];
  for (const item of incoming) {
    const key = `${item.type}:${item.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function mergeCandidates(existing: Candidate[], incoming: Candidate[]): Candidate[] {
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const row of incoming) {
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, row);
      continue;
    }
    const evidence = [...new Set([...prev.evidence_refs, ...row.evidence_refs])];
    byId.set(row.id, {
      ...prev,
      ...row,
      evidence_refs: evidence,
      discovery_key: prev.discovery_key,
      id: prev.id
    });
  }
  return [...byId.values()];
}

export function writeDiscoveryArtifacts(
  runRoot: string,
  candidates: Candidate[],
  staticEvidence: EvidenceRecord[],
  runtimeEvidence: EvidenceRecord[],
  controls?: ObservedControl[]
): void {
  ensureDir(join(runRoot, "evidence"));
  writeJsonl(candidatesPath(runRoot), candidates);
  writeJsonl(evidencePath(runRoot, "static"), staticEvidence);
  writeJsonl(evidencePath(runRoot, "runtime"), runtimeEvidence);
  if (controls) {
    writeJsonl(controlsPath(runRoot), controls);
  }
}

export function persistMerged(
  runRoot: string,
  incomingCandidates: Candidate[],
  incomingStatic: EvidenceRecord[],
  incomingRuntime: EvidenceRecord[],
  incomingControls: ObservedControl[] = []
): {
  candidates: Candidate[];
  staticEvidence: EvidenceRecord[];
  runtimeEvidence: EvidenceRecord[];
  controls: ObservedControl[];
} {
  const candidates = mergeCandidates(loadCandidates(runRoot), incomingCandidates);
  const staticEvidence = uniqueEvidence([...loadEvidence(runRoot, "static"), ...incomingStatic]);
  const runtimeEvidence = uniqueEvidence([...loadEvidence(runRoot, "runtime"), ...incomingRuntime]);
  const controls = mergeControls(loadControls(runRoot), incomingControls);
  writeDiscoveryArtifacts(runRoot, candidates, staticEvidence, runtimeEvidence, controls);
  const promoted = promoteMissingControlCandidates(runRoot);
  return { candidates: promoted, staticEvidence, runtimeEvidence, controls };
}

function uniqueEvidence(rows: EvidenceRecord[]): EvidenceRecord[] {
  const seen = new Set<string>();
  const out: EvidenceRecord[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    out.push(row);
  }
  return out;
}
