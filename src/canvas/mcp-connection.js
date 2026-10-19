const PAGES_ORIGIN = 'https://yitonghu-sc.github.io';
const PAGES_PATH = '/yuandian/';
const REMOTE_ROOT = 'https://stellarcore.games/yuandian-mcp';

export const REMOTE_MCP_URL = `${REMOTE_ROOT}/mcp`;

// The published application has one fixed relay. Page parameters and imported
// content cannot redirect credentials or canvas content to another service.
export function getMcpConnection(location) {
  const local =
    location?.protocol === 'http:' && location?.hostname === '127.0.0.1';
  const remote =
    location?.origin === PAGES_ORIGIN &&
    typeof location?.pathname === 'string' &&
    location.pathname.startsWith(PAGES_PATH);
  return Object.freeze({
    available: local || remote,
    remote,
    apiBase: remote ? `${REMOTE_ROOT}/api/mcp` : '/api/mcp',
    pollDelayMs: remote ? 0 : 750,
    requestTimeoutMs: 35000
  });
}

export function codexMcpConfiguration(config) {
  if (
    config?.url !== REMOTE_MCP_URL ||
    !/^Bearer [a-f0-9]{64}$/u.test(config?.headers?.Authorization || '') ||
    Object.keys(config.headers).length !== 1
  ) {
    throw new Error('远程接入配置无效，请重新开启接入。');
  }
  return [
    '[mcp_servers.yuandian]',
    `url = ${JSON.stringify(config.url)}`,
    `http_headers = { Authorization = ${JSON.stringify(config.headers.Authorization)} }`
  ].join('\n');
}
