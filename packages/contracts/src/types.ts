/**
 * 行为地图 M0 核心类型。
 * 只使用 Surface / Control / Journey / Observation。
 * 不引入任何产品域实体。
 */

export const SCHEMA_VERSION = "0.1.0" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export type ExecutionStatus =
  | "observed"
  | "executed"
  | "not_executed"
  | "unreachable"
  | "unsupported"
  | "uncertain";

export type ScopeStatus = "in_scope" | "out_of_scope" | "unresolved";
export type ReviewStatus = "unreviewed" | "kept" | "rejected" | "merged";
export type CandidateKind = "entry" | "surface" | "control" | "interaction" | "effect";

export type ObservationKind =
  | "current_surface"
  | "other_surface"
  | "collection"
  | "indicator"
  | "notification"
  | "backend_operation";

export type Transport = "http" | "websocket" | "rpc" | "event" | "database" | "unknown";
export type StartStatus = "success" | "partial" | "failed-runtime";
export type AgentStatus = "success" | "partial" | "failed";
export type ComparisonMode = "same_snapshot" | "changed_snapshot";
export type JourneyLifecycle = "accepted" | "stale" | "not_observed";
export type NetworkPolicy = "denied_or_explicit";
export type WorkspaceMode = "read_only";

export interface Study {
  schema_version: SchemaVersion;
  id: string;
  name: string;
  goal: string;
  entry_seeds: string[];
  include_hints: string[];
  exclude_hints: string[];
  exploration_mode: "approved_probe";
}

export interface ProbePlan {
  schema_version: SchemaVersion;
  human_approved: true;
  entry: string;
  session_slot: string;
  target_surface: string;
  send_action: string;
  other_surfaces_to_refresh: string[];
}

/** Source 种类。GitHub/GitLab 只是 git 宿主，不是核心类型。 */
export type SourceKind = "git" | "local" | "archive";

/** 交给 SourceProvider.prepare 的输入。revision 为可选 ref 提示。 */
export interface SourceRequest {
  schema_version?: SchemaVersion;
  kind: SourceKind;
  locator: string;
  revision?: string;
}

/**
 * 写入 source.json 的记录。
 * 不含业务范围，不以绝对路径作为长期身份，也没有 host-specific 类型。
 */
export interface SourceRecord {
  schema_version: SchemaVersion;
  kind: SourceKind;
  locator: string;
  revision: string;
  snapshot: string;
  dirty?: boolean;
  content_digest?: string;
}

/** @deprecated 使用 SourceRecord（落盘）或 SourceRequest（prepare 输入） */
export type SourceDescriptor = SourceRecord;

/**
 * 下游（boot / discovery）只消费此快照，不得依赖 source.kind。
 * id：git / 含提交的 local 为 commit；非 git local 为 content_digest。
 */
export interface SourceSnapshot {
  id: string;
  revision: string;
  dirty?: boolean;
  content_digest?: string;
}

export type SourcePrepareReady = {
  status: "ready";
  workspace: Workspace;
  snapshot: SourceSnapshot;
};

export type SourcePrepareNotShipped = {
  status: "not_shipped";
  kind: "archive";
  message: string;
};

export type SourcePrepareResult = SourcePrepareReady | SourcePrepareNotShipped;

export interface ProfileFace {
  id: string;
  name: string;
  clues?: string[];
}

export interface ProfilePart {
  id: string;
  role: string;
  clues?: string[];
}

export interface HowToRunClue {
  source: string;
  hint: string;
}

/**
 * 工作区画像。主键是 faces / parts / frameworks / how_to_run 线索，
 * 不是单一项目类型枚举。
 */
export interface ProjectProfile {
  schema_version: SchemaVersion;
  faces: ProfileFace[];
  parts: ProfilePart[];
  frameworks: string[];
  how_to_run: HowToRunClue[];
  notes?: string;
}

export interface SecretRef {
  secret_ref: string;
}

export type PlanConfirmationStatus = "draft" | "confirmed";

export interface PlanConfirmation {
  status: PlanConfirmationStatus;
  confirmed_at?: string;
}

