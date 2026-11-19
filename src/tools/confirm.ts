/**
 * The launch confirmation (ZCode's confirmation window): shown in every
 * permission mode before a script runs, with Allow / Always allow in this
 * session / Deny / Refine (deny with feedback the model reads).
 *
 * DSH's binary approval channel cannot carry a script or a feedback box, so the
 * confirmation rides `ctx.userQuestions` with a fixed question id. The plugin's
 * Web client renders that question as the timeline card in the composer; any
 * other client still gets a usable generic question whose detail is markdown.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkflowLaunchDisplay } from '../display/types.ts'

export const CONFIRM_QUESTION_ID = 'dynamic-workflow-confirm'
export const CONFIRM_LABELS = {
  allow: 'Allow',
  always: 'Always allow in this session',
  deny: 'Deny',
  refine: 'Refine',
} as const

export type ConfirmMode = 'ask' | 'never' | 'ask-or-allow'

/** Settings the user changed in the confirmation card before allowing (ZCode's ask settings). */
export interface ConfirmSettings {
  maxConcurrency?: number
  /** `null`: back to the session model. */
  subagentModel?: string | null
}

/** Prefix of the `custom` text an Allow answer carries when the user edited the settings. */
export const SETTINGS_ANSWER_PREFIX = 'dwf-settings:'

export type ConfirmDecision =
  | { kind: 'allow'; always?: true; settings?: ConfirmSettings }
  | { kind: 'deny' }
  | { kind: 'refine'; feedback: string }

export interface ConfirmRequest {
  tool: 'create_workflow' | 'amend_workflow' | 'fill_workflow_hole' | 'eval_workflow_snippet' | 'save_workflow'
  name: string
  scriptText: string
  display: WorkflowLaunchDisplay
  settings: { maxConcurrency: number; subagentModel?: string }
  /** Whether "Always allow in this session" is offered and honored (default true; false for `save_workflow` and `eval_workflow_snippet`). */
  allowAlways?: boolean
  /** Literal `world.run` commands declared by a snippet (shown on the confirmation card). */
  commands?: readonly string[]
  /** Target metadata for `save_workflow` confirmations. */
  saveTarget?: { scope: 'project' | 'global'; path: string; description: string; overwrites: boolean }
}

/** The launch a session is being asked to confirm (the Web card reads it over HTTP). */
export interface PendingLaunch {
  tool: ConfirmRequest['tool']
  name: string
  scriptText: string
  display: WorkflowLaunchDisplay
  settings: ConfirmRequest['settings']
  allowAlways?: boolean
  commands?: readonly string[]
  saveTarget?: ConfirmRequest['saveTarget']
  askedAt: number
}

export class LaunchConfirmation {
  private readonly alwaysAllowed = new Set<string>()
  private readonly pending = new Map<string, PendingLaunch>()

  constructor(private readonly ctx: Context, private readonly mode: () => ConfirmMode) {}

  isAlwaysAllowed(agent: Agent): boolean {
    return this.alwaysAllowed.has(agent.id as string)
  }

  /** The launch awaiting confirmation in a session, if any. */
  pendingFor(sessionId: string): PendingLaunch | undefined {
    return this.pending.get(sessionId)
  }

