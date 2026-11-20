/**
 * Regression tests for the issues the plugin's own medium-large review run found:
 * artifact ids cannot leave the run directory (H1), a run executing in another live Host is
 * not claimed as an orphan (H3), and an aborted governor waiter leaves the queue, updates the
 * waiters count and leaves no listener behind (M9/L14).
 * Run: tsx --tsconfig <paths config> tests/dsh/hardening.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ConcurrencyGovernor } from '../../src/governor/governor.ts'
import { RunOwnership, SqliteJournal } from '../../src/journal/journal.ts'
import { JOURNAL_SCHEMA } from '../../src/journal/schema.ts'
import { createArtifactStore } from '../../src/service/artifacts.ts'
import { createNodeExecutionPort, createNodeFileSystemPort } from '../../src/world/ports.ts'
import { executeWorldRead } from '../../src/world/world-read.ts'
import { taskCounts } from '../../src/client/run-view.ts'
import { classifyChildFailure } from '../../src/driver/model-failure.ts'
import { parseModelSpec } from '../../src/driver/driver.ts'
import { analyzeWorkflowScript } from '@zcode/dynamic-workflow'
import { compileOnce } from '../../src/service/compile.ts'
import { fillHole } from '../../src/service/fill.ts'
import { RunService } from '../../src/service/run-service.ts'
import { loadSkillContent } from '../../src/skill.ts'
import { parseSettings } from '../../src/tools/confirm.ts'
import { applyConfirmedSettings, displayOf } from '../../src/tools/tools.ts'
import { artifactResponseHeaders, registerWorkflowRoutes } from '../../src/web/routes.ts'
import { findSaved, listSaved, resolveSavedArgs, writeSaved } from '../../src/tools/sources.ts'
import { sessionHasLoadedSkill } from '../../src/tools/skill-gate.ts'
import type { WorkflowRunState } from '../../src/shared/runs/workflow-runs.ts'
import { parsePresetSpec, projectBoard, projectChart, projectMetrics, projectTable, specFieldPaths } from '../../src/client/model/preset-artifacts.ts'
import { spineLayout } from '../../src/client/model/timeline/spine-layout.ts'
import { buildWorkflowTimeline } from '../../src/client/model/timeline/timeline-model.ts'
import { ROSTER_PINS_PANE, rosterMore, rosterRoll, stationRosterOf } from '../../src/client/model/timeline/roster-model.ts'

function artifacts(): void {
  const root = mkdtempSync(join(tmpdir(), 'dwf-art-'))
  const store = createArtifactStore(root)
  assert.equal(store.pathOf('run-1', 'report.md', 2), join(root, 'run-1', 'report.md', 'v2'))
  for (const id of ['..', '.', '../x', 'a/b', 'a\\b', '', 'x'.repeat(129), '%2e%2e']) {
    assert.throws(() => store.pathOf('run-1', id, 1), (error: { code?: string }) => error.code === 'ArtifactSpecInvalid', `id ${JSON.stringify(id)} must be rejected`)
  }
  for (const version of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => store.pathOf('run-1', 'ok', version), (error: { code?: string }) => error.code === 'ArtifactSpecInvalid', `version ${version} must be rejected`)
  }
  // the run id is sanitized, never trusted as a path
  assert.equal(store.pathOf('../../etc', 'ok', 1), join(root, '.._.._etc', 'ok', 'v1'))
  rmSync(root, { recursive: true, force: true })
  console.log('✓ artifacts: traversal ids, separators and bad versions are refused')
}

function ownership(): void {
  const db = new DatabaseSync(':memory:')
  db.exec(JOURNAL_SCHEMA)
  const mine = new RunOwnership(db)
  const other = new RunOwnership(db)
  mine.claim('run-a')
  assert.equal(mine.ownedElsewhere('run-a'), false, 'own runs are never "elsewhere"')
  assert.equal(other.ownedElsewhere('run-a'), true, 'a live owner on this boot holds the run')
  // a stale heartbeat alone does not release it (a laptop that slept stops every heartbeat at once)
  db.prepare('update dsh_dwf_run_owner set heartbeat = ? where run_id = ?').run(Date.now() - 3_600_000, 'run-a')
  assert.equal(other.ownedElsewhere('run-a'), true, 'an hour-old heartbeat of a live process still holds the run')
  // a dead owner (pid that cannot exist) releases the run
  db.prepare('update dsh_dwf_run_owner set pid = ? where run_id = ?').run(2 ** 22 + 12345, 'run-a')
  assert.equal(other.ownedElsewhere('run-a'), false, 'a dead pid does not hold the run')
  // a claim recorded before a reboot does not hold the run (its pid may be someone else now)
  mine.claim('run-b')
  db.prepare("update dsh_dwf_run_owner set instance = ? where run_id = ?").run(`${process.pid}-0-old`, 'run-b')
  assert.equal(other.ownedElsewhere('run-b'), false, 'a pre-reboot claim does not hold the run')
  // boot time compared with a tolerance: a reading 30 s off (rounding edge, clock correction) is the same boot
  mine.claim('run-d')
  const parts = mine.instance.split('-')
  const shifted = `${parts[0]}-${(Number.parseInt(parts[1]!, 36) + 30_000).toString(36)}-${parts[2]}`
  db.prepare('update dsh_dwf_run_owner set instance = ? where run_id = ?').run(shifted, 'run-d')
  assert.equal(other.ownedElsewhere('run-d'), true, 'a boot reading 30 s apart is the same boot')
  // write fence: when another Host takes a run over, the old owner learns it on its next beat
  const fenced = new RunOwnership(db)
  fenced.claim('run-c')
  assert.deepEqual(fenced.lost(), [])
  assert.equal(fenced.takenOver('run-c'), false)
  other.claim('run-c')
  assert.equal(fenced.takenOver('run-c'), true, 'the per-write check sees the takeover at once')
  assert.deepEqual(fenced.lost(), ['run-c'], 'the replaced claim is reported once')
  assert.deepEqual(fenced.lost(), [])
  fenced.release('run-c')
  assert.equal(mine.ownedElsewhere('run-c'), true, 'the old owner cannot release the new owner\'s claim')
  db.close()
  console.log('✓ ownership: live owners hold runs through sleep; dead pids and pre-reboot claims do not; a taken-over run is fenced')
}

class CountingSignal {
  readonly controller = new AbortController()
  listeners = 0
  get signal(): AbortSignal {
    const signal = this.controller.signal
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => { this.listeners += 1; add(...args) }) as AbortSignal['addEventListener']
    signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => { this.listeners -= 1; remove(...args) }) as AbortSignal['removeEventListener']
    return signal
  }
}

async function governor(): Promise<void> {
  const governor = new ConcurrencyGovernor({ initial: 1, growthLimit: 1 })
  const request = (sessionId: string, signal: AbortSignal): GenerateOptions => ({ provider: 'p', model: 'm', messages: [], sessionId, signal }) as unknown as GenerateOptions
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const stream = (wait: Promise<void>) => async function * (): AsyncIterable<StreamChunk> {
    await wait
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  }
  const drain = async (iterable: AsyncIterable<StreamChunk>): Promise<void> => { for await (const _ of iterable) { /* consume */ } }
  const first = new CountingSignal()
  const firstSignal = first.signal
  const holder = drain(governor.govern(request('dwf-r-a_1', firstSignal), stream(gate)))
  await new Promise(resolve => setTimeout(resolve, 5))
  const queued = new CountingSignal()
  const queuedRun = drain(governor.govern(request('dwf-r-a_2', queued.signal), stream(Promise.resolve())))
  const kept = new CountingSignal()
  const keptRun = drain(governor.govern(request('dwf-r-a_3', kept.signal), stream(Promise.resolve())))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(governor.snapshot()[0]!.waiters, 2)
  queued.controller.abort(new Error('user stop'))
  await assert.rejects(queuedRun, /user stop/u)
  assert.equal(governor.snapshot()[0]!.waiters, 1, 'the aborted waiter left the queue')
  release!()
  await holder
  await keptRun
  assert.equal(kept.listeners, 0, 'an admitted waiter removed its abort listener')
  assert.equal(governor.snapshot()[0]!.waiters, 0)
  governor.dispose()
  console.log('✓ governor: an aborted waiter leaves the queue; admitted waiters leave no abort listener behind')
}

