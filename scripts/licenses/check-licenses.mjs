import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const report = JSON.parse(fs.readFileSync(path.join(root, 'licenses/dependencies.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(root, 'licenses/policy.json'), 'utf8'));
const blocked = new RegExp(`\\b(?:${policy.blockedPatterns.join('|')})\\b`, 'i');
const review = new Set(policy.reviewLicenses);
const failures = [];
const reviews = [];
const exceptions = new Map();

const project = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (project.license !== policy.projectLicense || report.projectLicense !== policy.projectLicense) {
  failures.push(`项目许可证与策略不一致：package.json=${project.license ?? 'missing'}, policy=${policy.projectLicense ?? 'missing'}, 清单=${report.projectLicense ?? 'missing'}`);
}

function parseLicenseExpression(expression) {
  const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*/gi) ?? [];
  let index = 0;
  function primary() {
    if (tokens[index] === '(') {
      index += 1;
      const value = parseOr();
      if (tokens[index] !== ')') throw new Error('未闭合括号');
      index += 1;
      return value;
    }
    const license = tokens[index++];
    if (!license || /^(AND|OR|WITH)$/i.test(license)) throw new Error('缺少许可证标识');
    if (/^WITH$/i.test(tokens[index] ?? '')) {
      index += 1;
      const exception = tokens[index++];
      if (!exception || /^(AND|OR|WITH)$/i.test(exception)) throw new Error('缺少例外标识');
      return { type: 'with', license, exception };
    }
    return { type: 'license', license };
  }
  function parseAnd() {
    let value = primary();
    while (/^AND$/i.test(tokens[index] ?? '')) {
      index += 1;
      value = { type: 'and', left: value, right: primary() };
    }
    return value;
  }
  function parseOr() {
    let value = parseAnd();
    while (/^OR$/i.test(tokens[index] ?? '')) {
      index += 1;
      value = { type: 'or', left: value, right: parseAnd() };
    }
    return value;
  }
  const tree = parseOr();
  if (!tokens.length || index !== tokens.length) throw new Error('许可证表达式格式无效');
  return tree;
}

function hasBlockedLicense(expression) {
  let tree;
  try {
    tree = parseLicenseExpression(expression);
  } catch {
    return true;
  }
  const isAllowed = node => {
    if (node.type === 'license' || node.type === 'with') return node.license !== 'Unknown' && !blocked.test(node.license);
    if (node.type === 'and') return isAllowed(node.left) && isAllowed(node.right);
    return isAllowed(node.left) || isAllowed(node.right);
  };
  return !isAllowed(tree);
}

for (const exception of policy.exceptions) {
  const note = typeof exception.note === 'string' ? exception.note.trim() : '';
  if (!exception.package || !note) {
    failures.push(`策略例外缺少 package 或 note：${JSON.stringify(exception)}`);
    continue;
  }
  exceptions.set(`${exception.package}|${exception.license ?? '*'}`, note);
}

for (const dependency of report.dependencies) {
  const key = `${dependency.name}@${dependency.version}`;
  const noted = exceptions.has(`${key}|${dependency.license}`) || exceptions.has(`${key}|*`);
  if (hasBlockedLicense(dependency.license) && !noted) failures.push(`${key}: ${dependency.license}`);
  if (review.has(dependency.license) && !noted) reviews.push(`${key}: ${dependency.license}`);
}

const installedVersions = new Set(report.dependencies.map(item => `${item.name}@${item.version}`));
for (const dependency of report.workspaceDependencies ?? []) {
  const key = `${dependency.name}@${dependency.resolvedVersion}`;
  if (!dependency.resolvedVersion) {
    if (['dependencies', 'devDependencies'].includes(dependency.type)) {
      failures.push(`workspace 直接依赖未解析：${dependency.workspace} ${dependency.type} ${dependency.name}@${dependency.specifier}`);
    }
    continue;
  }
  if (!installedVersions.has(key)) {
    failures.push(`workspace 直接依赖未出现在许可证清单中：${dependency.workspace} ${dependency.type} ${key}`);
  }
}

if (reviews.length) {
  console.warn('需要人工复核的许可证（如批准例外，请在 licenses/policy.json 中附 note）：');
  for (const item of reviews) console.warn(`- ${item}`);
}
if (failures.length) {
  console.error('许可证策略失败：');
  for (const item of failures) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log(`许可证策略通过；${reviews.length} 项需要人工复核。`);
}
