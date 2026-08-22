# M4 / M4b / M7 双 Surface 夹具

微型本地 Web 应用：登录墙 + 列表面 + 撰写/详情面。列表面有一条导航树入口，点击后打开撰写面。注入 storageState 后可绕过登录墙；发送后列表更新。

这不是产品仓库，也不是 Rocket.Chat 证明。CI 用它验证 `DiscoveryAdapter.scan / explore / execute`、M4b 的 Control / Binding / SessionProvider，以及 M7 的 `runClosedLoop`（树入口 click + type + submit）。  
产品级 RC 绑定发送是后续在操作者 Linux 机器上、用户将目标仓库标为 trusted 并提供会话之后的可信运行。
