import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  readYaml,
  scopeFromStudy,
  type PlanConfirmation,
  type RunContext,
  type RunPlan,
  type Scope,
  type Study,
  type Workspace
} from "@behavior-map/contracts";
import { TINY_HTTP_SERVER } from "./tiny-processes.js";

export const TWO_SURFACE_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/m4-two-surface"
);

export function copyTwoSurfaceFixture(dest: string): void {
  cpSync(TWO_SURFACE_FIXTURE, dest, { recursive: true });
}

export function workspaceAt(path: string): Workspace {
  return { path, read_only: false };
}

export function fixtureScope(dir: string): Scope {
  const study = readYaml<Study>(join(dir, "study.yaml"));
  return scopeFromStudy(study, "scope-message-sync");
}

export function fixtureContext(dir: string, entryUrl: string): RunContext {
  const context = readYaml<RunContext>(join(dir, "run-context.yaml"));
  return { ...context, entry_url: entryUrl };
}

export function twoSurfacePlan(options: {
  runId: string;
  depPort: number;
  appPort: number;
  confirmation?: PlanConfirmation;
}): RunPlan {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: options.runId,
    secret_refs: [{ secret_ref: "env:STUDY_CREDENTIAL" }],
    components: [
      {
        id: "dep",
        role: "database",
        depends_on: [],
        install: { command: "node -e \"require('fs').writeFileSync('installed-dep','ok')\"" },
        start: {
          command: `PORT=${options.depPort} COMPONENT_NAME=dep MARKER_FILE=marker-dep node ${TINY_HTTP_SERVER}`
        },
        start_order: 1,
        healthcheck: { kind: "http", url: `http://127.0.0.1:${options.depPort}/health` },
        logs: "logs/dep.log",
        seed: { status: "not_done" }
      },
      {
        id: "app",
        role: "app",
        depends_on: ["dep"],
        install: { command: "node -e \"require('fs').writeFileSync('installed-app','ok')\"" },
        start: {
          command: `PORT=${options.appPort} node server.cjs`
        },
        start_order: 2,
        healthcheck: { kind: "http", url: `http://127.0.0.1:${options.appPort}/health` },
        logs: "logs/app.log",
        seed: { status: "not_done" }
      }
    ],
    confirmation: options.confirmation ?? { status: "draft" }
  };
}
