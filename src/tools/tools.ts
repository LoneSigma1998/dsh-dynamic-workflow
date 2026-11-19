/**
 * The model-facing tools (ZCode's CreateWorkflow family, DSH snake_case names):
 *
 *   create_workflow · amend_workflow · fill_workflow_hole · resume_workflow_run ·
 *   stop_workflow_run · resolve_workflow_question · get_workflow_run ·
 *   list_workflow_runs · save_workflow · list_saved_workflows · eval_workflow_snippet
 *
 * Launch tools return at once (the run continues in the background) and carry
 * the bounded display payload as `presentationMeta`, which the plugin's Web
 * client draws as the timeline.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { analyzeWorkflowScript, type AnalyzeResult } from '@zcode/dynamic-workflow'
import { boundCausalityGraph } from '../display/graph-bounds.ts'
import type { WorkflowLaunchDisplay } from '../display/types.ts'
import { CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS, CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS } from '../display/types.ts'
import { formatProviderStopError } from '../notify/text.ts'
import { compileOnce, type CompiledScript } from '../service/compile.ts'
import { fillHole } from '../service/fill.ts'
import type { RunService } from '../service/run-service.ts'
import type { SnippetRunner } from '../service/snippet.ts'
import type { ConfirmSettings, LaunchConfirmation } from './confirm.ts'
import { recordAuthoredDraft } from './drafts.ts'
import { sessionHasLoadedSkill, skillGateMessage } from './skill-gate.ts'
import { describePath, findSaved, listSaved, readScriptFile, resolveSavedArgs, savedDir, slugOf, writeDraft, writeSaved } from './sources.ts'

export interface ToolDeps {
  ctx: Context
  service: RunService
  confirmation: LaunchConfirmation
  snippets?: SnippetRunner
  /** Disable the skill gate (tests). */
  skillGate: boolean
  /** Mode gate: the model-facing tools participate in a step only while the session is active. */
  access?: { isActive(agent: Agent | undefined): boolean }
}

interface ExecContext {
  agent?: Agent
  signal: AbortSignal
  callId: string
}

type ToolValue = { ok: boolean; text: string; display?: WorkflowLaunchDisplay; data?: unknown }

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    display: { description: 'GUI display payload' },
    data: { description: 'structured data for the GUI' },
  },
  required: ['ok', 'text'],
  additionalProperties: false,
}

function textBlocks(value: ToolValue): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value.text }]
}

/**
 * Run control belongs to the session that owns the run: another session (or another user's
 * session on a shared Host) may read runs, never stop, fill, resume, amend or answer them.
 */
function assertOwnRun(service: RunService, agent: Agent, runId: string): void {
  const owner = service.journal.getRun(runId)?.parentSessionId
  if (owner !== undefined && owner !== (agent.id as string)) {
    throw new Error(`Run ${runId} belongs to another session; only the session that started it can control it.`)
  }
}

let activeGate: ToolDeps['access']

function register(ctx: Context, def: {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: ExecContext) => Promise<ToolValue>
  readOnly?: boolean
}): void {
  const tools = ctx.tools as unknown as { register(definition: unknown, options?: unknown): () => void }
  const gate = activeGate
  tools.register({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: unknown, value: ToolValue) => textBlocks(value),
      presentationMeta: (_args: unknown, value: ToolValue) => (value.display ?? value.data ?? null) as never,
    },
    ...def.readOnly === true ? { isConcurrencySafe: () => true } : {},
    execute: async (args: unknown, exec: ExecContext) => await def.execute((args ?? {}) as Record<string, unknown>, exec),
  }, gate === undefined ? undefined : { when: (context: { agent: Agent }) => gate.isActive(context.agent) })
}

/** The settings the run starts with after the confirmation, and a sentence for the model when the user changed them. */
export function applyConfirmedSettings(settings: ConfirmSettings | undefined, proposed: { maxConcurrency: number; subagentModel: string | undefined }): { maxConcurrency: number; subagentModel: string | undefined; note: string } {
  if (settings === undefined) return { ...proposed, note: '' }
  const maxConcurrency = settings.maxConcurrency ?? proposed.maxConcurrency
  const subagentModel = settings.subagentModel === undefined ? proposed.subagentModel : settings.subagentModel ?? undefined
  const changes: string[] = []
  if (maxConcurrency !== proposed.maxConcurrency) changes.push(`max concurrency ${proposed.maxConcurrency} → ${maxConcurrency}`)
  if (subagentModel !== proposed.subagentModel) changes.push(`subagent model ${proposed.subagentModel ?? 'session model'} → ${subagentModel ?? 'session model'}`)
  return { maxConcurrency, subagentModel, note: changes.length === 0 ? '' : ` The user changed the settings in the confirmation: ${changes.join(', ')}.` }
}

