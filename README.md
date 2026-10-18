# 原点 · 自由思考画布

自由书写、摆放、展开和连接想法的本机网页工具。当前以“顺畅用起来”为目标，由实际使用反馈推动小步迭代。

项目根目录：`F:\projects\thinking-canvas`。独立维护从 2026-10-18 开始。

## 先读什么

- [PROJECT.md](PROJECT.md)：产品目标、形成过程、用户已确认方向、功能现状、限制与下一步。
- [AGENTS.md](AGENTS.md)：Codex 协作约定、改动边界与验证要求。
- [CANVAS-VALIDATION.md](CANVAS-VALIDATION.md)：自由画布的已有验证；[VALIDATION.md](VALIDATION.md) 是旧版六步工具的历史记录。
- [CHANGELOG.md](CHANGELOG.md)：版本与项目迁出记录。
- [INITIALIZATION.md](INITIALIZATION.md)：独立目录、服务迁出、验证和 Codex 接入记录。

## 启动

双击 `Start.cmd`，或运行：

```powershell
.\start.ps1
```

固定入口：[http://127.0.0.1:4176/](http://127.0.0.1:4176/)。仅启动服务、不打开系统浏览器：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -NoBrowser
```

脚本优先使用本机 Codex 自带的 Python，再查找 `python` 命令。服务仅绑定 `127.0.0.1`；关闭网页不会停止服务，重复启动会核对项目标记并复用。端口被其他服务占用时会报错，不结束其他进程。不要直接双击 `index.html`，JavaScript 模块需要通过 HTTP 加载。

## 在 Codex 中使用

在 Codex 的项目入口添加本地文件夹 `F:\projects\thinking-canvas`，作为独立项目。后续聊天在这个项目中开始，让 Codex 先读 `AGENTS.md` 和 `PROJECT.md`。

独立目录与 Git 仓库已经初始化；Codex 侧的项目添加由桌面应用完成。不要为了登记项目而修改 Codex 的内部状态文件。

## 基本操作

- 双击卡片原位编辑，Enter 换行，点击空白结束编辑；双击空白或点“＋想法”新增。
- 选中卡片按 Tab、点“＋分支”或卡片旁的“＋”，创建相连的想法。
- 拖动卡片重新组合；拖空白平移画布。颜色的含义由你决定。
- 点“连线”后选择起点和终点；已有选中卡片时只需再点目标。Esc 取消。选中线条可以删除连接。
- 右下角缩放或 Ctrl / ⌘ + 滚轮；“适配全部”找回画布。
- Ctrl / ⌘ Z 撤销，Ctrl / ⌘ Shift Z 重做。历史限本次页面会话，平移和缩放不进入节点编辑撤销。
- 顶部“＋新画布”记录其他问题；“文件”导入导出 JSON。导入追加新画布，不覆盖已有内容。

## 数据与兼容

内容保存在当前浏览器的站点存储，不写入源码目录。维持同一浏览器、配置及 `http://127.0.0.1:4176/`，这次源码独立不会更换数据空间。换浏览器、换机器或清理站点数据前，请从“文件”导出备份。

自由画布的存储键为 `yitong.thinking-canvas.v1`；[旧版六步入口](http://127.0.0.1:4176/guided.html)及 `yitong.first-principles.workspace.v1` 保留。两版 JSON 格式独立，不自动互转。浏览器自动保存不等于文件备份；个人导出文件可放在忽略目录 `backups/` 或 `private/`，它们不随源码提交。

## 开发与验证

纯 HTML、CSS、原生 JavaScript ES Modules，无构建步骤、前端依赖或后端账号服务。

```powershell
npm test
```

也可直接运行：

```powershell
node --test canvas-model.test.mjs model.test.mjs logic.test.mjs
node --check canvas.js
```

界面改动后实际验证编辑、分支、拖动、连线、撤销、刷新保存和 JSON 回导，检查保存状态。当前 44 项模型与逻辑检查包含自由画布 14 项和旧版 30 项。

## 文件地图

| 文件 | 用途 |
| --- | --- |
| `index.html`、`canvas.js`、`canvas.css` | 自由画布入口、交互和视觉 |
| `canvas-model.js`、`canvas-model.test.mjs` | 自由图数据、存储、备份校验及测试 |
| `guided.html`、`app.js`、`styles.css`、`model.js`、`logic.js` | 旧版兼容入口与实现，继续保持独立 |
| `Start.cmd`、`start.ps1` | 本机服务启动与复用 |
| `*-preview.png`、`preview.png` | 不含个人分析的历史操作示例 |

源码来源：`yitong-ai/tools/first-principles`，源提交 `429da6f240789a2bbf136cedab00902218848328`。原目录保留迁出时快照；此后以本项目为唯一开发源。新仓库仅在本机初始化，尚未配置 GitHub 或 Gitea 远端。
