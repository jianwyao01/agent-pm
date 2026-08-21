import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  writeYaml,
  type PlanConfirmation,
  type RunPlan,
  type Workspace
} from "@behavior-map/contracts";

export const TINY_HTTP_SERVER = join(dirname(fileURLToPath(import.meta.url)), "tiny-http-server.cjs");

export function workspaceAt(path: string): Workspace {
  return { path, read_only: false };
}

export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to reserve port"));
        return;
      }
      const port = addr.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

export interface TinyPlanOptions {
  runId: string;
  depPort: number;
  appPort: number;
  confirmation?: PlanConfirmation;
  failAppHealth?: boolean;
  dumpEnvFile?: string;
}

export function tinyTwoProcessPlan(options: TinyPlanOptions): RunPlan {
  const failHealth = options.failAppHealth ? "1" : "0";
  const dump = options.dumpEnvFile ? ` DUMP_ENV_FILE=${JSON.stringify(options.dumpEnvFile)}` : "";
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
          command: `PORT=${options.appPort} COMPONENT_NAME=app FAIL_HEALTH=${failHealth}${dump} MARKER_FILE=marker-app node ${TINY_HTTP_SERVER}`
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

export function writeTrusted(workspacePath: string): void {
  writeYaml(join(workspacePath, "trust.yaml"), {
    schema_version: SCHEMA_VERSION,
    status: "trusted",
    confirmed_by_user: true,
    confirmed_at: "2026-08-21T00:00:00.000Z"
  });
}

export function writePlanFile(workspacePath: string, plan: RunPlan): void {
  writeYaml(join(workspacePath, "run-plan.yaml"), plan);
}
