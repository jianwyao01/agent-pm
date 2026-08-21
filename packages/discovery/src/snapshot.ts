import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readJson, type SourceRecord } from "@behavior-map/contracts";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "runs",
  "generated",
  "model",
  ".vitest"
]);

export const SCAN_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
  ".css"
]);

export function shouldScanFile(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return SCAN_EXTENSIONS.has(lower.slice(dot));
}

export function listScanFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, root, out);
  out.sort();
  return out;
}

function walk(root: string, dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, abs, out);
      continue;
    }
    if (entry.isFile() && statSync(abs).isFile() && shouldScanFile(entry.name)) {
      out.push(abs);
    }
  }
}

export function digestScanFiles(root: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const abs of files) {
    const rel = relative(root, abs).replaceAll("\\", "/");
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(abs));
    hash.update("\0");
  }
  return `digest-${hash.digest("hex").slice(0, 16)}`;
}

export function resolveSnapshotId(workspacePath: string, files: string[], explicit?: string): string {
  if (explicit && explicit.trim()) {
    return explicit;
  }
  const sourceFiles = [
    join(workspacePath, "source.json"),
    ...listRunSourceFiles(workspacePath)
  ];
  for (const file of sourceFiles) {
    if (!existsSync(file)) {
      continue;
    }
    try {
      const record = readJson<SourceRecord>(file);
      if (record.snapshot) {
        return record.snapshot;
      }
    } catch {
      // 忽略损坏的 source.json，回退到内容摘要
    }
  }
  return digestScanFiles(workspacePath, files);
}

function listRunSourceFiles(workspacePath: string): string[] {
  const runs = join(workspacePath, "runs");
  if (!existsSync(runs)) {
    return [];
  }
  return readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runs, entry.name, "source.json"));
}
