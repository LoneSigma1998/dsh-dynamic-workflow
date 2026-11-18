/**
 * Pure helpers for the DSH workflow driver: ids, epilogues, prompts and small
 * value conversions. Text constants are ported from ZCode's
 * `bootstrap/src/app/workflow-driver-helpers.ts` and `workflow-ask-epilogue.ts`
 * (Apache-2.0) with the tool names adapted to DSH.
 */

import { refToString, WorkflowError, type ActorRef, type PersonaSpec } from '@zcode/dynamic-workflow'

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Fold any string into `[A-Za-z0-9.-_]` where `_` only appears as an escape:
 * first `_` → `__`, then every other character outside the safe set → `_`.
 */
export function sanitizeIdSegment(value: string): string {
  return value.replace(/_/g, '__').replace(/[^A-Za-z0-9.-]/g, '_')
}

/** Deterministic child session id for one subagent of one run. */
export function mintActorSessionId(runId: string, actor: ActorRef): string {
  return `dwf-${sanitizeIdSegment(runId)}-${sanitizeIdSegment(refToString(actor))}`
}

/** The subagent's effective name (the engine's normalized persona name). */
export function effectiveActorName(persona: PersonaSpec): string | undefined {
  const name = persona.name
  return name === undefined || name === '' ? undefined : name
}

export function subagentLabel(actor: ActorRef, name: string | undefined): string {
  return name ?? refToString(actor)
}

/** At most this many escalations per ask; the next call is refused (not an error). */
export const MAX_ESCALATIONS_PER_ASK = 3

export const ESCALATION_BUDGET_EXHAUSTED
  = `Escalation budget exhausted: at most ${MAX_ESCALATIONS_PER_ASK} escalations per task. `
    + 'Do not call escalate again. Proceed on your best judgement with the information you have, '
    + 'and state in your final result the assumptions you relied on and the doubts that remain.'

export const NUDGE_PROMPT
  = 'You ended your turn without submitting a result. Call the submit_result tool now with a payload conforming to the required schema.'

export const TRANSIENT_CONTINUE_PROMPT
  = 'The previous model request failed transiently and was abandoned; continue from where you left off.'

/** Schema epilogue for a typed ask on a `generic` subagent. */
export function schemaEpilogue(schema: unknown): string {
  const rendered = schema === undefined ? '(any JSON value)' : JSON.stringify(schema, null, 2)
  return [
    '',
    '',
    '---',
    'When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must be a JSON value conforming to this JSON Schema:',
    '',
    rendered,
    '',
    'Pass the conforming JSON as the `result` argument — do not wrap it or add commentary.',
  ].join('\n')
}

/** Typed-ask epilogue for a `mono` subagent: the schema already rides the tool declaration. */
export const TYPED_TOOL_EPILOGUE = [
  '',
  '',
  '---',
  'When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must match the tool\'s declared schema — pass the conforming JSON directly, do not wrap it or add commentary.',
].join('\n')

/** Quality epilogue appended to every ask (after the input hash is computed). */
export function qualityEpilogue(schema: unknown): string {
  const fields = topLevelSchemaProperties(schema)
  return [
    '',
    '',
    '---',
    'Standard for this result:',
    '- Every finding cites what you read or ran: path and line for code; the exact command and its output for a check; the part of the ask for material the ask itself gave you.',
    '- A check counts as passed only if you ran it during this ask. Otherwise report it as not run.',
    '- Run the check the ask names, at the scale it names. A narrower or faster substitute — one test file for the suite, a build for the tests — is reported as what it is, never as the ask\'s check; say the exact command you ran.',
    '- Anything you could not do, verify, or find is stated as such — never filled with a plausible guess.',
    ...fields.has('evidence') ? ['- Put each finding\'s citation in its `evidence` field.'] : [],
    ...fields.has('confidence') ? ['- Rate `confidence` honestly; a low value with a reason beats a confident guess.'] : [],
    '- If you are blocked by something outside your reach, call `escalate` instead of inventing a value.',
  ].join('\n')
}

function topLevelSchemaProperties(schema: unknown): Set<string> {
  if (typeof schema !== 'object' || schema === null) return new Set()
  const properties = (schema as { properties?: unknown }).properties
  if (typeof properties !== 'object' || properties === null) return new Set()
  return new Set(Object.keys(properties as Record<string, unknown>))
}

/** System-prompt preamble every workflow subagent reads (DSH counterpart of ZCode's engine persona). */
export function subagentPreamble(input: { runName?: string; actorName?: string }): string {
  const who = input.actorName === undefined ? 'a subagent' : `the subagent "${input.actorName}"`
  const run = input.runName === undefined ? 'a dynamic workflow' : `the dynamic workflow "${input.runName}"`
  return [
    `You are ${who} in ${run}: a script written by the main agent hands you tasks one at a time and reads your answers.`,
    'Each user message in this conversation is one task. Work it to completion with your tools, then answer.',
    'When a task has a typed result, you MUST finish by calling `submit_result` with a value that matches the schema; plain text does not count as the result of a typed task.',
    'Your results are read by the user, in their language. Be concrete: cite files with path and line, commands with their real output.',
    'You cannot ask the user anything directly. If something outside your reach blocks you, call `escalate` with one focused question.',
  ].join('\n')
}

/** Normalize anything thrown by a child turn into a node-level WorkflowError. */
export function toWorkflowError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new WorkflowError('DriverError', `Subagent turn failed: ${message}`, { cause: error })
}

const TRANSIENT_BACKOFF_BASE_MS = 2_000
const TRANSIENT_BACKOFF_MAX_MS = 60_000

/** 2s doubling to 60s, jittered into [0.5, 1]. */
export function transientBackoffMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(TRANSIENT_BACKOFF_MAX_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** (attempt - 1))
  return Math.round(raw * (0.5 + 0.5 * random()))
}

/** Candidate qid fragments: 8, 16, then all characters of the run id body. */
export function questionIdFragments(runId: string): string[] {
  const body = runId.startsWith('dwfrun-') ? runId.slice('dwfrun-'.length) : runId
  const full = sanitizeIdSegment(body)
  return [...new Set([full.slice(0, 8), full.slice(0, 16), full])]
}

export function normalizeEscalationContext(context: string | undefined): string | undefined {
  const trimmed = context?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/** Short human target for a tool call: a path for file tools, the head of a command for shells. */
export function toolTarget(name: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
  }
  const raw = /bash|pwsh|shell|terminal|command/i.test(name)
    ? pick('command', 'cmd', 'script')
    : pick('path', 'file_path', 'filePath', 'file', 'pattern', 'url', 'query')
  if (raw === undefined) return undefined
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine
}
