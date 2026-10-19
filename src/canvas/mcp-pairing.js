import { REMOTE_MCP_URL } from './mcp-connection.js';

const DATABASE = 'yuandian.mcp-pairing.v1';
const STORE = 'pairing';
const RECORD = 'browser';
const CONSENT = 'permanent-consent';
const TOKEN = /^[a-f0-9]{64}$/u;

// Device proof and the user's optional permanent consent live separately from
// canvas data. Session tokens, requests and client credentials are never saved.
export function createBrowserPairingStore({
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto
} = {}) {
  let database;

  async function open() {
    if (!indexedDB || !crypto?.subtle)
      throw new Error('当前浏览器无法安全保存配对，请在支持 IndexedDB 与 Web Crypto 的浏览器中使用。');
    if (!database) {
      database = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => {
          const result = request.result;
          result.onversionchange = () => { result.close(); database = undefined; };
          resolve(result);
        };
        request.onerror = () => { database = undefined; reject(new Error('无法保存浏览器配对，请检查站点存储权限。')); };
        request.onblocked = () => { database = undefined; reject(new Error('配对存储被其他页面占用，请关闭旧页面后重试。')); };
      });
    }
    return database;
  }

  async function access(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let value;
      const request = operation(transaction.objectStore(STORE));
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = transaction.onerror = () => reject(new Error('无法保存浏览器配对，请检查站点存储空间。'));
    });
  }

  return {
    async exclusive(operation) {
      return globalThis.navigator?.locks?.request
        ? globalThis.navigator.locks.request('yuandian.mcp-pairing', operation)
        : operation();
    },
    async load() {
      const record = await access('readonly', store => store.get(RECORD));
      if (!record) return null;
      if (record.version !== 1 || record.privateKey?.type !== 'private' ||
          record.privateKey.extractable !== false ||
          record.privateKey.algorithm?.name !== 'ECDSA' ||
          record.privateKey.algorithm?.namedCurve !== 'P-256' ||
          record.publicKey?.kty !== 'EC' || record.publicKey?.crv !== 'P-256' ||
          Object.hasOwn(record.publicKey, 'd') ||
          (record.pairingId !== null && typeof record.pairingId !== 'string'))
        throw new Error('浏览器配对数据无法使用，请取消配对后重新开始。');
      return record;
    },
    async create() {
      const keys = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']
      );
      const record = {
        version: 1,
        pairingId: null,
        privateKey: keys.privateKey,
        publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey)
      };
      await access('readwrite', store => store.put(record, RECORD));
      return record;
    },
    async save(record) {
      await access('readwrite', store => store.put(record, RECORD));
    },
    async loadConsent(expectedPairingId) {
      const record = await access('readonly', store => store.get(CONSENT));
      if (!record || record.pairingId !== expectedPairingId) return null;
      if (record.version !== 1 || typeof record.pairingId !== 'string' ||
          !/^[a-f0-9-]{36}$/u.test(record.consentId || '') ||
          !['read', 'write'].includes(record.mode) ||
          Object.keys(record).some(key => !['version', 'pairingId', 'consentId', 'mode'].includes(key)))
        throw new Error('永久授权记录无法使用，请断开授权后重试。');
      return record;
    },
    async saveConsent(record) {
      if (record?.version !== 1 || typeof record.pairingId !== 'string' ||
          !/^[a-f0-9-]{36}$/u.test(record.consentId || '') || !['read', 'write'].includes(record.mode) ||
          Object.keys(record).some(key => !['version', 'pairingId', 'consentId', 'mode'].includes(key)))
        throw new Error('永久授权记录无效。');
      const db = await open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const request = store.get(RECORD);
        let replaced = false;
        request.onsuccess = () => {
          if (request.result?.pairingId !== record.pairingId) {
            replaced = true;
            transaction.abort();
          } else store.put(record, CONSENT);
        };
        transaction.oncomplete = resolve;
        transaction.onabort = transaction.onerror = () => reject(new Error(replaced
          ? '配对已由另一页面更新，请重新检查授权。' : '无法保存永久授权，请检查站点存储空间。'));
      });
    },
    async clearConsent(expectedPairingId) {
      const db = await open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const request = store.get(CONSENT);
        request.onsuccess = () => {
          if (expectedPairingId === undefined || request.result?.pairingId === expectedPairingId)
            store.delete(CONSENT);
        };
        transaction.oncomplete = resolve;
        transaction.onabort = transaction.onerror = () => reject(new Error('无法清除永久授权，请检查站点存储权限后重试。'));
      });
    },
    async clear(expectedPairingId) {
      const db = await open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const request = store.get(RECORD);
        request.onsuccess = () => {
          // A different tab may already have established a replacement pairing.
          // Clearing an old identity must not delete that newer device proof.
          if (expectedPairingId === undefined || request.result?.pairingId === expectedPairingId) {
            store.delete(RECORD);
            store.delete(CONSENT);
          }
        };
        transaction.oncomplete = resolve;
        transaction.onabort = transaction.onerror = () => reject(new Error('无法清除浏览器配对，请检查站点存储权限。'));
      });
    }
  };
}

