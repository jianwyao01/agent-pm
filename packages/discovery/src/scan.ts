import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  SCHEMA_VERSION,
  newEvidenceId,
  stableCandidateId,
  type Candidate,
  type CandidateKind,
  type EvidenceRecord,
  type ExecutionStatus,
  type Gap,
  type Scope,
  type StaticDiscoveryResult,
  type Workspace
} from "@behavior-map/contracts";
import { classifyScope } from "./scope-match.js";
import { digestScanFiles, listScanFiles, resolveSnapshotId } from "./snapshot.js";
import { persistMerged, resolveRunRoot } from "./store.js";

const UNSUPPORTED_GESTURES = new Set(["swipe", "long-press", "longpress", "long_press"]);

interface RawFind {
  kind: CandidateKind;
  discoveryKey: string;
  label: string;
  executionStatus: ExecutionStatus;
  seed?: string;
  hints: string[];
  file: string;
  locator: string;
  extra?: Record<string, unknown>;
}

export interface ScanOptions {
  runId?: string;
  runRoot?: string;
  snapshotId?: string;
  candidateCap?: number;
}

export function scanWorkspace(
  workspace: Workspace,
  scope: Scope,
  options: ScanOptions = {}
): StaticDiscoveryResult {
  const files = listScanFiles(workspace.path);
  const snapshot = resolveSnapshotId(workspace.path, files, options.snapshotId);
  const finds: RawFind[] = [];
  const fileEvidence = new Map<string, EvidenceRecord>();

  for (const file of files) {
    const rel = relative(workspace.path, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    const evidence: EvidenceRecord = {
      schema_version: SCHEMA_VERSION,
      id: newEvidenceId("ev-static"),
      immutable: true,
      source: "static",
      kind: "static-source",
      payload: { path: rel, snapshot, bytes: source.length }
    };
    fileEvidence.set(rel, evidence);
    finds.push(...discoverInSource(rel, source));
  }

  const unique = dedupeFinds(finds);
  const cap = options.candidateCap ?? 10_000;
  const gaps: Gap[] = [];
  let status: StaticDiscoveryResult["status"] = "success";
  let kept = unique;
  if (unique.length > cap) {
    kept = unique.slice(0, cap);
    status = "partial";
    gaps.push({
      reason: "resource_cap",
      message: `candidate cap ${cap} hit; ${unique.length - cap} finds not written`
    });
  }

  const candidates: Candidate[] = kept.map((find) => {
    const evidence = fileEvidence.get(find.file);
    return {
      schema_version: SCHEMA_VERSION,
      id: stableCandidateId(snapshot, find.discoveryKey),
      kind: find.kind,
      scope_id: scope.id,
      discovered_by: "scan",
      evidence_refs: evidence ? [evidence.id] : [],
      execution_status: find.executionStatus,
      scope_status: classifyScope(
        { id: find.discoveryKey, label: find.label, seed: find.seed, hints: find.hints },
        scope
      ),
      review_status: "unreviewed",
      rejection_reason: null,
      discovery_key: find.discoveryKey,
      label: find.label
    };
  });

  const evidence = [...fileEvidence.values()].filter((row) =>
    candidates.some((candidate) => candidate.evidence_refs.includes(row.id))
  );
  const runRoot = resolveRunRoot(workspace.path, options);
  const persisted = persistMerged(runRoot, candidates, evidence, []);
  return { status, candidates: persisted.candidates, evidence, gaps };
}

function dedupeFinds(finds: RawFind[]): RawFind[] {
  const byKey = new Map<string, RawFind>();
  for (const find of finds) {
    if (!byKey.has(find.discoveryKey)) {
      byKey.set(find.discoveryKey, find);
    }
  }
  return [...byKey.values()];
}

function discoverInSource(rel: string, source: string): RawFind[] {
  const finds: RawFind[] = [];
  const tagRe =
    /<(button|input|textarea|select|a|form|div|nav|main|section|li|span)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const voidRe = /<(button|input|textarea|select|a|form|div|nav|main|section|li|span)\b([^>]*)\/?>/gi;

  const seenLocators = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(source))) {
    const find = findFromTag(rel, match[1], match[2], stripTags(match[3]));
    if (find && !seenLocators.has(find.discoveryKey)) {
      seenLocators.add(find.discoveryKey);
      finds.push(find);
    }
  }
  while ((match = voidRe.exec(source))) {
    const find = findFromTag(rel, match[1], match[2], "");
    if (find && !seenLocators.has(find.discoveryKey)) {
      seenLocators.add(find.discoveryKey);
      finds.push(find);
    }
  }

  const gestureRe = /data-gesture\s*=\s*["']([^"']+)["']/gi;
  while ((match = gestureRe.exec(source))) {
    const gesture = match[1];
    const key = `control:${rel}:gesture:${normalizeToken(gesture)}`;
    if (seenLocators.has(key)) {
      continue;
    }
    seenLocators.add(key);
    finds.push({
      kind: "control",
      discoveryKey: key,
      label: gesture,
      executionStatus: isUnsupportedGesture(gesture) ? "not_executed" : "observed",
      seed: gesture,
      hints: [gesture],
      file: rel,
      locator: `[data-gesture="${gesture}"]`
    });
  }

  return finds;
}

