import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  readJson,
  readYaml,
  type HowToRunClue,
  type ProfileFace,
  type ProfilePart,
  type ProjectProfile,
  type Workspace
} from "@behavior-map/contracts";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  meteor?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ComposeService {
  image?: string;
  build?: unknown;
  environment?: Record<string, unknown> | string[];
  ports?: unknown[];
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
}

const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml"
];

const README_FILES = ["README.md", "README", "README.txt"];

const START_HINT =
  /(?:npm(?:\s+run)?\s+(?:start|dev|meteor)\b|meteor(?:\s+npm\s+install|\s+run\b|\b)|docker(?:-|\s+)compose\s+up(?:\s+[^\n]*)?|make\s+(?:start|up|dev)\b)/i;

const SECRET_ENV = /PASSWORD|TOKEN|SECRET|API[_-]?KEY|CREDENTIAL/i;

export interface DetectExtras {
  composeServiceNames: Record<string, string>;
  secretRefs: string[];
}

function readTextIfExists(file: string): string | undefined {
  if (!existsSync(file) || !statSync(file).isFile()) {
    return undefined;
  }
  return readFileSync(file, "utf8");
}

function hasDep(pkg: PackageJson, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function upsertPart(parts: ProfilePart[], id: string, role: string, clue: string): ProfilePart {
  const existing = parts.find((part) => part.id === id || (part.role === role && (role === "app" || role === "database" || role === "cache")));
  if (existing) {
    existing.clues = existing.clues ?? [];
    addUnique(existing.clues, clue);
    return existing;
  }
  const created: ProfilePart = { id, role, clues: [clue] };
  parts.push(created);
  return created;
}

function upsertFace(faces: ProfileFace[], id: string, name: string, clue: string): void {
  const existing = faces.find((face) => face.id === id);
  if (existing) {
    existing.clues = existing.clues ?? [];
    addUnique(existing.clues, clue);
    return;
  }
  faces.push({ id, name, clues: [clue] });
}

function looksLikeMongo(name: string, image: string): boolean {
  return /mongo/i.test(name) || /mongo/i.test(image);
}

function looksLikeRedis(name: string, image: string): boolean {
  return /redis/i.test(name) || /redis/i.test(image);
}

function looksLikePostgres(name: string, image: string): boolean {
  return /postgres/i.test(name) || /postgres/i.test(image);
}

function looksLikeMysql(name: string, image: string): boolean {
  return /mysql|mariadb/i.test(name) || /mysql|mariadb/i.test(image);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "service";
}

function collectSecretEnvKeys(environment: ComposeService["environment"]): string[] {
  if (!environment) {
    return [];
  }
  const keys = Array.isArray(environment)
    ? environment.map((entry) => String(entry).split("=")[0] ?? "")
    : Object.keys(environment);
  return keys.filter((key) => SECRET_ENV.test(key));
}

function loadCompose(root: string): { file: string; data: ComposeFile } | undefined {
  for (const name of COMPOSE_FILES) {
    const file = join(root, name);
    if (!existsSync(file)) {
      continue;
    }
    try {
      return { file: name, data: readYaml<ComposeFile>(file) ?? {} };
    } catch {
      return { file: name, data: {} };
    }
  }
  return undefined;
}

function loadPackageJson(root: string): PackageJson | undefined {
  const file = join(root, "package.json");
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    return readJson<PackageJson>(file);
  } catch {
    return undefined;
  }
}

