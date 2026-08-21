import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CROSS_ACTOR_UNEXECUTED,
  SCHEMA_VERSION,
  UNOBSERVED,
  newEvidenceId,
  readYaml,
  stableCandidateId,
  type ActionObservation,
  type Candidate,
  type Control,
  type EvidenceRecord,
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
import { loadCandidates, persistMerged, resolveRunRoot } from "./store.js";
import { listScanFiles, resolveSnapshotId } from "./snapshot.js";

export interface RuntimeOptions {
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
  return readYaml<ProbePlan>(file);
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
  const session = await openSession();
  try {
    const entryUrl = context.entry_url || project.base_url;
    await session.page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    const discovered = await discoverVisible(session, scope, workspacePath, options, "explore");
    if (probe?.entry) {
      const nav = session.page.locator(`[data-seed="${probe.entry}"]`).first();
      if ((await nav.count()) > 0) {
        await nav.click();
        await session.page.waitForLoadState("domcontentloaded");
        const more = await discoverVisible(session, scope, workspacePath, options, "explore");
        discovered.candidates.push(...more.candidates);
        discovered.evidence.push(...more.evidence);
      }
    }
    const runRoot = resolveRunRoot(workspacePath, options);
    const persisted = persistMerged(runRoot, discovered.candidates, [], discovered.evidence);
    return {
      status: "success",
      candidates: persisted.candidates,
      evidence: discovered.evidence,
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

export async function executeAction(
  project: RunningProject,
  context: RunContext,
  action: Control,
  scope: Scope,
  options: RuntimeOptions
): Promise<ActionObservation> {
  const workspacePath = workspaceFromProject(project, options.workspacePath);
  if (!workspacePath) {
    return refusedObservation("missing_workspace", "cannot resolve workspace for execute");
  }
  const study = loadStudy(workspacePath);
  const probe = loadProbePlan(workspacePath);
  if (!probe || probe.human_approved !== true) {
    return refusedObservation("probe_not_approved", "execute send requires human-confirmed probe-plan.yaml");
  }
  if (study && study.exploration_mode !== "approved_probe") {
    return refusedObservation("probe_not_approved", "study.exploration_mode must be approved_probe");
  }
  if (!isApprovedSend(action, probe)) {
    return refusedObservation(
      "action_not_in_probe",
      "real send is driven only by human-confirmed probe-plan.yaml"
    );
  }
  if (isUnsupportedAction(action)) {
    const runRoot = resolveRunRoot(workspacePath, options);
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

  const session = await openSession();
  const evidence: EvidenceRecord[] = [];
  const observations: Observation[] = [];
  try {
    const entryUrl = context.entry_url || project.base_url;
    await session.page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    const listBefore = await readCollection(session);

    const nav = session.page.locator(`[data-seed="${probe.entry}"]`).first();
    if ((await nav.count()) > 0) {
      await nav.click();
      await session.page.waitForLoadState("domcontentloaded");
    }

    const typed = `probe-send-${Date.now().toString(36)}`;
    const typeBox = session.page.locator("[data-action='type'], textarea, input[type='text']").first();
    if ((await typeBox.count()) > 0) {
      await typeBox.fill(typed);
    }

    const beforeRequests = session.requests.length;
    const submit = session.page
      .locator(
        action.locator?.value ||
          `[data-seed="${probe.send_action}"], #${probe.send_action}, [data-control="${probe.send_action}"], [data-action='submit']`
      )
      .first();
    await Promise.all([
      session.page.waitForResponse((response) => response.url().includes("/send"), { timeout: 5000 }).catch(() => undefined),
      submit.click()
    ]);
    await session.page.waitForFunction(
      () => {
        const status = document.getElementById("status");
        return Boolean(status && status.textContent && status.textContent.includes("已发送"));
      },
      { timeout: 5000 }
    ).catch(() => undefined);

    const currentText = ((await session.page.locator("#status, [data-surface='surface-target']").first().textContent()) ?? "").trim();
    const currentEv = evidenceRecord("runtime-current", {
      surface: probe.target_surface,
      text: currentText.slice(0, 400),
      typed
    });
    evidence.push(currentEv);
    observations.push({
      kind: "current_surface",
      observed: Boolean(currentText),
      display_value: currentText || `typed ${typed}`,
      evidence_refs: [currentEv.id],
      surface_id: probe.target_surface
    });

    const newRequests = session.requests.slice(beforeRequests);
    const backend = actualBackendFrom(newRequests, session.page.url());
    if (backend) {
      const backendEv = evidenceRecord("runtime-backend", backend);
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
    let listAfter: string[] = [];
    if (pushed) {
      otherText = "realtime push seen";
    } else {
      await session.page.goto(entryUrl, { waitUntil: "domcontentloaded" });
      listAfter = await readCollection(session);
      otherText = ((await session.page.locator("[data-surface='surface-list'], main").first().textContent()) ?? "").trim();
    }
    const delta = listAfter.filter((item) => !listBefore.includes(item));
    const otherEv = evidenceRecord("runtime-other", {
      realtime_push: pushed,
      refreshed: !pushed,
      surfaces: probe.other_surfaces_to_refresh,
      list_before: listBefore,
      list_after: listAfter,
      delta,
      text: otherText.slice(0, 400)
    });
    evidence.push(otherEv);
    const otherObserved = pushed || delta.length > 0 || listAfter.some((item) => item.includes(typed));
    observations.push({
      kind: "other_surface",
      observed: otherObserved,
      display_value: otherObserved
        ? delta[0] || otherText.slice(0, 80) || typed
        : UNOBSERVED,
      evidence_refs: [otherEv.id],
      surface_id: probe.other_surfaces_to_refresh[0]
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
    const runRoot = resolveRunRoot(workspacePath, options);
    const existingSend = loadCandidates(runRoot).find((row) =>
      row.discovery_key.toLowerCase().includes(probe.send_action.toLowerCase())
    );
    const sendKey = existingSend?.discovery_key ?? `control:${probe.send_action}`;
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
      label: existingSend?.label ?? action.name ?? probe.send_action
    };
    const interaction: Candidate = {
      schema_version: SCHEMA_VERSION,
      id: stableCandidateId(snapshot, `interaction:${probe.send_action}`),
      kind: "interaction",
      scope_id: scope.id,
      discovered_by: "execute",
      evidence_refs: evidence.map((row) => row.id),
      execution_status: "executed",
      scope_status: "in_scope",
      review_status: "unreviewed",
      rejection_reason: null,
      discovery_key: `interaction:${probe.send_action}`,
      label: "probe send"
    };

    const persisted = persistMerged(runRoot, [executed, interaction], [], evidence);
    return {
      status: "success",
      observations,
      evidence,
      candidates: persisted.candidates,
      gaps: [],
      cross_actor: CROSS_ACTOR
    };
  } catch (error) {
    return {
      status: "failed",
      observations,
      evidence,
      candidates: persistMerged(
        resolveRunRoot(workspacePath, options),
        [],
        [],
        evidence
      ).candidates,
      gaps: [
        {
          reason: "execute_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      cross_actor: CROSS_ACTOR
    };
  } finally {
    await closeSession(session);
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

function isApprovedSend(action: Control, probe: ProbePlan): boolean {
  const tokens = [action.id, action.name, action.action, action.locator?.value]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  const send = probe.send_action.toLowerCase();
  return tokens.some((token) => token.includes(send) || send.includes(token) || token === "submit" || token === "send");
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

async function readCollection(session: DriverSession): Promise<string[]> {
  return session.page.$$eval("[data-item-id], #item-list li", (nodes) =>
    nodes.map((node) => (node.textContent ?? "").trim()).filter(Boolean)
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
