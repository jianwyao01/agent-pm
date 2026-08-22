import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CROSS_ACTOR_UNEXECUTED,
  SCHEMA_VERSION,
  UNOBSERVED,
  newEvidenceId,
  readYaml,
  stableCandidateId,
  validateDocument,
  type ActionObservation,
  type Candidate,
  type Control,
  type EvidenceRecord,
  type Gap,
  type Observation,
  type ProbePlan,
  type RunContext,
  type RunningProject,
  type RuntimeDiscoveryResult,
  type Scope,
  type Study,
  type Transport,
  type Workspace
} from "@behavior-map/contracts";
import { classifyScope } from "./scope-match.js";
import { actualBackendFrom, closeSession, openSession, type DriverSession } from "./driver.js";
import {
  collectProbeUrls,
  dumpVisibleControls,
  isPhase1ApprovedLocator,
  waitForApprovedVisible
} from "./observe.js";
import { loadBindings, loadCandidates, persistMerged, resolveRunRoot } from "./store.js";
import { listScanFiles, resolveSnapshotId } from "./snapshot.js";
import type { SessionProviderOptions } from "./session-provider.js";

export interface RuntimeOptions extends SessionProviderOptions {
  runId?: string;
  runRoot?: string;
  snapshotId?: string;
  workspacePath?: string;
}

const CROSS_ACTOR = {
  executed: false as const,
  display_value: CROSS_ACTOR_UNEXECUTED
};

export function loadProbePlan(workspacePath: string): ProbePlan | undefined {
  const file = join(workspacePath, "probe-plan.yaml");
  if (!existsSync(file)) {
    return undefined;
  }
  const data = readYaml<ProbePlan>(file);
  const report = validateDocument("probe-plan", data, file);
  if (!report.ok) {
    throw new Error(report.issues.map((issue) => issue.message).join("; "));
  }
  return data;
}

export function loadStudy(workspacePath: string): Study | undefined {
  const file = join(workspacePath, "study.yaml");
  if (!existsSync(file)) {
    return undefined;
  }
  return readYaml<Study>(file);
}

export function workspaceFromProject(project: RunningProject, fallback?: string): string | undefined {
  if (fallback) {
    return fallback;
  }
  if (project.pid_ref) {
    return dirname(dirname(dirname(project.pid_ref)));
  }
  return undefined;
}

