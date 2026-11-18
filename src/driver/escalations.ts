/**
 * In-memory registry of parked escalation questions: the one link between the
 * driver (which parks the subagent's `escalate` call) and the run service
 * (which owns `resolve_workflow_question`). Deliberately not persisted — after
 * a process death no deferred is waiting; a resume makes the subagent ask again.
 *
 * Ported from ZCode `bootstrap/src/app/workflow-escalation-registry.ts` (Apache-2.0).
 */

const RETIRED_HISTORY_LIMIT = 256

export interface PendingQuestion {
  qid: string
  /** `refToString` of the asking subagent, e.g. `agent#1@0`. */
  actor: string
  actorName?: string
  question: string
  context?: string
  askedAt: number
}

export interface ParkedQuestionInput extends PendingQuestion {
  runId: string
}

export type ResolveQuestionResult =
  | { ok: true; qid: string }
  | { ok: false; reason: 'already_resolved' | 'run_not_in_flight' | 'unknown_question'; message: string }

export interface EscalationRegistry {
  park(entry: ParkedQuestionInput, settle: (answer: string) => void): void
  isTaken(qid: string): boolean
  withdraw(qid: string): void
  resolve(qid: string, answer: string): ResolveQuestionResult
  pendingFor(runId: string): PendingQuestion[]
  /** Run id of a parked or retired question (for routing a resolve to its run). */
  runOf(qid: string): string | undefined
}

type RetiredReason = 'resolved' | 'withdrawn'

interface Parked extends ParkedQuestionInput {
  settle: (answer: string) => void
}

export function createEscalationRegistry(): EscalationRegistry {
  const parked = new Map<string, Parked>()
  const retired = new Map<string, { reason: RetiredReason; runId: string }>()

  const retire = (qid: string, reason: RetiredReason): void => {
    const entry = parked.get(qid)
    parked.delete(qid)
    retired.set(qid, { reason, runId: entry?.runId ?? '' })
    while (retired.size > RETIRED_HISTORY_LIMIT) {
      const oldest = retired.keys().next()
      if (oldest.done === true) break
      retired.delete(oldest.value)
    }
  }

  return {
    park(entry, settle) {
      parked.set(entry.qid, { ...entry, settle })
    },
    isTaken(qid) {
      return parked.has(qid) || retired.has(qid)
    },
    withdraw(qid) {
      if (!parked.has(qid)) return
      retire(qid, 'withdrawn')
    },
    resolve(qid, answer) {
      const entry = parked.get(qid)
      if (entry === undefined) {
        const reason = retired.get(qid)?.reason
        if (reason === 'resolved') {
          return {
            ok: false,
            reason: 'already_resolved',
            message: `Question ${qid} was already answered and the subagent has moved on with that answer. No need to answer again; if you have more to add, wait for its next escalation.`,
          }
        }
        if (reason === 'withdrawn') {
          return {
            ok: false,
            reason: 'run_not_in_flight',
            message: `The ask that raised question ${qid} is no longer in flight (the run was cancelled, or that ask already failed), so nobody is waiting for this answer. Use get_workflow_run to see the run's current state before deciding what to do next.`,
          }
        }
        return {
          ok: false,
          reason: 'unknown_question',
          message: `Unknown question id ${qid}. It may be misspelled, or it may come from a process that is gone: parked questions are not persisted, so they vanish on restart (a resume makes the subagent ask again under a new id). Use get_workflow_run to read the run's pendingQuestions for the ids that are actually awaiting an answer.`,
        }
      }
      retire(qid, 'resolved')
      entry.settle(answer)
      return { ok: true, qid }
    },
    pendingFor(runId) {
      const out: PendingQuestion[] = []
      for (const entry of parked.values()) {
        if (entry.runId !== runId) continue
        out.push({
          qid: entry.qid,
          actor: entry.actor,
          ...entry.actorName === undefined ? {} : { actorName: entry.actorName },
          question: entry.question,
          ...entry.context === undefined ? {} : { context: entry.context },
          askedAt: entry.askedAt,
        })
      }
      return out
    },
    runOf(qid) {
      return parked.get(qid)?.runId ?? retired.get(qid)?.runId
    },
  }
}
