import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  countJsonlLines,
  hasValidStaticScan,
  listRunIds,
  promoteMissingControlCandidates,
  projectDisplay,
  readJsonl,
  type Binding,
  type Candidate,
  type EvidenceRecord,
  type Journey,
  type ReviewedModel
} from "@behavior-map/contracts";

export interface ProductMapContext {
  bindings: Binding[];
  candidates: Candidate[];
  candidateLineCount: number;
  rejectedCount: number;
  unreviewedCount: number;
  hasValidStatic: boolean;
  playUrlsByJourney: Record<string, string[]>;
}

const SURFACE_NAME_BLOCKLIST = new Set(["撰写面", "列表面"]);

export function resolveRunId(analysisRoot: string, runId?: string): string | undefined {
  if (runId) {
    return runId;
  }
  return listRunIds(analysisRoot).at(-1);
}

export function loadProductMapContext(
  analysisRoot: string,
  model: ReviewedModel,
  runId?: string
): ProductMapContext {
  const resolved = resolveRunId(analysisRoot, runId);
  if (!resolved) {
    return emptyContext(model);
  }
  const runRoot = join(analysisRoot, "runs", resolved);
  const candidates = promoteMissingControlCandidates(runRoot);
  const bindings = existsSync(join(runRoot, "bindings.jsonl"))
    ? readJsonl<Binding>(join(runRoot, "bindings.jsonl"))
    : [];
  const runtime = existsSync(join(runRoot, "evidence", "runtime.jsonl"))
    ? readJsonl<EvidenceRecord>(join(runRoot, "evidence", "runtime.jsonl"))
    : [];
  const decisionsRejected = model.decisions.filter((item) => item.review_status === "rejected");
  const rejectedIds = new Set(decisionsRejected.map((item) => item.candidate_id));
  const fileRejected = candidates.filter((item) => item.review_status === "rejected");
  for (const row of fileRejected) {
    rejectedIds.add(row.id);
  }
  const decided = new Set(model.decisions.map((item) => item.candidate_id));
  const unreviewedCount = candidates.filter(
    (item) => item.review_status === "unreviewed" && !decided.has(item.id)
  ).length;
  const playUrlsByJourney: Record<string, string[]> = {};
  for (const journey of model.journeys) {
    playUrlsByJourney[journey.id] = playUrlsForJourney(journey, runtime);
  }
  return {
    bindings,
    candidates,
    candidateLineCount: countJsonlLines(join(runRoot, "candidates.jsonl")),
    rejectedCount: rejectedIds.size,
    unreviewedCount,
    hasValidStatic: hasValidStaticScan(join(runRoot, "evidence", "static.jsonl")),
    playUrlsByJourney
  };
}

function emptyContext(model: ReviewedModel): ProductMapContext {
  return {
    bindings: [],
    candidates: [],
    candidateLineCount: 0,
    rejectedCount: model.decisions.filter((item) => item.review_status === "rejected").length,
    unreviewedCount: 0,
    hasValidStatic: false,
    playUrlsByJourney: {}
  };
}

export function playUrlsForJourney(journey: Journey, evidence: EvidenceRecord[]): string[] {
  const bindingIds = new Set((journey.steps ?? []).map((step) => step.binding_id));
  if (bindingIds.size === 0) {
    return [];
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const row of evidence) {
    const payload = row.payload ?? {};
    const bid = payload.binding_id;
    const url = payload.url;
    if (typeof url !== "string" || !url.trim()) {
      continue;
    }
    if (SURFACE_NAME_BLOCKLIST.has(url.trim())) {
      continue;
    }
    if (typeof bid === "string" && !bindingIds.has(bid)) {
      continue;
    }
    if (typeof bid !== "string") {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function isBlockedSurfaceName(name: string | undefined): boolean {
  return Boolean(name && SURFACE_NAME_BLOCKLIST.has(name));
}

export function mapAffectedParties(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "用户") {
    return "未识别";
  }
  return trimmed;
}

export function mapCombinations(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "无";
}

export function mapKeepReason(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "未写理由";
}

export function unobservedCells(model: ReviewedModel): string[] {
  const display = projectDisplay(model.journeys, model.effects);
  const gaps: string[] = [];
  for (const row of display.rows) {
    for (const cell of row.cells) {
      if (!cell.observed) {
        gaps.push(`${row.journey_id} ${cell.column}`);
      }
    }
  }
  return gaps;
}