export async function exploreRuntime(
  project: RunningProject,
  context: RunContext,
  scope: Scope,
  options: RuntimeOptions
): Promise<RuntimeDiscoveryResult> {
  const workspacePath = workspaceFromProject(project, options.workspacePath);
  if (!workspacePath) {
    return {
      status: "failed",
      candidates: [],
      evidence: [],
      observations: [],
      gaps: [{ reason: "missing_workspace", message: "cannot resolve workspace for explore" }]
    };
  }
  const probe = loadProbePlan(workspacePath);
  const study = loadStudy(workspacePath);
  const session = await openSession(context, options);
  try {
    const entryUrl = context.entry_url || project.base_url;
    await session.page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    const seeds = [
      ...(study?.entry_seeds ?? []),
      ...(probe?.entry ? [probe.entry] : []),
      ...(probe?.target_surface ? [probe.target_surface] : [])
    ];
    const urls = await collectProbeUrls(session.page, entryUrl, seeds);
    const discovered = await discoverVisible(session, scope, workspacePath, options, "explore");
    const dumped = await dumpPageControls(session, workspacePath, options);
    for (const url of urls) {
      if (sameUrl(url, session.page.url())) {
        continue;
      }
      await session.page.goto(url, { waitUntil: "domcontentloaded" });
      const more = await discoverVisible(session, scope, workspacePath, options, "explore");
      discovered.candidates.push(...more.candidates);
      discovered.evidence.push(...more.evidence);
      const extra = await dumpPageControls(session, workspacePath, options);
      dumped.controls.push(...extra.controls);
      dumped.evidence.push(...extra.evidence);
    }
    const runRoot = resolveRunRoot(workspacePath, options);
    const persisted = persistMerged(
      runRoot,
      discovered.candidates,
      [],
      [...discovered.evidence, ...dumped.evidence],
      dumped.controls
    );
    return {
      status: "success",
      candidates: persisted.candidates,
      evidence: [...discovered.evidence, ...dumped.evidence],
      observations: [],
      gaps: []
    };
  } catch (error) {
    return {
      status: "failed",
      candidates: [],
      evidence: [],
      observations: [],
      gaps: [
        {
          reason: "explore_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  } finally {
    await closeSession(session);
  }
}

/** click | type | submit 的有限超时；超时记 execute_failed，不改搜。 */
export const DECLARED_ACTION_TIMEOUT_MS = 10_000;

/** 单条 listitem/link 读取的短超时；脱离节点直接跳过，避免 30s 挂起。 */
export const COLLECTION_ITEM_TIMEOUT_MS = 150;

/** 大页链接上限，避免管理信息页把 play 拖死。 */
export const COLLECTION_NODE_CAP = 24;

export function pageHasNavigated(session: DriverSession): boolean {
  const url = session.page.url();
  return url.startsWith("http://") || url.startsWith("https://");
}

export async function executeAction(
  project: RunningProject,
  context: RunContext,
  action: Control,
  scope: Scope,
  options: RuntimeOptions,
  shared?: DriverSession
): Promise<ActionObservation> {
  const workspacePath = workspaceFromProject(project, options.workspacePath);
  if (!workspacePath) {
    return refusedObservation("missing_workspace", "cannot resolve workspace for execute");
  }
  const runRoot = resolveRunRoot(workspacePath, options);
  if (!action.binding_id) {
    return failedObservation("binding_missing", "action.binding_id is required");
  }
  const binding = loadBindings(runRoot).find((row) => row.binding_id === action.binding_id);
  if (!binding) {
    return failedObservation("binding_missing", `binding not found: ${action.binding_id}`);
  }
  if (!isPhase1ApprovedLocator(binding.approved_locator)) {
    return failedObservation("locator_not_found", "phase-1 approved_locator must be accessibility or role+name");
  }
  if (isUnsupportedAction(action)) {
    const candidate = markNotExecuted(action, scope, workspacePath, options);
    const persisted = persistMerged(runRoot, candidate ? [candidate] : [], [], []);
    return {
      status: "success",
      observations: [],
      evidence: [],
      candidates: persisted.candidates,
      gaps: [],
      cross_actor: CROSS_ACTOR
    };
  }

  const probe = loadProbePlan(workspacePath);
  const ownsSession = !shared;
  const session = shared ?? (await openSession(context, options));
  const evidence: EvidenceRecord[] = [];
  const observations: Observation[] = [];
  const collectionGaps: Gap[] = [];
  let actionCompleted = false;
  try {
    const entryUrl = context.entry_url || project.base_url;
    if (!pageHasNavigated(session)) {
      await session.page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    }
    const listBeforeRead = await readCollection(session);
    noteCollectionGap(collectionGaps, listBeforeRead);
    const listBefore = listBeforeRead.names;
    const locator = await waitForApprovedVisible(session.page, binding.approved_locator);
    if (!locator) {
      const miss = evidenceRecord("runtime-execute", {
        binding_id: binding.binding_id,
        reason: "locator_not_found",
        approved_locator: binding.approved_locator
      });
      persistMerged(runRoot, [], [], [miss]);
      return failedObservation("locator_not_found", "approved_locator not found or not visible");
    }

    const beforeRequests = session.requests.length;
    await performDeclared(action.action, locator.first(), action.value);
    actionCompleted = true;
    await new Promise((resolve) => setTimeout(resolve, 400));

    const currentText = ((await session.page.locator("main, body").first().textContent()) ?? "").trim();
    const currentEv = evidenceRecord("runtime-current", {
      binding_id: binding.binding_id,
      surface: action.surface_id || probe?.target_surface,
      text: currentText.slice(0, 400)
    });
    evidence.push(currentEv);
    observations.push({
      kind: "current_surface",
      observed: Boolean(currentText),
      display_value: currentText.slice(0, 80) || action.name,
      evidence_refs: [currentEv.id],
      surface_id: action.surface_id || probe?.target_surface
    });

    const newRequests = session.requests.slice(beforeRequests);
    const backend = actualBackendFrom(newRequests, session.page.url());
    if (backend) {
      const backendEv = evidenceRecord("runtime-backend", { ...backend, binding_id: binding.binding_id });
      evidence.push(backendEv);
      observations.push({
        kind: "backend_operation",
        transport: backend.transport as Transport,
        observed: true,
        display_value: `${backend.transport} ${backend.method ?? ""} ${backend.path ?? ""}`.trim(),
        evidence_refs: [backendEv.id]
      });
    }

    const pushed = session.websockets.length > 0;
    let otherText = "";
    let listAfterRead = await readCollection(session);
    noteCollectionGap(collectionGaps, listAfterRead);
    let listAfter = listAfterRead.names;
    if (!pushed && listAfter.length === 0) {
      const refreshUrl = project.base_url || entryUrl;
      if (!sameUrl(refreshUrl, session.page.url())) {
        await session.page.goto(refreshUrl, { waitUntil: "domcontentloaded" });
        listAfterRead = await readCollection(session);
        noteCollectionGap(collectionGaps, listAfterRead);
        listAfter = listAfterRead.names;
      }
    }
    if (pushed) {
      otherText = "realtime push seen";
    } else {
      otherText = ((await session.page.locator("[data-surface], main").first().textContent()) ?? "").trim();
    }
    const delta = listAfter.filter((item) => !listBefore.includes(item));
    const otherEv = evidenceRecord("runtime-other", {
      binding_id: binding.binding_id,
      realtime_push: pushed,
      list_before: listBefore,
      list_after: listAfter,
      delta,
      text: otherText.slice(0, 400)
    });
    evidence.push(otherEv);
    const otherObserved = pushed || delta.length > 0 || listAfter.length > listBefore.length;
    observations.push({
      kind: "other_surface",
      observed: otherObserved,
      display_value: otherObserved ? delta[0] || otherText.slice(0, 80) : UNOBSERVED,
      evidence_refs: [otherEv.id],
      surface_id: probe?.other_surfaces_to_refresh[0]
    });
    observations.push({
      kind: "collection",
      subtype: "list",
      observed: otherObserved,
      display_value: otherObserved ? `list delta ${delta.length}` : UNOBSERVED,
      evidence_refs: [otherEv.id],
      surface_id: "surface-list"
    });

    const snapshot = resolveSnapshotId(workspacePath, listScanFiles(workspacePath), options.snapshotId);
    const existingSend = loadCandidates(runRoot).find(
      (row) =>
        row.discovery_key.toLowerCase().includes((probe?.send_action ?? action.id).toLowerCase()) ||
        row.id === action.id
    );
    const sendKey = existingSend?.discovery_key ?? `control:${action.id}`;
    const executed: Candidate = {
      schema_version: SCHEMA_VERSION,
      id: existingSend?.id ?? stableCandidateId(snapshot, sendKey),
      kind: existingSend?.kind ?? "control",
      scope_id: existingSend?.scope_id ?? scope.id,
      discovered_by: existingSend?.discovered_by ?? "execute",
      evidence_refs: [...(existingSend?.evidence_refs ?? []), ...evidence.map((row) => row.id)],
      execution_status: "executed",
      scope_status: existingSend?.scope_status === "out_of_scope" ? "in_scope" : existingSend?.scope_status ?? "in_scope",
      review_status: existingSend?.review_status ?? "unreviewed",
      rejection_reason: null,
      discovery_key: sendKey,
      label: existingSend?.label ?? action.name
    };
    const interaction: Candidate = {
      schema_version: SCHEMA_VERSION,
      id: stableCandidateId(snapshot, `interaction:${binding.binding_id}`),
      kind: "interaction",
      scope_id: scope.id,
      discovered_by: "execute",
      evidence_refs: evidence.map((row) => row.id),
      execution_status: "executed",
      scope_status: "in_scope",
      review_status: "unreviewed",
      rejection_reason: null,
      discovery_key: `interaction:${binding.binding_id}`,
      label: action.name
    };

    const persisted = persistMerged(runRoot, [executed, interaction], [], evidence);
    return {
      status: "success",
      observations,
      evidence,
      candidates: persisted.candidates,
      gaps: collectionGaps,
      cross_actor: CROSS_ACTOR
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (actionCompleted && isCollectionScrapeError(message)) {
      return {
        status: "success",
        observations,
        evidence,
        candidates: persistMerged(runRoot, [], [], evidence).candidates,
        gaps: [
          ...collectionGaps,
          {
            reason: "collection_scrape",
            message
          }
        ],
        cross_actor: CROSS_ACTOR
      };
    }
    return {
      status: "failed",
      observations,
      evidence,
      candidates: persistMerged(runRoot, [], [], evidence).candidates,
      gaps: [
        {
          reason: "execute_failed",
          message
        }
      ],
      cross_actor: CROSS_ACTOR
    };
  } finally {
    if (ownsSession) {
      await closeSession(session);
    }
  }
}

function refusedObservation(reason: string, message: string): ActionObservation {
  return {
    status: "refused",
    observations: [],
    evidence: [],
    candidates: [],
    gaps: [{ reason, message }],
    cross_actor: CROSS_ACTOR
  };
}

function failedObservation(reason: string, message: string): ActionObservation {
  return {
    status: "failed",
    observations: [],
    evidence: [],
    candidates: [],
    gaps: [{ reason, message }],
    cross_actor: CROSS_ACTOR
  };
}

async function performDeclared(
  action: string,
  locator: import("playwright-core").Locator,
  value?: string
): Promise<void> {
  const kind = action.trim().toLowerCase();
  if (kind === "type") {
    await locator.fill(value ?? "", { timeout: DECLARED_ACTION_TIMEOUT_MS });
    return;
  }
  if (kind === "submit" || kind === "click" || kind === "send") {
    await locator.click({ timeout: DECLARED_ACTION_TIMEOUT_MS });
    return;
  }
  throw new Error(`unsupported declared action: ${action}`);
}

async function dumpPageControls(
  session: DriverSession,
  workspacePath: string,
  options: RuntimeOptions
): Promise<{ controls: import("@behavior-map/contracts").ObservedControl[]; evidence: EvidenceRecord[] }> {
  const snapshot = resolveSnapshotId(workspacePath, listScanFiles(workspacePath), options.snapshotId);
  const dumped = await dumpVisibleControls(session.page, snapshot);
  const ev = evidenceRecord("runtime-a11y", {
    url: session.page.url(),
    count: dumped.controls.length
  });
  return {
    controls: dumped.controls.map((row) => ({ ...row, evidence_refs: [ev.id] })),
    evidence: [ev]
  };
}

function sameUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch {
    return left === right;
  }
}

function isUnsupportedAction(action: Control): boolean {
  const value = `${action.action} ${action.name} ${action.locator?.value ?? ""}`.toLowerCase();
  return /\b(swipe|long-press|longpress|long_press)\b/.test(value);
}

function markNotExecuted(
  action: Control,
  scope: Scope,
  workspacePath: string,
  options: RuntimeOptions
): Candidate | undefined {
  const snapshot = resolveSnapshotId(workspacePath, listScanFiles(workspacePath), options.snapshotId);
  const key = `control:${action.id || action.name}`;
  return {
    schema_version: SCHEMA_VERSION,
    id: stableCandidateId(snapshot, key),
    kind: "control",
    scope_id: scope.id,
    discovered_by: "execute",
    evidence_refs: [],
    execution_status: "not_executed",
    scope_status: classifyScope({ id: action.id, label: action.name, seed: action.id }, scope),
    review_status: "unreviewed",
    rejection_reason: null,
    discovery_key: key,
    label: action.name
  };
}

async function discoverVisible(
  session: DriverSession,
  scope: Scope,
  workspacePath: string,
  options: RuntimeOptions,
  discoveredBy: string
): Promise<{ candidates: Candidate[]; evidence: EvidenceRecord[] }> {
  const snapshot = resolveSnapshotId(workspacePath, listScanFiles(workspacePath), options.snapshotId);
  const handles = await session.page.$$("[data-control], [data-seed], [data-surface], [data-gesture], [data-action], button, a, textarea, input, form");
  const evidence: EvidenceRecord[] = [];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const ev = evidenceRecord("runtime-dom", {
    url: session.page.url(),
    count: handles.length
  });
  evidence.push(ev);
  for (const handle of handles) {
    const info = await handle.evaluate((node) => {
      const el = node as HTMLElement;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id,
        seed: el.getAttribute("data-seed") ?? "",
        control: el.getAttribute("data-control") ?? "",
        surface: el.getAttribute("data-surface") ?? "",
        gesture: el.getAttribute("data-gesture") ?? "",
        action: el.getAttribute("data-action") ?? "",
        hint: el.getAttribute("data-scope-hint") ?? "",
        label: (el.getAttribute("aria-label") || el.innerText || el.id || "").trim().slice(0, 80)
      };
    });
    const local = info.control || info.seed || info.surface || (info.gesture ? `gesture:${info.gesture}` : "") || info.id || `${info.tag}:${info.action}`;
    if (!local || seen.has(local)) {
      continue;
    }
    seen.add(local);
    const gesture = /\b(swipe|long-press|longpress)\b/i.test(info.gesture || info.action);
    const kind = info.surface && !info.action && !info.control && !info.seed ? "surface" : "control";
    const key = `${kind}:${local}`;
    candidates.push({
      schema_version: SCHEMA_VERSION,
      id: stableCandidateId(snapshot, key),
      kind,
      scope_id: scope.id,
      discovered_by: discoveredBy,
      evidence_refs: [ev.id],
      execution_status: gesture ? "not_executed" : "observed",
      scope_status: classifyScope(
        { id: local, label: info.label, seed: info.seed, hints: [info.hint, info.action, info.gesture] },
        scope
      ),
      review_status: "unreviewed",
      rejection_reason: null,
      discovery_key: key,
      label: info.label || local
    });
  }
  return { candidates, evidence };
}

interface CollectionRead {
  names: string[];
  scrapeError?: string;
}

async function readCollection(session: DriverSession): Promise<CollectionRead> {
  const names: string[] = [];
  const seen = new Set<string>();
  let scrapeError: string | undefined;
  const add = (value: string): void => {
    const name = value.trim();
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    names.push(name);
  };
  for (const role of ["listitem", "link"] as const) {
    try {
      const locators = session.page.getByRole(role);
      const rawCount = await locators.count();
      const count = Math.min(rawCount, COLLECTION_NODE_CAP);
      for (let index = 0; index < count; index += 1) {
        const node = locators.nth(index);
        try {
          const labeled = ((await node.getAttribute("aria-label", { timeout: COLLECTION_ITEM_TIMEOUT_MS })) ?? "").trim();
          const text = labeled
            ? ""
            : ((await node.innerText({ timeout: COLLECTION_ITEM_TIMEOUT_MS })) ?? "").trim();
          add(labeled || text);
        } catch (error) {
          scrapeError ??= error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      scrapeError = error instanceof Error ? error.message : String(error);
    }
  }
  return { names, scrapeError };
}

function noteCollectionGap(gaps: Gap[], read: CollectionRead): void {
  if (!read.scrapeError || gaps.some((item) => item.reason === "collection_scrape")) {
    return;
  }
  gaps.push({
    reason: "collection_scrape",
    message: read.scrapeError
  });
}

function isCollectionScrapeError(message: string): boolean {
  return /getAttribute|innerText|getByRole\('(?:link|listitem)'\)|getByRole\("(?:link|listitem)"\)/.test(
    message
  );
}

function evidenceRecord(kind: string, payload: Record<string, unknown>): EvidenceRecord {
  return {
    schema_version: SCHEMA_VERSION,
    id: newEvidenceId("ev-runtime"),
    immutable: true,
    source: "runtime",
    kind,
    payload
  };
}

export function workspaceAt(path: string): Workspace {
  return { path, read_only: false };
}
