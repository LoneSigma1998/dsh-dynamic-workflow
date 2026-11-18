#!/usr/bin/env node
/**
 * Loads the BUILT Web bundle (lib/client.js) the way the DSH shell does — a classic script calling
 * `window.__ModuleLoader__.load({ id, factory, meta })`, `factory(require)` with the platform module
 * table — then applies the plugin against a recording client context and server-renders every
 * registered component with real fixture props. Fails on: wrong id, a require outside the platform
 * table, a missing registration, a component that throws.
 *
 * Usage: node tests/client/bundle-load.mjs <fixtures.json> [--react <dir holding react + react-dom>] [--dsh <deepseek-harness>]
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const argv = process.argv.slice(2)
const option = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1] }
const fixtures = JSON.parse(readFileSync(argv[0], 'utf8'))
const reactRequire = createRequire(join(resolve(option('--react', join(root, 'node_modules'))), 'noop.js'))
const React = reactRequire('react')
const ReactDOMServer = reactRequire('react-dom/server')
const jsxRuntime = reactRequire('react/jsx-runtime')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Minimal primitives with the real export names (the shell provides the real ones).
const h = React.createElement
const primitives = new Proxy({
  StateDot: ({ state }) => h('span', { 'data-dot': state }),
  Button: ({ children, icon, variant: _v, size: _s, ...rest }) => h('button', rest, icon, children),
  DisclosureRow: ({ title, collapsedContent, open, children }) => h('div', { 'data-disclosure': title }, collapsedContent, open ? children : null),
  TextShimmer: ({ children }) => h('span', null, children),
  MarkdownText: ({ text }) => h('div', null, text),
}, { get: (target, name) => target[name] ?? (name.startsWith('Icon') ? () => h('i', { 'data-icon': name }) : undefined) })

const PLATFORM = new Map([
  ['react', React], ['react/jsx-runtime', jsxRuntime], ['react-dom', reactRequire('react-dom')],
  ['@deepseek-ai/dsh-client-ui-primitives', primitives],
  ['zod', createRequire(join(root, 'package.json'))('zod')],
])
const required = new Set()
let registration
// a minimal document: the factory self-injects its stylesheet (DSH 0.2.2-rc.4 delivery)
const injectedStyles = []
const fakeDocument = {
  querySelector: (selector) => injectedStyles.find(tag => selector.includes(JSON.stringify(tag.dataset.pluginCss))) ?? null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => { injectedStyles.push(tag) } },
}
const sandbox = { window: { __ModuleLoader__: { load: (r) => { registration = r } } }, document: fakeDocument, console, URLSearchParams, setTimeout, clearTimeout }
vm.runInNewContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })
assert.ok(registration !== undefined, 'bundle registered through __ModuleLoader__.load')
assert.equal(registration.id, pkg.name, 'registration id is the package name')
const stylesheets = registration.meta?.().stylesheets ?? {}
const cssText = Object.values(stylesheets).map(s => s.text({ asset: x => x })).join('')
assert.ok(cssText.includes('.dwf-timeline'), 'stylesheet text delivered through meta')
const exportsObject = registration.factory(Object.assign((spec) => {
  required.add(spec)
  if (!PLATFORM.has(spec)) throw new Error(`require("${spec}") missed the module table`)
  return PLATFORM.get(spec)
}, { async: async () => { throw new Error('no chunks') }, asset: x => x }))
assert.deepEqual([...required].filter(s => !PLATFORM.has(s)), [])
assert.equal(injectedStyles.length, 1, 'the factory injected one stylesheet')
assert.equal(injectedStyles[0].dataset.plugin, pkg.name, 'tagged with the owning package (the loader removes it on unload)')
assert.ok(injectedStyles[0].textContent.includes('.dwf-timeline'))
assert.equal(typeof exportsObject.apply, 'function')
assert.equal(exportsObject.default, undefined, 'no default export (it would replace the plugin)')
console.log(`✓ bundle: id=${registration.id}, requires=[${[...required].join(', ')}], css ${(cssText.length / 1024).toFixed(1)} KB`)

// Apply against a recording context.
const registrations = []
const definitions = []
const locales = []
const tabs = []
const ctx = {
  effect: (fn) => { fn() },
  inject: (names, cb) => cb(ctx),
  get: () => undefined,
  logger: { warn: () => undefined },
  slots: {
    inject: (_name, cb) => { const out = cb(); if (out && typeof out[Symbol.iterator] === 'function' && typeof out.next === 'function') for (const _ of out) { /* drain */ } },
    register: (options, component) => { registrations.push({ options, component }); return () => undefined },
  },
  locale: { register: (ns, dicts) => { locales.push([ns, Object.keys(dicts)]); return () => undefined } },
  uiConversation: { events: { register: (def) => { definitions.push(def); return () => undefined } } },
  sidebarRightTabs: { register: (def) => { tabs.push(def); return () => undefined } },
}
for (const name of exportsObject.inject) assert.ok(name in ctx, `injected service ${name} exists`)
exportsObject.apply(ctx)
const keys = registrations.map(r => `${r.options.name}:${r.options.key ?? r.options.priority ?? r.options.id}`)
for (const expected of ['tool.call.toolview:create_workflow', 'tool.call.toolview:amend_workflow', 'tool.call.toolview:fill_workflow_hole', 'conversation.composer:-1', 'conversation.chat.node:dynamic-workflow-notice', 'conversation.chat.node:dynamic-workflow-run', 'sidebar.right.pane.tab:dsh-dynamic-workflow:run']) {
  assert.ok(keys.includes(expected), `registered ${expected} (got ${keys.join(', ')})`)
}
assert.deepEqual(definitions.map(d => d.kind), ['dynamic-workflow-notice', 'dynamic-workflow-run'])
assert.deepEqual(locales, [['dynamicWorkflow', ['zh', 'en']]])
assert.equal(tabs[0]?.kind, 'dynamic-workflow-run')
console.log(`✓ apply: ${keys.join(' · ')}; definition ${definitions[0].kind}; tab ${tabs[0].kind}`)

