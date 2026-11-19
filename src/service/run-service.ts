/**
 * The run service: owns every live run in this process, launches, resumes,
 * amends, retunes, fills holes, answers questions, cancels, and reports.
 *
 * It is the DSH counterpart of ZCode's `bootstrap/src/app/dynamic-workflow-run-service.ts`
 * (+ submit / launch / fill / retune / replay), built on the vendored pure
 * engine and sandbox harness. Three invariants carried over unchanged:
 *   1. the journal is the truth — snapshots, notifications and the UI read
 *      engine records, never what the model said;
 *   2. compile once — one `ts.Program` feeds the site table, schema synthesis
 *      and lowering, and the script hash is computed on the author's text;
 *   3. a live entry outranks the journal for runs this process owns.
 */

import { randomUUID, createHash } from 'node:crypto'
import { availableParallelism } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  validate,
  type ImportedRunCache,
  type JsonSchema,
  type RunEvent,
  type RunSettlement,
  type StoredEvent,
  type ValidateFn,
  type WorkflowEngine,
} from '@zcode/dynamic-workflow'
import { runWorkflowScript } from '@zcode/dynamic-workflow-runtime'
import { createDshWorkflowDriver, type DshWorkflowDriverHandle } from '../driver/driver.ts'
import type { EscalationRegistry, PendingQuestion, ResolveQuestionResult } from '../driver/escalations.ts'
import type { FileChanges, RunOwnership, SqliteJournal } from '../journal/journal.ts'
import { diffStats, unifiedDiff } from './line-diff.ts'
import { formatBlockedNotification, formatEscalationNotification, formatHoleNotification, formatStallNotification, formatTerminalNotification, type RunFailure } from '../notify/text.ts'
import type { NotificationDelivery } from '../notify/delivery.ts'
import { executeWorldRead } from '../world/world-read.ts'
import { createNodeExecutionPort, createNodeFileSystemPort } from '../world/ports.ts'
import { compileOnce, type CompiledScript } from './compile.ts'
import { buildImportedCache, preflightAmendImport, rebuildImportedCacheForResume, type ActorTranscriptStore } from './import.ts'
import { toProgressPayload, type ProgressPayload } from './progress.ts'
import type { ArtifactStore } from './artifacts.ts'
import {
  WORKFLOW_ARTIFACT_LIMITS,
  type WorkflowRunArtifact,
  type WorkflowRunArtifactKind,
  type WorkflowRunArtifactVersion,
} from '../shared/runs/workflow-artifacts.ts'
import type { DwfArtifactItem } from '../journal/zcode/dwf-journal-artifacts.ts'

const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value)

export type RunInitiator = 'user' | 'model' | 'interrupted' | { superseded: string }

export interface LaunchOptions {
  scriptText: string
  name?: string
  args?: Record<string, unknown>
  /** The main agent that owns the run (notifications, UI events, child lineage). */
  parent: Agent
  toolCallId?: string
  maxConcurrency?: number | null
  /** `provider/model` the subagents run on; omitted = the parent's model. */
  subagentModel?: string
  scriptPath?: string
  /** Pre-compiled product of the same text (the tool already compiled it once). */
  compiled?: CompiledScript
  /** Run without the launch confirmation (already confirmed / amend of own run). */
}

export interface LiveRun {
  runId: string
  name: string
  parentSessionId: string
  cwd: string
  controller: AbortController
  settlement: Promise<RunSettlement>
  compiled: CompiledScript
  scriptText: string
  scriptPath?: string
  toolCallId?: string
  startedAt: number
  engine?: Pick<WorkflowEngine, 'setMaxConcurrency' | 'fillHole' | 'openHoles' | 'filledHoles'>
  /** Fill requests are serialized per run. */
  fillQueue: Promise<unknown>
  resumedFrom?: string
  subagentModel?: string
  modelBindings?: Record<string, string>
  /** Last `phase()` the script entered (runtime status context). */
  currentPhase?: string
  /** The run's driver once the sandbox created it. */
  driver?: DshWorkflowDriverHandle
  /** The governor's current cap was recorded on the run (first admitted request). */
  capSeeded?: boolean
  /** The governor bucket (`provider/model`) this run's subagents actually use, learned from their first request. */
  routeKey?: string
  /** Ownership moved to another Host: no more journal writes, progress records or notifications. */
  fenced?: boolean
}

export interface RunServiceDeps {
  ctx: Context
  /** The process-wide governor is installed (it reports subagent requests via noteModelRequest). */
  governed?: boolean
  /** `submit_result` schema declaration (see DshDriverDeps.resultSchema). */
  resultSchema?: 'exact' | 'relaxed'
  /** Per-subagent change lens storage. */
  fileChanges?: FileChanges
  /** Current cap of a governor bucket (`provider/model`), when it exists. */
  governorCap?: (key: string) => number | undefined
  /** Cross-process run ownership (several Hosts may share one journal). */
  ownership?: RunOwnership
  journal: SqliteJournal
  escalations: EscalationRegistry
  delivery: NotificationDelivery
  artifacts?: ArtifactStore
  defaultMaxConcurrency?: number
  logger?: { warn(message: string, ...args: unknown[]): void; info?(message: string, ...args: unknown[]): void }
  /** Append one progress payload into the owner's session (UI projection). */
  onProgress?(parentSessionId: string, payload: ProgressPayload): void
  /** Seed support for amend carry. */
  readSessionEvents?(sessionId: string): Promise<readonly SessionEvent[]>
  /** Whether released subagent transcripts can be read back (a session persistence backend is mounted). */
  transcriptsReadable?(): boolean
  buildForkSeed?(events: readonly SessionEvent[], boundary: number): SessionEvent[]
  /** Per-persona access policy (DSH enhancement). */
  accessOf?(persona: { name?: string; system?: string }): 'full' | 'read-only'
}

export type SubmitResult =
  | { ok: true; runId: string; supersededRunId?: string }
  | { ok: false; reason: string; message: string }

export class RunService {
  private readonly live = new Map<string, LiveRun>()
  private readonly settledListeners = new Set<(notice: { runId: string }) => void>()

  /** A governed model request of a workflow subagent (`dwf-<runId>-<actor>`) waits for or got a slot. */
  noteModelRequest(sessionId: string, phase: 'waiting' | 'executing', routeKey?: string): void {
    for (const entry of this.live.values()) {
      if (sessionId.startsWith(`dwf-${entry.runId}-`)) {
        // A run on the session model has no subagentModel: its bucket is whatever its requests use.
        if (routeKey !== undefined) entry.routeKey ??= routeKey
        entry.driver?.noteModelRequest(sessionId, phase)
        // The run card reads the shared bucket's cap from the run's events: record it once, at the
        // run's first admitted request (later moves arrive through noteConcurrencyChange).
        const key = entry.routeKey ?? entry.subagentModel
        if (phase === 'executing' && entry.capSeeded !== true && key !== undefined) {
          entry.capSeeded = true
          const cap = this.deps.governorCap?.(key)
          const ceiling = this.defaultConcurrency()
          if (cap !== undefined && cap !== ceiling) entry.driver?.noteConcurrency({ key, previous: ceiling, next: cap, reason: 'seeded' } as never)
        }
        return
      }
    }
  }

