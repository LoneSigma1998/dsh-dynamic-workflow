#!/usr/bin/env node
// Typecheck this plugin (Host + Web halves + tests) against a deepseek-harness checkout's sources.
// DSH's own files are compiled too (they are mapped by path), so only diagnostics in this
// package's files count; DSH-internal noise (other compiler options, optional deps) is ignored.
// Usage: node scripts/typecheck.mjs [path to deepseek-harness]

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync(process.execPath, [join(root, 'vendor/dynamic-workflow/scripts/generate-libs.mjs')], { stdio: 'inherit', cwd: join(root, 'vendor/dynamic-workflow') })
execFileSync(process.execPath, [join(root, 'scripts/dsh-test-config.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' })
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc')
let failed = false
for (const [name, include, types] of [['host', ['src/**/*.ts', 'tests/**/*.ts'], ['node']], ['web', ['src/client/**/*.ts', 'src/client/**/*.tsx'], ['node', 'react']]]) {
  const config = JSON.parse(readFileSync(join(root, 'tsconfig.test.json'), 'utf8'))
  config.include = include
  config.exclude = ['src/client/**'].filter(() => name === 'host')
  config.compilerOptions.types = types
  const file = join(root, `tsconfig.typecheck-${name}.json`)
  writeFileSync(file, JSON.stringify(config))
  const result = spawnSync(process.execPath, [tsc, '-p', file], { cwd: root, encoding: 'utf8' })
  const own = (result.stdout + result.stderr).split('\n').filter(line => /^(src|tests)\//u.test(line))
  if (own.length > 0) {
    failed = true
    console.log(own.join('\n'))
  }
  console.log(`${own.length === 0 ? '✓' : '✗'} typecheck ${name}: ${own.length} diagnostic(s) in this package`)
}
process.exit(failed ? 1 : 0)
