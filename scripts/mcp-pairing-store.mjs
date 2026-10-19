import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const ACTIONS = new Set(['status', 'attach', 'authorize', 'release', 'unpair']);
const MAX_RECORDS = 512;
const MAX_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const hash = token => createHash('sha256').update(token).digest('hex');
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function publicKey(value) {
  if (!object(value) || Object.keys(value).some(key => !['kty', 'crv', 'x', 'y', 'ext', 'key_ops'].includes(key)) ||
      value.kty !== 'EC' || value.crv !== 'P-256' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.x || '') || !/^[A-Za-z0-9_-]{43}$/u.test(value.y || '') ||
      (value.ext !== undefined && value.ext !== true) ||
      (value.key_ops !== undefined && (!Array.isArray(value.key_ops) || value.key_ops.length !== 1 || value.key_ops[0] !== 'verify')))
    throw error(400, 'invalid_public_key', '浏览器配对公钥无效。');
  const normalized = { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
  for (const coordinate of [value.x, value.y])
    if (Buffer.from(coordinate, 'base64url').toString('base64url') !== coordinate)
      throw error(400, 'invalid_public_key', '浏览器配对公钥无效。');
  try { createPublicKey({ key: normalized, format: 'jwk' }); }
  catch { throw error(400, 'invalid_public_key', '浏览器配对公钥无效。'); }
  return normalized;
}

function parseStore(source) {
  let input;
  try { input = JSON.parse(source); }
  catch { throw new Error('配对状态文件无效；请保留原文件并检查。'); }
  if (!exact(input, ['version', 'pairings']) || input.version !== 1 || !Array.isArray(input.pairings) || input.pairings.length > MAX_RECORDS)
    throw new Error('配对状态格式不受支持；请保留原文件并检查。');
  const ids = new Set();
  const tokens = new Set();
  for (const record of input.pairings) {
    if (!exact(record, ['pairingId', 'clientHash', 'publicKey', 'createdAt', 'revokedAt']) ||
        !UUID.test(record.pairingId) || !TOKEN.test(record.clientHash) ||
        !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
        !(record.revokedAt === null || Number.isSafeInteger(record.revokedAt) && record.revokedAt >= record.createdAt) ||
        ids.has(record.pairingId) || tokens.has(record.clientHash))
      throw new Error('配对状态记录无效；请保留原文件并检查。');
    record.publicKey = publicKey(record.publicKey);
    ids.add(record.pairingId);
    tokens.add(record.clientHash);
  }
  return input.pairings;
}

