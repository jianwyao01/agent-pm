# M4b：Control / Binding / SessionProvider

Will 于 2026-08-22 锁定。本里程碑只补 **页面事实控件、人类绑定、会话注入**，让 `execute` 变成 dumb replayer。

四套公共接口与六步不变：`SourceProvider` / `ProjectAdapter` / `DiscoveryAdapter` / `AgentRunner`；`detect` / `plan` / `start` / `scan` / `explore` / `execute`。

**不**增加第五套接口、Explorer 层、GUI Agent、Effect DAG，也 **不** 写入 Rocket.Chat 专用选择器 / 类型 / 路由。

> CI 夹具是登录墙 + 撰写 + 列表更新。这不是产品 RC 证明。  
> 产品 RC 绑定发送是后续在操作者 Linux 机器上、注入会话之后的可信运行。

## 对象

### controls.jsonl（每个 run）

字段：`control_id`、`surface_id`、`kind`（`button` | `input` | `menu` | `other`）、`observed`（所见 `role` / `name` / `placeholder` / `value`）、`locator_candidates`（`[{type,value}]`）、`evidence_refs`。

- 只记事实。`send_message` / `login` 等语义猜测 **不得** 出现在 execute 使用的 control 上，也 **不得** 出现在 binding 上。若要记录，只允许写在 `candidates.jsonl` 或 agent proposals。
- 同一 snapshot + 同一 surface + 同一 observed `role`+`name` → 稳定 `control_id`。
- 观察时 locator 候选顺序：`accessibility` > `role` > `label` > `text`。CSS / XPath 可以是额外候选。
- Phase-1 `approved_locator` 必须是 `accessibility` 或 `role+name`。Executor **从不** 在候选中自行挑选。

### bindings.jsonl

字段：`binding_id`、`control_id`、`approved_locator {type,value}`、`approved_by: "human"`、`created_at`。

- Probe 动作只引用 `binding_id`。
- Agent 以后若提案 binding，只能写在 `runs/<id>/proposals/`。
- `execute` **永不** 把 proposals 当 bindings 读。

### SessionProvider（模块，不是公共接口）

`createContext(credential_ref | cookie_ref)` → Playwright `storageState` / cookies context。

- Phase 1：只支持 storageState / cookies。
- storageState 文件必须在 `analysis/` **之外**；`run-context.yaml` 只持有 ref。
- `execute` 永不打开登录页、永不填密码、永不猜测登录表单。

## execute = dumb replayer

`DiscoveryAdapter.execute(project, context, action)` 签名不变。`action.binding_id` **必填**。

1. 只加载这一条 binding。
2. 使用 `approved_locator`。
3. 执行声明的 `click` | `type` | `submit`。
4. 写 Observation。

导航完成后、执行 `click` | `type` | `submit` 之前，replay **只**等待这一条 `approved_locator` 变为可见（有限超时）。超时即 `locator_not_found` / not visible 并停止，这是失败而不是继续搜索：不改用其他 locator、不点最后一个按钮、不试 submit、不打开登录页。

若 binding 缺失、locator 找不到、或控件不可见：`status` 为 `failed`（该联合类型已锁定，不用新增值），`reason` 为 `binding_missing` | `locator_not_found`。**停止**。

禁止：回退选择器、语义猜测、AI 重试、点最后一个按钮、试 submit、夹具默认 `#control-send`。

## explore

注入会话后，打开 probe entry seeds / 目标 surface URL，把 a11y 与可见控件写入 `controls.jsonl` 和 `evidence/runtime.jsonl`。

- 不执行产品动作。
- 不推断 `send_message`。
- `scan()` 不变（源码候选，不是页面事实）。

## 语义校验

- execute 产物若带 `binding_id`，该 id 必须存在于 `bindings.jsonl`。
- 已生成 Playwright 草稿的 locator 必须等于 `approved_locator`，不得回退 `#control-send`。

## 范围外（禁止在 M4b 实现）

- 第五套公共接口
- Explorer 层 / GUI Agent / Effect DAG
- Rocket.Chat 专用类型（Room / Channel）、选择器或路由（`usernameOrEmail`、`/channel/`、写死 `aria-label=Send`）
- 在 CI 中声称完成产品 RC 绑定发送
