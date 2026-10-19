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

部署后检查 Actions 成功、实际 Pages 地址可访问、两个入口及脚本 / 样式正常加载，并用虚构数据验证编辑、刷新保存及 JSON 回导。线上不应显示本机 AI 接入。部署流水线和模型测试不能替代这些页面操作；本次实际结果由执行发布的任务补记。
