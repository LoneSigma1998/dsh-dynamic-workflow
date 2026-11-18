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
import { RunOwnership } from '../../src/journal/journal.ts'
import { JOURNAL_SCHEMA } from '../../src/journal/schema.ts'
import { createArtifactStore } from '../../src/service/artifacts.ts'
import { createNodeExecutionPort, createNodeFileSystemPort } from '../../src/world/ports.ts'
import { executeWorldRead } from '../../src/world/world-read.ts'
import { taskCounts } from '../../src/client/run-view.ts'
import { classifyChildFailure } from '../../src/driver/model-failure.ts'
import { RunService } from '../../src/service/run-service.ts'
import { parseSettings } from '../../src/tools/confirm.ts'
import { applyConfirmedSettings } from '../../src/tools/tools.ts'
import { artifactResponseHeaders } from '../../src/web/routes.ts'
import { findSaved, listSaved, resolveSavedArgs, writeSaved } from '../../src/tools/sources.ts'
import { sessionHasLoadedSkill } from '../../src/tools/skill-gate.ts'
import type { WorkflowRunState } from '../../src/shared/runs/workflow-runs.ts'

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

async function main(): Promise<void> {
  artifacts()
  round3()
  confirmSettings()
  quotaAndRoutes()
  ownership()
  await governor()
  await world()
  steps()
  console.log('HARDENING OK')
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
