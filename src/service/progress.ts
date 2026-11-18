/**
 * RunEvent → progress envelope, the shape ZCode's shared run-state reducer
 * (`src/shared/runs/workflow-runs-reducer.ts`, ported verbatim) folds. Ported
 * from ZCode `bootstrap/src/app/dynamic-workflow-run-progress-payload.ts`
 * (Apache-2.0): the payload is the engine event minus `type`, bounded, plus a
 * few host-derived fields kept outside the engine's own words.
 *
 * The envelope is appended to the owning session as a log-only
 * `dynamic-workflow/progress` event — DSH's durable, replayable channel to the
 * Web client — and folded by the `dynamicWorkflowRuns` session projection.
 */

import { refToString, type ActorRef, type RunEvent } from '@zcode/dynamic-workflow'
import { mintActorSessionId } from '../driver/helpers.ts'

export interface ProgressPayload {
  runId: string
  toolCallId?: string
  sequence: number
  eventType: string
  payload: Record<string, unknown>
  truncated?: true
  actorSessionId?: string
  /** Journal timestamp (epoch ms) of the event. */
  at: number
}

const MAX_TEXT = 4000
const MAX_STRUCTURED = 8000

function bound(value: unknown, max: number): { value: unknown; cut: boolean } {
  if (typeof value === 'string') return value.length > max ? { value: `${value.slice(0, max - 1)}…`, cut: true } : { value, cut: false }
  if (value === undefined || value === null || typeof value !== 'object') return { value, cut: false }
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    return { value: String(value).slice(0, max), cut: true }
  }
  if (text === undefined || text.length <= max) return { value, cut: false }
  return { value: `${text.slice(0, max - 1)}…`, cut: true }
}

function boundPayload(rest: Record<string, unknown>): { payload: Record<string, unknown>; truncated: boolean } {
  let truncated = false
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    const max = typeof value === 'string' ? MAX_TEXT : MAX_STRUCTURED
    const { value: next, cut } = bound(value, max)
    payload[key] = next
    if (cut) truncated = true
  }
  return { payload, truncated }
}

function isResumableSettlement(status: string, stopReason: string | undefined): boolean {
  return status === 'stopped' && stopReason !== 'superseded'
}

function actorRefOf(event: RunEvent): ActorRef | undefined {
  if (event.type === 'actor-created') return event.actor
  if (event.type === 'node-dispatched' && event.kind === 'ask') return event.actor
  if (event.type === 'node-settled' && event.cached === true && event.kind === 'ask') return event.actor
  return undefined
}

export function toProgressPayload(input: {
  runId: string
  event: RunEvent
  sequence: number
  at: number
  toolCallId?: string
  resumedFrom?: string
  concurrencyCeiling?: number
  subagentModel?: string
  modelBindings?: Record<string, string>
  holeTypeOf?: (siteId: string) => string | undefined
}): ProgressPayload | undefined {
  const { event } = input
  if (event.type === 'compaction') return undefined
  const { type, ...rest } = event as RunEvent & Record<string, unknown>
  const bounded = boundPayload(rest as Record<string, unknown>)
  let payload = bounded.payload
  const withModel = (key: 'model' | 'actorModel', personaModel: string | undefined): Record<string, unknown> => {
    const model = personaModel === undefined ? undefined : input.modelBindings?.[personaModel]
    return model === undefined ? payload : { ...payload, [key]: model }
  }
  switch (event.type) {
    case 'run-settled':
      if (isResumableSettlement(event.status, event.stopReason)) payload = { ...payload, resumable: true }
      break
    case 'run-started':
      payload = {
        ...payload,
        ...input.resumedFrom === undefined ? {} : { resumedFrom: input.resumedFrom },
        ...input.concurrencyCeiling === undefined ? {} : { concurrencyCeiling: input.concurrencyCeiling },
        ...input.subagentModel === undefined ? {} : { subagentModel: input.subagentModel },
      }
      break
    case 'run-caps-changed':
      payload = { ...payload, ...input.concurrencyCeiling === undefined ? {} : { concurrencyCeiling: input.concurrencyCeiling } }
      break
    case 'actor-created':
      payload = withModel('model', event.persona?.model)
      break
    case 'node-dispatched':
      payload = withModel('actorModel', event.actorPersonaModel)
      break
    case 'hole-reached': {
      const holeType = input.holeTypeOf?.(event.instance.siteId)
      payload = { ...payload, ...holeType === undefined ? {} : { type: holeType }, reachedAt: input.at }
      break
    }
    default:
  }
  const actor = actorRefOf(event)
  return {
    runId: input.runId,
    ...input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId },
    sequence: input.sequence,
    eventType: type,
    payload,
    ...bounded.truncated ? { truncated: true as const } : {},
    ...actor === undefined ? {} : { actorSessionId: mintActorSessionId(input.runId, actor) },
    at: input.at,
  }
}

export { refToString }
