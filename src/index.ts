/**
 * dsh-dynamic-workflow — ZCode's dynamic workflows as a DeepSeek Harness plugin.
 *
 * The model writes a TypeScript script against a small facade (`agent()`,
 * `.ask<T>()`, `files.*`, `git.*`, `world.run`, `report`, `artifact.*`,
 * `phase()`, `hole<T>()`); the harness typechecks it, draws its phase graph,
 * asks the user to confirm, runs it in a sandboxed child process with one DSH
 * child agent per subagent, journals every step to SQLite (resume / amend by
 * replay), and reports back to the main agent through notifications.
 *
 * The pure compiler / analyzer / engine / sandbox are ZCode's
 * `@zcode/dynamic-workflow` and `@zcode/dynamic-workflow-runtime` (Apache-2.0),
 * vendored unchanged under `vendor/`.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { userMessage } from './dsh/messages.ts'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { createEscalationRegistry } from './driver/escalations.ts'
import { createSqliteJournal, FileChanges, RunOwnership } from './journal/journal.ts'
import { openJournalDatabase } from './journal/schema.ts'
import { NotificationDelivery } from './notify/delivery.ts'
import { createArtifactStore } from './service/artifacts.ts'
import type { ProgressPayload } from './service/progress.ts'
import { RunService } from './service/run-service.ts'
import { createSnippetRunner } from './service/snippet.ts'
import { LaunchConfirmation, type ConfirmMode } from './tools/confirm.ts'
import { WORKFLOW_SKILL_NAME } from './tools/skill-gate.ts'
import { registerWorkflowTools } from './tools/tools.ts'
import { registerWorkflowRoutes } from './web/routes.ts'
import { registerRunProjection } from './web/projection.ts'
import { ConcurrencyGovernor, installGovernor } from './governor/governor.ts'
import { loadSkillContent } from './skill.ts'
import { startQuotaAutoResume } from './service/quota-resume.ts'
import { hostModules, loadHostModules, whenHostModules } from './dsh/host.ts'
import { resolveOwnerAgent } from './dsh/owner.ts'
import { installDraftWriteExemption } from './tools/drafts.ts'
import { WORKFLOW_ROUTINGS, WorkflowAccess, type WorkflowMode, type WorkflowRouting } from './tools/routing.ts'

export const name = 'dynamic-workflow'
export const inject = ['tools', 'agents', 'systemPrompt']

/**
 * Progress is persisted as an out-of-tree *plugin record* (`ignorable: true`): DSH refuses to
 * reload a log holding an unknown event type without that marker, and `appendPluginRecord`
 * is the supported writer that stamps it.
 */
export const PROGRESS_EVENT = 'plugin:dynamic-workflow/progress'

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** One bounded run event of a dynamic workflow owned by this session (log-only, GUI projection). */
    'plugin:dynamic-workflow/progress': ProgressPayload
  }
}

