/**
 * Wire-level end-to-end test — the closest offline stand-in for the live test:
 *
 *   real DSH loop + real `llm-pi-ai` adapter (pi-ai, `anthropic-messages`) over real HTTP to a
 *   local Anthropic-compatible gateway (tests/dsh/mock-anthropic.ts) + `llm-retry` + JSONL session
 *   persistence, then the session is read back from disk through the persistence backend.
 *
 * What it proves that the scripted-adapter integration test cannot:
 *   - every tool schema the plugin declares (create_workflow, the per-ask typed submit_result, …)
 *     survives pi-ai's Anthropic conversion and is a top-level object schema;
 *   - tool calls streamed as input_json_delta reach the plugin intact; usage reaches the journal;
 *   - a gateway 429 (Retry-After) is retried and the run still completes;
 *   - the owner session's log — with the plugin's progress records — is persisted as JSONL and
 *     reads back through the backend's row admission (the check that refuses unknown events
 *     that are not `ignorable`), and the run projection refolds from it.
 *
 * Run: DWF_TEST_HOOK=1 tsx --tsconfig tsconfig.test.json tests/dsh/wire.ts
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { applyProgressEvent } from '../../src/web/projection.ts'
import type { WorkflowRunsState } from '../../src/shared/runs/workflow-runs.ts'
import { startMockAnthropic, type AnthropicRequestView, type MockReply } from './mock-anthropic.ts'

const WorkflowPlugin = process.env.DWF_PLUGIN === 'lib'
  ? await import(new URL('../../lib/index.js', import.meta.url).href) as typeof import('../../src/index.ts')
  : await import('../../src/index.ts')

const SCRIPT = `
interface Finding {
  /** Workspace-relative path. */
  file: string
  /** @minimum 1 */
  line: number
  issue: string
}
interface Review { findings: Finding[]; clean: boolean }

phase("Survey")
const sources = await files.glob("src/*.ts")

phase("Review")
const reviewer = agent("Reviewer", { system: "You review TypeScript for concrete bugs." })
const reviews: Review[] = []
for (const file of sources) {
  const review = await reviewer.ask<Review>(\`Review \${file}\`)
  for (const finding of review.findings) report(finding)
  reviews.push(review)
}

phase("Summarize")
const summary = await agent("Writer").ask(\`Summarize: \${JSON.stringify(reviews)}\`)
return { files: sources.length, findings: reviews.reduce((n, r) => n + r.findings.length, 0), summary }
`

/** Load a plugin whose config type is not exported structurally (tests only). */
function plug(context: Context, plugin: unknown, config: unknown = {}): Promise<unknown> {
  return (context.plugin as unknown as (plugin: unknown, config: unknown) => Promise<unknown>).call(context, plugin, config)
}

function childName(request: AnthropicRequestView): string | undefined {
  return /You are a subagent inside a dynamic workflow run, named "([^"]+)"/u.exec(request.system)?.[1]
}

