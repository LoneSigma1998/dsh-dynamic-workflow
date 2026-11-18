/**
 * Who may start a workflow, and when (ZCode parity).
 *
 * **Mode** (ZCode's `dynamicWorkflow` feature key, launch.md "Gray release"):
 * - `disabled` — no way to start a workflow: no tools, no `/workflow`, no skill. Existing runs
 *   keep rendering; resuming is withheld.
 * - `onDemand` — every door of `alwaysOn`, but the workflow tools are not offered to the model
 *   until the session is activated: by its first `/workflow`, by a resume or configure of one of
 *   its runs, or by a session whose records already hold a workflow. Activation is sticky and
 *   persisted in the session log.
 * - `alwaysOn` — the tools are offered from the session's first request.
 *
 * **Routing** (how the model treats a task the user did not name a workflow for):
 * - `explicit` — ZCode's CreateWorkflow rule: only an explicit request starts a workflow.
 * - `suggest` — ZCode's Workflow-tool rule: do not start one, but when a task would clearly gain
 *   from it, describe what it would do and its rough cost, and ask.
 * - `auto` — the standing opt-in (ZCode's "ultracode"): run a workflow for every substantive
 *   task without asking.
 * Routing is set per deployment (`routing` config) and per session (`/dwf routing …`, persisted).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { hostModules } from '../dsh/host.ts'

export type WorkflowMode = 'disabled' | 'onDemand' | 'alwaysOn'
export type WorkflowRouting = 'explicit' | 'suggest' | 'auto'
export const WORKFLOW_ROUTINGS: readonly WorkflowRouting[] = ['explicit', 'suggest', 'auto']

/** Log-only session record holding this session's workflow settings (activation, routing). */
export const SETTINGS_RECORD = 'plugin:dynamic-workflow/settings'
export interface SettingsRecord { activated?: true; routing?: WorkflowRouting }

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** This session's dynamic-workflow settings: activation (onDemand) and routing (log-only). */
    'plugin:dynamic-workflow/settings': SettingsRecord
  }
}

/** The ten model-facing workflow tools; a call to any of them in a log means the session has had a workflow. */
export const WORKFLOW_TOOL_NAMES = new Set([
  'create_workflow', 'amend_workflow', 'fill_workflow_hole', 'resume_workflow_run', 'stop_workflow_run',
  'resolve_workflow_question', 'get_workflow_run', 'list_workflow_runs', 'save_workflow', 'list_saved_workflows', 'eval_workflow_snippet',
])

const EXPLICIT_REQUEST = 'An explicit request — "use a workflow", "with a workflow", "使用 workflow", "用工作流", or `/workflow …` — makes create_workflow mandatory, however small the task.'
const COMMON = 'Load the `dynamic-workflows` skill before writing a script. A started run reports back through notifications: never poll it.'

/** The routing rule the model reads, per routing. */
export function routingText(routing: WorkflowRouting): string {
  switch (routing) {
    case 'explicit':
      return `Dynamic workflows (create_workflow) run only when the user asks for one. ${EXPLICIT_REQUEST} Without such a request, do not start a workflow: delegate with the subagent tool or do the work yourself. ${COMMON}`
    case 'suggest':
      return `Dynamic workflows (create_workflow) — routing for this session: suggest. ${EXPLICIT_REQUEST} Without such a request, do not start a workflow yourself. But when a task would clearly gain from one — a sweep over many files or items, independent verification of findings the user will act on, or more material than one context can hold — briefly say what a workflow would do (its phases and roughly how many subagents) and what it would roughly cost (tokens grow with the number of subagents), then ask whether to run it; mention that saying "用工作流" or \`/workflow\` skips the question. Do quick or conversational tasks yourself without suggesting anything. ${COMMON}`
    case 'auto':
      return `Dynamic workflows (create_workflow) — routing for this session: auto. The user has opted in to workflows as the default: author and run a workflow for every substantive task (a review or audit across files, a migration, research across many sources, implement-and-verify work) without asking first. This overrides the \`dynamic-workflows\` skill's rule that only an explicit request starts a workflow. Handle conversational turns and trivial single edits yourself. ${COMMON}`
  }
}

interface SessionLike { id: string; snapshotEvents(): readonly { type: string; data?: unknown }[] }

export class WorkflowAccess {
  private readonly activated = new Set<string>()
  private readonly routings = new Map<string, WorkflowRouting>()

  constructor(
    private readonly ctx: Context,
    readonly mode: WorkflowMode,
    readonly defaultRouting: WorkflowRouting,
    /** Whether the journal holds a run this session launched. */
    private readonly hasRuns: (sessionId: string) => boolean,
  ) {}

  get enabled(): boolean {
    return this.mode !== 'disabled'
  }

  /** Whether the workflow tools are offered to this agent's model now. */
  isActive(agent: Agent | undefined): boolean {
    if (this.mode === 'disabled') return false
    if (this.mode === 'alwaysOn') return true
    if (agent === undefined) return false
    const id = agent.id as string
    if (this.activated.has(id)) return true
    if (this.hasRuns(id) || this.logShowsWorkflow(agent.session as unknown as SessionLike)) {
      this.activated.add(id)
      return true
    }
    return false
  }

  /** Activate a session (onDemand): `/workflow`, a resume or configure of its run. Persisted once. */
  activate(agent: Agent): void {
    if (this.mode !== 'onDemand') return
    const id = agent.id as string
    if (this.activated.has(id)) return
    this.activated.add(id)
    this.record(agent, { activated: true })
  }

  routingOf(agent: Agent | undefined): WorkflowRouting {
    if (agent === undefined) return this.defaultRouting
    const id = agent.id as string
    const cached = this.routings.get(id)
    if (cached !== undefined) return cached
    const fromLog = lastSettings(agent.session as unknown as SessionLike).routing
    const routing = fromLog ?? this.defaultRouting
    this.routings.set(id, routing)
    return routing
  }

  setRouting(agent: Agent, routing: WorkflowRouting): void {
    this.routings.set(agent.id as string, routing)
    this.record(agent, { routing })
  }

  /** The system prompt section for this agent: the routing rule while the tools are offered. */
  sectionText(agent: Agent | undefined): string {
    return this.isActive(agent) ? routingText(this.routingOf(agent)) : ''
  }

  private logShowsWorkflow(session: SessionLike): boolean {
    let events: readonly { type: string; data?: unknown }[]
    try {
      events = session.snapshotEvents()
    } catch {
      return false
    }
    for (const event of events) {
      if (event.type === SETTINGS_RECORD && (event.data as SettingsRecord | undefined)?.activated === true) return true
      if (event.type === 'tool/call' && WORKFLOW_TOOL_NAMES.has(String((event.data as { name?: unknown } | undefined)?.name))) return true
    }
    return false
  }

  private record(agent: Agent, data: SettingsRecord): void {
    const append = hostModules()?.appendPluginRecord
    if (append === null || append === undefined) return
    try {
      append(agent.session, SETTINGS_RECORD, data)
    } catch (error) {
      (this.ctx.logger as unknown as { warn(message: string, ...args: unknown[]): void }).warn('dynamic-workflow: could not persist session settings: %s', String(error))
    }
  }
}

function lastSettings(session: SessionLike): SettingsRecord {
  const merged: SettingsRecord = {}
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type !== SETTINGS_RECORD) continue
      const data = event.data as SettingsRecord | undefined
      if (data?.activated === true) merged.activated = true
      if (data?.routing !== undefined && WORKFLOW_ROUTINGS.includes(data.routing)) merged.routing = data.routing
    }
  } catch {
    // an unreadable log falls back to the deployment defaults
  }
  return merged
}
