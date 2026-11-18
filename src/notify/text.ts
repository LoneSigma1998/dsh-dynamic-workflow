/**
 * Every sentence the main agent reads about a run: the terminal
 * `<task-notification>`, the mid-run `<workflow-escalation>` / `<workflow-hole>` /
 * `<workflow-stall>` notices, the `<workflow-blocked>` reminder, and the
 * provider-stop `<error>` block. Ported from ZCode
 * `core/src/runtime-task/notification.ts` and `workflow-notification-copy.ts`
 * (Apache-2.0) with DSH tool names.
 */

import type { ProviderStopDetails, RunStatus, RunStopReason } from '@zcode/dynamic-workflow'
import type { PendingQuestion } from '../driver/escalations.ts'

export const TASK_NOTIFICATION_MAX_CHARS = 120_000

export function truncateTaskNotification(value: string): string {
  if (value.length <= TASK_NOTIFICATION_MAX_CHARS) return value
  return `${value.slice(0, TASK_NOTIFICATION_MAX_CHARS)}\n[truncated]`
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/gu, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '\'': '&apos;', '"': '&quot;' })[char] ?? char)
}

function escapeXmlText(value: string): string {
  return value.replace(/[<>&]/gu, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char] ?? char)
}

const SYSTEM_NOTIFICATION_BANNER = [
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  'This is an automated workflow event, NOT a message from the user.',
  'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.',
  '',
] as const

export interface RunFailure {
  code?: string
  message: string
  providerStop?: ProviderStopDetails
}

export interface TerminalNotificationInput {
  runId: string
  toolCallId?: string
  name: string
  status: Extract<RunStatus, 'completed' | 'errored' | 'stopped'>
  stopReason?: RunStopReason
  result?: string
  failure?: RunFailure
  reports?: { count: number; shown: number; preview: string }
  artifacts?: { count: number; shown: number; preview: string }
  scriptPath?: string
  durationMs?: number
  spentTokens?: number
}

export function formatTerminalNotification(input: TerminalNotificationInput): string {
  const lines = ['<task-notification>', `<task-id>${escapeXml(input.runId)}</task-id>`]
  if (input.toolCallId !== undefined) lines.push(`<tool-use-id>${escapeXml(input.toolCallId)}</tool-use-id>`)
  lines.push(`<status>${escapeXml(input.status)}</status>`)
  if (input.stopReason !== undefined) lines.push(`<stop-reason>${escapeXml(input.stopReason)}</stop-reason>`)
  lines.push(`<description>${escapeXml(input.name)}</description>`)
  lines.push(`<summary>${escapeXml(summaryOf(input))}</summary>`)
  if (input.result !== undefined) lines.push(`<result>${escapeXml(input.result)}</result>`)
  const providerStop = input.failure?.providerStop === undefined ? undefined : formatProviderStopError(input.failure, input.runId)
  if (providerStop !== undefined) lines.push(`<error>\n${escapeXmlText(providerStop)}\n</error>`)
  else if (input.failure !== undefined) lines.push(`<error>${escapeXml(input.failure.message)}</error>`)
  if (input.reports !== undefined) {
    const shown = input.reports.shown < input.reports.count ? ` shown="${input.reports.shown}"` : ''
    lines.push(`<reports count="${input.reports.count}"${shown}>`, escapeXml(input.reports.preview), '</reports>')
  }
  if (input.artifacts !== undefined) {
    const shown = input.artifacts.shown < input.artifacts.count ? ` shown="${input.artifacts.shown}"` : ''
    lines.push(`<artifacts count="${input.artifacts.count}"${shown}>`, escapeXml(input.artifacts.preview), '</artifacts>')
  }
  const usage: string[] = []
  if (input.spentTokens !== undefined) usage.push(`<total-tokens>${input.spentTokens}</total-tokens>`)
  if (input.durationMs !== undefined) usage.push(`<duration-ms>${Math.round(input.durationMs)}</duration-ms>`)
  if (usage.length > 0) lines.push(`<usage>${usage.join('')}</usage>`)
  lines.push('</task-notification>', '', deliveryGuidance(input))
  return truncateTaskNotification(lines.join('\n'))
}

function summaryOf(input: TerminalNotificationInput): string {
  switch (input.status) {
    case 'completed': return `Workflow "${input.name}" completed.`
    case 'errored': return `Workflow "${input.name}" failed.`
    default: return `Workflow "${input.name}" stopped (${input.stopReason ?? 'unknown reason'}).`
  }
}

