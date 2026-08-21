import { basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceKind } from "@behavior-map/contracts";

export function normalizeGitLocator(locator: string): string {
  const trimmed = locator.trim();
  if (/^(file|https|http|git|ssh):/i.test(trimmed) || trimmed.startsWith("git@")) {
    return trimmed;
  }
  if (isAbsolute(trimmed)) {
    return pathToFileURL(trimmed).href;
  }
  return trimmed;
}

/**
 * source.json 的 locator：git 记 URL；local 不用绝对路径当长期身份。
 */
export function recordLocator(kind: SourceKind, locator: string): string {
  if (kind === "git") {
    return normalizeGitLocator(locator);
  }
  if (kind === "local") {
    if (isAbsolute(locator)) {
      return basename(locator.replace(/[\\/]+$/, ""));
    }
    return locator.replaceAll("\\", "/").replace(/^\.\//, "");
  }
  return locator;
}
