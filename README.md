# 行为地图（behavior-map）

通用产品行为分析器。核心对象是 **Surface / Control / Journey / Observation**，不绑定任何聊天或代码托管产品。

> **当前：M0 合约 + Mock，M1 Source 快照（git / local），M2 detect + plan + scope，M3 多组件 start/stop，M4 Discovery scan/explore/execute + 一次 Probe 发送，M4b Control / Binding / SessionProvider（execute 只重放人类 locator），M5 真实 AgentRunner（事后 classify / prune），M6 人工审定模型 + 四份导出，以及 M6b 官方闭环（ProbePlan.actions + 官方 play + 官方 retarget + generateAll）。**  
> 这不是 Rocket.Chat 级验收。产品级 RC 证明（真实发送上的 MAP）是后续在操作者 Linux 机器上、用户将该仓库标为 trusted 并提供会话之后的可信运行，**不是 CI**。  
> CI 使用微型本地进程与双 Surface 夹具，不需要 LLM API key，也不需要外网。不宣传对未信任目标的安全执行。不声称目标应用 CI 变绿。

## 已交付

### M0
- JSON Schema 与语义校验
- `AgentRunner` 接口 + `MockAgentRunner`
- 导出函数与消息域形状的假数据走查

### M1
- `SourceProvider.prepare`：`git`（记录解析 commit）与 `local`（git checkout → commit+dirty；非 git → `content_digest`）
- `archive` 接口保留，实现未交付（`not_shipped`，不是「不支持的 kind」）
- 下游只消费 `Workspace` + `SourceSnapshot`

### M2
- `ProjectAdapter.detect` / `createRunPlan`：通用线索（package.json、compose、meteor、mongo/redis、README）
- `ProjectProfile`：faces / parts / frameworks / how_to_run
- 人类可编辑 `run-plan.yaml`（多组件、各有 healthcheck、`secret_ref`、draft/confirmed）
- 首发 `study.yaml` + `probe-plan.yaml` + `run-context.yaml`（消息发送与状态同步）

### M3
- `ProjectAdapter.start` / `stop`：多组件 install → 按 `depends_on` / `start_order` 启动 → 每组件 healthcheck
- 只接受 confirmed 的 `run-plan.yaml`；未信任目标拒绝安装/执行
- success 才写入 `running-project.json`；`stop` 只拆除本工具启动的进程
- CI 用两个微型 HTTP 进程，不克隆真实产品仓库

### M4
- `DiscoveryAdapter.scan(workspace, scope)`：静态发现，不依赖 start；全部候选写入 `candidates.jsonl`
- `explore` / `execute`：仅 success 的 `RunningProject` 可用；Web phase-1 驱动 click / type / submit
- 一次发送只由人类确认的 `probe-plan.yaml` 驱动；观察为通用类型，六列是投影
- CI 用双 Surface 夹具（列表 + 撰写），不克隆真实产品仓库

### M4b
- `controls.jsonl`：页面事实（role / name / placeholder / value）与 locator 候选；禁止把 `send_message` / `login` 写在 execute 用的 control 或 binding 上
- `bindings.jsonl`：人类批准的 `approved_locator`（phase-1 仅 accessibility 或 role+name）；execute 只读此文件，不读 proposals
- SessionProvider（内部模块）：`credential_ref` / `cookie_ref` → storageState；文件在 analysis/ 之外
- `execute` 是 dumb replayer：必填 `binding_id`，找不到 binding / locator 即 `failed` + `binding_missing` | `locator_not_found`，禁止回退选择器
- CI 夹具增加登录墙；storageState 绕过登录。这不是产品 RC 证明

### M5
- `DefaultAgentRunner.run(task) -> AgentResult`：对已批准的 M4 产物做确定性事后分析
- 任务 kind 仅 `classify_features` / `build_journeys` / `analyze_effects` / `prune_candidates`
- 只写 `proposals/<task-id>.json` 与 `agent-scratch/`；不改 `model/`；不驱动 Discovery
- LLM 可选，默认关闭；CI 不需要 API key 或外网
- 提案中的 run-plan **不会**被 `start()` 读取，只认人类确认的 `run-plan.yaml`

