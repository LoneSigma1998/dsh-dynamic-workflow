/**
 * DSH integration test (no network): a real cordis Context with DSH's agent
 * registry, agent loop, session store, projection registry, tool runtime and
 * system prompt, plus this plugin; one scripted adapter plays the model for
 * the main agent and for every workflow subagent.
 *
 * Scenarios:
 *   1. create_workflow → confirm (never) → run with two real child agents →
 *      typed ask with one rejected submit (repair) → untyped ask → report() /
 *      files.glob / world.run → completed → terminal <task-notification>
 *      wakes the idle main agent; journal, session progress events and the
 *      run projection all agree.
 *   2. escalate: a child escalates, the main agent answers with
 *      resolve_workflow_question, the child finishes.
 *   3. stop + resume: a run stopped mid-ask resumes from the journal; the
 *      finished ask is replayed from cache (no second model call).
 *   4. compile diagnostics come back without starting a run.
 *
 * Run: tsx --tsconfig <paths config> tests/dsh/integration.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ScriptedModel, text, toolCall, type RequestView } from './scripted-model.ts'

/** Where to dump fixtures for the Web preview / bundle tests (resolved now: the test changes cwd). */
const FIXTURE_DIR = process.env.DWF_FIXTURE_DIR === undefined ? undefined : resolvePath(process.env.DWF_FIXTURE_DIR)

// DWF_PLUGIN=lib runs the same scenarios against the built bundle (lib/index.js).
const WorkflowPlugin = process.env.DWF_PLUGIN === 'lib'
  ? await import(new URL('../../lib/index.js', import.meta.url).href) as typeof import('../../src/index.ts')
  : await import('../../src/index.ts')

const SCRIPT = `
interface Finding {
  /** Workspace-relative path of the file. */
  file: string
  /** @minimum 1 */
  line: number
  issue: string
}
interface Review { findings: Finding[] }

phase("Survey")
const sources = await files.glob("src/*.ts")
const probe = await world.run("node", ["-e", "console.log(40 + 2)"])
log(\`found \${sources.length} files, probe=\${probe.stdout.trim()}\`)

phase("Review")
const reviewer = agent("Reviewer", { system: "You review TypeScript for bugs." })
const reviews: Review[] = []
for (const file of sources) {
  const review = await reviewer.ask<Review>(\`Review \${file} and list concrete bugs.\`)
  for (const finding of review.findings) report(finding)
  reviews.push(review)
}

phase("Summarize")
const writer = agent("Writer")
const summary = await writer.ask(\`Summarize: \${JSON.stringify(reviews)}\`)
return { files: sources.length, probe: probe.stdout.trim(), summary }
`

const ESCALATE_SCRIPT = `
phase("Ask")
const worker = agent("Worker")
const answer = await worker.ask("Pick the deployment region and report it.")
return { answer }
`

const SLOW_SCRIPT = `
interface Count { n: number }
phase("Count")
const counter = agent("Counter")
const a = await counter.ask<Count>("Count step A.")
const b = await counter.ask<Count>("Count step B.")
return { total: a.n + b.n }
`

const FENCE_SCRIPT = `
interface Count { n: number }
phase("Count")
const counter = agent("Counter")
const f = await counter.ask<Count>("Count step F.")
return { total: f.n }
`

const AMEND_BASE = `
interface Plan { steps: string[] }
phase("Plan")
const planner = agent("Planner")
const plan = await planner.ask<Plan>("Plan the change in two steps.")
phase("Build")
const coder = agent("Coder")
const built = await coder.ask(\`Implement: \${plan.steps.join("; ")}\`)
return { plan, built }
`

const AMEND_REVISED = `
interface Plan { steps: string[] }
phase("Plan")
const planner = agent("Planner")
const plan = await planner.ask<Plan>("Plan the change in two steps.")
phase("Build")
const coder = agent("Coder")
const built = await coder.ask(\`Implement: \${plan.steps.join("; ")}\`)
phase("Check")
const checker = agent("Checker")
const verdict = await checker.ask(\`Check: \${built}\`)
return { plan, built, verdict }
`

