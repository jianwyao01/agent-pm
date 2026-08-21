import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  SourcePrepareResult,
  SourceProvider,
  SourceRequest,
  SourceSnapshot,
  Workspace
} from "@behavior-map/contracts";
import { contentDigest } from "./digest.js";
import { isGitWorkTree, isWorkTreeDirty, resolveHeadCommit, runGit } from "./git.js";
import { normalizeGitLocator } from "./locator.js";

export interface DefaultSourceProviderOptions {
  workspaceRoot?: string;
}

/**
 * M1 SourceProvider：git + local。
 * archive 接口存在，返回 not_shipped，而不是「不支持的 source kind」。
 */
export class DefaultSourceProvider implements SourceProvider {
  constructor(private readonly options: DefaultSourceProviderOptions = {}) {}

  async prepare(source: SourceRequest): Promise<SourcePrepareResult> {
    if (source.kind === "archive") {
      return {
        status: "not_shipped",
        kind: "archive",
        message: "archive SourceProvider interface is present; implementation not shipped"
      };
    }
    if (source.kind === "git") {
      return this.prepareGit(source);
    }
    if (source.kind === "local") {
      return this.prepareLocal(source);
    }
    throw new Error(`source kind is not a shipped provider: ${String((source as { kind?: string }).kind)}`);
  }

  private async prepareGit(source: SourceRequest): Promise<Extract<SourcePrepareResult, { status: "ready" }>> {
    const locator = normalizeGitLocator(source.locator);
    const parent = this.options.workspaceRoot ?? tmpdir();
    const workspacePath = mkdtempSync(join(parent, "bm-src-"));
    await runGit(["clone", "--", locator, workspacePath]);
    if (source.revision) {
      await runGit(["-c", "advice.detachedHead=false", "checkout", "--detach", source.revision], workspacePath);
    }
    const commit = await resolveHeadCommit(workspacePath);
    if (!commit) {
      throw new Error("git prepare 未能解析到 commit");
    }
    const snapshot: SourceSnapshot = {
      id: commit,
      revision: commit,
      dirty: false
    };
    const workspace: Workspace = { path: workspacePath, read_only: true };
    return { status: "ready", workspace, snapshot };
  }

  private async prepareLocal(source: SourceRequest): Promise<Extract<SourcePrepareResult, { status: "ready" }>> {
    const workspacePath = resolve(source.locator);
    if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
      throw new Error("local source locator 不是已存在的目录");
    }
    const workspace: Workspace = { path: workspacePath, read_only: true };
    if (await isGitWorkTree(workspacePath)) {
      const commit = await resolveHeadCommit(workspacePath);
      if (commit) {
        const dirty = await isWorkTreeDirty(workspacePath);
        const snapshot: SourceSnapshot = {
          id: commit,
          revision: commit,
          dirty
        };
        return { status: "ready", workspace, snapshot };
      }
    }
    const digest = contentDigest(workspacePath);
    const snapshot: SourceSnapshot = {
      id: digest,
      revision: digest,
      content_digest: digest
    };
    return { status: "ready", workspace, snapshot };
  }
}
