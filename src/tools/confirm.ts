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
  tool: 'create_workflow' | 'amend_workflow' | 'fill_workflow_hole'
  name: string
  scriptText: string
  display: WorkflowLaunchDisplay
  settings: { maxConcurrency: number; subagentModel?: string }
}

/** The launch a session is being asked to confirm (the Web card reads it over HTTP). */
export interface PendingLaunch {
  tool: ConfirmRequest['tool']
  name: string
  scriptText: string
  display: WorkflowLaunchDisplay
  settings: ConfirmRequest['settings']
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
    if (mode === 'never' || this.alwaysAllowed.has(agent.id as string)) return { kind: 'allow' }
    const questions = this.ctx.get('userQuestions') as { ask?: (request: unknown) => Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> } | undefined
    if (questions?.ask === undefined) {
      return mode === 'ask-or-allow' ? { kind: 'allow' } : { kind: 'deny' }
    }
    let answer: { answers: { id: string; selected: string[]; custom?: string }[] }
    const sessionId = agent.id as string
    this.pending.set(sessionId, { tool: request.tool, name: request.name, scriptText: request.scriptText, display: request.display, settings: request.settings, askedAt: Date.now() })
    try {
      answer = await questions.ask({
        agent,
        signal,
        questions: [{
          id: CONFIRM_QUESTION_ID,
          header: request.tool === 'amend_workflow' ? 'Amend workflow' : 'Run workflow',
          question: request.tool === 'amend_workflow' ? `Amend the workflow "${request.name}"?` : `Run the workflow "${request.name}"?`,
          detail: renderDetail(request),
          options: [
            { label: CONFIRM_LABELS.allow, description: 'Run it once.' },
            { label: CONFIRM_LABELS.always, description: 'Do not ask again for workflows in this session.' },
            { label: CONFIRM_LABELS.deny, description: 'Do not run it.' },
            { label: CONFIRM_LABELS.refine, description: 'Do not run it; tell the agent what to change.' },
          ],
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
    if (selected === CONFIRM_LABELS.always) {
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