async function world(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dwf-world-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'src', 'a:1:b.ts'), 'const x = 1\nneedle: here\n')
  writeFileSync(join(root, 'src', 'plain.ts'), 'needle\n')
  writeFileSync(join(root, 'node_modules', 'dep', 'index.ts'), 'needle\n')
  const fs = createNodeFileSystemPort()
  const text = await fs.searchText({ path: root, pattern: 'needle', headLimit: 50 } as never)
  const hits = text.entries.map(e => `${e.path}#${e.lineNumber}#${e.text}`).sort()
  assert.deepEqual(hits, ['src/a:1:b.ts#2#needle: here', 'src/plain.ts#1#needle'], 'colon file names parse exactly; node_modules is skipped')
  const files = await fs.searchFiles({ path: root, pattern: '**/*.ts', maxResults: 50 } as never)
  assert.deepEqual(files.files.map(f => f.slice(root.length + 1)).sort(), ['src/a:1:b.ts', 'src/plain.ts'], 'glob skips node_modules like the walker')
  console.log('✓ world: rg results parse NUL-delimited paths and skip the same directories as the fallback walker')

  // a stopped run kills the command it is waiting on
  const controller = new AbortController()
  const started = Date.now()
  const pending = executeWorldRead({ fileSystemPort: fs, executionPort: createNodeExecutionPort(), cwd: root, signal: controller.signal }, 'run', ['sleep', ['30'], { timeoutMs: 60_000 }])
  setTimeout(() => controller.abort('user'), 150)
  await assert.rejects(pending)
  assert.ok(Date.now() - started < 5_000, `cancel took ${Date.now() - started} ms`)
  console.log(`✓ world: cancelling the run killed a 30 s world.run after ${Date.now() - started} ms`)

  // …and everything the command started: a grandchild holding the pipe dies with it
  if (process.platform !== 'win32') {
    const pidFile = join(root, 'grandchild.pid')
    const tree = new AbortController()
    const running = executeWorldRead({ fileSystemPort: fs, executionPort: createNodeExecutionPort(), cwd: root, signal: tree.signal }, 'run', ['sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 60_000 }])
    const readPid = (): number => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : 0)
    for (let i = 0; i < 200 && !(readPid() > 0); i += 1) await new Promise(resolve => setTimeout(resolve, 20))
    const grandchild = readPid()
    assert.ok(grandchild > 0, 'the grandchild started')
    tree.abort('user')
    await assert.rejects(running)
    await new Promise(resolve => setTimeout(resolve, 1200))
    const alive = (() => { try { process.kill(grandchild, 0); return true } catch { return false } })()
    assert.equal(alive, false, `grandchild ${grandchild} must be gone after cancel`)
    console.log('✓ world: cancel ends the whole process tree (the grandchild is gone too)')
  }
  rmSync(root, { recursive: true, force: true })
}

