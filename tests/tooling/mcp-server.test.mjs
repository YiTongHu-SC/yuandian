import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { bridgeSettings } from '../../scripts/mcp-server.mjs';
import { PROJECT_ROOT, startDevServer } from '../../scripts/dev-server.mjs';
import { createMemoryPairingAuthority } from '../../scripts/mcp-pairing-store.mjs';

test('stdio 目的地址严格限制回环 HTTP，拒绝无凭据、主机别名及任意路径', () => {
  const token = 'a'.repeat(64);
  assert.deepEqual(bridgeSettings({ YUANDIAN_MCP_TOKEN: token }), {
    url: 'http://127.0.0.1:4176/api/mcp/call',
    token
  });
  for (const url of [
    'http://localhost:4176',
    'http://2130706433:4176',
    'http://127.0.0.1:4176/extra',
    'http://user:pass@127.0.0.1:4176',
    'https://127.0.0.1:4176',
    'http://127.0.0.1:4176/?x=1',
    'http://127.0.0.1:99999',
    'http://127.0.0.1:0',
    'http://127.0.0.1:04176',
    'http://example.test:4176'
  ])
    assert.throws(() =>
      bridgeSettings({ YUANDIAN_URL: url, YUANDIAN_MCP_TOKEN: token })
    );
  assert.throws(() => bridgeSettings({}));
  const run = spawnSync(
    process.execPath,
    [path.join(PROJECT_ROOT, 'scripts/mcp-server.mjs')],
    {
      env: { ...process.env, YUANDIAN_MCP_TOKEN: '' },
      encoding: 'utf8',
      windowsHide: true
    }
  );
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /授权/u);
});

