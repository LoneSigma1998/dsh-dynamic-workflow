/**
 * DSH-backed `WorkflowDriver` (ZCode's "Boundary B").
 *
 * Every `agent()` of a run is one persistent child DSH Agent, created with
 * `ctx.agents.create` under a deterministic session id and owned by this
 * driver for the run's life. Each ask is one `followup` turn on that agent; a
 * typed ask is settled by the child's scoped `submit_result` tool, which hands
 * the payload to the engine and blocks on its verdict (accept / reject with
 * violations, so the model repairs in the same turn). A turn that ends without
 * an accepted submit is reported as `askTurnEnded`; the engine may answer with
 * a nudge, which runs another turn on the same agent.
 *
 * `escalate` is the fourth sequence: the child's scoped tool parks on a
 * deferred registered in the run service's escalation registry; the main agent
 * answers with `resolve_workflow_question`.
 *
 * DSH-native improvements over the ZCode driver:
 *   - the first workspace write is observed on the child's own
 *     `tools/pre-execute` waterfall, i.e. before the tool runs;
 *   - a persona may carry `access: "read-only"`, enforced with
 *     `childCtx.tools.restrict` rather than requested in prose;
 *   - an amended subagent's transcript is seeded with DSH's own fork seed
 *     (`buildForkSeed`), so the loop owns interrupted-tail closers.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { userMessage } from '../dsh/messages.ts'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  GENERIC_SUBMIT_PROFILE,
  type ConcurrencyChange,
  DEFAULT_WEB_SEARCH_BUDGET_PER_ASK,
  refToString,
  WorkflowError,
  type ActorRef,
  type ActorSessionSeed,
  type ActorSubmitProfile,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
  type AskMessage,
  type InstanceRef,
  type JournalStorePort,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type SubmitVerdict,
  type Violation,
  type WorkflowDriver,
  type WorkflowReportSink,
  type WorldReadOp,
} from '@zcode/dynamic-workflow'
import type { EscalationRegistry } from './escalations.ts'
import {
  defer,
  effectiveActorName,
  ESCALATION_BUDGET_EXHAUSTED,
  MAX_ESCALATIONS_PER_ASK,
  mintActorSessionId,
  normalizeEscalationContext,
  NUDGE_PROMPT,
  qualityEpilogue,
  questionIdFragments,
  schemaEpilogue,
  subagentLabel,
  subagentPreamble,
  toolTarget,
  toWorkflowError,
  TRANSIENT_CONTINUE_PROMPT,
  transientBackoffMs,
  TYPED_TOOL_EPILOGUE,
  type Deferred,
} from './helpers.ts'
import { classifyChildFailure, UNKNOWN_FAILURE_LIMIT, quotaResetAt } from './model-failure.ts'
import { hostModules } from '../dsh/host.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dynamic-workflow': { kind: 'dynamic-workflow' } & ({ form: 'relay' } | { form: 'notice'; summary: string })
  }
}

/** Tools the main agent has that a workflow subagent must never see. */
export const CHILD_DENIED_TOOLS = [
  'create_workflow', 'amend_workflow', 'fill_workflow_hole', 'resume_workflow_run', 'stop_workflow_run',
  'resolve_workflow_question', 'get_workflow_run', 'list_workflow_runs', 'save_workflow', 'eval_workflow_snippet', 'retune_workflow_run',
  // interaction with the user goes through the main agent (escalate)
  'ask_user_question', 'enter_plan_mode', 'exit_plan_mode', 'propose_action', 'present',
  // DSH's own orchestration, delegation, scheduling & system-mutation surfaces:
  // subagents do not spawn unmanaged grandchildren, teams, goals, cron jobs or plugins
  'workflow', 'ralph',
  'subagent', 'subagent_fork', 'subagent_oar', 'send_message', 'wait_agent', 'interrupt_agent', 'list_agents',
  'team_task_create', 'team_task_update',
  'create_goal', 'update_goal',
  'schedule_create', 'schedule_edit',
  'plugin_manager', 'plugin_market',
  'create_worktree',
]

/** Tool names that write the workspace (first one closes an amended run's import cache). */
const MUTATING_TOOLS = new Set([
  'write', 'edit', 'apply_patch', 'str_replace_editor', 'str_replace_based_edit_tool', 'multi_edit',
  'bash', 'pwsh', 'bash_persistent', 'pwsh_persistent',
  'terminal_open', 'terminal_send', 'terminal_signal',
  'office_convert', 'office_recalculate',
  'create_worktree',
])
/** File tools whose targets the change lens follows (bash and terminals cannot be followed by path). */
const FILE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'str_replace_editor', 'str_replace_based_edit_tool', 'apply_patch'])

/** The workspace files a file tool call writes: absolute path plus the workspace-relative display path. */
export function fileToolPaths(name: string, args: unknown, cwd: string): { absolute: string; display: string }[] {
  if (!FILE_TOOLS.has(name) || typeof args !== 'object' || args === null) return []
  const record = args as Record<string, unknown>
  const raw: string[] = []
  if (name === 'apply_patch') {
    for (const value of Object.values(record)) {
      if (typeof value !== 'string' || !value.includes('*** ')) continue
      for (const match of value.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gmu)) raw.push((match[1] ?? match[2] ?? '').trim())
    }
  } else {
    for (const key of ['file_path', 'filePath', 'path', 'target_file', 'file']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) { raw.push(value); break }
    }
  }
  const out: { absolute: string; display: string }[] = []
  for (const path of new Set(raw.filter(Boolean))) {
    const absolute = isAbsolute(path) ? path : resolvePath(cwd, path)
    const rel = relative(cwd, absolute)
    // only workspace files: the lens reads the file before the call's own permission check runs
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
    out.push({ absolute, display: rel.split(sep).join('/') })
  }
  return out
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Web search tools charged against a persona's `budget.webSearch` (per ask). */
const WEB_SEARCH_TOOLS = new Set(['web_search', 'WebSearch'])

function webSearchBudgetExhaustedMessage(limit: number): string {
  return `Search budget exhausted: at most ${limit} web searches per task. Do not search again in this task. `
    + 'Finish from the information you already have, and state in your result that your search was cut short by the search budget.'
}

/** Tools that only read the workspace (they still count as world-touching for cache purity). */
const PROTOCOL_TOOLS = new Set(['submit_result', 'escalate'])
/** Inherited tools allowed for an `access: "read-only"` persona (scope-local `submit_result`/`escalate` stay visible automatically). */
export const READ_ONLY_TOOLS = [
  'read', 'read_image', 'glob', 'grep', 'lsp',
  'web_search', 'web_fetch', 'skill', 'todo_write',
  'job_output', 'job_list', 'list_subagent_models',
  'terminal_read', 'terminal_list', 'user_terminal_read', 'user_terminal_list',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'list_saved_workflows',
]

export interface ArtifactPort {
  publish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord>
}

