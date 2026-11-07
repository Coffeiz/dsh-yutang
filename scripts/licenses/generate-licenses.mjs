import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const virtualStore = path.join(root, 'node_modules/.pnpm');
const licensesDir = path.join(root, 'licenses');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function licenseFor(packagePath, manifest) {
  const declared = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
  if (declared) return declared;
  const file = fs.readdirSync(packagePath).find(name => (
    ['license', 'license.md', 'license.txt', 'copying', 'copying.md'].includes(name.toLowerCase())
  ));
  if (!file) return 'Unknown';
  const text = fs.readFileSync(path.join(packagePath, file), 'utf8').slice(0, 4096);
  return text.match(/SPDX-License-Identifier:\s*([^\s*]+)/i)?.[1]
    ?? (/^\s*The MIT License(?:\s*\(MIT\))?/i.test(text) ? 'MIT' : null)
    ?? (/^\s*Apache License\s*\n\s*Version 2\.0/i.test(text) ? 'Apache-2.0' : null)
    ?? 'Unknown';
}

function collectPackages() {
  if (!fs.existsSync(virtualStore)) {
    throw new Error('未找到 pnpm 虚拟依赖目录，请先运行 pnpm install --frozen-lockfile。');
  }
  const packages = new Map();
  for (const virtualPackage of fs.readdirSync(virtualStore).sort()) {
    const moduleRoot = path.join(virtualStore, virtualPackage, 'node_modules');
    if (!fs.existsSync(moduleRoot)) continue;
    for (const entry of fs.readdirSync(moduleRoot).sort()) {
      const entryPath = path.join(moduleRoot, entry);
      const packagePaths = entry.startsWith('@') && fs.statSync(entryPath).isDirectory()
        ? fs.readdirSync(entryPath).sort().map(name => path.join(entryPath, name))
        : [entryPath];
      for (const packagePath of packagePaths) {
        const manifestPath = path.join(packagePath, 'package.json');
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = readJson(manifestPath);
        if (!manifest.name || !manifest.version) continue;
        const key = `${manifest.name}@${manifest.version}`;
        packages.set(key, {
          name: manifest.name,
          version: manifest.version,
          license: licenseFor(packagePath, manifest),
          homepage: manifest.homepage || '',
          repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url || '',
        });
      }
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const workspaceFiles = [];
for (const dir of ['apps', 'packages', 'plugins']) {
  if (!fs.existsSync(path.join(root, dir))) continue;
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(root, dir, entry.name, 'package.json');
    if (fs.existsSync(manifest)) workspaceFiles.push(manifest);
  }
}

const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const workspaceDependencies = [];
for (const file of workspaceFiles) {
  const manifest = readJson(file);
  const workspacePath = path.dirname(file);
  for (const dependencyType of dependencyGroups) {
    for (const [name, specifier] of Object.entries(manifest[dependencyType] ?? {})) {
      if (typeof specifier !== 'string' || specifier.startsWith('workspace:')) continue;
      const installedManifest = path.join(workspacePath, 'node_modules', ...name.split('/'), 'package.json');
      const installed = fs.existsSync(installedManifest) ? readJson(installedManifest) : null;
      workspaceDependencies.push({
        workspace: manifest.name || path.relative(root, workspacePath).split(path.sep).join('/'),
        path: path.relative(root, workspacePath).split(path.sep).join('/'),
        type: dependencyType,
        name,
        specifier,
        resolvedVersion: installed?.version ?? null,
      });
    }
  }
}

const directRefsByPackage = new Map();
for (const dependency of workspaceDependencies) {
  if (!dependency.resolvedVersion) continue;
  const key = `${dependency.name}@${dependency.resolvedVersion}`;
  const refs = directRefsByPackage.get(key) ?? [];
  refs.push({ workspace: dependency.workspace, type: dependency.type, specifier: dependency.specifier });
  directRefsByPackage.set(key, refs);
}

const dependencies = collectPackages().map(item => {
  const directRefs = directRefsByPackage.get(`${item.name}@${item.version}`) ?? [];
  return { ...item, directIn: directRefs };
});
const runtimeHeader = process.report?.getReport?.().header;
const report = {
  project: 'workspace',
  label: 'DSH 鱼塘 / pnpm workspace',
  projectLicense: readJson(path.join(root, 'package.json')).license || 'Unknown',
  packageManager: 'pnpm',
  scannedPlatform: {
    os: process.platform,
    cpu: process.arch,
    libc: process.platform === 'linux'
      ? (runtimeHeader?.glibcVersionRuntime ? 'glibc' : 'musl-or-unknown')
      : null,
  },
  inventoryScope: 'Packages installed in this pnpm workspace on the scanned platform',
  packageManifests: ['package.json', 'pnpm-workspace.yaml', ...workspaceFiles.map(file => path.relative(root, file).split(path.sep).join('/'))],
  workspaceDependencies: workspaceDependencies.sort((a, b) => a.workspace.localeCompare(b.workspace)
    || a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
  dependencies,
};

fs.mkdirSync(licensesDir, { recursive: true });
fs.writeFileSync(path.join(licensesDir, 'dependencies.json'), `${JSON.stringify(report, null, 2)}\n`);
const markdown = [
  '# 第三方依赖许可证清单',
  '',
  `项目自身许可证：${report.projectLicense}。以下为第三方依赖许可证，不改变项目自身许可证。`,
  '',
  `扫描平台：${report.scannedPlatform.os}-${report.scannedPlatform.cpu}${report.scannedPlatform.libc ? ` (${report.scannedPlatform.libc})` : ''}。该清单只代表此平台安装的依赖；跨平台合规由 CI 平台矩阵检查。`,
  '',
  '> 由 `pnpm licenses:generate` 生成，请勿手动编辑。',
  '',
  '| 依赖 | 版本 | 许可证 | 直接依赖位置 | 链接 |',
  '| --- | --- | --- | --- | --- |',
  ...dependencies.map(item => {
    const links = [item.homepage, item.repository].filter(Boolean).join(' · ');
    const directIn = item.directIn.map(ref => `${ref.workspace} (${ref.type})`).join(', ') || '—';
    return `| ${item.name} | ${item.version} | ${item.license} | ${directIn} | ${links} |`;
  }),
].join('\n');
fs.writeFileSync(path.join(licensesDir, 'THIRD-PARTY-NOTICES.md'), `${markdown}\n`);
console.log(`Generated license list for ${dependencies.length} installed packages.`);
