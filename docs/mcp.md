# MCP 接入指南

更新日期：2026-10-19，Asia/Shanghai。

原点允许 AI 客户端经临时授权跨画布列举、读取、编辑、新建和导出，支持本机 stdio 与线上 Streamable HTTP。线上将固定配对身份与每次临时授权分开：配置只保存一次，刷新或到期后只在网页重新授权。本机 stdio 保持临时凭据流程。授权覆盖当前浏览器、当前站点的全部自由画布，包含之后新建和追加导入的画布；不跨浏览器或站点。原点不调用模型；画布的持久数据仍由浏览器保存，存储键与 JSON 备份方式不变。实际部署与验证状态见 [部署说明](deployment.md)。

## 在线版开启接入

[GitHub Pages](https://yitonghu-sc.github.io/yuandian/) 仍只托管静态应用，独立 Node 中继提供 `https://stellarcore.games/yuandian-mcp/mcp`。Codex 经 Streamable HTTP 调用，中继通过浏览器主动建立的 HTTPS 长轮询访问授权页面，不要求开放用户电脑端口。

1. 在线打开原点，结束正在进行的编辑，点“AI 接入”，建立一次配对。首次使用复制固定 TOML，按下文配置 Codex 并首次加载 `yuandian`；已有当前线上配置时，可在配对选项中粘贴，复用原客户端凭据。粘贴内容只接受本服务的固定地址及凭据，不写其他客户端配置。
2. 确认授权范围为当前浏览器、当前站点的全部画布。默认“只读”，允许列举、读取和导出；确需 Codex 编辑或新建时明确选择“读写”。授权时长可选“15分钟”“1小时”“永久（直到断开）”，默认“1小时”。永久仅让当前页面授权不按时长到期，仍会因刷新、关闭、主动断开、异常失联或服务重启而撤销。
3. 在网页授权，保持这张页面打开。先调用 `connection_status` 和 `list_canvases`；读取后用明确的 `boardId` 和刚读取的 `revision` 编辑。切换画布继续有效。
4. 刷新、关闭后重开、到期、主动断开或中继重启时，Codex 配对继续保留，状态为未授权（`needs_authorization` 或到期时的 `expired`），内容工具返回 `needs_authorization`。在网页重新授权后继续使用，无需更换配置或重新连接 Codex，每次重新授权均恢复默认只读。

打开面板、记住配对或服务启动本身不会授权或上传画布。配对不是永久画布访问。另一标签页不能静默接管；需明确选择改由当前页授权，原页与其在途请求随即失效。主动取消配对后，固定客户端凭据也会失效；清理浏览器设备密钥或更换浏览器后须重新配对，JSON 备份不迁移配对关系。

跨页接管与取消配对需要浏览器支持 Web Locks，操作会先通知旧页撤销授权，并等待已开始的页面操作离开授权锁。缺少该能力时面板明确拒绝这两项操作，可先在原页断开后在另一页重新授权；取消配对需使用支持该能力的浏览器。页面从往返缓存恢复时重建身份，不自动恢复授权。

面板仅在指定 Pages 来源 `https://yitonghu-sc.github.io` 的 `/yuandian/` 路径启用固定中继。查询参数、导入内容及其他静态镜像不能指定另一台接收内容或凭据的服务器。中继跨源接口只允许该精确 Origin；Origin 不含 `/yuandian/`，也不能代替令牌鉴权。

这是面向用户自用 Codex 的固定 Bearer 配对凭据接入，浏览器另用设备密钥签名证明配对归属；不建设账号或通用 OAuth 平台。有效配对且没有临时授权时，MCP 初始化与工具发现仍可用，内容工具拒绝访问；错误或已撤销的配对凭据在 HTTP 层返回 401。其他客户端是否支持自定义请求头需单独验证，不承诺所有云端 MCP 客户端均可直接使用。

## 本机版开启接入

需要 Node.js 20 或以上版本，以及可在这台机器启动 stdio MCP 进程的 AI 客户端。

1. 在项目目录执行 `npm ci`，安装锁定依赖。运行依赖为官方 `@modelcontextprotocol/server` 2.3.1；`@modelcontextprotocol/client` 2.3.1 是实际协议测试使用的开发依赖。前端没有构建步骤。普通画布可不安装 SDK 运行，完整测试及 stdio 接入需要安装。
2. 启动项目，打开 [原点](http://127.0.0.1:4176/)。若服务早于 MCP 更新已运行，需先确认服务属于本项目，再重启；刷新网页不会更新旧 Node 进程。
3. 点顶栏“AI 接入”，确认全部画布范围。权限默认“只读”；需要 AI 修改卡片、连线或新建画布时选择“读写”。时长可选“15分钟”“1小时”“永久（直到断开）”，默认“1小时”，再点“开启接入”。永久仍受页面刷新、关闭、主动断开、异常失联和服务重启的撤销规则约束。
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

1. 线上先建立配对；本机则开启临时接入。备份已有 Codex 配置，保留其他服务，仅新增或替换 `yuandian`。线上直接使用面板生成的固定 TOML；本机将 `mcpServers` JSON 的 `command`、`args` 和 `env` 转为下述 TOML。下面均为占位符，不包含可用凭据。
2. 初次登记服务后，让客户端加载 `yuandian`。桌面端不同版本的入口可能不同，以实际提供的服务开关或重新加载操作为准；不要求寻找不存在的 Restart 按钮。CLI 的 `codex mcp list` 可确认服务已登记，但不能代替工具调用验证。已有线上凭据在配对时复用成功，则不改配置。
3. 确认客户端已显示下文六个工具，先调用状态。线上未授权时返回 `needs_authorization`，此时在网页确认全部画布范围并授权，无需重载客户端；本机还需保持本机服务和临时授权运行。
4. 读取画布列表和目标画布。编辑时明确 `boardId` 并使用本次读取返回的 `revision`；新建使用画布列表返回的 `workspaceRevision`。先在虚构测试画布验证新增、修改和连线，再使用自己的画布。

线上配置：

```toml
[mcp_servers.yuandian]
url = "https://stellarcore.games/yuandian-mcp/mcp"
http_headers = { Authorization = "Bearer <首次配对生成的固定客户端凭据>" }
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

首次保存配置不等于当前聊天已经加载新工具。是否能立即更新工具列表，须以客户端实际行为和成功调用为准；不能仅凭配置文件或服务列表宣称已接通。能够返回画布内容，并将测试修改保存后在页面看到，才分别证明读取和编辑可用。配对后的网页重新授权不改变六个工具或传输凭据，不需要再次执行加载步骤。

线上配对后，刷新、关闭、断开、到期或服务重启只撤销临时授权；在网页重新授权即可，修改权限也不改固定客户端配置。取消配对才撤销固定凭据。旧线上临时配置与本机 stdio 仍在失效后替换令牌、重新加载。切换、新建、删除和导入画布不会撤销工作区授权。更新前的单画布授权不会自动扩大；重新授权后确认 `connection_status.scope` 为 `workspace`，才可跨画布使用。勿将含真实凭据的客户端配置复制到项目文档、日志、截图或 Git。

## 权限与生命周期

| 项目 | 当前行为 |
| --- | --- |
| 范围 | 新面板建立 `scope: workspace`，绑定本次页面实例、权限与期限，覆盖该浏览器该站点的全部自由画布，包括后续新建 / 导入；不包含 `guided.html` |
| 旧授权兼容 | 原 `canvas` 授权仍限制原单张画布；列举、新建、导出全部或访问其他 ID 均拒绝，不自动升级 |
| 默认权限 | 每次授权默认只读；读写须在网页明确选择，线上不更改配对配置 |
| 收起面板 | 保留连接；面板的“断开接入”才撤销授权 |
| 切换 / 新建 / 删除 / 导入画布 | 工作区接入继续有效，不切换权限或凭据 |
| 刷新或关闭页面 | 临时授权撤销；页面未能通知服务时也会因心跳中断失效；线上配对保持，网页重新授权即可 |
| 会话寿命 | 本机与线上均可选“15分钟”“1小时”“永久（直到断开）”，默认“1小时”；永久不设定时到期，仍受页面与服务生命周期约束；远程超过 90 秒无页面心跳失效，本机为 10 秒 |
| 浏览器通道 | 远程长轮询每次最多等待 20 秒；本机沿用 750 毫秒轮询 |
| 请求期限 | 远程 30 秒，本机 15 秒；写入前重查期限，过期请求不能继续提交 |
| 服务重启 | 内存会话、请求和结果全部消失；线上配对身份保留，在网页重新授权；本机临时配置需更新 |
| 多页 | 同一配对同时只由一页授权，另一页显示 `page_in_use`；明确接管才撤销原页 |
| 取消配对 | 撤销固定客户端身份，后续请求 HTTP 401；重新使用须新配对和配置 |

“永久（直到断开）”在创建授权时以 `durationMs: null` 表示，状态中的 `expiresAt` 为 `null`；15 分钟与 1 小时授权仍返回实际到期时间。永久只取消本次会话的定时到期，不改变请求期限、心跳与授权复查，也不将授权持久保存到浏览器或服务器。

页面刷新、关闭时撤销授权；网络中断或异常退出无法发送通知时，远程最长 90 秒后失效，本机为 10 秒，永久授权也遵循此规则。浏览器长时间挂起、休眠或后台节流可能使心跳失效。网络短暂中断只能继续仍有效的原授权，不能延长有限期限、恢复已失效授权或重放写入。不提供离线排队编辑。线上在网页重新授权，本机沿用更新临时配置流程；重新授权默认只读，先前的读写权限不会自动恢复。

线上浏览器在独立 IndexedDB 保存不可导出的 P-256 私钥、公钥与配对 ID，用签名的一次性挑战证明配对归属；标签页标识放在 sessionStorage。固定客户端凭据只交给 Codex 配置，浏览器不持久保存其原文。页面临时令牌、权限、期限和活跃页面实例仅在内存，每次重新授权生成新的会话；它们都不写入画布 localStorage 或 JSON 备份。页面重新授权不会让旧请求借用新权限继续提交。

配置包含访问凭据，只交给你信任的客户端。只读权限也允许客户端获取全部授权画布的卡片、连线、名称和视图，并导出完整 JSON；客户端可能将内容交给它使用的 AI 服务，后续处理取决于该客户端及服务的数据政策。

在线读取和编辑的内容会经过 HTTPS 中继与 AI 客户端。中继在独立受限文件中只持久保存配对 ID、客户端凭据哈希、P-256 公钥、创建和撤销时间；原始凭据、私钥、权限、活跃页面、画布、请求和结果不落盘。临时会话、请求与短暂结果仍只在单进程内存；反向代理对该服务路径关闭访问日志，不记录内容、请求体或令牌。画布持久数据仍在原浏览器，没有账号、画布数据库或云同步。服务器重启清除临时授权但保留配对，不会自动恢复读写。客户端后续如何使用已读取内容由该客户端决定。

本机 `/api/mcp/` 仍是内部转发接口，不能直接作为远程 MCP 地址；远程客户端应使用上面的 HTTPS `/mcp`。两种模式均不支持连接其他 MCP 服务、访问旧六步数据或任意代码执行。

## 工具

| 工具 | 参数 | 结果与权限 |
| --- | --- | --- |
| `connection_status` | `{}` | 有授权时返回连接状态、`scope`、权限、会话到期时间与最近心跳，永久授权的 `expiresAt` 为 `null`；线上有效配对未授权时为 `ok: true, connected: false`，`state` 为 `needs_authorization` 或到期时的 `expired`；旧单画布范围另含 `boardId`，不读取正文 |
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
| `read_only` | 确需修改时，在原点明确重新授予读写权限；线上配对配置不变 |
| `scope_mismatch` | 旧单画布令牌不能访问其他画布或使用工作区工具；在更新后的页面明确授权全部画布 |
| `canvas_not_found` | 目标画布可能已删除，重新读取画布列表 |
| `unauthorized`、`session_expired`、`authorization_revoked` | 旧授权不可继续使用，重新开启接入 |
| `needs_authorization` | 线上配对有效，网页当前未授权；在原点重新授权，不修改配置或重连 Codex |
| `page_in_use` | 另一页正在持有此配对的接入位置；需在网页明确改由当前页授权 |
| 线上 HTTP 401 | 客户端配对凭据错误、被撤销或未完成配对；核对配对与配置，不能通过重新授予画布权限绕过身份校验 |
| `request_timeout` 或回执中断 | 先重新读取最新内容，避免盲目重复发送可能已保存但未收到回执的修改 |
| 服务不支持接入 / 找不到接口 | 核对服务身份，重启当前项目的 Node 服务 |
| MCP 进程无法加载 SDK | 在当前项目目录运行 `npm ci`，确认配置中的 Node 和脚本路径仍存在 |

本机接入的历史结果见 [MCP 验证](mcp-validation.md)；本轮线上部署、协议测试、Codex 调用与实际页面验证范围分别见 [部署说明](deployment.md)。模拟页面的协议测试不证明真实浏览器的保存、撤销和授权操作已通过。

## 协议参考

本项目使用 [MCP 官方 TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) 的独立服务端 / 客户端包；[SDK 文档](https://ts.sdk.modelcontextprotocol.io/v2/)说明其 API。MCP 标准分别定义 [stdio 与 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)，本机 HTTP 内部桥不是 MCP 传输端点。远程固定 Bearer 配对身份与本应用临时画布权限分层：无效身份在 HTTP 层拒绝，有效身份在没有活跃页面授权时仍能发现工具，并收到应用的未授权状态。这不是通用 OAuth 实现；若扩大为公开多用户接入，应另行实现与验证 [MCP 授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) 的 OAuth 流程。项目具体权限、操作限制和期限以当前源码及本页为准。
