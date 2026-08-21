import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  validateDocument,
  type SourceRequest,
  type SourceSnapshot,
  type Workspace
} from "@behavior-map/contracts";
import {
  DefaultSourceProvider,
  snapshotHasNoKind,
  toSourceRecord
} from "@behavior-map/source";
import { createNonGitTree, createTinyGitRepo } from "./helpers/tiny-git.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function consumeDownstream(workspace: Workspace, snapshot: SourceSnapshot): {
  path: string;
  snapshot_id: string;
} {
  return { path: workspace.path, snapshot_id: snapshot.id };
}

describe("M1 SourceProvider", () => {
  it("prepare(git) 通过 file:// 克隆临时夹具，与 prepare(local) 得到同一 commit 身份", async () => {
    const repo = tmp("bm-m1-repo-");
    const commit = await createTinyGitRepo(repo);
    const fileUrl = pathToFileURL(repo).href;
    expect(fileUrl).not.toMatch(/Rocket\.Chat|RocketChat|github\.com/i);

    const provider = new DefaultSourceProvider({ workspaceRoot: tmp("bm-m1-ws-") });
    const git = await provider.prepare({
      schema_version: SCHEMA_VERSION,
      kind: "git",
      locator: fileUrl
    });
    const local = await provider.prepare({
      schema_version: SCHEMA_VERSION,
      kind: "local",
      locator: repo
    });

    expect(git.status).toBe("ready");
    expect(local.status).toBe("ready");
    if (git.status !== "ready" || local.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(git.snapshot.id).toBe(commit);
    expect(local.snapshot.id).toBe(commit);
    expect(git.snapshot.id).toBe(local.snapshot.id);
    expect(git.snapshot.revision).toBe(commit);
    expect(local.snapshot.dirty).toBe(false);
    expect(git.workspace.read_only).toBe(true);
    expect(local.workspace.read_only).toBe(true);

    expect(snapshotHasNoKind(git.snapshot)).toBe(true);
    expect(git.snapshot).not.toHaveProperty("kind");
    expect(consumeDownstream(git.workspace, git.snapshot).snapshot_id).toBe(
      consumeDownstream(local.workspace, local.snapshot).snapshot_id
    );

    const gitRecord = toSourceRecord({ kind: "git", locator: fileUrl }, git.snapshot);
    const localRecord = toSourceRecord({ kind: "local", locator: repo }, local.snapshot);
    for (const record of [gitRecord, localRecord]) {
      expect(validateDocument("source", record).ok).toBe(true);
      expect(record.schema_version).toBe(SCHEMA_VERSION);
      expect(record.kind === "git" || record.kind === "local").toBe(true);
      expect(record.locator).toBeTruthy();
      expect(record.revision).toBe(commit);
      expect(record.snapshot).toBe(commit);
      expect(record).not.toHaveProperty("scope");
      expect(record.kind).not.toBe("github");
      expect(record).not.toHaveProperty("github");
      expect(record).not.toHaveProperty("gitlab");
    }
    expect(gitRecord.locator.startsWith("file:")).toBe(true);
    expect(localRecord.locator.includes("/")).toBe(false);
  });

  it("脏工作区 local git 记录 dirty:true，revision 仍是 HEAD commit", async () => {
    const repo = tmp("bm-m1-dirty-");
    const commit = await createTinyGitRepo(repo);
    writeFileSync(join(repo, "README.md"), "dirty change\n");
    const provider = new DefaultSourceProvider();
    const result = await provider.prepare({ kind: "local", locator: repo });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(result.snapshot.dirty).toBe(true);
    expect(result.snapshot.id).toBe(commit);
    const record = toSourceRecord({ kind: "local", locator: repo }, result.snapshot);
    expect(record.dirty).toBe(true);
    expect(record.revision).toBe(commit);
    expect(validateDocument("source", record).ok).toBe(true);
  });

  it("非 git local 记录 content_digest，不伪造 commit", async () => {
    const dir = tmp("bm-m1-nongit-");
    await createNonGitTree(dir);
    const provider = new DefaultSourceProvider();
    const result = await provider.prepare({ kind: "local", locator: dir });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(result.snapshot.content_digest).toMatch(/^digest-[0-9a-f]+$/);
    expect(result.snapshot.id).toBe(result.snapshot.content_digest);
    expect(result.snapshot.revision).toBe(result.snapshot.content_digest);
    expect(result.snapshot).not.toHaveProperty("commit");
    const record = toSourceRecord({ kind: "local", locator: dir }, result.snapshot);
    expect(record.content_digest).toBe(result.snapshot.content_digest);
    expect(record.revision).toBe(record.content_digest);
    expect(record).not.toHaveProperty("commit");
    expect(validateDocument("source", record).ok).toBe(true);

    const twin = tmp("bm-m1-nongit-b-");
    await createNonGitTree(twin);
    const again = await provider.prepare({ kind: "local", locator: twin });
    if (again.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(again.snapshot.id).toBe(result.snapshot.id);
  });

  it("archive 接口存在，prepare 返回未交付而不是拒绝 kind", async () => {
    const provider = new DefaultSourceProvider();
    const request: SourceRequest = {
      kind: "archive",
      locator: "memory://sample.tar"
    };
    const result = await provider.prepare(request);
    expect(result.status).toBe("not_shipped");
    if (result.status !== "not_shipped") {
      throw new Error("expected not_shipped");
    }
    expect(result.kind).toBe("archive");
    expect(result.message).toMatch(/not shipped|unimplemented/i);
    expect(result.message).not.toMatch(/unsupported source kind/i);
  });

  it("GitHub URL 仍是 kind=git，不是 github 类型；测试绝不克隆 Rocket.Chat", async () => {
    const record = toSourceRecord(
      { kind: "git", locator: "https://github.com/example/sample.git" },
      { id: "abc123def", revision: "abc123def" }
    );
    expect(record.kind).toBe("git");
    expect(Object.keys(record)).not.toContain("github");
    expect(validateDocument("source", record).ok).toBe(true);
    expect(validateDocument("source", { ...record, kind: "github" }).ok).toBe(false);
    expect(validateDocument("source", { ...record, scope: "chat" }).ok).toBe(false);

    const sourceImpl = new URL("../packages/source/src/provider.ts", import.meta.url).pathname;
    const text = await import("node:fs").then((fs) => fs.readFileSync(sourceImpl, "utf8"));
    expect(text).not.toMatch(/RocketChat\/Rocket\.Chat/);
    expect(text).not.toMatch(/github\.com\/RocketChat/);
  });

  it("空 git 仓库（尚无 commit）按非 git 处理，不伪造 commit", async () => {
    const dir = tmp("bm-m1-emptygit-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "only.txt"), "x\n");
    const { runGit } = await import("@behavior-map/source");
    await runGit(["init", "-b", "main"], dir);
    const result = await new DefaultSourceProvider().prepare({ kind: "local", locator: dir });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(result.snapshot.content_digest).toBeTruthy();
    expect(result.snapshot).not.toHaveProperty("commit");
    expect(result.snapshot.id.startsWith("digest-")).toBe(true);
  });
});
