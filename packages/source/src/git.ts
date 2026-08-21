import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0"
    }
  });
  return stdout.trim();
}

export async function isGitWorkTree(dir: string): Promise<boolean> {
  try {
    const value = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
    return value === "true";
  } catch {
    return false;
  }
}

export async function resolveHeadCommit(dir: string): Promise<string | undefined> {
  try {
    const sha = await runGit(["rev-parse", "HEAD"], dir);
    return sha || undefined;
  } catch {
    return undefined;
  }
}

export async function isWorkTreeDirty(dir: string): Promise<boolean> {
  const porcelain = await runGit(["status", "--porcelain"], dir);
  return porcelain.length > 0;
}
