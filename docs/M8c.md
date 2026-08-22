# M8c：retarget 重映射残留能力名，导出标题跟随旅程

Will 于 2026-08-22 锁定。本里程碑修正 M8b 之后两处仍焊死「发送」的行为：对已有创建旅程做 `applyHumanReview({ retarget })` 时，必须重写挂在该 `control_id` 上的残留 `cap-send` / `发送`；`generateAll` 产品地图 markdown 的标题必须跟随旅程或能力名。

四套公共接口与六步不变：`SourceProvider` / `ProjectAdapter` / `DiscoveryAdapter` / `AgentRunner`；`detect` / `plan` / `start` / `scan` / `explore` / `execute`。

**不**增加 Explorer、GUI Agent、Effect DAG，也 **不** 写入 Channel / Room / Rocket.Chat 类型或选择器。  
**不**改写四接口。  
**不**增加第五套接口。  
**不**开始观察六列效果。  
**不**手改操作者 study。

## 能力重映射

`retarget` 必须处理 `control_ids` 含本次重定位 `control_id` 的能力：

- `name` 跟随旅程，推导与 `addJourney` 相同（`ensureJourneyCapability` 或其等价）
- 若该能力是非发送旅程上焊死的 `cap-send` 残留，`id` 也跟随旅程
- 名为 `发送` 的发送 study 旅程仍可以是 `cap-send` / `发送`
- 创建条目 / 创建频道旅程在 `retarget` 后不得仍名为 `发送`
- 不得删除无关能力

## 导出标题

`generateAll` / 产品地图 markdown **不得**焊死 `## 发送控件` 与 `已接受的发送旅程`。

标题跟随旅程或能力名：

- 发送旅程仍可以说 `发送`（`## 发送控件`、`## 已接受的发送旅程`）
- 创建条目旅程必须写成该旅程或能力名（例如 `## 创建条目控件`、`## 已接受的创建条目旅程`），不得再出现上述两句焊死标题

本里程碑不开始观察六列效果。跨面效果投影保持原样。

## 契约测试

保持 M0–M8b 变绿。`npm test` = vitest + tsc。

- 创建条目夹具先挂 leftover `cap-send` / `发送` 再 `retarget`
- 能力名不是 `发送`，旅程 `accepted`
- 生成地图标题跟随能力名，创建条目不得焊死 `发送`

## 范围外（禁止在 M8c 实现）

- 第五套公共接口
- Explorer / GUI Agent / Effect DAG
- 开始观察六列效果
- Rocket.Chat 专用类型（Room / Channel）、选择器或路由
- 第三套夹具应用
- 克隆 Rocket.Chat
- 在本仓库实现或手改 RC 操作者 study
- 在 CI 中声称完成产品 RC 创建