export interface DshDriverDeps {
  /** Plugin context that owns the child agents. */
  ctx: Context
  /** The process-wide governor reports this run's requests (`noteModelRequest`); else `agent/request` does. */
  governed?: boolean
  /**
   * How a typed `submit_result` declares its schema: `exact` (default, ZCode parity) sends the
   * synthesized JSON Schema as is — the provider sees and can enforce the precise shape;
   * `relaxed` folds it into DSH's enforced subset (for an endpoint that rejects richer schemas).
   */
  resultSchema?: 'exact' | 'relaxed'
  /** Per-subagent change lens: the content of each file a subagent changes, before and after. */
  fileChanges?: {
    before(sessionId: string, actor: string | undefined, path: string, content: string | null): void
    after(sessionId: string, path: string, content: string | null): void
  }
  runId: string
  runName?: string
  /** The live main agent that launched (or resumed) the run, when it is resident. */
  parent?: Agent
  parentSessionId?: string
  cwd: string
  journal: JournalStorePort
  emit: (event: RunEvent) => void
  actorSubmitProfiles?: ReadonlyMap<string, ActorSubmitProfile>
  /** Model names the script declared → `provider/model`. */
  modelBindings?: Record<string, string>
  /** The run's subagent model `provider/model`, when set by the launch. */
  subagentModel?: string
  escalations: EscalationRegistry
  executeWorldRead: (op: WorldReadOp, args: unknown[]) => Promise<unknown>
  artifacts?: ArtifactPort
  /** Extra per-persona access rules keyed by subagent name (DSH enhancement). */
  accessOf?: (persona: PersonaSpec) => 'full' | 'read-only'
  /** Seed source reader for amend carry: events of a persisted session. */
  readSessionEvents?: (sessionId: string) => Promise<readonly SessionEvent[]>
  buildForkSeed?: (events: readonly SessionEvent[], boundary: number) => SessionEvent[]
  logger?: { warn(message: string, ...args: unknown[]): void; info?(message: string, ...args: unknown[]): void }
  /** Test hook for redrive timers. */
  schedule?: (callback: () => void, delayMs: number) => () => void
}

type SubmitAnswer = { accept: true } | { accept: false; violations: Violation[] }

interface ActorState {
  ref: SessionRef
  sessionId: string
  actor: ActorRef
  actorName?: string
  persona: PersonaSpec
  handle: AgentHandle
  agent: Agent
  submitProfile: ActorSubmitProfile
  currentInstance?: InstanceRef
  currentTyped: boolean
  accepted: boolean
  cancelled: boolean
  pendingSubmit?: Deferred<SubmitAnswer>
  pendingEscalations: Map<string, Deferred<string>>
  escalationsUsed: number
  /** Web searches charged to the current ask, and this subagent's per-ask limit (ZCode search budget). */
  webSearchesUsed: number
  webSearchLimit: number
  turnGeneration: number
  /** Per-ask counters (reset at startAsk). */
  turnsInAsk: number
  toolCalls: number
  worldToolCalls: number
  mutatingReported: boolean
  /** The current ask has reported `executing` (a model request of it was sent). */
  executing?: boolean
  lastTool?: { name: string; target?: string }
  transientAttempts: number
  unknownFailures: number
  cancelRedrive?: () => void
  turn?: Promise<void>
  /** Session seq when the current turn started. */
  turnStartSeq: number
}

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

class DshWorkflowDriver implements WorkflowDriver {
  readonly journal: JournalStorePort
  readonly emit: (event: RunEvent) => void
  private readonly sessions = new Map<string, ActorState>()
  private readonly instanceToSession = new Map<string, ActorState>()
  private readonly qidToSession = new Map<string, ActorState>()
  private escalationSeq = 0
  private disposed = false
  private readonly pendingCreations = new Set<Promise<unknown>>()

  constructor(private readonly deps: DshDriverDeps, private readonly sink: WorkflowReportSink) {
    this.journal = deps.journal
    this.emit = deps.emit
  }

  // ————————————————————————————— sessions —————————————————————————————

  createActorSession(actor: ActorRef, persona: PersonaSpec, seed?: ActorSessionSeed): Promise<SessionRef> {
    if (this.disposed) return Promise.reject(new Error('Workflow driver is closed'))
    const creation = this.createOwnedActorSession(actor, persona, seed)
    this.pendingCreations.add(creation)
    void creation.finally(() => this.pendingCreations.delete(creation)).catch(() => undefined)
    return creation
  }

  private async createOwnedActorSession(actor: ActorRef, persona: PersonaSpec, seed?: ActorSessionSeed): Promise<SessionRef> {
    const { ctx, runId } = this.deps
    const sessionId = mintActorSessionId(runId, actor)
    const journaled = this.journal.getActor(runId, actor.siteId, actor.ordinal)?.sessionId
    if (journaled !== undefined && journaled !== sessionId) {
      throw new WorkflowError('DriverError',
        `Subagent session identity mismatch for ${refToString(actor)}: the journaled session id and the minted one differ.`,
        { mismatch: { expected: journaled, got: sessionId } })
    }
    const actorName = effectiveActorName(persona)
    const submitProfile = this.deps.actorSubmitProfiles?.get(actor.siteId) ?? GENERIC_SUBMIT_PROFILE
    // A continued transcript keeps its model (ZCode's pin: switching models under a seeded
    // conversation is the identity change the pin exists to prevent); a crash resume keeps the
    // model the journal recorded for this actor.
    const pinned = seed?.resolvedModel ?? (journaled === undefined ? undefined : this.journal.getActor(runId, actor.siteId, actor.ordinal)?.resolvedModel)
    const agentOptions = this.pinnedAgentOptions(pinned) ?? this.resolveAgentOptions(persona)
    const access = this.deps.accessOf?.(persona) ?? 'full'

    // Late-bound state: the scoped tools close over the session id and look the state up lazily.
    const setup = (childCtx: Context, child: Agent): void => {
      this.composeChild(childCtx, child, { sessionId, actor, actorName, persona, submitProfile, access, fresh: journaled === undefined })
    }

    let handle: AgentHandle
    const existing = ctx.agents.get(sessionId as SessionId)
    if (existing !== undefined) {
      throw new WorkflowError('DriverError', `Subagent session ${sessionId} is already live in this process.`)
    }
    if (journaled !== undefined && await this.sessionExists(sessionId)) {
      // Crash / stop resume: re-attach the persisted transcript under the same id.
      handle = await ctx.agents.resume({ resumeSessionId: sessionId as SessionId, agentOptions, setup })
    } else {
      const seedEvents = seed === undefined ? undefined : await this.seedEventsFor(seed)
      const parent = this.deps.parent
      const parentHeader = parent?.session.header
      const meta = {
        cwd: this.deps.cwd,
        ...this.deps.parentSessionId === undefined ? {} : { parentSession: this.deps.parentSessionId as SessionId },
        origin: 'subagent' as const,
        delegationDepth: (parentHeader?.delegationDepth ?? 0) + 1,
        ...seedEvents === undefined ? {} : { isSeeded: true },
      }
      handle = await ctx.agents.create({
        sessionId: sessionId as SessionId,
        meta,
        ...seedEvents === undefined ? {} : { seed: seedEvents.events, inheritedEventCount: seedEvents.inherited as never },
        agentOptions,
        setup,
      })
    }

    const state: ActorState = {
      ref: { id: sessionId },
      sessionId,
      actor,
      ...actorName === undefined ? {} : { actorName },
      persona,
      handle,
      agent: handle.agent,
      submitProfile,
      currentTyped: false,
      accepted: false,
      cancelled: false,
      pendingEscalations: new Map(),
      escalationsUsed: 0,
      webSearchesUsed: 0,
      webSearchLimit: persona.budget?.webSearch ?? DEFAULT_WEB_SEARCH_BUDGET_PER_ASK,
      turnGeneration: 0,
      turnsInAsk: 0,
      toolCalls: 0,
      worldToolCalls: 0,
      mutatingReported: false,
      transientAttempts: 0,
      unknownFailures: 0,
      turnStartSeq: handle.agent.session.seq,
    }
    if (this.disposed) {
      await handle.dispose().catch(() => undefined)
      throw new Error('Workflow driver closed during subagent creation')
    }
    this.sessions.set(sessionId, state)
    // The driver owns the session id and the resolved model (journal; engine carries them forward).
    const row = this.journal.getActor(runId, actor.siteId, actor.ordinal)
    const effortSuffix = agentOptions.reasoningEffort === undefined ? '' : `$${String(agentOptions.reasoningEffort)}`
    this.journal.putActor({
      ...row ?? { runId, siteId: actor.siteId, ordinal: actor.ordinal },
      sessionId,
      ...agentOptions.provider !== undefined && agentOptions.model !== undefined
        ? { resolvedModel: `${agentOptions.provider}/${agentOptions.model}${effortSuffix}` }
        : {},
    })
    return state.ref
  }

