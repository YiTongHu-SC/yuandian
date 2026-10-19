# 架构与目录

这是一个可本机运行或静态托管的网页原型。浏览器直接加载 ES Modules，拥有画布数据、校验和保存职责；Node.js 提供本机服务、检查、本机 MCP stdio 与独立远程 MCP 中继。浏览器端无需构建或 SDK，两种桥均不持久化画布。产品方向以 [PROJECT.md](../PROJECT.md) 为准。

## 内容与交互基础

产品“原点”以“让思维可以自由生长”为理念，采用“一切皆卡片”的内容组织方式：用户内容由卡片承载，关系由连线表达，画布提供空间。界面与交互优先支持直接、自由、靠直觉的编辑，避免为不同内容另建操作流程或冗余功能。

当前文本卡片在代码和 v1 数据中称为 `Node` / `node`，关系称为 `Edge` / `edge`；产品称谓与技术命名对应即可，无需为文案调整修改字段或存储格式。当前模型只表达已实现的文本卡片，不预设未来内容类型的继承层级或通用插件框架。

## 目录职责

```text
thinking-canvas/
├─ index.html                 自由画布入口
├─ guided.html                旧六步工具兼容入口
├─ src/
│  ├─ canvas/                 自由画布界面、模型与纯计算模块
│  └─ guided/                 旧六步工具界面、模型与业务计算
├─ assets/screenshots/        不含个人分析的历史操作示例
├─ tests/
│  ├─ unit/                   模型和纯逻辑测试
│  └─ tooling/                开发服务、MCP 桥与实际 stdio 测试
├─ scripts/                   本机服务、MCP stdio / 远程 HTTP / 桥和检查工具
├─ deploy/remote-mcp/         独立 Node 服务的 systemd 与 Caddy 路由模板
├─ .github/workflows/         检查与 GitHub Pages 部署
├─ docs/                      架构、开发、数据约定
│  └─ history/                初始化及历史验证记录
├─ Start.cmd / start.ps1       Windows 启动入口
├─ package.json / package-lock.json  Node 运行要求、命令及锁定的 MCP 依赖
└─ README / PROJECT / AGENTS / CHANGELOG
```

`private/`、`backups/` 是可选的个人文件位置，已从 Git 忽略，也不属于应用资源。

GitHub Pages 的产物由 `scripts/build-pages.mjs` 复制到已忽略的 `dist/pages/`，仅包含两个 HTML 入口及其前端资源，不包含服务脚本、依赖、测试、Git 元数据或个人目录。入口与模块使用相对路径，支持 `/yuandian/` 项目路径。线上浏览器使用固定独立中继，本机 HTTP 回环地址沿用本机桥；其他来源不自动启用 AI 接入。两种部署的 localStorage 互相独立，JSON 用于显式迁移。发布流程与实际状态见 [部署说明](deployment.md)。

## 自由画布

| 模块 | 职责 |
| --- | --- |
| `src/canvas/app.js` | DOM 渲染、输入和拖动事件、当前选择、菜单与必要确认、保存状态与跨页协调 |
| `src/canvas/model.js` | 工作区 / 画布 / 节点 / 连线数据，校验、追加导入、JSON 导出和存储保护 |
| `src/canvas/history.js` | 按画布隔离的会话撤销与重做记录 |
| `src/canvas/geometry.js` | 视图坐标换算、坐标限幅与连接曲线等纯计算 |
| `src/canvas/mcp-model.js` | MCP 编辑白名单与 JSON Schema、内容版本、原子操作及最终 v1 校验；无 DOM 或存储 |
| `src/canvas/mcp-workspace-model.js` | 跨画布列举、按 ID 读取和编辑、新建、兼容 JSON 导出、工作区版本；复用卡片模型，无 DOM 或存储 |
| `src/canvas/mcp-connection.js` | 允许接入的来源与路径、固定中继地址、本机 / 远程参数及 Codex TOML 生成 |
| `src/canvas/mcp-ui.js` | 本机临时授权面板、页面实例及配置、页面轮询；线上分派给配对面板 |
| `src/canvas/mcp-paired-ui.js` | 线上一次配对与重新授权面板、权限 / 期限、显式跨页接管、轮询及授权检查 |
| `src/canvas/mcp-pairing.js` | 独立 IndexedDB 设备密钥与配对标识、一次性挑战签名、固定 Codex 配置的严格解析 |
| `src/canvas/styles.css` | 自由画布布局、卡片和交互视觉 |

