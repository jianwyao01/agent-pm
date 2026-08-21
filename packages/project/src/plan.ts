import {
  SCHEMA_VERSION,
  type ComponentHealthcheck,
  type ComponentSeed,
  type ProjectProfile,
  type RunPlan,
  type RunPlanComponent,
  type SecretRef,
  type Workspace
} from "@behavior-map/contracts";
import { detectSeedPath, detectWorkspaceExtras } from "./detect.js";

function composeServiceName(part: ProjectProfile["parts"][number]): string | undefined {
  const clue = part.clues?.find((item) => item.includes(":"));
  if (!clue) {
    return undefined;
  }
  const idx = clue.lastIndexOf(":");
  return idx >= 0 ? clue.slice(idx + 1) : undefined;
}

function installCommand(part: ProjectProfile["parts"][number], frameworks: string[]): string {
  if (part.role === "database" || part.role === "cache" || part.role === "service") {
    const service = composeServiceName(part) ?? part.id;
    return `docker compose up -d ${service}`;
  }
  if (frameworks.includes("meteor")) {
    return "meteor npm install";
  }
  if (frameworks.includes("node")) {
    return "npm install";
  }
  return "install from how_to_run clues";
}

function healthcheckFor(part: ProjectProfile["parts"][number], frameworks: string[]): ComponentHealthcheck {
  if (part.role === "database") {
    if (frameworks.includes("postgres")) {
      return { kind: "tcp", port: 5432 };
    }
    if (frameworks.includes("mysql")) {
      return { kind: "tcp", port: 3306 };
    }
    return { kind: "tcp", port: 27017 };
  }
  if (part.role === "cache") {
    return { kind: "tcp", port: 6379 };
  }
  if (part.role === "app") {
    return { kind: "http", url: "http://localhost:3000" };
  }
  return { kind: "command", command: "true" };
}

function startOrder(part: ProjectProfile["parts"][number], index: number): number {
  if (part.role === "database") {
    return 1;
  }
  if (part.role === "cache") {
    return 2;
  }
  if (part.role === "app") {
    return 100;
  }
  return 10 + index;
}

function dependsOn(part: ProjectProfile["parts"][number], parts: ProjectProfile["parts"]): string[] {
  if (part.role !== "app") {
    return [];
  }
  return parts.filter((item) => item.role === "database" || item.role === "cache").map((item) => item.id);
}

function seedFor(workspace: Workspace): ComponentSeed {
  const path = detectSeedPath(workspace);
  if (path) {
    return { status: "present", path };
  }
  return { status: "not_done" };
}

export function buildRunPlan(workspace: Workspace, profile: ProjectProfile): RunPlan {
  const extras = detectWorkspaceExtras(workspace);
  const seed = seedFor(workspace);
  const components: RunPlanComponent[] = profile.parts.map((part, index) => ({
    id: part.id,
    role: part.role,
    depends_on: dependsOn(part, profile.parts),
    install: { command: installCommand(part, profile.frameworks) },
    start_order: startOrder(part, index),
    healthcheck: healthcheckFor(part, profile.frameworks),
    logs: `logs/${part.id}.log`,
    seed: { ...seed }
  }));

  components.sort((a, b) => a.start_order - b.start_order || a.id.localeCompare(b.id));

  const secret_refs: SecretRef[] = extras.secretRefs.map((secret_ref) => ({ secret_ref }));

  return {
    schema_version: SCHEMA_VERSION,
    secret_refs,
    components,
    confirmation: { status: "draft" }
  };
}