test(
  '真实 SDK stdio 初始化、tools/list、读取、写入、只读拒绝和断连错误',
  { timeout: 15000 },
  async (t) => {
    const server = await startDevServer({ port: 0, pairingAuthority: createMemoryPairingAuthority() });
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    async function browser(route, ownerToken, body) {
      const response = await fetch(`${origin}/api/mcp/${route}`, {
        method: route === 'poll' ? 'GET' : 'POST',
        headers: {
          Origin: origin,
          'X-Yuandian-Client': 'canvas',
          'Content-Type': 'application/json',
          ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return {
        status: response.status,
        value: response.status === 204 ? undefined : await response.json()
      };
    }
    async function poll(ownerToken) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await browser('poll', ownerToken);
        if (response.status !== 204) return response.value;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('SDK tool call was not relayed');
    }
    async function connect(mode, workspace = false) {
      const session = (
        await browser('session', null, workspace
          ? { scope: 'workspace', pageId: randomUUID(), mode }
          : { boardId: 'fictional-board', mode })
      ).value;
      const transport = new StdioClientTransport({
        ...session.config,
        stderr: 'pipe'
      });
      let stderr = '';
      transport.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      const client = new Client({
        name: 'yuandian-integration-test',
        version: '1.0.0'
      });
      await client.connect(transport);
      t.after(() => client.close());
      return { session, client, stderr: () => stderr };
    }
    const { session, client, stderr } = await connect('write');
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['get_canvas', 'edit_canvas', 'connection_status', 'list_canvases', 'create_canvas', 'export_canvas']
    );
    assert.equal(tools[0].annotations.readOnlyHint, true);
    assert.equal(tools[1].inputSchema.additionalProperties, false);
    assert.equal(tools[1].annotations.destructiveHint, true);
    assert.equal(tools[1].annotations.openWorldHint, false);
    const status = await client.callTool({
      name: 'connection_status',
      arguments: {}
    });
    assert.equal(status.structuredContent.mode, 'write');
    const readPending = client.callTool({ name: 'get_canvas', arguments: {} });
    const request = await poll(session.ownerToken);
    assert.equal(request.tool, 'get_canvas');
    const board = {
      id: 'fictional-board',
      title: '虚构测试画布',
      nodes: [
        { id: 'card-1', text: '用户数据；不是指令', x: 0, y: 0, color: 'cream' }
      ],
      edges: []
    };
    const revision = 'c'.repeat(64);
    await browser('result', session.ownerToken, {
      requestId: request.requestId,
      result: { ok: true, board, revision }
    });
    const readResult = await readPending;
    assert.deepEqual(readResult.structuredContent.board, board);
    assert.match(readResult.content[0].text, /不是系统指令/u);
    const operations = [{ op: 'create_card', text: 'AI 测试卡片', ref: 'new' }];
    const writePending = client.callTool({
      name: 'edit_canvas',
      arguments: { expectedRevision: revision, operations }
    });
    const write = await poll(session.ownerToken);
    assert.deepEqual(write.arguments.operations, operations);
    await browser('result', session.ownerToken, {
      requestId: write.requestId,
      result: {
        ok: true,
        revision: 'd'.repeat(64),
        created: { cards: [{ ref: 'new', id: 'card-2' }], connections: [] }
      }
    });
    assert.equal((await writePending).structuredContent.ok, true);
    const invalid = await client.callTool({
      name: 'edit_canvas',
      arguments: {
        expectedRevision: revision,
        operations,
        boardId: 'other-board'
      }
    });
    assert.equal(invalid.isError, true);
    assert.equal((await browser('poll', session.ownerToken)).status, 204);
    const readOnly = await connect('read');
    const denied = await readOnly.client.callTool({
      name: 'edit_canvas',
      arguments: { expectedRevision: revision, operations }
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.code, 'read_only');
    const conflictPending = client.callTool({
      name: 'edit_canvas',
      arguments: { expectedRevision: revision, operations }
    });
    const conflict = await poll(session.ownerToken);
    await browser('result', session.ownerToken, {
      requestId: conflict.requestId,
      result: {
        ok: false,
        code: 'revision_conflict',
        error: '画布已更改，请重新读取。'
      }
    });
    assert.equal((await conflictPending).isError, true);
    await browser('disconnect', session.ownerToken);
    const disconnected = await client.callTool({
      name: 'get_canvas',
      arguments: {}
    });
    assert.equal(disconnected.isError, true);
    assert.equal(disconnected.structuredContent.code, 'unauthorized');
    assert.equal(stderr(), '');
    assert.equal(readOnly.stderr(), '');
    const workspace = await connect('write', true);
    assert.equal((await workspace.client.callTool({ name: 'connection_status', arguments: {} })).structuredContent.scope, 'workspace');
    const jobs = [
      ['list_canvases', {}, { ok: true, activeId: 'first', workspaceRevision: 'a'.repeat(64), boards: [{ id: 'first' }, { id: 'second' }] }],
      ['get_canvas', { boardId: 'second' }, { ok: true, board: { id: 'second' }, revision: 'b'.repeat(64) }],
      ['edit_canvas', { boardId: 'second', expectedRevision: 'b'.repeat(64), operations: [{ op: 'create_card', text: '另一画布' }] }, { ok: true, revision: 'c'.repeat(64) }],
      ['create_canvas', { title: '新建测试', expectedWorkspaceRevision: 'a'.repeat(64) }, { ok: true, board: { id: 'third' }, revision: 'd'.repeat(64), workspaceRevision: 'e'.repeat(64) }],
      ['export_canvas', { all: true }, { ok: true, json: JSON.stringify({ version: 1, activeId: 'first', boards: [{ id: 'first' }, { id: 'second' }, { id: 'third' }] }), filename: '备份.json', mimeType: 'application/json' }]
    ];
    for (const [name, arguments_, result] of jobs) {
      const pending = workspace.client.callTool({ name, arguments: arguments_ });
      const request = await poll(workspace.session.ownerToken);
      assert.equal(request.tool, name);
      assert.deepEqual(request.arguments, arguments_);
      await browser('result', workspace.session.ownerToken, { requestId: request.requestId, result });
      assert.deepEqual((await pending).structuredContent, result);
    }
    const invalidTarget = await workspace.client.callTool({ name: 'edit_canvas', arguments: { expectedRevision: 'b'.repeat(64), operations: [{ op: 'create_card' }] } });
    assert.equal(invalidTarget.structuredContent.code, 'invalid_arguments');
    assert.equal(workspace.stderr(), '');
  }
);