  private async sessionExists(sessionId: string): Promise<boolean> {
    const persistence = this.deps.ctx.get('sessionPersistence') as { stat?: (id: string) => Promise<unknown> } | undefined
    if (persistence?.stat === undefined) return false
    try {
      return (await persistence.stat(sessionId)) !== undefined
    } catch {
      return false
    }
  }

  private async seedEventsFor(seed: ActorSessionSeed): Promise<{ events: SessionEvent[]; inherited: number } | undefined> {
    if (this.deps.readSessionEvents === undefined || this.deps.buildForkSeed === undefined) return undefined
    const events = await this.deps.readSessionEvents(seed.sourceSessionId)
    if (events.length === 0) return undefined
    // `messageCount` is the source session's event offset at the end of the copied exchange.
    const boundary = Math.min(seed.messageCount, events.length) - 1
    if (boundary < 0) return undefined
    const forked = this.deps.buildForkSeed(events, boundary)
    return { events: forked, inherited: boundary + 1 }
  }

  /** Parse `provider/model[$effort]` into DSH `AgentOptions` (undefined when absent or malformed). */
  private parseModelSpec(value: string | undefined): AgentOptions | undefined {
    return parseModelSpec(value)
  }

  /** `provider/model[$effort]` of a pinned actor as agent options (undefined when absent or malformed). */
  private pinnedAgentOptions(pinned: string | undefined): AgentOptions | undefined {
    return this.parseModelSpec(pinned)
  }

  /** Provider/model for a subagent: persona model binding > run subagent model > parent route. */
  private resolveAgentOptions(persona: PersonaSpec): AgentOptions {
    const parentRoute = this.parentRoute()
    const qualify = (spec: string | undefined): string | undefined => {
      if (spec === undefined) return undefined
      const trimmed = spec.trim()
      if (trimmed.length === 0) return undefined
      return trimmed.includes('/') || parentRoute === undefined ? trimmed : `${parentRoute.provider}/${trimmed}`
    }
    const bound = persona.model === undefined ? undefined : qualify(this.deps.modelBindings?.[persona.model])
    const fromPersona = this.parseModelSpec(bound)
    if (persona.model !== undefined && fromPersona === undefined) {
      throw new WorkflowError('DriverError', `Model "${persona.model}" named by subagent ${persona.name ?? '(anonymous)'} is not bound for this run.`)
    }
    const chosen = fromPersona ?? this.parseModelSpec(qualify(this.deps.subagentModel)) ?? parentRoute
    return { ...chosen ?? {} }
  }

  private parentRoute(): { provider: string; model: string } | undefined {
    const parent = this.deps.parent
    if (parent === undefined) return undefined
    const config = parent.session.requestHeader?.()?.config
    if (config !== undefined) return { provider: config.provider, model: config.model }
    const options = parent.options
    if (options.provider !== undefined && options.model !== undefined) return { provider: options.provider, model: options.model }
    try {
      const current = parent.model.current()
      return current === undefined ? undefined : { provider: current.provider, model: current.model }
    } catch {
      return undefined
    }
  }

