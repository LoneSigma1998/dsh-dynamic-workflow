/**
 * End-to-end regression suite against real DSH services (`AgentLoop`, `ToolsService`,
 * `CommandRuntime`, `SessionStore`, SQLite journal) covering all security & feature fixes:
 *
 *   1. P0 `readOnlySubagents`: real `ToolsService.restrict` does not throw when own-scoped
 *      `submit_result` / `escalate` are registered; read-only subagents get only `read` + protocol
 *      tools, while regular subagents exclude denied control/nesting tools.
 *   2. P0 `eval_workflow_snippet`: read-only snippets skip confirmation; `world.run` snippets
 *      require confirmation and respect Deny/Allow; `code` + `path` XOR is enforced.
 *   3. P1 `save_workflow`: enforces `skillGate` AND always requires explicit user confirmation
 *      (never bypassed by "Always allow in this session", and omits the Always option).
 *   4. P1 `amend_workflow`: amending an own run on the same provider skips confirmation;
 *      introducing a new provider via `subagent_model` triggers confirmation.
 *   5. P1 `/dwf stop` & `/dwf resume`: refuse control from any non-owner session.
 *   6. L9 `create_workflow({ saved: null })`: returns a clean tool error without throwing.
 *   7. P2 Preset dashboard artifacts (`chart` / `table` / `metrics` / `board`): end-to-end
 *      declaration + tagged `report(item, id)` + `RunService.artifacts()` + paged field-extracted
 *      `RunService.artifactData()`.
 *
 * Run: DWF_TEST_HOOK=1 tsx --tsconfig tsconfig.test.json tests/dsh/audit-regressions.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CONFIRM_LABELS, CONFIRM_QUESTION_ID } from '../../src/tools/confirm.ts'
import type { RunService } from '../../src/service/run-service.ts'
import { ScriptedModel, text, toolCall, type RequestView } from './scripted-model.ts'

const WorkflowPluginState = (globalThis as { __dwfTest?: { service?: RunService } }).__dwfTest ??= {}
process.env.DWF_TEST_HOOK = '1'
const WorkflowPlugin = process.env.DWF_PLUGIN === 'lib'
  ? await import(new URL('../../lib/index.js', import.meta.url).href) as typeof import('../../src/index.ts')
  : await import('../../src/index.ts')

function plug(context: Context, plugin: unknown, config: unknown = {}): Promise<unknown> {
  return (context.plugin as unknown as (plugin: unknown, config: unknown) => Promise<unknown>).call(context, plugin, config)
}

function send(agent: Agent, content: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } }))
}

function childName(request: RequestView): string | undefined {
  return /You are the subagent "([^"]+)"/u.exec(request.system)?.[1]
}

async function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

interface QuestionAskRecord {
  header?: string
  question: string
  options?: { label: string }[]
}

async function composeHarness(options: {
  pluginConfig?: Record<string, unknown>
  onQuestion?: (record: QuestionAskRecord) => string
  onModel: (request: RequestView) => Promise<ReturnType<typeof text>>
  extraTools?: boolean
  extraProvider?: string
}) {
  const temp = mkdtempSync(join(tmpdir(), 'dwf-audit-'))
  const workspace = join(temp, 'ws')
  const state = join(temp, 'state')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'hello.txt'), 'world\n')

  const model = new ScriptedModel(options.onModel)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await plug(ctx, CommandRuntime)

  const asks: QuestionAskRecord[] = []
  if (options.onQuestion !== undefined) {
    ctx.provide('userQuestions' as never, {
      ask: async (req: { questions: QuestionAskRecord[] }) => {
        const q = req.questions[0]!
        asks.push(q)
        const selected = options.onQuestion!(q)
        return { answers: [{ id: CONFIRM_QUESTION_ID, selected: [selected] }] }
      },
    } as never)
  }

  if (options.extraTools === true) {
    const tools = ctx.get('tools') as { register(def: unknown): () => void }
    for (const name of ['read', 'write', 'bash', 'subagent', 'propose_action', 'present']) {
      tools.register({
        name,
        description: `test ${name}`,
        parameters: { type: 'object', properties: {} },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          render: () => [{ type: 'text', text: `${name}:ok` }],
        },
        execute: async () => ({ ok: true }),
      })
    }
  }

  ctx.llm.registerAdapter(['scripted'], model)
  if (options.extraProvider !== undefined) {
    ctx.llm.registerAdapter([options.extraProvider], model)
  }

  WorkflowPluginState.service = undefined
  await plug(ctx, WorkflowPlugin, {
    stateDir: state,
    confirm: 'never',
    skillGate: false,
    governor: false,
    quotaAutoResume: false,
    ...options.pluginConfig,
  })
  const service = WorkflowPluginState.service!
  assert.ok(service !== undefined, 'plugin published RunService via DWF_TEST_HOOK')

  const loop = (ctx as unknown as { agentLoop: { create(id: SessionId, opts: object, meta?: object): Promise<Agent> } }).agentLoop
  const create = (id: string) => loop.create(id as SessionId, { provider: 'scripted', model: 'm1' }, { cwd: workspace })
  const dispose = async () => {
    try { await service.close() } catch { /* ignore */ }
    try { ctx.registry.delete(WorkflowPlugin as never) } catch { /* ignore */ }
    rmSync(temp, { recursive: true, force: true })
  }
  return { ctx, model, service, asks, workspace, create, dispose }
}

