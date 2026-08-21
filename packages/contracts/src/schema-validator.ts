import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { readJson, readJsonl, readYaml } from "./io.js";
import { validateRunPlanShape } from "./run-plan.js";

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "schemas");

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(schemaDir, name), "utf8")) as object;
}

export type FileKind =
  | "study"
  | "probe-plan"
  | "source"
  | "project-profile"
  | "run-plan"
  | "run-context"
  | "status"
  | "running-project"
  | "evidence"
  | "candidate"
  | "proposal"
  | "diff"
  | "capabilities"
  | "journeys"
  | "effects"
  | "review-decisions"
  | "product-map"
  | "export-manifest"
  | "agent-task";

const SCHEMAS: Record<FileKind, object> = {
  study: loadSchema("study.schema.json"),
  "probe-plan": loadSchema("probe-plan.schema.json"),
  source: loadSchema("source.schema.json"),
  "project-profile": loadSchema("project-profile.schema.json"),
  "run-plan": loadSchema("run-plan.schema.json"),
  "run-context": loadSchema("run-context.schema.json"),
  status: loadSchema("status.schema.json"),
  "running-project": loadSchema("running-project.schema.json"),
  evidence: loadSchema("evidence.schema.json"),
  candidate: loadSchema("candidate.schema.json"),
  proposal: loadSchema("proposal.schema.json"),
  diff: loadSchema("diff.schema.json"),
  capabilities: loadSchema("capabilities.schema.json"),
  journeys: loadSchema("journeys.schema.json"),
  effects: loadSchema("effects.schema.json"),
  "review-decisions": loadSchema("review-decisions.schema.json"),
  "product-map": loadSchema("product-map.schema.json"),
  "export-manifest": loadSchema("export-manifest.schema.json"),
  "agent-task": loadSchema("agent-task.schema.json")
};

export interface StructuralIssue {
  kind: FileKind;
  path: string;
  message: string;
  errors?: ErrorObject[];
}

export interface StructuralReport {
  ok: boolean;
  issues: StructuralIssue[];
}

const PLAINTEXT_SECRET_KEYS = new Set([
  "password",
  "token",
  "api_key",
  "apikey",
  "secret",
  "credential",
  "cookie",
  "access_token",
  "refresh_token"
]);

const REF_KEYS = new Set(["secret_ref", "credential_ref", "cookie_ref"]);

type AjvLike = {
  compile: (schema: object) => ValidateFunction;
};

function createAjv(): AjvLike {
  const Ctor =
    (Ajv as unknown as { default?: new (opts?: object) => AjvLike }).default ??
    (Ajv as unknown as new (opts?: object) => AjvLike);
  const ajv = new Ctor({ allErrors: true, strict: false });
  const formats =
    (addFormats as unknown as { default?: (instance: AjvLike) => void }).default ??
    (addFormats as unknown as (instance: AjvLike) => void);
  formats(ajv);
  return ajv;
}

const ajv = createAjv();
const validators = new Map<FileKind, ValidateFunction>();

function validatorFor(kind: FileKind): ValidateFunction {
  const cached = validators.get(kind);
  if (cached) {
    return cached;
  }
  const compiled = ajv.compile(SCHEMAS[kind]);
  validators.set(kind, compiled);
  return compiled;
}

export function listFileKinds(): FileKind[] {
  return Object.keys(SCHEMAS) as FileKind[];
}

export function getSchema(kind: FileKind): object {
  return SCHEMAS[kind];
}