function requireAgent(exec: ExecContext, tool: string): Agent {
  if (exec.agent === undefined) throw new Error(`${tool} requires a calling agent`)
  return exec.agent
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined
}

function diagnosticsText(analysis: Pick<AnalyzeResult, 'diagnostics'>): string {
  return analysis.diagnostics.map(d => `L${d.line}:C${d.column} ${d.message}`).join('\n')
}

export function displayOf(tool: string, analysis: AnalyzeResult, extra: Partial<WorkflowLaunchDisplay> = {}): WorkflowLaunchDisplay {
  const causalityGraph = analysis.causality === undefined || analysis.flow === undefined || analysis.handoff === undefined
    ? undefined
    : boundCausalityGraph(analysis.causality, analysis.flow, analysis.handoff) as WorkflowLaunchDisplay['causalityGraph']
  return {
    kind: 'dynamic-workflow-launch',
    tool,
    ok: analysis.ok,
    errorCount: analysis.diagnostics.length,
    diagnostics: analysis.diagnostics.slice(0, CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS).map(d => ({
      line: d.line, column: d.column, code: d.code, message: d.message.slice(0, CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
    })),
    ...causalityGraph === undefined ? {} : { causalityGraph },
    ...extra,
  }
}

const SKILL_SENTENCE = 'Before writing or revising a script, load the `dynamic-workflows` skill with the `skill` tool: it carries the facade declarations the script is checked against, the authoring rules, and this tool\'s full contract. A call that submits a script is refused until that skill has been loaded; running a saved workflow by name is exempt.'

const CREATE_DESCRIPTION = [
  'Create and run a dynamic workflow: a TypeScript script that orchestrates multiple model-driven subagents with plain control flow (loops, conditionals, fan-out) and typed intermediate results. The script is typechecked, the user is asked to confirm it, and the run starts in the background; you are notified with its final result when it settles. Compilation errors come back as diagnostics.',
  '',
  'When to use:',
  '- The user explicitly asks for a workflow — "use a workflow", "with a workflow", "使用 workflow", "用工作流", or `/workflow …`: this tool is mandatory. Do not substitute subagent tools, do not do the work inline yourself, and do not judge the task too small for a workflow. Size only decides how many subagents the script gets.',
  '- Otherwise follow the dynamic-workflow routing rule in the system prompt (it says whether workflows start only on request, may be suggested with their cost, or are the default for substantive tasks).',
  '',
  SKILL_SENTENCE,
  '',
  'Pass exactly one source: `script` (inline; it is saved to a draft file the result names — revise that file with edit and resubmit with `path`, never paste the script again), `saved` (a saved workflow by name; check list_saved_workflows first), or `path` (a script file on disk). To change a run that already exists — errored, completed, stopped or still running — call amend_workflow instead of starting over.',
].join('\n')

const AMEND_DESCRIPTION = [
  'Revise a workflow run. Starts a NEW run that supersedes the old one and imports its finished work as a cache (named subagents whose persona and asks are unchanged are answered from the cache until the revision first writes the workspace). If the run is still running and going wrong, amend it immediately — this stops it for you.',
  'Omitted fields inherit the predecessor\'s value; `null` resets max_concurrency / subagent_model. A call with only `max_concurrency` against a live run retunes it in place (same run id). A settings-only call needs no script and skips the skill gate.',
  SKILL_SENTENCE,
].join('\n')

export function registerWorkflowTools(deps: ToolDeps): void {
  const { ctx, service, confirmation } = deps
  activeGate = deps.access
  const gate = (agent: Agent, tool: string): void => {
    if (deps.skillGate && !sessionHasLoadedSkill(agent)) throw new Error(skillGateMessage(tool))
  }

  // ————————————————————————————— create_workflow —————————————————————————————
  register(ctx, {
    name: 'create_workflow',
    description: CREATE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short human name of the workflow, in the user\'s language.' },
        script: { type: 'string', description: 'The TypeScript workflow script (inline source).' },
        path: { type: 'string', description: 'A script file on disk (normally the draft a previous result named).' },
        saved: {
          type: 'object',
          description: 'Run a saved workflow by name.',
          properties: {
            name: { type: 'string' },
            scope: { type: 'string', enum: ['project', 'global'] },
            args: { type: 'object', description: 'Arguments declared by the saved workflow.' },
          },
          required: ['name'],
        },
        args: { type: 'object', description: 'Arguments for a `path` script (read through the `args` global).' },
        max_concurrency: { type: 'integer', description: 'Bound on tasks in flight at once (default: machine parallelism).' },
        subagent_model: { type: 'string', description: 'provider/model or bare model id (optionally $effort) the subagents run on (default: this session\'s model).' },
      },
      additionalProperties: false,
    },
    execute: async (args, exec) => {
      const agent = requireAgent(exec, 'create_workflow')
      const cwd = agent.session.header.cwd ?? process.cwd()
      const sources = [args.script, args.path, args.saved].filter(value => value !== undefined && value !== null)
      if (sources.length !== 1) throw new Error('Pass exactly one of `script`, `path` or `saved`.')
      let scriptText: string
      let scriptPath: string | undefined
      let runArgs: Record<string, unknown> | undefined
      let name = str(args.name)
      if (args.saved !== undefined && args.saved !== null) {
        if (typeof args.saved !== 'object' || Array.isArray(args.saved)) throw new Error('`saved` must be an object with a `name` string.')
        const saved = args.saved as { name?: unknown; scope?: unknown; args?: Record<string, unknown> }
        const found = typeof saved.name === 'string' ? findSaved(cwd, saved.name, saved.scope === 'project' || saved.scope === 'global' ? saved.scope : undefined) : undefined
        if (found === undefined) throw new Error(`No saved workflow named ${JSON.stringify(saved.name)}. list_saved_workflows lists them.`)
        const resolved = resolveSavedArgs(found, saved.args)
        if (!resolved.ok) throw new Error(resolved.message)
        scriptText = found.script
        runArgs = resolved.args
        name ??= found.name
      } else {
        gate(agent, 'create_workflow')
        if (typeof args.script === 'string') {
          scriptText = args.script
          scriptPath = writeDraft(cwd, name, scriptText)
          // the model wrote these bytes: its first edit after a diagnostic needs no re-read
          if (scriptPath !== undefined) await recordAuthoredDraft(ctx, agent, scriptPath)
        } else {
          const file = readScriptFile(cwd, String(args.path))
          scriptText = file.text
          scriptPath = file.path
          runArgs = args.args as Record<string, unknown> | undefined
        }
      }
      const analysis = analyzeWorkflowScript(scriptText)
      const pathNote = scriptPath === undefined ? '' : `\nThe script is saved at ${describePath(cwd, scriptPath)} — fix it there with edit and resubmit with \`path\`.`
      if (!analysis.ok) {
        return {
          ok: false,
          text: `The script did not compile (${analysis.diagnostics.length} diagnostic${analysis.diagnostics.length === 1 ? '' : 's'}); nothing was started.\n${diagnosticsText(analysis)}${pathNote}`,
          display: displayOf('create_workflow', analysis, { ...scriptPath === undefined ? {} : { scriptPath: describePath(cwd, scriptPath) } }),
        }
      }
      const compiled = compileOnce(scriptText)
      name ??= compiled.phases.phaseNames[0] ?? 'workflow'
      let maxConcurrency = int(args.max_concurrency) ?? service.defaultConcurrency()
      let subagentModel = service.resolveModelSpec(str(args.subagent_model), agent)
      const modelErrors = await service.validateModels(compiled, subagentModel, agent)
      if (modelErrors.length > 0) {
        return {
          ok: false,
          text: `Unknown model in workflow configuration; nothing was started:\n${modelErrors.join('\n')}${pathNote}`,
          display: displayOf('create_workflow', analysis, { name, ...scriptPath === undefined ? {} : { scriptPath: describePath(cwd, scriptPath) } }),
        }
      }
      const display = displayOf('create_workflow', analysis, {
        name, maxConcurrency, ...subagentModel === undefined ? {} : { subagentModel },
        ...scriptPath === undefined ? {} : { scriptPath: describePath(cwd, scriptPath) },
      })
      const decision = await confirmation.confirm(agent, { tool: 'create_workflow', name, scriptText, display, settings: { maxConcurrency, ...subagentModel === undefined ? {} : { subagentModel } } }, exec.signal)
      if (decision.kind !== 'allow') return denied('create_workflow', decision, display, pathNote)
      // the user may have changed the settings in the confirmation card: they win
      const adjusted = applyConfirmedSettings(decision.settings, { maxConcurrency, subagentModel })
      maxConcurrency = adjusted.maxConcurrency
      subagentModel = adjusted.subagentModel
      const result = service.submit({
        scriptText, name, parent: agent, toolCallId: exec.callId, maxConcurrency, compiled,
        ...runArgs === undefined ? {} : { args: runArgs },
        ...subagentModel === undefined ? {} : { subagentModel },
        ...scriptPath === undefined ? {} : { scriptPath },
      })
      if (!result.ok) return { ok: false, text: result.message, display }
      return {
        ok: true,
        text: [
          `Workflow "${name}" started in the background as run ${result.runId} (${compiled.phases.phaseNames.length} phases, max concurrency ${maxConcurrency}${subagentModel === undefined ? '' : `, subagents on ${subagentModel}`}).${adjusted.note}`,
          'You will be notified when it settles, and when a subagent escalates a question or the script reaches a hole. Do not poll get_workflow_run; continue with other work or end your turn.',
          ...scriptPath === undefined ? [] : [`Script: ${describePath(cwd, scriptPath)}`],
        ].join('\n'),
        display: { ...display, runId: result.runId },
      }
    },
  })

  // ————————————————————————————— amend_workflow —————————————————————————————
  register(ctx, {
    name: 'amend_workflow',
    description: AMEND_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The run to revise (any state).' },
        script: { type: 'string', description: 'The revised script (inline).' },
        path: { type: 'string', description: 'The revised script file (normally the draft you edited).' },
        name: { type: 'string' },
        max_concurrency: { type: 'integer', description: 'New bound; omit to inherit, -1 (or null) to reset to the default.' },
        subagent_model: { type: 'string', description: 'provider/model or bare model id (optionally $effort); omit to inherit, "" to reset to the session model.' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
    execute: async (args, exec) => {
      const agent = requireAgent(exec, 'amend_workflow')
      const cwd = agent.session.header.cwd ?? process.cwd()
      const runId = String(args.run_id)
      const predecessor = service.journal.getRun(runId)
      if (predecessor === undefined) throw new Error(`No workflow run ${runId} exists.`)
      assertOwnRun(service, agent, runId)
      const settingsOnly = args.script === undefined && args.path === undefined
      const maxArg = int(args.max_concurrency)
      // `null` (the skill's wording) and a negative number (the schema's) both mean "back to the default".
      const resetMax = args.max_concurrency === null || (maxArg !== undefined && maxArg < 0)
      // Settings-only change of a live run's bound: retune in place.
      if (settingsOnly && (resetMax || maxArg !== undefined) && args.subagent_model === undefined && args.name === undefined && service.liveRun(runId) !== undefined) {
        const retuned = service.retune(runId, resetMax ? null : maxArg!)
        return { ok: retuned.ok, text: `${retuned.message} Run ${runId} keeps its id; tasks in flight finish where they are.`, data: { kind: 'dynamic-workflow-retune', runId, ...retuned } }
      }
      if (!settingsOnly) gate(agent, 'amend_workflow')
      let scriptText: string
      let scriptPath: string | undefined
      if (typeof args.script === 'string') {
        scriptText = args.script
        scriptPath = writeDraft(cwd, str(args.name) ?? predecessor.name, scriptText)
        if (scriptPath !== undefined) await recordAuthoredDraft(ctx, agent, scriptPath)
      } else if (typeof args.path === 'string') {
        const file = readScriptFile(cwd, args.path)
        scriptText = file.text
        scriptPath = file.path
      } else {
        if (predecessor.scriptText === undefined) throw new Error(`Run ${runId} has no stored script to re-run.`)
        scriptText = predecessor.scriptText
        scriptPath = service.liveRun(runId)?.scriptPath
      }
      const analysis = analyzeWorkflowScript(scriptText)
      const pathNote = scriptPath === undefined ? '' : `\nThe script is at ${describePath(cwd, scriptPath)} — fix it there and resubmit with \`path\`.`
      if (!analysis.ok) {
        return {
          ok: false,
          text: `The revised script did not compile; nothing was started or stopped.\n${diagnosticsText(analysis)}${pathNote}`,
          display: displayOf('amend_workflow', analysis),
        }
      }
      const compiled: CompiledScript = compileOnce(scriptText)
      const name = str(args.name) ?? predecessor.name ?? compiled.phases.phaseNames[0] ?? 'workflow'
      let maxConcurrency = resetMax ? service.defaultConcurrency() : maxArg ?? predecessor.caps.maxConcurrency
      const rawSubagentModel = args.subagent_model === '' ? undefined : str(args.subagent_model) ?? (args.subagent_model === undefined ? launchedSubagentModel(service, runId) : undefined)
      let subagentModel = service.resolveModelSpec(rawSubagentModel, agent)
      const modelErrors = await service.validateModels(compiled, subagentModel, agent)
      if (modelErrors.length > 0) {
        return {
          ok: false,
          text: `Unknown model in amended workflow configuration; nothing was started or stopped:\n${modelErrors.join('\n')}${pathNote}`,
          display: displayOf('amend_workflow', analysis, { name, supersededRunId: runId }),
        }
      }
      const display = displayOf('amend_workflow', analysis, {
        name, maxConcurrency, supersededRunId: runId, ...subagentModel === undefined ? {} : { subagentModel },
        ...scriptPath === undefined ? {} : { scriptPath: describePath(cwd, scriptPath) },
      })
      // Amending this session's own run (not stopped by the user) skips confirmation ONLY when it
      // introduces no new provider beyond what the predecessor already authorized (ZCode parity).
      const prevProviders = service.launchedProviders(runId)
      const nextProviders = service.candidateProviders(compiled, subagentModel, agent)
      const introducesProvider = [...nextProviders].some(provider => !prevProviders.has(provider))
      const own = predecessor.parentSessionId === (agent.id as string) && predecessor.stopReason !== 'user' && !introducesProvider
      if (!own) {
        const decision = await confirmation.confirm(agent, { tool: 'amend_workflow', name, scriptText, display, settings: { maxConcurrency, ...subagentModel === undefined ? {} : { subagentModel } } }, exec.signal)
        if (decision.kind !== 'allow') return denied('amend_workflow', decision, display, pathNote)
        const adjusted = applyConfirmedSettings(decision.settings, { maxConcurrency, subagentModel })
        maxConcurrency = adjusted.maxConcurrency
        subagentModel = adjusted.subagentModel
      }
      const result = await service.amend({
        predecessorRunId: runId, scriptText, name, parent: agent, toolCallId: exec.callId, maxConcurrency, compiled,
        ...subagentModel === undefined ? {} : { subagentModel },
        ...scriptPath === undefined ? {} : { scriptPath },
      })
      if (!result.ok) return { ok: false, text: result.message, display }
      return {
        ok: true,
        text: `Run ${result.runId} started, amending ${runId}${result.supersededRunId === undefined ? '' : ' (which was still running and is now stopped as superseded)'}. Its finished work is imported as cache. You will be notified when it settles.`,
        display: { ...display, runId: result.runId, ...result.supersededRunId === undefined ? {} : { supersededRunId: result.supersededRunId } },
      }
    },
  })

  // ————————————————————————————— fill_workflow_hole —————————————————————————————
  register(ctx, {
    name: 'fill_workflow_hole',
    description: [
      'Write the body of a hole a running workflow is waiting at (`<workflow-hole>` notification). Starts nothing: the body is compiled where the hole stands, sees every binding declared before it, and must return the hole\'s type — or do one step and end with a new tail hole (`return await hole<T>("next step", …)`).',
      'Pass the statements only (not the hole call, not an arrow). A hole is filled once; a body under a loop reruns on every iteration. On diagnostics, fix the body and call again.',
      SKILL_SENTENCE,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        hole_id: { type: 'string', description: 'The hole id from the notification (hole#xxxxxxxx).' },
        script: { type: 'string', description: 'The body statements.' },
        path: { type: 'string', description: 'A file holding the body statements.' },
      },
      required: ['run_id', 'hole_id'],
      additionalProperties: false,
    },
    execute: async (args, exec) => {
      const agent = requireAgent(exec, 'fill_workflow_hole')
      gate(agent, 'fill_workflow_hole')
      const cwd = agent.session.header.cwd ?? process.cwd()
      const body = typeof args.script === 'string' ? args.script : typeof args.path === 'string' ? readScriptFile(cwd, args.path).text : undefined
      if (body === undefined) throw new Error('Pass the hole body as `script` or `path`.')
      const runId = String(args.run_id)
      assertOwnRun(service, agent, runId)
      const result = await fillHole(service.liveRun(runId), { runId, holeId: String(args.hole_id), body, filledBy: agent.id as string })
      if (!result.ok) {
        return { ok: false, text: `${result.message}${result.diagnostics === undefined ? '' : `\n${result.diagnostics.map(d => `L${d.line}:C${d.column} ${d.message}`).join('\n')}`}` }
      }
      const analysis = analyzeWorkflowScript(result.scriptText)
      return {
        ok: true,
        text: `Filled ${String(args.hole_id)} of run ${runId}; the parked branch continues.${result.phasesAdded.length === 0 ? '' : ` New phases: ${result.phasesAdded.join(', ')}.`}${result.scriptPath === undefined ? '' : ` The effective script is at ${describePath(cwd, result.scriptPath)}.`}`,
        display: displayOf('fill_workflow_hole', analysis, { runId, fill: { siteId: String(args.hole_id), name: String(args.hole_id) } }),
      }
    },
  })

  // ————————————————————————————— resume / stop —————————————————————————————
  register(ctx, {
    name: 'resume_workflow_run',
    description: 'Resume a STOPPED workflow run under its byte-identical script: finished steps replay from the journal and only the unfinished ones run again. Refused for completed, errored (use amend_workflow) and superseded runs. A run the user stopped is resumed only when the user asks.',
    parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'], additionalProperties: false },
    execute: async (args, exec) => {
      const agent = requireAgent(exec, 'resume_workflow_run')
      assertOwnRun(service, agent, String(args.run_id))
      const result = await service.resume(String(args.run_id), agent)
      return result.ok
        ? { ok: true, text: `Run ${result.runId} resumed in the background; you will be notified when it settles.`, data: { kind: 'dynamic-workflow-resume', runId: result.runId } }
        : { ok: false, text: `${result.reason}: ${result.message}` }
    },
  })

  register(ctx, {
    name: 'stop_workflow_run',
    description: 'Stop a running workflow run (it settles as stopped(model) and stays resumable). To fix a running run, prefer amend_workflow, which stops it for you and reuses its finished work.',
    parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'], additionalProperties: false },
    execute: async (args, exec) => {
      assertOwnRun(service, requireAgent(exec, 'stop_workflow_run'), String(args.run_id))
      const result = service.cancel(String(args.run_id), 'model')
      return { ok: result.ok, text: result.message }
    },
  })

  // ————————————————————————————— questions —————————————————————————————
  register(ctx, {
    name: 'resolve_workflow_question',
    description: 'Answer a question a workflow subagent escalated (`<workflow-escalation>` notification). Only the asking subagent is parked; the answer is delivered verbatim and its turn continues. Nothing times out: answer, or ask the user if the decision is theirs.',
    parameters: {
      type: 'object',
      properties: { question_id: { type: 'string', description: 'dwfq-… id from the notification.' }, answer: { type: 'string' } },
      required: ['question_id', 'answer'],
      additionalProperties: false,
    },
    execute: async (args, exec) => {
      const runId = service.questionRun(String(args.question_id))
      if (runId !== undefined) assertOwnRun(service, requireAgent(exec, 'resolve_workflow_question'), runId)
      const result = service.resolveQuestion(String(args.question_id), String(args.answer))
      return result.ok ? { ok: true, text: `Answered ${result.qid}; the subagent continues.` } : { ok: false, text: `${result.reason}: ${result.message}` }
    },
  })

  // ————————————————————————————— introspection —————————————————————————————
  const steering = 'Do NOT poll: notifications arrive by themselves. Use this only when the user asks, to review history, or after a truncated notification.'
  register(ctx, {
    name: 'get_workflow_run',
    description: `Read one workflow run from its journal: status, progress, tokens, reported items, artifacts, open questions and holes, a log tail, the result or failure. ${steering}`,
    parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'], additionalProperties: false },
    readOnly: true,
    execute: async (args) => {
      const runId = String(args.run_id)
      if (service.journal.getRun(runId) === undefined && service.liveRun(runId) === undefined) return { ok: false, text: `No workflow run ${runId} exists.` }
      const snap = service.snapshot(runId)
      const lines = [
        `Run ${snap.runId} — "${snap.name}": ${snap.status}${snap.stopReason === undefined ? '' : ` (${snap.stopReason})`}${snap.resumable ? ' — resumable' : ''}`,
        `Tasks: ${snap.nodes.completed} done, ${snap.nodes.running} running, ${snap.nodes.failed} failed · tokens ${snap.spentTokens} · max concurrency ${snap.maxConcurrency}`,
        ...snap.resumedFrom === undefined ? [] : [`Amends ${snap.resumedFrom}`],
        ...snap.supersededBy === undefined ? [] : [`Superseded by ${snap.supersededBy}`],
        `Subagents: ${snap.actors.map(actor => actor.name ?? `${actor.siteId}@${actor.ordinal}`).join(', ') || '(none yet)'}`,
        ...snap.pendingQuestions.length === 0 ? [] : ['Open questions:', ...snap.pendingQuestions.map(q => `- ${q.qid} from ${q.actorName ?? q.actor}: ${q.question}`)],
        ...snap.openHoles.length === 0 ? [] : ['Open holes:', ...snap.openHoles.map(h => `- ${h.siteId} "${h.name}"`)],
        ...snap.reports.count === 0 ? [] : [`Reports (${snap.reports.count}${snap.reports.preview.length < snap.reports.count ? `, first ${snap.reports.preview.length}` : ''}):`, ...snap.reports.preview.map(item => `- ${item}`)],
        ...snap.artifacts.length === 0 ? [] : ['Artifacts:', ...snap.artifacts.map(a => `- ${a.title ?? a.id} (${a.kind} v${a.version}${a.primary ? ', primary' : ''})`)],
        ...snap.logTail.length === 0 ? [] : ['Log tail:', ...snap.logTail.map(line => `  ${line}`)],
        ...snap.result === undefined ? [] : ['Result:', typeof snap.result === 'string' ? snap.result : JSON.stringify(snap.result, null, 2).slice(0, 20_000)],
        ...snap.failure === undefined ? [] : ['Failure:', snap.failure.providerStop === undefined ? snap.failure.message : formatProviderStopError(snap.failure, runId)],
      ]
      return { ok: true, text: lines.join('\n'), data: { kind: 'dynamic-workflow-snapshot', snapshot: snap } }
    },
  })

  register(ctx, {
    name: 'list_workflow_runs',
    description: `List recent workflow runs (this session's first, then the project's). ${steering}`,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '1–50, default 20.' },
        all_sessions: { type: 'boolean', description: 'Include runs started by other sessions.' },
      },
      additionalProperties: false,
    },
    readOnly: true,
    execute: async (args, exec) => {
      const limit = Math.max(1, Math.min(50, int(args.limit) ?? 20))
      const rows = service.listRuns(args.all_sessions === true ? undefined : exec.agent?.id as string | undefined, limit)
      if (rows.length === 0) return { ok: true, text: 'No workflow runs yet.' }
      return {
        ok: true,
        text: rows.map(row => `${row.runId}  ${row.status}${row.stopReason === undefined ? '' : `(${row.stopReason})`}  "${row.name}"  tokens=${row.spentTokens}  updated=${new Date(row.updated).toISOString()}`).join('\n'),
        data: { kind: 'dynamic-workflow-runs', rows },
      }
    },
  })

  // ————————————————————————————— saved workflows —————————————————————————————
  register(ctx, {
    name: 'save_workflow',
    description: 'Save a workflow so the user can run it again by name (project: <cwd>/.dsh/workflows, global: $DSH_HOME/workflows). NEVER call this unsolicited: suggest saving in one sentence and wait for the user to agree.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        whenToUse: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'global'] },
        script: { type: 'string' },
        script_path: { type: 'string' },
        run_id: { type: 'string', description: 'Save the effective script of this run.' },
        args: { type: 'object', description: 'Declared arguments: { name: { type, description, default, required } }.' },
      },
      required: ['name', 'description', 'scope'],
      additionalProperties: false,
    },
    execute: async (args, exec) => {
      const agent = requireAgent(exec, 'save_workflow')
      gate(agent, 'save_workflow')
      const cwd = agent.session.header.cwd ?? process.cwd()
      const script = typeof args.script === 'string' ? args.script
        : typeof args.script_path === 'string' ? readScriptFile(cwd, args.script_path).text
          : typeof args.run_id === 'string' ? service.journal.getRun(args.run_id)?.scriptText : undefined
      if (script === undefined) throw new Error('Pass `script`, `script_path` or `run_id`.')
      const analysis = analyzeWorkflowScript(script)
      if (!analysis.ok) return { ok: false, text: `The script does not compile, so it was not saved:\n${diagnosticsText(analysis)}` }
      const scope: 'project' | 'global' = args.scope === 'global' ? 'global' : 'project'
      const workflowName = String(args.name)
      const description = String(args.description)
      const targetPath = join(savedDir(cwd, scope), `${slugOf(workflowName, script)}.dwf.ts`)
      const overwrites = existsSync(targetPath)
      const display = displayOf('save_workflow', analysis, { name: workflowName })
      const decision = await confirmation.confirm(agent, {
        tool: 'save_workflow',
        name: workflowName,
        scriptText: script,
        display,
        settings: { maxConcurrency: service.defaultConcurrency() },
        allowAlways: false,
        saveTarget: { scope, path: describePath(cwd, targetPath), description, overwrites },
      }, exec.signal)
      if (decision.kind !== 'allow') {
        return { ok: false, text: 'The user declined to save this workflow. Nothing was written.' }
      }
      const path = writeSaved(cwd, scope, {
        name: workflowName, description,
        ...typeof args.whenToUse === 'string' ? { whenToUse: args.whenToUse } : {},
        ...typeof args.args === 'object' && args.args !== null ? { args: args.args as never } : {},
      }, script)
      return { ok: true, text: `Saved "${workflowName}" at ${describePath(cwd, path)}. Run it with create_workflow { saved: { name: "${workflowName}" } }.` }
    },
  })

  register(ctx, {
    name: 'list_saved_workflows',
    description: 'List the saved workflows of this project and the global ones (a project workflow hides a global one of the same name). Check this before writing a workflow from scratch.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    execute: async (_args, exec) => {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const saved = listSaved(cwd)
      if (saved.length === 0) return { ok: true, text: 'No saved workflows.' }
      return {
        ok: true,
        text: saved.map(item => `- ${item.name} [${item.scope}]: ${item.description}${item.whenToUse === undefined ? '' : ` (use when: ${item.whenToUse})`}${item.args === undefined ? '' : ` args: ${Object.keys(item.args).join(', ')}`}`).join('\n'),
        data: { kind: 'dynamic-workflow-saved', saved: saved.map(({ script: _script, ...rest }) => rest) },
      }
    },
  })

  if (deps.snippets !== undefined) {
    const snippets = deps.snippets
    register(ctx, {
      name: 'eval_workflow_snippet',
      description: 'Run a fragment of workflow script through the real compiler and sandbox with the world-read facade only (files.*, git.*, world.run, log, channel/future) — no subagents, no reports, nothing persisted. Use it to try a world.run gate or a files.glob routing before putting it in a workflow.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string' }, path: { type: 'string' }, timeoutMs: { type: 'integer', description: '1000–600000, default 60000' } },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const agent = requireAgent(exec, 'eval_workflow_snippet')
        gate(agent, 'eval_workflow_snippet')
        const cwd = agent.session.header.cwd ?? process.cwd()
        const hasCode = typeof args.code === 'string'
        const hasPath = typeof args.path === 'string'
        if (hasCode === hasPath) throw new Error('Pass exactly one of `code` or `path`.')
        const code = hasCode ? args.code as string : readScriptFile(cwd, args.path as string).text
        const inspected = snippets.inspect(code)
        if (!inspected.ok) return { ok: false, text: inspected.text }
        if (inspected.prepared.worldRunCommands.length > 0) {
          const display: WorkflowLaunchDisplay = { kind: 'dynamic-workflow-launch', tool: 'eval_workflow_snippet', ok: true, errorCount: 0, diagnostics: [], name: 'snippet' }
          const decision = await confirmation.confirm(agent, {
            tool: 'eval_workflow_snippet',
            name: 'snippet',
            scriptText: code,
            display,
            settings: { maxConcurrency: 4 },
            allowAlways: false,
            commands: inspected.prepared.worldRunCommands,
          }, exec.signal)
          if (decision.kind !== 'allow') return denied('eval_workflow_snippet', decision, display, '')
        }
        const result = await snippets.run(code, cwd, Math.max(1000, Math.min(600_000, int(args.timeoutMs) ?? 60_000)), exec.signal, inspected.prepared)
        return { ok: result.ok, text: result.text }
      },
    })
  }
}

function launchedSubagentModel(service: RunService, runId: string): string | undefined {
  const events = service.journal.listEvents(runId, { types: ['run-launched'], reportItems: { limit: 0 }, limit: 1 })
  const launched = events[0]?.event
  return launched?.type === 'run-launched' ? launched.subagentModel : undefined
}

function denied(tool: string, decision: { kind: 'deny' } | { kind: 'refine'; feedback: string }, display: WorkflowLaunchDisplay, pathNote: string): ToolValue {
  if (decision.kind === 'refine') {
    return {
      ok: false,
      text: `The user did not run this workflow and asked for changes${decision.feedback.length === 0 ? '.' : `: ${decision.feedback}`}\nRevise the script accordingly and call ${tool} again.${pathNote}`,
      display: { ...display, denied: { reason: 'refined', feedback: decision.feedback } },
    }
  }
  return {
    ok: false,
    text: 'The user declined to run this workflow. Nothing was started. Do not resubmit it unless the user asks.',
    display: { ...display, denied: { reason: 'denied' } },
  }
}