export async function signPairingChallenge(privateKey, message, crypto = globalThis.crypto) {
  if (typeof message !== 'string' || !message || message.length > 8192)
    throw new Error('配对验证信息无效，请重试。');
  const bytes = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(message)
  ));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

// Accept exactly this service's compact TOML configuration. Treat pasted text
// as data; never evaluate TOML, accept another endpoint or change client files.
export function parseExistingCodexToken(text) {
  const source = typeof text === 'string' ? text.trim() : '';
  const lines = source.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length === 4 && /^enabled\s*=\s*true$/u.test(lines[3])) lines.pop();
  if (lines.length !== 3 || lines[0] !== '[mcp_servers.yuandian]')
    throw new Error('请粘贴当前 yuandian 服务的完整三行 Codex 配置。');
  const url = /^url\s*=\s*("[^"]*")$/u.exec(lines[1]);
  const authorization = /^http_headers\s*=\s*\{\s*Authorization\s*=\s*"Bearer ([a-f0-9]{64})"\s*\}$/u.exec(lines[2]);
  if (!url || JSON.parse(url[1]) !== REMOTE_MCP_URL ||
      !authorization || !TOKEN.test(authorization[1]))
    throw new Error('只能沿用原点固定远程地址的 yuandian 配置。');
  return authorization[1];
}

export async function pairingPageIdentity(window = globalThis.window, crypto = globalThis.crypto) {
  const storageKey = 'yuandian.mcp-tab.v1';
  let tabId = crypto.randomUUID();
  let stored = false;
  try {
    const candidate = window.sessionStorage.getItem(storageKey);
    if (/^[a-f0-9-]{36}$/u.test(candidate || '')) tabId = candidate;
    stored = true;
  } catch { /* Explicit authorization still works without sessionStorage. */ }
  let release = () => {};
  const locks = window.navigator?.locks;
  if (locks?.request) {
    let locked = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let ready;
      let failed = false;
      const acquired = new Promise(resolve => { ready = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      // Duplicating a tab may clone sessionStorage. A live document owns this
      // slot exclusively, so a cloned tab must get a different slot identity.
      void locks.request(`yuandian.mcp-tab:${tabId}`, { ifAvailable: true }, async lock => {
        ready(Boolean(lock));
        if (lock) await held;
      }).catch(() => { failed = true; ready(false); });
      if (await acquired) { locked = true; break; }
      tabId = crypto.randomUUID();
      if (failed) break;
    }
    if (!locked) stored = false;
  } else {
    // Without an exclusive document lock, never infer a same-tab refresh.
    tabId = crypto.randomUUID();
    stored = false;
  }
  try { window.sessionStorage.setItem(storageKey, tabId); } catch { stored = false; }
  return {
    pageId: crypto.randomUUID(),
    tabId,
    reload: stored && window.performance?.getEntriesByType('navigation')[0]?.type === 'reload',
    release
  };
}
