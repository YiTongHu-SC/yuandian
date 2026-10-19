/** Shared ephemeral grant and tool-scope checks. No canvas data is retained here. */
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const exactKeys = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 100;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const revision = /^[a-f0-9]{64}$/u;
const denied = (status, code, error) => ({ status, value: { ok: false, code, error } });

// null disables only the absolute grant expiry; heartbeat and request deadlines still apply.
export const validMcpDuration = (value) => value === null ||
  (Number.isSafeInteger(value) && value >= 60000 && value <= 3600000);

export function inspectMcpGrant(input, { requireLegacyPageId = false } = {}) {
  if (!object(input) || (input.mode !== undefined && !['read', 'write'].includes(input.mode)) ||
      (own(input, 'durationMs') && !validMcpDuration(input.durationMs))) return null;
  const duration = own(input, 'durationMs') ? { durationMs: input.durationMs } : {};
  if (input.scope === 'workspace') {
    if (!exactKeys(input, ['scope', 'pageId', 'mode', 'durationMs']) || !uuid.test(input.pageId || '')) return null;
    return { scope: 'workspace', pageId: input.pageId, mode: input.mode || 'read', ...duration };
  }
  // An older client without an explicit scope always retains its original single-canvas grant.
  if (own(input, 'scope') || !exactKeys(input, ['boardId', 'pageId', 'mode', 'durationMs']) || !validId(input.boardId) ||
      ((requireLegacyPageId || own(input, 'pageId')) && !uuid.test(input.pageId || ''))) return null;
  return { scope: 'canvas', boardId: input.boardId, ...(input.pageId ? { pageId: input.pageId } : {}), mode: input.mode || 'read', ...duration };
}

/** Check permission and target routing before anything is queued for the browser. */
export function inspectMcpCall(session, tool, input) {
  const fields = {
    connection_status: [], list_canvases: [], get_canvas: ['boardId'],
    edit_canvas: ['boardId', 'expectedRevision', 'operations'],
    create_canvas: ['title', 'expectedWorkspaceRevision'], export_canvas: ['boardId', 'all']
  };
  if (!own(fields, tool) || !object(input)) return denied(400, 'invalid_tool', '无效的工具调用。');
  if (!exactKeys(input, fields[tool]) || (own(input, 'boardId') && !validId(input.boardId)))
    return denied(400, 'invalid_arguments', '工具参数格式不正确。');
  if (['edit_canvas', 'create_canvas'].includes(tool) && session.mode !== 'write')
    return denied(403, 'read_only', '当前连接只允许读取，修改需在原点重新授权。');
  if (session.scope !== 'workspace' && (['list_canvases', 'create_canvas'].includes(tool) ||
      input.all === true || (own(input, 'boardId') && input.boardId !== session.boardId)))
    return denied(403, 'scope_mismatch', '此连接只授权原来的一张画布；访问全部画布需在原点重新授权。');
  if (session.scope === 'workspace' && tool === 'edit_canvas' && !own(input, 'boardId'))
    return denied(400, 'invalid_arguments', '跨画布编辑必须指定 boardId，请先列出或读取目标画布。');
  if (tool === 'create_canvas' && (!revision.test(input.expectedWorkspaceRevision || '') ||
      (own(input, 'title') && (typeof input.title !== 'string' || input.title.length > 200))))
    return denied(400, 'invalid_arguments', '新建画布需要最近 list_canvases 的 workspaceRevision，以及有效名称。');
  if (tool === 'export_canvas' && ((own(input, 'all') && typeof input.all !== 'boolean') ||
      (input.all === true && own(input, 'boardId'))))
    return denied(400, 'invalid_arguments', '导出可指定 boardId，或使用 all:true 备份全部画布。');
  return null;
}

/** Keep a legacy single-canvas response from accidentally widening to another board. */
export function inspectMcpResult(session, item, result) {
  if (!result.ok) return null;
  const target = item.arguments.boardId ?? (session.scope === 'workspace' ? undefined : session.boardId);
  if (item.tool === 'get_canvas' && target && result.board?.id !== target)
    return denied(400, 'scope_mismatch', '响应不属于已请求或已授权的画布。');
  if (item.tool === 'export_canvas' && (session.scope !== 'workspace' || item.arguments.all !== true)) {
    let parsed;
    try { parsed = JSON.parse(result.json); } catch { /* Reject malformed exports without echoing their content. */ }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.boards) || parsed.boards.length !== 1 ||
        (target && parsed.boards[0]?.id !== target))
      return denied(400, 'scope_mismatch', '导出响应不属于已请求或已授权的单张画布。');
  }
  return null;
}
