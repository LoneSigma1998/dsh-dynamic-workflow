/**
 * The per-ask web search budget (ZCode parity): a subagent whose persona says
 * `budget: { webSearch: 2 }` gets two searches per ask; the third is refused before the tool
 * runs, with the message that tells it to finish from what it has. Real DSH AgentLoop + tools.
 * Run: DWF_TEST_HOOK=1 tsx --tsconfig tsconfig.test.json tests/dsh/budget.ts
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
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ScriptedModel, text, toolCall } from './scripted-model.ts'

const WorkflowPlugin = await import(process.env.DWF_PLUGIN === 'lib' ? '../../lib/index.js' : '../../src/index.ts')

function plug(context: Context, plugin: unknown, config: unknown = {}): Promise<unknown> {
  return (context.plugin as unknown as (plugin: unknown, config: unknown) => Promise<unknown>).call(context, plugin, config)
}

const SCRIPT = `
interface Answer { summary: string }
phase("Research")
const searcher = agent("Searcher", { budget: { webSearch: 2 } })
return await searcher.ask<Answer>("Find three facts.")
`

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), 'dwf-budget-'))
  let searches = 0
  const refusals: string[] = []
  const model = new ScriptedModel(async (request) => {
    const child = /You are a subagent inside a dynamic workflow run, named "([^"]+)"/u.exec(request.system)?.[1]
    const last = request.lastToolResult
    if (child === undefined) {
      if (request.lastUser === 'RUN' && last === undefined) return toolCall('create_workflow', { name: 'research', script: SCRIPT })
      return text('ok')
    }
    if (last?.name === 'web_search' && last.isError) refusals.push(last.text)
    if (last?.name === 'submit_result' && !last.isError) return text('done')
    if (refusals.length === 0) return toolCall('web_search', { query: `fact ${searches + 1}` })
    return toolCall('submit_result', { result: { summary: 'two facts; search budget cut the third' } })
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
  ctx.llm.registerAdapter(['scripted'], model)
  ;(ctx as unknown as { tools: { register(definition: unknown): () => void } }).tools.register({
    name: 'web_search',
    description: 'Search the web.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    output: { schema: { type: 'string' }, render: (value: string) => [{ type: 'text', text: value }] },
    execute: async () => { searches += 1; return `result ${searches}` },
  })
  const state = join(temp, 'state')
  await plug(ctx, WorkflowPlugin, { stateDir: state, confirm: 'never', skillGate: false })
  const loop = (ctx as unknown as { agentLoop: { create(id: SessionId, options: object, meta?: object): Promise<Agent> } }).agentLoop
  const main = await loop.create('budget-main' as SessionId, { provider: 'scripted', model: 'm' }, { cwd: temp })
  main.followup(createUserMessage({ content: [{ type: 'text', text: 'RUN' }], source: { kind: 'user' } }))
  await main.whenIdle()
  const db = new DatabaseSync(join(state, 'journal.sqlite'), { readOnly: true })
  const deadline = Date.now() + 30_000
  let row: { status: string } | undefined
  while (Date.now() < deadline) {
    row = db.prepare('select status from dwf_run').get() as { status: string } | undefined
    if (row !== undefined && row.status !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(row?.status, 'completed')
  assert.equal(searches, 2, 'exactly the budget ran')
  assert.equal(refusals.length, 1)
  assert.match(refusals[0]!, /Search budget exhausted: at most 2 web searches per task/u)
  db.close()
  console.log(`✓ budget: 2 searches ran, the third was refused before the tool ran ("${refusals[0]!.slice(0, 60)}…"), the run completed`)
  try { ctx.registry.delete(WorkflowPlugin as never) } catch { /* disposed */ }
  rmSync(temp, { recursive: true, force: true })
  console.log('BUDGET OK')
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
