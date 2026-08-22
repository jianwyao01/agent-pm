# M4 / M4b / M7 / M8 双 Surface 夹具

微型本地 Web 应用：登录墙 + 列表面 + 撰写/详情面。列表面有一条导航树入口（打开撰写面）和一条创建入口（打开名称栏 + 提交，导航/列表出现新项）。注入 storageState 后可绕过登录墙。

这不是产品仓库，也不是 Rocket.Chat 证明。CI 用它验证 `DiscoveryAdapter.scan / explore / execute`、M4b 的 Control / Binding / SessionProvider、M7 的 `runClosedLoop`（树入口 click + type + submit），以及 M8 的创建序列（打开创建 + 填名称 + 提交）。  
产品级 RC 证明是后续在操作者 Linux 机器上、用户将目标仓库标为 trusted 并提供会话之后的可信运行。
