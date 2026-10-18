# 原点 · 自由思考画布

把想法写成卡片，自由摆放、展开分支和建立连接的本机网页工具。内容自动保存在当前浏览器，也可导出 JSON 备份。

原生 HTML、CSS 和 JavaScript ES Modules，无构建步骤，无需安装前端依赖。

## 启动

需要 Node.js 20 或以上版本。Windows 双击 `Start.cmd`，或在项目目录运行：

```powershell
.\start.ps1
```

固定入口：[http://127.0.0.1:4176/](http://127.0.0.1:4176/)。仅启动服务、不打开浏览器：

```powershell
.\start.ps1 -NoBrowser
```

开发时也可在终端前台运行服务，按 Ctrl+C 停止：

```powershell
npm start
```

服务只监听 `127.0.0.1`。Windows 启动脚本在后台运行服务，关闭网页后服务仍在；重复启动会核对当前项目目录并复用。端口被无关服务占用时会报错，不会结束其他进程。不要直接双击 `index.html`，浏览器需要通过 HTTP 加载 JavaScript 模块。

## 基本操作

- 双击卡片原位编辑，Enter 换行，点击空白结束编辑；双击空白或点“＋想法”新增。
- 选中卡片按 Tab、点“＋分支”或卡片旁的“＋”，创建相连的想法。
- 拖动卡片重新组合；拖空白平移画布。颜色的含义由你决定。
- 点“连线”后选择起点和终点；已有选中卡片时再点目标即可。Esc 取消。选中线条可以删除连接。
- 右下角缩放或 Ctrl / ⌘ + 滚轮；“适配全部”找回画布。
- Ctrl / ⌘ Z 撤销，Ctrl / ⌘ Shift Z 重做；撤销历史限本次页面会话。
- 顶部“＋新画布”记录其他问题；“文件”导入导出 JSON。导入追加新画布，保留已有内容。

## 保存与备份

固定使用同一浏览器、配置及 `http://127.0.0.1:4176/`，才能继续访问原来的站点存储。换浏览器、换机器或清理站点数据前，请从“文件”导出 JSON。浏览器自动保存不等于文件备份。

[旧版六步工具](http://127.0.0.1:4176/guided.html)继续保留，数据与自由画布分开；两版 JSON 不自动互转。存储键、格式和恢复机制见 [数据约定](docs/data-format.md)。个人备份可放 `backups/` 或 `private/`，这些目录已从 Git 忽略。

## 开发与文档

```powershell
npm test
npm run check
```

- [PROJECT.md](PROJECT.md)：已确认的产品方向、现有能力与边界。
- [AGENTS.md](AGENTS.md)：项目协作、隐私与交付约定。
- [架构与目录](docs/architecture.md)：入口、源码职责和依赖关系。
- [开发与验证](docs/development.md)：运行命令、检查方式和界面验证路径。
- [数据约定](docs/data-format.md)：存储、JSON 导入导出和兼容要求。
- [本次整理验证](docs/validation.md)：自动检查、界面实测范围与剩余限制。
- [CHANGELOG.md](CHANGELOG.md)：变更记录；[历史验证与初始化](docs/history/INITIALIZATION.md)保留迁出时证据。

在 Codex 中将 `F:\projects\thinking-canvas` 添加为本地项目。项目独立维护；源码来源与 Git 边界见 [PROJECT.md](PROJECT.md)。