function deliveryGuidance(input: TerminalNotificationInput): string {
  const { status, stopReason, scriptPath, runId } = input
  const hasArtifacts = input.artifacts !== undefined
  const artifactsSentence = hasArtifacts
    ? ['Artifacts listed above are already in front of the user as cards; refer to them by title and do not paste their contents. The one marked primary is the deliverable: point the user to it first.']
    : []
  const artifactsShort = hasArtifacts ? ['Artifacts listed above are already in front of the user.'] : []
  if (status === 'completed') {
    return [
      'The workflow completed. Present its outcome to the user as a deliverable, in this order: the conclusion; each finding with its evidence (path and line, or the command and output that showed it); which findings were confirmed by a deterministic check or an independent subagent and which are judged only; what the run did not cover.',
      'The reported items above are individual findings: present them individually and keep their evidence. When the preview is partial (count greater than shown), say so and read the rest with get_workflow_run.',
      ...artifactsSentence,
      'Do not restate the phase graph or the script.',
    ].join('\n')
  }
  if (stopReason === 'user') {
    return [
      'The user stopped this workflow on purpose. Do not resume it with resume_workflow_run and do not amend or rebuild it unless the user asks you to.',
      'Present what it finished before it was stopped: the reported items above are finished findings — show them individually with their evidence. Then stop and wait for the user to say what happens next.',
      ...artifactsShort,
    ].join('\n')
  }
  if (stopReason === 'model') {
    return [
      `You stopped this workflow with stop_workflow_run. If you stopped it to fix the script, do that now: call amend_workflow with this run's ID and the corrected script — everything that settled before the stop is imported as cache. (Next time, amend the running run directly: amend_workflow stops it for you.)${scriptPath === undefined ? '' : ` Its script is at ${scriptPath}: edit that file and pass \`path\`.`}`,
      'Otherwise present what it finished: the reported items above are finished findings — show them individually with their evidence. Resume it unchanged only if that is what the user wants.',
      ...artifactsShort,
    ].join('\n')
  }
  if (stopReason === 'provider') {
    const autoResume = input.failure?.providerStop?.kind === 'quota' && input.failure.providerStop.resetAt !== undefined
    return [
      'A provider-side error stopped this run; the <error> block above names the cause and the fix. Present what the run finished: the reported items above are finished findings — show them individually with their evidence.',
      autoResume
        ? 'The run resumes by itself after the usage cap resets (the <error> block says when): tell the user, and do not call resume_workflow_run or rebuild the workflow before then.'
        : `Then resolve the cause with the user before calling resume_workflow_run with run_id="${runId}" — finished steps replay from the journal. Do not rebuild the workflow.`,
      ...artifactsShort,
    ].join('\n')
  }
  if (stopReason === 'interrupted') {
    return [
      'The process that owned this run exited before it finished. Present what it finished: the reported items above are finished findings — show them individually with their evidence.',
      `Then call resume_workflow_run with run_id="${runId}" — finished steps replay from the journal and only the unfinished ones run again.`,
      ...artifactsShort,
    ].join('\n')
  }
  if (stopReason === 'superseded') {
    return [
      'This run was stopped because you amended it: a newer run supersedes it and is already running. Do not resume this run and do not amend it again; wait for the successor\'s notification.',
      ...artifactsShort,
    ].join('\n')
  }
  if (status === 'stopped') {
    return [
      'This workflow was stopped before it finished. Present what it salvaged first: the reported items above are finished findings — show them individually with their evidence.',
      `It can be continued with resume_workflow_run (run_id="${runId}"); ask the user before resuming a run you did not stop yourself.`,
      ...artifactsShort,
    ].join('\n')
  }
  return [
    'The workflow script failed. Present what it salvaged first: the reported items above are finished findings — show them individually with their evidence. Then explain the failure and what it means for the user\'s request.',
    ...artifactsShort,
    scriptPath === undefined
      ? `Fix the script and submit it with amend_workflow (run_id="${runId}") so finished work is reused. resume_workflow_run will refuse this run: replaying the same script would fail the same way.`
      : `The run's script is at ${scriptPath}. Edit that file in place, then call amend_workflow (run_id="${runId}", path="${scriptPath}") so finished work is reused — do not paste the script inline. resume_workflow_run will refuse this run: replaying the same script would fail the same way.`,
  ].join('\n')
}