应用入口调用模型处理数据，再将用户内容作为文本显示。纯模块不依赖 DOM、网络或旧六步工具。会话历史与选择不写入数据格式；视图位置保存在画布数据中，但不进入节点编辑撤销。

顶栏提供唯一的画布名称入口、画布管理与全局动作；卡片的编辑、延伸、连接、配色和删除通过所选卡片旁的工具完成。就地工具的位置跟随选择、拖动与视图变化，并保持在可操作的画布区域。当前选择、连接模式、展开菜单、编辑光标和工具位置属于界面状态，不进入工作区或 JSON。

“文件”使用顶栏下拉菜单，提供当前画布导出、全部备份与 JSON 追加导入。导出直接下载；读取进度、候选预览、错误及追加确认在同一菜单中呈现，不打开导入导出对话框。候选数据、读取标记和递增读取序号均属应用临时状态：关闭菜单、取消或切换时立即失效，异步读取完成后先核对序号，防止旧结果重新出现。文件选择、读取与候选预览期间仍参与跨页冲突判断；展开文件菜单时隔离画布快捷键，Esc 关闭后归焦“文件”。

空卡片通过模型中已有的 `text: ''` 表达；占位提示仅由界面呈现。新画布的首张卡片由应用进入编辑，已有工作区加载和 JSON 导入不触发内容替换。界面文字使用“卡片”和“延伸”，仍沿用 `node` / `edge` 字段，保持 v1 兼容。

## MCP 接入

```text
本机 AI 客户端
  → scripts/mcp-server.mjs（官方 SDK，MCP stdio）
  → scripts/mcp-bridge.mjs（127.0.0.1 HTTP，临时令牌和请求队列）
  → src/canvas/mcp-ui.js（授权页面轮询）
  → app.js / mcp-workspace-model.js / mcp-model.js（目标、版本、原子校验、保存和撤销）
  → 当前浏览器 localStorage

线上 Codex
  → https://stellarcore.games/yuandian-mcp/mcp（Streamable HTTP）
  → Caddy → scripts/mcp-remote-server.mjs（127.0.0.1:4177）
  → scripts/mcp-remote-bridge.mjs（固定身份鉴权、内存授权与请求队列）
    → scripts/mcp-pairing-store.mjs（受限配对元数据与一次性挑战验签）
  ← Pages 的 mcp-paired-ui.js 主动发起 HTTPS 长轮询
  → 同一 app.js / MCP 纯模型 → 当前浏览器 localStorage
```

`mcp-server.mjs` 共注册连接状态、列举、读取、编辑、新建及导出六个工具，通过环境变量接收本机 URL 与客户端令牌；远程服务复用相同注册。它不直接读取磁盘备份或浏览器存储；导出返回浏览器生成的 JSON 字符串，由客户端决定是否存文件，不让中继落盘或强制浏览器下载。标准输出仅承载 MCP 消息。官方服务端 SDK 为运行依赖，客户端 SDK 为实际 stdio 测试的开发依赖，均锁定在 2.3.1。

`mcp-bridge.mjs` 按需由本机服务加载，使用不同的页面令牌和 AI 客户端令牌，校验 Host / Origin、工具与只读权限；只在进程内保留会话、请求及短暂结果，不写画布文件。新面板按页面实例创建 `workspace` 授权，覆盖该浏览器该站点全部自由画布，最长一小时；页面心跳中断超过十秒或主动断开即失效，每项请求十五秒过期。

`mcp-remote-server.mjs` 提供单个回环监听，由 Caddy 终止 HTTPS 并剥离 `/yuandian-mcp` 前缀；systemd 使用独立低权限用户管理进程。`mcp-remote-bridge.mjs` 复用六工具注册和纯模型，增加远程 MCP 端点、精确 Origin / Host 校验、请求大小与速率限制及有界内存队列。固定客户端凭据先验证配对身份；有效身份始终可初始化和发现工具，没有活跃授权则状态为 `needs_authorization`，不能获取内容。错误或已撤销凭据在 HTTP 层拒绝。