function findFromTag(rel: string, tag: string, rawAttrs: string, text: string): RawFind | undefined {
  const attrs = parseAttrs(rawAttrs);
  const gesture = attrs["data-gesture"];
  const seed = attrs["data-seed"] || attrs["data-entry"];
  const surface = attrs["data-surface"] || attrs["data-surface-id"];
  const control = attrs["data-control"] || attrs.id;
  const action = attrs["data-action"] || inferAction(tag, attrs);
  const hint = attrs["data-scope-hint"];
  const label =
    attrs["aria-label"] ||
    attrs.title ||
    attrs.name ||
    text ||
    control ||
    seed ||
    surface ||
    gesture ||
    tag;

  const interactive =
    Boolean(surface || control || seed || gesture || attrs["data-action"] || attrs["data-collection"]) ||
    isInteractiveTag(tag, attrs);
  if (!interactive) {
    return undefined;
  }

  if (surface && !attrs["data-action"] && !control && !seed && !gesture && tag !== "a" && tag !== "button") {
    return {
      kind: "surface",
      discoveryKey: `surface:${rel}:${surface}`,
      label: label || surface,
      executionStatus: "observed",
      seed,
      hints: [surface, hint, text].filter(Boolean) as string[],
      file: rel,
      locator: `[data-surface="${surface}"]`
    };
  }

  if (seed && (seed.startsWith("entry") || attrs["data-entry"] || isEntrySeedTag(tag, action))) {
    // entry 与 control 分开：入口种子额外记一条 entry，控件本身仍作为 control
  }

  const local =
    control ||
    seed ||
    (gesture ? `gesture:${normalizeToken(gesture)}` : undefined) ||
    `${tag}:${action}:${stableAttrFingerprint(attrs)}`;
  const kind: CandidateKind = seed && isEntryLike(seed, action) ? "entry" : "control";
  const unsupported = isUnsupportedGesture(gesture) || isUnsupportedGesture(action);
  return {
    kind,
    discoveryKey: `${kind}:${rel}:${local}`,
    label: label || local,
    executionStatus: unsupported ? "not_executed" : "observed",
    seed,
    hints: [hint, seed, action, gesture, text].filter(Boolean) as string[],
    file: rel,
    locator: locatorFor(attrs, tag),
    extra: { action, tag }
  };
}

function isEntryLike(seed: string, action: string): boolean {
  return seed.startsWith("entry") || seed.includes("nav-") || action === "open";
}

function isEntrySeedTag(tag: string, action: string): boolean {
  return (tag === "a" || tag === "button") && (action === "click" || action === "open");
}

function isInteractiveTag(tag: string, attrs: Record<string, string>): boolean {
  if (tag === "button" || tag === "textarea" || tag === "select" || tag === "form") {
    return true;
  }
  if (tag === "a" && attrs.href) {
    return true;
  }
  if (tag === "input") {
    return attrs.type !== "hidden";
  }
  return false;
}

function inferAction(tag: string, attrs: Record<string, string>): string {
  if (attrs["data-action"]) {
    return attrs["data-action"];
  }
  if (attrs["data-gesture"]) {
    return attrs["data-gesture"];
  }
  if (tag === "form" || attrs.type === "submit") {
    return "submit";
  }
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return "type";
  }
  return "click";
}

function isUnsupportedGesture(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return UNSUPPORTED_GESTURES.has(normalizeToken(value));
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:@\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function locatorFor(attrs: Record<string, string>, tag: string): string {
  if (attrs.id) {
    return `#${attrs.id}`;
  }
  if (attrs["data-control"]) {
    return `[data-control="${attrs["data-control"]}"]`;
  }
  if (attrs["data-seed"]) {
    return `[data-seed="${attrs["data-seed"]}"]`;
  }
  if (attrs["data-surface"]) {
    return `[data-surface="${attrs["data-surface"]}"]`;
  }
  if (attrs["data-gesture"]) {
    return `[data-gesture="${attrs["data-gesture"]}"]`;
  }
  return tag;
}

function stableAttrFingerprint(attrs: Record<string, string>): string {
  const keys = ["id", "name", "type", "href", "data-action", "data-scope-hint"].filter((key) => attrs[key]);
  if (keys.length === 0) {
    return "anon";
  }
  return keys.map((key) => `${key}=${attrs[key]}`).join(",");
}

export function snapshotDigestFor(workspacePath: string): string {
  const files = listScanFiles(workspacePath);
  return digestScanFiles(workspacePath, files);
}