export function validateDocument(kind: FileKind, data: unknown, path = "<memory>"): StructuralReport {
  const validate = validatorFor(kind);
  const ok = validate(data);
  const issues: StructuralIssue[] = [];
  if (!ok) {
    issues.push({
      kind,
      path,
      message: `${kind} 未通过 JSON Schema`,
      errors: validate.errors ?? undefined
    });
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (!("schema_version" in record)) {
      issues.push({ kind, path, message: "缺少 schema_version" });
    }
  }
  issues.push(...findPlaintextSecrets(kind, data, path));
  if (kind === "run-plan") {
    for (const issue of validateRunPlanShape(data).issues) {
      issues.push({
        kind,
        path: issue.path ? `${path}#${issue.path}` : path,
        message: issue.message
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

function findPlaintextSecrets(kind: FileKind, data: unknown, path: string): StructuralIssue[] {
  const issues: StructuralIssue[] = [];
  walk(data, (key, value) => {
    const normalized = key.toLowerCase();
    if (REF_KEYS.has(normalized)) {
      return;
    }
    if (PLAINTEXT_SECRET_KEYS.has(normalized) && typeof value === "string" && value.length > 0) {
      issues.push({
        kind,
        path,
        message: `禁止在分析文件中写入明文密钥字段 ${key}`
      });
    }
  });
  return issues;
}

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      walk(child, visit);
    }
  }
}

function loadStructured(file: string): unknown {
  if (file.endsWith(".yaml") || file.endsWith(".yml")) {
    return readYaml(file);
  }
  return readJson(file);
}

export function validateAnalysisTree(analysisRoot: string): StructuralReport {
  const issues: StructuralIssue[] = [];

  const topLevel: Array<[FileKind, string]> = [
    ["study", join(analysisRoot, "study.yaml")],
    ["probe-plan", join(analysisRoot, "probe-plan.yaml")]
  ];

  for (const [kind, file] of topLevel) {
    if (!existsSync(file)) {
      issues.push({ kind, path: file, message: "缺少文件" });
      continue;
    }
    issues.push(...validateDocument(kind, loadStructured(file), file).issues);
  }

  const modelFiles: Array<[FileKind, string]> = [
    ["capabilities", join(analysisRoot, "model", "capabilities.yaml")],
    ["journeys", join(analysisRoot, "model", "journeys.yaml")],
    ["effects", join(analysisRoot, "model", "effects.yaml")],
    ["review-decisions", join(analysisRoot, "model", "review-decisions.yaml")]
  ];
  for (const [kind, file] of modelFiles) {
    if (!existsSync(file)) {
      continue;
    }
    issues.push(...validateDocument(kind, loadStructured(file), file).issues);
  }

  const runsDir = join(analysisRoot, "runs");
  if (existsSync(runsDir)) {
    for (const runId of readdirSync(runsDir)) {
      const runDir = join(runsDir, runId);
      const files: Array<[FileKind, string]> = [
        ["source", join(runDir, "source.json")],
        ["project-profile", join(runDir, "project-profile.json")],
        ["run-plan", join(runDir, "run-plan.yaml")],
        ["run-context", join(runDir, "run-context.yaml")],
        ["status", join(runDir, "status.json")],
        ["diff", join(runDir, "diff.json")]
      ];
      for (const [kind, file] of files) {
        if (!existsSync(file)) {
          issues.push({ kind, path: file, message: "缺少文件" });
          continue;
        }
        issues.push(...validateDocument(kind, loadStructured(file), file).issues);
      }

      const running = join(runDir, "running-project.json");
      const status = existsSync(join(runDir, "status.json"))
        ? (loadStructured(join(runDir, "status.json")) as { start_status?: string })
        : {};
      if (status.start_status === "success") {
        if (!existsSync(running)) {
          issues.push({
            kind: "running-project",
            path: running,
            message: "success 运行必须有 running-project.json"
          });
        } else {
          issues.push(...validateDocument("running-project", loadStructured(running), running).issues);
        }
      } else if (existsSync(running)) {
        issues.push({
          kind: "running-project",
          path: running,
          message: "非 success 运行不得提供 explore 可用的 running-project.json"
        });
      }

      const evidenceFiles = [
        join(runDir, "evidence", "static.jsonl"),
        join(runDir, "evidence", "runtime.jsonl")
      ];
      for (const file of evidenceFiles) {
        if (!existsSync(file)) {
          issues.push({ kind: "evidence", path: file, message: "缺少文件" });
          continue;
        }
        for (const [index, row] of readJsonl(file).entries()) {
          issues.push(...validateDocument("evidence", row, `${file}:${index + 1}`).issues);
        }
      }

      const candidates = join(runDir, "candidates.jsonl");
      if (!existsSync(candidates)) {
        issues.push({ kind: "candidate", path: candidates, message: "缺少文件" });
      } else {
        for (const [index, row] of readJsonl(candidates).entries()) {
          issues.push(...validateDocument("candidate", row, `${candidates}:${index + 1}`).issues);
        }
      }

      const proposalsDir = join(runDir, "proposals");
      if (existsSync(proposalsDir)) {
        for (const name of readdirSync(proposalsDir)) {
          if (!name.endsWith(".json")) {
            continue;
          }
          const file = join(proposalsDir, name);
          issues.push(...validateDocument("proposal", loadStructured(file), file).issues);
        }
      }
    }
  }

  const generated = join(analysisRoot, "generated");
  if (existsSync(generated)) {
    const productMap = join(generated, "product-map", "product-map.json");
    if (existsSync(productMap)) {
      issues.push(...validateDocument("product-map", loadStructured(productMap), productMap).issues);
    }
    for (const kind of ["product-map", "diagrams", "web", "tests"] as const) {
      const manifest = join(generated, kind, "journey-ids.json");
      if (existsSync(manifest)) {
        issues.push(...validateDocument("export-manifest", loadStructured(manifest), manifest).issues);
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