// 1. P0 readOnlySubagents against real DSH ToolsService
async function testReadOnlySubagents(): Promise<void> {
  const seenTools = new Map<string, string[]>()
  const script = `
    interface Verdict { ok: boolean }
    phase("Review and edit");
    const r = await agent("reviewer-1").ask<Verdict>("review");
    const e = await agent("editor-1").ask<Verdict>("edit");
    return { r: r.ok, e: e.ok };
  `
  const h = await composeHarness({
    extraTools: true,
    pluginConfig: { readOnlySubagents: ['reviewer*'] },
    onModel: async (req) => {
      const who = childName(req)
      if (who !== undefined) {
        seenTools.set(who, [...req.tools])
        if (req.lastToolResult?.name === 'submit_result') return text('submitted')
        return toolCall('submit_result', { result: { ok: true } })
      }
      if (req.lastUser.includes('LAUNCH_RO') && req.lastToolResult === undefined) {
        return toolCall('create_workflow', { name: 'ro-test', script })
      }
      return text('done')
    },
  })
  try {
    const main = await h.create('ro-main')
    send(main, 'LAUNCH_RO')
    await main.whenIdle()
    const run = await waitFor('ro-test settled', () => {
      const list = h.service.listRuns('ro-main', 5)
      return list.find(r => r.name === 'ro-test' && r.status !== 'running')
    })
    assert.equal(run.status, 'completed', `readOnlySubagents run must complete cleanly, got ${run.status}: ${JSON.stringify(h.service.snapshot(run.runId).failure)}`)
    const revTools = seenTools.get('reviewer-1') ?? []
    const edTools = seenTools.get('editor-1') ?? []
    assert.ok(revTools.includes('read'), `reviewer-1 must have read: ${revTools.join(', ')}`)
    assert.ok(revTools.includes('submit_result'), `reviewer-1 must have submit_result: ${revTools.join(', ')}`)
    assert.ok(revTools.includes('escalate'), `reviewer-1 must have escalate: ${revTools.join(', ')}`)
    assert.ok(!revTools.includes('write'), `reviewer-1 must NOT have write: ${revTools.join(', ')}`)
    assert.ok(!revTools.includes('bash'), `reviewer-1 must NOT have bash: ${revTools.join(', ')}`)
    assert.ok(!revTools.includes('subagent'), `reviewer-1 must NOT have subagent: ${revTools.join(', ')}`)
    assert.ok(edTools.includes('write') && edTools.includes('bash'), `editor-1 keeps write/bash: ${edTools.join(', ')}`)
    for (const denied of ['create_workflow', 'get_workflow_run', 'subagent', 'propose_action', 'present']) {
      assert.ok(!edTools.includes(denied), `editor-1 must NOT inherit denied tool ${denied}`)
    }
    console.log('✓ P0 readOnlySubagents: real ToolsService.restrict keeps submit_result/escalate + read and drops write/bash')
  } finally {
    await h.dispose()
  }
}

