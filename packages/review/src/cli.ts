import { applyHumanReview, type HumanReviewSpec } from "./apply-review.js";
import { writeRunDiff } from "./write-diff.js";

export type ReviewCliCommand = "write-diff" | "apply";

export interface ReviewCliArgs {
  command: ReviewCliCommand;
  analysisRoot: string;
  runId: string;
  /** 仅 --baseline 能改基线；省略则用上一完成 run。 */
  baselineRunId?: string;
  decisionsJson?: string;
}

export function parseReviewCliArgs(argv: string[]): ReviewCliArgs {
  const args = [...argv];
  const command = args.shift();
  if (command !== "write-diff" && command !== "apply") {
    throw new Error("命令只允许 write-diff 或 apply");
  }
  let analysisRoot: string | undefined;
  let runId: string | undefined;
  let baselineRunId: string | undefined;
  let decisionsJson: string | undefined;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--analysis" || flag === "--analysis-root") {
      analysisRoot = needValue(flag, args.shift());
      continue;
    }
    if (flag === "--run" || flag === "--run-id") {
      runId = needValue(flag, args.shift());
      continue;
    }
    if (flag === "--baseline" || flag === "--baseline-run-id") {
      baselineRunId = needValue(flag, args.shift());
      continue;
    }
    if (flag === "--decisions") {
      decisionsJson = needValue(flag, args.shift());
      continue;
    }
    throw new Error(`未知参数 ${flag}。改基线只能用 --baseline`);
  }
  if (!analysisRoot || !runId) {
    throw new Error("必须提供 --analysis 与 --run");
  }
  return { command, analysisRoot, runId, baselineRunId, decisionsJson };
}

export function runReviewCli(argv: string[]): { ok: true; output?: string } {
  const parsed = parseReviewCliArgs(argv);
  if (parsed.command === "write-diff") {
    const diff = writeRunDiff({
      analysisRoot: parsed.analysisRoot,
      runId: parsed.runId,
      baselineRunId: parsed.baselineRunId
    });
    return { ok: true, output: JSON.stringify(diff, null, 2) };
  }
  const spec: HumanReviewSpec = parsed.decisionsJson
    ? (JSON.parse(parsed.decisionsJson) as HumanReviewSpec)
    : {};
  const model = applyHumanReview({
    analysisRoot: parsed.analysisRoot,
    runId: parsed.runId,
    spec
  });
  return { ok: true, output: JSON.stringify({ journey_ids: model.journeys.map((item) => item.id) }) };
}

function needValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} 需要参数值`);
  }
  return value;
}

export function main(argv = process.argv.slice(2)): void {
  const result = runReviewCli(argv);
  if (result.output) {
    process.stdout.write(`${result.output}\n`);
  }
}
