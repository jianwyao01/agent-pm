import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** 非 git 目录的内容摘要。跳过 .git，不伪造 commit。 */
export function contentDigest(root: string): string {
  const files: string[] = [];
  collectFiles(root, root, files);
  files.sort();
  const hash = createHash("sha256");
  for (const abs of files) {
    const rel = relative(root, abs).replaceAll("\\", "/");
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(abs));
    hash.update("\0");
  }
  return `digest-${hash.digest("hex")}`;
}

function collectFiles(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, abs, out);
      continue;
    }
    if (entry.isFile() && statSync(abs).isFile()) {
      out.push(abs);
    }
  }
}
