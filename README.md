# 行为地图（behavior-map）

通用产品行为分析器。核心对象是 **Surface / Control / Journey / Observation**，不绑定任何聊天或代码托管产品。

> **当前：M0 合约 + Mock，M1 Source 快照（git / local），M2 detect + plan + scope，M3 多组件 start/stop，M4 Discovery scan/explore/execute + 一次 Probe 发送，M4b Control / Binding / SessionProvider（execute 只重放人类 locator），M5 真实 AgentRunner（事后 classify / prune），M6 人工审定模型 + 四份导出，M6b 官方闭环（ProbePlan.actions + 官方 play + 官方 retarget + generateAll），M7 官方 study runner（runClosedLoop + 夹具树入口），M8 创建面深化域（Journey.entry_url + 可指定 journey_id 的 addJourney + 夹具创建入口），M8b 审定观察与能力不再焊发送，M8c retarget 重映射残留能力名且导出标题跟随旅程，M9 人类确认列表效果，M14 collection 刮取不得拖死已成功的 play 点击，M16 官方 dump 把 title 与 aria-label 记为 locator 候选，以及 M17 产品地图八列（可观察步骤/轨迹由 generateAll 投影，MAP-2/7/8 仅人类 annotate；控件落成候选；空 static.jsonl 不跳过 scan）。**  
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

### M7
- `runClosedLoop` 是 review 包函数，不是第五套接口：scan（已有 static+candidates 则跳过）→ playFromProbePlan → applyHumanReview → generateAll
- 不得调用 `ProjectAdapter.start`，不得用 `explore()` 做产品动作，不得发明 bindings，不得把 Probe 拆成孤立 `execute()`
- 夹具增加一条导航树入口（打开撰写面）。人类绑定：nav/entry、composer、submit
- `ProbePlan.actions` 为 click 树入口 + type + submit/click；`send_action` 等于最后发送步；`entry` 不变
- CI 仍用同一套登录墙 + 撰写 + 列表夹具。这不是产品 RC 证明。create-channel 是后续深化域

### M8
- Journey 可有可选 `entry_url`；`applyHumanReview` 的 addJourney / retarget 从该 study 的 `run-context.yaml` 拷入；`hydrateModel` 不发明
- `addJourney` 首次接受可指定稳定 `journey_id`（锁定形状为数组；兼容单个对象）；已存在则失败；`control_id` 必须有人类绑定
- `generateTests`：有 steps 且有 `entry_url` 时第一行 `page.goto(entry_url)`，否则 `about:blank`；导出时不读 `probe-plan.yaml` / `run-context.yaml`
- 夹具增加创建入口（名称栏 + 提交，导航/列表出现新项）。CI 用新的 study 形分析 + 新的 `journey_id`（不是 `jny-send`）。这不是产品 RC 证明

### M8b
- 同一 `applyHumanReview` 里 `addJourney` / `retarget` 的旅程保持 `accepted`
- 观察：候选 control_id、step `binding_id`、或该 run 的 human 绑定任一成立即可；不要求候选等于人类 `ctl-*-obs`
- 旧的已接受旅程若本 run 既无绑定也无候选，仍标 `stale` / `not_observed`
- 能力从旅程派生；发送夹具仍可得到 `cap-send`，创建条目夹具不得以 `发送` 为能力名

### M8c
- `retarget` 重映射挂在该 `control_id` 上的残留 `cap-send` / `发送`；推导与 `addJourney` 相同（`ensureJourneyCapability`）
- 发送旅程仍可以是 `cap-send` / `发送`；创建条目旅程不得在 retarget 后仍名为 `发送`；不删除无关能力
- `generateAll` 产品地图标题跟随旅程或能力名，不得焊死 `## 发送控件` 与 `已接受的发送旅程`
- 不开始观察六列效果，不手改操作者 study

### M9
- `HumanReviewSpec.confirmEffects` 只确认已有六列槽位与本 run 已有 evidence；人类确认，禁止猜测
- `applyHumanReview` 翻转该槽位 `observed`；可选 `display_value` 由人类点名，否则只从 payload `name` / `label` / `item` / `title` / `delta` / `list_after` 推导，不用 `payload.text`
- `hydrateModel` 不发明 observation；`generateAll` 在该列写 `观察到`
- `play` 用 role+name / listitem / link name 记页上可见项，不再刮夹具 CSS
- 首次证明用已有 evidence，本里程碑不做现场 RC play

