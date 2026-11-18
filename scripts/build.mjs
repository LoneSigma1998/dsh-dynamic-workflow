#!/usr/bin/env node
// Build the plugin into self-contained bundles:
//   lib/index.js  — Host plugin (ESM, node), with the vendored ZCode compiler/engine,
//                   TypeScript 5.9 and zod bundled in; no runtime import of host packages.
//   lib/client.js — Web client plugin (CJS wrapped in window.__ModuleLoader__.load), with
//                   react/react-dom/zod/@deepseek-ai/* client platform modules left to the host.
// Usage: node scripts/build.mjs [--server-only|--client-only]

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
let esbuild
try {
  esbuild = require('esbuild')
} catch {
  esbuild = createRequire(process.env.ESBUILD_FROM ?? '/opt/cowork-node-tools/node_modules/')('esbuild')
}

const args = new Set(process.argv.slice(2))
mkdirSync(join(root, 'lib'), { recursive: true })

// The compiler embeds the TypeScript stdlib .d.ts closure: generate it for the installed TS.
execFileSync(process.execPath, [join(root, 'vendor/dynamic-workflow/scripts/generate-libs.mjs')], { stdio: 'inherit', cwd: join(root, 'vendor/dynamic-workflow') })

const alias = {
  '@zcode/dynamic-workflow/projections': join(root, 'vendor/dynamic-workflow/src/projections.ts'),
  '@zcode/dynamic-workflow/testing': join(root, 'vendor/dynamic-workflow/src/testing/index.ts'),
  '@zcode/dynamic-workflow': join(root, 'vendor/dynamic-workflow/src/index.ts'),
  '@zcode/dynamic-workflow-runtime': join(root, 'vendor/dynamic-workflow-runtime/src/index.ts'),
}

// `.js` specifiers inside the vendored sources point at sibling `.ts` files.
const jsToTs = {
  name: 'js-to-ts',
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const candidate = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'))
      return existsSync(candidate) ? { path: candidate } : undefined
    })
  },
}

if (!args.has('--client-only')) {
  await esbuild.build({
    entryPoints: [join(root, 'src/index.ts')],
    outfile: join(root, 'lib/index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    alias,
    plugins: [jsToTs],
    // Host packages are type-only imports; the one dynamic import stays a runtime probe.
    external: ['@deepseek-ai/*'],
    // The bundled TypeScript compiler is CommonJS and reads `require` / `__filename` / `__dirname`.
    banner: {
      js: [
        "import { createRequire as __dwfCreateRequire } from 'node:module';",
        "import { fileURLToPath as __dwfFileURLToPath } from 'node:url';",
        "import { dirname as __dwfDirname } from 'node:path';",
        'const require = __dwfCreateRequire(import.meta.url);',
        'const __filename = __dwfFileURLToPath(import.meta.url);',
        'const __dirname = __dwfDirname(__filename);',
      ].join(' '),
    },
    logLevel: 'info',
    legalComments: 'linked',
  })
}

/**
 * The Web shell's frozen module table (packages/client/web/src/platform.ts PLATFORM_MODULES).
 * A client bundle may `require` exactly these; every other import is bundled, and other
 * `@deepseek-ai/*` packages must be type-only (erased).
 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Fail the build on a runtime import of a host package outside the module table (it would throw at load). */
const guardHostImports = {
  name: 'guard-host-imports',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
      if (PLATFORM_MODULES.includes(args.path)) return { path: args.path, external: true }
      return { errors: [{ text: `client bundle: runtime import of ${args.path} (not in the Web module table; use \`import type\`)` }] }
    })
  },
}

if (!args.has('--server-only') && existsSync(join(root, 'src/client/index.tsx'))) {
  const id = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
  const result = await esbuild.build({
    entryPoints: [join(root, 'src/client/index.tsx')],
    outdir: join(root, 'lib/.client-tmp'),
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    alias,
    plugins: [jsToTs, guardHostImports],
    external: PLATFORM_MODULES,
    loader: { '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  })
  const js = result.outputFiles.find(file => file.path.endsWith('.js'))
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
  if (js === undefined) throw new Error('client bundle: no JavaScript output')
  // Stylesheet delivery differs across DSH releases: published 0.2.2-rc.4 bundles inject their own
  // <style data-plugin data-plugin-css> when the factory runs (and the loader removes
  // style[data-plugin=<id>] on unload); newer sources read `meta.stylesheets`. Do both — the
  // self-injected tag is keyed, so a re-run (HMR) replaces its text instead of stacking copies.
  const tagId = `${id}/src/client/styles.css`
  const injectCss = css === '' ? '' : [
    '(function () {',
    "  if (typeof document === 'undefined') return;",
    `  var tagId = ${JSON.stringify(tagId)};`,
    "  var tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']');",
    "  if (tag === null) { tag = document.createElement('style'); tag.dataset.plugin = " + JSON.stringify(id) + '; tag.dataset.pluginCss = tagId; document.head.appendChild(tag); }',
    `  tag.textContent = ${JSON.stringify(css)};`,
    '})();',
  ].join('\n')
  const wrapped = [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
    injectCss,
    js.text,
    `return module.exports; }${css === '' ? '' : `, meta: () => ({ stylesheets: { "src/client/styles.css": { text: () => ${JSON.stringify(css)} } } })`} });`,
    '',
  ].join('\n')
  writeFileSync(join(root, 'lib/client.js'), wrapped)
  console.log(`lib/client.js ${(wrapped.length / 1024).toFixed(1)} KB (css ${(css.length / 1024).toFixed(1)} KB)`)
}