const HOLE_SCRIPT = `
phase("Survey")
const lister = agent("Lister")
const items = await lister.ask("List the items.")
const pick = await hole<string>("Pick one", \`Items: \${items}\`)
phase("Finish")
return { pick }
`

function send(agent: Agent, value: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } }))
}

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== false) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function childName(request: RequestView): string | undefined {
  return /You are the subagent "([^"]+)"/.exec(request.system)?.[1]
}

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'dwf-ws-'))
  const state = mkdtempSync(join(tmpdir(), 'dwf-state-'))
  writeFileSync(join(workspace, 'package.json'), '{}')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(workspace, 'src'))
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(workspace, 'src', 'b.ts'), 'export const b = 2\n')

  const counters = { reviewerSubmits: 0, counterCalls: 0, escalated: false, planner: 0, coder: 0, checker: 0, lister: 0, gateDeclined: 0, intrusions: [] as { tool: string; isError: boolean; text: string }[] }
  let holdCounter: (() => void) | undefined
  const counterGate = new Promise<void>(resolve => { holdCounter = resolve })
  let releaseFence: (() => void) | undefined
  const fenceGate = new Promise<void>(resolve => { releaseFence = resolve })
  let fenceAsked = false
  const reviewerAsks: string[] = []

  const model = new ScriptedModel(async (request) => {
    const child = childName(request)
    // ——— main agent ———
    if (child === undefined) {
      const last = request.lastToolResult
      if (request.lastUser.includes('<task-notification>') && last === undefined) return text('Workflow finished; here is the summary.')
      if (request.lastUser.includes('<workflow-hole>') && last === undefined) {
        const runId = /<run-id>([^<]+)<\/run-id>/.exec(request.lastUser)?.[1]
        const holeId = /<hole-id>([^<]+)<\/hole-id>/.exec(request.lastUser)?.[1]
        return toolCall('fill_workflow_hole', { run_id: runId, hole_id: holeId, script: 'return "chosen: " + items' })
      }
      if (last?.name === 'fill_workflow_hole') return text(last.isError ? `fill failed: ${last.text}` : 'Filled the hole.')
      if (request.lastUser.startsWith('AMEND:') && last === undefined) {
        return toolCall('amend_workflow', { run_id: request.lastUser.slice(6).trim(), script: AMEND_REVISED })
      }
      if (last?.name === 'amend_workflow') return text('Amended.')
      if (request.lastUser.includes('<workflow-escalation>') && request.lastUser.includes('GATE') && last === undefined && counters.gateDeclined === 0) {
        // first try to end the turn without answering: the turn-boundary gate must steer us back
        counters.gateDeclined += 1
        return text('I will look at that later.')
      }
      if (request.lastUser.includes('<workflow-blocked>') && last === undefined) {
        const qid = /question id="([^"]+)"/.exec(request.lastUser)?.[1]
        return toolCall('resolve_workflow_question', { question_id: qid, answer: 'ap-south-1' })
      }
      if (request.lastUser.includes('<workflow-escalation>') && last === undefined) {
        const qid = /<question-id>([^<]+)<\/question-id>/.exec(request.lastUser)?.[1]
        return toolCall('resolve_workflow_question', { question_id: qid, answer: 'eu-west-1' })
      }
      if (last?.name === 'resolve_workflow_question') return text('Answered the subagent.')
      if (request.lastUser.startsWith('RUN:') && last === undefined) {
        const which = request.lastUser.slice(4).trim()
        const scripts: Record<string, string> = { fence: FENCE_SCRIPT, main: SCRIPT, escalate: ESCALATE_SCRIPT, gate: ESCALATE_SCRIPT.replace('Pick the deployment region', 'GATE pick the region'), slow: SLOW_SCRIPT, amend: AMEND_BASE, hole: HOLE_SCRIPT }
        const script = scripts[which] ?? 'const x: number = "nope"\nreturn x'
        return toolCall('create_workflow', { name: `test-${which}`, script })
      }
      if (last?.name === 'create_workflow') return text('Started the workflow.')
      // scenario 9: another session reaching for someone else's run
      const intrude = /^(STOP|RESUME): (\S+)/.exec(request.lastUser)
      if (intrude !== null && last === undefined) return toolCall(intrude[1] === 'STOP' ? 'stop_workflow_run' : 'resume_workflow_run', { run_id: intrude[2] })
      if (last?.name === 'stop_workflow_run' || last?.name === 'resume_workflow_run') {
        counters.intrusions.push({ tool: last.name, isError: last.isError, text: last.text })
        return text('noted')
      }
      return text('ok')
    }
    // ——— subagents ———
    const last = request.lastToolResult
    if (child === 'Reviewer') {
      reviewerAsks.push(request.lastUser)
      if (last?.name === 'submit_result' && !last.isError) return text('Submitted.')
      const file = /Review (\S+)/.exec(request.lastUser)?.[1] ?? 'src/a.ts'
      counters.reviewerSubmits += 1
      // the first submit violates @minimum 1 → the engine rejects it and the model repairs in the same turn
      const line = counters.reviewerSubmits === 1 ? 0 : 1
      return toolCall('submit_result', { result: { findings: [{ file, line, issue: 'unused export' }] } })
    }
    if (child === 'Writer') return text('Two files, one unused export each.', { inputTokens: 300, outputTokens: 40 })
    if (child === 'Worker') {
      if (last?.name === 'escalate') return text(`Region chosen: ${last.text}`)
      counters.escalated = true
      return toolCall('escalate', { question: request.lastUser.includes('GATE') ? 'GATE: which region?' : 'Which region should I deploy to?', context: 'The ask does not say.' })
    }
    if (child === 'Planner') {
      if (last?.name === 'submit_result' && !last.isError) return text('planned')
      counters.planner += 1
      return toolCall('submit_result', { result: { steps: ['add flag', 'wire flag'] } })
    }
    if (child === 'Coder') { counters.coder += 1; return text('implemented both steps') }
    if (child === 'Checker') { counters.checker += 1; return text('looks right') }
    if (child === 'Lister') { counters.lister += 1; return text('apple, pear') }
    if (child === 'Counter') {
      if (last?.name === 'submit_result' && !last.isError) return text('done')
      counters.counterCalls += 1
      if (request.lastUser.includes('step B')) await counterGate
      if (request.lastUser.includes('step F')) { fenceAsked = true; await fenceGate }
      return toolCall('submit_result', { result: { n: request.lastUser.includes('step A') ? 1 : 2 } })
    }
    return text('?')
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
  await ctx.plugin(WorkflowPlugin, { stateDir: state, confirm: 'never', skillGate: false, defaultMaxConcurrency: 4 })

  // children are disposed when their run settles: record their descriptors as they are appended
  const descriptorEvents: { sessionId: string; data: unknown }[] = []
  ctx.on('session/event' as never, ((session: { id: string }, event: { type: string; data: unknown }) => {
    if (event.type === 'subagent/descriptor') descriptorEvents.push({ sessionId: session.id, data: event.data })
  }) as never)
  const agentLoop = (ctx as unknown as { agentLoop: { create(id: SessionId, options: object, meta?: object): Promise<Agent> } }).agentLoop
  process.chdir(workspace)
  const main = await agentLoop.create('main-session' as SessionId, { provider: 'scripted', model: 'm1' }, { cwd: workspace })

  const journal = () => (WorkflowPluginState.service!).journal
  // Grab the run service through the tool surface: list via journal file.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(state, 'journal.sqlite'), { readOnly: true })
  const runs = () => db.prepare('select id, name, status, failure_json, result_json, spent_tokens from dwf_run order by time_created').all() as { id: string; name: string; status: string; failure_json: string | null; result_json: string | null; spent_tokens: number }[]
  void journal

  // ——— scenario 4: diagnostics ———
  send(main, 'RUN: bad')
  await main.whenIdle()
  const badResult = model.requests.find(r => r.lastToolResult?.name === 'create_workflow')?.lastToolResult
  assert.ok(badResult !== undefined && badResult.text.includes('did not compile'), `diagnostics result: ${badResult?.text}`)
  assert.equal(runs().length, 0, 'no run for a dirty script')
  console.log('✓ scenario 4: diagnostics, no run created')

  // ——— scenario 1: full run ———
  send(main, 'RUN: main')
  await main.whenIdle()
  const run1 = await waitFor('main run settled', () => runs().find(r => r.name === 'test-main' && r.status !== 'running'))
  assert.equal(run1.status, 'completed', `run failed: ${run1.failure_json}`)
  const result = JSON.parse(run1.result_json!) as { files: number; probe: string; summary: string }
  assert.deepEqual(result, { files: 2, probe: '42', summary: 'Two files, one unused export each.' })
  assert.ok(counters.reviewerSubmits >= 3, 'the rejected submit was repaired')
  const reports = db.prepare("select count(*) as n from dwf_node where run_id = ? and kind = 'report'").get(run1.id) as { n: number }
  assert.equal(reports.n, 2)
  const executing = db.prepare("select count(*) as n from dwf_event where run_id = ? and type = 'node-executing'").get(run1.id) as { n: number }
  assert.ok(executing.n >= 3, `asks report executing when their model request is sent (${executing.n})`)
  const repairing = db.prepare("select count(*) as n from dwf_event where run_id = ? and type = 'node-repairing'").get(run1.id) as { n: number }
  assert.equal(repairing.n, 1, 'one repair round')
  assert.ok(run1.spent_tokens > 0, 'tokens accounted')
  // notification woke the idle main agent
  await waitFor('terminal notification turn', () => model.requests.some(r => childName(r) === undefined && r.lastUser.includes('<task-notification>') && r.lastUser.includes(run1.id)))
  await main.whenIdle()
  const progress = main.session.snapshotEvents().filter(e => (e.type as string) === 'plugin:dynamic-workflow/progress')
  assert.ok(progress.length > 10, `progress events in the owner session: ${progress.length}`)
  // persisted as ignorable plugin records, so a log holding them stays reloadable by any DSH build
  assert.ok(progress.every(e => (e as { ignorable?: true }).ignorable === true), 'progress records are ignorable')
  const projections = (ctx as unknown as { sessionProjections: { snapshot(session: unknown, keys?: unknown): { values: Record<string, unknown> } } }).sessionProjections
  const view = projections.snapshot(main.session).values.dynamicWorkflowRuns as { runs: { runId: string; status: string; actors: unknown[]; nodes: unknown[] }[] } | undefined
  const projected = view?.runs.find(r => r.runId === run1.id)
  assert.equal(projected?.status, 'completed', `projection: ${JSON.stringify(view?.runs.map(r => [r.runId, r.status]))}`)
  assert.equal(projected?.actors.length, 2)
  const childSessions = db.prepare('select session_id from dwf_actor where run_id = ?').all(run1.id) as { session_id: string }[]
  assert.equal(childSessions.length, 2)
  for (const { session_id: childId } of childSessions) {
    const descriptors = descriptorEvents.filter(entry => entry.sessionId === childId)
    assert.equal(descriptors.length, 1, `${childId} carries exactly one subagent/descriptor (DSH opens its transcript as a subagent)`)
    assert.equal((descriptors[0]!.data as { mode?: string }).mode, 'one-shot')
  }
  // exact mode (default): the typed ask ends in one line; the schema lives in the tool declaration only
  assert.ok(reviewerAsks.length > 0 && reviewerAsks.every(ask => !ask.includes('conforming to this JSON Schema')), 'no schema restatement in the ask text')
  console.log(`✓ scenario 1: completed ${run1.id}; tokens=${run1.spent_tokens}; progress events=${progress.length}; children=${childSessions.map(c => c.session_id).join(', ')}`)
  if (FIXTURE_DIR !== undefined) {
    // Real data for the Web preview harness (tests/preview): the launch display the card reads
    // from the tool result's meta, and the run's progress records in order.
    const events = main.session.snapshotEvents()
    const launch = events.find(e => e.type === 'tool/result' && (e.data as { meta?: { kind?: string; runId?: string } }).meta?.runId === run1.id)
    const callId = (launch?.data as { message?: { toolCallId?: string } } | undefined)?.message?.toolCallId
    const call = events.find(e => e.type === 'tool/call' && (e.data as { callId?: string }).callId === callId)
    writeFileSync(join(FIXTURE_DIR, 'run-main.json'), JSON.stringify({
      display: (launch?.data as { meta?: unknown } | undefined)?.meta ?? null,
      call: call?.data ?? null,
      progress: progress.map(e => e.data),
      notices: events.filter(e => e.type === 'user/message' && ((e.data as { source?: { kind?: string } }).source?.kind === 'dynamic-workflow')).map(e => e.data),
    }, null, 1))
  }

  // ——— scenario 2: escalation ———
  send(main, 'RUN: escalate')
  await main.whenIdle()
  const run2 = await waitFor('escalate run settled', () => runs().find(r => r.name === 'test-escalate' && r.status !== 'running'))
  assert.equal(run2.status, 'completed', `run failed: ${run2.failure_json}`)
  assert.ok(counters.escalated)
  assert.deepEqual(JSON.parse(run2.result_json!), { answer: 'Region chosen: eu-west-1' })
  const escalations = db.prepare("select type from dwf_event where run_id = ? and type like 'escalation-%' order by sequence").all(run2.id) as { type: string }[]
  assert.deepEqual(escalations.map(e => e.type), ['escalation-raised', 'escalation-resolved'])
  // DSH runtime context: while the question was open, the main agent's requests carried the
  // <workflow-runs> status naming it (re-sent only on change), and none after the run settled.
  const allText = (r: RequestView): string => JSON.stringify(r.messages)
  const mainRequests = model.requests.filter(r => childName(r) === undefined)
  assert.ok(mainRequests.some(r => allText(r).includes('<workflow-runs>') && allText(r).includes('waiting on you: question')), 'runtime status context named the open question')
  console.log('✓ scenario 2: escalation raised → main agent resolved → subagent finished (runtime <workflow-runs> context named the open question)')

  // ——— scenario 3: stop + resume ———
  send(main, 'RUN: slow')
  await main.whenIdle()
  const run3id = await waitFor('slow run id', () => runs().find(r => r.name === 'test-slow')?.id)
  await waitFor('step B in flight', () => counters.counterCalls >= 2)
  const service = WorkflowPluginState.service!
  service.cancel(run3id, 'user')
  holdCounter?.()
  const stopped = await waitFor('slow run stopped', () => runs().find(r => r.id === run3id && r.status !== 'running'))
  assert.equal(stopped.status, 'cancelled', 'stopped is stored as cancelled')
  const callsBefore = counters.counterCalls
  await waitFor('main idle after stop notice', () => main.status === 'idle' || undefined)
  const resumed = await service.resume(run3id, main)
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  const finished = await waitFor('slow run resumed to completion', () => runs().find(r => r.id === run3id && r.status === 'completed'))
  assert.deepEqual(JSON.parse(finished.result_json!), { total: 3 })
  assert.equal(counters.counterCalls - callsBefore, 1, 'step A replayed from the journal; only step B ran again')
  const cached = db.prepare("select count(*) as n from dwf_event where run_id = ? and type = 'node-settled' and json_extract(payload_json, '$.cached') = 1").get(run3id) as { n: number }
  assert.equal(cached.n, 1)
  console.log('✓ scenario 3: stop → resume replayed the finished ask from cache, re-ran only the unfinished one')

  // ——— scenario 5: amend imports the finished work as cache ———
  send(main, 'RUN: amend')
  await main.whenIdle()
  const base = await waitFor('amend base settled', () => runs().find(r => r.name === 'test-amend' && r.status !== 'running'))
  assert.equal(base.status, 'completed', `base failed: ${base.failure_json}`)
  await main.whenIdle()
  const before = { planner: counters.planner, coder: counters.coder }
  send(main, `AMEND:${base.id}`)
  await main.whenIdle()
  const amended = await waitFor('amended run settled', () => runs().find(r => r.id !== base.id && r.name === 'test-amend' && r.status !== 'running'))
  assert.equal(amended.status, 'completed', `amended failed: ${amended.failure_json}`)
  assert.deepEqual({ planner: counters.planner, coder: counters.coder }, before, 'Planner and Coder answered from the import cache')
  assert.equal(counters.checker, 1, 'the new Checker ran live')
  const resumedFrom = db.prepare('select resumed_from from dwf_run where id = ?').get(amended.id) as { resumed_from: string }
  assert.equal(resumedFrom.resumed_from, base.id)
  assert.ok(amended.spent_tokens >= base.spent_tokens, 'usage across the lineage')
  console.log(`✓ scenario 5: amend ${base.id} → ${amended.id}: 2 asks from cache, 1 live; lineage tokens ${amended.spent_tokens}`)

  // ——— scenario 6: hole filled by the main agent mid-run ———
  send(main, 'RUN: hole')
  await main.whenIdle()
  const holeRun = await waitFor('hole run settled', () => runs().find(r => r.name === 'test-hole' && r.status !== 'running'))
  assert.equal(holeRun.status, 'completed', `hole run failed: ${holeRun.failure_json}`)
  assert.deepEqual(JSON.parse(holeRun.result_json!), { pick: 'chosen: apple, pear' })
  const holeEvents = db.prepare("select type from dwf_event where run_id = ? and type like 'hole-%' order by sequence").all(holeRun.id) as { type: string }[]
  assert.deepEqual(holeEvents.map(e => e.type), ['hole-reached', 'hole-filled'])
  const effective = db.prepare('select script_text from dwf_run where id = ?').get(holeRun.id) as { script_text: string }
  assert.ok(effective.script_text.includes('return "chosen: " + items'), 'the effective script carries the fill')
  console.log('✓ scenario 6: hole reached → main agent filled it → run completed with the effective script journaled')

  // ——— scenario 7: turn-boundary gate (DSH enhancement) ———
  await main.whenIdle()
  send(main, 'RUN: gate')
  await main.whenIdle()
  const gateRun = await waitFor('gate run settled', () => runs().find(r => r.name === 'test-gate' && r.status !== 'running'))
  assert.equal(gateRun.status, 'completed', `gate run failed: ${gateRun.failure_json}`)
  assert.equal(counters.gateDeclined, 1, 'the main agent first tried to end its turn')
  assert.ok(model.requests.some(r => childName(r) === undefined && r.lastUser.includes('<workflow-blocked>')), 'the gate steered a <workflow-blocked> reminder')
  assert.deepEqual(JSON.parse(gateRun.result_json!), { answer: 'Region chosen: ap-south-1' })
  console.log('✓ scenario 7: the main agent could not end its turn on an open question; the gate steered it back')

  // ——— scenario 9: a run is controlled only by the session that started it ———
  const intruder = await agentLoop.create('intruder-session' as SessionId, { provider: 'scripted', model: 'm1' }, { cwd: workspace })
  send(intruder, `STOP: ${run3id}`)
  await intruder.whenIdle()
  send(intruder, `RESUME: ${run3id}`)
  await intruder.whenIdle()
  assert.equal(counters.intrusions.length, 2, JSON.stringify(counters.intrusions))
  for (const attempt of counters.intrusions) {
    assert.equal(attempt.isError, true, `${attempt.tool} from another session must fail: ${attempt.text}`)
    assert.match(attempt.text, /belongs to another session/u)
  }
  assert.equal(runs().find(r => r.id === run3id)?.status, 'completed', 'the owner\'s run is untouched')
  console.log('✓ scenario 9: stop/resume from another session were refused; the owner\'s run is untouched')

  // ——— scenario 10: write fence — a run another Host took over is stopped without further writes ———
  send(main, 'RUN: fence')
  await main.whenIdle()
  const fenceRun = await waitFor('fence run started', () => runs().find(r => r.name === 'test-fence')?.id)
  await waitFor('step F in flight', () => fenceAsked)
  const eventCount = () => (db.prepare('select count(*) as n from dwf_event where run_id = ?').get(fenceRun) as { n: number }).n
  const eventsBefore = eventCount()
  // another Host (its own connection and ownership) takes the run over while step F is in flight
  const { RunOwnership } = await import('../../src/journal/journal.ts')
  const otherDb = new DatabaseSync(join(state, 'journal.sqlite'))
  new RunOwnership(otherDb).claim(fenceRun)
  otherDb.close()
  await new Promise(resolve => setTimeout(resolve, 1100)) // past the per-write check's 1 s throttle
  releaseFence?.()
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(runs().find(r => r.id === fenceRun)?.status, 'running', 'the fenced process wrote no terminal status (the new owner settles the run)')
  assert.equal(eventCount(), eventsBefore, 'no journal events after the fence')
  assert.equal(service.liveRun(fenceRun), undefined, 'the fenced run left this process')
  console.log(`✓ scenario 10: write fence — taken over by another Host, the run's next write was dropped and it stopped here (${eventsBefore} events, status untouched)`)

  // ——— scenario 8: hold mode (headless / SDK) ———
  // A second composition with holdTurnWhileRunning: the owning agent's turn stays open while its
  // run is live, so the escalation and the terminal notice are handled before the agent ever idles.
  const ctx2 = new Context()
  await ctx2.plugin(LlmRuntime)
  await ctx2.plugin(SessionStore)
  await ctx2.plugin(SessionProjectionRegistry)
  await ctx2.plugin(SystemPrompt)
  await ctx2.plugin(ToolRuntime)
  await ctx2.plugin(NativeToolExecutor)
  await ctx2.plugin(AgentRegistry)
  await ctx2.plugin(AgentLoop, { agents: [] })
  ctx2.llm.registerAdapter(['scripted'], model)
  const state2 = mkdtempSync(join(tmpdir(), 'dwf-state2-'))
  await ctx2.plugin(WorkflowPlugin, { stateDir: state2, confirm: 'never', skillGate: false, holdTurnWhileRunning: true })
  const loop2 = (ctx2 as unknown as { agentLoop: { create(id: SessionId, options: object, meta?: object): Promise<Agent> } }).agentLoop
  const headless = await loop2.create('headless-session' as SessionId, { provider: 'scripted', model: 'm1' }, { cwd: workspace })
  let idles = 0
  ctx2.on('agent/status', ({ agent, status }: { agent: Agent; status: string }) => { if (agent === headless && status === 'idle') idles += 1 })
  send(headless, 'RUN: escalate')
  await headless.whenIdle()
  const db2 = new DatabaseSync(join(state2, 'journal.sqlite'), { readOnly: true })
  const held = db2.prepare("select id, status, result_json from dwf_run where name = 'test-escalate'").get() as { id: string; status: string; result_json: string }
  assert.equal(held.status, 'completed', 'the run settled before the owning agent first went idle')
  assert.equal(idles, 1, 'exactly one idle: the held turn absorbed the escalation and the terminal notice')
  const turnEvents = headless.session.snapshotEvents().filter(e => e.type === 'turn/start').length
  assert.equal(turnEvents, 1, 'everything happened inside one turn')
  db2.close()
  console.log('✓ scenario 8: hold mode kept the headless turn open through the escalation and the terminal notice')

  await main.whenIdle()
  db.close()
  try { ctx.registry.delete(WorkflowPlugin as never) } catch { /* already disposed */ }
  rmSync(workspace, { recursive: true, force: true })
  rmSync(state, { recursive: true, force: true })
  console.log('INTEGRATION OK')
}

// Test hook: the plugin publishes its service here when `DWF_TEST_HOOK` is set.
const WorkflowPluginState = (globalThis as { __dwfTest?: { service?: import('../../src/service/run-service.ts').RunService } }).__dwfTest ??= {}
process.env.DWF_TEST_HOOK = '1'

main().then(() => process.exit(0), (error) => {
  console.error(error)
  process.exit(1)
})
