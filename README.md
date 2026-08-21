# 行为地图（behavior-map）

通用产品行为分析器。核心对象是 **Surface / Control / Journey / Observation**，不绑定任何聊天或代码托管产品。

> **当前：M0 合约 + Mock，以及 M1 Source 快照（git / local）。**  
> 这不是 Rocket.Chat 级验收。产品级抓取是后续在操作者机器上的可信/手工运行，**不是 CI**。

## 已交付

### M0
- JSON Schema 与语义校验
- `AgentRunner` 接口 + `MockAgentRunner`
- 导出函数与消息域形状的假数据走查

### M1
- `SourceProvider.prepare`：`git`（记录解析 commit）与 `local`（git checkout → commit+dirty；非 git → `content_digest`）
- `archive` 接口保留，实现未交付（`not_shipped`，不是「不支持的 kind」）
- 下游只消费 `Workspace` + `SourceSnapshot`

## 尚未交付

- 真实 boot、运行时 Discovery、真实 LLM
- M2–M6 产品适配器
- Effect DAG / Reconciler / 能力注册表 / Worker / Broker
- 在 CI 中克隆任何真实产品仓库

详见 [docs/M0.md](docs/M0.md) 与 [docs/M1.md](docs/M1.md)。

## 目录

```
packages/contracts/   # 类型、JSON Schema、语义校验
packages/source/      # SourceProvider：git + local（archive 未交付）
packages/agent/       # AgentRunner 接口实现：Mock only
packages/export/      # generateProductMap / Diagrams / Web / Tests
fixtures/m0-fake-study/
docs/M0.md
docs/M1.md
tests/
```

## 使用

```bash
npm install
npm test
```

`npm test` 覆盖：结构 schema、语义校验、MockAgentRunner 合约、假数据走查，以及 M1 SourceProvider（临时微型 git 夹具，不克隆真实产品）。

生成的 Playwright spec **可被发现、含 Journey ID**；不可靠 locator 使用 `test.skip` / TODO。M0 **不运行这些测试，也不声称它们已通过**。

## 许可

MIT。见 [LICENSE](LICENSE)。