export function formatProviderStopError(failure: RunFailure, runId: string): string {
  const details = failure.providerStop
  if (details === undefined) return failure.message
  const provider = details.providerLabel ?? details.providerId ?? 'the provider'
  const subagent = details.subagentName ?? details.subagent ?? 'a subagent'
  const phase = details.phase === undefined ? '' : ` (phase "${details.phase}")`
  const model = details.modelId ?? 'the current model'
  const code = details.providerCode ?? details.reason
  const resume = `then call resume_workflow_run with run_id="${runId}"`
  const sentences = ((): [string, string] => {
    switch (details.kind) {
      case 'auth':
        return [`Authentication with ${provider} failed while subagent ${subagent}${phase} was running.`, `Ask the user to fix the credentials for ${provider}, ${resume}. Finished steps are kept.`]
      case 'not_configured':
        return [`Provider ${details.providerId ?? provider} is not configured, so subagent ${subagent}${phase} could not send its request.`, `Ask the user to configure the provider or switch this session to another model, ${resume}.`]
      case 'model_unavailable':
        return [`Model ${model} is not available on ${provider}.`, `Ask the user to switch this session to an available model, ${resume}. Subagents follow the session's model.`]
      case 'invalid_request':
        return [`${provider} rejected subagent ${subagent}${phase}'s request as invalid (code ${code}).`, `Switching the session to another model usually clears this; ${resume}. If it stops again with the same code, show the raw message to the user.`]
      case 'quota':
        return details.resetAt === undefined
          ? [`${provider} reports the user's quota is exhausted (code ${code}).`, `Ask the user to top up or switch to another provider, ${resume}.`]
          : [`${provider} reports the user's usage cap is reached (code ${code}); it resets at ${new Date(details.resetAt).toISOString()}.`, 'DSH resumes this run by itself a minute after the reset while this session is loaded. Tell the user; do not call resume_workflow_run before the reset, and do not rebuild the workflow.']
      default:
        return [`${provider} refused subagent ${subagent}${phase}'s request with a permanent error (code ${code}).`, `Resolve it with the user (the raw message below says what the provider wants), ${resume}.`]
    }
  })()
  const facts = [
    `provider=${details.providerId ?? 'unknown'}`,
    `model=${details.modelId ?? 'unknown'}`,
    `subagent=${details.subagent ?? 'unknown'}`,
    ...details.phase === undefined ? [] : [`phase=${details.phase}`],
    `code=${code}`,
  ].join(' ')
  return [sentences[0], sentences[1], facts, ...details.rawMessage === undefined ? [] : [`raw: ${details.rawMessage}`]].join('\n')
}

export function formatEscalationNotification(input: { runLabel: string; runId: string; qid: string; actor: string; question: string; context?: string }): string {
  const lines = [
    ...SYSTEM_NOTIFICATION_BANNER,
    '<workflow-escalation>',
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <question-id>${escapeXml(input.qid)}</question-id>`,
    `  <subagent>${escapeXml(input.actor)}</subagent>`,
    `  <question>${escapeXml(input.question)}</question>`,
  ]
  if (input.context !== undefined && input.context.length > 0) lines.push(`  <context>${escapeXml(input.context)}</context>`)
  lines.push(
    '</workflow-escalation>',
    '',
    `Subagent ${input.actor} in workflow run ${input.runLabel} (${input.runId}) escalated a blocking question and is parked on that call waiting for your answer.`,
    `Next step: call resolve_workflow_question with question_id="${input.qid}" and your answer.`,
    'The run is still running: only the subagent that asked is parked — every other subagent and the script\'s control flow keep going. So do not drop what you are doing, but do not leave it unanswered either: nothing times out on its behalf.',
    'If this notification is ever lost, get_workflow_run lists the questions this run still owes an answer to.',
  )
  return truncateTaskNotification(lines.join('\n'))
}

export function formatHoleNotification(input: { runLabel: string; runId: string; holeId: string; name: string; type: string; prompt?: string; draftPath?: string; line?: number }): string {
  const lines = [
    ...SYSTEM_NOTIFICATION_BANNER,
    '<workflow-hole>',
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <hole-id>${escapeXml(input.holeId)}</hole-id>`,
    `  <name>${escapeXml(input.name)}</name>`,
    `  <type>${escapeXml(input.type)}</type>`,
  ]
  if (input.prompt !== undefined && input.prompt.length > 0) lines.push(`  <prompt>${escapeXml(input.prompt)}</prompt>`)
  if (input.draftPath !== undefined) lines.push(`  <draft>${escapeXml(input.draftPath)}</draft>`)
  if (input.line !== undefined) lines.push(`  <line>${input.line}</line>`)
  const draft = input.draftPath === undefined
    ? 'Read the run\'s script with get_workflow_run for the context'
    : `Read the draft at ${input.draftPath}${input.line === undefined ? '' : ` (the hole is on line ${input.line})`} for the context`
  lines.push(
    '</workflow-hole>',
    '',
    `Workflow run ${input.runLabel} (${input.runId}) reached the hole "${input.name}" (${input.holeId}) and is waiting for you to write its body.`,
    `Next step: ${draft}, write the statements of the hole's function, and call fill_workflow_hole with run_id="${input.runId}" and hole_id="${input.holeId}" and the body as \`script\`.`,
    `The body is compiled where the hole stands and sees every binding declared before it; it must return a value of type \`${input.type}\` — or, when the next step is not known yet, do one step and end with a new tail hole of the same type named for the next step (\`return await hole<${input.type}>("…", …)\`); the last fill returns. Write only the statements — not the hole call, not an arrow, not the script around it.`,
    'Only this branch of the script is parked — every other subagent and the rest of the control flow keep going. So do not drop what you are doing, but do not leave it unfilled either: nothing times out on its behalf.',
    'If this notification is ever lost, get_workflow_run lists the holes this run is still waiting at.',
  )
  return truncateTaskNotification(lines.join('\n'))
}

