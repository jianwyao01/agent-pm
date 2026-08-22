# M6b：官方闭环（play + retarget + generateAll）

Will 于 2026-08-22 锁定。本里程碑把 **ProbePlan.actions**、**官方 play**、**官方 retarget** 与 **generateAll** 收成同一条闭环。

四套公共接口与六步不变：`SourceProvider` / `ProjectAdapter` / `DiscoveryAdapter` / `AgentRunner`；`detect` / `plan` / `start` / `scan` / `explore` / `execute`。

`play` **不是**第五套接口。孤立 `execute()` 仍留给单步测试。

**不**增加 Explorer、GUI Agent、Effect DAG，也 **不** 写入 Rocket.Chat 专用选择器 / 类型 / 路由。

> CI 夹具仍是登录墙 + 撰写 + 列表。这不是产品 RC 证明。  
> 产品 RC 运行是后续由可信操作者用官方 play + 官方 retarget + generateAll 完成的，禁止手改 `journeys.yaml`。

## ProbePlan.actions

`ProbePlan` 增加可选有序字段 `actions`。每一步包含 `binding_id`、`action`（`click` / `type` / `submit`），以及可选的 `value`。

- 保留现有 `send_action`。
- 若写了 `actions`，`send_action` **必须**等于最后发送步的 `binding_id`。发送步 = `action` 为 `submit` 的一步；若没有 submit，则取最后一步 `click`。
- 若省略 `actions`，按单步 `[{ binding_id: send_action, action: "click" }]` 解释。不回写磁盘。旧的、没有 `actions` 的 `probe-plan.yaml` 必须仍能加载。
- Probe plan **不得**包含 CSS 或语义目标；`actions` 只点名 `binding_id`。
- 加载时校验。

## play 是官方 ProbePlan runner

`DiscoveryAdapter.play(project, context, actions)` 已存在（内部 ProbeRunner，一个 SessionProvider context，同一 page）。

官方路径只做薄封装：加载 `ProbePlan.actions`（或省略时的单步默认），再调用 `play`。

禁止把 Probe 序列实现成 N 次孤立 `execute()`。

## HumanReviewSpec.retarget

增加可选字段 `retarget`：一组 `{ journey_id, control_id }`。

`applyHumanReview` **必须**执行它：

- `control_id` **必须**在该 run 的 `bindings.jsonl` 里有 `approved_by: human` 的绑定。否则显式失败，禁止猜测。
- 保持原来已接受的 `journey_id`。不得再造第二条发送旅程。
- 把 `journey.control_id` 设为重定位后的 `control_id`。
- 把该 study 人类批准的 `ProbePlan.actions`（或单步默认）拷到 `journey.steps`。不得把 Agent 提案拷进 `steps`。

`hydrateModel` 只从 bindings 挂 locator。它 **不得**发明 retarget。没有 spec 就没有自动重定位。`execute` / `play` **永不**把 `proposals/` 当 bindings 读。

## Journey.steps

Journey 可有可选 `steps`：每一步包含 `binding_id`、`action`，以及可选的 `value`。

在接受或 retarget 时从 `ProbePlan.actions` 拷入 `model/`。`model/` 是唯一语义源。

`generateTests`：

- 若有 `steps`：按顺序发出每一步的 `approved_locator`（`type` 用 fill/type，`click` / `submit` 用 click；`accessibility` / `role` 且形状为 `role=...;name=...` 时用 `getByRole`，与现有 `playwrightCall` 一致）。
- 若无 `steps`：沿用当前行为（单条 `journey.control_id` locator）。
- 发出的每一条 locator **必须**等于该 binding 的 `approved_locator`。
- 禁止默认 `#control-send`。
- `generateTests` **不得**读取 `probe-plan.yaml`。

## 语义校验

- `execute` / `play` 产物若带 `binding_id`，该 id 必须存在于该 run 的 `bindings.jsonl`。
- 已生成测试里，每一步发出的 locator 必须等于 `approved_locator`。

## 范围外（禁止在 M6b 实现）

- 第五套公共接口
- Explorer / GUI Agent / Effect DAG
- Rocket.Chat 专用类型（Room / Channel）、选择器或路由（`usernameOrEmail`、`/channel/`、写死 `aria-label=Send`）
- 第三套夹具应用
- 克隆 Rocket.Chat
- 在 CI 中声称完成产品 RC 绑定发送