function steps(): void {
  const run = { nodes: Array.from({ length: 4 }, (_, i) => ({ phase: i < 3 ? 'settled' : 'running' })), usage: { nodesUsed: 5, nodesUnlisted: 6, nodesUnlistedSettled: 2 } } as unknown as WorkflowRunState
  assert.deepEqual(taskCounts(run), { done: 5, total: 10 }, 'unlisted nodes count toward the total')
  console.log('✓ steps: the task count includes nodes outside the listed table')
}

function quotaAndRoutes(): void {
  assert.deepEqual(classifyChildFailure({ code: 'RATE_LIMIT', message: '429 Too Many Requests: 今日额度已用尽，请明日再试' }), { kind: 'stop', stop: 'quota' })
  assert.deepEqual(classifyChildFailure({ code: 'HTTP_429', message: '账户余额不足' }), { kind: 'stop', stop: 'quota' })
  assert.deepEqual(classifyChildFailure({ code: 'RATE_LIMIT', message: '429 rate limit, slow down' }), { kind: 'transient' })
  assert.deepEqual(classifyChildFailure({ code: 'RATE_LIMIT', message: '请求过于频繁，请稍后再试' }), { kind: 'transient' })
  console.log('✓ quota: Chinese exhausted-quota wording stops the run as quota; plain rate limits stay transient')

  // concurrency changes reach only the run whose bucket moved
  const service = new RunService({} as never)
  const calls: string[] = []
  const entry = (runId: string, subagentModel?: string) => ({ runId, ...subagentModel === undefined ? {} : { subagentModel }, driver: { noteConcurrency: (c: { key: string }) => calls.push(`${runId}:${c.key}`), noteModelRequest: () => undefined } })
  const live = (service as unknown as { live: Map<string, unknown> }).live
  live.set('r1', entry('r1'))
  live.set('r2', entry('r2', 'p/m2'))
  live.set('r3', entry('r3'))
  service.noteModelRequest('dwf-r1-actor_1_1', 'waiting', 'p/m1')
  service.noteConcurrencyChange({ key: 'p/m2', previous: 4, next: 2, reason: 'rate_limited' })
  service.noteConcurrencyChange({ key: 'p/m1', previous: 4, next: 3, reason: 'rate_limited' })
  assert.deepEqual(calls, ['r2:p/m2', 'r1:p/m1'], `cross-talk: ${calls.join(', ')}`)
  console.log('✓ concurrency: a bucket change is recorded only by runs on that bucket (session-model runs learn theirs from their requests)')
}

function confirmSettings(): void {
  assert.deepEqual(parseSettings('{"maxConcurrency":8,"subagentModel":"p/m"}'), { maxConcurrency: 8, subagentModel: 'p/m' })
  assert.deepEqual(parseSettings('{"subagentModel":null}'), { subagentModel: null })
  assert.equal(parseSettings('{"maxConcurrency":0,"subagentModel":"no-slash"}'), undefined, 'out-of-range and malformed values are ignored')
  assert.equal(parseSettings('not json'), undefined)
  const adjusted = applyConfirmedSettings({ maxConcurrency: 8, subagentModel: null }, { maxConcurrency: 4, subagentModel: 'p/fast' })
  assert.deepEqual({ max: adjusted.maxConcurrency, model: adjusted.subagentModel }, { max: 8, model: undefined })
  assert.match(adjusted.note, /max concurrency 4 → 8, subagent model p\/fast → session model/u)
  assert.equal(applyConfirmedSettings(undefined, { maxConcurrency: 4, subagentModel: undefined }).note, '')
  console.log('✓ confirm: edited settings are validated, applied, and reported to the model')
}

