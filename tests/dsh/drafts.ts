/**
 * Drafts as files the model already knows, through DSH's real file tools and observation policy:
 * a create_workflow call whose inline script fails to compile leaves a draft, and the model's
 * very next `edit` of that draft succeeds without a `read` first (DSH's `fs-observation-policy`
 * would otherwise refuse it with FS_NOT_OBSERVED, which the control case proves is active).
 * The resubmission by `path` then compiles. Also checks the pure draft-write approval judgement.
 * Run: tsx --tsconfig tsconfig.test.json tests/dsh/drafts.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { ScriptedModel, text, toolCall } from './scripted-model.ts'
import { isDraftWriteRequest } from '../../src/tools/drafts.ts'

const WorkflowPlugin = await import(process.env.DWF_PLUGIN === 'lib' ? '../../lib/index.js' : '../../src/index.ts')

function plug(context: Context, plugin: unknown, config: unknown = {}): Promise<unknown> {
  return (context.plugin as unknown as (plugin: unknown, config: unknown) => Promise<unknown>).call(context, plugin, config)
}

const BROKEN = 'phase("Count")\nconst n: number = "three"\nreturn n\n'
const FIX = 'phase("Fix")\nreturn await agent("Fixer").ask("Fix the off-by-one in src/a.ts.")\n'

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'dwf-drafts-ws-'))
  const state = mkdtempSync(join(tmpdir(), 'dwf-drafts-state-'))
  writeFileSync(join(workspace, 'unread.txt'), 'hello\n')
  const results: { name: string; isError: boolean; text: string }[] = []
  const outside = mkdtempSync(join(tmpdir(), 'dwf-outside-'))
  let fixerStep = 0
  let failedEdit = false
  let draftPath: string | undefined

  const model = new ScriptedModel(async (request) => {
    const last = request.lastToolResult
    const child = /You are a subagent inside a dynamic workflow run, named "([^"]+)"/u.exec(request.system)?.[1]
    if (child === 'Fixer') {
      // read → edit (ok) → write NOTES (ok) → edit that fails → write outside the workspace → done
      fixerStep += 1
      const a = join(workspace, 'src', 'a.ts')
      switch (fixerStep) {
        case 1: return toolCall('read', { file_path: a })
        case 2: return toolCall('edit', { file_path: a, old_string: 'i <= n', new_string: 'i < n' })
        case 3: return toolCall('write', { file_path: join(workspace, 'src', 'NOTES.md'), content: '# notes\nfixed the loop\n' })
        case 4: return toolCall('edit', { file_path: a, old_string: 'no such text', new_string: 'x' })
        case 5: failedEdit = last?.isError === true; return toolCall('write', { file_path: join(outside, 'leak.txt'), content: 'outside\n' })
        default: return text('fixed')
      }
    }
    if (request.lastUser === 'FIX' && last === undefined) return toolCall('create_workflow', { name: 'fix', script: FIX })
    if (last !== undefined) results.push(last)
    if (request.lastUser === 'CONTROL' && last === undefined) return toolCall('edit', { file_path: join(workspace, 'unread.txt'), old_string: 'hello', new_string: 'bye' })
    if (request.lastUser === 'RUN' && last === undefined) return toolCall('create_workflow', { name: 'count', script: BROKEN })
    if (last?.name === 'create_workflow' && last.isError === false && draftPath === undefined) {
      draftPath = /(\.dsh\/workflow-drafts\/[^\s`'"]+\.dwf\.ts)/u.exec(last.text)?.[1]
      if (draftPath === undefined) return text(`no draft path in: ${last.text.slice(0, 300)}`)
      return toolCall('edit', { file_path: join(workspace, draftPath), old_string: 'const n: number = "three"', new_string: 'const n: number = 3' })
    }
    if (last?.name === 'create_workflow' && last.isError === false) return text('started')
    if (last?.name === 'edit' && draftPath !== undefined && !last.isError) return toolCall('create_workflow', { name: 'count', path: draftPath })
    return text('done')
  })

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await plug(ctx, FileSystem)
  await plug(ctx, WorkingDirectory, { defaultDirectory: workspace })
  await plug(ctx, ToolFs)
  await plug(ctx, ObservationPolicy)
  ctx.llm.registerAdapter(['scripted'], model)
  await plug(ctx, WorkflowPlugin, { stateDir: state, confirm: 'never', skillGate: false, defaultMaxConcurrency: 2 })

  const loop = (ctx as unknown as { agentLoop: { create(id: SessionId, options: object, meta?: object): Promise<Agent> } }).agentLoop
  const send = (agent: Agent, value: string): void => agent.followup(createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } }))

  // control: the policy is live — editing a file this session never read is refused
  const control = await loop.create('control-session' as SessionId, { provider: 'scripted', model: 'm' }, { cwd: workspace })
  send(control, 'CONTROL')
  await control.whenIdle()
  const refused = results.find(r => r.name === 'edit')
  assert.ok(refused?.isError === true && /read|FS_NOT_OBSERVED/iu.test(refused.text), `control edit must be refused: ${JSON.stringify(refused)}`)
  results.length = 0
  console.log('✓ drafts: the observation policy is active (editing an unread file is refused)')

  const main = await loop.create('main-session' as SessionId, { provider: 'scripted', model: 'm' }, { cwd: workspace })
  send(main, 'RUN')
  await main.whenIdle()
  const names = results.map(r => `${r.name}:${r.isError ? 'error' : 'ok'}`)
  assert.ok(draftPath !== undefined, `a draft was named: ${names.join(', ')}`)
  const edit = results.find(r => r.name === 'edit')
  assert.ok(edit !== undefined && !edit.isError, `the first edit of the authored draft succeeds without a read: ${JSON.stringify(edit)}`)
  assert.match(readFileSync(join(workspace, draftPath), 'utf8'), /const n: number = 3/u)
  const resubmit = results.filter(r => r.name === 'create_workflow')[1]
  assert.ok(resubmit !== undefined && !resubmit.isError && /started|Run /u.test(resubmit.text), `resubmission by path compiles: ${JSON.stringify(resubmit)}`)
  assert.ok(!results.some(r => r.name === 'read'), 'no read was needed')
  console.log(`✓ drafts: compile diagnostic → edit of ${draftPath} (no read) → resubmit by path started the run`)

  // per-subagent change lens: the Fixer's edit and new file, with exact line counts and a diff
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export function sum(n: number) {\n  let s = 0\n  for (let i = 0; i <= n; i++) s += i\n  return s\n}\n')
  const fixer = await loop.create('fix-session' as SessionId, { provider: 'scripted', model: 'm' }, { cwd: workspace })
  send(fixer, 'FIX')
  await fixer.whenIdle()
  const service = (globalThis as { __dwfTest?: { service?: import('../../src/service/run-service.ts').RunService } }).__dwfTest!.service!
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(state, 'journal.sqlite'), { readOnly: true })
  let fixRun: { id: string; status: string } | undefined
  for (let i = 0; i < 300; i += 1) {
    fixRun = db.prepare("select id, status from dwf_run where name = 'fix'").get() as { id: string; status: string } | undefined
    if (fixRun !== undefined && fixRun.status !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  db.close()
  assert.equal(fixRun?.status, 'completed')
  const changes = service.changes(fixRun!.id)
  assert.equal(changes.length, 1, JSON.stringify(changes))
  assert.equal(changes[0]!.actor, 'Fixer')
  const byPath = Object.fromEntries(changes[0]!.files.map(file => [file.path, file]))
  assert.deepEqual({ added: byPath['src/a.ts']!.added, removed: byPath['src/a.ts']!.removed, created: byPath['src/a.ts']!.created }, { added: 1, removed: 1, created: false })
  assert.equal(byPath['src/a.ts']!.edits, 1, 'the failed edit is not counted')
  assert.ok(!Object.keys(byPath).some(path => path.includes('leak.txt')), 'a file outside the workspace is not followed')
  assert.equal(failedEdit, true, 'the extra edit really failed')
  assert.deepEqual({ added: byPath['src/NOTES.md']!.added, created: byPath['src/NOTES.md']!.created }, { added: 2, created: true })
  const diff = service.changeDiff(fixRun!.id, changes[0]!.sessionId, 'src/a.ts')!.diff!
  assert.match(diff, /^--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n@@ -1,5 \+1,5 @@/u)
  assert.match(diff, /\n-  for \(let i = 0; i <= n; i\+\+\) s \+= i\n\+  for \(let i = 0; i < n; i\+\+\) s \+= i\n/u)
  console.log(`✓ changes: the Fixer's edit (+1 −1) and new file (+2, new) are listed with an exact unified diff`)

  // approval exemption: a file write into the drafts directory is a draft write; anything else is not
  const fakeAgent = (args: object) => ({
    session: {
      header: { cwd: workspace },
      snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'c1', name: 'edit', arguments: JSON.stringify(args) } }],
    },
  }) as unknown as Agent
  assert.equal(isDraftWriteRequest({ agent: fakeAgent({ file_path: join(workspace, '.dsh/workflow-drafts/x.dwf.ts') }), toolName: 'edit', callId: 'c1' }), true)
  assert.equal(isDraftWriteRequest({ agent: fakeAgent({ file_path: '.dsh/workflow-drafts/x.dwf.ts' }), toolName: 'write', callId: 'c1' }), true)
  assert.equal(isDraftWriteRequest({ agent: fakeAgent({ file_path: '.dsh/workflow-drafts/../../src/a.ts' }), toolName: 'edit', callId: 'c1' }), false)
  assert.equal(isDraftWriteRequest({ agent: fakeAgent({ file_path: join(workspace, 'src/a.ts') }), toolName: 'edit', callId: 'c1' }), false)
  assert.equal(isDraftWriteRequest({ agent: fakeAgent({ file_path: '.dsh/workflow-drafts/x.dwf.ts' }), toolName: 'bash', callId: 'c1' }), false)
  console.log('✓ drafts: approval requests for draft writes are exempt; traversal, other files and bash are not')

  try { ctx.registry.delete(WorkflowPlugin as never) } catch { /* disposed */ }
  rmSync(workspace, { recursive: true, force: true })
  rmSync(state, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  console.log('DRAFTS OK')
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
