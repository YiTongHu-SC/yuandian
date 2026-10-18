# 架构与目录

这是一个本机运行的静态网页原型。浏览器直接加载 ES Modules，Node.js 仅用于开发服务与检查，不参与用户数据处理。产品方向以 [PROJECT.md](../PROJECT.md) 为准。

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
│  └─ tooling/                开发服务与项目检查测试
├─ scripts/                   本机服务和静态检查工具
├─ docs/                      架构、开发、数据约定
│  └─ history/                初始化及历史验证记录
├─ Start.cmd / start.ps1       Windows 启动入口
├─ package.json               Node 运行要求和统一命令
└─ README / PROJECT / AGENTS / CHANGELOG
```

`private/`、`backups/` 是可选的个人文件位置，已从 Git 忽略，也不属于应用资源。

## 自由画布

| 模块 | 职责 |
| --- | --- |
| `src/canvas/app.js` | DOM 渲染、输入和拖动事件、当前选择、对话框、保存状态与跨页协调 |
| `src/canvas/model.js` | 工作区 / 画布 / 节点 / 连线数据，校验、追加导入、JSON 导出和存储保护 |
| `src/canvas/history.js` | 按画布隔离的会话撤销与重做记录 |
| `src/canvas/geometry.js` | 视图坐标换算、坐标限幅与连接曲线等纯计算 |
| `src/canvas/styles.css` | 自由画布布局、卡片和交互视觉 |

应用入口调用模型处理数据，再将用户内容作为文本显示。纯模块不依赖 DOM、网络或旧六步工具。会话历史与选择不写入数据格式；视图位置保存在画布数据中，但不进入节点编辑撤销。

## 旧六步工具

`src/guided/app.js` 负责旧界面和保存协调，`model.js` 负责旧格式及导入导出，`logic.js` 负责计算、删除解除关联及变更检测，`styles.css` 保留旧视觉。该入口使用自己的存储键与 schema，不读取自由画布数据，也不作为新版交互的扩展基础。

## 开发工具

`scripts/dev-server.mjs` 提供仅监听 `127.0.0.1` 的静态服务，公开两个 HTML 入口、`src/` 和 `assets/`，并提供供启动脚本核对目录的身份信息。Git 元数据、项目文档、测试和个人备份不作为静态资源公开。

`scripts/check.mjs` 汇总项目语法与静态引用检查。测试使用 Node 内置测试运行器，不依赖打包器或第三方测试框架。启动、测试和界面检查方式见 [开发与验证](development.md)。
