import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "@behavior-map/source";

export async function createTinyGitRepo(dir: string): Promise<string> {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "tiny fixture\n");
  writeFileSync(join(dir, "src", "hello.txt"), "hello\n");
  await runGit(["init", "-b", "main"], dir);
  await runGit(["config", "user.email", "m1@example.test"], dir);
  await runGit(["config", "user.name", "M1 Fixture"], dir);
  await runGit(["config", "commit.gpgsign", "false"], dir);
  await runGit(["add", "."], dir);
  await runGit(["commit", "-m", "init tiny fixture"], dir);
  return runGit(["rev-parse", "HEAD"], dir);
}

export async function createNonGitTree(dir: string): Promise<void> {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "tiny fixture\n");
  writeFileSync(join(dir, "src", "hello.txt"), "hello\n");
}
