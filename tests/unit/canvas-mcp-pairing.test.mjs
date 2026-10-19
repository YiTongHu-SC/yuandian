import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  parseExistingCodexToken, pairingPageIdentity, signPairingChallenge
} from '../../src/canvas/mcp-pairing.js';
import { REMOTE_MCP_URL } from '../../src/canvas/mcp-connection.js';

test('浏览器不可导出私钥可签名，输出与服务器 P1363 格式一致', async () => {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  assert.equal(keys.privateKey.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('jwk', keys.privateKey));
  const message = '虚构的配对验证信息';
  const signature = await signPairingChallenge(keys.privateKey, message, webcrypto);
  assert.match(signature, /^[A-Za-z0-9_-]{86}$/u);
  assert.equal(await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey,
    Buffer.from(signature, 'base64url'), new TextEncoder().encode(message)
  ), true);
});

test('沿用配置只接受固定服务的完整配置，不接受额外字段或其他地址', () => {
  const token = 'a'.repeat(64);
  const valid = `[mcp_servers.yuandian]\nurl = "${REMOTE_MCP_URL}"\nhttp_headers = { Authorization = "Bearer ${token}" }`;
  assert.equal(parseExistingCodexToken(valid), token);
  assert.equal(parseExistingCodexToken(`${valid}\nenabled = true`), token);
  for (const invalid of [valid.replace(REMOTE_MCP_URL, 'https://untrusted.invalid/mcp'),
    `${valid}\ncommand = "execute"`, valid.replace(token, 'a'.repeat(63)),
    valid.replace('Authorization =', 'Other ='), valid.replace('[mcp_servers.yuandian]', '[mcp_servers.other]')])
    assert.throws(() => parseExistingCodexToken(invalid));
});

test('复制标签的同 tabId 被排他锁识别，刷新原标签仍可保留身份', async () => {
  const held = new Set();
  const locks = {
    async request(name, options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); }
      finally { held.delete(name); }
    }
  };
  const tabId = webcrypto.randomUUID();
  const window = () => {
    const entries = new Map([['yuandian.mcp-tab.v1', tabId]]);
    return {
      navigator: { locks }, performance: { getEntriesByType: () => [{ type: 'reload' }] },
      sessionStorage: { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) }
    };
  };
  const first = await pairingPageIdentity(window(), webcrypto);
  assert.equal(first.tabId, tabId);
  assert.equal(first.reload, true);
  const cloned = await pairingPageIdentity(window(), webcrypto);
  assert.notEqual(cloned.tabId, tabId);
  first.release();
  await new Promise(resolve => setImmediate(resolve));
  const refreshed = await pairingPageIdentity(window(), webcrypto);
  assert.equal(refreshed.tabId, tabId);
  assert.notEqual(first.pageId, refreshed.pageId);
  cloned.release();
  refreshed.release();
});

test('不支持 Web Locks 时不以存储的 tabId 推定页面刷新', async () => {
  const previous = webcrypto.randomUUID();
  const identity = await pairingPageIdentity({
    performance: { getEntriesByType: () => [{ type: 'reload' }] },
    sessionStorage: { getItem: () => previous, setItem() {} }
  }, webcrypto);
  assert.notEqual(identity.tabId, previous);
  assert.equal(identity.reload, false);
});
