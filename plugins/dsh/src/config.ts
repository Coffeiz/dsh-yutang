import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface YutangPluginConfig { dataDir?: string; serverUrl?: string; officialServerUrl?: string }
export interface ResolvedYutangPluginConfig { dataDir: string; serverUrl: string; officialServerUrl?: string }

export function resolveConfig(input: YutangPluginConfig = {}, profileDir?: string): ResolvedYutangPluginConfig {
  const serverUrl = new URL(input.serverUrl ?? 'https://yutangapi.gugugu.site');
  if (!['http:', 'https:'].includes(serverUrl.protocol) || serverUrl.username || serverUrl.password || serverUrl.search || serverUrl.hash) {
    throw new Error('dsh-yutang: serverUrl must be a valid HTTP(S) origin or base URL');
  }
  const officialServerUrl = input.officialServerUrl ? normalizeServerUrl(input.officialServerUrl) : undefined;
  return {
    dataDir: resolve(input.dataDir ?? (profileDir ? join(profileDir, 'dsh-yutang') : join(homedir(), '.dsh', 'plugins', 'dsh-yutang'))),
    serverUrl: serverUrl.toString().replace(/\/$/u, ''),
    ...(officialServerUrl ? { officialServerUrl } : {}),
  };
}

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Server 地址不能为空。');
  const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed);
  const candidate = explicitScheme ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Server 地址必须是有效的 HTTP(S) 域名、域名:端口或完整 URL。');
  }
  if (!explicitScheme && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) parsed.protocol = 'http:';
  return parsed.toString().replace(/\/$/u, '');
}
