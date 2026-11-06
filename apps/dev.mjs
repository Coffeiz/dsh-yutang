import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appsDir = path.dirname(fileURLToPath(import.meta.url));
const serverEnvPath = path.join(appsDir, 'server', '.env');
const serverEnvExamplePath = path.join(appsDir, 'server', '.env.example');

async function ensureServerDevEnv() {
  try {
    await access(serverEnvPath);
  } catch {
    const example = await readFile(serverEnvExamplePath, 'utf8');
    const localEnv = example
      .replace(/^TOKEN_HMAC_PEPPER=.*$/m, `TOKEN_HMAC_PEPPER=${randomBytes(32).toString('base64url')}`)
      .replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}`);
    try {
      await writeFile(serverEnvPath, localEnv, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      console.log('已生成本机开发配置 apps/server/.env（Git 已忽略）；管理员密码可在该文件中查看。');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    return;
  }

  const current = await readFile(serverEnvPath, 'utf8');
  if (/^DB_HOST=/m.test(current) || !/^DATABASE_URL=/m.test(current)) return;

  const legacyValue = current.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim();
  let databaseUrl;
  try {
    databaseUrl = new URL(legacyValue ?? '');
  } catch {
    throw new Error('apps/server/.env 中的 DATABASE_URL 无法转换，请改为 DB_HOST、DB_PORT、DB_USER、DB_PASSWORD、DB_NAME。');
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || databaseUrl.search) {
    throw new Error('apps/server/.env 中的 DATABASE_URL 带有不支持的协议或参数，请手动填写独立 DB_* 配置。');
  }

  const fields = [
    `DB_HOST=${JSON.stringify(databaseUrl.hostname)}`,
    `DB_PORT=${databaseUrl.port || '5432'}`,
    `DB_USER=${JSON.stringify(decodeURIComponent(databaseUrl.username))}`,
    `DB_PASSWORD=${JSON.stringify(decodeURIComponent(databaseUrl.password))}`,
    `DB_NAME=${JSON.stringify(decodeURIComponent(databaseUrl.pathname.slice(1)))}`,
  ].join('\n');
  const migrated = current.replace(/^DATABASE_URL=.*(?:\r?\n|$)/m, `${fields}\n`);
  await writeFile(serverEnvPath, migrated, { encoding: 'utf8', mode: 0o600 });
  console.log('已将 apps/server/.env 的 DATABASE_URL 转为独立 DB_* 配置。');
}

const workspaces = [
  { name: '@dsh-im/web', preferredPort: Number(process.env.DSH_WEB_DEV_PORT ?? 9556), kind: 'web' },
  { name: '@dsh-im/server', preferredPort: Number(process.env.DSH_API_DEV_PORT ?? process.env.PORT ?? 9555), kind: 'server' },
  { name: '@dsh-im/admin', preferredPort: Number(process.env.DSH_ADMIN_DEV_PORT ?? 5174), kind: 'admin' },
];
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('请在 apps/ 目录通过 npm run dev 启动开发服务。');
  process.exit(1);
}

const children = new Set();
let stopping = false;

function isPortAvailable(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function findPort(preferred, reserved) {
  for (let port = preferred; port < Math.min(preferred + 100, 65536); port++) {
    if (!reserved.has(port) && await isPortAvailable(port)) {
      reserved.add(port);
      return port;
    }
  }
  throw new Error(`找不到从 ${preferred} 开始的可用端口`);
}

function stopAll(signal, exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (process.platform === 'win32') {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else if (child.pid) {
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    }
  }
}

process.on('SIGINT', () => stopAll('SIGINT', 130));
process.on('SIGTERM', () => stopAll('SIGTERM', 143));

const reserved = new Set();
const ports = {};
for (const workspace of workspaces) ports[workspace.kind] = await findPort(workspace.preferredPort, reserved);
await ensureServerDevEnv();

console.log(`Web: http://127.0.0.1:${ports.web}/`);
console.log(`Admin: http://127.0.0.1:${ports.web}/admin/ (Vite ${ports.admin})`);
console.log(`API: http://127.0.0.1:${ports.server}/`);

for (const workspace of workspaces) {
  const env = { ...process.env };
  if (workspace.kind === 'web') {
    env.WEB_DEV_PORT = String(ports.web);
    env.API_PROXY = `http://127.0.0.1:${ports.server}`;
    env.ADMIN_API_PROXY = `http://127.0.0.1:${ports.server}`;
    env.ADMIN_WEB_PROXY = `http://127.0.0.1:${ports.admin}`;
  } else if (workspace.kind === 'server') {
    env.HOST = '127.0.0.1';
    env.PORT = String(ports.server);
    env.WEB_ORIGIN = `http://127.0.0.1:${ports.web}`;
  } else {
    env.ADMIN_DEV_PORT = String(ports.admin);
    env.ADMIN_API_PROXY = `http://127.0.0.1:${ports.server}`;
  }

  const child = spawn(process.execPath, [npmCli, 'run', 'dev', '--workspace', workspace.name], {
    stdio: 'inherit',
    env,
    detached: process.platform !== 'win32',
  });
  children.add(child);
  child.on('error', error => {
    console.error(`无法启动 ${workspace.name}: ${error.message}`);
    stopAll('SIGTERM', 1);
  });
  child.on('exit', code => {
    children.delete(child);
    if (!stopping) stopAll('SIGTERM', code ?? 1);
  });
}
