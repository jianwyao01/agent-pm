import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { listRunIds, loadReviewedModel, readJson, readJsonl } from "./io.js";
import type {
  Binding,
  Candidate,
  DiffFile,
  EvidenceRecord,
  ExportManifest,
  Proposal,
  StatusFile
} from "./types.js";
import { countChineseSentences } from "./explanation.js";

export interface SemanticIssue {
  code: string;
  message: string;
  path?: string;
}

export interface SemanticReport {
  ok: boolean;
  issues: SemanticIssue[];
}

function isGeneratedPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized === "generated" ||
    normalized.startsWith("generated/") ||
    normalized.includes("/generated/")
  );
}

function collectEvidence(analysisRoot: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const runId of listRunIds(analysisRoot)) {
    for (const name of ["static.jsonl", "runtime.jsonl"]) {
      const file = join(analysisRoot, "runs", runId, "evidence", name);
      if (!existsSync(file)) {
        continue;
      }
      for (const row of readJsonl<EvidenceRecord>(file)) {
        ids.set(row.id, file);
      }
    }
  }
  return ids;
}

function collectCandidates(analysisRoot: string): Candidate[] {
  const rows: Candidate[] = [];
  for (const runId of listRunIds(analysisRoot)) {
    const file = join(analysisRoot, "runs", runId, "candidates.jsonl");
    if (existsSync(file)) {
      rows.push(...readJsonl<Candidate>(file));
    }
  }
  return rows;
}

function collectBindings(analysisRoot: string): Binding[] {
  const rows: Binding[] = [];
  for (const runId of listRunIds(analysisRoot)) {
    const file = join(analysisRoot, "runs", runId, "bindings.jsonl");
    if (existsSync(file)) {
      rows.push(...readJsonl<Binding>(file));
    }
  }
  return rows;
}

function collectProposals(analysisRoot: string): Array<{ file: string; proposal: Proposal }> {
  const out: Array<{ file: string; proposal: Proposal }> = [];
  for (const runId of listRunIds(analysisRoot)) {
    const dir = join(analysisRoot, "runs", runId, "proposals");
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const file = join(dir, name);
      out.push({ file, proposal: readJson<Proposal>(file) });
    }
  }
  return out;
}

function readExportManifests(analysisRoot: string): ExportManifest[] {
  const kinds = ["product-map", "diagrams", "web", "tests"] as const;
  const manifests: ExportManifest[] = [];
  for (const kind of kinds) {
    const file = join(analysisRoot, "generated", kind, "journey-ids.json");
    if (existsSync(file)) {
      manifests.push(readJson<ExportManifest>(file));
    }
  }
  return manifests;
}

