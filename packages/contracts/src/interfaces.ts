import type {
  ActionObservation,
  AgentResult,
  AgentTask,
  Control,
  DiscoveryProjectInput,
  ProjectProfile,
  RunningProject,
  RunContext,
  RunPlan,
  RuntimeDiscoveryResult,
  Scope,
  SourcePrepareResult,
  SourceRequest,
  StartResult,
  StaticDiscoveryResult,
  StopResult,
  Workspace
} from "./types.js";

/**
 * 四接口。M1 实现 SourceProvider（git + local；archive 接口保留未交付）。
 * M2 实现 ProjectAdapter.detect / createRunPlan；M3 实现 start / stop。
 * M4 实现 DiscoveryAdapter.scan / explore / execute；M4b 增加 play（Probe 序列共用会话，不是第五套接口）。
 * M5 实现真实 AgentRunner（DefaultAgentRunner）；Mock 仍用于合约测试。
 * M6 实现人工审定 model/ 与四份导出函数（不是第五套接口）。
 * M6b 把 play 定为官方 ProbePlan runner，并增加官方 retarget；play 仍不是第五套接口。
 * M7 的 runClosedLoop 是 review 包里的函数，不是第五套接口。
 * M8 深化创建域：Journey.entry_url 与可指定 journey_id 的 addJourney；四接口不变。
 * M8c：retarget 重映射残留能力名；四接口不变。
 * M9：HumanReviewSpec.confirmEffects 确认已有六列槽位；四接口不变。
 * M14：collection 刮取失败不得把已成功的 play 点击打成 execute_failed；四接口不变。
 * M16：dump 把节点 title / aria-label 记为 locator 候选；人类可批准其中一条；四接口不变。
 * M17：HumanReviewSpec.annotate 写入 MAP-2/7/8；generateAll 投影可观察 MAP-4/5；控件落成 control 候选。四接口不变。
 * boot / discovery 只消费 Workspace + SourceSnapshot，不得依赖 source.kind。
 * 替换 AgentRunner 时，Source / Project / Discovery / Export 代码无需改动。
 */

export interface SourceProvider {
  prepare(source: SourceRequest): Promise<SourcePrepareResult>;
}

export interface ProjectAdapter {
  detect(workspace: Workspace): Promise<ProjectProfile>;
  createRunPlan(workspace: Workspace, profile: ProjectProfile): Promise<RunPlan>;
  /**
   * 只读取 confirmation.status === "confirmed" 的 run-plan.yaml。
   * 未确认或未信任的目标不得安装或执行目标脚本。
   */
  start(workspace: Workspace, plan: RunPlan): Promise<StartResult>;
  /** 仅拆除本工具启动的组件，依据 running-project.json。 */
  stop(project: RunningProject): Promise<StopResult>;
}

export interface DiscoveryAdapter {
  /** scan 只依赖 workspace + scope，不依赖 StartResult 或 RunningProject。 */
  scan(workspace: Workspace, scope: Scope): Promise<StaticDiscoveryResult>;
  /**
   * 仅当 start status === success 时使用 RunningProject。
   * 传入非 success 的 StartResult 必须拒绝。
   */
  explore(
    project: DiscoveryProjectInput,
    context: RunContext,
    scope: Scope
  ): Promise<RuntimeDiscoveryResult>;
  /**
   * 仅当 start status === success 时使用 RunningProject。
   * 真实发送只由人类确认的 probe-plan.yaml 驱动。
   */
  execute(
    project: DiscoveryProjectInput,
    context: RunContext,
    action: Control
  ): Promise<ActionObservation>;
  /**
   * 一次 Probe 序列：共用一个 SessionProvider context，首次导航后沿用同一 page。
   * 不是第五套接口。孤立 execute() 仍可开独立浏览器做单步测试。
   */
  play(
    project: DiscoveryProjectInput,
    context: RunContext,
    actions: Control[]
  ): Promise<ActionObservation[]>;
}

export interface AgentRunner {
  readonly inherit_host_credentials: false;
  readonly load_project_agent_config: false;
  readonly workspace: "read_only";
  readonly network: "denied_or_explicit";
  run(task: AgentTask): Promise<AgentResult>;
}

/**
 * 导出是函数，不是第五套插件协议。
 * 签名留在 export 包；此处仅标记依赖倒置边界。
 */
export interface ExportFns {
  generateProductMap: unknown;
  generateDiagrams: unknown;
  generateWeb: unknown;
  generateTests: unknown;
}