export interface ComponentInstall {
  command: string;
  notes?: string;
}

export interface ComponentHealthcheck {
  kind: "http" | "tcp" | "command";
  url?: string;
  port?: number;
  command?: string;
}

export interface ComponentSeed {
  /** 工作区没有种子时必须显式 not_done，禁止编造种子。 */
  status: "not_done" | "present";
  path?: string;
  notes?: string;
}

export interface ComponentStartSpec {
  command: string;
  notes?: string;
  env?: Record<string, string>;
}

export interface RunPlanComponent {
  id: string;
  role: string;
  depends_on: string[];
  install: ComponentInstall;
  /** 进程启动命令。compose up 已在 install 拉起服务时可省略。 */
  start?: ComponentStartSpec;
  start_order: number;
  healthcheck: ComponentHealthcheck;
  logs: string;
  seed: ComponentSeed;
}

export interface RunPlan {
  schema_version: SchemaVersion;
  run_id?: string;
  study_id?: string;
  scope_id?: string;
  secret_refs: SecretRef[];
  steps?: string[];
  components: RunPlanComponent[];
  confirmation: PlanConfirmation;
}

export interface RunContext {
  schema_version: SchemaVersion;
  role: string;
  locale: string;
  flags: string[];
  credential_ref: string;
  cookie_ref: string;
  entry_url: string;
}

export interface StatusFile {
  schema_version: SchemaVersion;
  phase: string;
  start_status: StartStatus;
  completed: boolean;
  study_id: string;
  scope_id: string;
}

export type ComponentStartStatus = "started" | "failed" | "refused" | "skipped";
export type ComponentHealthStatus = "passed" | "failed" | "not_run";

export interface ComponentStartResult {
  id: string;
  role: string;
  status: ComponentStartStatus;
  healthcheck: ComponentHealthStatus;
  logs: string;
  url?: string;
  pid?: number;
  started_at?: string;
  reason?: string;
}

export interface Gap {
  reason: string;
  message: string;
  component_id?: string;
}

/** 仅 StartResult.status === "success" 时才存在、且可用于 explore。 */
export interface RunningComponentState {
  id: string;
  role: string;
  status: "started";
  url?: string;
  pid?: number;
  logs: string;
  started_by: "project-adapter";
}

export interface RunningProject {
  schema_version: SchemaVersion;
  usable_for_explore: true;
  base_url: string;
  pid_ref?: string;
  run_id?: string;
  urls?: Record<string, string>;
  components?: RunningComponentState[];
}

export type StartResult =
  | {
      status: "success";
      project: RunningProject;
      components: ComponentStartResult[];
      gaps: Gap[];
    }
  | {
      status: "partial";
      components: ComponentStartResult[];
      gaps: Gap[];
    }
  | {
      status: "failed-runtime";
      components: ComponentStartResult[];
      gaps: Gap[];
    };

export type StopResult =
  | { status: "stopped" }
  | { status: "not_shipped"; message: string };

export interface EvidenceRecord {
  schema_version: SchemaVersion;
  id: string;
  immutable: true;
  source: "static" | "runtime";
  kind: string;
  payload: Record<string, unknown>;
}

export interface Candidate {
  schema_version: SchemaVersion;
  id: string;
  kind: CandidateKind;
  scope_id: string;
  discovered_by: string;
  evidence_refs: string[];
  execution_status: ExecutionStatus;
  scope_status: ScopeStatus;
  review_status: ReviewStatus;
  rejection_reason: string | null;
  discovery_key: string;
  label: string;
}

export interface ProposedJourney {
  name: string;
  candidate_ids: string[];
  effect_candidate_ids: string[];
}

export interface ProposedEffect {
  name: string;
  candidate_id: string;
  observation_kind: ObservationKind;
  subtype?: string;
  transport?: Transport;
  observed: boolean;
}

export interface Proposal {
  schema_version: SchemaVersion;
  id: string;
  task_id: string;
  run_id: string;
  inputs: string[];
  proposed_journeys: ProposedJourney[];
  proposed_effects: ProposedEffect[];
}