function round3(): void {
  // artifact previews are inert; downloads are attachments
  const html = artifactResponseHeaders('page.html', { contentType: 'text/html', kind: 'file' }, true, 10)
  assert.equal(html['content-type'], 'text/plain; charset=utf-8', 'HTML previews as plain text, never as a document')
  assert.equal(html['content-security-policy'], "sandbox; default-src 'none'")
  assert.equal(artifactResponseHeaders('x.svg', { contentType: 'image/svg+xml' }, true, 1)['content-type'], 'text/plain; charset=utf-8', 'SVG (scriptable) previews as text')
  assert.equal(artifactResponseHeaders('chart.png', { contentType: 'image/png' }, true, 1)['content-type'], 'image/png')
  const download = artifactResponseHeaders('report', { kind: 'markdown' }, false, 1)
  assert.equal(download['content-type'], 'application/octet-stream')
  assert.match(download['content-disposition']!, /^attachment; filename\*=UTF-8''report\.md$/u)
  console.log('✓ artifacts: previews are inert (text/plain or raster image, sandbox CSP); downloads are named attachments')

  // saved workflows: a shadowed global one is reachable by scope; an explicit null is kept
  const home = mkdtempSync(join(tmpdir(), 'dwf-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dwf-proj-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    writeSaved(project, 'global', { name: 'review', description: 'global one', args: { target: { type: 'json', default: 'src' } } }, 'return 1')
    writeSaved(project, 'project', { name: 'review', description: 'project one' }, 'return 2')
    assert.equal(listSaved(project).length, 1, 'by name, the project one hides the global one')
    assert.equal(findSaved(project, 'review')?.scope, 'project')
    assert.equal(findSaved(project, 'review', 'global')?.description, 'global one', 'an explicit scope reaches the shadowed global one')
    const global = findSaved(project, 'review', 'global')!
    assert.deepEqual(resolveSavedArgs(global, { target: null }), { ok: true, args: { target: null } }, 'an explicit null is a value, not "use the default"')
    assert.deepEqual(resolveSavedArgs(global, {}), { ok: true, args: { target: 'src' } })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
  console.log('✓ saved: scope reaches shadowed global workflows; explicit null arguments are kept')

  // the skill gate accepts DSH's own user-invocation injection (<skill_content name=…>), not just a tool call
  const withUserText = (text: string) => ({ session: { deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text }] }] } }) as never
  assert.equal(sessionHasLoadedSkill(withUserText('<skill_content name="dynamic-workflows">\n…</skill_content>')), true)
  assert.equal(sessionHasLoadedSkill(withUserText('please use /dynamic-workflows')), false)
  console.log('✓ skill gate: a user-invoked skill (DSH <skill_content> injection) opens the gate')
}