  /** Scoped composition of one subagent: prompt, protocol tools, tool policy, observation. */
  private composeChild(childCtx: Context, child: Agent, input: {
    sessionId: string
    actor: ActorRef
    actorName?: string
    persona: PersonaSpec
    submitProfile: ActorSubmitProfile
    access: 'full' | 'read-only'
    fresh: boolean
  }): void {
    const { sessionId, actor, persona, submitProfile } = input
    // Inherit the parent's composition (presets, tools) when there is one.
    const parent = this.deps.parent
    if (parent !== undefined) {
      const presets = childCtx.get('agentPresets') as { composeFrom?: (ctx: Context, from: Context) => void } | undefined
      presets?.composeFrom?.(childCtx, parent.ctx)
    }
    if (input.fresh) {
      // DSH's durable subagent identity: without exactly one `subagent/descriptor` in the child's
      // own log, the Web client refuses to open its transcript ("subagent descriptor is corrupt").
      // One-shot: a workflow subagent is resumed by the run (journal replay), not by the user.
      try {
        const append = child.session.append.bind(child.session) as (type: string, data: unknown) => void
        const label = input.actorName ?? `${actor.siteId}#${actor.ordinal}`
        append('subagent/descriptor', { version: hostModules()?.subagentDescriptorVersion ?? 3, mode: 'one-shot', provider: 'dynamic-workflow', label: this.deps.runName === undefined ? label : `${label} · ${this.deps.runName}`.slice(0, 200) })
      } catch (error) {
        this.deps.logger?.warn('dynamic-workflow: could not record the subagent descriptor for %s: %s', sessionId, String(error))
      }
    }
    if (input.fresh && parent !== undefined) {
      // Delegated policy: fixed at delegation, approvals never prompt from inside a run (DSH
      // `approval/policy: 'never'` fails closed — any action requiring approval is auto-rejected).
      try {
        const preset = (parent.ctx.get('permissionPresets') as { current?: (s: unknown) => string } | undefined)?.current?.(parent.session)
        const sandboxPolicy = parent.ctx.get('sandboxPolicy') as { overrideOf?: (s: unknown) => string | undefined } | undefined
        const sandboxMode = input.access === 'read-only' && sandboxPolicy !== undefined ? 'read-only' : sandboxPolicy?.overrideOf?.(parent.session)
        const append = child.session.append.bind(child.session) as (type: string, data: unknown) => void
        if (sandboxMode !== undefined) append('sandbox/mode', { mode: sandboxMode, source: 'delegation' })
        if (parent.ctx.get('approval') !== undefined) append('approval/policy', { policy: 'never', source: 'delegation' })
        if (input.access !== 'read-only' && (preset === 'auto' || preset === 'danger-full-access')) append('permission/preset', { preset })
      } catch (error) {
        this.deps.logger?.warn('dynamic-workflow: could not seed delegated policy for %s: %s', sessionId, String(error))
      }
    }

    const systemPrompt = childCtx.systemPrompt as {
      section(entry: { name: string; order: number; text: string; interpolate?: boolean }): () => void
      getSectionOrder?(name: string): number
    }
    const order = (name: string, fallback: number): number => {
      try { return systemPrompt.getSectionOrder?.(name) ?? fallback } catch { return fallback }
    }
    systemPrompt.section({
      name: 'dynamic-workflow:subagent',
      order: order('DEPLOYMENT_PERSONA_PREFIX', 50) + 1,
      interpolate: false,
      text: subagentPreamble({
        ...this.deps.runName === undefined ? {} : { runName: this.deps.runName },
        ...input.actorName === undefined ? {} : { actorName: input.actorName },
        ...persona.system === undefined || persona.system.length === 0 ? {} : { persona: persona.system },
      }),
    })

    const tools = childCtx.tools as unknown as {
      register(def: unknown): () => void
      restrict(rule: { allow?: string[]; deny?: string[] }): () => void
      definitions(scope?: unknown): readonly { name: string }[]
    }
    // Snapshot inherited (global + preset) tool names BEFORE registering scope-local protocol
    // tools: DSH's `tools.restrict()` only accepts inherited names (`restrictableNames`) and throws
    // if given scope-local names (`submit_result` / `escalate`), while keeping scope-local tools
    // automatically exempt from restrictions.
    const inheritedKnown = new Set(tools.definitions(child).map(definition => definition.name))
    if (submitProfile.kind !== 'untyped') {
      tools.register(this.submitResultTool(sessionId, submitProfile))
    }
    tools.register(this.escalateTool(sessionId, actor, input.actorName))
    if (input.access === 'read-only') {
      tools.restrict({ allow: READ_ONLY_TOOLS.filter(name => inheritedKnown.has(name)) })
    } else {
      const deny = CHILD_DENIED_TOOLS.filter(name => inheritedKnown.has(name))
      if (deny.length > 0) tools.restrict({ deny })
    }

    // Observe every call before it runs: counters, last tool, and the first workspace write.
    if (this.deps.governed !== true) {
      // No governor: the request is sent as soon as the agent prepares it.
      childCtx.on('agent/request' as never, (async (_payload: unknown, next: () => Promise<unknown>) => {
        this.noteModelRequest(sessionId, 'executing')
        return next()
      }) as never)
    }
    childCtx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
      const state = this.sessions.get(sessionId)
      // Search budget per ask (ZCode): a subagent that degenerates in a long turn cannot search
      // without end. Nudge and repair rounds share the ask's budget; no ask in flight, no charge.
      if (state !== undefined && WEB_SEARCH_TOOLS.has(exec.name) && state.currentInstance !== undefined) {
        if (state.webSearchesUsed >= state.webSearchLimit) {
          return Promise.resolve({ kind: 'deny', reason: webSearchBudgetExhaustedMessage(state.webSearchLimit) } as PreToolDecision)
        }
        state.webSearchesUsed += 1
      }
      if (state !== undefined && !PROTOCOL_TOOLS.has(exec.name)) {
        state.toolCalls += 1
        state.worldToolCalls += 1
        const target = toolTarget(exec.name, exec.arguments)
        state.lastTool = { name: exec.name.slice(0, 64), ...target === undefined ? {} : { target } }
        const instance = this.live(state)
        if (instance !== undefined && !state.mutatingReported && MUTATING_TOOLS.has(exec.name)) {
          state.mutatingReported = true
          this.sink.askMutating(instance)
        }
      }
      const changed = this.deps.fileChanges === undefined ? [] : fileToolPaths(exec.name, exec.arguments, this.deps.cwd)
      if (changed.length === 0) return next()
      const label = input.actorName ?? `${actor.siteId}#${actor.ordinal}`
      return Promise.all(changed.map(async path => this.deps.fileChanges!.before(sessionId, label, path.display, await readText(path.absolute))))
        .catch(() => undefined)
        .then(() => next())
    })
    if (this.deps.fileChanges !== undefined) {
      childCtx.on('tools/post-execute' as never, (async (exec: ToolExecution, result: { isError?: boolean }, next: () => Promise<PostToolDecision>) => {
        try {
          // a failed or refused call changed nothing of its own; recording the file now would
          // attribute whatever another subagent wrote meanwhile to this one
          if (result.isError !== true) {
            for (const path of fileToolPaths(exec.name, exec.arguments, this.deps.cwd)) this.deps.fileChanges!.after(sessionId, path.display, await readText(path.absolute))
          }
        } catch {
          // the lens is best effort; it never fails a tool call
        }
        return next()
      }) as never)
    }
  }

  private submitResultTool(sessionId: string, profile: ActorSubmitProfile): unknown {
    const typed = profile.kind !== 'mono'
      ? undefined
      : this.deps.resultSchema === 'relaxed'
        ? (() => { const relaxed = toDshSchema(profile.schema); return relaxed === undefined ? undefined : { schema: relaxed, defs: undefined } })()
        : exactResultSchema(profile.schema)
    const typedSchema = typed?.schema
    const resultSchema = typedSchema === undefined
      ? { description: 'The structured result for this task, matching the JSON schema given in the task instructions.' }
      : { ...typedSchema, description: 'The structured result for this task.' }
    return {
      name: 'submit_result',
      description: typedSchema === undefined
        ? 'Submit the structured result for the current task. The required JSON shape is described in the task instructions.'
        : 'Submit the structured result for the current task. The `result` argument must match this tool\'s schema.',
      parameters: { type: 'object', properties: { result: resultSchema }, required: ['result'], additionalProperties: false, ...typed?.defs === undefined ? {} : { $defs: typed.defs } },
      output: {
        schema: { type: 'object', properties: { status: { type: 'string', const: 'accepted' } }, required: ['status'], additionalProperties: false },
        render: () => [{ type: 'text', text: 'Result accepted. Your task is complete; end your turn.' }],
      },
      isConcurrencySafe: () => false,
      execute: async (args: unknown, exec: { signal: AbortSignal; concludeTurn(): void }) => {
        const answer = await this.submit(sessionId, args, exec.signal)
        if (!answer.accept) {
          const lines = answer.violations.map(v => `${v.path}: expected ${v.expected}, got ${v.got}`)
          throw new Error(`submit_result rejected: the result does not match the required schema.\n${lines.join('\n')}\nFix the result and call submit_result again.`)
        }
        exec.concludeTurn()
        return { status: 'accepted' }
      },
    }
  }

  private escalateTool(sessionId: string, actor: ActorRef, actorName: string | undefined): unknown {
    return {
      name: 'escalate',
      description: [
        'Escalates a question that is BLOCKING you to the main agent that created this workflow, and waits here for the answer.',
        '',
        'This is a LAST RESORT, for when you are genuinely stuck on something outside your reach:',
        '- a gate that is broken or impossible to pass;',
        '- instructions that contradict each other, so no output can satisfy both;',
        '- a fact you cannot obtain that only whoever started this run knows.',
        '',
        'Do NOT use it for curiosity, progress reports, asking permission, or confirming a conclusion you could verify yourself.',
        'Ask ONE focused question that can be answered in a sentence, and put your evidence in `context`.',
        `The call BLOCKS until the main agent answers. You get at most ${MAX_ESCALATIONS_PER_ASK} escalations per task.`,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The single focused question that unblocks you.' },
          context: { type: 'string', description: 'What you already tried and where exactly you are stuck.' },
        },
        required: ['question'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { status: { type: 'string' }, message: { type: 'string' } }, required: ['status', 'message'] },
        render: (_args: unknown, value: { message: string }) => [{ type: 'text', text: value.message }],
      },
      isConcurrencySafe: () => true,
      execute: async (args: unknown, exec: { signal: AbortSignal }) => {
        const input = (args ?? {}) as { question?: unknown; context?: unknown }
        const question = typeof input.question === 'string' ? input.question.trim() : ''
        if (question.length === 0) throw new Error('escalate requires a non-empty question')
        const context = typeof input.context === 'string' ? normalizeEscalationContext(input.context) : undefined
        return await this.escalate(sessionId, actor, actorName, question, context, exec.signal)
      },
    }
  }

  // ————————————————————————————— asks —————————————————————————————

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    const state = this.sessions.get(session.id)
    if (state === undefined) {
      this.sink.askFailed(instance, new WorkflowError('DriverError', `Unknown subagent session: ${session.id}`))
      return
    }
    this.withdrawEscalations(state)
    state.currentInstance = instance
    state.currentTyped = message.typed
    state.accepted = false
    state.cancelled = false
    state.pendingSubmit = undefined
    state.escalationsUsed = 0
    state.webSearchesUsed = 0
    state.turnsInAsk = 0
    state.toolCalls = 0
    state.worldToolCalls = 0
    state.mutatingReported = false
    delete state.lastTool
    state.transientAttempts = 0
    state.unknownFailures = 0
    state.executing = false
    state.cancelRedrive?.()
    state.cancelRedrive = undefined
    this.instanceToSession.set(refToString(instance), state)

    if (message.typed && state.submitProfile.kind === 'untyped') {
      this.sink.askFailed(instance, new WorkflowError('DriverError',
        `Subagent ${subagentLabel(state.actor, state.actorName)} received a typed task but has no submit_result tool (the ask-to-subagent analysis missed this ask).`))
      return
    }
    // A tool declaration that carries the whole schema needs no restatement (ZCode: the mono
    // subagent's typed ask ends in one line); exact mode always does, a relaxed declaration only
    // when nothing was lost — otherwise the task text restates the exact schema.
    const profile = state.submitProfile
    const declared = message.typed && profile.kind === 'mono'
      && (this.deps.resultSchema !== 'relaxed' ? exactResultSchema(profile.schema) !== undefined : relaxToDshSchema(profile.schema)?.lossless === true)
    const typedTail = !message.typed ? '' : declared ? TYPED_TOOL_EPILOGUE : schemaEpilogue(message.schema)
    const input = `${message.instructions}${qualityEpilogue(message.typed ? message.schema : undefined)}${typedTail}`
    this.runTurn(state, instance, input)
  }

  /**
   * A model request of this subagent is waiting for a slot of the process-wide governor, or was
   * just admitted (sent). Drives the ask's `waiting` / `executing` phases — what lights a pill.
   */
  noteModelRequest(sessionId: string, phase: 'waiting' | 'executing'): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    const instance = this.live(state)
    if (instance === undefined) return
    if (phase === 'waiting') {
      state.executing = false
      this.sink.askWaiting(instance, { cause: 'slot' })
      return
    }
    if (state.executing === true) return
    state.executing = true
    this.sink.askExecuting(instance)
  }

  /** The process-wide governor moved the cap of this run's provider key: record it on the run. */
  noteConcurrency(change: ConcurrencyChange): void {
    if (this.disposed) return
    this.sink.concurrencyChanged(change)
  }

  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void {
    const state = this.instanceToSession.get(refToString(instance))
    if (state === undefined) return
    switch (verdict.kind) {
      case 'accept': {
        state.accepted = true
        const deferred = state.pendingSubmit
        state.pendingSubmit = undefined
        deferred?.resolve({ accept: true })
        return
      }
      case 'reject': {
        const deferred = state.pendingSubmit
        state.pendingSubmit = undefined
        deferred?.resolve({ accept: false, violations: verdict.violations })
        return
      }
      case 'nudge': {
        this.runTurn(state, instance, NUDGE_PROMPT)
      }
    }
  }

  cancelAsk(instance: InstanceRef): void {
    const key = refToString(instance)
    const state = this.instanceToSession.get(key)
    this.instanceToSession.delete(key)
    if (state === undefined) return
    state.cancelled = true
    const deferred = state.pendingSubmit
    state.pendingSubmit = undefined
    deferred?.reject(new WorkflowError('Cancelled', 'The ask was cancelled by the engine.'))
    this.withdrawEscalations(state)
    state.cancelRedrive?.()
    state.cancelRedrive = undefined
    if (state.agent.status !== 'idle') {
      try {
        state.agent.cancel({ kind: 'parent' })
      } catch (error) {
        this.deps.logger?.warn('dynamic-workflow: cancel of %s failed: %s', state.sessionId, String(error))
      }
    }
  }

  async executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    if (this.disposed) throw new Error('Workflow driver is closed')
    return await this.deps.executeWorldRead(op, args)
  }

  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    if (this.disposed) throw new Error('Workflow driver is closed')
    if (this.deps.artifacts === undefined) {
      throw new WorkflowError('ArtifactStoreUnavailable', 'No artifact store is mounted in this host.')
    }
    return await this.deps.artifacts.publish(request)
  }

  private released: Promise<ReadonlySet<string>> | undefined

  whenReleased(): Promise<ReadonlySet<string>> {
    return this.released ?? Promise.resolve(new Set<string>())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const states = [...this.sessions.values()]
    for (const state of states) {
      state.cancelRedrive?.()
      this.withdrawEscalations(state)
    }
    this.sessions.clear()
    this.instanceToSession.clear()
    this.qidToSession.clear()
    // Release every child after its in-flight turn (if any) lands; failures only warn. A session
    // whose turn settled and whose agent was released is quiet: its transcript count is final.
    this.released = Promise.allSettled([...this.pendingCreations]).then(async () => {
      const quiet = new Set<string>()
      await Promise.allSettled(states.map(async state => {
        try {
          if (state.agent.status !== 'idle') {
            state.agent.cancel({ kind: 'parent' })
            await state.agent.whenIdle()
          }
          await state.handle.dispose()
          quiet.add(state.sessionId)
        } catch (error) {
          this.deps.logger?.warn('dynamic-workflow: releasing subagent %s failed: %s', state.sessionId, String(error))
        }
      }))
      return quiet
    })
  }

  /** The run service answers a parked escalation through the registry, which calls this back. */
  respondToEscalation(qid: string, answer: string): boolean {
    const state = this.qidToSession.get(qid)
    if (state === undefined) return false
    const deferred = state.pendingEscalations.get(qid)
    if (deferred === undefined) return false
    state.pendingEscalations.delete(qid)
    this.qidToSession.delete(qid)
    try {
      this.record({ type: 'escalation-resolved', qid, answer })
    } catch (error) {
      // the subagent must not hang on a journal hiccup: deliver the answer regardless
      this.deps.logger?.warn('dynamic-workflow: could not journal the answer to %s: %s', qid, String(error))
    } finally {
      deferred.resolve(answer)
    }
    return true
  }

  // ————————————————————————————— internals —————————————————————————————

  private live(state: ActorState): InstanceRef | undefined {
    return state.currentInstance === undefined || state.accepted || state.cancelled ? undefined : state.currentInstance
  }

  private runTurn(state: ActorState, instance: InstanceRef, text: string): void {
    state.turnGeneration += 1
    const generation = state.turnGeneration
    state.turnStartSeq = state.agent.session.seq
    const message = userMessage(text, { kind: 'dynamic-workflow', form: 'relay' }, `dwf:${this.deps.runId}:${refToString(instance)}:${generation}:${randomUUID()}`)
    try {
      state.agent.followup(message)
    } catch (error) {
      this.sink.askFailed(instance, toWorkflowError(error))
      return
    }
    const startSeq = state.turnStartSeq
    state.turn = state.agent.whenIdle().then(
      () => this.onTurnSettled(state, instance, generation, startSeq),
      (error: unknown) => this.onTurnRejected(state, instance, error),
    ).catch((error: unknown) => {
      this.deps.logger?.warn('dynamic-workflow: settling the turn of %s failed: %s', state.sessionId, String(error))
    })
  }

  private onTurnSettled(state: ActorState, instance: InstanceRef, generation: number, startSeq: number): void {
    if (this.disposed) return
    // A later generation (nudge / redrive) owns the ask now.
    if (state.turnGeneration !== generation) return
    const events = snapshotEventsSince(state.agent, startSeq)
    const facts = summarizeTurn(events)
    state.turnsInAsk += 1
    // Observations in order: progress, then usage.
    this.sink.askProgress(instance, {
      turn: state.turnsInAsk,
      toolCalls: state.toolCalls,
      ...state.lastTool === undefined ? {} : { lastTool: state.lastTool },
    })
    this.sink.askStats(instance, {
      tokens: facts.tokens,
      toolCalls: state.toolCalls,
      turns: facts.requests || 1,
      worldToolCalls: state.worldToolCalls,
    })
    if (state.cancelled || facts.end?.kind === 'aborted') return

    if (facts.end?.kind === 'error' && !state.accepted) {
      this.handleModelFailure(state, instance, facts.end.error ?? {})
      return
    }
    state.transientAttempts = 0
    state.unknownFailures = 0
    if (state.accepted) {
      this.journalBoundary(state, instance)
      this.instanceToSession.delete(refToString(instance))
      return
    }
    const before = state.turnGeneration
    this.sink.askTurnEnded(instance, facts.finalText)
    // A nudge starts a new generation inside that call: the exchange is not over yet.
    if (state.turnGeneration === before) {
      this.journalBoundary(state, instance)
      this.instanceToSession.delete(refToString(instance))
    }
  }

  private onTurnRejected(state: ActorState, instance: InstanceRef, error: unknown): void {
    this.withdrawEscalations(state)
    this.instanceToSession.delete(refToString(instance))
    if (state.cancelled || this.disposed) return
    this.sink.askFailed(instance, toWorkflowError(error))
  }

  private handleModelFailure(state: ActorState, instance: InstanceRef, failure: { code?: string; message?: string; status?: number; providerRetryAfterMs?: number }): void {
    const facts = { code: failure.code ?? 'UNKNOWN', message: failure.message ?? 'model request failed', ...failure.status === undefined ? {} : { status: failure.status }, ...failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs } }
    const verdict = classifyChildFailure(facts)
    const route = state.agent.session.requestHeader?.()?.config
    const label = subagentLabel(state.actor, state.actorName)
    if (verdict.kind === 'context_exceeded') {
      this.instanceToSession.delete(refToString(instance))
      this.sink.askFailed(instance, new WorkflowError('ContextLimit',
        `Subagent ${label} exceeded the model's context window even after compaction. Give this ask a smaller input or split the work across subagents.`))
      return
    }
    if (verdict.kind === 'unknown') {
      state.unknownFailures += 1
      if (state.unknownFailures < UNKNOWN_FAILURE_LIMIT) {
        this.redrive(state, instance, facts.providerRetryAfterMs)
        return
      }
    }
    if (verdict.kind === 'transient') {
      this.redrive(state, instance, facts.providerRetryAfterMs)
      return
    }
    const kind = verdict.kind === 'stop' ? verdict.stop : 'other'
    const resetAt = kind === 'quota' ? quotaResetAt(facts) : undefined
    this.sink.stopRun(new WorkflowError('ProviderStop',
      `Subagent ${label} hit a permanent model-side error (${kind} [${facts.code}]): ${facts.message.slice(0, 2000)}`,
      {
        providerStop: {
          kind,
          reason: facts.code,
          ...route === undefined ? {} : { providerId: route.provider, modelId: route.model },
          providerCode: facts.code,
          subagent: refToString(state.actor),
          ...state.actorName === undefined ? {} : { subagentName: state.actorName },
          rawMessage: facts.message.slice(0, 2000),
          ...resetAt === undefined ? {} : { resetAt },
        },
      } as never))
  }

  private redrive(state: ActorState, instance: InstanceRef, retryAfterMs: number | undefined): void {
    state.transientAttempts += 1
    const delayMs = retryAfterMs ?? transientBackoffMs(state.transientAttempts)
    this.sink.askWaiting(instance, { cause: 'backoff', attempt: state.transientAttempts, delayMs, ...retryAfterMs === undefined ? {} : { retryAfterMs } })
    const schedule = this.deps.schedule ?? defaultSchedule
    state.cancelRedrive = schedule(() => {
      state.cancelRedrive = undefined
      if (this.disposed || state.cancelled || this.live(state) === undefined) return
      state.executing = false
      this.runTurn(state, instance, TRANSIENT_CONTINUE_PROMPT)
    }, delayMs)
  }

  private async submit(sessionId: string, payload: unknown, signal: AbortSignal): Promise<SubmitAnswer> {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      return { accept: false, violations: [{ path: '$', expected: 'an active task', got: 'a submit_result call outside of a task' }] }
    }
    const instance = this.live(state)
    if (instance === undefined || !state.currentTyped) {
      return {
        accept: false,
        violations: [{ path: '$', expected: state.currentTyped ? 'an active task' : 'a final text answer (this task is untyped)', got: 'submit_result call' }],
      }
    }
    if (state.pendingSubmit !== undefined) {
      return { accept: false, violations: [{ path: '$', expected: 'one submit_result at a time', got: 'a concurrent submit_result call' }] }
    }
    const deferred = defer<SubmitAnswer>()
    state.pendingSubmit = deferred
    const onAbort = (): void => { deferred.reject(new WorkflowError('Cancelled', 'submit_result was aborted.')) }
    signal.addEventListener('abort', onAbort, { once: true })
    const result = (payload as { result?: unknown } | undefined)?.result
    try {
      // The engine validates synchronously and answers through respondToSubmit.
      this.sink.askSubmitAttempted(instance, result)
      return await deferred.promise
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async escalate(
    sessionId: string,
    actor: ActorRef,
    actorName: string | undefined,
    question: string,
    context: string | undefined,
    signal: AbortSignal,
  ): Promise<{ status: 'answered' | 'refused'; message: string; qid?: string; reason?: string }> {
    const state = this.sessions.get(sessionId)
    const instance = state === undefined ? undefined : this.live(state)
    if (state === undefined || instance === undefined) {
      return { status: 'refused', reason: 'no_active_ask', message: 'There is no active task to escalate from. Finish your answer with what you know.' }
    }
    if (state.escalationsUsed >= MAX_ESCALATIONS_PER_ASK) {
      return { status: 'refused', reason: 'budget_exhausted', message: ESCALATION_BUDGET_EXHAUSTED }
    }
    state.escalationsUsed += 1
    const qid = this.mintQid()
    const askedAt = Date.now()
    const deferred = defer<string>()
    state.pendingEscalations.set(qid, deferred)
    this.qidToSession.set(qid, state)
    this.deps.escalations.park({
      qid,
      runId: this.deps.runId,
      actor: refToString(actor),
      ...actorName === undefined ? {} : { actorName },
      question,
      ...context === undefined ? {} : { context },
      askedAt,
    }, answer => { this.respondToEscalation(qid, answer) })
    try {
      this.record({
        type: 'escalation-raised',
        qid,
        actor,
        ...actorName === undefined ? {} : { actorName },
        question,
        ...context === undefined ? {} : { context },
        askedAt,
      })
    } catch (error) {
      this.deps.escalations.withdraw(qid)
      state.pendingEscalations.delete(qid)
      this.qidToSession.delete(qid)
      throw error
    }
    const onAbort = (): void => {
      this.deps.escalations.withdraw(qid)
      state.pendingEscalations.delete(qid)
      this.qidToSession.delete(qid)
      deferred.reject(new WorkflowError('Cancelled', 'The escalation was withdrawn.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const answer = await deferred.promise
      return { status: 'answered', qid, message: answer }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private mintQid(): string {
    this.escalationSeq += 1
    for (const fragment of questionIdFragments(this.deps.runId)) {
      const qid = `dwfq-${fragment}-${this.escalationSeq}`
      if (!this.deps.escalations.isTaken(qid)) return qid
    }
    return `dwfq-${randomUUID()}`
  }

  private withdrawEscalations(state: ActorState): void {
    for (const [qid, deferred] of state.pendingEscalations) {
      this.deps.escalations.withdraw(qid)
      this.qidToSession.delete(qid)
      deferred.reject(new WorkflowError('Cancelled', 'The escalation was withdrawn.'))
    }
    state.pendingEscalations.clear()
  }

  /**
   * Message boundary = the subagent session's event count at the end of this exchange, i.e. just
   * past the exchange's last `turn/end`. Not `seq + 1` at settle time: the settle callback runs
   * after `whenIdle()` resolves, and by then the next ask's input may already be spliced into
   * the inbox. A seed cut there would carry that pending input, and the forked subagent would
   * start a turn on the old ask before the engine dispatched it (submit refused, repair loop).
   */
  private journalBoundary(state: ActorState, instance: InstanceRef): void {
    try {
      const boundary = exchangeEndBoundary(state.agent)
      const row = this.journal.getNode(this.deps.runId, instance.siteId, instance.ordinal)
      if (row === undefined || row.kind !== 'ask') return
      if (state.currentInstance !== undefined && refToString(state.currentInstance) !== refToString(instance)) return
      this.journal.putNode({ ...row, messageBoundary: boundary })
    } catch (error) {
      this.deps.logger?.warn('dynamic-workflow: message boundary write failed for %s: %s', refToString(instance), String(error))
    }
  }

  private record(event: RunEvent): void {
    this.journal.appendEvent(this.deps.runId, event)
    this.emit(event)
  }
}

export type DshWorkflowDriverHandle = WorkflowDriver & {
  /**
   * Resolves once every subagent of a disposed driver has been released, with the ids of the
   * sessions that are now quiet (their last turn landed, nothing writes to them any more). An
   * amend of a live run reads transcript counts only after this (ZCode's quiescence register).
   */
  whenReleased(): Promise<ReadonlySet<string>>
  respondToEscalation(qid: string, answer: string): boolean
  noteModelRequest(sessionId: string, phase: 'waiting' | 'executing'): void
  noteConcurrency(change: ConcurrencyChange): void
}

export function createDshWorkflowDriver(deps: DshDriverDeps, onCreated?: (driver: DshWorkflowDriverHandle) => void): (sink: WorkflowReportSink) => DshWorkflowDriverHandle {
  return (sink) => {
    const driver = new DshWorkflowDriver(deps, sink)
    onCreated?.(driver)
    return driver
  }
}

// ————————————————————————————— session reading —————————————————————————————

/** Event count just past the session's last `turn/end` (the whole log when none is found). */
export function exchangeEndBoundary(agent: Agent): number {
  const session = agent.session as unknown as { seq: number; snapshotEvents(): readonly { type: string; seq: number }[] }
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === 'turn/end') return events[i]!.seq + 1
  }
  return session.seq + 1
}

function snapshotEventsSince(agent: Agent, startSeq: number): readonly SessionEvent[] {
  const session = agent.session as unknown as { snapshotEvents(from?: number): readonly SessionEvent[] }
  try {
    return session.snapshotEvents(startSeq)
  } catch {
    return session.snapshotEvents().filter(event => (event as { seq?: number }).seq === undefined || ((event as { seq: number }).seq >= startSeq))
  }
}

interface TurnFacts {
  finalText: string
  tokens: number
  requests: number
  end?: { kind: string; error?: { code?: string; message?: string; status?: number; providerRetryAfterMs?: number } }
}

/** Parse `provider/model[$effort]` into DSH `AgentOptions` (undefined when absent or malformed). */
export function parseModelSpec(value: string | undefined): AgentOptions | undefined {
  if (value === undefined) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  const dollar = value.indexOf('$', slash + 1)
  const provider = value.slice(0, slash)
  const model = dollar < 0 ? value.slice(slash + 1) : value.slice(slash + 1, dollar)
  const effort = dollar < 0 ? undefined : value.slice(dollar + 1).trim()
  if (model.length === 0) return undefined
  return {
    provider,
    model,
    ...effort !== undefined && effort.length > 0 ? { reasoningEffort: effort as AgentOptions['reasoningEffort'] } : {},
  }
}

/** Final assistant text (last non-empty message, else streamed text), token usage and turn end. */
export function summarizeTurn(events: readonly SessionEvent[]): TurnFacts {
  let lastContent: readonly ContentBlock[] | undefined
  let tokens = 0
  let requests = 0
  let end: TurnFacts['end']
  for (const event of events) {
    const type = (event as { type: string }).type
    const data = (event as { data: unknown }).data as Record<string, unknown>
    if (type === 'assistant/message') {
      requests += 1
      const message = data.message as { content?: ContentBlock[] } | undefined
      if (message?.content !== undefined && message.content.length > 0) lastContent = message.content
      const usage = data.usage as { totalTokens?: number; inputTokens?: number; outputTokens?: number } | undefined
      if (usage !== undefined) tokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    } else if (type === 'turn/end') {
      end = data.reason as TurnFacts['end']
    }
  }
  const finalText = (lastContent ?? [])
    .filter((block): block is ContentBlock & { type: 'text'; text: string } => (block as { type: string }).type === 'text')
    .map(block => block.text)
    .join('')
  return { finalText, tokens, requests, ...end === undefined ? {} : { end } }
}

/**
 * Relax a synthesized ask schema into DSH's enforced tool-schema subset (type / oneOf /
 * properties / required / boolean additionalProperties / items / scalar enum & const +
 * annotations) so the model sees the result's STRUCTURE in the `submit_result` tool itself.
 *
 * The relaxation must never reject a value the original accepts — the engine re-validates every
 * submission against the full schema (repair loop), so the tool schema only guides:
 *   - value constraints (minimum, pattern, minItems, format, …) are dropped and restated in the
 *     node's description;
 *   - `type: [a, b]` becomes `oneOf` of single types (disjoint; `integer` folds into `number`);
 *   - `anyOf` becomes `oneOf` when every branch has a distinct single `type` (disjoint), else an
 *     unconstrained node whose description lists the variants;
 *   - tuples (`prefixItems`), map values (`additionalProperties: {…}`), non-scalar enums and
 *     recursive references (`$ref`) become unconstrained nodes described in text.
 * Returns `undefined` when the root is not an object schema (the generic profile is used).
 */
export function relaxToDshSchema(schema: unknown): { schema: Record<string, unknown>; lossless: boolean } | undefined {
  let lossless = true
  const CONSTRAINTS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties']
  const isScalar = (value: unknown): boolean => value === null || ['string', 'number', 'boolean'].includes(typeof value)
  const brief = (value: unknown): string => {
    const text = JSON.stringify(value)
    return text.length > 400 ? `${text.slice(0, 400)}…` : text
  }
  const describe = (node: Record<string, unknown>, extra: string[]): Record<string, unknown> => {
    if (extra.length === 0) return node
    lossless = false
    const base = typeof node.description === 'string' && node.description !== '' ? `${node.description} ` : ''
    return { ...node, description: `${base}(${extra.join('; ')})` }
  }
  const visit = (raw: unknown): Record<string, unknown> => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const node = raw as Record<string, unknown>
    const notes: string[] = []
    const out: Record<string, unknown> = {}
    for (const key of ['description', 'title']) if (typeof node[key] === 'string') out[key] = node[key]
    if (node.default !== undefined) out.default = node.default
    for (const key of CONSTRAINTS) if (node[key] !== undefined) notes.push(`${key} ${brief(node[key])}`)
    if (typeof node.$ref === 'string') return describe(out, [`recursive type ${node.$ref}`, ...notes])
    if (node.const !== undefined) {
      if (isScalar(node.const)) out.const = node.const
      else notes.push(`must equal ${brief(node.const)}`)
    }
    if (Array.isArray(node.enum)) {
      if (node.enum.every(isScalar)) out.enum = node.enum
      else notes.push(`one of ${brief(node.enum)}`)
    }
    if (Array.isArray(node.anyOf)) {
      const branches = node.anyOf.map(visit)
      const types = branches.map(branch => branch.type)
      const disjoint = types.every(type => typeof type === 'string') && new Set(types).size === types.length && !(types.includes('number') && types.includes('integer'))
      if (disjoint && branches.length >= 2) return describe({ ...out, oneOf: branches }, notes)
      if (branches.length === 1) return describe({ ...branches[0], ...out }, notes)
      return describe(out, [`one of: ${node.anyOf.map(brief).join(' | ')}`, ...notes])
    }
    const objectPart = (): Record<string, unknown> => {
      const part: Record<string, unknown> = {}
      if (node.properties !== undefined && typeof node.properties === 'object') {
        part.properties = Object.fromEntries(Object.entries(node.properties as Record<string, unknown>).map(([name, child]) => [name, visit(child)]))
      }
      if (Array.isArray(node.required) && part.properties !== undefined) {
        part.required = (node.required as string[]).filter(name => name in (part.properties as object))
      }
      if (typeof node.additionalProperties === 'boolean') part.additionalProperties = node.additionalProperties
      else if (node.additionalProperties !== undefined) notes.push(`values: ${brief(node.additionalProperties)}`)
      return part
    }
    const arrayPart = (): Record<string, unknown> => {
      if (Array.isArray(node.prefixItems)) {
        notes.push(`tuple: ${brief(node.prefixItems)}`)
        return {}
      }
      return node.items === undefined ? {} : { items: visit(node.items) }
    }
    const partFor = (type: string): Record<string, unknown> => type === 'object' ? objectPart() : type === 'array' ? arrayPart() : {}
    if (Array.isArray(node.type)) {
      const types = [...new Set(node.type as string[])].filter(type => !(type === 'integer' && (node.type as string[]).includes('number')))
      if (types.length === 1) return describe({ ...out, type: types[0], ...partFor(types[0]!) }, notes)
      const branches = types.map(type => ({ type, ...partFor(type) }))
      // enum / const stay on the wrapper only when DSH accepts them as oneOf siblings: drop instead (relaxation)
      delete out.enum
      delete out.const
      if (node.enum !== undefined || node.const !== undefined) notes.push(`allowed values ${brief(node.enum ?? node.const)}`)
      return describe({ ...out, oneOf: branches }, notes)
    }
    if (typeof node.type === 'string') return describe({ ...out, type: node.type, ...partFor(node.type) }, notes)
    // no type: keep object/array structure only when it is unambiguous
    if (node.properties !== undefined) return describe({ ...out, type: 'object', ...objectPart() }, notes)
    // DSH requires a type next to enum / const: infer it from the literal values (literal unions)
    const literals = out.enum !== undefined ? out.enum as unknown[] : out.const !== undefined ? [out.const] : undefined
    if (literals !== undefined) {
      const typeOf = (value: unknown): string => value === null ? 'null' : typeof value === 'number' ? 'number' : typeof value
      const groups = new Map<string, unknown[]>()
      for (const value of literals) groups.set(typeOf(value), [...groups.get(typeOf(value)) ?? [], value])
      if (groups.size === 1) return describe({ ...out, type: [...groups.keys()][0] }, notes)
      const { enum: _enum, const: _const, ...rest } = out
      return describe({ ...rest, oneOf: [...groups].map(([type, values]) => (values.length === 1 ? { type, const: values[0] } : { type, enum: values })) }, notes)
    }
    return describe(out, notes)
  }
  if (typeof schema !== 'object' || schema === null) return undefined
  const root = visit(schema)
  if (root.type !== 'object') return undefined
  if ((schema as { $defs?: unknown }).$defs !== undefined) lossless = false
  return { schema: root, lossless }
}

/**
 * The synthesized ask schema as the tool declares it (ZCode parity: the provider sees the precise
 * shape). It is nested under `properties.result`, so its `$defs` move to the parameters root,
 * where `#/$defs/…` references resolve. `undefined` when the root is not an object schema.
 */
export function exactResultSchema(schema: unknown): { schema: Record<string, unknown>; defs: Record<string, unknown> | undefined } | undefined {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined
  const { $defs, ...rest } = schema as Record<string, unknown>
  if (rest.type !== 'object') return undefined
  const defs = typeof $defs === 'object' && $defs !== null && !Array.isArray($defs) ? $defs as Record<string, unknown> : undefined
  return { schema: rest, defs }
}

/** The relaxed tool schema of a synthesized ask schema, or `undefined` (see {@link relaxToDshSchema}). */
export function toDshSchema(schema: unknown): Record<string, unknown> | undefined {
  return relaxToDshSchema(schema)?.schema
}
