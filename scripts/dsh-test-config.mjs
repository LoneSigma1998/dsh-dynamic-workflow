#!/usr/bin/env node
// Generate tsconfig.test.json: maps every `@deepseek-ai/*` package (and its subpath exports) of a
// deepseek-harness checkout to its TypeScript sources, so the offline integration tests run the
// REAL DSH agent loop from source with tsx — no DSH build needed (only `pnpm install` there).
// Usage: node scripts/dsh-test-config.mjs [path to deepseek-harness] (default ../deepseek-harness or $DSH_REPO)

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(process.argv[2] ?? process.env.DSH_REPO ?? join(root, '..', 'deepseek-harness'))
if (!existsSync(join(repo, 'packages'))) {
  console.error(`No deepseek-harness checkout at ${repo} (pass its path or set DSH_REPO).`)
  process.exit(2)
}

function* manifests(dir, depth = 0) {
  if (depth > 4) return
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'tests' || name === 'lib') continue
    const path = join(dir, name)
    if (!statSync(path).isDirectory()) continue
    const manifest = join(path, 'package.json')
    if (existsSync(manifest)) yield manifest
    else yield* manifests(path, depth + 1)
  }
}

/** `./lib/x.js` / `./lib/types/x.d.ts` / `./src/x.ts` → the package's `src/x.ts`, when it exists. */
function sourceOf(packageDir, target) {
  const value = typeof target === 'string' ? target : target?.types ?? target?.default ?? target?.import
  if (typeof value !== 'string') return undefined
  const stem = value.replace(/^\.\//u, '')
    .replace(/^lib\/types\//u, 'src/').replace(/\.d\.ts$/u, '.ts')
    .replace(/^lib\//u, 'src/').replace(/\.js$/u, '.ts')
  for (const candidate of [stem, stem.replace(/\.ts$/u, '.tsx'), stem.replace(/\.ts$/u, '/index.ts')]) {
    const file = join(packageDir, candidate)
    if (existsSync(file) && candidate.startsWith('src/')) return file
  }
  return undefined
}

const paths = {}
for (const base of ['packages', 'vendor', 'apps']) {
  if (!existsSync(join(repo, base))) continue
  for (const manifest of manifests(join(repo, base))) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@deepseek-ai/')) continue
    const dir = dirname(manifest)
    const exportsMap = pkg.exports === undefined ? { '.': pkg.main ?? './lib/index.js' } : typeof pkg.exports === 'string' ? { '.': pkg.exports } : pkg.exports
    for (const [key, target] of Object.entries(exportsMap)) {
      if (key.includes('*') || key === './package.json') continue
      const source = sourceOf(dir, target) ?? (key === '.' && existsSync(join(dir, 'src/index.ts')) ? join(dir, 'src/index.ts') : undefined)
      if (source === undefined) continue
      paths[key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`] = [source]
    }
  }
}

const base = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
const config = {
  compilerOptions: {
    ...base.compilerOptions,
    noEmit: true,
    skipLibCheck: true,
    jsx: 'react-jsx',
    baseUrl: '.',
    paths: { ...base.compilerOptions?.paths, ...paths },
  },
  include: ['src/**/*.ts', 'tests/**/*.ts'],
}
writeFileSync(join(root, 'tsconfig.test.json'), `${JSON.stringify(config, null, 1)}\n`)
console.log(`tsconfig.test.json: ${Object.keys(paths).length} DSH module paths from ${relative(root, repo) || repo}`)
