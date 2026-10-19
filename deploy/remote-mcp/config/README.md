# 服务器连接与配置

本目录集中放置原点远程 MCP 的连接资料与运行参数。Git 默认忽略目录中的所有内容，仅允许本说明和以下四个脱敏示例进入仓库；示例里的占位符不是真实密码、私钥或已核验的 SSH 连接。

| 可提交的示例 | 本机填写的文件 | 用途 |
| --- | --- | --- |
| [ssh_config.example](ssh_config.example) | `ssh_config.local` | SSH 主机、用户、端口与私钥路径 |
| [server.example.json](server.example.json) | `server.local.json` | 部署目录、服务名称与核验信息记录 |
| [runtime.env.example](runtime.env.example) | `runtime.local.env` | MCP 后端现有环境变量 |
| [credentials.env.example](credentials.env.example) | `credentials.local.env` | 可选的密码、私钥口令示例，按需填写 |

真实私钥放在 `keys/`，已核验的 SSH 主机公钥记录放在 `known_hosts.local`，配置备份放在 `backups/`；这些路径及任意其他新增文件均被忽略。现有 `private/remote-deployment/` 历史资料可继续保留，不需要搬移或覆盖。

## 本机准备

在仓库根目录执行；只创建不存在的本机文件，保留已经填写的配置：

```powershell
$serverConfigDirectory = Join-Path (Get-Location) 'deploy/remote-mcp/config'
foreach ($serverConfigPair in @(
    @('ssh_config.example', 'ssh_config.local'),
    @('server.example.json', 'server.local.json'),
    @('runtime.env.example', 'runtime.local.env'),
    @('credentials.env.example', 'credentials.local.env')
)) {
    $serverConfigTarget = Join-Path $serverConfigDirectory $serverConfigPair[1]
    if (-not (Test-Path -LiteralPath $serverConfigTarget)) {
        Copy-Item -LiteralPath (Join-Path $serverConfigDirectory $serverConfigPair[0]) -Destination $serverConfigTarget
    }
}
New-Item -ItemType Directory -Path (Join-Path $serverConfigDirectory 'keys') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $serverConfigDirectory 'backups') -Force | Out-Null
```

编辑 `ssh_config.local` 中的主机、用户和端口，并放入本任务专用的既有 SSH 私钥，或将 `IdentityFile` 改为已有密钥的路径。不要复用不相关服务的密钥。相对路径以执行 SSH 命令时的仓库根目录为基准。

连接前，通过服务器控制台或既有受信资料核对主机公钥指纹，将对应的公钥记录保存到 `known_hosts.local`。示例保留 `StrictHostKeyChecking yes`，不会自动接受未知主机；`ssh-keyscan` 单独取得的公钥不能代替可信指纹核验。没有真实连接资料时，只创建模板，不能据此宣称服务器可登录。

在仓库根目录连接：

```powershell
ssh -F deploy/remote-mcp/config/ssh_config.local yuandian-server
```

`server.local.json` 是部署信息记录；应用不会自动读取它。`runtime.local.env` 也不会自动覆盖当前 systemd 服务，实际部署仍按 [部署说明](../../../docs/deployment.md) 保留现有配置并核验后再应用。`credentials.local.env` 仅为可选的本机记录，SSH 不会自动读取；密码和私钥口令可在 SSH 提示时输入，无须写入文件。

## 提交与公开范围

- 只在 `*.local` / `*.local.env` 对应的本机文件中填写真实信息，不改写可提交的示例。不要使用 `git add -f` 强制加入配置或密钥。
- 根目录 `.gitignore` 还忽略常见私钥文件名和密钥容器。忽略不等于加密，也不会清除已经被 Git 跟踪的秘密；若曾误提交，需先撤销相关凭据并处理历史，不能只补一条忽略规则。
- 这些配置不属于前端资源，本机静态服务拒绝访问 `deploy/`，Pages 白名单构建不包含它们。部署包只取文档列出的后端运行文件，不上传本目录、密码或私钥。
- 提交前检查 `git status --short`、`git diff --cached`，并用 `git check-ignore -v deploy/remote-mcp/config/credentials.local.env` 确认实际文件仍被忽略。