// 2. P0 eval_workflow_snippet confirmation, deny, allow, alwaysAllowed isolation, and code+path XOR
async function testSnippetConfirmation(): Promise<void> {
  let nextAnswer: string = CONFIRM_LABELS.deny
  const results = new Map<string, string>()
  const tinyWorkflow = `phase("Run"); return await agent("w").ask("hi");`
  const h = await composeHarness({
    pluginConfig: { confirm: 'ask' },
    onQuestion: () => nextAnswer,
    onModel: async (req) => {
      if (childName(req) !== undefined) return text('ok')
      if (req.lastToolResult !== undefined) {
        results.set(req.lastUser, req.lastToolResult.text)
        return text('ok')
      }
      if (req.lastUser === 'GRANT_WORKFLOW_ALWAYS') {
        return toolCall('create_workflow', { name: 'grant-always', script: tinyWorkflow })
      }
      if (req.lastUser === 'SNIP_READ') {
        return toolCall('eval_workflow_snippet', { code: `return (await files.glob('*.txt')).length` })
      }
      if (req.lastUser === 'SNIP_RUN_DENY' || req.lastUser === 'SNIP_RUN_ALLOW') {
        return toolCall('eval_workflow_snippet', { code: `return (await world.run('echo', ['hello-snip'])).stdout.trim()` })
      }
      if (req.lastUser === 'SNIP_XOR') {
        return toolCall('eval_workflow_snippet', { code: 'return 1', path: 'hello.txt' })
      }
      return text('ok')
    },
  })
  try {
    const main = await h.create('snip-main')
    // Grant "Always allow in this session" on create_workflow first: snippets MUST remain isolated!
    nextAnswer = CONFIRM_LABELS.always
    send(main, 'GRANT_WORKFLOW_ALWAYS')
    await main.whenIdle()
    await waitFor('grant-always settled', () => h.service.listRuns('snip-main', 5).find(r => r.name === 'grant-always' && r.status !== 'running'))
    await main.whenIdle()
    assert.equal(h.asks.length, 1)

    send(main, 'SNIP_READ')
    await main.whenIdle()
    assert.equal(h.asks.length, 1, 'read-only snippet requires no confirmation')
    assert.match(results.get('SNIP_READ') ?? '', /1/)

    nextAnswer = CONFIRM_LABELS.deny
    send(main, 'SNIP_RUN_DENY')
    await main.whenIdle()
    assert.equal(h.asks.length, 2, 'world.run snippet prompts confirmation even when workflow alwaysAllowed is active')
    assert.match(h.asks[1]!.question, /echo/)
    const snipOptions = (h.asks[1]!.options ?? []).map(o => o.label)
    assert.ok(!snipOptions.includes(CONFIRM_LABELS.always), `snippet confirm must omit Always allow option: ${snipOptions.join(', ')}`)
    assert.match(results.get('SNIP_RUN_DENY') ?? '', /declined|denied/iu)

    nextAnswer = CONFIRM_LABELS.allow
    send(main, 'SNIP_RUN_ALLOW')
    await main.whenIdle()
    assert.equal(h.asks.length, 3)
    assert.match(results.get('SNIP_RUN_ALLOW') ?? '', /hello-snip/)

    send(main, 'SNIP_XOR')
    await main.whenIdle()
    assert.match(results.get('SNIP_XOR') ?? '', /exactly one of `code` or `path`/iu)
    console.log('✓ P0 eval_workflow_snippet: read-only skips confirm, world.run requires per-call confirm (isolated from alwaysAllowed), XOR enforced')
  } finally {
    await h.dispose()
  }
}

