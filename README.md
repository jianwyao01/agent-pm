# 行为地图（behavior-map）

通用产品行为分析器。核心对象是 **Surface / Control / Journey / Observation**，不绑定任何聊天或代码托管产品。

> **当前：M0 合约 + Mock，M1 Source 快照（git / local），M2 detect + plan + scope，M3 多组件 start/stop，以及 M4 Discovery scan/explore/execute + 一次 Probe 发送。**  
> 这不是 Rocket.Chat 级验收。产品级证明是后续在操作者机器上、用户将该仓库标为 trusted 并提供会话之后的可信运行，**不是 CI**。  
> CI 使用微型本地进程与双 Surface 夹具。不宣传对未信任目标的安全执行。

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

## 尚未交付

- 真实 LLM Agent（M5）
- 人工审定模型 + 四份导出（M6）
- Effect DAG / Reconciler / 能力注册表 / Worker / Broker
- 在 CI 中克隆任何真实产品仓库

详见 [docs/M0.md](docs/M0.md)、[docs/M1.md](docs/M1.md)、[docs/M2.md](docs/M2.md)、[docs/M3.md](docs/M3.md) 与 [docs/M4.md](docs/M4.md)。

## 目录

```
packages/contracts/   # 类型、JSON Schema、语义校验
packages/source/      # SourceProvider：git + local（archive 未交付）
packages/project/     # ProjectAdapter：detect + plan + start/stop
packages/discovery/   # DiscoveryAdapter：scan / explore / execute
packages/agent/       # AgentRunner 接口实现：Mock only
packages/export/      # generateProductMap / Diagrams / Web / Tests
fixtures/m0-fake-study/
fixtures/m2-message-sync/
fixtures/m4-two-surface/
docs/M0.md
docs/M1.md
docs/M2.md
docs/M3.md
docs/M4.md
tests/
```

## 使用

```bash
npm install
npm test
```

`npm test` 覆盖：结构 schema、语义校验、MockAgentRunner 合约、假数据走查、M1 SourceProvider（临时微型 git 夹具）、M2 detect/plan/scope、M3 多组件 start/stop（微型本地进程），以及 M4 Discovery + 一次 probe 发送（双 Surface 夹具，不克隆真实产品）。

生成的 Playwright spec **可被发现、含 Journey ID**；不可靠 locator 使用 `test.skip` / TODO。M0 **不运行这些测试，也不声称它们已通过**。

## 许可

MIT。见 [LICENSE](LICENSE)。