  /** The governor moved a bucket's cap: every live run on that provider key records it. */
  noteConcurrencyChange(change: { key: string; previous: number; next: number; reason: string }): void {
    for (const entry of this.live.values()) {
      // only the run's own bucket; a run whose bucket is not known yet records nothing
      const key = entry.routeKey ?? entry.subagentModel
      if (key !== change.key) continue
      entry.capSeeded = true
      entry.driver?.noteConcurrency(change as never)
    }
  }

  /** Listen to every run settlement in this process (quota auto-resume, diagnostics). */
  subscribeSettled(listener: (notice: { runId: string }) => void): () => void {
    this.settledListeners.add(listener)
    return () => this.settledListeners.delete(listener)
  }
  private closed = false
  private readonly fileSystemPort = createNodeFileSystemPort()
  private readonly executionPort = createNodeExecutionPort()

  constructor(private readonly deps: RunServiceDeps) {}

  /**
   * The subagent transcripts as amend import reads them: a session's event count is the unit of
   * the journal's message boundaries (`seq + 1` at the end of each exchange). Without it the
   * import can neither continue an in-flight ask nor check that a source transcript is as long
   * as the journal claims.
   */
  private get transcripts(): ActorTranscriptStore | undefined {
    const read = this.deps.readSessionEvents
    // No transcript backend (an in-memory composition): the counts cannot be read, so the import
    // keeps its prefix-only behaviour rather than dropping everything as "too short".
    if (read === undefined || this.deps.transcriptsReadable?.() === false) return undefined
    return { messages: async ({ sessionID }) => [...await read(sessionID as string)] }
  }

  /** Default per-run bound when the launch names none: the machine's parallelism, clamped to [2, 16]. */
  defaultConcurrency(): number {
    return this.deps.defaultMaxConcurrency ?? Math.max(2, Math.min(16, availableParallelism()))
  }

  get journal(): SqliteJournal {
    return this.deps.journal
  }

  liveRun(runId: string): LiveRun | undefined {
    return this.live.get(runId)
  }

  hasLiveRuns(parentSessionId: string): boolean {
    for (const run of this.live.values()) if (run.parentSessionId === parentSessionId) return true
    return false
  }

  liveRunsOf(parentSessionId: string): LiveRun[] {
    return [...this.live.values()].filter(run => run.parentSessionId === parentSessionId)
  }

  // ————————————————————————————— launch —————————————————————————————

  submit(options: LaunchOptions): SubmitResult {
    if (this.closed) return { ok: false, reason: 'closed', message: 'The workflow service is shutting down.' }
    const compiled = options.compiled ?? compileOnce(options.scriptText)
    const runId = `dwfrun-${randomUUID()}`
    this.launch({ ...options, compiled, runId })
    return { ok: true, runId }
  }

  async amend(options: LaunchOptions & { predecessorRunId: string; inheritArgs?: boolean }): Promise<SubmitResult> {
    if (this.closed) return { ok: false, reason: 'closed', message: 'The workflow service is shutting down.' }
    const preflight = preflightAmendImport(this.deps.journal, options.predecessorRunId)
    if (!preflight.ok) {
      return {
        ok: false,
        reason: preflight.reason,
        message: preflight.reason === 'run_not_found'
          ? `No workflow run ${options.predecessorRunId} exists.`
          : `Run ${options.predecessorRunId} has finished asks without transcript boundaries, so its work cannot be imported. Start a fresh run with create_workflow.`,
      }
    }
    const compiled = options.compiled ?? compileOnce(options.scriptText)
    const runId = `dwfrun-${randomUUID()}`
    const predecessor = this.live.get(options.predecessorRunId)
    let supersededRunId: string | undefined
    let quietSessions: ReadonlySet<string> | undefined
    if (predecessor !== undefined) {
      supersededRunId = predecessor.runId
      predecessor.controller.abort({ superseded: runId })
      await predecessor.settlement.catch(() => undefined)
      // Transcript counts are read only once the aborted turns have landed and their agents are
      // released (ZCode's quiescence register); a session that did not quiesce in time is left
      // out, so its in-flight ask restarts instead of continuing from a count that may still grow.
      quietSessions = await Promise.race([
        predecessor.driver?.whenReleased() ?? Promise.resolve(new Set<string>()),
        new Promise<ReadonlySet<string>>(resolve => setTimeout(() => resolve(new Set<string>()), 30_000).unref()),
      ])
    }
    const built = await buildImportedCache(
      { journal: this.deps.journal, ...this.transcripts === undefined ? {} : { actorTranscriptStore: this.transcripts } },
      options.predecessorRunId,
      quietSessions === undefined ? undefined : { quietSessions },
    )
    if (!built.ok) {
      return { ok: false, reason: built.reason, message: `Could not import the finished work of ${options.predecessorRunId} (${built.reason}).` }
    }
    const predecessorRow = this.deps.journal.getRun(options.predecessorRunId)
    const args = options.args ?? (options.inheritArgs === true ? predecessorRow?.args : undefined)
    this.launch({
      ...options,
      ...args === undefined ? {} : { args },
      compiled,
      runId,
      resumedFrom: built.resumedFrom,
      importedCache: built.cache,
      inheritedTokens: predecessorRow?.spentTokens ?? 0,
    })
    return { ok: true, runId, ...supersededRunId === undefined ? {} : { supersededRunId } }
  }