export function formatStallNotification(input: { runLabel: string; runId: string; sinceMs: number; reason?: string; cap?: number }): string {
  const minutes = Math.max(1, Math.round(input.sinceMs / 60_000))
  const lines = [
    ...SYSTEM_NOTIFICATION_BANNER,
    '<workflow-stall>',
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <since-ms>${Math.max(0, Math.floor(input.sinceMs))}</since-ms>`,
  ]
  if (input.reason !== undefined) lines.push(`  <dominant-reason>${escapeXml(input.reason)}</dominant-reason>`)
  if (input.cap !== undefined) lines.push(`  <cap>${input.cap}</cap>`)
  lines.push(
    '</workflow-stall>',
    '',
    `Workflow run ${input.runLabel} (${input.runId}) has not completed a model request in ${minutes} minutes; ${input.reason === undefined ? 'the provider keeps failing requests' : `the provider keeps answering ${input.reason}`} and the run is retrying with backoff${input.cap === undefined ? '' : ` (current fan-out ${input.cap})`}.`,
    'It is still running and needs nothing from you. Tell the user if they are waiting on it; they can stop it from the run card. Do not cancel or rebuild it on your own.',
  )
  return truncateTaskNotification(lines.join('\n'))
}

export interface OpenHole { siteId: string; name: string; type: string; line?: number; since?: number }

/**
 * The turn-boundary reminder (DSH enhancement): sent once when the main agent
 * tries to end a turn while a run it owns still waits on it.
 */
export function formatBlockedNotification(input: { runLabel: string; runId: string; now: number; questions: readonly PendingQuestion[]; holes: readonly OpenHole[]; draftPath?: string }): string {
  const { questions, holes, now, runId } = input
  const waited = (since: number | undefined): number => (since === undefined ? 0 : Math.max(0, Math.floor(now - since)))
  const lines: string[] = [
    ...SYSTEM_NOTIFICATION_BANNER,
    '<workflow-blocked>',
    `  <run-id>${escapeXml(runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
  ]
  if (questions.length > 0) {
    lines.push(`  <open-questions count="${questions.length}">`)
    for (const question of questions.slice(0, 8)) {
      lines.push(`    <question id="${escapeXml(question.qid)}" subagent="${escapeXml(question.actorName ?? question.actor)}" waited-ms="${waited(question.askedAt)}">`,
        `      <text>${escapeXml(question.question.slice(0, 2000))}</text>`, '    </question>')
    }
    lines.push('  </open-questions>')
  }
  if (holes.length > 0) {
    lines.push(`  <open-holes count="${holes.length}">`)
    for (const hole of holes.slice(0, 8)) {
      lines.push(`    <hole id="${escapeXml(hole.siteId)}" name="${escapeXml(hole.name)}" type="${escapeXml(hole.type)}"${hole.line === undefined ? '' : ` line="${hole.line}"`} waited-ms="${waited(hole.since)}"/>`)
    }
    lines.push('  </open-holes>')
  }
  if (input.draftPath !== undefined) lines.push(`  <draft>${escapeXml(input.draftPath)}</draft>`)
  lines.push('</workflow-blocked>', '',
    `You are about to end your turn, but workflow run ${input.runLabel} (${runId}) is still waiting on you.`)
  if (questions.length > 0) lines.push('For each question: call resolve_workflow_question with its id as question_id and your answer.')
  if (holes.length > 0) lines.push(`For each hole: read the script for the context, write only the statements of the hole's function returning its type, and call fill_workflow_hole with run_id="${runId}" and its id as hole_id.`)
  lines.push('If a decision needs the user, tell the user exactly what you need from them and end your turn; do not guess an answer. Nothing times out on the run\'s behalf.')
  return truncateTaskNotification(lines.join('\n'))
}
