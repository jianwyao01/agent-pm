# 行为地图（behavior-map）

通用产品行为分析器。核心对象是 **Surface / Control / Journey / Observation**，不绑定任何聊天或代码托管产品。

> **当前：M0 合约 + Mock，M1 Source 快照（git / local），以及 M2 detect + plan + scope + probe。**  
> 这不是 Rocket.Chat 级验收。产品级证明是后续在操作者机器上的可信/手工运行，**不是 CI**。  
> CI 使用多组件夹具。M3 才实现 `start`。

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
- `start` / `stop` 接口保留，实现未交付

## 尚未交付

- 真实 boot（M3）、运行时 Discovery、真实 LLM
- M3–M6 其余适配器
- Effect DAG / Reconciler / 能力注册表 / Worker / Broker
- 在 CI 中克隆任何真实产品仓库

详见 [docs/M0.md](docs/M0.md)、[docs/M1.md](docs/M1.md) 与 [docs/M2.md](docs/M2.md)。

## 目录

```
packages/contracts/   # 类型、JSON Schema、语义校验
packages/source/      # SourceProvider：git + local（archive 未交付）
packages/project/     # ProjectAdapter：detect + plan（start/stop 未交付）
packages/agent/       # AgentRunner 接口实现：Mock only
packages/export/      # generateProductMap / Diagrams / Web / Tests
fixtures/m0-fake-study/
fixtures/m2-message-sync/
docs/M0.md
docs/M1.md
docs/M2.md
tests/
```

## 使用

```bash
npm install
npm test
```

`npm test` 覆盖：结构 schema、语义校验、MockAgentRunner 合约、假数据走查、M1 SourceProvider（临时微型 git 夹具），以及 M2 detect/plan/scope（多组件夹具，不克隆真实产品）。

生成的 Playwright spec **可被发现、含 Journey ID**；不可靠 locator 使用 `test.skip` / TODO。M0 **不运行这些测试，也不声称它们已通过**。

## 许可

MIT。见 [LICENSE](LICENSE)。