export interface DiffFile {
  schema_version: SchemaVersion;
  baseline_run_id: string;
  current_run_id: string;
  comparison_mode: ComparisonMode;
  study_id: string;
  scope_id: string;
}

export interface Surface {
  id: string;
  name: string;
  role?: "current" | "other" | "list";
}

export interface Locator {
  kind: string;
  value: string;
  reliable: boolean;
}

export interface Control {
  id: string;
  surface_id: string;
  name: string;
  action: string;
  locator?: Locator;
}

export interface Observation {
  kind: ObservationKind;
  subtype?: string;
  transport?: Transport;
  observed: boolean;
  display_value: string;
  evidence_refs: string[];
  surface_id?: string;
}

export interface Effect {
  id: string;
  name: string;
  observation: Observation;
}

export interface Journey {
  id: string;
  name: string;
  status: JourneyLifecycle;
  effect_ids: string[];
  control_id?: string;
}

export interface Capability {
  id: string;
  name: string;
  control_ids: string[];
}

export interface ReviewDecision {
  candidate_id: string;
  review_status: Exclude<ReviewStatus, "unreviewed">;
  journey_id?: string;
  rename?: string;
  rejection_reason?: string;
}

export interface CapabilitiesFile {
  schema_version: SchemaVersion;
  capabilities: Capability[];
}

export interface JourneysFile {
  schema_version: SchemaVersion;
  journeys: Journey[];
}

export interface EffectsFile {
  schema_version: SchemaVersion;
  effects: Effect[];
}

export interface ReviewDecisionsFile {
  schema_version: SchemaVersion;
  decisions: ReviewDecision[];
}

export interface ReviewedModel {
  schema_version: SchemaVersion;
  capabilities: Capability[];
  journeys: Journey[];
  effects: Effect[];
  decisions: ReviewDecision[];
  surfaces: Surface[];
  controls: Control[];
}

export interface Workspace {
  path: string;
  read_only: boolean;
}

/** 兼容别名：下游请使用 SourceSnapshot。 */
export type Snapshot = SourceSnapshot;

export interface Scope {
  id: string;
  include_hints: string[];
  exclude_hints: string[];
}

export interface AgentPolicy {
  inherit_host_credentials: false;
  load_project_agent_config: false;
  workspace: WorkspaceMode;
  network: NetworkPolicy;
}

export interface AgentTask {
  schema_version: SchemaVersion;
  task_id: string;
  run_id: string;
  analysis_root: string;
  approved_read_paths: string[];
  policy: AgentPolicy;
}

export interface AgentResult {
  status: AgentStatus;
  proposal_id?: string;
  write_paths: string[];
  errors?: string[];
}

export interface ExportManifest {
  schema_version: SchemaVersion;
  kind: "product-map" | "diagrams" | "web" | "tests";
  journey_ids: string[];
}

export interface ProductMap {
  schema_version: SchemaVersion;
  journey_ids: string[];
  surfaces: Surface[];
  controls: Control[];
  journeys: Journey[];
  effects: Effect[];
  display: DisplayProjection;
}

export interface DisplayCell {
  column: string;
  observation_kind: ObservationKind;
  value: string;
  observed: boolean;
}

export interface DisplayProjection {
  columns: string[];
  rows: Array<{ journey_id: string; cells: DisplayCell[] }>;
}

export const UNOBSERVED = "未观察到";

export const DISPLAY_COLUMNS = [
  { observation_kind: "current_surface" as const, label: "本面" },
  { observation_kind: "other_surface" as const, label: "他面" },
  { observation_kind: "collection" as const, label: "列表", subtype: "list" },
  { observation_kind: "indicator" as const, label: "未读", subtype: "unread" },
  { observation_kind: "notification" as const, label: "通知" },
  { observation_kind: "backend_operation" as const, label: "后台" }
] as const;

export const AGENT_WRITE_PATHS = [
  "runs/<run-id>/proposals/<task-id>.json",
  "runs/<run-id>/agent-scratch/"
] as const;

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  inherit_host_credentials: false,
  load_project_agent_config: false,
  workspace: "read_only",
  network: "denied_or_explicit"
};