function authority({ records = [], persist = async () => {}, now = Date.now } = {}) {
  let entries = records;
  let queue = Promise.resolve();
  let closed = false;
  const challenges = new Map();
  const byId = id => entries.find(record => record.pairingId === id && record.revokedAt === null);
  const metadata = record => record ? structuredClone(record) : null;
  function alive() { if (closed) throw error(503, 'unavailable', '配对服务已停止。'); }
  function mutation(work) {
    const operation = queue.then(async () => { alive(); return work(); });
    queue = operation.catch(() => {});
    return operation;
  }
  function sweep() {
    for (const [id, challenge] of challenges) if (challenge.expiresAt <= now()) challenges.delete(id);
  }
  async function commit(next) {
    try { await persist(next); }
    catch (failure) {
      // A rename followed by a failed directory sync leaves uncertain durable
      // state. Fail closed until restart reloads the actual file.
      if (failure.pairingStoreUncertain) { closed = true; challenges.clear(); }
      throw failure;
    }
  }
  return {
    async create({ publicKey: suppliedKey, clientToken = randomBytes(32).toString('hex') }) {
      const key = publicKey(suppliedKey);
      if (!TOKEN.test(clientToken)) throw error(400, 'invalid_client_key', '客户端配对凭据无效。');
      return mutation(async () => {
        const clientHash = hash(clientToken);
        const existing = entries.find(record => record.clientHash === clientHash);
        // A lost first response may safely be retried by the same browser key
        // and known client secret. Never revive revoked or different devices.
        if (existing?.revokedAt === null && JSON.stringify(existing.publicKey) === JSON.stringify(key))
          return { pairingId: existing.pairingId, clientToken };
        if (existing)
          throw error(409, 'pairing_exists', '此客户端凭据已经配对或已被取消，请使用新的配置。');
        if (entries.length >= MAX_RECORDS) throw error(429, 'pairing_limit', '配对数量已达上限。');
        const record = { pairingId: randomUUID(), clientHash, publicKey: key, createdAt: now(), revokedAt: null };
        const next = [...entries, record];
        await commit(next);
        alive();
        entries = next;
        return { pairingId: record.pairingId, clientToken };
      });
    },
    get(pairingId) { alive(); return metadata(byId(pairingId)); },
    authenticate(token) {
      alive();
      if (!TOKEN.test(token || '')) return null;
      const clientHash = hash(token);
      return metadata(entries.find(record => record.clientHash === clientHash && record.revokedAt === null));
    },
    issue({ pairingId, action, parameters }) {
      alive(); sweep();
      if (!byId(pairingId)) throw error(401, 'pairing_revoked', '配对不存在或已取消，请重新配对。');
      if (!ACTIONS.has(action) || !object(parameters) || Buffer.byteLength(JSON.stringify(parameters)) > 2048)
        throw error(400, 'invalid_pairing_action', '无效的配对操作。');
      if (challenges.size >= 1024) throw error(429, 'challenge_limit', '配对请求过多，请稍后重试。');
      const challengeId = randomUUID();
      const expiresAt = now() + 30000;
      const message = JSON.stringify({ version: 1, pairingId, challengeId, action, parameters, expiresAt, nonce: randomBytes(32).toString('hex') });
      challenges.set(challengeId, { pairingId, action, parameters: structuredClone(parameters), message, expiresAt });
      return { challengeId, message, expiresAt };
    },
    verify({ pairingId, challengeId, signature }) {
      alive(); sweep();
      const challenge = challenges.get(challengeId);
      const record = byId(pairingId);
      if (!record || !challenge || challenge.pairingId !== pairingId || !/^[A-Za-z0-9_-]{86}$/u.test(signature || ''))
        throw error(401, 'invalid_proof', '配对验证已失效，请重试。');
      // Every proof is single-use, including an unsuccessful signature attempt.
      challenges.delete(challengeId);
      const bytes = Buffer.from(signature, 'base64url');
      let valid = false;
      try {
        valid = bytes.length === 64 && bytes.toString('base64url') === signature &&
          verifySignature('sha256', Buffer.from(challenge.message), {
            key: createPublicKey({ key: record.publicKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363'
          }, bytes);
      } catch { /* Invalid proof never changes pairing or grant state. */ }
      if (!valid) throw error(401, 'invalid_proof', '配对验证已失效，请重试。');
      return { pairingId, action: challenge.action, parameters: structuredClone(challenge.parameters) };
    },
    async revoke(pairingId) {
      return mutation(async () => {
        const record = byId(pairingId);
        if (!record) throw error(401, 'pairing_revoked', '配对不存在或已取消。');
        const next = entries.map(entry => entry === record ? { ...entry, revokedAt: Math.max(now(), entry.createdAt) } : entry);
        await commit(next);
        entries = next;
        for (const [id, challenge] of challenges) if (challenge.pairingId === pairingId) challenges.delete(id);
      });
    },
    close() { closed = true; challenges.clear(); }
  };
}

export function createMemoryPairingAuthority(options = {}) { return authority(options); }

/** Only device identity metadata is durable. No grants, requests or canvas data. */
export async function loadPairingAuthority({ filePath, now = Date.now } = {}) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error('配对状态路径必须是绝对文件路径。');
  const filename = path.resolve(filePath);
  const parent = path.dirname(filename);
  if (await realpath(parent) !== parent) throw new Error('配对状态目录不得经过符号链接。');
  const directory = await lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' && (directory.mode & 0o077))
    throw new Error('配对状态目录必须为当前服务专用的私有目录。');
  let records = [];
  async function checkFile() {
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES ||
          process.platform !== 'win32' && (info.mode & 0o077))
        throw new Error('配对状态文件必须为私有普通文件。');
      return info;
    } catch (failure) { if (failure.code === 'ENOENT') return null; throw failure; }
  }
  if (await checkFile()) records = parseStore(await readFile(filename, 'utf8'));
  async function persist(next) {
    await checkFile();
    if (await realpath(parent) !== parent) throw new Error('配对状态目录已改变。');
    const content = JSON.stringify({ version: 1, pairings: next });
    if (Buffer.byteLength(content) > MAX_BYTES) throw error(429, 'pairing_limit', '配对状态已达容量上限。');
    const pending = path.join(parent, `.pairings-${randomUUID()}.tmp`);
    let handle;
    let renamed = false;
    try {
      handle = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(pending, filename);
      renamed = true;
      if (process.platform !== 'win32') {
        const folder = await open(parent, 'r');
        try { await folder.sync(); } finally { await folder.close(); }
      }
    } catch (failure) {
      if (renamed) failure.pairingStoreUncertain = true;
      throw failure;
    } finally {
      await handle?.close();
      await unlink(pending).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
    }
  }
  return authority({ records, now, persist });
}