// Render each registered component with fixture props.
const zh = locales.length > 0
const t = (key, params) => params === undefined ? key : `${key}${JSON.stringify(params)}`
const run = fixtures.run
const state = { revision: 0, runs: [] }
const projection = ((initial) => {
  let value = initial
  // fold the real progress records with the bundle's own projection? The bundle does not export it;
  // rebuild the run list from the notice definition only. The card must still render without a run.
  return { get: () => value }
})(state)
const byKey = Object.fromEntries(registrations.map(r => [`${r.options.name}:${r.options.key ?? r.options.priority}`, r]))
const args = (values) => ({ isSealed: true, closed: () => true, has: k => k in values, complete: () => true, text: k => values[k], textPrefix: (k, n) => values[k]?.slice(0, n), value: k => values[k] })
const common = { t, sessionId: 's1', useDisclosure: () => ({ expanded: true, setExpanded: () => undefined, toggle: () => undefined }), useProjection: (_k, sel) => (sel === undefined ? projection.get() : sel(projection.get())), openChild: () => undefined, openRun: () => undefined }
const render = (key, props) => ReactDOMServer.renderToStaticMarkup(h(byKey[key].component, props))
const callArgs = JSON.parse(run.call.arguments)
const htmlPreparing = render('tool.call.toolview:create_workflow', { ...common, phase: 'preparing', callId: 'c1', toolName: 'create_workflow', block: { phase: 'preparing', callId: 'c1', name: 'create_workflow', turn: 1, step: 1, time: 0, args: args({ name: callArgs.name, script: callArgs.script }) } })
assert.match(htmlPreparing, /card\.writing/)
assert.match(htmlPreparing, /dwf-station/)
const htmlResult = render('tool.call.toolview:create_workflow', { ...common, phase: 'result', callId: run.call.callId, toolName: 'create_workflow', block: { kind: 'tool-result', seq: 1, time: 0, callId: run.call.callId, name: 'create_workflow', args: args({}), call: { name: 'create_workflow', argsRaw: run.call.arguments }, content: [], isError: false, meta: run.display } })
assert.match(htmlResult, /dwf-card-head/)
assert.doesNotMatch(htmlResult, /dwf-pill/, 'after launch the live timeline is the run node, not the tool card')
const htmlBad = render('tool.call.toolview:create_workflow', { ...common, phase: 'result', callId: 'c2', toolName: 'create_workflow', block: { kind: 'tool-result', seq: 1, time: 0, callId: 'c2', name: 'create_workflow', args: args({}), call: { name: 'create_workflow', argsRaw: '{}' }, content: [{ type: 'text', text: 'x' }], isError: true, meta: fixtures.diagnostics } })
assert.match(htmlBad, /dwf-diagnostics/)
const htmlFill = render('tool.call.toolview:fill_workflow_hole', { ...common, phase: 'result', callId: 'c3', toolName: 'fill_workflow_hole', block: { kind: 'tool-result', seq: 1, time: 0, callId: 'c3', name: 'fill_workflow_hole', args: args({}), call: { name: 'fill_workflow_hole', argsRaw: '{"run_id":"r","hole_id":"h","body":"return 1"}' }, content: [], isError: false, meta: { kind: 'dynamic-workflow-launch', tool: 'fill_workflow_hole', ok: true, errorCount: 0, diagnostics: [], fill: { siteId: 'h', name: 'h' } } } })
assert.match(htmlFill, /card\.fill/)
// the confirm selector and card
const confirm = byKey['conversation.composer:-1']
const pending = { kind: 'question', key: 'k', sessionId: 's1', questions: [{ id: 'dynamic-workflow-confirm', question: 'Run?' }], snapshot: () => ({ channel: 'waterfall', closed: false }), getSnapshot: () => ({ channel: 'waterfall', closed: false }), subscribe: () => () => undefined, answer: async () => undefined, dismiss: async () => undefined }
const matched = confirm.options.select({ sessionId: 's1', pendingInteraction: pending })
assert.ok(matched !== null, 'confirm selector claims dynamic-workflow-confirm')
assert.equal(confirm.options.select({ sessionId: 's1', pendingInteraction: { ...pending, questions: [{ id: 'other' }] } }), null, 'other questions are left to ui-user-questions')
assert.match(ReactDOMServer.renderToStaticMarkup(h(confirm.component, { matched, t })), /confirm\.allow/)
// the notice definition over a real notice message
const notice = run.notices[0]
const event = { type: 'user/message', seq: 5, time: 1, data: notice, surfaceOp: 'append' }
const match = definitions[0].match(event)
assert.equal(JSON.stringify(match), JSON.stringify({ id: String(notice.id), role: 'start', exclusive: true }), 'notice claimed exclusively (vm realm: compare as JSON)')
assert.equal(definitions[0].match({ ...event, data: { ...notice, source: { kind: 'user' } } }), null)
const nodeState = definitions[0].start({ key: 'k', kind: 'dynamic-workflow-notice', id: match.id, start: undefined, state: undefined }, { event, role: 'start', location: { kind: 'unresolved' } })
assert.equal(nodeState.tone, 'done')
const view = definitions[0].buildViewNode({ key: 'k', kind: 'dynamic-workflow-notice', id: match.id, start: { event, role: 'start', location: { kind: 'unresolved' } }, state: nodeState })
assert.equal(view.kind, 'dynamic-workflow-notice')
assert.match(render('conversation.chat.node:dynamic-workflow-notice', { ...common, node: view }), /notice\.title/)
// the run node: starts at the run-started record, ignores the rest, stands at turn level
const runDef = definitions.find(d => d.kind === 'dynamic-workflow-run')
const started = run.progress.find(p => p.eventType === 'run-started')
const startEvent = { type: 'plugin:dynamic-workflow/progress', seq: 11, time: 1, data: started }
assert.equal(JSON.stringify(runDef.match(startEvent)), JSON.stringify({ id: started.runId, role: 'start' }))
assert.equal(runDef.match({ ...startEvent, data: run.progress.find(p => p.eventType === 'node-settled') }), null)
const runState = runDef.start({ key: 'r', kind: 'dynamic-workflow-run', id: started.runId, start: undefined, state: undefined }, { event: startEvent, role: 'start', location: { kind: 'unresolved' } })
const runView = runDef.buildViewNode({ key: 'r', kind: 'dynamic-workflow-run', id: started.runId, start: { event: startEvent, role: 'start', location: { kind: 'unresolved' } }, state: runState })
assert.equal(runView.groupTree, 'turn', 'run node stays outside the folded process')
assert.match(render('conversation.chat.node:dynamic-workflow-run', { ...common, node: runView }), /dwf-run-node/)
console.log('✓ render: preparing draft, launched timeline, diagnostics, fill row, confirm card (+ selector), notice chip (+ definition)')
console.log(zh ? 'CLIENT BUNDLE OK' : 'CLIENT BUNDLE OK')
