import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = resolve(root, '.client-build')
const names = (await readdir(buildDir, { recursive: true }))
  .filter(name => name.endsWith('.cjs'))
  .sort()

const modules = []
for (const name of names) {
  const absolute = resolve(buildDir, name)
  const id = `./${relative(buildDir, absolute).split(sep).join('/')}`
  const body = await readFile(absolute, 'utf8')
  modules.push(`${JSON.stringify(id)}: function(module, exports, require) {\n${body}\n}`)
}

const wrapped = `window.__ModuleLoader__.load({ id: "dsh-yutang", factory: (require) => {\nvar __ytModules = {\n${modules.join(',\n')}\n};\nvar __ytCache = Object.create(null);\nfunction __ytRequire(id) {\n  var factory = __ytModules[id];\n  if (!factory) return require(id);\n  var cached = __ytCache[id];\n  if (cached) return cached.exports;\n  var module = { exports: {} };\n  __ytCache[id] = module;\n  factory(module, module.exports, __ytRequire);\n  return module.exports;\n}\nreturn __ytRequire("./plugin.cjs");\n} })\n`
await mkdir(resolve(root, 'lib'), { recursive: true })
await writeFile(resolve(root, 'lib/client.js'), wrapped, 'utf8')
await rm(buildDir, { recursive: true, force: true })