### M6
- 人类审定写入唯一规范模型 `analysis/model/`（capabilities / journeys / effects / review-decisions）
- 可 keep / reject / rename，并可补录一条其认为有效的旅程；`journey_id` 接受时分配，重命名不改 id
- 新 run 写新的 `runs/<run-id>/` 与 `diff.json`；默认基线为同一 study+scope 的上一完成 run；其它基线只能显式 `--baseline`
- 未再观察到的项标 `stale` / `not_observed`，不静默删除
- 四个导出函数消费同一已审定旅程列表：产品地图（中文工具说明）、Mermaid、只读离线 Web、Playwright 草稿

### M6b
- `ProbePlan.actions` 可选有序步骤；省略时按单步 `send_action` + `click` 解释；旧文件仍能加载
- `play` 是官方 ProbePlan runner（不是第五套接口）；孤立 `execute()` 只做单步测试
- `HumanReviewSpec.retarget` 必须显式给出；只接受该 run 人类绑定；保持同一 `journey_id`，并把 ProbePlan.actions 拷到 `journey.steps`
- `generateTests` 按 `steps` 发出 `approved_locator` 序列，不读 `probe-plan.yaml`，禁止默认 `#control-send`
- CI 仍用登录墙 + 撰写 + 列表夹具。这不是产品 RC 证明

## 尚未交付

- Effect DAG / Reconciler / 能力注册表 / Worker / Broker
- 在 CI 中克隆任何真实产品仓库
- 产品级 Rocket.Chat 发送上的 MAP（操作者机器上的后续可信运行）

详见 [docs/M0.md](docs/M0.md)、[docs/M1.md](docs/M1.md)、[docs/M2.md](docs/M2.md)、[docs/M3.md](docs/M3.md)、[docs/M4.md](docs/M4.md)、[docs/M4b.md](docs/M4b.md)、[docs/M5.md](docs/M5.md)、[docs/M6.md](docs/M6.md) 与 [docs/M6b.md](docs/M6b.md)。

## 目录

```
packages/contracts/   # 类型、JSON Schema、语义校验
packages/source/      # SourceProvider：git + local（archive 未交付）
packages/project/     # ProjectAdapter：detect + plan + start/stop
packages/discovery/   # DiscoveryAdapter：scan / explore / execute
packages/agent/       # AgentRunner：Mock（合约测试）+ DefaultAgentRunner（M5 真实分析）
packages/export/      # generateProductMap / Diagrams / Web / Tests
packages/review/      # 人工审定 model/ + writeRunDiff
fixtures/m0-fake-study/
fixtures/m2-message-sync/
fixtures/m4-two-surface/
docs/M0.md
docs/M1.md
docs/M2.md
docs/M3.md
docs/M4.md
docs/M4b.md
docs/M5.md
docs/M6.md
docs/M6b.md
tests/
```

## 使用

```bash
npm install
npm test
```

`npm test` 覆盖：结构 schema、语义校验、MockAgentRunner 合约、假数据走查、M1 SourceProvider（临时微型 git 夹具）、M2 detect/plan/scope、M3 多组件 start/stop（微型本地进程）、M4 Discovery + 一次 probe 发送（双 Surface 夹具）、M4b Control/Binding/SessionProvider（登录墙夹具 + 人类 locator 重放）、M5 真实 AgentRunner 对 M4 产物的确定性分析、M6 人工审定 + 四份导出，以及 M6b 官方 play / retarget / generateAll 闭环。不克隆真实产品，不要求 LLM API key。

生成的 Playwright spec **可被发现、含 Journey ID**；不可靠 locator 使用 `test.skip` / TODO。**不运行这些测试，也不声称它们已对目标应用通过**。

## 许可

MIT。见 [LICENSE](LICENSE)。