  async confirm(agent: Agent, request: ConfirmRequest, signal: AbortSignal): Promise<ConfirmDecision> {
    const mode = this.mode()
    const allowAlways = request.allowAlways !== false
    if (mode === 'never' || (allowAlways && this.alwaysAllowed.has(agent.id as string))) return { kind: 'allow' }
    const questions = this.ctx.get('userQuestions') as { ask?: (request: unknown) => Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> } | undefined
    if (questions?.ask === undefined) {
      return mode === 'ask-or-allow' ? { kind: 'allow' } : { kind: 'deny' }
    }
    let answer: { answers: { id: string; selected: string[]; custom?: string }[] }
    const sessionId = agent.id as string
    this.pending.set(sessionId, {
      tool: request.tool,
      name: request.name,
      scriptText: request.scriptText,
      display: request.display,
      settings: request.settings,
      ...allowAlways ? {} : { allowAlways: false },
      ...request.commands === undefined ? {} : { commands: request.commands },
      ...request.saveTarget === undefined ? {} : { saveTarget: request.saveTarget },
      askedAt: Date.now(),
    })
    const header = request.tool === 'amend_workflow'
      ? 'Amend workflow'
      : request.tool === 'eval_workflow_snippet'
        ? 'Run workflow snippet'
        : request.tool === 'save_workflow'
          ? 'Save workflow'
          : 'Run workflow'
    const question = request.tool === 'amend_workflow'
      ? `Amend the workflow "${request.name}"?`
      : request.tool === 'eval_workflow_snippet'
        ? `Run workflow snippet with commands (${(request.commands ?? []).join(', ')})?`
        : request.tool === 'save_workflow'
          ? `Save the workflow "${request.name}"?`
          : `Run the workflow "${request.name}"?`
    const options = [
      { label: CONFIRM_LABELS.allow, description: request.tool === 'save_workflow' ? 'Save it once.' : 'Run it once.' },
      ...allowAlways ? [{ label: CONFIRM_LABELS.always, description: 'Do not ask again for workflows in this session.' }] : [],
      { label: CONFIRM_LABELS.deny, description: request.tool === 'save_workflow' ? 'Do not save it.' : 'Do not run it.' },
      ...request.tool === 'save_workflow' ? [] : [{ label: CONFIRM_LABELS.refine, description: 'Do not run it; tell the agent what to change.' }],
    ]
    try {
      answer = await questions.ask({
        agent,
        signal,
        questions: [{
          id: CONFIRM_QUESTION_ID,
          header,
          question,
          detail: renderDetail(request),
          options,
        }],
      })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'NO_PROVIDER' && mode === 'ask-or-allow') return { kind: 'allow' }
      throw error
    } finally {
      this.pending.delete(sessionId)
    }
    const item = answer.answers.find(entry => entry.id === CONFIRM_QUESTION_ID) ?? answer.answers[0]
    const selected = item?.selected[0]
    const custom = item?.custom?.trim()
    const settings = custom?.startsWith(SETTINGS_ANSWER_PREFIX) === true ? parseSettings(custom.slice(SETTINGS_ANSWER_PREFIX.length)) : undefined
    if (selected === CONFIRM_LABELS.always && allowAlways) {
      this.alwaysAllowed.add(agent.id as string)
      return { kind: 'allow', always: true, ...settings === undefined ? {} : { settings } }
    }
    if (selected === CONFIRM_LABELS.allow) return { kind: 'allow', ...settings === undefined ? {} : { settings } }
    if (custom !== undefined && custom.length > 0) return { kind: 'refine', feedback: custom }
    if (selected === CONFIRM_LABELS.refine) return { kind: 'refine', feedback: '' }
    return { kind: 'deny' }
  }
}

/** Validate the settings an Allow answer carries; anything malformed is ignored, never trusted. */
export function parseSettings(text: string): ConfirmSettings | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { maxConcurrency?: unknown; subagentModel?: unknown }
  const out: ConfirmSettings = {}
  if (typeof raw.maxConcurrency === 'number' && Number.isInteger(raw.maxConcurrency) && raw.maxConcurrency >= 1 && raw.maxConcurrency <= 64) out.maxConcurrency = raw.maxConcurrency
  if (raw.subagentModel === null) out.subagentModel = null
  else if (typeof raw.subagentModel === 'string' && /^[^/\s]+\/\S+$/u.test(raw.subagentModel)) out.subagentModel = raw.subagentModel
  return Object.keys(out).length === 0 ? undefined : out
}

function renderDetail(request: ConfirmRequest): string {
  if (request.tool === 'eval_workflow_snippet') {
    const cmds = (request.commands ?? []).map(cmd => `\`${cmd}\``).join(', ')
    return [
      `**Workflow snippet** — executes host commands via \`world.run\`: ${cmds || '(none)'}`,
      '',
      '```ts',
      request.scriptText.trim(),
      '```',
      '',
      'Pick **Refine** or type in **Other** to tell the agent what to change instead of running it.',
    ].join('\n')
  }
  if (request.tool === 'save_workflow' && request.saveTarget !== undefined) {
    const t = request.saveTarget
    return [
      `**${request.name}** (${t.scope}${t.overwrites ? ' — overwrites existing file' : ''})`,
      `Target: \`${t.path}\``,
      ...t.description === '' ? [] : ['', t.description],
      '',
      '```ts',
      request.scriptText.trim(),
      '```',
    ].join('\n')
  }
  const graph = request.display.causalityGraph
  const phases = graph?.phases?.map(phase => phase.name ?? phase.id) ?? []
  const agents = graph?.lanes.filter(lane => lane.id !== 'workspace' && lane.id !== 'unknown').length ?? 0
  const lines = [
    `**${request.name}** — ${phases.length} phase${phases.length === 1 ? '' : 's'}${agents === 0 ? '' : ` · ${agents} subagent${agents === 1 ? '' : 's'}`}`,
    '',
    ...phases.length === 0 ? [] : [phases.map((phase, index) => `${index + 1}. ${phase}`).join('\n'), ''],
    `Max concurrency ${request.settings.maxConcurrency}${request.settings.subagentModel === undefined ? '' : ` · subagents run on ${request.settings.subagentModel}`}`,
    '',
    '```ts',
    request.scriptText.trim(),
    '```',
    '',
    'Pick **Refine** or type in **Other** to send the agent what to change instead of running it.',
  ]
  return lines.join('\n')
}