// 3. P1 save_workflow skillGate + mandatory confirmation (not bypassed by alwaysAllowed)
async function testSaveWorkflowSecurity(): Promise<void> {
  let nextAnswer: string = CONFIRM_LABELS.always
  const toolOutputs: string[] = []
  const tinyScript = `phase("Run"); return await agent("w").ask("hi");`
  const h = await composeHarness({
    pluginConfig: { confirm: 'ask', skillGate: true },
    onQuestion: () => nextAnswer,
    onModel: async (req) => {
      if (childName(req) !== undefined) return text('ok')
      if (req.lastToolResult !== undefined) {
        toolOutputs.push(`${req.lastToolResult.name}:${req.lastToolResult.text}`)
        return text('done')
      }
      if (req.lastUser.includes('TRY_SAVE_BEFORE_SKILL')) {
        return toolCall('save_workflow', { name: 'my-flow', description: 'd', script: tinyScript, scope: 'project' })
      }
      if (req.lastUser.includes('GRANT_ALWAYS')) {
        return toolCall('create_workflow', { name: 'grant', script: tinyScript })
      }
      if (req.lastUser.includes('TRY_SAVE_DENY') || req.lastUser.includes('TRY_SAVE_ALLOW')) {
        return toolCall('save_workflow', { name: 'my-flow', description: 'desc', script: tinyScript, scope: 'project' })
      }
      return text('ok')
    },
  })
  try {
    const main = await h.create('save-main')
    const savedPath = join(h.workspace, '.dsh', 'workflows', 'my-flow.dwf.ts')

    // 1) Refused before skill loaded
    send(main, 'TRY_SAVE_BEFORE_SKILL')
    await main.whenIdle()
    assert.equal(h.asks.length, 0)
    assert.equal(existsSync(savedPath), false)
    assert.match(toolOutputs.at(-1) ?? '', /dynamic-workflows/u, 'save_workflow blocked by skill gate')

    // 2) Load skill via user injection & grant "Always allow in this session" on create_workflow
    nextAnswer = CONFIRM_LABELS.always
    send(main, '<skill_content name="dynamic-workflows">loaded</skill_content>\nGRANT_ALWAYS')
    await main.whenIdle()
    await waitFor('grant run settled', () => h.service.listRuns('save-main', 5).find(r => r.name === 'grant' && r.status !== 'running'))
    await main.whenIdle()
    assert.equal(h.asks.length, 1)

    // 3) Even with alwaysAllowed set, save_workflow MUST prompt and offer NO "Always allow" option
    nextAnswer = CONFIRM_LABELS.deny
    send(main, 'TRY_SAVE_DENY')
    await main.whenIdle()
    assert.equal(h.asks.length, 2, 'save_workflow must prompt even when alwaysAllowed is active')
    const saveOptions = (h.asks[1]!.options ?? []).map(o => o.label)
    assert.ok(!saveOptions.includes(CONFIRM_LABELS.always), `save_workflow must omit Always allow option: ${saveOptions.join(', ')}`)
    assert.equal(existsSync(savedPath), false, 'denied save_workflow writes nothing')

    // 4) Explicitly allowed -> writes file
    nextAnswer = CONFIRM_LABELS.allow
    send(main, 'TRY_SAVE_ALLOW')
    await main.whenIdle()
    assert.equal(h.asks.length, 3)
    assert.equal(existsSync(savedPath), true, 'allowed save_workflow writes the file')
    console.log('✓ P1 save_workflow: skillGate enforced; always requires explicit confirmation (never bypassed by alwaysAllowed)')
  } finally {
    await h.dispose()
  }
}

// 4. P1 amend_workflow new-provider confirmation + bare subagent_model resolution + L9 saved: null
async function testAmendNewProviderAndNullSaved(): Promise<void> {
  const baseScript = `phase("One"); return await agent("a").ask("step 1");`
  const sameProvScript = `phase("One"); const x = await agent("a").ask("step 1"); return x + "!";`
  let baseRunId = ''
  const outputs = new Map<string, string>()
  const childModels: { provider: string; model: string; reasoningEffort?: string }[] = []
  const h = await composeHarness({
    extraProvider: 'alt',
    pluginConfig: { confirm: 'ask' },
    onQuestion: () => CONFIRM_LABELS.allow, // once only, NOT always
    onModel: async (req) => {
      if (childName(req) !== undefined) {
        childModels.push({ provider: req.provider, model: req.model, ...req.reasoningEffort === undefined ? {} : { reasoningEffort: req.reasoningEffort } })
        return text('ok')
      }
      if (req.lastToolResult !== undefined) {
        outputs.set(req.lastUser, req.lastToolResult.text)
        return text('done')
      }
      if (req.lastUser === 'LAUNCH_BASE') return toolCall('create_workflow', { name: 'base', script: baseScript, subagent_model: 'm2$high' })
      if (req.lastUser === 'AMEND_SAME') return toolCall('amend_workflow', { run_id: baseRunId, script: sameProvScript })
      if (req.lastUser === 'AMEND_NEW_PROV') return toolCall('amend_workflow', { run_id: baseRunId, subagent_model: 'alt/m2' })
      if (req.lastUser === 'SAVED_NULL') return toolCall('create_workflow', { saved: null })
      return text('ok')
    },
  })
  try {
    const main = await h.create('amend-main')
    send(main, 'LAUNCH_BASE')
    await main.whenIdle()
    const base = await waitFor('base settled', () => h.service.listRuns('amend-main', 5).find(r => r.name === 'base' && r.status !== 'running'))
    baseRunId = base.runId
    await main.whenIdle()
    assert.equal(base.status, 'completed', `base run failed: ${JSON.stringify(h.service.snapshot(baseRunId).failure)}`)
    assert.equal(h.asks.length, 1, 'initial launch asked once')
    assert.deepEqual(childModels[0], { provider: 'scripted', model: 'm2', reasoningEffort: 'high' }, 'bare subagent_model "m2$high" resolved inside session provider "scripted" with reasoningEffort')

    // Amend same provider -> own-session fast path skips confirmation
    send(main, 'AMEND_SAME')
    await main.whenIdle()
    await waitFor('amend same settled', () => h.service.listRuns('amend-main', 5).find(r => r.runId !== baseRunId && r.status !== 'running'))
    await main.whenIdle()
    assert.equal(h.asks.length, 1, 'own-session amend on same provider skips confirmation')

    // Amend introducing new provider 'alt' -> MUST ask confirmation!
    send(main, 'AMEND_NEW_PROV')
    await main.whenIdle()
    assert.equal(h.asks.length, 2, 'amend introducing a new provider must ask confirmation')

    // L9: saved: null returns clean error without TypeError
    send(main, 'SAVED_NULL')
    await main.whenIdle()
    assert.match(outputs.get('SAVED_NULL') ?? '', /saved|object|one of/iu)
    console.log('✓ P1 amend_workflow, bare model id & L9: bare subagent_model resolves inside session provider; same-provider amend skips confirm; new provider asks confirm; saved: null handled cleanly')
  } finally {
    await h.dispose()
  }
}

