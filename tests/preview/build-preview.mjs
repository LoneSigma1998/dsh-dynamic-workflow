#!/usr/bin/env node
// Build a self-contained preview page (inline JS + CSS) of the plugin's Web surfaces with the real
// DSH primitives and theme tokens. Usage:
//   node tests/preview/build-preview.mjs <fixtures.json> <out.html> [--dark] [--zh] [--react <dir with react, react-dom>] [--dsh <deepseek-harness root>]

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const option = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1] }
const valued = new Set(['--react', '--dsh', '--only'])
const [fixturesPath, outPath] = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]))
const dsh = resolve(option('--dsh', join(root, '..', 'deepseek-harness')))
const reactDir = resolve(option('--react', join(root, 'node_modules')))
const require = createRequire(join(root, 'package.json'))
let esbuild
try { esbuild = require('esbuild') } catch { esbuild = createRequire('/opt/cowork-node-tools/node_modules/')('esbuild') }

const primitives = join(dsh, 'packages/client/ui-primitives/src')
const theme = join(dsh, 'packages/client/ui-theme/src/styles')
const zodDir = [join(root, 'node_modules/zod'), join(root, '../pi/node_modules/zod')].find(existsSync)

const alias = {
  '@deepseek-ai/dsh-client-ui-primitives': join(here, 'primitives-shim.tsx'),
  '@dsh-primitives': primitives,
  'react': join(reactDir, 'react'),
  'react-dom': join(reactDir, 'react-dom'),
  'clsx': join(here, 'clsx-shim.ts'),
  '@zcode/dynamic-workflow': join(root, 'vendor/dynamic-workflow/src/index.ts'),
  ...zodDir === undefined ? {} : { zod: zodDir },
}

const jsToTs = {
  name: 'js-to-ts',
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const candidate = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'))
      return existsSync(candidate) ? { path: candidate } : undefined
    })
  },
}

writeFileSync(join(here, 'clsx-shim.ts'), "export default function clsx(...args: unknown[]): string {\n  const out: string[] = []\n  for (const arg of args) {\n    if (typeof arg === 'string' && arg !== '') out.push(arg)\n    else if (arg !== null && typeof arg === 'object') for (const [k, v] of Object.entries(arg)) if (v) out.push(k)\n  }\n  return out.join(' ')\n}\n")

const result = await esbuild.build({
  entryPoints: [join(here, 'preview.tsx')],
  bundle: true,
  write: false,
  outdir: '/tmp/dwf-preview-out',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  alias,
  plugins: [jsToTs],
  loader: { '.module.css': 'local-css', '.css': 'css', '.woff2': 'empty' },
  define: {
    'process.env.NODE_ENV': '"production"',
    FIXTURES: readFileSync(fixturesPath, 'utf8'),
    LOCALE: JSON.stringify(flag('--zh') ? 'zh' : 'en'),
    ONLY: JSON.stringify(option('--only', '')),
  },
  logLevel: 'warning',
})
const js = result.outputFiles.find(f => f.path.endsWith('.js')).text
const css = result.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? ''
const themeCss = ['base.css', 'design-platform.css', 'gradient-shadow-text.css', 'focus.css']
  .map(file => readFileSync(join(theme, file), 'utf8').replace(/@font-face\s*\{[^}]*\}/gu, '').replace(/@import[^;]+;/gu, ''))
  .join('\n')
const page = `<!doctype html>
<html lang="${flag('--zh') ? 'zh' : 'en'}"><head><meta charset="utf-8"><title>dsh-dynamic-workflow · Web preview</title>
<style>${themeCss}</style>
<style>${css}</style>
<style>
  body { margin: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: var(--dsw-font-s-14, 14px/22px system-ui); }
  .pv-main { padding: 20px 24px; }
  .pv-h { font: var(--dsw-font-xs-strong-13, 600 13px/20px system-ui); color: var(--dsw-alias-label-tertiary); margin: 0 0 8px; letter-spacing: .02em; }
</style></head>
<body${flag('--dark') ? ' data-ds-dark-theme=""' : ''}><div id="root"></div><script>${js.replace(/<\/script/giu, '<\\/script')}</script></body></html>`
writeFileSync(outPath, page)
console.log(`preview: ${outPath} (${(page.length / 1024).toFixed(0)} KB)`)
