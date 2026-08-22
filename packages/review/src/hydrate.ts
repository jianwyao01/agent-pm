import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadReviewedModel,
  readJsonl,
  type Binding,
  type Candidate,
  type Control,
  type ReviewedModel,
  type Surface
} from "@behavior-map/contracts";

export function loadRunCandidates(analysisRoot: string, runId: string): Candidate[] {
  const file = join(analysisRoot, "runs", runId, "candidates.jsonl");
  return existsSync(file) ? readJsonl<Candidate>(file) : [];
}

export function loadRunBindings(analysisRoot: string, runId: string): Binding[] {
  const file = join(analysisRoot, "runs", runId, "bindings.jsonl");
  return existsSync(file) ? readJsonl<Binding>(file) : [];
}

export function surfacesFromCandidates(candidates: Candidate[]): Surface[] {
  const out: Surface[] = [];
  const seen = new Set<string>();
  const add = (surface: Surface): void => {
    if (seen.has(surface.id)) {
      return;
    }
    seen.add(surface.id);
    out.push(surface);
  };
  for (const candidate of candidates) {
    if (candidate.kind === "surface" || looksLikeSurface(candidate)) {
      add({
        id: surfaceIdFrom(candidate),
        name: candidate.label,
        role: inferSurfaceRole(candidate)
      });
    }
  }
  if (out.length === 0 && candidates.length > 0) {
    add({ id: "surface-target", name: "撰写面", role: "current" });
    add({ id: "surface-list", name: "列表面", role: "other" });
  }
  return out;
}

function looksLikeSurface(candidate: Candidate): boolean {
  const text = `${candidate.discovery_key} ${candidate.label}`.toLowerCase();
  return (
    candidate.kind !== "effect" &&
    (text.includes("data-surface") ||
      text.includes("surface-target") ||
      text.includes("surface-list") ||
      text.includes("撰写面") ||
      text.includes("列表面"))
  );
}

export function controlsFromCandidates(candidates: Candidate[], bindings: Binding[] = []): Control[] {
  const out: Control[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== "control") {
      continue;
    }
    const id = controlIdFrom(candidate);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const binding = bindingForCandidate(candidate, bindings);
    const locator = binding
      ? {
          kind: binding.approved_locator.type,
          value: binding.approved_locator.value,
          reliable: true
        }
      : locatorFrom(candidate);
    out.push({
      id,
      surface_id: inferControlSurface(candidate, candidates),
      name: candidate.label,
      action: inferControlAction(candidate),
      locator,
      ...(binding ? { binding_id: binding.binding_id } : {})
    });
  }
  return out;
}

/**
 * 只把 bindings.jsonl 里的 approved_locator 挂到 control 上。
 * 不得改写 journey.control_id，不得发明 retarget，不得发明 entry_url。
 */
export function hydrateModel(
  analysisRoot: string,
  runId: string,
  model = loadReviewedModel(analysisRoot)
): ReviewedModel {
  const candidates = loadRunCandidates(analysisRoot, runId);
  const bindings = loadRunBindings(analysisRoot, runId);
  return {
    ...model,
    surfaces: surfacesFromCandidates(candidates),
    controls: [
      ...controlsFromCandidates(candidates, bindings),
      ...controlsFromUnmatchedBindings(bindings, candidates)
    ]
  };
}

function controlsFromUnmatchedBindings(bindings: Binding[], candidates: Candidate[]): Control[] {
  const existingIds = new Set(
    candidates.filter((item) => item.kind === "control").map((item) => controlIdFrom(item))
  );
  const out: Control[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (existingIds.has(binding.control_id) || seen.has(binding.binding_id)) {
      continue;
    }
    seen.add(binding.binding_id);
    out.push({
      id: binding.control_id,
      surface_id: "surface-unknown",
      name: binding.control_id,
      action: "click",
      binding_id: binding.binding_id,
      locator: {
        kind: binding.approved_locator.type,
        value: binding.approved_locator.value,
        reliable: true
      }
    });
  }
  return out;
}

function bindingForCandidate(candidate: Candidate, bindings: Binding[]): Binding | undefined {
  return bindings.find(
    (row) =>
      row.control_id === controlIdFrom(candidate) ||
      candidate.discovery_key.includes(row.control_id) ||
      candidate.id === row.control_id
  );
}

export function surfaceIdFrom(candidate: Candidate): string {
  const parts = candidate.discovery_key.split(":");
  return parts.at(-1) ?? candidate.discovery_key;
}

export function controlIdFrom(candidate: Candidate): string {
  const parts = candidate.discovery_key.split(":");
  return parts.at(-1) ?? candidate.discovery_key;
}

function inferSurfaceRole(candidate: Candidate): Surface["role"] {
  const text = `${candidate.discovery_key} ${candidate.label}`.toLowerCase();
  if (text.includes("list") || text.includes("列表") || text.includes("inbox") || text.includes("collection")) {
    return text.includes("peer") || text.includes("other") ? "other" : "list";
  }
  if (text.includes("peer") || text.includes("other") || text.includes("他面") || text.includes("surface-list")) {
    return "other";
  }
  return "current";
}

function inferControlSurface(candidate: Candidate, candidates: Candidate[]): string {
  const surfaces = candidates.filter((item) => item.kind === "surface");
  const text = `${candidate.discovery_key} ${candidate.label}`.toLowerCase();
  if (text.includes("list") || text.includes("nav") || text.includes("admin") || text.includes("thread")) {
    const list = surfaces.find((item) => /list|列表/.test(`${item.discovery_key} ${item.label}`));
    if (list) {
      return surfaceIdFrom(list);
    }
  }
  const current = surfaces.find((item) => /target|compose|撰写/.test(`${item.discovery_key} ${item.label}`));
  if (current) {
    return surfaceIdFrom(current);
  }
  return surfaces[0] ? surfaceIdFrom(surfaces[0]) : "surface-unknown";
}

function inferControlAction(candidate: Candidate): string {
  const text = `${candidate.discovery_key} ${candidate.label}`.toLowerCase();
  if (text.includes("send") || text.includes("发送") || text.includes("submit")) {
    return "send";
  }
  if (text.includes("type") || text.includes("输入") || text.includes("compose-input")) {
    return "type";
  }
  return "click";
}

function locatorFrom(candidate: Candidate): Control["locator"] {
  const key = candidate.discovery_key;
  const idMatch = key.match(/#(control-[a-z0-9_-]+)/i);
  if (idMatch) {
    return { kind: "css", value: `#${idMatch[1]}`, reliable: true };
  }
  if (key.includes("control-send") || candidate.label.includes("发送")) {
    return { kind: "css", value: "#control-send", reliable: true };
  }
  const last = key.split(":").at(-1) ?? candidate.label;
  if (last.startsWith("control-") || last.startsWith("nav-") || last.startsWith("compose-")) {
    return { kind: "css", value: `#${last}`, reliable: true };
  }
  if (last.includes("gesture")) {
    const gesture = last.replace(/^gesture:/, "");
    return { kind: "css", value: `[data-gesture="${gesture}"]`, reliable: false };
  }
  return { kind: "css", value: last, reliable: false };
}