// 5. P1 /dwf stop & /dwf resume ownership check
async function testDwfCommandOwnership(): Promise<void> {
  let releaseChild: (() => void) | undefined
  const childGate = new Promise<void>(resolve => { releaseChild = resolve })
  let childEntered = false
  const slowScript = `phase("Wait"); return await agent("slow").ask("hold");`
  const h = await composeHarness({
    onModel: async (req) => {
      if (childName(req) !== undefined) {
        childEntered = true
        await childGate
        return text('finished')
      }
      if (req.lastUser === 'START_SLOW' && req.lastToolResult === undefined) {
        return toolCall('create_workflow', { name: 'owned-slow', script: slowScript })
      }
      return text('ok')
    },
  })
  const execCmd = async (agent: Agent, line: string): Promise<string> => {
    const commands = (h.ctx as unknown as { commands: { execute(a: Agent, l: string, att: never[], s: AbortSignal): Promise<{ result: { text?: string } } | undefined> } }).commands
    const out = await commands.execute(agent, line, [], new AbortController().signal)
    return out?.result?.text ?? ''
  }
  try {
    const owner = await h.create('cmd-owner')
    const intruder = await h.create('cmd-intruder')
    send(owner, 'START_SLOW')
    await owner.whenIdle()
    const run = await waitFor('slow run started', () => h.service.listRuns('cmd-owner', 5).find(r => r.name === 'owned-slow'))
    await waitFor('child entered', () => (childEntered ? true : undefined))

    // Intruder cannot /dwf stop
    const stopDenied = await execCmd(intruder, `/dwf stop ${run.runId}`)
    assert.match(stopDenied, /another session/iu, `intruder /dwf stop must be refused: ${stopDenied}`)
    assert.ok(h.service.liveRun(run.runId) !== undefined, 'run stays live after intruder /dwf stop')

    // Owner CAN /dwf stop
    const stopOk = await execCmd(owner, `/dwf stop ${run.runId}`)
    assert.match(stopOk, /Stopping/u)
    releaseChild!()
    await waitFor('run stopped', () => h.service.listRuns('cmd-owner', 5).find(r => r.runId === run.runId && r.status === 'stopped'))
    await owner.whenIdle()

    // Intruder cannot /dwf resume
    const resumeDenied = await execCmd(intruder, `/dwf resume ${run.runId}`)
    assert.match(resumeDenied, /another session/iu, `intruder /dwf resume must be refused: ${resumeDenied}`)
    console.log('✓ P1 /dwf commands: non-owner /dwf stop and /dwf resume are refused')
  } finally {
    releaseChild?.()
    await h.dispose()
  }
}

