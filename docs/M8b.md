# M8b：审定观察与能力不再焊发送

Will 于 2026-08-22 锁定。本里程碑修正 M8 审定：同一 `applyHumanReview` 里由 `addJourney` 新建或由 `retarget` 更新的旅程保持 `accepted`；能力从旅程派生，不再每次写成 `cap-send` / `发送`。

四套公共接口与六步不变：`SourceProvider` / `ProjectAdapter` / `DiscoveryAdapter` / `AgentRunner`；`detect` / `plan` / `start` / `scan` / `explore` / `execute`。

**不**增加 Explorer、GUI Agent、Effect DAG，也 **不** 写入 Channel / Room / Rocket.Chat 类型或选择器。  
**不**改写四接口。  
**不**增加第五套接口。

## 观察

`collectObservedJourneyIds` 与 `markMissingSupport` 在下列任一成立时把旅程视为本 run 已观察到：

- scan 或 play 候选的 control_id（由 `discovery_key` 末段或候选 `id` 得出）等于 `journey.control_id`
- play 候选的 `discovery_key` 或 `id` 等于 `journey.steps[].binding_id`
- 该 run 的 `bindings.jsonl` 里存在 `approved_by: human` 的绑定，其 `control_id` 等于 `journey.control_id`，或其 `binding_id` 等于任一 `steps[].binding_id`

不得要求候选 control_id 必须等于人类分配的 `ctl-*-obs`。

同一 `applyHumanReview` 调用里，`addJourney` 新建或 `retarget` 更新的旅程必须保持 `status: accepted`。

旧的已接受旅程若本 run 既无绑定也无候选，仍标 `stale` 或 `not_observed`，禁止静默删除。

## 能力

`ensureSendCapability`（或其替代）不得在每次 `addJourney` 时写死 `id: cap-send`、`name: 发送`。

能力 id 与 name 从旅程派生（由旅程名或稳定 `journey_id` 生成）。发送 study 夹具仍可得到 `cap-send`。创建条目夹具不得以 `发送` 作为能力名。

`packages/` 不得假定聊天发送。

## 契约测试

保持 M0–M8 变绿。`npm test` = vitest + tsc。

- `runClosedLoop` + `addJourney` 后 `journey.status === accepted`
- 创建条目能力名不是 `发送`
- 生成 spec 仍含 `goto` 与创建 locator

## 范围外（禁止在 M8b 实现）

- 第五套公共接口
- Explorer / GUI Agent / Effect DAG
- Rocket.Chat 专用类型（Room / Channel）、选择器或路由
- 第三套夹具应用
- 克隆 Rocket.Chat
- 在本仓库实现 RC 操作者 study
- 在 CI 中声称完成产品 RC 创建
