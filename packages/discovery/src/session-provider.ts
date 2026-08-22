import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import type { RunContext } from "@behavior-map/contracts";

/**
 * SessionProvider 是 discovery 内部模块，不是第五套公共接口。
 * Phase 1：只注入 storageState / cookies。run-context.yaml 只持有 ref。
 * storageState 文件必须在 analysis/ 之外。
 */
export interface SessionProviderOptions {
  sessionRefs?: Record<string, string>;
  analysisRoot?: string;
}

export function resolveStorageStatePath(
  context: Pick<RunContext, "credential_ref" | "cookie_ref">,
  options: SessionProviderOptions = {}
): string | undefined {
  const refs = [context.cookie_ref, context.credential_ref].filter(
    (value): value is string => Boolean(value)
  );
  for (const ref of refs) {
    const mapped = options.sessionRefs?.[ref] ?? fromFileRef(ref) ?? fromEnv(ref);
    if (!mapped) {
      continue;
    }
    const abs = isAbsolute(mapped) ? mapped : resolve(mapped);
    assertOutsideAnalysis(abs, options.analysisRoot);
    if (existsSync(abs)) {
      return abs;
    }
  }
  return undefined;
}

export async function createContext(
  browser: Browser,
  context: Pick<RunContext, "credential_ref" | "cookie_ref">,
  options: SessionProviderOptions = {}
): Promise<BrowserContext> {
  const storageState = resolveStorageStatePath(context, options);
  if (storageState) {
    return browser.newContext({ storageState });
  }
  return browser.newContext();
}

function fromFileRef(ref: string): string | undefined {
  if (ref.startsWith("file:")) {
    return ref.slice("file:".length);
  }
  return undefined;
}

function fromEnv(ref: string): string | undefined {
  const key = ref.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  if (!key) {
    return undefined;
  }
  return process.env[`BEHAVIOR_MAP_${key}`] ?? process.env[key];
}

export function assertOutsideAnalysis(target: string, analysisRoot?: string): void {
  if (!analysisRoot) {
    return;
  }
  const rel = relative(resolve(analysisRoot), resolve(target));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) {
    throw new Error(`storageState 必须位于 analysis/ 之外: ${target}`);
  }
}