`mcp-pairing-store.mjs` 仅持久保存配对 ID、客户端凭据哈希、浏览器 P-256 公钥、创建与撤销时间；以私有文件和原子替换串行保存，不保存原始凭据、浏览器私钥或临时授权。浏览器 `mcp-pairing.js` 将不可导出的设备私钥和配对标识放在独立 IndexedDB，以短期、单次、绑定操作参数的挑战签名证明配对归属。标签页标识独立放在 sessionStorage。多页通过明确接管操作转交，不能静默取代原页。

临时授权仍由页面实例、范围、权限和期限共同限定，每次默认只读；线上可选一分钟、十五分钟或一小时，最长一小时。每个授权生成新的页面令牌，旧授权的请求不能借用新授权提交。浏览器每次长轮询最多等待 20 秒，远程请求 30 秒过期、心跳失联 90 秒失效。刷新、关闭、断开、到期或服务重启撤销临时授权，网页重新授权即可使用原固定客户端配置；切换 / 新建 / 删除 / 导入画布不撤销工作区授权。旧远程临时配置与本机 stdio 保持原生命周期。

`scripts/mcp-access.mjs` 是两种桥共同的授权和工具范围检查：默认只读，工作区编辑必须显式传 `boardId`，新建须传 `expectedWorkspaceRevision`，导出全部不能同时指定单张 ID。旧页面没有 `scope` 的请求保留原 `canvas` 单画布范围，拒绝列举、新建、全部导出或其他 ID；不会因服务更新自动扩大旧令牌权限。新面板拒绝旧范围的授权响应。

两种桥都只转发授权页面的内容。远程内容会经过服务器及 AI 客户端，不将浏览器画布改为云端保存；无账号、画布数据库、离线编辑队列或同步。中继不记录内容和凭据，Caddy 对中继路径跳过访问日志。仅部署一个进程，不以多实例共享授权；重启保留独立配对文件并清除全部临时会话。systemd 仅新增配对专用 `StateDirectory=yuandian-mcp`，其余运行目录继续只读。部署模板位于 `deploy/remote-mcp/`，实际主机改动与回退方法见部署说明。

`app.js` 保留数据所有权：读操作在异步前后检查捕获的授权；写操作获取同源写锁后检查编辑和保存状态，在副本上执行操作，异步摘要完成后重新检查原会话授权、请求期限和全工作区指纹，再通过 `save(expectedRaw)` 比较保存。只有保存成功才替换内存并回执。修改记入目标画布的会话历史，不切换当前画布；新增默认不切换当前画布，通过通知提供撤销新增，已有后续内容改动则拒绝删除。期间修改、断开、超时、损坏数据或跨页冲突均不能被 AI 静默覆盖；异步期间切换可能使当次写入冲突，但不会撤销工作区授权。完整接口与生命周期见 [MCP 接入指南](mcp.md)。

## 旧六步工具

`src/guided/app.js` 负责旧界面和保存协调，`model.js` 负责旧格式及导入导出，`logic.js` 负责计算、删除解除关联及变更检测，`styles.css` 保留旧视觉。该入口使用自己的存储键与 schema，不读取自由画布数据，也不作为新版交互的扩展基础。

## 开发工具

`scripts/dev-server.mjs` 提供仅监听 `127.0.0.1` 的静态服务，公开两个 HTML 入口、`src/` 和 `assets/`，提供供启动脚本核对目录的身份信息，并按需接入 `/api/mcp/` 临时桥。该内部 HTTP 接口不是远程 MCP 传输端点。Git 元数据、项目文档、测试和个人备份不作为静态资源公开。

`scripts/check.mjs` 汇总项目语法与静态引用检查。测试使用 Node 内置测试运行器，不依赖打包器或第三方测试框架；MCP 协议集成测试使用官方客户端 SDK。启动、测试和界面检查方式见 [开发与验证](development.md)。
