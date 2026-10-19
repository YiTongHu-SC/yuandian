# 开发与验证

## 环境与命令

需要 Node.js 20 或以上版本，无构建步骤。普通画布与本机静态服务可不安装 SDK 运行；开发、完整测试或使用 MCP stdio 前执行 `npm ci`，按锁文件安装官方 `@modelcontextprotocol/server` 及测试用 `@modelcontextprotocol/client` 2.3.1。Windows 使用 PowerShell 启动脚本，其他环境可用 `npm start`。

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按 `package-lock.json` 安装 MCP 运行与测试依赖，不增加前端构建链 |
| `npm start` | 前台启动 `scripts/dev-server.mjs`，默认 `127.0.0.1:4176`；Ctrl+C 停止 |
| `.\start.ps1` / `Start.cmd` | Windows 后台启动或核对并复用当前目录的服务，打开浏览器 |
| `.\start.ps1 -NoBrowser` | 仅启动或复用服务 |
| `npm test` | 运行 `tests/unit/` 和 `tests/tooling/` 的 Node 测试 |
| `npm run check` | 执行 `scripts/check.mjs` 项目静态检查 |
| `npm run verify` | 依次运行静态检查与全部测试 |
| `npm run build:pages` | 按白名单复制静态应用到 `dist/pages/`，供 GitHub Pages 发布；不生成或上传用户数据 |
| `npm run mcp` | 启动 stdio MCP 服务；通常由 AI 客户端按页面生成的配置启动，需要有效临时环境变量 |
| `npm run mcp:remote` | 启动独立远程 MCP 后端，需设置公开 HTTPS 地址等环境变量；仍只监听回环地址 |

不要直接打开本地 HTML。ES Modules 通过 HTTP 加载；用户日常入口固定为 `http://127.0.0.1:4176/`，更换 host 或端口会使用另一份浏览器站点存储。

重复启动时需确认服务来自同一项目目录。占用端口的服务身份不符时，启动脚本应报错并保留该进程。旧 Python 服务只有在目录核验匹配后才能兼容复用；若要验证新的静态资源访问边界，应使用新的 Node 服务。

MCP 需要支持 `/api/mcp/` 的当前 Node 服务；仅刷新页面不能更新已运行的旧服务代码。确认身份后重启本项目服务，勿结束无关进程。通过页面“AI 接入”生成配置，客户端会以 Node 绝对路径启动 `scripts/mcp-server.mjs`，并传入 `YUANDIAN_URL` 与 `YUANDIAN_MCP_TOKEN`；不要把真实令牌写入源码、测试记录或 Git。配置方法见 [MCP 接入指南](mcp.md)。

GitHub Pages 在 `main` 更新时由 Actions 先执行完整检查，再发布 `build:pages` 的静态产物。远程 MCP 后端独立部署，通过既有 Caddy HTTPS 反向代理，不进入 Pages 产物。模板在 `deploy/remote-mcp/`；运行需设置 `YUANDIAN_PUBLIC_URL=https://stellarcore.games/yuandian-mcp`、`YUANDIAN_ALLOWED_ORIGIN=https://yitonghu-sc.github.io`、`YUANDIAN_PORT=4177`，生产使用独立 systemd 用户、回环监听与单进程内存会话。部署与回退见 [部署说明](deployment.md)。线上与本机数据不自动同步。

## 改动与检查

先确认 [产品边界](../PROJECT.md)、[模块职责](architecture.md)和 [数据约定](data-format.md)。纯模型改动保留模型无 DOM 依赖；界面改动使用真实浏览器验证，模块搬迁同时核对两个入口的脚本与样式加载。

`npm test` 用于验证数据、计算和工具行为，`npm run check` 用于发现语法与引用错误。两者不能替代页面操作。无需为轻微文案变化扩写整套测试；新增测试应覆盖实际错误、兼容边界或可观察行为。

MCP 纯操作测试位于 `tests/unit/canvas-mcp.test.mjs`；临时桥和真实 stdio SDK 客户端测试位于 `tests/tooling/mcp-bridge.test.mjs`、`tests/tooling/mcp-server.test.mjs`。协议测试会用虚构响应与独立回环端口，不访问日常浏览器数据；它验证传输和鉴权，实际页面保存、撤销和授权切换仍需界面验证。

