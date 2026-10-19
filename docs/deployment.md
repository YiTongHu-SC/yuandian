# GitHub Pages 部署

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

- 画布保存在访问者自己的浏览器 localStorage。发布代码不会读取或上传本机画布，也没有云端保存服务。
- GitHub Pages 与 `http://127.0.0.1:4176/` 属于不同站点存储，换机器、浏览器或站点地址不会自动带走内容。迁移时在来源端“文件”导出 JSON，再在目标端预览并“追加导入”；原有画布保留。
- 在线版提供静态画布和旧六步兼容入口，不运行 Node MCP 后端。只有本机 HTTP 回环地址显示“AI 接入”；需要 AI 操作时运行本机版本并按 [MCP 指南](mcp.md)授权。
- GitHub Pages 同一站点域名下的应用共享浏览器存储来源；本项目保留既有存储键以兼容数据，源码或路径改名不构成自动迁移机制。重要内容仍需导出备份。

## 部署验证

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
