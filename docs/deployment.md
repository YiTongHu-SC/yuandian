# GitHub Pages 与远程 MCP 部署

更新日期：2026-10-19，Asia/Shanghai。

源码仓库：[YiTongHu-SC/yuandian](https://github.com/YiTongHu-SC/yuandian)。在线地址：[原点](https://yitonghu-sc.github.io/yuandian/)。发布由用户明确要求，源码和提交历史公开；个人画布、备份、日志及客户端配置不属于发布内容。

## 发布方式

GitHub 仓库 Settings → Pages 的 Source 选择 **GitHub Actions**。默认分支 `main` 更新时，Pages 工作流安装锁定依赖，执行 `npm run verify` 和 `npm run build:pages`，上传 `dist/pages/` 后部署；也可在 Actions 中手动运行。部署结果以工作流的 `github-pages` 环境地址和线上访问为准。

本地准备发布产物：

```powershell
npm ci
npm run verify
npm run build:pages
```

`build:pages` 只复制静态入口及前端资源，保持相对引用以支持 `/yuandian/` 路径。产物不包含 Node 服务、MCP 桥、依赖、测试、源码仓库元数据或个人目录。`dist/` 不进入 Git，由 Actions 每次重新生成。

## 数据与功能边界

- 画布保存在访问者自己的浏览器 localStorage。发布不会上传本机画布；用户开启 MCP 后，授权内容会按工具请求经过临时中继和 AI 客户端，没有云端保存服务。
- GitHub Pages 与 `http://127.0.0.1:4176/` 属于不同站点存储，换机器、浏览器或站点地址不会自动带走内容。迁移时在来源端“文件”导出 JSON，再在目标端预览并“追加导入”；原有画布保留。
- Pages 仍只运行静态画布和旧六步兼容入口；“AI 接入”连接下述独立 Node 中继。本机回环地址继续使用原 stdio 接入。使用方式见 [MCP 指南](mcp.md)。
- GitHub Pages 同一站点域名下的应用共享浏览器存储来源；本项目保留既有存储键以兼容数据，源码或路径改名不构成自动迁移机制。重要内容仍需导出备份。

## 首次静态发布验证（历史范围）

2026-10-19 实际发布与检查：

- 已创建 public 仓库 `YiTongHu-SC/yuandian`，默认分支 `main`，本地 `origin` 指向该独立仓库。Pages 的 `build_type` 为 `workflow`，已强制 HTTPS。
- 首次发布提交为 `ca7fb37`；[Actions 构建与部署](https://github.com/YiTongHu-SC/yuandian/actions/runs/39179182592)均成功。工作流固定官方 action 的 SHA，只上传 13 个运行文件。
- 本机 `npm run verify` 的 102 项测试全部通过，`build:pages` 成功。公开地址和两个 HTML 入口返回 200；逐一请求全部 13 个运行文件，与 Git 提交中的文件内容一致。站点下的 `private/`、`backups/`、Git 配置、Node 服务、项目文档及历史截图路径返回 404。
- 本次内置浏览器能打开公开地址并识别标题，但远程页的 DOM / 调试控制持续超时，因此没有将公网 HTTPS 上的直接交互列为通过。
- 对相同静态产物在隔离地址 `http://localhost:4192/pages/` 进行实际浏览器验证：空卡片编辑、Tab 分支连线、改名、刷新保存、真实 JSON 下载与预览后追加回导均通过；原画布保留并生成副本。兼容入口正常显示，两页控制台均无警告或错误。非本机回环主机名不显示“AI 接入”；另开正式 `127.0.0.1:4176` 页面确认该入口仍显示。此结果是静态预览验证，不替代公网实机验证。

[静态产物预览截图](../assets/screenshots/pages-static-preview.png)仅含虚构内容。预览页面与临时服务已关闭，未修改日常画布、清空 localStorage 或上传本机数据。此次只验证旧六步入口加载，未重新执行其完整交互流程。

### 公网交互复验（2026-10-19，受阻）

用户继续要求直接验证公开 HTTPS 页面。本轮在 Edge 中找到已打开的线上标签页，但读取页面状态的请求超时，没有对其输入或改动画布。用户随后明确要求停止操作 Edge，仅使用 GPT 内置浏览器。

在 GPT 内置浏览器中新建独立页面，导航到 `https://yitonghu-sc.github.io/yuandian/` 已完成；页面状态读取与截图请求仍持续超时，无法取得可用于实际点击和编辑的页面观察。没有在该线上页面执行编辑、连线、刷新或导入，也没有证据可将这些公网操作记录为通过。用户确认“只用 GPT 内置浏览器，先记录阻碍”；未启动备选无头浏览器，未使用其日常浏览器数据。后续恢复控制后，再使用独立虚构测试画布继续验证。

源码复核未发现明确的 HTTPS 或项目子路径阻断。后续须实际核对中文与多行编辑、续写、Tab 自动连线及跨分支手动连线、已保存后刷新、真实 JSON 下载及预览后追加导入，并确认无效文件与取消操作保留原数据。此复核不替代浏览器操作；未确认产品故障前，不修改画布实现来掩盖控制工具超时。

本轮 `npm run verify` 的静态检查与 102 项测试全部通过。本轮只补充验证记录和 MCP 功能边界说明，未修改应用运行资源或数据格式；此前静态预览的结果仍保留原范围，不升级为公网直接验证结果。

## 远程 MCP 服务器评估与部署（2026-10-19）

用户要求先评估复用 `hu-yitong-portfolio` 所用服务器，再按最小方案实现与部署。通过现有受信 SSH 连接只读核验：Debian 13、Caddy 2.11.4、systemd 257、2 CPU，约 1.44 GiB 可用内存、54.5 GiB 空闲磁盘，候选端口未占用，足以运行单实例内存中继。服务器原无 Node；本次使用官方 Node 24.22.0 的专用安装，不改全局 Node、DNS、TLS、主站产物或试玩版本。

| 组件 | 位置与职责 |
| --- | --- |
| 画布前端 | 原 Pages 地址与原 `yitong.thinking-canvas.v1` 存储键不变；14 个静态运行文件 |
| MCP 地址 | `https://stellarcore.games/yuandian-mcp/mcp`，Codex 经 Streamable HTTP 调用 |
| 页面通道 | 同服务下 `/api/mcp/session`、`poll`、`result`、`disconnect`；精确 Pages Origin，HTTPS 长轮询 |
| Node | `/opt/yuandian-node/node-v24.22.0-linux-x64/bin/node`，仅监听 `127.0.0.1:4177` |
| 服务与目录 | 独立 `yuandian-mcp` 用户及同名 systemd 服务；`/srv/yuandian/mcp/releases/` 与 `current` 链接 |
| HTTPS | 复用 Caddy 主域名，只新增 `/yuandian-mcp/*` 路径；先去前缀并反代，再保留原主站回退 |

Node 官方发行包的 SHA-256 已与 [官方校验清单](https://nodejs.org/dist/v24.22.0/SHASUMS256.txt)核对：`cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008`。服务器连接资料、完整配置备份、安装诊断与部署回执只留在本机忽略的 `private/remote-deployment/` 和服务器 root 可读的部署记录中，不进入 Git 或静态网站。

### 发布与回退约定

当前后端负载严格限定九个文件：`package.json`、`package-lock.json`、`scripts/mcp-server.mjs`、`scripts/mcp-remote-server.mjs`、`scripts/mcp-remote-bridge.mjs`、`scripts/mcp-access.mjs`、`src/canvas/mcp-model.js`、`src/canvas/mcp-workspace-model.js`、`src/canvas/model.js`。首次部署为七个文件，工作区授权增加共享权限校验与跨画布纯模型两项。从已核验提交取字节、记录清单和 SHA-256；服务器独立新版本目录执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`，不上传完整仓库、画布、测试或个人资料。

服务模板见 [systemd](../deploy/remote-mcp/yuandian-mcp.service) 与 [Caddy 路由片段](../deploy/remote-mcp/stellarcore-route.caddy)。模板不是服务器完整配置：需先读取当前 Caddyfile，备份并保留其他站点原文，将主站原 `try_files` / `file_server` 纳入模板的字面顺序路由。单独在原全站 `try_files` 旁追加反代可能先被重写为首页，必须用 `caddy validate` 和 `caddy adapt` 检查最终顺序。该路径使用 `log_skip`，Node 也不记录正文或令牌。

核对目录与服务身份后，原子切换 `current`，安装专属 unit，执行 `systemctl daemon-reload` 和 `systemctl enable --now yuandian-mcp`；先通过带 `Host: stellarcore.games` 的本机 `/health`，再验证和 reload Caddy，最后检查公网健康和现有站点指纹。服务账户没有持久写目录，启用 `ProtectSystem=strict`、`ProtectHome`、空 capabilities、仅回环网络、384 MiB 内存与 64 task 限额。

失败时保留发布包，撤回新增路径、unit 和本服务的 current 链接，恢复已核验的原配置并再次验证。已有服务更新时，保留上一 release，原子切回并重启；重启必然撤销内存授权，浏览器持久数据不迁移。恢复配置前比较活动哈希，若其他任务已修改 Caddy 则先合并，不能覆盖其改动。Pages 可通过恢复先前提交触发重新发布，保持页面地址与存储键不变。

首次激活时发现入口通过 `current` 符号链接执行后未启动监听，健康检查失败；部署脚本已自动恢复原 Caddy 配置和服务状态。根因为 Node 主入口比较未解析符号链接，已加入真实 CLI 经目录链接启动的回归检查，修复后重新发布。此失败没有切换 Pages 或改动浏览器数据。

### 当次验证范围

界面验证继续只使用 GPT 内置浏览器；本轮页面状态读取再次超时，不能取得可用于操作的观察。没有使用 Edge、独立无头浏览器，未清理或改写日常 localStorage。授权按钮、真实页面与 Codex 的端到端读写、整批撤销、刷新保存和 JSON 回导仍须在浏览器控制恢复后实测。下述协议与服务检查不替代这些页面结果。

- 后端已激活 `mcp-20261019-bedecb7`，七文件内容与提交 `bedecb7a426bbcd1415b58be175670d5bc57a527` 一致；本机和公网健康检查通过。主站、未知路径原有首页回退及既有试玩的状态、最终地址和 HTML 指纹与部署前一致。
- `npm run verify` 的静态检查和 127 项测试通过，包含实际 stdio / Streamable HTTP SDK、CLI 经版本链接启动、并发超限回包，以及前端授权撤销状态逻辑。前端状态测试使用 DOM 替身，不是浏览器验证。
- 使用本机 Codex app-server 自身的 MCP 客户端，经公网 HTTPS 完成三工具发现、读取、默认只读拒写、读写模式的一批新增 / 修改 / 连线、旧 revision 拒写及断开后的 401。页面端为明确标注的虚构内存模型：成功编辑后为两卡一线，未接触真实浏览器数据，不能据此声称当前线上画布已被修改或保存。
- 实际公网预检允许精确 Pages Origin，其他 Origin 403，匿名 MCP 401。只重启已核对身份的本服务后，旧测试令牌 401，健康检查恢复，Caddy 配置保持。测试授权均已撤销，客户端临时配置已删除。
- Codex 验证使用隔离的 `CODEX_HOME`，没有替换用户全局配置或把当前聊天切换到某张线上画布。实际使用时须先在页面开启当前画布授权，再复制生成的 TOML、保留并替换原 `yuandian` 条目并重新加载；受浏览器控制阻碍，本轮未替用户完成此真实页面授权步骤。
- Pages 提交 `99782c0` 的 [构建与发布](https://github.com/YiTongHu-SC/yuandian/actions/runs/39183629112)成功；Linux CI 的 127 项中 125 通过、2 项 Windows 专用启动检查按平台跳过。本机 Windows 127 项全部通过。公网逐文件核对 14 个运行文件与提交一致，私有目录、Node 脚本、依赖清单、项目文档及历史截图路径保持 404。随后文档更新不改变这些运行文件。
- 发布后再用 GPT 内置浏览器新建页面，可获得标签标识，但页面状态和截图仍无法返回；本轮没有真实页面读写证据，未将此阻碍当成产品故障绕过，也未改用其他浏览器。
