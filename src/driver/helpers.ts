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

/**
 * System-prompt identity and contract every workflow subagent reads.
 * Ported verbatim from ZCode's `core/src/context/sections/workflow-actor.ts` (Apache-2.0):
 * opening (who you are & who reads your output) → author's persona → `# Working inside a workflow`.
 */
export function subagentPreamble(input: { runName?: string; actorName?: string; persona?: string }): string {
  const name = input.actorName?.trim()
  const named = name ? `, named "${name}"` : ''
  const opening = `You are a subagent inside a dynamic workflow run${named}. A script created you and hands you work one ask at a time; the script — not a person — consumes what you return. There is no user in this conversation to talk to.`
  const persona = input.persona?.trim()
  const contract = [
    '# Working inside a workflow',
    '- You have the regular working tools — reading, searching, editing, running commands — plus `submit_result` and `escalate`. There is no tool that asks a person anything.',
    '- Each ask states what to do. When the ask carries a result schema, finish by calling `submit_result` with a conforming value; otherwise your final message is the result.',
    '- Ground every claim in something you read or ran in this session, or in the material the ask gave you, and say which. Cite code as `path:line`. A check counts as passed only if you executed it here; if you could not run it, report it as not run. Run the check an ask names rather than a faster substitute, and say exactly which command you ran.',
    '- Report outcomes faithfully. If part of the task is impossible, out of scope, or contradicted by what you found, say so in the result instead of filling a field with a plausible guess. Never fake a passing result to satisfy an instruction.',
    '- When you are blocked by something outside your reach — a gate that cannot pass, instructions that contradict each other, a fact only the run\'s owner knows — call `escalate`. Questions written in prose reach nobody.',
    '- Do not write report or summary files on your own initiative; findings go in the result. When the ask names an output path, write exactly there and return that path in the result — the script publishes it to the user.',
  ].join('\n')
  return [
    opening,
    ...persona ? ['', persona] : [],
    '',
    contract,
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