  async resume(runId: string, parent: Agent): Promise<SubmitResult> {
    const pendingOrphans = this.orphans.get(parent.id as string)
    if (pendingOrphans !== undefined) this.orphans.set(parent.id as string, pendingOrphans.filter(id => id !== runId))
    if (this.closed) return { ok: false, reason: 'closed', message: 'The workflow service is shutting down.' }
    const settling = this.live.get(runId)
    if (settling !== undefined) {
      // A run whose journal row is already terminal is in its settlement tail: let it finish.
      const status = this.deps.journal.getRun(runId)?.status
      if (status === 'running' || status === 'pending' || status === undefined) {
        return { ok: false, reason: 'already_running', message: `Run ${runId} is already running in this process.` }
      }
      await settling.settlement.catch(() => undefined)
      await new Promise(resolve => setImmediate(resolve))
    }
    const row = this.deps.journal.getRun(runId)
    if (row === undefined) return { ok: false, reason: 'not_found', message: `No workflow run ${runId} exists.` }
    if (row.status !== 'stopped') {
      return {
        ok: false,
        reason: 'not_resumable',
        message: row.status === 'errored'
          ? `Run ${runId} errored: replaying the same script would fail the same way. Fix the script and use amend_workflow.`
          : `Run ${runId} is ${row.status}; only a stopped run resumes.`,
      }
    }
    if (row.stopReason === 'superseded') {
      return { ok: false, reason: 'superseded', message: `Run ${runId} was superseded by ${row.supersededBy ?? 'a newer run'}; its unfinished work belongs to that run.` }
    }
    if (row.scriptText === undefined) return { ok: false, reason: 'script_missing', message: `Run ${runId} has no stored script.` }
    const hash = createHash('sha256').update(row.scriptText, 'utf8').digest('hex')
    if (row.scriptHash !== undefined && row.scriptHash !== hash) {
      return { ok: false, reason: 'script_mismatch', message: `Run ${runId}'s stored script does not match its hash.` }
    }
    let compiled: CompiledScript
    try {
      compiled = compileOnce(row.scriptText)
    } catch (error) {
      return { ok: false, reason: 'compile_failed', message: `The stored script of run ${runId} no longer compiles: ${String(error)}. Use amend_workflow with a script rewritten for the current facade.` }
    }
    const importedCache = row.resumedFrom === undefined
      ? undefined
      : await rebuildImportedCacheForResume(
        { journal: this.deps.journal, ...this.transcripts === undefined ? {} : { actorTranscriptStore: this.transcripts } },
        { runId, predecessorRunId: row.resumedFrom },
      )
    const launch = this.readLaunch(runId)
    this.launch({
      scriptText: row.scriptText,
      ...row.name === undefined ? {} : { name: row.name },
      ...row.args === undefined ? {} : { args: row.args },
      parent,
      ...row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId },
      compiled,
      runId,
      ...launch?.scriptPath === undefined ? {} : { scriptPath: launch.scriptPath },
      ...launch?.subagentModel === undefined ? {} : { subagentModel: launch.subagentModel },
      resuming: true,
      ...importedCache === undefined ? {} : { importedCache },
    })
    return { ok: true, runId }
  }

  private readLaunch(runId: string): { scriptPath?: string; subagentModel?: string; modelBindings?: Record<string, string>; phaseNames?: string[] } | undefined {
    const events = this.deps.journal.listEvents(runId, { types: ['run-launched'], reportItems: { limit: 0 }, limit: 1 })
    const launched = events[0]?.event
    return launched?.type === 'run-launched' ? launched : undefined
  }

  private launch(input: LaunchOptions & {
    compiled: CompiledScript
    runId: string
    resumedFrom?: string
    importedCache?: ImportedRunCache
    inheritedTokens?: number
    resuming?: boolean
  }): void {
    const { compiled, runId, parent } = input
    const parentSessionId = parent.id as string
    const cwd = parent.session.header.cwd ?? process.cwd()
    const name = input.name ?? compiled.phases.phaseNames[0] ?? 'workflow'
    const controller = new AbortController()
    const maxConcurrency = input.maxConcurrency === null || input.maxConcurrency === undefined
      ? this.defaultConcurrency()
      : Math.max(1, Math.floor(input.maxConcurrency))
    const existingRow = input.resuming === true ? this.deps.journal.getRun(runId) : undefined
    const caps = { maxConcurrency: existingRow?.caps.maxConcurrency ?? maxConcurrency }
    const subagentModel = this.resolveModelSpec(input.subagentModel, parent) ?? this.parentModel(parent)
    const launched = input.resuming === true ? this.readLaunch(runId) : undefined
    const modelBindings = launched?.modelBindings ?? this.modelBindings(compiled, subagentModel, parent)

    const entry: LiveRun = {
      runId,
      name,
      parentSessionId,
      cwd,
      controller,
      settlement: Promise.resolve(undefined as unknown as RunSettlement),
      compiled,
      scriptText: input.scriptText,
      ...input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath },
      ...input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId },
      startedAt: Date.now(),
      fillQueue: Promise.resolve(),
      ...(input.resumedFrom ?? existingRow?.resumedFrom) === undefined ? {} : { resumedFrom: (input.resumedFrom ?? existingRow?.resumedFrom)! },
      ...subagentModel === undefined ? {} : { subagentModel },
      ...modelBindings === undefined ? {} : { modelBindings },
    }
    this.live.set(runId, entry)
    this.deps.ownership?.claim(runId)
    this.ensureHeartbeat()

    // The journal sequence of each event is captured at append so UI payloads carry it.
    const journal = this.deps.journal
    let lastAppended: StoredEvent | undefined
    const capturingJournal = Object.create(journal) as SqliteJournal
    let fencedSequence = 0
    // Write fence, checked before writes (at most once a second) rather than only on the 30 s
    // heartbeat: a Host that took this run over is noticed before this one writes over it.
    let ownershipCheckedAt = 0
    const fenced = (): boolean => {
      if (entry.fenced === true) return true
      const now = Date.now()
      if (this.deps.ownership !== undefined && now - ownershipCheckedAt >= 1000) {
        ownershipCheckedAt = now
        try {
          if (this.deps.ownership.takenOver(runId)) this.fence(runId)
        } catch { /* a failed check never blocks a write */ }
      }
      return (entry.fenced as boolean | undefined) === true // fence() may have just set it
    }
    capturingJournal.appendEvent = (id: string, event: RunEvent): StoredEvent => {
      if (fenced()) return { sequence: --fencedSequence, event } as unknown as StoredEvent
      const stored = journal.appendEvent(id, event)
      lastAppended = stored
      return stored
    }
    // write fence: once fenced, every write of this run is dropped (reads still answer)
    for (const method of ['createRun', 'updateRunStatus', 'updateRunUsage', 'updateRunCaps', 'updateRunScript', 'putActor', 'putNode'] as const) {
      const original = (journal as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!.bind(journal)
      ;(capturingJournal as unknown as Record<string, (...args: unknown[]) => unknown>)[method] = (...args: unknown[]) => (fenced() ? undefined : original(...args))
    }

    const makeDriver = createDshWorkflowDriver({
      ctx: this.deps.ctx,
      governed: this.deps.governed === true,
      ...this.deps.resultSchema === undefined ? {} : { resultSchema: this.deps.resultSchema },
      ...this.deps.fileChanges === undefined ? {} : {
        fileChanges: {
          before: (sessionId: string, actor: string | undefined, path: string, content: string | null) => this.deps.fileChanges!.before(runId, sessionId, actor, path, content),
          after: (sessionId: string, path: string, content: string | null) => this.deps.fileChanges!.after(runId, sessionId, path, content),
        },
      },
      runId,
      runName: name,
      parent,
      parentSessionId,
      cwd,
      journal: capturingJournal,
      emit: (event) => {
        const stored = lastAppended !== undefined && lastAppended.event === event ? lastAppended : undefined
        try {
          this.onRunEvent(entry, event, stored)
        } catch (error) {
          this.deps.logger?.warn('dynamic-workflow: run event hook failed: %s', String(error))
        }
      },
      actorSubmitProfiles: compiled.actorSubmitProfiles,
      ...modelBindings === undefined ? {} : { modelBindings },
      ...subagentModel === undefined ? {} : { subagentModel },
      escalations: this.deps.escalations,
      executeWorldRead: (op, args) => executeWorldRead({ fileSystemPort: this.fileSystemPort, executionPort: this.executionPort, cwd, signal: controller.signal }, op, args),
      ...this.deps.artifacts === undefined ? {} : { artifacts: { publish: request => this.deps.artifacts!.publish(cwd, request) } },
      ...this.deps.accessOf === undefined ? {} : { accessOf: this.deps.accessOf },
      ...this.deps.readSessionEvents === undefined ? {} : { readSessionEvents: this.deps.readSessionEvents },
      ...this.deps.buildForkSeed === undefined ? {} : { buildForkSeed: this.deps.buildForkSeed },
      ...this.deps.logger === undefined ? {} : { logger: this.deps.logger },
    }, (driver) => { entry.driver = driver })

    const settlement = runWorkflowScript({
      askSpecs: compiled.askSpecs,
      sitePhases: compiled.sitePhases,
      caps,
      cwd,
      lowered: compiled.lowered,
      makeDriver,
      onWarning: warning => this.deps.logger?.warn('dynamic-workflow: entry file fallback %o', warning),
      name,
      ...input.args === undefined ? {} : { args: input.args },
      parentSessionId,
      runId,
      scriptHash: compiled.scriptHash,
      scriptText: input.scriptText,
      ...input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId },
      ...input.resumedFrom === undefined ? {} : { resumedFrom: input.resumedFrom },
      ...input.importedCache === undefined ? {} : { importedCache: input.importedCache },
      ...input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens },
      launch: {
        inputId: input.toolCallId ?? runId,
        phaseNames: compiled.phases.phaseNames,
        ...compiled.phases.holes.length === 0 ? {} : { holes: compiled.phases.holes },
        ...subagentModel === undefined ? {} : { subagentModel },
        ...modelBindings === undefined ? {} : { modelBindings },
        ...input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath },
      } as never,
      signal: controller.signal,
      control: { bind: (engine) => { entry.engine = engine } },
      validate: validateFn,
    })
    entry.settlement = settlement
    void settlement.then(
      result => this.onSettled(entry, result),
      (error) => {
        this.live.delete(entry.runId)
        if (entry.fenced !== true) this.deps.ownership?.release(entry.runId)
        this.deps.delivery.wake(entry.parentSessionId)
        this.deps.logger?.warn('dynamic-workflow: run %s settlement rejected: %s', runId, String(error))
      },
    )
  }

  /** Provider names already authorized by a run's launch settings (subagentModel + modelBindings). */
  launchedProviders(runId: string): Set<string> {
    const providers = new Set<string>()
    const add = (spec: string | undefined): void => {
      if (spec === undefined) return
      const slash = spec.indexOf('/')
      if (slash > 0) providers.add(spec.slice(0, slash))
    }
    const launched = this.readLaunch(runId)
    add(launched?.subagentModel)
    for (const bound of Object.values(launched?.modelBindings ?? {})) add(bound)
    return providers
  }

  /**
   * Normalize a model spec (`provider/model[$effort]` or a bare `model[$effort]`):
   * a bare name resolves inside the session's current provider (matching SKILL.md §16.1),
   * never crossing providers unless `provider/model` is written explicitly.
   */
  resolveModelSpec(spec: string | undefined, parent: Agent): string | undefined {
    if (spec === undefined) return undefined
    const trimmed = spec.trim()
    if (trimmed.length === 0) return undefined
    if (trimmed.includes('/')) return trimmed
    const parentProvider = this.parentModel(parent)?.split('/')[0]
    return parentProvider === undefined ? trimmed : `${parentProvider}/${trimmed}`
  }

  /** Provider names that a candidate launch (compiled script + subagentModel) would invoke. */
  candidateProviders(compiled: CompiledScript, subagentModel: string | undefined, parent: Agent): Set<string> {
    const providers = new Set<string>()
    const effectiveSubagent = this.resolveModelSpec(subagentModel, parent) ?? this.parentModel(parent)
    const add = (spec: string | undefined): void => {
      if (spec === undefined) return
      const slash = spec.indexOf('/')
      if (slash > 0) providers.add(spec.slice(0, slash))
    }
    add(effectiveSubagent)
    const bindings = this.modelBindings(compiled, effectiveSubagent, parent)
    for (const bound of Object.values(bindings ?? {})) add(bound)
    return providers
  }

  /**
   * Check declared model references and an explicit `subagentModel` against the Host's live model
   * catalog (ZCode diagnostic 9011 parity). Bare model ids are resolved inside the session's
   * provider first. Returns error lines when a model is unknown; skips silently when no provider
   * catalog is populated (e.g. scripted unit-test adapters).
   */
  async validateModels(compiled: CompiledScript, subagentModel: string | undefined, parent: Agent): Promise<string[]> {
    const llm = this.deps.ctx.get('llm' as never) as {
      listProviders?(): { id: string }[]
      listModels?(provider: string): Promise<{ id: string }[]>
    } | undefined
    if (llm?.listProviders === undefined || llm.listModels === undefined) return []
    const providers = llm.listProviders()
    const registeredProviders = new Set(providers.map(p => p.id))
    const catalog = new Map<string, Set<string>>()
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id)
        if (models.length > 0) catalog.set(provider.id, new Set(models.map(m => m.id)))
      } catch {
        // skip providers that cannot list models
      }
    }
    if (registeredProviders.size === 0) return []
    const check = (label: string, spec: string): string | undefined => {
      const slash = spec.indexOf('/')
      if (slash <= 0 || slash === spec.length - 1) return `${label} "${spec}" must be in "provider/model" form (session has no active provider).`
      const provider = spec.slice(0, slash)
      const rest = spec.slice(slash + 1)
      const dollar = rest.indexOf('$')
      const modelId = dollar < 0 ? rest : rest.slice(0, dollar)
      if (modelId.length === 0) return `${label} "${spec}" is missing a model id.`
      if (!registeredProviders.has(provider)) return `${label} "${spec}" names unknown provider "${provider}".`
      const known = catalog.get(provider)
      if (known === undefined) return undefined // provider does not expose a static list
      if (!known.has(modelId)) return `${label} "${spec}" is not available on provider "${provider}".`
      return undefined
    }
    const errors: string[] = []
    const normalizedSubagent = this.resolveModelSpec(subagentModel, parent)
    if (normalizedSubagent !== undefined) {
      const err = check('subagent_model', normalizedSubagent)
      if (err !== undefined) errors.push(err)
    }
    const bindings = this.modelBindings(compiled, normalizedSubagent ?? this.parentModel(parent), parent)
    for (const [ref, bound] of Object.entries(bindings ?? {})) {
      const err = check(`model("${ref}")`, bound)
      if (err !== undefined) errors.push(err)
    }
    return errors
  }

  private parentModel(parent: Agent): string | undefined {
    const config = parent.session.requestHeader?.()?.config
    if (config !== undefined) return `${config.provider}/${config.model}`
    const options = parent.options
    if (options.provider !== undefined && options.model !== undefined) return `${options.provider}/${options.model}`
    return undefined
  }

  /** Bind every `model("…")` the script names: `provider/model` literals bind to themselves; bare ids use the run's or session's provider. */
  private modelBindings(compiled: CompiledScript, subagentModel: string | undefined, parent?: Agent): Record<string, string> | undefined {
    if (compiled.modelReferences.length === 0) return undefined
    const provider = subagentModel?.includes('/') ? subagentModel.split('/')[0] : parent === undefined ? undefined : this.parentModel(parent)?.split('/')[0]
    const out: Record<string, string> = {}
    for (const name of compiled.modelReferences) {
      out[name] = name.includes('/') ? name : provider === undefined ? name : `${provider}/${name}`
    }
    return out
  }

  // ————————————————————————————— events —————————————————————————————

  private onRunEvent(entry: LiveRun, event: RunEvent, stored: StoredEvent | undefined): void {
    if (entry.fenced === true) return // the new owner writes this run's progress
    const payload = toProgressPayload({
      runId: entry.runId,
      event,
      sequence: stored?.sequence ?? -1,
      at: stored?.timeCreated ?? Date.now(),
      ...entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId },
      ...entry.resumedFrom === undefined ? {} : { resumedFrom: entry.resumedFrom },
      concurrencyCeiling: this.defaultConcurrency(),
      ...entry.subagentModel === undefined ? {} : { subagentModel: entry.subagentModel },
      ...entry.modelBindings === undefined ? {} : { modelBindings: entry.modelBindings },
      holeTypeOf: siteId => entry.compiled.holes.find(hole => hole.siteId === siteId)?.type,
    })
    if (payload !== undefined) this.deps.onProgress?.(entry.parentSessionId, payload)
    if (event.type === 'phase-entered') entry.currentPhase = event.name

    switch (event.type) {
      case 'escalation-raised':
        void this.deps.delivery.deliver(entry.parentSessionId, {
          summary: `Workflow question from ${event.actorName ?? event.actor.siteId}`,
          text: formatEscalationNotification({
            runLabel: entry.name,
            runId: entry.runId,
            qid: event.qid,
            actor: event.actorName ?? `${event.actor.siteId}@${event.actor.ordinal}`,
            question: event.question,
            ...event.context === undefined ? {} : { context: event.context },
          }),
        })
        return
      case 'hole-reached': {
        const hole = entry.compiled.holes.find(item => item.siteId === event.instance.siteId)
        void this.deps.delivery.deliver(entry.parentSessionId, {
          summary: `Workflow hole "${event.name}" is waiting`,
          text: formatHoleNotification({
            runLabel: entry.name,
            runId: entry.runId,
            holeId: event.instance.siteId,
            name: event.name,
            type: hole?.type ?? 'unknown',
            ...event.prompt === undefined ? {} : { prompt: event.prompt },
            ...entry.scriptPath === undefined ? {} : { draftPath: entry.scriptPath },
            ...hole?.line === undefined ? {} : { line: hole.line },
          }),
        })
        return
      }
      case 'run-stalled':
        void this.deps.delivery.deliver(entry.parentSessionId, {
          summary: 'Workflow stalled on the provider',
          text: formatStallNotification({ runLabel: entry.name, runId: entry.runId, sinceMs: event.sinceMs, ...event.reason === undefined ? {} : { reason: event.reason }, ...event.cap === undefined ? {} : { cap: event.cap } }),
        })
        return
      default:
    }
  }

  private onSettled(entry: LiveRun, settlement: RunSettlement): void {
    this.live.delete(entry.runId)
    if (entry.fenced === true) {
      // Wake any hold-mode waiter so the owning turn does not hang after fencing.
      this.deps.delivery.wake(entry.parentSessionId)
      return // the new owner settles and notifies; never release its claim
    }
    this.deps.ownership?.release(entry.runId)
    for (const listener of this.settledListeners) {
      try { listener({ runId: entry.runId }) } catch (error) { this.deps.logger?.warn('dynamic-workflow: settle listener failed: %s', String(error)) }
    }
    const status = settlement.status as 'completed' | 'errored' | 'stopped'
    const stopReason = (settlement as { stopReason?: string }).stopReason as never
    if (stopReason === 'superseded') return
    if (this.closed && stopReason === 'interrupted') return
    const snapshot = this.snapshot(entry.runId)
    const failure = (settlement as { error?: { code?: string; message: string; providerStop?: unknown } }).error
    const text = formatTerminalNotification({
      runId: entry.runId,
      ...entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId },
      name: entry.name,
      status,
      ...stopReason === undefined ? {} : { stopReason },
      ...status === 'completed' ? { result: renderResult((settlement as { artifact?: unknown }).artifact) } : {},
      ...failure === undefined ? {} : { failure: failure as RunFailure },
      ...snapshot.reports.count === 0 ? {} : { reports: { count: snapshot.reports.count, shown: snapshot.reports.preview.length, preview: snapshot.reports.preview.join('\n') } },
      ...snapshot.artifacts.length === 0 ? {} : { artifacts: { count: snapshot.artifacts.length, shown: Math.min(8, snapshot.artifacts.length), preview: snapshot.artifacts.slice(0, 8).map(item => `- ${item.title ?? item.id} (${item.kind}${item.primary ? ', primary' : ''})`).join('\n') } },
      ...entry.scriptPath === undefined ? {} : { scriptPath: entry.scriptPath },
      durationMs: Date.now() - entry.startedAt,
      spentTokens: snapshot.spentTokens,
    })
    void this.deps.delivery.deliver(entry.parentSessionId, { text, summary: `Workflow "${entry.name}" ${status}` })
    // The engine's `run-settled` carries no result; the GUI's result preview rides one extra
    // record (folded by the projection, ignored by the ZCode reducer).
    if (status === 'completed') {
      this.deps.onProgress?.(entry.parentSessionId, {
        runId: entry.runId,
        ...entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId },
        sequence: -1,
        eventType: RUN_RESULT_EVENT,
        payload: { resultPreview: renderResult((settlement as { artifact?: unknown }).artifact).slice(0, 2048) },
        at: Date.now(),
      })
    }
  }

  // ————————————————————————————— control —————————————————————————————

  cancel(runId: string, initiator: RunInitiator): { ok: boolean; message: string } {
    const entry = this.live.get(runId)
    if (entry === undefined) return { ok: false, message: `Run ${runId} is not running in this process.` }
    entry.controller.abort(initiator)
    return { ok: true, message: `Stopping run ${runId}.` }
  }

  retune(runId: string, maxConcurrency: number | null): { ok: boolean; applied?: number; previous?: number; message: string } {
    const entry = this.live.get(runId)
    if (entry?.engine === undefined) return { ok: false, message: `Run ${runId} is not running in this process.` }
    const previous = this.deps.journal.getRun(runId)?.caps.maxConcurrency
    const applied = maxConcurrency === null ? this.defaultConcurrency() : Math.max(1, Math.floor(maxConcurrency))
    const changed = entry.engine.setMaxConcurrency(applied)
    return { ok: true, applied, ...previous === undefined ? {} : { previous }, message: changed ? `Max concurrency ${previous ?? '?'} → ${applied}.` : `Max concurrency is already ${applied}.` }
  }

  /**
   * Revise a run's settings from the GUI (ZCode `amendWorkflowRunSettings`): the same script on a
   * new run that imports the finished work, with the new concurrency and/or subagent model
   * (`null` = the session model). No model turn, no confirmation.
   */
  async configure(runId: string, parent: Agent, settings: { maxConcurrency?: number; subagentModel?: string | null }): Promise<SubmitResult & { supersededRunId?: string }> {
    const row = this.deps.journal.getRun(runId)
    if (row?.scriptText === undefined) return { ok: false, reason: 'not_found', message: `Run ${runId} has no stored script.` }
    const launch = this.readLaunch(runId)
    const subagentModel = settings.subagentModel === undefined ? launch?.subagentModel : settings.subagentModel ?? undefined
    return await this.amend({
      predecessorRunId: runId,
      scriptText: row.scriptText,
      ...row.name === undefined ? {} : { name: row.name },
      parent,
      maxConcurrency: settings.maxConcurrency ?? row.caps.maxConcurrency,
      ...subagentModel === undefined ? {} : { subagentModel },
      ...launch?.scriptPath === undefined ? {} : { scriptPath: launch.scriptPath },
      ...row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId },
      inheritArgs: true,
    })
  }

  /** What each subagent changed through file tools, grouped by subagent, with line counts. */
  changes(runId: string): { sessionId: string; actor?: string; files: { path: string; added: number; removed: number; created: boolean; deleted: boolean; tooLarge: boolean; edits: number }[] }[] {
    const store = this.deps.fileChanges
    if (store === undefined) return []
    const bySession = new Map<string, { sessionId: string; actor?: string; files: { path: string; added: number; removed: number; created: boolean; deleted: boolean; tooLarge: boolean; edits: number }[] }>()
    for (const row of store.list(runId)) {
      const entry = bySession.get(row.sessionId) ?? { sessionId: row.sessionId, ...row.actor === undefined ? {} : { actor: row.actor }, files: [] }
      bySession.set(row.sessionId, entry)
      const contents = row.tooLarge ? undefined : store.get(runId, row.sessionId, row.path)
      const stats = contents === undefined ? { added: 0, removed: 0 } : diffStats(contents.before, contents.after)
      if (contents !== undefined && stats.added === 0 && stats.removed === 0 && row.beforeMissing === row.afterMissing) continue // written back unchanged
      entry.files.push({ path: row.path, ...stats, created: row.beforeMissing && !row.afterMissing, deleted: !row.beforeMissing && row.afterMissing, tooLarge: row.tooLarge, edits: row.edits })
    }
    return [...bySession.values()].filter(entry => entry.files.length > 0)
  }

  /** The unified diff of one subagent's change to one file (before its first edit → after its last). */
  changeDiff(runId: string, sessionId: string, path: string): { diff?: string; tooLarge?: true } | undefined {
    const contents = this.deps.fileChanges?.get(runId, sessionId, path)
    if (contents === undefined) return undefined
    if (contents.tooLarge) return { tooLarge: true }
    return { diff: unifiedDiff(path, contents.before, contents.after) }
  }

  /**
   * All published/declared user-facing artifacts of one run, grouped by id (version ascending),
   * with tagged-report counts (`itemCount`) for preset dashboards (`chart` / `table` / `metrics` / `board`).
   */
  artifacts(runId: string): WorkflowRunArtifact[] {
    const rows = this.deps.journal.listArtifactRows(runId)
    const counts = this.deps.journal.countTaggedReports(runId)
    const grouped = new Map<string, { kind: WorkflowRunArtifactKind; versions: WorkflowRunArtifactVersion[]; primary?: true }>()
    for (const node of rows) {
      if (node.status !== 'completed') continue
      const record = node.result as {
        id?: string; kind?: string; version?: number; title?: string; description?: string
        contentType?: string; bytes?: number; uri?: string; sourcePath?: string; spec?: unknown
        publishedAt?: number; primary?: boolean
      } | undefined
      if (record?.id === undefined || record.kind === undefined) continue
      const kind = record.kind as WorkflowRunArtifactKind
      const versionEntry: WorkflowRunArtifactVersion = {
        version: record.version ?? 1,
        publishedAt: record.publishedAt ?? 0,
        ...record.title === undefined ? {} : { title: record.title },
        ...record.description === undefined ? {} : { description: record.description },
        ...record.contentType === undefined ? {} : { contentType: record.contentType },
        ...record.bytes === undefined ? {} : { bytes: record.bytes },
        ...record.uri === undefined ? {} : { uri: record.uri },
        ...record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath },
        ...record.spec === undefined ? {} : { spec: record.spec },
        ...record.primary === true ? { primary: true as const } : {},
      }
      const existing = grouped.get(record.id)
      if (existing === undefined) {
        grouped.set(record.id, { kind, versions: [versionEntry], ...record.primary === true ? { primary: true as const } : {} })
      } else {
        existing.versions.push(versionEntry)
        if (record.primary === true) existing.primary = true
      }
    }
    const out: WorkflowRunArtifact[] = []
    for (const [id, entry] of grouped) {
      entry.versions.sort((a, b) => a.version - b.version)
      const latest = entry.versions[entry.versions.length - 1]!
      out.push({
        id,
        kind: entry.kind,
        version: latest.version,
        versions: entry.versions,
        itemCount: counts.get(id) ?? 0,
        ...latest.title === undefined ? {} : { title: latest.title },
        ...latest.description === undefined ? {} : { description: latest.description },
        ...latest.contentType === undefined ? {} : { contentType: latest.contentType },
        ...latest.sourcePath === undefined ? {} : { sourcePath: latest.sourcePath },
        ...latest.spec === undefined ? {} : { spec: latest.spec },
        ...entry.primary === true ? { primary: true as const } : {},
      })
    }
    return out
  }

  /** Paged tagged `report(item, artifactId)` items feeding a preset dashboard artifact. */
  artifactData(
    runId: string,
    artifactId: string,
    options: { afterSequence?: number; limit?: number; fields?: readonly string[] } = {},
  ): { items: DwfArtifactItem[]; hasMore: boolean } {
    const rawLimit = options.limit ?? WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage
    const limit = Math.max(1, Math.min(WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage, Math.floor(rawLimit)))
    const fields = options.fields === undefined || options.fields.length === 0
      ? undefined
      : options.fields
        .filter(path => typeof path === 'string' && path.length > 0 && path.length <= WORKFLOW_ARTIFACT_LIMITS.maxFieldPathLength)
        .slice(0, WORKFLOW_ARTIFACT_LIMITS.maxFieldsPerRequest)
    return this.deps.journal.listArtifactItems(runId, artifactId, {
      ...options.afterSequence !== undefined && Number.isFinite(options.afterSequence) && options.afterSequence >= 0
        ? { afterSequence: Math.floor(options.afterSequence) }
        : {},
      limit,
      maxBytes: WORKFLOW_ARTIFACT_LIMITS.maxPageBytes,
      ...fields !== undefined && fields.length > 0
        ? { fields: { paths: fields, maxValueBytes: WORKFLOW_ARTIFACT_LIMITS.maxFieldValueBytes } }
        : {},
    })
  }

  /** The published record of one artifact version (content type for the download route). */
  artifactMeta(runId: string, id: string, version: number): { contentType?: string; kind?: string } | undefined {
    const journal = this.deps.journal as unknown as { listArtifactRows?(runId: string): { result?: unknown }[] }
    for (const node of journal.listArtifactRows?.(runId) ?? []) {
      const record = node.result as { id?: string; version?: number; contentType?: string; kind?: string } | undefined
      if (record?.id === id && (record.version ?? 1) === version) return { ...record.contentType === undefined ? {} : { contentType: record.contentType }, ...record.kind === undefined ? {} : { kind: record.kind } }
    }
    return undefined
  }

  /** The run a parked question belongs to, if it is still open. */
  questionRun(qid: string): string | undefined {
    return this.deps.escalations.runOf(qid)
  }

  resolveQuestion(qid: string, answer: string): ResolveQuestionResult {
    return this.deps.escalations.resolve(qid, answer)
  }

  pendingQuestions(runId: string): PendingQuestion[] {
    return this.deps.escalations.pendingFor(runId)
  }

  /** Open holes of a live run (from the engine's parked set). */
  openHoles(runId: string): { siteId: string; ordinal: number; name: string; since?: number }[] {
    const entry = this.live.get(runId)
    const open = entry?.engine?.openHoles() ?? []
    return open.map(hole => ({ siteId: hole.siteId, ordinal: hole.ordinal, name: hole.name }))
  }

  /** The `<workflow-blocked>` reminder for the owner's runs that wait on it, if any. */
  blockedReminder(parentSessionId: string): string | undefined {
    for (const entry of this.liveRunsOf(parentSessionId)) {
      const questions = this.pendingQuestions(entry.runId)
      const holes = this.openHoles(entry.runId).map((hole) => {
        const compiled = entry.compiled.holes.find(item => item.siteId === hole.siteId)
        return { siteId: hole.siteId, name: hole.name, type: compiled?.type ?? 'unknown', ...compiled?.line === undefined ? {} : { line: compiled.line } }
      })
      if (questions.length === 0 && holes.length === 0) continue
      return formatBlockedNotification({ runLabel: entry.name, runId: entry.runId, now: Date.now(), questions, holes, ...entry.scriptPath === undefined ? {} : { draftPath: entry.scriptPath } })
    }
    return undefined
  }

  /**
   * Runtime status context for the owner's model requests (DSH `systemPrompt.context`): one line
   * per live run — what it is and what it waits on. Deliberately coarse (no counters) so it only
   * changes when something the agent should know changes: DSH re-sends a context only on change.
   * Empty when the owner has no live run.
   */
  runtimeStatus(parentSessionId: string): string {
    const lines: string[] = []
    for (const entry of this.liveRunsOf(parentSessionId)) {
      const questions = this.pendingQuestions(entry.runId)
      const holes = this.openHoles(entry.runId)
      const waiting = [
        ...questions.map(q => `question ${q.qid} from ${q.actorName ?? q.actor} (answer with resolve_workflow_question)`),
        ...holes.map(h => `hole "${h.name}" (fill with fill_workflow_hole)`),
      ]
      lines.push(`- ${entry.runId} "${entry.name}": running${entry.currentPhase === undefined ? '' : `, phase "${entry.currentPhase}"`}${waiting.length === 0 ? '' : `; waiting on you: ${waiting.join('; ')}`}`)
    }
    if (lines.length === 0) return ''
    return [
      '<workflow-runs>',
      'Dynamic workflow runs you started are still running in the background. They report back with a <task-notification> when they settle: do not poll them, and do not start a duplicate run. To change a running run use amend_workflow; to stop it, stop_workflow_run.',
      ...lines,
      '</workflow-runs>',
    ].join('\n')
  }

  // ————————————————————————————— read faces —————————————————————————————

  snapshot(runId: string): RunSnapshot {
    const journal = this.deps.journal
    const row = journal.getRun(runId)
    const entry = this.live.get(runId)
    const nodes = journal.listNodes(runId, { kinds: ['ask', 'world-read', 'world-run'], withResult: false })
    const reportEvents = journal.listEvents(runId, { types: ['report'], reportItems: 'all', limit: 64 })
    const reportCount = journal.countNodes(runId, 'report')
    const artifacts = this.artifacts(runId)
    const actors = journal.listActors(runId, { withPersona: false } as never)
    const logs = journal.listRecentLogEvents?.(runId, 20) ?? []
    const counts = { queued: 0, running: 0, completed: 0, failed: 0 }
    for (const node of nodes) {
      if (node.status === 'running') counts.running += 1
      else if (node.status === 'completed') counts.completed += 1
      else counts.failed += 1
    }
    return {
      runId,
      name: row?.name ?? entry?.name ?? runId,
      status: entry !== undefined ? 'running' : row?.status ?? 'pending',
      ...entry === undefined && row?.stopReason !== undefined ? { stopReason: row.stopReason } : {},
      ...row?.supersededBy === undefined ? {} : { supersededBy: row.supersededBy },
      ...row?.resumedFrom === undefined ? {} : { resumedFrom: row.resumedFrom },
      ...entry === undefined && row?.failure !== undefined ? { failure: row.failure as RunFailure } : {},
      ...entry === undefined && row?.result !== undefined ? { result: row.result } : {},
      spentTokens: row?.spentTokens ?? 0,
      maxConcurrency: row?.caps.maxConcurrency ?? 0,
      nodes: counts,
      actors: actors.map(actor => ({ siteId: actor.siteId, ordinal: actor.ordinal, ...actor.name === undefined ? {} : { name: actor.name }, ...actor.sessionId === undefined ? {} : { sessionId: actor.sessionId } })),
      reports: {
        count: reportCount,
        preview: reportEvents.flatMap(({ event }) => event.type === 'report' ? [boundedJson(event.item, 500)] : []).slice(0, 8),
      },
      artifacts: artifacts.map(item => ({
        id: item.id,
        kind: item.kind,
        ...item.title === undefined ? {} : { title: item.title },
        ...item.description === undefined ? {} : { description: item.description },
        primary: item.primary === true,
        version: item.version,
        ...item.contentType === undefined ? {} : { contentType: item.contentType },
        ...item.versions[item.versions.length - 1]?.bytes === undefined ? {} : { bytes: item.versions[item.versions.length - 1]!.bytes },
        ...item.spec === undefined ? {} : { spec: item.spec },
        itemCount: item.itemCount,
      })),
      pendingQuestions: this.pendingQuestions(runId),
      openHoles: this.openHoles(runId),
      logTail: logs.flatMap(({ event }) => event.type === 'log' ? [event.message] : []),
      ...entry?.scriptPath === undefined ? {} : { scriptPath: entry.scriptPath },
      resumable: entry === undefined && row?.status === 'stopped' && row.stopReason !== 'superseded',
      live: entry !== undefined,
    }
  }

  listRuns(parentSessionId: string | undefined, limit = 20): { runId: string; name: string; status: string; stopReason?: string; spentTokens: number; updated: number }[] {
    const rows = this.deps.journal.listRunRows(parentSessionId, limit)
    return rows.map(row => ({
      ...row,
      ...this.live.has(row.runId) ? { status: 'running' } : {},
    }))
  }

  /** Mark every non-terminal run owned by a session as interrupted (cold start reconciliation). */
  /** Runs this process marked interrupted at start, by owner session, not yet settled in the owner's log. */
  private readonly orphans = new Map<string, string[]>()

  /** Take (and forget) the interrupted runs of one owner session. */
  takeOrphans(parentSessionId: string): string[] {
    const runs = this.orphans.get(parentSessionId) ?? []
    this.orphans.delete(parentSessionId)
    return runs
  }

  private heartbeat?: ReturnType<typeof setInterval>

  /** Keep this process's ownership rows fresh while it executes runs. */
  private ensureHeartbeat(): void {
    if (this.heartbeat !== undefined || this.deps.ownership === undefined) return
    this.heartbeat = setInterval(() => {
      if (this.live.size === 0) {
        clearInterval(this.heartbeat)
        this.heartbeat = undefined
        return
      }
      try {
        this.deps.ownership?.beat()
        // write fence: a run another Host took over is no longer ours to write
        for (const runId of this.deps.ownership?.lost() ?? []) this.fence(runId)
      } catch (error) {
        this.deps.logger?.warn('dynamic-workflow: ownership heartbeat failed: %s', String(error))
      }
    }, 30_000)
    this.heartbeat.unref?.()
  }

  /**
   * Stop a run whose ownership moved to another Host without writing anything more for it: its
   * journal writes become no-ops and its notifications are dropped (the new owner reports).
   */
  fence(runId: string): void {
    const entry = this.live.get(runId)
    if (entry === undefined || entry.fenced === true) return
    entry.fenced = true
    this.deps.logger?.warn('dynamic-workflow: run %s is now executed by another Host; this process stops it without further writes', runId)
    entry.controller.abort('interrupted')
  }

  reconcileOrphans(): number {
    let count = 0
    for (const row of this.deps.journal.listNonTerminalRunsAll()) {
      if (this.live.has(row.runId)) continue
      // Another Host sharing this DSH_HOME is executing it: not an orphan.
      if (this.deps.ownership?.ownedElsewhere(row.runId) === true) continue
      const updated = this.deps.journal.markInterruptedIfNonTerminal(row.runId, {
        code: 'Interrupted',
        message: `dynamic workflow run ${row.runId} was interrupted: the owning process exited before the run settled`,
      })
      if (!updated) continue
      if (row.parentSessionId !== undefined) this.orphans.set(row.parentSessionId, [...this.orphans.get(row.parentSessionId) ?? [], row.runId])
      count += 1
    }
    return count
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    const runs = [...this.live.values()]
    for (const run of runs) run.controller.abort('interrupted')
    await Promise.allSettled(runs.map(run => run.settlement))
  }
}

/** Progress record carrying a completed run's result preview (see onSettled). */
export const RUN_RESULT_EVENT = 'run-result'

export interface RunSnapshot {
  runId: string
  name: string
  status: string
  stopReason?: string
  supersededBy?: string
  resumedFrom?: string
  failure?: RunFailure
  result?: unknown
  spentTokens: number
  maxConcurrency: number
  nodes: { queued: number; running: number; completed: number; failed: number }
  actors: { siteId: string; ordinal: number; name?: string; sessionId?: string }[]
  reports: { count: number; preview: string[] }
  artifacts: { id: string; kind: string; title?: string; description?: string; primary: boolean; version: number; contentType?: string; bytes?: number; spec?: unknown; itemCount?: number }[]
  pendingQuestions: PendingQuestion[]
  openHoles: { siteId: string; ordinal: number; name: string }[]
  logTail: string[]
  scriptPath?: string
  resumable: boolean
  /** Whether the run executes in this Host process right now. */
  live: boolean
}

export function renderResult(value: unknown): string {
  if (value === undefined) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function boundedJson(value: unknown, max: number): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export type { SessionId }
