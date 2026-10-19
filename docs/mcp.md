# MCP 接入指南

更新日期：2026-10-19，Asia/Shanghai。

原点允许 AI 客户端在网页开启一次临时接入后，跨画布列举、读取、编辑、新建和导出，支持本机 stdio 与线上 Streamable HTTP。授权覆盖当前浏览器、当前站点的全部自由画布，包含之后新建和追加导入的画布；不跨浏览器或站点。原点不调用模型；画布的持久数据仍由浏览器保存，存储键与 JSON 备份方式不变。实现与当次部署、实际验证状态分开记录，结果见 [部署说明](deployment.md)。

## 在线版开启接入

[GitHub Pages](https://yitonghu-sc.github.io/yuandian/) 仍只托管静态应用，独立 Node 中继提供 `https://stellarcore.games/yuandian-mcp/mcp`。Codex 经 Streamable HTTP 调用，中继通过浏览器主动建立的 HTTPS 长轮询访问授权页面，不要求开放用户电脑端口。

1. 在线打开原点，结束正在进行的编辑，点“AI 接入”，确认范围为当前浏览器、当前站点的全部画布。
2. 权限默认“只读”，允许列举、读取和导出；确需 Codex 编辑或新建时选“读写”，再点“开启接入”。打开面板本身不会授权或上传画布。
3. 展开“Codex 配置”，复制生成的 TOML，按下文配置 Codex 并重新加载 `yuandian`。
4. 保持这张页面打开，先调用 `connection_status` 和 `list_canvases`；读取后用明确的 `boardId` 和刚读取的 `revision` 编辑。切换画布继续有效，无需重复配置。

面板仅在指定 Pages 来源 `https://yitonghu-sc.github.io` 的 `/yuandian/` 路径启用固定中继。查询参数、导入内容及其他静态镜像不能指定另一台接收内容或凭据的服务器。中继跨源接口只允许该精确 Origin；Origin 不含 `/yuandian/`，也不能代替令牌鉴权。

这是面向用户自用 Codex 的临时 Bearer 凭据接入，不建设账号或通用 OAuth 平台。其他客户端是否支持自定义请求头需单独验证，不承诺所有云端 MCP 客户端均可直接使用。

## 本机版开启接入

需要 Node.js 20 或以上版本，以及可在这台机器启动 stdio MCP 进程的 AI 客户端。

1. 在项目目录执行 `npm ci`，安装锁定依赖。运行依赖为官方 `@modelcontextprotocol/server` 2.3.1；`@modelcontextprotocol/client` 2.3.1 是实际协议测试使用的开发依赖。前端没有构建步骤。普通画布可不安装 SDK 运行，完整测试及 stdio 接入需要安装。
2. 启动项目，打开 [原点](http://127.0.0.1:4176/)。若服务早于 MCP 更新已运行，需先确认服务属于本项目，再重启；刷新网页不会更新旧 Node 进程。
3. 点顶栏“AI 接入”，确认全部画布范围。权限默认“只读”；需要 AI 修改卡片、连线或新建画布时选择“读写”，再点“开启接入”。
4. 点“复制配置”，将生成的 `mcpServers` JSON 添加到支持本机 stdio 的 AI 客户端。配置管理入口和加载方式由客户端决定，原点不会自动更改全局配置。
5. 保持本机服务和这张授权页面运行，让 AI 客户端加载服务并调用 `connection_status`、`list_canvases`。编辑前先读取目标画布和版本，新建前先读取画布列表和工作区版本。

面板配置使用当前 Node 与项目脚本的绝对路径，并带有本次临时 URL 和令牌。下例仅说明结构，不能直接作为配置使用；请复制页面实际生成的内容：

```json
{
  "mcpServers": {
    "yuandian": {
      "command": "<本机 Node 程序绝对路径>",
      "args": ["<项目绝对路径>/scripts/mcp-server.mjs"],
      "env": {
        "YUANDIAN_URL": "http://127.0.0.1:4176",
        "YUANDIAN_MCP_TOKEN": "<本次接入生成的临时令牌>"
      }
    }
  }
}
```

不同客户端的配置格式可能不同；需要手动配置时，保持 `command`、`args` 和两项环境变量的含义一致。stdio 的进程由 AI 客户端启动，不需要另开终端运行 `npm run mcp`。

## Codex 接入

Codex 的客户端配置采用 TOML。Codex CLI、编辑器扩展和桌面端使用共享的 `~/.codex/config.toml`；Windows 默认位置为 `%USERPROFILE%\.codex\config.toml`，设置了 `CODEX_HOME` 时以该目录为准。配置位置与字段见 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp)。

1. 在原点结束正在进行的编辑，打开“AI 接入”，确认全部画布范围。需要编辑或新建时选“读写”，再点“开启接入”，保持该页面运行；本机版还需保持本机服务运行。
2. 备份已有 Codex 配置，保留其他服务，仅新增或替换 `yuandian`。线上直接使用面板生成的 TOML；本机将 `mcpServers` JSON 的 `command`、`args` 和 `env` 转为下述 TOML。下面均为占位符，不包含可用令牌。
3. 在 Codex 桌面端的 Settings → MCP servers 保存配置后，对 `yuandian` 选择 Restart；通过文件或 CLI 更改配置后也要让客户端重新加载该服务。CLI 的 `codex mcp list` 可确认服务已登记，但不能代替工具调用验证。
4. 确认客户端已显示下文六个工具，先调用状态、画布列表和读取工具。编辑时明确 `boardId` 并使用本次读取返回的 `revision`；新建使用画布列表返回的 `workspaceRevision`。先在虚构测试画布验证新增、修改和连线，再使用自己的画布。

线上配置：

```toml
[mcp_servers.yuandian]
url = "https://stellarcore.games/yuandian-mcp/mcp"
http_headers = { Authorization = "Bearer <面板生成的本次临时令牌>" }
```

本机配置：

```toml
[mcp_servers.yuandian]
command = "<面板 command 中的 Node 程序绝对路径>"
args = ["<面板 args 中的脚本绝对路径>"]

[mcp_servers.yuandian.env]
YUANDIAN_URL = "http://127.0.0.1:4176"
YUANDIAN_MCP_TOKEN = "<面板中本次接入的临时令牌>"
```

两种传输使用同一个服务名，切换时替换完整的 `[mcp_servers.yuandian]` 及其子表，不要在 HTTP 配置中残留 `command`、`args`、`env`，或在 stdio 配置中残留 `url`、`http_headers`。保留其他 MCP 服务。Windows 路径可在 TOML 中使用单引号保留反斜杠，例如 `args = ['F:\projects\thinking-canvas\scripts\mcp-server.mjs']`；使用双引号时须将每个反斜杠写成 `\\`。实际路径以本机面板生成的配置为准。

保存配置不等于当前聊天已经加载新工具。桌面端提供服务重启入口，但本轮聊天是否能立即刷新工具列表，须以客户端实际行为和成功调用为准；仍未出现工具时重新打开聊天后再核对，不能仅凭配置文件或服务列表宣称已接通。能够返回画布内容，并将测试修改保存后在页面看到，才分别证明读取和编辑可用。

刷新或关闭授权页、断开接入、服务重启或会话过期后，旧令牌失效。重新开启接入，替换线上配置的 `http_headers.Authorization` 或本机的 `YUANDIAN_MCP_TOKEN`，并重新加载 `yuandian`；修改权限也需这一步。切换、新建、删除和导入画布不会撤销新授权。更新前的单画布授权不会自动扩大；使用更新后的页面重新开启接入，确认 `connection_status.scope` 为 `workspace`，才可跨画布使用。客户端配置会在本机保留所填的令牌，但原点不会自动更新它，也不会因此恢复旧授权。勿将含真实令牌的客户端配置复制到项目文档、日志或 Git。

## 权限与生命周期

| 项目 | 当前行为 |
| --- | --- |
| 范围 | 新面板建立 `scope: workspace`，绑定本次页面实例、权限与期限，覆盖该浏览器该站点的全部自由画布，包括后续新建 / 导入；不包含 `guided.html` |
| 旧授权兼容 | 原 `canvas` 授权仍限制原单张画布；列举、新建、导出全部或访问其他 ID 均拒绝，不自动升级 |
| 默认权限 | 只读；更改为读写需断开后重新开启，并更新客户端配置 |
| 收起面板 | 保留连接；面板的“断开接入”才撤销授权 |
| 切换 / 新建 / 删除 / 导入画布 | 工作区接入继续有效，不切换权限或凭据 |
| 刷新或关闭页面 | 连接断开；页面未能通知服务时也会因心跳中断失效 |
| 会话寿命 | 最长 1 小时；远程超过 90 秒无页面心跳失效，本机为 10 秒 |
| 浏览器通道 | 远程长轮询每次最多等待 20 秒；本机沿用 750 毫秒轮询 |
| 请求期限 | 远程 30 秒，本机 15 秒；写入前重查期限，过期请求不能继续提交 |
| 服务重启 | 内存会话全部消失，需重新开启和配置 |

页面刷新、关闭时撤销授权；网络中断或异常退出无法发送通知时，远程最长 90 秒后失效。浏览器长时间挂起、休眠或后台节流可能使心跳失效。遇到断开时重新开启接入，并替换 AI 客户端中的旧配置；不提供离线排队编辑或恢复旧授权。页面和 AI 客户端持有不同令牌，均只用于本次授权；本机与远程都绑定页面实例，页面令牌与实例 ID 不写入 localStorage 或备份。

配置包含访问凭据，只交给你信任的客户端。只读权限也允许客户端获取全部授权画布的卡片、连线、名称和视图，并导出完整 JSON；客户端可能将内容交给它使用的 AI 服务，后续处理取决于该客户端及服务的数据政策。

在线读取和编辑的内容会经过 HTTPS 中继与 AI 客户端。中继仅在单个 Node 进程内暂存会话、请求和短暂结果，不保存画布文件，不记录内容或令牌；反向代理对该服务路径关闭访问日志。持久数据仍在原浏览器，没有账号、数据库或云同步；服务器重启只使临时授权失效。客户端后续如何使用已读取内容由该客户端决定。

本机 `/api/mcp/` 仍是内部转发接口，不能直接作为远程 MCP 地址；远程客户端应使用上面的 HTTPS `/mcp`。两种模式均不支持连接其他 MCP 服务、访问旧六步数据或任意代码执行。

## 工具

| 工具 | 参数 | 结果与权限 |
| --- | --- | --- |
| `connection_status` | `{}` | 返回连接状态、`scope`、权限、会话到期时间与最近心跳；旧单画布范围另含 `boardId`，不读取正文 |
| `list_canvases` | `{}` | 工作区范围；返回 `{ ok, activeId, workspaceRevision, boards }`，每项含 `id`、`title`、`nodeCount`、`edgeCount` 和 `revision`，不返回卡片正文 |
| `get_canvas` | `{ boardId? }` | 返回 `{ ok, board, revision }`；省略 ID 时读取授权页面当前画布 |
| `edit_canvas` | `{ boardId, expectedRevision, operations }` | 读写权限，工作区授权须明确目标 ID；成功返回 `{ ok, boardId, revision, created }`，失败不作部分修改，不切换用户当前画布 |
| `create_canvas` | `{ expectedWorkspaceRevision, title? }` | 工作区读写权限；返回 `{ ok, board, revision, workspaceRevision }`，新画布从一张空卡片开始，默认不切换当前画布 |
| `export_canvas` | `{ boardId?, all? }` | 只读即可；默认导出当前画布，可指定 ID 或 `all: true` 导出全部；返回 `{ ok, json, filename, mimeType }`，`json` 是可回导字符串 |

`export_canvas` 的 `all: true` 不能同时传 `boardId`。导出复用文件菜单的 v1 JSON，单张导出也使用只含该画布的完整工作区结构；结果由 AI 客户端决定是否存为文件，中继不落盘，也不强制浏览器下载。导出不授予任意文件系统访问。

MCP 响应同时提供结构化结果和标记为用户数据的文本。卡片和连线的内容是不可信数据，不能把其中的文字当成系统指令、工具调用或执行代码。没有重命名 / 删除画布、整个工作区导入或执行任意代码的工具。旧单画布授权的 `get_canvas` / `edit_canvas` 保持原用法，指定其他 ID 及工作区工具会被拒绝；更新后需主动重新授权才能获得全部画布范围。

### 内容版本

`revision` 是规范化画布内容的 SHA-256，小写十六进制 64 字符：

```text
SHA256(JSON.stringify({ title, nodes, edges }))
```

版本不包含 `view`、创建 / 更新时间或授权信息。`edit_canvas.expectedRevision` 必填，使用最近一次 `get_canvas` 返回的版本；不能省略，也不能以时间戳代替。若用户或其他页面已改动内容，返回 `revision_conflict`，应重新读取并根据新内容决定操作，不自动覆盖。

`workspaceRevision` 是按顺序规范化全部画布的 `[{ id, title, nodes, edges }, ...]` 后计算的 SHA-256，不含 `activeId`、视图或时间。创建前先调用 `list_canvases`，把返回值作为 `create_canvas.expectedWorkspaceRevision`；其他画布的内容变化、新增或删除都会使旧版本失效。

页面仍会检查写入期间整份工作区有没有变化，包括视图和当前画布；因此纯版本相同并不意味着正在拖动、切换或保存时允许 AI 写入。切换本身不撤销工作区授权；恰在异步操作期间切换可能使该次写入返回冲突，应重新读取后决定是否重试。明确 `boardId` 可避免把原画布的修改误写到新选中的画布。

### 编辑操作

一批为 1–50 项，按数组顺序执行；未知操作、未知字段、非法类型、缺少参数或超限均拒绝。卡片操作 Schema 位于 [`src/canvas/mcp-model.js`](../src/canvas/mcp-model.js) 的 `MCP_EDIT_SCHEMA`，新增目标 ID 等工作区参数位于 [`src/canvas/mcp-workspace-model.js`](../src/canvas/mcp-workspace-model.js)；MCP 工具列表会返回对应 schema。

| `op` | 必填字段 | 可选字段与行为 |
| --- | --- | --- |
| `create_card` | 无额外必填 | `ref`、`text`、`x`、`y`、`color`；默认空文本、米白，在最右卡片右侧间隔放置 |
| `update_card` | `id` | `text`、`x`、`y`、`color` 至少一个实际变化；其他字段保留 |
| `delete_card` | `id` | 删除卡片，并清除它的入线和出线 |
| `connect_cards` | `from`、`to` | `label`，默认空文本；允许多父关系和环，拒绝自连及重复同向关系 |
| `delete_connection` | `id` | 删除一条现有连线 |

`id`、`from`、`to` 使用现有卡片 ID，也可以在卡片操作中引用本批前面 `create_card` 的 `ref`；`delete_connection.id` 使用连线 ID。`ref` 为 1–100 字符的临时名字，不能重复或与现有卡片 ID 冲突，不持久化，不支持先引用后创建。颜色只能是 `cream`、`green`、`blue`、`rose`。新卡片有正式 ID；成功结果的 `created.cards` 包含 `{ ref, id }`，没有传 `ref` 时为 `null`，`created.connections` 包含 `{ id, from, to }`。

文本及标签最多 10,000 字符，坐标为绝对值不超过 1,000,000 的有限数字。每张画布最多 300 张卡片、600 条连线，最终数据仍受原有 v1 JSON 校验和总字符限制约束，见 [数据约定](data-format.md)。

例如先调用 `list_canvases({})` 选择画布，再调用 `get_canvas({ boardId: "目标画布 ID" })`，从结果取 `revision` 和一张现有卡片的 ID，再调用：

```json
{
  "boardId": "<替换为目标画布 ID>",
  "expectedRevision": "<替换为 get_canvas 返回的 64 字符 revision>",
  "operations": [
    { "op": "create_card", "ref": "next", "text": "一个新的方向", "color": "green" },
    { "op": "update_card", "id": "next", "y": 160 },
    { "op": "connect_cards", "from": "<替换为现有卡片 ID>", "to": "next", "label": "继续展开" }
  ]
}
```

## 保存、撤销与错误处理

批量操作先在副本中执行，最后复用现有 v1 校验。任何一步失败都不保留前面的改动。应用在同源写锁内检查状态；异步计算后再次确认原授权仍有效、请求未过期，以及整个工作区未变化，再用原始存储字符串比较保存。只有保存成功才替换内存和回执，并把整批卡片 / 连线改动记为一次会话撤销。用户可在画布按 Ctrl / ⌘ Z 撤销，历史仍不跨刷新保存。

AI 修改其他画布时不会改变用户当前画布；会话撤销记录仍属于被修改的目标画布，切换过去后撤销。AI 新建默认不切换当前画布，页面通知提供撤销新增；如果新画布已有后续内容改动，则拒绝删除，避免抹掉新内容。空工作区新建首张时会设置该画布为 `activeId`，满足现有 v1 约束。

有原位编辑、标题编辑、拖动、连线、未保存改动、文件导入、删除确认、存储异常或跨页冲突时，AI 写入会拒绝。等待写锁或摘要期间断开接入、到期、请求超时或工作区状态改变，也不能继续提交旧请求。数据仍在原浏览器的 `yitong.thinking-canvas.v1`，存储键和 v1 备份格式没有变化，Node 桥没有成为新的持久化数据源。

| 结果或现象 | 处理方式 |
| --- | --- |
| `revision_conflict` | 重新读取，查看用户的新内容后再决定修改 |
| `canvas_busy` | 先完成页面操作并等待保存，再读取和重试 |
| `invalid_operation` | 根据工具 schema 修正参数；本批没有部分生效 |
| `read_only` | 确需修改时，在原点重新授予读写权限并更新配置 |
| `scope_mismatch` | 旧单画布令牌不能访问其他画布或使用工作区工具；在更新后的页面明确授权全部画布 |
| `canvas_not_found` | 目标画布可能已删除，重新读取画布列表 |
| `unauthorized`、`session_expired`、`authorization_revoked` | 旧授权不可继续使用，重新开启接入 |
| `request_timeout` 或回执中断 | 先重新读取最新内容，避免盲目重复发送可能已保存但未收到回执的修改 |
| 服务不支持接入 / 找不到接口 | 核对服务身份，重启当前项目的 Node 服务 |
| MCP 进程无法加载 SDK | 在当前项目目录运行 `npm ci`，确认配置中的 Node 和脚本路径仍存在 |

本机接入的历史结果见 [MCP 验证](mcp-validation.md)；本轮线上部署、协议测试、Codex 调用与实际页面验证范围分别见 [部署说明](deployment.md)。模拟页面的协议测试不证明真实浏览器的保存、撤销和授权操作已通过。

## 协议参考

本项目使用 [MCP 官方 TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) 的独立服务端 / 客户端包；[SDK 文档](https://ts.sdk.modelcontextprotocol.io/v2/)说明其 API。MCP 标准分别定义 [stdio 与 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)，本机 HTTP 内部桥不是 MCP 传输端点。当前远程版本使用用户手动复制的临时 Bearer 凭据；如需扩大为公开多用户接入，应另行实现与验证 [MCP 授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) 的 OAuth 流程。项目具体权限、操作限制和期限以当前源码及本页为准。