async function round4(): Promise<void> {
  // L12: glob [!...] negation translates to RegExp [^...]
  {
    const root = mkdtempSync(join(tmpdir(), 'dwf-glob-'))
    try {
      writeFileSync(join(root, 'a.ts'), '1\n')
      writeFileSync(join(root, 'b.ts'), '2\n')
      writeFileSync(join(root, 'c.ts'), '3\n')
      const fs = createNodeFileSystemPort()
      const res = await fs.searchFiles({ path: root, pattern: '[!a].ts', maxResults: 50 } as never)
      const names = res.files.map(f => f.slice(root.length + 1)).sort()
      assert.deepEqual(names, ['b.ts', 'c.ts'], `glob negation must exclude a.ts, got ${names.join(', ')}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    console.log('✓ glob: [!...] character class negation excludes matching files')
  }

  // L3: atomic markInterruptedIfNonTerminal never overwrites a completed run
  {
    const db = new DatabaseSync(':memory:')
    db.exec(JOURNAL_SCHEMA)
    const journal = new SqliteJournal(db)
    const baseRun = (runId: string, status: 'running' | 'completed') => ({
      runId,
      name: runId,
      parentSessionId: 's1',
      scriptHash: 'h',
      scriptText: 'return 1',
      status,
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      timeCreated: Date.now(),
      timeUpdated: Date.now(),
    })
    journal.createRun(baseRun('r-done', 'completed') as never)
    journal.createRun(baseRun('r-live', 'running') as never)
    assert.equal(journal.markInterruptedIfNonTerminal('r-done', { code: 'Interrupted', message: 'gone' }), false)
    assert.equal(journal.getRun('r-done')?.status, 'completed', 'completed run stays completed')
    assert.equal(journal.markInterruptedIfNonTerminal('r-live', { code: 'Interrupted', message: 'gone' }), true)
    assert.equal(journal.getRun('r-live')?.status, 'stopped')
    assert.equal(journal.getRun('r-live')?.stopReason, 'interrupted')
    db.close()
    console.log('✓ journal: atomic markInterruptedIfNonTerminal never overwrites a terminal run')
  }

  // L6: malformed JSON string in SKILL.md frontmatter does not crash
  {
    const dir = mkdtempSync(join(tmpdir(), 'dwf-skill-'))
    try {
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: dynamic-workflows\ndescription: "broken \\x quote"\n---\n\nBody\n')
      const loaded = loadSkillContent(dir)
      assert.ok(loaded !== undefined && loaded.content.includes('Body'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    console.log('✓ skill: malformed JSON quotes in frontmatter degrade cleanly')
  }

  // L5: hole fill with unsupported ask<Date> returns structured compile_failed instead of throwing
  {
    const base = 'phase("Plan");\nconst n = await hole<number>("pick");\nreturn n;\n'
    const compiled = compileOnce(base)
    const holeId = compiled.holes[0]!.siteId
    const fakeEntry = { runId: 'r-fill', scriptText: base, engine: {}, fillQueue: Promise.resolve(), compiled } as never
    const badFill = await fillHole(fakeEntry, { runId: 'r-fill', holeId, body: 'const d = await agent("a").ask<Date>("when"); return 1;' })
    assert.equal(badFill.ok, false)
    if (!badFill.ok) {
      assert.equal(badFill.reason, 'compile_failed')
      assert.ok((badFill.diagnostics?.length ?? 0) > 0, 'structured diagnostics returned for bad ask schema in fill')
    }
    console.log('✓ fill: unsupported ask<Date> schema in hole body returns structured compile_failed')
  }

  // P1: $effort parsing in parseModelSpec & pre-launch validateModels catalog check
  {
    assert.deepEqual(parseModelSpec('p/m$high'), { provider: 'p', model: 'm', reasoningEffort: 'high' })
    assert.deepEqual(parseModelSpec('p/vendor/m$low'), { provider: 'p', model: 'vendor/m', reasoningEffort: 'low' })
    assert.deepEqual(parseModelSpec('p/m'), { provider: 'p', model: 'm' })
    assert.equal(parseModelSpec('no-slash'), undefined)

    const fakeCtx = {
      get: (name: string) => (name === 'llm'
        ? {
          listProviders: () => [{ id: 'p' }],
          listModels: async (provider: string) => (provider === 'p' ? [{ id: 'm1' }, { id: 'm2' }] : []),
        }
        : undefined),
    }
    const svc = new RunService({ ctx: fakeCtx } as never)
    const okCompiled = compileOnce('phase("Run"); return await agent("a").ask("hi");')
    const parent = { options: { provider: 'p', model: 'm1' }, session: {} } as never
    assert.deepEqual(await svc.validateModels(okCompiled, 'p/m2$high', parent), [])
    assert.equal(svc.resolveModelSpec('m2$high', parent), 'p/m2$high', 'bare model id resolves within session provider')
    assert.deepEqual(await svc.validateModels(okCompiled, 'm2$high', parent), [], 'validateModels accepts bare model id on session provider')
    const unknownBare = await svc.validateModels(okCompiled, 'nonexistent', parent)
    assert.equal(unknownBare.length, 1)
    assert.match(unknownBare[0]!, /not available/iu)
    const unknownModel = await svc.validateModels(okCompiled, 'p/nonexistent', parent)
    assert.equal(unknownModel.length, 1)
    assert.match(unknownModel[0]!, /not available/iu)
    const unknownProvider = await svc.validateModels(okCompiled, 'ghost/m1', parent)
    assert.equal(unknownProvider.length, 1)
    assert.match(unknownProvider[0]!, /unknown provider/iu)
    console.log('✓ models: $effort parsed to reasoningEffort; bare ids resolve inside session provider; validateModels rejects unknown models & providers')
  }

  // P1: HTTP routes fail-closed owner check + NaN retune guard + preset artifact routes
  {
    type Handler = (req: unknown, res: unknown, peer?: unknown) => Promise<void>
    let handler: Handler | undefined
    const fakeCtx = {
      inject: (_names: string[], cb: (scope: unknown) => void) => cb(fakeCtx),
      effect: (fn: () => void) => fn(),
      get: (name: string) => (name === 'webServer'
        ? { register: (route: { handler: Handler }) => { handler = route.handler; return () => undefined } }
        : undefined),
    }
    const fakeService = {
      artifacts: () => [{ id: 'perf', kind: 'chart', version: 1, versions: [{ version: 1, publishedAt: 1 }], itemCount: 1 }],
      artifactData: (_runId: string, _id: string, opts: { afterSequence?: number; limit?: number; fields?: readonly string[] }) => ({
        items: [{ sequence: 5, siteId: 'r#1', ordinal: 1, fields: { round: 1, ms: 42 }, _opts: opts }],
        hasMore: false,
      }),
      retune: () => ({ ok: true, applied: 4 }),
      snapshot: () => ({}),
    }
    registerWorkflowRoutes(fakeCtx as never, {
      service: fakeService as never,
      artifacts: { read: async () => undefined } as never,
    })
    assert.ok(handler !== undefined, 'workflow route handler registered')
    const call = async (method: string, path: string, body?: unknown, peer?: unknown): Promise<{ status: number; body: unknown }> => {
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const req = {
        method,
        url: path,
        headers: { 'x-dynamic-workflow-request': '1', host: 'localhost' },
        [Symbol.asyncIterator]: async function * () { for (const chunk of payload) yield chunk },
      }
      let status = 200
      let raw = ''
      const res = {
        writeHead: (code: number) => { status = code },
        end: (data?: string) => { if (data !== undefined) raw += data },
      }
      await handler!(req, res, peer)
      return { status, body: raw === '' ? undefined : JSON.parse(raw) as unknown }
    }
    // Fail-closed: missing caller (401) or non-owner principal (403)
    const noCaller = await call('POST', '/dynamic-workflow/api/runs/r1/retune', { maxConcurrency: 4 })
    assert.equal(noCaller.status, 401, 'POST without caller must fail closed (401)')
    const guest = await call('POST', '/dynamic-workflow/api/runs/r1/retune', { maxConcurrency: 4 }, { principal: { kind: 'guest' } })
    assert.equal(guest.status, 403, 'POST with non-owner principal must fail closed (403)')
    const noPrincipal = await call('POST', '/dynamic-workflow/api/runs/r1/retune', { maxConcurrency: 4 }, {})
    assert.equal(noPrincipal.status, 403, 'POST with peer missing principal must fail closed (403)')
    // NaN / non-finite maxConcurrency gets 400
    const badRetune = await call('POST', '/dynamic-workflow/api/runs/r1/retune', { maxConcurrency: 'abc' }, { principal: { kind: 'owner' } })
    assert.equal(badRetune.status, 400, 'non-finite maxConcurrency returns 400')
    // Preset artifact routes
    const listRes = await call('GET', '/dynamic-workflow/api/runs/r1/artifacts', undefined, { principal: { kind: 'owner' } })
    assert.equal(listRes.status, 200)
    assert.equal((listRes.body as { artifacts: unknown[] }).artifacts.length, 1)
    const dataRes = await call('GET', '/dynamic-workflow/api/runs/r1/artifacts/perf/data?after=0&limit=50&fields=round,ms', undefined, { principal: { kind: 'owner' } })
    assert.equal(dataRes.status, 200)
    const dataBody = dataRes.body as { items: { sequence: number; fields: { round: number; ms: number } }[]; hasMore: boolean }
    assert.equal(dataBody.items[0]!.fields.ms, 42)
    console.log('✓ routes: POST fails closed without owner principal, guards NaN retune, serves preset artifact data')
  }

  // Save & Distill Workflow routes + fromRunId provenance
  {
    const ws = mkdtempSync(join(tmpdir(), 'dwf-save-route-'))
    const followups: unknown[] = []
    const fakeParent = {
      status: 'idle',
      session: { id: 'sess-owner', header: { cwd: ws } },
      followup: (msg: unknown) => { followups.push(msg) },
    }
    type Handler = (req: unknown, res: unknown, peer?: unknown) => Promise<void>
    let handler: Handler | undefined
    const fakeCtx = {
      agents: new Map([['sess-owner', fakeParent]]),
      inject: (_names: string[], cb: (scope: unknown) => void) => cb(fakeCtx),
      effect: (fn: () => void) => fn(),
      get: (name: string) => (name === 'webServer'
        ? { register: (route: { handler: Handler }) => { handler = route.handler; return () => undefined } }
        : undefined),
    }
    const runScript = 'phase("Run"); return await agent("worker").ask("hello");'
    const fakeService = {
      journal: {
        getRun: (id: string) => (id === 'r-save-1' ? { runId: id, name: '迷你正则引擎', parentSessionId: 'sess-owner', cwd: ws, scriptText: runScript } : undefined),
        listRunLifeSpans: () => [{ startedAt: 1_000, lastActivityAt: 65_000 }],
      },
      liveRun: () => undefined,
      snapshot: () => ({ name: '迷你正则引擎', status: 'completed', spentTokens: 123_456, logTail: [], artifacts: [] }),
    }
    registerWorkflowRoutes(fakeCtx as never, {
      service: fakeService as never,
      artifacts: { read: async () => undefined } as never,
    })
    const owner = { principal: { kind: 'owner' } }
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const req = {
        method,
        url: path,
        headers: { 'x-dynamic-workflow-request': '1', host: 'localhost' },
        [Symbol.asyncIterator]: async function * () { for (const chunk of payload) yield chunk },
      }
      let status = 200
      let raw = ''
      const res = {
        writeHead: (code: number) => { status = code },
        end: (data?: string) => { if (data !== undefined) raw += data },
      }
      await handler!(req, res, owner)
      return { status, body: (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown> }
    }

    const beforeSave = await call('GET', '/dynamic-workflow/api/runs/r-save-1')
    assert.equal(beforeSave.status, 200)
    assert.equal(beforeSave.body.durationMs, 64_000)
    assert.equal(beforeSave.body.canSave, true)
    assert.equal(beforeSave.body.savedAs, null)

    const badName = await call('POST', '/dynamic-workflow/api/runs/r-save-1/save', { name: '../escape', scope: 'project' })
    assert.equal(badName.status, 400)
    assert.equal(badName.body.reason, 'invalid_name')

    const firstSave = await call('POST', '/dynamic-workflow/api/runs/r-save-1/save', { name: 'regex-engine', scope: 'project', description: 'Regex verification' })
    assert.equal(firstSave.status, 200)
    assert.equal(firstSave.body.ok, true)

    const probeTaken = await call('GET', '/dynamic-workflow/api/runs/r-save-1/save-probe?name=regex-engine&scope=project')
    assert.equal(probeTaken.body.taken, true)
    const probeShadow = await call('GET', '/dynamic-workflow/api/runs/r-save-1/save-probe?name=regex-engine&scope=global')
    assert.equal(probeShadow.body.taken, false)
    assert.equal(probeShadow.body.shadowing, true)

    const dupGuard = await call('POST', '/dynamic-workflow/api/runs/r-save-1/save', { name: 'regex-engine', scope: 'project' })
    assert.equal(dupGuard.body.ok, false)
    assert.equal(dupGuard.body.reason, 'target_exists')

    const overwriteOk = await call('POST', '/dynamic-workflow/api/runs/r-save-1/save', { name: 'regex-engine', scope: 'project', overwrite: true })
    assert.equal(overwriteOk.body.ok, true)

    const afterSave = await call('GET', '/dynamic-workflow/api/runs/r-save-1')
    assert.deepEqual(afterSave.body.savedAs, { name: 'regex-engine', scope: 'project', hasRequiredArgs: false })

    const distill = await call('POST', '/dynamic-workflow/api/runs/r-save-1/distill', { name: 'regex-reusable', scope: 'project', description: 'Reusable regex builder', locale: 'zh' })
    assert.equal(distill.status, 200)
    assert.equal(distill.body.ok, true)
    assert.equal(followups.length, 1)
    const injectedText = JSON.stringify(followups[0])
    assert.match(injectedText, /\/dynamic-workflows/u)
    assert.match(injectedText, /from_run_id: \\"r-save-1\\"/u)
    assert.match(injectedText, /regex-reusable/u)

    rmSync(ws, { recursive: true, force: true })
    console.log('✓ save & distill routes: save-probe collision/shadowing, target_exists guard, fromRunId provenance, and 5-point distillation followup verified')
  }

  // P2: Dashboard preset artifact projections (chart / table / metrics / board)
  {
    const chartSpec = parsePresetSpec('chart', { type: 'line', x: { field: 'round' }, y: [{ field: 'ms', unit: 'ms' }], baseline: { field: 'target' } })
    assert.ok(chartSpec?.kind === 'chart')
    assert.deepEqual(specFieldPaths(chartSpec!).sort(), ['ms', 'round', 'target'])
    const chartItems = [
      { sequence: 1, siteId: 'r#1', ordinal: 1, item: { round: 1, ms: 80, target: 30 } },
      { sequence: 2, siteId: 'r#1', ordinal: 2, item: { round: 2, ms: 25, target: 30 } },
    ]
    const projectedChart = projectChart(chartSpec!.spec, chartItems)
    assert.equal(projectedChart.series[0]!.points.length, 2)
    assert.equal(projectedChart.baseline?.value, 30)

    const logSpec = parsePresetSpec('chart', { type: 'scatter', scale: 'log', x: { field: 'x' }, y: { field: 'y' } })
    assert.ok(logSpec?.kind === 'chart')
    const projectedLog = projectChart(logSpec!.spec, [
      { sequence: 1, siteId: 'r#1', ordinal: 1, item: { x: 1, y: 0 } },
      { sequence: 2, siteId: 'r#1', ordinal: 2, item: { x: 2, y: 10 } },
    ])
    assert.equal(projectedLog.series[0]!.points.length, 1, 'log scale skips non-positive y values')

    const tableSpec = parsePresetSpec('table', { key: 'id', columns: [{ field: 'id' }, { field: 'score' }] })
    assert.ok(tableSpec?.kind === 'table')
    const projectedTable = projectTable(tableSpec!.spec, [
      { sequence: 1, siteId: 'r#1', ordinal: 1, item: { id: 'a', score: 1 } },
      { sequence: 2, siteId: 'r#1', ordinal: 2, item: { id: 'a', score: 9 } },
    ])
    assert.equal(projectedTable.rows.length, 1, 'table deduplicates by key')
    assert.equal(projectedTable.rows[0]!.cells[1], 9)

    const metricsSpec = parsePresetSpec('metrics', { metrics: [{ field: 'passed', label: 'Passed' }, { field: 'failed' }] })
    assert.ok(metricsSpec?.kind === 'metrics')
    const projectedMetrics = projectMetrics(metricsSpec!.spec, [
      { sequence: 1, siteId: 'r#1', ordinal: 1, item: { passed: 1, failed: 3 } },
      { sequence: 2, siteId: 'r#1', ordinal: 2, item: { passed: 4 } },
    ])
    assert.equal(projectedMetrics[0]!.value, 4)
    assert.equal(projectedMetrics[1]!.value, 3, 'metric keeps last defined value per field')

    const boardSpec = parsePresetSpec('board', { key: 'id', status: 'state', columns: ['todo', 'done'], cardTitle: 'title', detail: [{ field: 'owner' }] })
    assert.ok(boardSpec?.kind === 'board')
    const projectedBoard = projectBoard(boardSpec!.spec, [
      { sequence: 1, siteId: 'r#1', ordinal: 1, item: { id: '1', state: 'todo', title: 'Fix A', owner: 'alice' } },
      { sequence: 2, siteId: 'r#1', ordinal: 2, item: { id: '1', state: 'done', title: 'Fix A', owner: 'alice' } },
      { sequence: 3, siteId: 'r#1', ordinal: 3, item: { id: '2', state: 'blocked', title: 'Fix B' } },
    ])
    assert.equal(projectedBoard[0]!.cards.length, 0, 'card moved from todo to done')
    assert.equal(projectedBoard[1]!.cards.length, 1)
    assert.equal(projectedBoard[2]!.other, true, 'unknown status goes to Other column')
    console.log('✓ presets: chart/table/metrics/board projections (including log scale, dedup, board move + Other) are exact')
  }

  // P2: Vertical Spine parallel band layout (fork/merge joints + gutter) & 5-pill roster cap
  {
    const parallelScript = `
      phase("Start");
      const s = await agent("start").ask<string>("go");
      const a = future(async () => { phase("Branch A"); return await agent("a").ask<string>(s); });
      const b = future(async () => { phase("Branch B"); return await agent("b").ask<string>(s); });
      const [ra, rb] = await Promise.all([a, b]);
      phase("Finish");
      return await agent("fin").ask<string>(ra + rb);
    `
    const analyzed = analyzeWorkflowScript(parallelScript)
    assert.equal(analyzed.ok, true)
    const graph = displayOf('get_workflow_run', analyzed).causalityGraph
    assert.ok(graph !== undefined)
    const timeline = buildWorkflowTimeline(graph!, undefined)
    const layout = spineLayout(timeline)
    assert.ok(timeline.bands.length >= 1, 'parallel branches fold into a band')
    assert.ok(layout.gutter > 0, `parallel band widens spine gutter (${layout.gutter})`)
    assert.ok(layout.sections.some(s => s.fork !== undefined), 'spine has a fork joint')
    assert.ok(layout.sections.some(s => s.merge !== undefined), 'spine has a merge joint')
    const syntheticPills = Array.from({ length: 8 }, (_, i) => ({
      key: `p${i}`,
      lane: { id: `a${i}`, label: `worker-${i}`, kind: 'actor' },
      laneClass: 'actor',
      status: i === 6 ? 'failed' : i === 7 ? 'running' : 'done',
      stepIds: [],
    }))
    const roster = stationRosterOf({ pills: syntheticPills as never }, ROSTER_PINS_PANE)
    assert.ok(roster !== undefined)
    assert.equal(roster!.pinned.length, ROSTER_PINS_PANE, 'spine pins 5 pills')
    assert.equal(roster!.pinned[0]!.key, 'p7', 'running pill pinned first')
    assert.equal(roster!.pinned[1]!.key, 'p6', 'failed pill pinned second')
    assert.equal(rosterMore(roster!).count, 3, 'remaining 3 pills collapse behind the door')
    assert.equal(rosterRoll(roster!)[0]!.status, 'done')
    console.log('✓ spine: parallel phase bands produce fork/merge joints; >5 pills pin top 5 and fold rest into grouped roll')
  }
}

async function main(): Promise<void> {
  artifacts()
  round3()
  await round4()
  confirmSettings()
  quotaAndRoutes()
  ownership()
  await governor()
  await world()
  steps()
  console.log('HARDENING OK')
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