export interface Config {
  /** Directory for the journal and artifacts (default `$DSH_HOME/state/dynamic-workflow`). */
  stateDir?: string
  /** `ask` (default): confirm every launch; `never`: run without asking (headless); `ask-or-allow`: ask when a UI can answer, else run. */
  confirm?: ConfirmMode
  /** Keep the owning agent's turn open while it has live runs (headless / SDK). Default false. */
  holdTurnWhileRunning?: boolean
  /** Default per-run bound on tasks in flight (default: machine parallelism, 2–16). */
  defaultMaxConcurrency?: number
  /** Refuse authoring tools until the `dynamic-workflows` skill is loaded (default true). */
  skillGate?: boolean
  /** Persona names (or name prefixes ending in `*`) whose subagents get read-only tools. */
  readOnlySubagents?: string[]
  /** Resume runs stopped by an exhausted provider quota once it resets (default on). */
  quotaAutoResume?: boolean
  /**
   * `alwaysOn` (default): the workflow tools are offered from a session's first request.
   * `onDemand`: offered once the session is activated (`/workflow`, a resume or configure of its
   * run, or a session that already holds a workflow). `disabled`: no way to start a workflow.
   */
  mode?: WorkflowMode
  /**
   * How the model treats tasks the user did not name a workflow for: `explicit` (default, only an
   * explicit request starts one), `suggest` (describe a workflow and its rough cost, then ask), or
   * `auto` (run one for every substantive task). Overridable per session with `/dwf routing …`.
   */
  routing?: WorkflowRouting
  /** Typed `submit_result` schema: `exact` (default, the precise JSON Schema) or `relaxed` (DSH's enforced subset, for endpoints that reject richer schemas). */
  resultSchema?: 'exact' | 'relaxed'
  /** Process-wide adaptive request governor for workflow subagents (default on); `false` disables it. */
  governor?: false | { initial?: number; growthLimit?: number }
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function packageRoot(): string {
  // src/index.ts (dev) and lib/index.js (built) both sit one level under the package root.
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

export function apply(ctx: Context, config: Config = {}): void {
  const stateDir = config.stateDir ?? join(dshHome(), 'state', 'dynamic-workflow')
  mkdirSync(stateDir, { recursive: true })
  const db = openJournalDatabase(join(stateDir, 'journal.sqlite'))
  try {
    applyWithDatabase(ctx, config, stateDir, db)
  } catch (error) {
    try { db.close() } catch { /* already closed */ }
    throw error
  }
}

function applyWithDatabase(ctx: Context, config: Config, stateDir: string, db: ReturnType<typeof openJournalDatabase>): void {
  const journal = createSqliteJournal(db)
  const escalations = createEscalationRegistry()
  const artifacts = createArtifactStore(join(stateDir, 'artifacts'))
  const logger = ctx.logger as unknown as { warn(message: string, ...args: unknown[]): void; info(message: string, ...args: unknown[]): void }

  let service!: RunService
  let governor: ConcurrencyGovernor | undefined
  const delivery = new NotificationDelivery(ctx, {
    holdTurnWhileRunning: config.holdTurnWhileRunning === true,
    hasLiveRuns: id => service.hasLiveRuns(id),
    blockedReminder: id => service.blockedReminder(id),
    logger,
  })

  const readOnly = config.readOnlySubagents ?? []
  const accessOf = readOnly.length === 0 ? undefined : (persona: { name?: string }): 'full' | 'read-only' => {
    const personaName = persona.name ?? ''
    return readOnly.some(pattern => pattern.endsWith('*') ? personaName.startsWith(pattern.slice(0, -1)) : pattern === personaName) ? 'read-only' : 'full'
  }

  service = new RunService({
    ctx,
    journal,
    escalations,
    delivery,
    artifacts,
    ...config.defaultMaxConcurrency === undefined ? {} : { defaultMaxConcurrency: config.defaultMaxConcurrency },
    logger,
    onProgress: (parentSessionId, payload) => appendProgress(ctx, parentSessionId, payload),
    readSessionEvents: sessionId => readSessionEvents(ctx, sessionId),
    transcriptsReadable: () => ctx.get('sessionPersistence' as never) !== undefined,
    buildForkSeed: (events, boundary) => forkSeed(ctx, events, boundary),
    ...accessOf === undefined ? {} : { accessOf },
    governed: config.governor !== false,
    ...config.resultSchema === undefined ? {} : { resultSchema: config.resultSchema },
    governorCap: key => governor?.capOf(key),
    ownership: new RunOwnership(db),
    fileChanges: new FileChanges(db),
  })
  if (process.env.DWF_TEST_HOOK !== undefined) {
    (globalThis as { __dwfTest?: { service?: RunService } }).__dwfTest ??= {}
    ;(globalThis as unknown as { __dwfTest: { service?: RunService } }).__dwfTest.service = service
  }
  const orphans = service.reconcileOrphans()
  if (orphans > 0) logger.info('dynamic-workflow: marked %d interrupted run(s) from a previous process as stopped(interrupted)', orphans)
  // The owner sessions were not loaded when their runs were marked interrupted: settle each run in
  // its owner's log (and so in the run card) as soon as that session's agent comes back.
  ctx.on('agent/created', ({ agent }) => {
    const pending = service.takeOrphans(agent.id as string)
    if (pending.length === 0) return undefined
    setTimeout(() => {
      for (const runId of pending) {
        appendProgress(ctx, agent.id as string, { runId, sequence: -1, eventType: 'run-settled', payload: { status: 'stopped', stopReason: 'interrupted', resumable: true, error: { code: 'Interrupted', message: 'The process that ran this workflow exited before it settled.' } }, at: Date.now() })
      }
    }, 0)
    return undefined
  })

  // Runs stopped by an exhausted quota resume by themselves once it resets (ZCode parity).
  if (config.quotaAutoResume !== false) {
    const quota = startQuotaAutoResume({
      journal,
      subscribeRunSettled: listener => service.subscribeSettled(listener),
      resume: async (runId) => {
        const owner = journal.getRun(runId)?.parentSessionId
        const agent = owner === undefined ? undefined : await resolveOwnerAgent(ctx, owner)
        if (agent === undefined) return { ok: false, reason: 'owner_unavailable', message: `The session that owns run ${runId} is not loaded.` }
        return service.resume(runId, agent)
      },
      logger,
    })
    ctx.effect(() => () => quota.dispose())
  }

  if (config.governor !== false) {
    const initial = config.governor?.initial ?? service.defaultConcurrency()
    installGovernor(ctx, governor = new ConcurrencyGovernor({
      initial,
      growthLimit: config.governor?.growthLimit ?? initial * 2,
      onChange: (change) => {
        logger.info('dynamic-workflow: governor %s cap %d → %d (%s)', change.key, change.previous, change.next, change.reason)
        service.noteConcurrencyChange(change)
      },
      onQueued: options => service.noteModelRequest(String((options as { sessionId?: string }).sessionId ?? ''), 'waiting', governorKey(options)),
      onAdmitted: options => service.noteModelRequest(String((options as { sessionId?: string }).sessionId ?? ''), 'executing', governorKey(options)),
    }))
  }

  const confirmation = new LaunchConfirmation(ctx, () => config.confirm ?? 'ask')
  const access = new WorkflowAccess(ctx, config.mode ?? 'alwaysOn', config.routing ?? 'explicit', sessionId => journal.listRunRows(sessionId, 1).length > 0)
  if (access.enabled) {
    registerWorkflowTools({ ctx, service, confirmation, snippets: createSnippetRunner(), skillGate: config.skillGate !== false, access })
    installDraftWriteExemption(ctx)
  }

  // Routing policy ships with the tools (DSH convention: tool guidance lives in tool plugins); it
  // is per session (routing) and present only while the tools are offered (mode).
  ctx.systemPrompt.section({
    name: 'tool:create_workflow',
    order: 9000,
    interpolate: false,
    text: (context: { agent?: Agent }) => access.sectionText(context.agent),
  } as never)

  // Runtime status of the agent's live runs, re-sent by DSH only when it changes (DSH-native:
  // the model always knows a run is live and what it is waiting on, without polling tools).
  ctx.systemPrompt.context({
    name: 'dynamic-workflow:runs',
    order: 9100,
    interpolate: false,
    text: (context: { agent?: Agent }) => context.agent === undefined ? '' : service.runtimeStatus(context.agent.id as string),
  } as never)

  // The skill: SKILL.md inline, patterns.md / examples.md as resources next to it.
  const skillDir = join(packageRoot(), 'skills', WORKFLOW_SKILL_NAME)
  if (access.enabled) ctx.inject(['skills'], (scope) => {
    const skills = scope.get('skills') as { register(skill: unknown): () => void }
    const loaded = loadSkillContent(skillDir)
    if (loaded === undefined) {
      logger.warn('dynamic-workflow: skill directory %s not found; the skill gate is still enforced', skillDir)
      return
    }
    scope.effect(() => skills.register({
      name: WORKFLOW_SKILL_NAME,
      description: loaded.description,
      ...loaded.whenToUse === undefined ? {} : { whenToUse: loaded.whenToUse },
      content: loaded.content,
      source: 'runtime',
      ...existsSync(skillDir) ? { resourceBase: { kind: 'directory', path: skillDir } } : {},
    }))
  })

  // `/workflow <instructions>` and `/dwf list|stop|resume|routing`.
  ctx.inject(['commands'], (scope) => {
    const commands = scope.get('commands') as { register(definition: unknown): () => void }
    if (access.enabled) scope.effect(() => commands.register({
      name: 'workflow',
      description: 'Ask the agent to do this with a dynamic workflow (a typechecked multi-subagent script).',
      input: { hint: '<what the workflow should do>' },
      handler: (invocation: { agent: Agent; rawInput: string }) => {
        const instructions = invocation.rawInput.trim()
        if (instructions.length === 0) return { kind: 'error', text: 'Usage: /workflow <what the workflow should do>' }
        access.activate(invocation.agent)
        // `/dynamic-workflows` is DSH's own skill gesture: tool-skill injects the skill body into
        // this very request, so the model starts writing at once instead of spending a round
        // trip on the skill tool. Without tool-skill the sentence after it still says what to do.
        invocation.agent.followup(userMessage(
          `/${WORKFLOW_SKILL_NAME} Use a dynamic workflow for this request. If the \`${WORKFLOW_SKILL_NAME}\` skill content is not in this conversation yet, load it with the skill tool first.\n\nRequest:\n${instructions}\n\nDecide the subagent topology before writing any code: how many subagents, which of them share a context vs. need fresh eyes (for example: design/plan review, independent verification or audit), what typed result each one returns, and what deterministic \`world.run\` gates decide completion. Then write the script and submit it with \`create_workflow\` (do not use DSH's plain-JS \`workflow\` tool, and do not substitute \`subagent\`).`,
          { kind: 'user' },
        ))
        return { kind: 'success' }
      },
    }))
    scope.effect(() => commands.register({
      name: 'dwf',
      description: 'Dynamic workflows: /dwf list · /dwf stop <run_id> · /dwf resume <run_id> · /dwf routing [explicit|suggest|auto]',
      input: { hint: 'list | stop <run_id> | resume <run_id> | routing [explicit|suggest|auto]' },
      handler: async (invocation: { agent: Agent; rawInput: string }) => {
        const [verb, runId] = invocation.rawInput.trim().split(/\s+/)
        if (verb === 'routing') {
          if (runId === undefined) return { kind: 'success', text: `Workflow routing for this session: ${access.routingOf(invocation.agent)} (mode ${access.mode}).` }
          if (!(WORKFLOW_ROUTINGS as readonly string[]).includes(runId)) return { kind: 'error', text: 'Usage: /dwf routing explicit|suggest|auto' }
          access.setRouting(invocation.agent, runId as WorkflowRouting)
          return { kind: 'success', text: `Workflow routing for this session: ${runId}.` }
        }
        if (verb === undefined || verb === '' || verb === 'list') {
          const rows = service.listRuns(invocation.agent.id as string, 20)
          return { kind: 'success', text: rows.length === 0 ? 'No workflow runs in this session.' : rows.map(row => `${row.runId}  ${row.status}${row.stopReason === undefined ? '' : `(${row.stopReason})`}  ${row.name}`).join('\n') }
        }
        if (runId === undefined) return { kind: 'error', text: 'Usage: /dwf stop <run_id> | /dwf resume <run_id>' }
        const owner = service.journal.getRun(runId)?.parentSessionId
        if (owner !== undefined && owner !== (invocation.agent.id as string)) {
          return { kind: 'error', text: `Run ${runId} belongs to another session; only the session that started it can control it.` }
        }
        if (verb === 'stop') {
          const result = service.cancel(runId, 'user')
          return result.ok ? { kind: 'success', text: result.message } : { kind: 'error', text: result.message }
        }
        if (verb === 'resume') {
          if (!access.enabled) return { kind: 'error', text: 'Dynamic workflows are disabled in this deployment; existing runs can be viewed but not resumed.' }
          access.activate(invocation.agent)
          const result = await service.resume(runId, invocation.agent)
          return result.ok ? { kind: 'success', text: `Run ${runId} resumed.` } : { kind: 'error', text: result.message }
        }
        return { kind: 'error', text: `Unknown subcommand ${verb}.` }
      },
    }))
  })

  // Web: run-state projection for the client plugin, and read routes (run detail, artifacts, user actions).
  registerRunProjection(ctx)
  registerWorkflowRoutes(ctx, { service, artifacts, confirmation, access })

  ctx.effect(() => () => {
    delivery.dispose()
    return service.close().finally(() => {
      try { db.close() } catch { /* already closed */ }
    })
  })
}

void loadHostModules()

let warnedNoRecordWriter = false

/** Append one progress payload to the owner session as an ignorable plugin record (no-op when the owner is not loaded). */
/** The governor bucket key of a model request (`provider/model`), as the governor forms it. */
function governorKey(options: unknown): string | undefined {
  const { provider, model } = options as { provider?: unknown; model?: unknown }
  return typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : undefined
}

function appendProgress(ctx: Context, parentSessionId: string, payload: ProgressPayload): void {
  const host = hostModules()
  if (host === undefined) {
    // Host modules still loading: keep order by queueing behind them.
    whenHostModules(() => appendProgress(ctx, parentSessionId, payload))
    return
  }
  const appendRecordImpl = host.appendPluginRecord
  if (appendRecordImpl === null) {
    if (!warnedNoRecordWriter) {
      warnedNoRecordWriter = true
      ctx.logger.warn('dynamic-workflow: @deepseek-ai/dsh-session#appendPluginRecord is unavailable; run progress is not persisted to the session (the run itself is unaffected)')
    }
    return
  }
  const agent = ctx.agents.get(parentSessionId as SessionId)
  if (agent === undefined) return
  try {
    appendRecordImpl(agent.session, PROGRESS_EVENT, payload)
  } catch (error) {
    ctx.logger.warn(`dynamic-workflow: progress append failed for ${parentSessionId}: ${String(error)}`)
  }
}

/** Events of a session, live when loaded, otherwise read from persistence. */
async function readSessionEvents(ctx: Context, sessionId: string): Promise<readonly SessionEvent[]> {
  const live = ctx.agents.get(sessionId as SessionId)
  if (live !== undefined) {
    return (live.session as unknown as { snapshotEvents(): readonly SessionEvent[] }).snapshotEvents()
  }
  const persistence = ctx.get('sessionPersistence') as {
    flush?(): Promise<void>
    open(id: string, mode: 'read'): Promise<{ read(offset: number, limit: number): Promise<{ events: SessionEvent[] }>; [Symbol.asyncDispose]?(): Promise<void>; close?(): Promise<void> }>
  } | undefined
  if (persistence === undefined) return []
  await persistence.flush?.()
  const handle = await persistence.open(sessionId, 'read')
  const events: SessionEvent[] = []
  try {
    for (let offset = 0; ; ) {
      const page = await handle.read(offset, 512)
      if (page.events.length === 0) break
      events.push(...page.events)
      offset += page.events.length
    }
  } finally {
    await (handle[Symbol.asyncDispose]?.() ?? handle.close?.())
  }
  return events
}

/**
 * Minimal fork seed when `@deepseek-ai/dsh-session`'s `buildForkSeed` cannot be resolved from the
 * Host's module graph: the inclusive prefix plus the inherited `session/end-seed` marker.
 */
function localForkSeed(events: readonly SessionEvent[], boundary: number): SessionEvent[] {
  const prefix = events.slice(0, boundary + 1)
  const last = events[boundary] as { time?: number } | undefined
  prefix.push({ type: 'session/end-seed', seq: boundary + 1, time: last?.time ?? Date.now(), data: { inherited: true } } as unknown as SessionEvent)
  return prefix
}

function forkSeed(_ctx: Context, events: readonly SessionEvent[], boundary: number): SessionEvent[] {
  return (hostModules()?.buildForkSeed ?? localForkSeed)(events, boundary)
}

export async function loadForkSeedBuilder(): Promise<void> {
  await loadHostModules()
}
