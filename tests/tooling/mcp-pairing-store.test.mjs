import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMemoryPairingAuthority, loadPairingAuthority } from '../../scripts/mcp-pairing-store.mjs';

function device() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKey: publicKey.export({ format: 'jwk' }),
    proof(pairingId, challenge) {
      return { pairingId, challengeId: challenge.challengeId,
        signature: sign('sha256', Buffer.from(challenge.message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
    }
  };
}

test('pairing proof binds exact action, parameters and nonce; replay, wrong key and expiry fail', async () => {
  let current = 1000;
  const authority = createMemoryPairingAuthority({ now: () => current });
  const browser = device();
  const pair = await authority.create({ publicKey: browser.publicKey });
  assert.equal(authority.authenticate(pair.clientToken).pairingId, pair.pairingId);
  const challenge = authority.issue({ pairingId: pair.pairingId, action: 'authorize', parameters: { mode: 'read', pageId: 'test-page' } });
  const proof = browser.proof(pair.pairingId, challenge);
  assert.deepEqual(authority.verify(proof), { pairingId: pair.pairingId, action: 'authorize', parameters: { mode: 'read', pageId: 'test-page' } });
  assert.throws(() => authority.verify(proof), { code: 'invalid_proof' });
  const wrong = authority.issue({ pairingId: pair.pairingId, action: 'unpair', parameters: {} });
  assert.throws(() => authority.verify(device().proof(pair.pairingId, wrong)), { code: 'invalid_proof' });
  assert.throws(() => authority.verify(browser.proof(pair.pairingId, wrong)), { code: 'invalid_proof' });
  const expired = authority.issue({ pairingId: pair.pairingId, action: 'status', parameters: {} });
  current += 30000;
  assert.throws(() => authority.verify(browser.proof(pair.pairingId, expired)), { code: 'invalid_proof' });
  authority.close();
});

test('durable pairing survives restart without plaintext token, grant or canvas content; unpair remains revoked', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuandian-pairing-'));
  try {
    const filePath = path.join(directory, 'pairings.json');
    const browser = device();
    const first = await loadPairingAuthority({ filePath });
    const pair = await first.create({ publicKey: browser.publicKey, clientToken: 'f'.repeat(64) });
    const text = await readFile(filePath, 'utf8');
    assert.ok(!text.includes(pair.clientToken));
    assert.deepEqual(Object.keys(JSON.parse(text).pairings[0]).sort(), ['clientHash', 'createdAt', 'pairingId', 'publicKey', 'revokedAt']);
    first.close();
    const second = await loadPairingAuthority({ filePath });
    assert.equal(second.authenticate(pair.clientToken).pairingId, pair.pairingId);
    await second.revoke(pair.pairingId);
    assert.equal(second.authenticate(pair.clientToken), null);
    second.close();
    const third = await loadPairingAuthority({ filePath });
    assert.equal(third.authenticate(pair.clientToken), null);
    assert.throws(() => third.issue({ pairingId: pair.pairingId, action: 'status', parameters: {} }), { code: 'pairing_revoked' });
    await assert.rejects(third.create({ publicKey: browser.publicKey, clientToken: pair.clientToken }), { code: 'pairing_exists' });
    third.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('same-key creation retries are idempotent; different device or failed persistence cannot activate pairing', async () => {
  const authority = createMemoryPairingAuthority();
  const browser = device();
  const results = await Promise.allSettled([1, 2].map(() => authority.create({ publicKey: browser.publicKey, clientToken: 'a'.repeat(64) })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results[0].value.pairingId, results[1].value.pairingId);
  await assert.rejects(authority.create({ publicKey: device().publicKey, clientToken: 'a'.repeat(64) }), { code: 'pairing_exists' });
  authority.close();
  const failing = createMemoryPairingAuthority({ persist: async () => { throw new Error('disk unavailable'); } });
  await assert.rejects(failing.create({ publicKey: browser.publicKey, clientToken: 'b'.repeat(64) }), /disk unavailable/u);
  assert.equal(failing.authenticate('b'.repeat(64)), null);
  failing.close();
});

test('invalid or content-bearing store is rejected without rewriting recoverable bytes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuandian-pairing-'));
  try {
    const filePath = path.join(directory, 'pairings.json');
    const bytes = '{"version":1,"pairings":[],"canvas":"not allowed"}';
    await writeFile(filePath, bytes, { mode: 0o600 });
    await assert.rejects(loadPairingAuthority({ filePath }), /配对状态/u);
    assert.equal(await readFile(filePath, 'utf8'), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('challenge capacity is bounded and expired proofs release capacity', async () => {
  let current = 100;
  const authority = createMemoryPairingAuthority({ now: () => current });
  const pair = await authority.create({ publicKey: device().publicKey });
  for (let i = 0; i < 1024; i++) authority.issue({ pairingId: pair.pairingId, action: 'status', parameters: {} });
  assert.throws(() => authority.issue({ pairingId: pair.pairingId, action: 'status', parameters: {} }), { code: 'challenge_limit' });
  current += 30000;
  assert.ok(authority.issue({ pairingId: pair.pairingId, action: 'status', parameters: {} }));
  authority.close();
});
