# 行为地图（behavior-map）

通用产品行为分析器。核心对象是 **Surface / Control / Journey / Observation**，不绑定任何聊天或代码托管产品。

> **当前是 M0：合约 + Mock + 假数据走查。**  
> 这不是 Rocket.Chat 级验收。Rocket.Chat 只是后续的证明级示例，本仓库 M0 **不会**去克隆、启动或探索任何真实产品。

## 本里程碑做什么

- JSON Schema 与语义校验（`evidence_ref`、journey–effect、四份导出共用 `journey_id`、`generated/` 不得当输入）
- `AgentRunner` 接口 + `MockAgentRunner`（只写 proposal 与 agent-scratch）
- 导出函数：产品地图、Mermaid 图、离线只读静态页、带 Journey ID 的 Playwright spec
- 消息域形状的假数据走查，写出 `analysis/` 树

## 本里程碑不做什么

- 真实 Source git fetch、真实 boot、真实 Playwright 探索、真实 LLM
- M1–M6 产品适配器
- Effect DAG / Reconciler / 能力注册表 / Worker / Broker
- 把 Room / Channel / 具体产品类型焊进核心

详见 [docs/M0.md](docs/M0.md)。

## 目录

```
packages/contracts/   # 类型、JSON Schema、语义校验
packages/agent/       # AgentRunner 接口实现：Mock only
packages/export/      # generateProductMap / Diagrams / Web / Tests
fixtures/m0-fake-study/
docs/M0.md
tests/
```

## 使用

```bash
npm install
npm test
```

`npm test` 覆盖：结构 schema、语义校验、MockAgentRunner 合约、假数据走查（写入 `analysis/` 与 `generated/`）。

生成的 Playwright spec **可被发现、含 Journey ID**；不可靠 locator 使用 `test.skip` / TODO。M0 **不运行这些测试，也不声称它们已通过**。

## 许可

MIT。见 [LICENSE](LICENSE)。
