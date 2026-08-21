import type { AgentAnalysisBackend } from "./deterministic.js";

export const LLM_API_KEY_ENV = "BEHAVIOR_MAP_LLM_API_KEY";
export const LLM_ALLOW_NETWORK_ENV = "BEHAVIOR_MAP_ALLOW_NETWORK";

export interface OptionalLlmOptions {
  apiKey?: string;
  allowNetwork?: boolean;
  env?: NodeJS.ProcessEnv;
  complete?: (prompt: string) => Promise<string>;
}

/**
 * LLM 默认关闭。只有显式 API key 且显式允许网络时才打开。
 * CI / 测试不得依赖此路径。
 */
export function isOptionalLlmEnabled(options: OptionalLlmOptions = {}): boolean {
  const env = options.env ?? process.env;
  const key = (options.apiKey ?? env[LLM_API_KEY_ENV] ?? "").trim();
  const allow =
    options.allowNetwork === true ||
    env[LLM_ALLOW_NETWORK_ENV] === "1" ||
    env[LLM_ALLOW_NETWORK_ENV] === "true";
  return Boolean(key) && allow;
}

/**
 * 可选 LLM 后端：与确定性后端同一接口。
 * 未提供 complete 钩子时回退确定性分析，绝不自行发起网络请求。
 */
export class OptionalLlmBackend implements AgentAnalysisBackend {
  constructor(
    private readonly fallback: AgentAnalysisBackend,
    private readonly complete?: (prompt: string) => Promise<string>
  ) {}

  async analyze(
    ...args: Parameters<AgentAnalysisBackend["analyze"]>
  ): ReturnType<AgentAnalysisBackend["analyze"]> {
    if (!this.complete) {
      return this.fallback.analyze(...args);
    }
    try {
      await this.complete("behavior-map agent task");
    } catch {
      // LLM 失败不编造「不存在」，回退确定性分析。
    }
    return this.fallback.analyze(...args);
  }
}