export function validateSemantics(analysisRoot: string): SemanticReport {
  const issues: SemanticIssue[] = [];
  const evidence = collectEvidence(analysisRoot);
  const model = loadReviewedModel(analysisRoot);

  const checkRefs = (refs: string[] | undefined, path: string): void => {
    for (const ref of refs ?? []) {
      if (!evidence.has(ref)) {
        issues.push({
          code: "missing_evidence_ref",
          message: `evidence_ref 不存在: ${ref}`,
          path
        });
      }
    }
  };

  for (const runId of listRunIds(analysisRoot)) {
    const candidatesFile = join(analysisRoot, "runs", runId, "candidates.jsonl");
    if (existsSync(candidatesFile)) {
      for (const [index, candidate] of readJsonl<Candidate>(candidatesFile).entries()) {
        checkRefs(candidate.evidence_refs, `${candidatesFile}:${index + 1}`);
        if (candidate.execution_status === ("out_of_scope" as string)) {
          issues.push({
            code: "invalid_execution_status",
            message: "execution_status 不得使用 out_of_scope（范围应写在 scope_status）",
            path: `${candidatesFile}:${index + 1}`
          });
        }
      }
    }
  }

  const candidatesById = new Map(collectCandidates(analysisRoot).map((row) => [row.id, row]));

  for (const { file, proposal } of collectProposals(analysisRoot)) {
    for (const input of proposal.inputs) {
      if (isGeneratedPath(input)) {
        issues.push({
          code: "generated_is_not_input",
          message: `generated/ 不得作为输入: ${input}`,
          path: file
        });
      }
    }

    const candidateIds = [
      ...(proposal.proposed_features ?? []).flatMap((item) => item.candidate_ids),
      ...proposal.proposed_journeys.flatMap((item) => [
        ...item.candidate_ids,
        ...item.effect_candidate_ids
      ]),
      ...proposal.proposed_effects.map((item) => item.candidate_id),
      ...(proposal.pruned ?? []).map((item) => item.candidate_id)
    ];
    for (const id of candidateIds) {
      if (!candidatesById.has(id)) {
        issues.push({
          code: "missing_candidate_ref",
          message: `proposal 引用了不存在的 candidate ${id}`,
          path: file
        });
      }
    }

    const proposalEvidence = [
      ...(proposal.proposed_features ?? []).flatMap((item) => item.evidence_refs ?? []),
      ...proposal.proposed_journeys.flatMap((item) => item.evidence_refs ?? []),
      ...proposal.proposed_effects.flatMap((item) => item.evidence_refs ?? [])
    ];
    checkRefs(proposalEvidence, file);

    for (const feature of proposal.proposed_features ?? []) {
      if (feature.evidence_refs.length === 0) {
        issues.push({
          code: "missing_evidence_ref",
          message: `无证据边被拒绝: 功能 ${feature.name}`,
          path: file
        });
      }
      if (feature.explanation && countChineseSentences(feature.explanation) < 3) {
        issues.push({
          code: "thin_explanation",
          message: `保留项说明不足三句: ${feature.name}`,
          path: file
        });
      }
    }

    for (const journey of proposal.proposed_journeys) {
      if (journey.evidence_refs && journey.evidence_refs.length === 0) {
        issues.push({
          code: "missing_evidence_ref",
          message: `无证据边被拒绝: 旅程 ${journey.name}`,
          path: file
        });
      }
      if (journey.explanation && countChineseSentences(journey.explanation) < 3) {
        issues.push({
          code: "thin_explanation",
          message: `保留项说明不足三句: ${journey.name}`,
          path: file
        });
      }
    }

    for (const effect of proposal.proposed_effects) {
      if (effect.evidence_refs && effect.evidence_refs.length === 0) {
        issues.push({
          code: "missing_evidence_ref",
          message: `无证据边被拒绝: 效果 ${effect.name}`,
          path: file
        });
      }
      if (effect.explanation && countChineseSentences(effect.explanation) < 3) {
        issues.push({
          code: "thin_explanation",
          message: `保留项说明不足三句: ${effect.name}`,
          path: file
        });
      }
    }

    for (const pruned of proposal.pruned ?? []) {
      if (!pruned.reason.trim()) {
        issues.push({
          code: "missing_prune_reason",
          message: `剪枝项缺少原因: ${pruned.candidate_id}`,
          path: file
        });
      }
    }
  }

  const effectIds = new Set(model.effects.map((effect) => effect.id));
  for (const journey of model.journeys) {
    for (const effectId of journey.effect_ids) {
      if (!effectIds.has(effectId)) {
        issues.push({
          code: "missing_effect_ref",
          message: `journey ${journey.id} 引用了不存在的 effect ${effectId}`,
          path: join(analysisRoot, "model", "journeys.yaml")
        });
      }
    }
  }

  for (const effect of model.effects) {
    checkRefs(effect.observation.evidence_refs, join(analysisRoot, "model", "effects.yaml"));
  }

  const bindings = collectBindings(analysisRoot);
  const bindingsById = new Map(bindings.map((row) => [row.binding_id, row]));

  for (const runId of listRunIds(analysisRoot)) {
    const runBindings = existsSync(join(analysisRoot, "runs", runId, "bindings.jsonl"))
      ? readJsonl<Binding>(join(analysisRoot, "runs", runId, "bindings.jsonl"))
      : [];
    const runBindingIds = new Set(runBindings.map((row) => row.binding_id));
    const runtimeFile = join(analysisRoot, "runs", runId, "evidence", "runtime.jsonl");
    if (existsSync(runtimeFile)) {
      for (const [index, row] of readJsonl<EvidenceRecord>(runtimeFile).entries()) {
        const bindingId = row.payload?.binding_id;
        if (typeof bindingId === "string" && bindingId.length > 0 && !runBindingIds.has(bindingId)) {
          issues.push({
            code: "missing_binding_ref",
            message: `execute/play 产物引用了不存在的 binding_id ${bindingId}`,
            path: `${runtimeFile}:${index + 1}`
          });
        }
      }
    }

    const controlsFile = join(analysisRoot, "runs", runId, "controls.jsonl");
    if (existsSync(controlsFile)) {
      for (const [index, row] of readJsonl<Record<string, unknown>>(controlsFile).entries()) {
        if (hasSemanticGuess(row)) {
          issues.push({
            code: "semantic_guess_on_control",
            message: "controls.jsonl 只允许页面事实，禁止 send_message / login 等语义猜测",
            path: `${controlsFile}:${index + 1}`
          });
        }
      }
    }

    const bindingsFile = join(analysisRoot, "runs", runId, "bindings.jsonl");
    if (existsSync(bindingsFile)) {
      for (const [index, row] of readJsonl<Record<string, unknown>>(bindingsFile).entries()) {
        if (hasSemanticGuess(row)) {
          issues.push({
            code: "semantic_guess_on_binding",
            message: "bindings.jsonl 禁止语义猜测",
            path: `${bindingsFile}:${index + 1}`
          });
        }
      }
    }
  }

  const specFile = join(analysisRoot, "generated", "tests", "journeys.spec.ts");
  if (existsSync(specFile) && bindings.length > 0) {
    const spec = readFileSync(specFile, "utf8");
    if (/getByRole|page\.locator\(/.test(spec)) {
      const approvedInSpec = bindings.some((row) => spec.includes(row.approved_locator.value));
      if (!approvedInSpec) {
        issues.push({
          code: "generated_locator_mismatch",
          message: "generated test locator 必须等于 approved_locator",
          path: specFile
        });
      }
      const fallbackSend = bindings.some((row) => row.approved_locator.value.includes("#control-send"));
      if (spec.includes("#control-send") && !fallbackSend) {
        issues.push({
          code: "generated_locator_mismatch",
          message: "generated test locator 不得回退 #control-send",
          path: specFile
        });
      }
    }
    for (const journey of model.journeys) {
      if (!journey.steps?.length || !journeyTestEmitsLocators(spec, journey.id)) {
        continue;
      }
      for (const step of journey.steps) {
        const binding = bindingsById.get(step.binding_id);
        if (!binding) {
          continue;
        }
        if (!spec.includes(binding.approved_locator.value)) {
          issues.push({
            code: "generated_locator_mismatch",
            message: `generated test 每一步 locator 必须等于 approved_locator（${step.binding_id}）`,
            path: specFile
          });
        }
      }
    }
  }

  const generatedDir = join(analysisRoot, "generated");
  if (existsSync(generatedDir)) {
    const manifests = readExportManifests(analysisRoot);
    if (manifests.length === 4) {
      const [first, ...rest] = manifests;
      const expected = [...first.journey_ids].sort().join("|");
      for (const manifest of rest) {
        const actual = [...manifest.journey_ids].sort().join("|");
        if (actual !== expected) {
          issues.push({
            code: "export_journey_mismatch",
            message: `四份导出的 journey_id 不一致: ${first.kind} vs ${manifest.kind}`,
            path: join(analysisRoot, "generated")
          });
        }
      }
      const modelIds = [...model.journeys.map((journey) => journey.id)].sort().join("|");
      if (expected !== modelIds) {
        issues.push({
          code: "export_journey_not_from_model",
          message: "导出 journey_id 必须与 reviewed model 一致",
          path: join(analysisRoot, "generated")
        });
      }
    } else if (manifests.length > 0) {
      issues.push({
        code: "incomplete_exports",
        message: "若存在 generated/，四份导出必须同时具备 journey-ids.json",
        path: generatedDir
      });
    }
  }

  for (const runId of listRunIds(analysisRoot)) {
    const statusFile = join(analysisRoot, "runs", runId, "status.json");
    if (!existsSync(statusFile)) {
      continue;
    }
    const status = readJson<StatusFile>(statusFile);
    const prev = findPreviousCompletedRun(analysisRoot, status.study_id, status.scope_id, runId);
    const diffFile = join(analysisRoot, "runs", runId, "diff.json");
    if (existsSync(diffFile) && prev) {
      const diff = readJson<DiffFile>(diffFile);
      const explicit = diff.baseline_source === "explicit";
      if (!explicit && diff.baseline_run_id !== prev && diff.baseline_run_id !== runId) {
        issues.push({
          code: "diff_baseline_not_previous",
          message: `diff.json 默认应对比同一 study+scope 的上一完成 run（期望 ${prev}）；其它基线只能通过显式参数`,
          path: diffFile
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function findPreviousCompletedRun(
  analysisRoot: string,
  studyId: string,
  scopeId: string,
  currentRunId: string
): string | undefined {
  const completed: string[] = [];
  for (const runId of listRunIds(analysisRoot)) {
    if (runId === currentRunId) {
      break;
    }
    const statusFile = join(analysisRoot, "runs", runId, "status.json");
    if (!existsSync(statusFile)) {
      continue;
    }
    const status = readJson<StatusFile>(statusFile);
    if (status.completed && status.study_id === studyId && status.scope_id === scopeId) {
      completed.push(runId);
    }
  }
  return completed.at(-1);
}

export function assertPathInsideAnalysis(analysisRoot: string, target: string): string {
  const rel = relative(analysisRoot, target);
  if (rel.startsWith(`..${sep}`) || rel === "..") {
    throw new Error(`路径越出 analysis 根目录: ${target}`);
  }
  return rel.replaceAll("\\", "/");
}

export function approvedReadsForRun(runId: string): string[] {
  return [
    "study.yaml",
    "probe-plan.yaml",
    `runs/${runId}/source.json`,
    `runs/${runId}/project-profile.json`,
    `runs/${runId}/run-plan.yaml`,
    `runs/${runId}/run-context.yaml`,
    `runs/${runId}/status.json`,
    `runs/${runId}/candidates.jsonl`,
    `runs/${runId}/controls.jsonl`,
    `runs/${runId}/bindings.jsonl`,
    `runs/${runId}/evidence/static.jsonl`,
    `runs/${runId}/evidence/runtime.jsonl`,
    "model/capabilities.yaml",
    "model/journeys.yaml",
    "model/effects.yaml",
    "model/review-decisions.yaml"
  ];
}

function journeyTestEmitsLocators(spec: string, journeyId: string): boolean {
  const marker = `// Journey ID: ${journeyId}`;
  const start = spec.indexOf(marker);
  if (start < 0) {
    return false;
  }
  const next = spec.indexOf("// Journey ID:", start + marker.length);
  const block = next < 0 ? spec.slice(start) : spec.slice(start, next);
  return /getByRole|page\.locator\(/.test(block) && !/test\.skip/.test(block);
}

function hasSemanticGuess(row: Record<string, unknown>): boolean {
  const forbiddenKeys = ["intent", "semantic", "guess", "purpose", "meaning", "send_message", "login"];
  return forbiddenKeys.some((key) => key in row);
}

export { collectCandidates, collectBindings, collectEvidence, collectProposals, isGeneratedPath };