function collectReadmeHints(root: string): HowToRunClue[] {
  const hints: HowToRunClue[] = [];
  for (const name of README_FILES) {
    const text = readTextIfExists(join(root, name));
    if (!text) {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^\s*[#>*`-]+\s*/, "").replace(/^\$\s*/, "").trim();
      if (START_HINT.test(line)) {
        hints.push({ source: name, hint: line });
      }
    }
  }
  return hints;
}

function hasMeteorTree(root: string): boolean {
  return existsSync(join(root, ".meteor")) || existsSync(join(root, "meteor"));
}

function listSeedPath(root: string): string | undefined {
  const candidates = [
    "seed",
    "seed.js",
    "seed.mjs",
    "seeds",
    "mongo-init.js",
    "mongo-init",
    "docker/mongo-init.js",
    "docker/mongo-init"
  ];
  for (const rel of candidates) {
    if (existsSync(join(root, rel))) {
      return rel;
    }
  }
  return undefined;
}

export function detectWorkspaceExtras(workspace: Workspace): DetectExtras {
  const extras: DetectExtras = { composeServiceNames: {}, secretRefs: [] };
  const compose = loadCompose(workspace.path);
  if (!compose?.data.services) {
    return extras;
  }
  for (const [name, service] of Object.entries(compose.data.services)) {
    extras.composeServiceNames[name] = name;
    for (const key of collectSecretEnvKeys(service?.environment)) {
      addUnique(extras.secretRefs, `env:${key}`);
    }
  }
  return extras;
}

export function detectSeedPath(workspace: Workspace): string | undefined {
  return listSeedPath(workspace.path);
}

export function detectProject(workspace: Workspace): ProjectProfile {
  const faces: ProfileFace[] = [];
  const parts: ProfilePart[] = [];
  const frameworks: string[] = [];
  const how_to_run: HowToRunClue[] = [];

  const pkg = loadPackageJson(workspace.path);
  if (pkg) {
    addUnique(frameworks, "node");
    upsertPart(parts, "app", "app", "package.json");
    upsertFace(faces, "web", "web", "package.json");
    if (pkg.meteor !== undefined || hasDep(pkg, "meteor-node-stubs")) {
      addUnique(frameworks, "meteor");
    }
    if (hasDep(pkg, "mongodb") || hasDep(pkg, "mongoose")) {
      addUnique(frameworks, "mongo");
      upsertPart(parts, "database", "database", "package.json");
    }
    if (hasDep(pkg, "redis") || hasDep(pkg, "ioredis")) {
      addUnique(frameworks, "redis");
      upsertPart(parts, "cache", "cache", "package.json");
    }
    if (hasDep(pkg, "pg") || hasDep(pkg, "postgres")) {
      addUnique(frameworks, "postgres");
      upsertPart(parts, "database", "database", "package.json");
    }
    for (const [script, command] of Object.entries(pkg.scripts ?? {})) {
      if (/^(start|dev|meteor)$/i.test(script) || START_HINT.test(command)) {
        how_to_run.push({ source: "package.json", hint: `npm run ${script} / ${command}` });
      }
    }
  }

  if (hasMeteorTree(workspace.path)) {
    addUnique(frameworks, "meteor");
    upsertPart(parts, "app", "app", existsSync(join(workspace.path, ".meteor")) ? ".meteor" : "meteor");
    upsertFace(faces, "web", "web", ".meteor");
    how_to_run.push({ source: ".meteor", hint: "meteor" });
  }

  const compose = loadCompose(workspace.path);
  if (compose) {
    addUnique(frameworks, "docker-compose");
    how_to_run.push({ source: compose.file, hint: "docker compose up" });
    for (const [name, service] of Object.entries(compose.data.services ?? {})) {
      const image = String(service?.image ?? "");
      const clue = `${compose.file}:${name}`;
      if (looksLikeMongo(name, image)) {
        addUnique(frameworks, "mongo");
        upsertPart(parts, "database", "database", clue);
        continue;
      }
      if (looksLikeRedis(name, image)) {
        addUnique(frameworks, "redis");
        upsertPart(parts, "cache", "cache", clue);
        continue;
      }
      if (looksLikePostgres(name, image)) {
        addUnique(frameworks, "postgres");
        upsertPart(parts, "database", "database", clue);
        continue;
      }
      if (looksLikeMysql(name, image)) {
        addUnique(frameworks, "mysql");
        upsertPart(parts, "database", "database", clue);
        continue;
      }
      if (/^app$|web|frontend|backend|meteor/i.test(name)) {
        upsertPart(parts, "app", "app", clue);
        upsertFace(faces, "web", "web", clue);
        continue;
      }
      upsertPart(parts, slug(name), "service", clue);
    }
  }

  how_to_run.push(...collectReadmeHints(workspace.path));

  return {
    schema_version: SCHEMA_VERSION,
    faces,
    parts,
    frameworks,
    how_to_run
  };
}