远程 MCP 测试需使用真实 Streamable HTTP SDK 客户端核对协议、只读拒写、单画布范围、错误令牌、Origin、超时、断开和版本冲突；模拟浏览器桥返回的结果只证明协议路径。随后在隔离页面以虚构数据验证授权、读取、批量写入、整批撤销、刷新保存与 JSON 回导，并用实际 Codex 调用确认客户端配置。协议、Codex 与界面三类证据分开记录；服务 HTTP 可达不代表页面操作通过。

## 界面验证

使用隔离的浏览器配置和虚构内容。涉及自动保存或导入时，避免使用日常存有真实分析的配置；不要以清空 localStorage 作为测试前置步骤。

结构或交互改动按影响范围选择下列路径，并记录日期、浏览器、实际结果和未覆盖项：

| 路径 | 要确认的行为 |
| --- | --- |
| 加载 | `index.html` 和 `guided.html` 正常显示，脚本 / 样式无 404，控制台无错误 |
| 编辑与分支 | 双击原位编辑多行文字，点击空白完成；Tab 新分支并正确连线 |
| 拖动与关系 | 拖动卡片后坐标改变、连线跟随；跨分支连接可选中并单独删除 |
| 撤销重做 | 删节点清理关联，撤销恢复节点及连线；切换画布不串用历史 |
| 画布视图 | 空白拖动、缩放与显示全部正常，位置与连线保持一致 |
| 保存 | 等待保存状态完成后刷新，文字、位置、颜色和连接仍在 |
| JSON 回导 | 下载真实文件再选择导入；追加副本，原记录和内部连接保留；无效文件禁止导入 |
| 文件菜单 | 当前与全部导出直接下载；选择后在菜单内预览；改选无效、超大和容量失败时禁止确认并保留原数据；取消、Esc、外点和切换作废候选，菜单内不触发画布删除或撤销 |
| 跨页冲突 | 两页竞争编辑时暂停覆盖，可导出本页或保留副本；双方内容可恢复 |
| MCP 只读 | 默认只读，本机 stdio / 远程 HTTP 配置分别可加载；工具列表和授权内容可读取，编辑返回拒绝；未授权 / 错误令牌不能读取 |
| MCP 读写 | 先读版本，再批量创建、更新、连线、删除；成功时本机保存已完成，可撤销重做，刷新和 JSON 回导仍兼容 |
| MCP 冲突与撤销授权 | 旧版本、无效操作、编辑中、拖动、未保存、导入和跨页冲突拒绝写入；断开、切换、刷新、过期后旧配置失效；等待写锁或摘要期间断开也不提交 |
| 线上接入 | 保持 Pages 地址、原 localStorage 与 JSON 不变；授权只含当前页面的一张画布；未点击开启时不发送画布；异常失联 / 服务重启后需新授权，旧令牌不能恢复 |

旧六步工具改动时，另核对记录编辑、删除解除关联、JSON 回导与刷新保存。服务改动时，核对入口 / 模块可访问、私有目录不公开、仅回环监听、重复启动复用和无关端口占用的报错。

## 验证证据与提交

本机 MCP 的历史实际结果见 [MCP 验证](mcp-validation.md)。2026-10-19 文件菜单的当次结果见 [文件菜单验证](file-menu-validation.md)；此前的 [极简交互验证](ui-validation.md)、[目录整理验证](validation.md)与 [docs/history/](history/CANVAS-VALIDATION.md)保留各自日期的范围、路径、命令和数量，不代表本轮已重新通过。每次交付说明当次运行的命令、结果和界面覆盖范围，不能仅凭目录整理或历史记录推断兼容性。

本轮远程部署和验证以 [部署说明](deployment.md) 为准。用户当前要求只用 GPT 内置浏览器；其公网页面控制持续超时时记录阻碍，不改用 Edge、独立无头浏览器或其他控制通道，不把历史静态预览或协议测试标为本轮真实页面通过。

检查 `git diff`、`git status` 与暂存内容，确认没有个人备份、日志、凭据或无关改动。默认分支名为 `codex/<task-name>`。独立远端为 `https://github.com/YiTongHu-SC/yuandian`，不借用来源仓库地址。公开推送会使源码及提交历史可见；部署只上传静态白名单产物，实际结果以远端工作流和线上检查为准。