### M14
- 成功的 click/type 之后，`readCollection` 超时或碰到脱离节点不得把 play 打成 `execute_failed`
- collection 仍用 role+name / listitem / link name；每条短超时、跳过脱离节点、限制数量
- 刮取错误记观察缺口；已完成的人类动作保持 `success`

### M16
- `dumpVisibleControls` 在节点存在 `title` 或 `aria-label` 时写入对应 locator 候选；`observed.name` 仍是无障碍名，即使它是字形
- 人类 Binding 可批准一条 `title` 或 `label`（aria-label）候选；`execute` / `play` 只等这一条，不回退，不把 name 改写成 title
- 夹具仅图标按钮带 `title=Open item`，play 点击为 success

### M17
- `HumanReviewSpec.annotate` 只把 `affected_parties` / `combinations` / `keep_reason` 写到已有旅程；未知 `journey_id` 或单独的「用户」硬失败；`hydrateModel` 不发明这些字段
- `generateAll` 投影 MAP-4 步骤与 MAP-5 轨迹；MAP-2/7/8 只回放人类标注；永不导出单独的「用户」；不对其它旅程做笛卡尔积
- 概览数字只来自该 run 文件：入口清单、候选行数、保留/删除条数、未审定与六列未观察 Gap、无合法 static 则「静态扫描未落盘」
- explore 落盘的 Control 同时是 `control:<id>` 候选；加载 run 时补齐缺失候选；拒绝 control 候选不创建旅程
- 仅当 `static.jsonl` 已有 ≥1 条合法记录才跳过 scan
- mermaid 节点为旅程或能力名，不焊死 `SendControl`；控件节列出 steps/bindings 引用的 Control，不再用 `/send|发送|submit/` 丢掉树入口

## 尚未交付

- Effect DAG / Reconciler / 能力注册表 / Worker / Broker
- 在 CI 中克隆任何真实产品仓库
- 产品级 Rocket.Chat 发送上的 MAP（操作者机器上的后续可信运行）

详见 [docs/M0.md](docs/M0.md)、[docs/M1.md](docs/M1.md)、[docs/M2.md](docs/M2.md)、[docs/M3.md](docs/M3.md)、[docs/M4.md](docs/M4.md)、[docs/M4b.md](docs/M4b.md)、[docs/M5.md](docs/M5.md)、[docs/M6.md](docs/M6.md)、[docs/M6b.md](docs/M6b.md)、[docs/M7.md](docs/M7.md)、[docs/M8.md](docs/M8.md)、[docs/M8b.md](docs/M8b.md)、[docs/M8c.md](docs/M8c.md)、[docs/M9.md](docs/M9.md)、[docs/M14.md](docs/M14.md)、[docs/M16.md](docs/M16.md) 与 [docs/M17.md](docs/M17.md)。

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
docs/M7.md
docs/M8.md
docs/M8b.md
docs/M8c.md
docs/M9.md
docs/M14.md
docs/M16.md
docs/M17.md
tests/
```

## 使用

```bash
npm install
npm test
```

`npm test` 覆盖：结构 schema、语义校验、MockAgentRunner 合约、假数据走查、M1 SourceProvider（临时微型 git 夹具）、M2 detect/plan/scope、M3 多组件 start/stop（微型本地进程）、M4 Discovery + 一次 probe 发送（双 Surface 夹具）、M4b Control/Binding/SessionProvider（登录墙夹具 + 人类 locator 重放）、M5 真实 AgentRunner 对 M4 产物的确定性分析、M6 人工审定 + 四份导出、M6b 官方 play / retarget / generateAll 闭环、M7 `runClosedLoop`（树入口 click + type + submit）、M8 创建入口（打开创建 + 填名称 + 提交，`goto entry_url`）、M8b 审定观察与能力派生、M8c retarget 重映射残留能力与导出标题、M9 人类确认列表效果、M14 collection 刮取不得拖死已成功的 play 点击、M16 title/aria-label 候选，以及 M17 产品地图八列与控件候选提升。不克隆真实产品，不要求 LLM API key。

生成的 Playwright spec **可被发现、含 Journey ID**；不可靠 locator 使用 `test.skip` / TODO。**不运行这些测试，也不声称它们已对目标应用通过**。

## 许可

MIT。见 [LICENSE](LICENSE)。