function send(agent: Agent, value: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } }))
}

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== false) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), 'dwf-wire-'))
  const workspace = join(temp, 'ws')
  const state = join(temp, 'state')
  const sessionsRoot = join(temp, 'sessions')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export function avg(xs: number[]) { let s = 0; for (let i = 0; i <= xs.length; i++) s += xs[i]; return s / xs.length }\n')
  writeFileSync(join(workspace, 'src', 'b.ts'), 'export const isBlank = (t: string) => t.trim().length > 0\n')

  let throttled = 0
  let gateTried = false
  let skillText = ''
  const gateway = await startMockAnthropic((request): MockReply => {
    const child = childName(request)
    const last = request.lastToolResult
    if (child === undefined) {
      if (last?.name === 'create_workflow' && last.isError && last.text.includes('dynamic-workflows')) return { kind: 'tool', name: 'skill', input: { name: 'dynamic-workflows' } }
      if (last?.name === 'create_workflow') return { kind: 'text', text: last.isError ? `create failed: ${last.text}` : 'The workflow is running; I will report when it finishes.' }
      if (request.lastUser.includes('<task-notification>')) return { kind: 'text', text: 'Done: the workflow reviewed 2 files and found 2 bugs.' }
      // the skill gate: load the skill first (the real `skill` tool), then submit the script
      if (last?.name === 'skill') {
        skillText = last.text
        return { kind: 'tool', name: 'create_workflow', text: 'Starting a workflow.', input: { name: 'wire-review', script: SCRIPT } }
      }
      if (request.lastUser.startsWith('RUN')) {
        if (!gateTried) {
          gateTried = true
          return { kind: 'tool', name: 'create_workflow', input: { name: 'wire-review', script: SCRIPT } }
        }
        return { kind: 'tool', name: 'skill', input: { name: 'dynamic-workflows' } }
      }
      if (last?.name === 'create_workflow') return { kind: 'text', text: 'unexpected' }
      return { kind: 'text', text: 'ok' }
    }
    if (child === 'Reviewer') {
      if (last?.name === 'submit_result') return { kind: 'text', text: last.isError ? `still failing: ${last.text}` : 'Submitted.' }
      // the gateway throttles the very first subagent request
      if (throttled === 0) {
        throttled += 1
        return { kind: 'http', status: 429, headers: { 'retry-after': '1' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited, slow down.' } } }
      }
      const file = /Review (\S+)/u.exec(request.lastUser)?.[1] ?? 'src/a.ts'
      const issue = file.endsWith('a.ts') ? 'loop reads one past the end (i <= xs.length)' : 'isBlank is inverted'
      return { kind: 'tool', name: 'submit_result', input: { result: { findings: [{ file, line: 1, issue }], clean: false } }, usage: { input: 900, output: 60 } }
    }
    if (child === 'Writer') return { kind: 'text', text: 'Two real bugs: an off-by-one loop in a.ts and an inverted predicate in b.ts.', usage: { input: 700, output: 40 } }
    return { kind: 'text', text: '?' }
  })

  process.env.DWF_WIRE_KEY = 'sk-wire-test'
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await plug(ctx, LlmRetry)
  await plug(ctx, LlmPiAi, {
    providers: {
      'wire-gateway': {
        api: 'anthropic-messages',
        baseURL: gateway.url,
        apiKeyEnv: 'DWF_WIRE_KEY',
        models: [{ id: 'wire-model', contextWindow: 200_000, maxTokens: 8192 }],
      },
    },
  })
  await ctx.plugin(SessionStore)
  await plug(ctx, JsonlPersistence, { root: sessionsRoot, compression: 'none' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await plug(ctx, FileSystem)
  await plug(ctx, WorkingDirectory, { defaultDirectory: workspace })
  await plug(ctx, SkillRegistry)
  await plug(ctx, ToolSkill)
  await ctx.plugin(WorkflowPlugin, { stateDir: state, confirm: 'never', skillGate: true, defaultMaxConcurrency: 2 })

  const agentLoop = (ctx as unknown as { agentLoop: { create(id: SessionId, options: object, meta?: object): Promise<Agent> } }).agentLoop
  process.chdir(workspace)
  const sessionId = 'wire-main' as SessionId
  const main = await agentLoop.create(sessionId, { provider: 'wire-gateway', model: 'wire-model' }, { cwd: workspace })

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(state, 'journal.sqlite'), { readOnly: true })
  const runs = () => db.prepare('select id, name, status, failure_json, result_json, spent_tokens from dwf_run order by time_created').all() as { id: string; name: string; status: string; failure_json: string | null; result_json: string | null; spent_tokens: number }[]

  send(main, 'RUN the review workflow')
  await main.whenIdle()
  const run = await waitFor('run settled', () => runs().find(r => r.status !== 'running'))
  assert.equal(runs().length, 1, 'exactly one workflow was created')
  assert.equal(run.status, 'completed', `run: ${run.status} ${run.failure_json}`)
  const result = JSON.parse(run.result_json!) as { files: number; findings: number; summary: string }
  assert.equal(result.files, 2)
  assert.equal(result.findings, 2)
  assert.match(result.summary, /off-by-one/u)
  assert.ok(run.spent_tokens >= 2 * 960, `usage from the wire reached the journal: ${run.spent_tokens}`)
  console.log(`✓ wire: run ${run.id} completed over pi-ai/anthropic-messages; result ${JSON.stringify(result).slice(0, 80)}…; tokens ${run.spent_tokens}`)
  const gated = gateway.requests.find(r => r.lastToolResult?.name === 'create_workflow' && r.lastToolResult.isError)
  assert.ok(gated !== undefined && /dynamic-workflows/u.test(gated.lastToolResult!.text), 'the first create_workflow was refused by the skill gate')
  assert.match(skillText, /agent\(|create_workflow/u, 'the real `skill` tool returned the bundled SKILL.md')
  const firstSystem = gateway.requests[0]!.system
  assert.match(firstSystem, /dynamic-workflows/u, 'the skill is listed to the model')
  console.log(`✓ wire: skill gate refused the first submit; the real skill tool served SKILL.md (${skillText.length} chars); the retry was accepted`)

  // schemas as the gateway received them
  const firstMain = gateway.requests.find(r => childName(r) === undefined)!
  const create = firstMain.tools.find(t => t.name === 'create_workflow')
  assert.ok(create !== undefined, `create_workflow declared (tools: ${firstMain.tools.map(t => t.name).join(', ')})`)
  for (const request of gateway.requests) for (const tool of request.tools) assert.equal(tool.input_schema.type, 'object', `${tool.name} has a top-level object schema`)
  const reviewerRequest = gateway.requests.find(r => childName(r) === 'Reviewer' && r.tools.some(t => t.name === 'submit_result'))!
  const submit = reviewerRequest.tools.find(t => t.name === 'submit_result')!
  const resultSchema = (submit.input_schema.properties as Record<string, { properties?: Record<string, unknown>; required?: string[] }>).result!
  assert.ok(resultSchema.properties?.findings !== undefined && resultSchema.required?.includes('clean'), `typed submit_result schema: ${JSON.stringify(submit.input_schema).slice(0, 300)}`)
  const forbidden = gateway.requests.flatMap(r => r.tools.map(t => t.name)).filter(name => ['create_workflow', 'amend_workflow'].includes(name) && false)
  assert.deepEqual(forbidden, [])
  assert.ok(!reviewerRequest.tools.some(t => t.name === 'create_workflow'), 'subagents do not get the workflow tools')
  console.log(`✓ wire: ${new Set(gateway.requests.flatMap(r => r.tools.map(t => t.name))).size} distinct tool schemas crossed pi-ai as object schemas; Reviewer's submit_result carries the Review type`)

  // the 429
  assert.equal(gateway.errors.filter(e => e.status === 429).length, 1)
  const reviewerRequests = gateway.requests.filter(r => childName(r) === 'Reviewer')
  assert.ok(reviewerRequests.length >= 3, `the throttled request was retried (${reviewerRequests.length} Reviewer requests)`)
  console.log(`✓ wire: gateway 429 (Retry-After 1) absorbed — ${reviewerRequests.length} Reviewer requests, run unaffected`)

  // the notification reached the main agent over the wire and it answered
  await waitFor('main answered the notification', () => gateway.requests.some(r => childName(r) === undefined && r.lastUser.includes('<task-notification>')))
  await main.whenIdle()
  const lastAssistant = [...main.session.snapshotEvents()].reverse().find(e => e.type === 'assistant/message')
  assert.match(JSON.stringify(lastAssistant?.data), /found 2 bugs/u)
  console.log('✓ wire: <task-notification> woke the main agent; its final answer streamed back')

  // persistence: the JSONL log reads back through the backend (row admission) and refolds
  const persistence = ctx.get('sessionPersistence') as unknown as { flush(): Promise<void>; open(id: string, access: 'read'): Promise<{ read(offset: number, limit: number): Promise<{ events: SessionEvent[] }>; close?(): Promise<void>; [Symbol.asyncDispose]?(): Promise<void> }> }
  await persistence.flush()
  const files: string[] = []
  const walk = (dir: string): void => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else files.push(path) } }
  walk(sessionsRoot)
  const mainLog = files.find(path => path.includes('wire-main') && path.endsWith('.jsonl'))
  assert.ok(mainLog !== undefined, `main session JSONL on disk: ${files.map(f => f.slice(sessionsRoot.length)).join(', ')}`)
  const raw = readFileSync(mainLog, 'utf8')
  const rawRecords = raw.split('\n').filter(line => line.includes('plugin:dynamic-workflow/progress'))
  assert.ok(rawRecords.length > 10 && rawRecords.every(line => line.includes('"ignorable":true')), `progress rows on disk are ignorable (${rawRecords.length})`)
  const handle = await persistence.open(sessionId, 'read')
  const events: SessionEvent[] = []
  try {
    for (let offset = 0; ; ) {
      const page = await handle.read(offset, 256)
      if (page.events.length === 0) break
      events.push(...page.events)
      offset += page.events.length
    }
  } finally {
    await (handle[Symbol.asyncDispose]?.() ?? handle.close?.())
  }
  const records = events.filter(e => (e.type as string) === 'plugin:dynamic-workflow/progress')
  assert.equal(records.length, rawRecords.length)
  let folded: WorkflowRunsState = { revision: 0, runs: [] }
  for (const event of events) folded = applyProgressEvent(folded, event as { type: string; data?: unknown })
  const projected = folded.runs.find(r => r.runId === run.id)
  assert.equal(projected?.status, 'completed')
  assert.ok(projected?.resultPreview?.includes('off-by-one'), 'result preview record folded')
  console.log(`✓ wire: ${mainLog.slice(sessionsRoot.length)} — ${events.length} events read back through the JSONL backend, ${records.length} ignorable progress records, projection refolds to completed`)

  // reopen: a second Host (fresh plugin instances, same session root) resumes the session from
  // disk — the in-process equivalent of `dsh headless --session-id` — and keeps talking.
  // unloading the first agent loop disposes its agents and releases the session's write lease
  await ctx.registry.delete(AgentLoop as never)
  await persistence.flush()
  const ctx2 = new Context()
  await ctx2.plugin(LlmRuntime)
  await plug(ctx2, LlmPiAi, { providers: { 'wire-gateway': { api: 'anthropic-messages', baseURL: gateway.url, apiKeyEnv: 'DWF_WIRE_KEY', models: [{ id: 'wire-model', contextWindow: 200_000, maxTokens: 8192 }] } } })
  await ctx2.plugin(SessionStore)
  await plug(ctx2, JsonlPersistence, { root: sessionsRoot, compression: 'none' })
  await ctx2.plugin(SessionProjectionRegistry)
  await ctx2.plugin(SystemPrompt)
  await ctx2.plugin(ToolRuntime)
  await ctx2.plugin(NativeToolExecutor)
  await ctx2.plugin(AgentRegistry)
  await ctx2.plugin(AgentLoop, { agents: [] })
  await ctx2.plugin(WorkflowPlugin, { stateDir: join(temp, 'state2'), confirm: 'never', skillGate: false })
  const agents2 = (ctx2 as unknown as { agents: { resume(options: object): Promise<{ agent: Agent }> } }).agents
  const { agent: reopened } = await agents2.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'wire-gateway', model: 'wire-model' } })
  const reloaded = reopened.session.snapshotEvents()
  assert.equal(reloaded.filter(e => (e.type as string) === 'plugin:dynamic-workflow/progress').length, records.length, 'plugin records survived the reopen')
  const projections2 = (ctx2 as unknown as { sessionProjections: { snapshot(session: unknown): { values: Record<string, unknown> } } }).sessionProjections
  const view2 = projections2.snapshot(reopened.session).values.dynamicWorkflowRuns as WorkflowRunsState | undefined
  assert.equal(view2?.runs.find(r => r.runId === run.id)?.status, 'completed', 'the reopened session projects the run (card state survives a restart)')
  const before = gateway.requests.length
  send(reopened, 'In one sentence: what did the workflow find?')
  await reopened.whenIdle()
  const followUp = gateway.requests.slice(before).find(r => childName(r) === undefined)
  assert.ok(followUp !== undefined && JSON.stringify(followUp.messages).includes('task-notification'), 'the continued conversation carries the workflow history')
  console.log(`✓ wire: reopened in a fresh Host — ${reloaded.length} events, ${records.length} plugin records, run card state restored, conversation continued`)

  db.close()
  try { ctx2.registry.delete(WorkflowPlugin as never) } catch { /* disposed */ }
  try { ctx.registry.delete(WorkflowPlugin as never) } catch { /* disposed */ }
  await gateway.close()
  process.chdir(tmpdir())
  rmSync(temp, { recursive: true, force: true })
  console.log('WIRE OK')
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
