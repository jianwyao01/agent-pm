import { join } from "node:path";
import {
  ensureDir,
  listRunIds,
  readJsonl,
  writeJsonl,
  type Candidate,
  type EvidenceRecord
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
  runtimeEvidence: EvidenceRecord[]
): void {
  ensureDir(join(runRoot, "evidence"));
  writeJsonl(candidatesPath(runRoot), candidates);
  writeJsonl(evidencePath(runRoot, "static"), staticEvidence);
  writeJsonl(evidencePath(runRoot, "runtime"), runtimeEvidence);
}

export function persistMerged(
  runRoot: string,
  incomingCandidates: Candidate[],
  incomingStatic: EvidenceRecord[],
  incomingRuntime: EvidenceRecord[]
): { candidates: Candidate[]; staticEvidence: EvidenceRecord[]; runtimeEvidence: EvidenceRecord[] } {
  const candidates = mergeCandidates(loadCandidates(runRoot), incomingCandidates);
  const staticEvidence = uniqueEvidence([...loadEvidence(runRoot, "static"), ...incomingStatic]);
  const runtimeEvidence = uniqueEvidence([...loadEvidence(runRoot, "runtime"), ...incomingRuntime]);
  writeDiscoveryArtifacts(runRoot, candidates, staticEvidence, runtimeEvidence);
  return { candidates, staticEvidence, runtimeEvidence };
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
