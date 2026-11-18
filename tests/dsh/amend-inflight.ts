/**
 * Amending a run while one of its asks is in flight continues that ask instead of restarting it
 * (ZCode parity: transcript counts + quiescence + in-flight import), with real JSONL session
 * persistence underneath. The predecessor's Counter finished step A and is mid-way through
 * step B when the main agent amends the script; the amended run answers step A from the cache
 * and re-asks step B inside a session seeded with the predecessor's half-finished exchange.
 * Run: DWF_TEST_HOOK=1 tsx --tsconfig tsconfig.test.json tests/dsh/amend-inflight.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ScriptedModel, text, toolCall, type RequestView } from './scripted-model.ts'

const WorkflowPlugin = await import(process.env.DWF_PLUGIN === 'lib' ? '../../lib/index.js' : '../../src/index.ts')

function plug(context: Context, plugin: unknown, config: unknown = {}): Promise<unknown> {
  return (context.plugin as unknown as (plugin: unknown, config: unknown) => Promise<unknown>).call(context, plugin, config)
}

const SCRIPT = `
interface Count { n: number }
phase("Count")
const counter = agent("Counter")
const a = await counter.ask<Count>("Count step A.")
const b = await counter.ask<Count>("Count step B.")
return { total: a.n + b.n }
`

function userTexts(request: RequestView): string[] {
  return request.messages
    .filter(message => message.role === 'user')
    .map(message => (Array.isArray(message.content) ? message.content : []).map(block => (block as { text?: string }).text ?? '').join(''))
}

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), 'dwf-inflight-'))
  const workspace = join(temp, 'ws')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(workspace)
  const counter = { stepA: 0, stepB: 0, stepBInFlight: false }
  let stepBPrior = 0
  let runId: string | undefined

  const model = new ScriptedModel(async (request) => {
    const child = /You are the subagent "([^"]+)"/u.exec(request.system)?.[1]
    const last = request.lastToolResult
    if (child === undefined) {
      if (request.lastUser.includes('<task-notification>') && last === undefined) return text('noted')
      if (request.lastUser === 'RUN' && last === undefined) return toolCall('create_workflow', { name: 'count', script: SCRIPT })
      if (request.lastUser === 'AMEND' && last === undefined) return toolCall('amend_workflow', { run_id: runId, script: `${SCRIPT}// revised: same asks\n` })
      return text('ok')
    }
    if (last?.name === 'submit_result' && !last.isError) return text('done')
    if (request.lastUser.includes('step A')) {
      counter.stepA += 1
      return toolCall('submit_result', { result: { n: 1 } })
    }
    counter.stepB += 1
    if (counter.stepB === 1) {
      // the predecessor's step B: hang until the run is superseded (the turn is aborted)
      counter.stepBInFlight = true
      await new Promise<void>((_resolve, reject) => {
        const signal = request.signal
        if (signal === undefined) return
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    stepBPrior = userTexts(request).filter(t => t.includes('Count step B.')).length
    return toolCall('submit_result', { result: { n: 2 } })
  })

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await plug(ctx, JsonlPersistence, { root: join(temp, 'sessions'), compression: 'none' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['scripted'], model)
  const state = join(temp, 'state')
  await plug(ctx, WorkflowPlugin, { stateDir: state, confirm: 'never', skillGate: false, defaultMaxConcurrency: 2 })

  const loop = (ctx as unknown as { agentLoop: { create(id: SessionId, options: object, meta?: object): Promise<Agent> } }).agentLoop
  const main = await loop.create('inflight-main' as SessionId, { provider: 'scripted', model: 'm' }, { cwd: workspace })
  const send = (value: string): void => main.followup(createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } }))
  const db = new DatabaseSync(join(state, 'journal.sqlite'), { readOnly: true })
  const runs = () => db.prepare('select id, status, resumed_from, result_json from dwf_run order by time_created').all() as { id: string; status: string; resumed_from: string | null; result_json: string | null }[]

  send('RUN')
  await main.whenIdle()
  runId = await waitFor('run started', () => runs()[0]?.id)
  await waitFor('step B in flight', () => counter.stepBInFlight)
  send('AMEND')
  await main.whenIdle()
  const amended = await waitFor('amended run completed', () => runs().find(r => r.resumed_from === runId && r.status === 'completed'), 40_000)
  assert.deepEqual(JSON.parse(amended.result_json!), { total: 3 })
  assert.equal(counter.stepA, 1, 'step A answered from the import cache')
  assert.equal(counter.stepB, 2, 'step B asked once in each run')
  assert.ok(stepBPrior >= 2, `the amended step B continued the predecessor's half-finished exchange (saw ${stepBPrior} copies of the ask)`)
  const predecessor = runs().find(r => r.id === runId)!
  assert.equal(predecessor.status, 'cancelled', 'the predecessor stopped as superseded')
  db.close()
  console.log(`✓ amend in flight: step A from cache, step B continued in a seeded session (${stepBPrior} copies of the ask in its transcript)`)

  try { ctx.registry.delete(WorkflowPlugin as never) } catch { /* disposed */ }
  rmSync(temp, { recursive: true, force: true })
  console.log('AMEND IN-FLIGHT OK')
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