// 6. P2 Preset dashboard artifacts end-to-end (chart / table / metrics / board)
async function testPresetArtifactsEndToEnd(): Promise<void> {
  const script = `
    artifact.chart("perf", {
      title: "Latency",
      x: { field: "round", label: "Round" },
      y: { field: "ms", label: "Latency", unit: "ms" },
      baseline: { field: "target" },
    });
    artifact.table("rows", {
      title: "Items",
      key: "id",
      columns: [{ field: "id" }, { field: "score" }],
    });
    artifact.metrics("kpi", {
      title: "Summary",
      metrics: [{ field: "total" }, { field: "bestMs", unit: "ms" }],
    });
    artifact.board("tasks", {
      title: "Workboard",
      key: "id",
      status: "state",
      columns: ["todo", "done"],
      cardTitle: "title",
    });
    phase("Measure");
    const note = await agent("runner").ask("run");
    report({ round: 1, ms: 95, target: 30 }, "perf");
    report({ round: 2, ms: 42, target: 30 }, "perf");
    report({ id: "a", score: 10 }, "rows");
    report({ id: "a", score: 20 }, "rows");
    report({ total: 2, bestMs: 42 }, "kpi");
    report({ id: "t1", state: "todo", title: "Task 1" }, "tasks");
    report({ id: "t1", state: "done", title: "Task 1" }, "tasks");
    return note;
  `
  const h = await composeHarness({
    onModel: async (req) => {
      if (childName(req) !== undefined) return text('measured')
      if (req.lastUser === 'RUN_PRESETS' && req.lastToolResult === undefined) {
        return toolCall('create_workflow', { name: 'preset-dash', script })
      }
      return text('done')
    },
  })
  try {
    const main = await h.create('preset-main')
    send(main, 'RUN_PRESETS')
    await main.whenIdle()
    const run = await waitFor('preset run settled', () => h.service.listRuns('preset-main', 5).find(r => r.name === 'preset-dash' && r.status !== 'running'))
    assert.equal(run.status, 'completed', `preset run failed`)

    const list = h.service.artifacts(run.runId)
    assert.equal(list.length, 4, `expected 4 preset artifacts, got ${list.map(a => a.id).join(', ')}`)
    const byId = new Map(list.map(a => [a.id, a]))
    assert.equal(byId.get('perf')?.kind, 'chart')
    assert.equal(byId.get('perf')?.itemCount, 2)
    assert.ok(byId.get('perf')?.spec !== undefined)
    assert.equal(byId.get('rows')?.kind, 'table')
    assert.equal(byId.get('rows')?.itemCount, 2)
    assert.equal(byId.get('kpi')?.kind, 'metrics')
    assert.equal(byId.get('kpi')?.itemCount, 1)
    assert.equal(byId.get('tasks')?.kind, 'board')
    assert.equal(byId.get('tasks')?.itemCount, 2)

    // Paged SQLite field extraction on `perf`
    const page1 = h.service.artifactData(run.runId, 'perf', { fields: ['round', 'ms'], limit: 1 })
    assert.equal(page1.items.length, 1)
    assert.equal(page1.hasMore, true)
    assert.deepEqual(page1.items[0]!.fields, { round: 1, ms: 95 })
    const page2 = h.service.artifactData(run.runId, 'perf', { afterSequence: page1.items[0]!.sequence, fields: ['round', 'ms'], limit: 10 })
    assert.equal(page2.items.length, 1)
    assert.equal(page2.hasMore, false)
    assert.deepEqual(page2.items[0]!.fields, { round: 2, ms: 42 })

    // Snapshot also exposes spec + itemCount for RunPane
    const snap = h.service.snapshot(run.runId)
    assert.equal(snap.artifacts.length, 4)
    assert.equal(snap.artifacts.find(a => a.id === 'perf')?.itemCount, 2)
    assert.ok(snap.artifacts.find(a => a.id === 'perf')?.spec !== undefined)
    console.log('✓ P2 preset artifacts: chart/table/metrics/board declared, tagged reports counted, paged SQLite field extraction verified')
  } finally {
    await h.dispose()
  }
}

async function main(): Promise<void> {
  await testReadOnlySubagents()
  await testSnippetConfirmation()
  await testSaveWorkflowSecurity()
  await testAmendNewProviderAndNullSaved()
  await testDwfCommandOwnership()
  await testPresetArtifactsEndToEnd()
  console.log('AUDIT REGRESSIONS OK')
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
