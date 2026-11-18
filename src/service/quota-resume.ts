/**
 * Auto-resume of runs stopped by an exhausted provider quota, once the quota resets.
 *
 * Port of ZCode `bootstrap/src/app/dynamic-workflow-quota-resume.ts` (Apache-2.0), same rules:
 *
 *   - **The journal row is the only source of truth.** A timer is just a wake-up: on firing it
 *     re-reads the row and resumes only if it is still the same quota stop (same `resetAt`). A
 *     manual resume, an amend (superseded) or a stop for another reason all win.
 *   - **Two entry points**: a cold-start scan (DSH: process-wide, the plugin is process-scoped)
 *     and every run settlement in this process.
 *   - **No loops**: when the provider still refuses after the reset and reports the same (or an
 *     earlier) reset time, the run is not resumed again — only logged.
 *   - **Spacing**: each automatic resume of the same run in this process pushes the next earliest
 *     start (10 min, doubling, capped at 60 min), against a quota stop with a bogus short reset.
 *   - **Bounded retry of transient refusals** (`already_running` or a thrown error): twice, one
 *     margin apart.
 *   - **Never crashes the process**: journal read failures inside timers/listeners only log.
 *
 * DSH difference: resuming needs the owner Agent (the run's parent session). It is resolved
 * through `ctx.agents` / the session controller; when the owner cannot be loaded the attempt is
 * skipped and the next cold-start scan tries again.
 */

import type { RunRecord } from '@zcode/dynamic-workflow'

/** Wait one more minute after the reset: provider windows round to seconds and clocks drift. */
export const QUOTA_RESUME_MARGIN_MS = 60_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const COLD_START_SCAN_LIMIT = 64
export const QUOTA_RESUME_MIN_SPACING_MS = 10 * 60_000
export const QUOTA_RESUME_MAX_SPACING_MS = 60 * 60_000
export const QUOTA_RESUME_RETRY_LIMIT = 2
const LOG_ERROR_MESSAGE_MAX_CHARS = 500

export type QuotaResumeResult = { ok: true } | { ok: false; reason?: string; message?: string }

export interface QuotaAutoResumeDeps {
  journal: {
    getRun(runId: string): RunRecord | undefined
    listRunRows(parentSessionId: string | undefined, limit: number): { runId: string }[]
  }
  subscribeRunSettled(listener: (notice: { runId: string }) => void): () => void
  /** Resume one run through the same path as the UI / tool (owner resolution included). */
  resume(runId: string): Promise<QuotaResumeResult>
  clock?: { now(): number; schedule(callback: () => void, delayMs: number): () => void }
  logger?: { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void }
}

export interface QuotaAutoResume {
  dispose(): void
  /** Armed timers (tests / diagnostics). */
  armed(): string[]
}

/** When a row is a quota stop with a reset time, the moment it should resume; else undefined. */
export function quotaResumeAt(row: Pick<RunRecord, 'status' | 'stopReason' | 'failure'> | undefined): number | undefined {
  if (row?.status !== 'stopped' || row.stopReason !== 'provider') return undefined
  const stop = (row.failure as { providerStop?: { kind?: string; resetAt?: unknown } } | undefined)?.providerStop
  if (stop?.kind !== 'quota' || typeof stop.resetAt !== 'number') return undefined
  return stop.resetAt + QUOTA_RESUME_MARGIN_MS
}

const TRANSIENT_REFUSALS = new Set(['already_running'])

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function startQuotaAutoResume(deps: QuotaAutoResumeDeps): QuotaAutoResume {
  const clock = deps.clock ?? { now: () => Date.now(), schedule: defaultSchedule }
  const timers = new Map<string, () => void>()
  const lastResumedAt = new Map<string, number>()
  const resumeStarts = new Map<string, { at: number; count: number }>()
  let disposed = false

  const readRow = (runId: string): RunRecord | undefined => {
    try {
      return deps.journal.getRun(runId)
    } catch (error) {
      deps.logger?.warn('dynamic-workflow: quota auto-resume could not read run %s: %s', runId, clipped(error))
      return undefined
    }
  }

  const earliestNextStart = (runId: string): number => {
    const previous = resumeStarts.get(runId)
    if (previous === undefined) return Number.NEGATIVE_INFINITY
    return previous.at + Math.min(QUOTA_RESUME_MIN_SPACING_MS * 2 ** (previous.count - 1), QUOTA_RESUME_MAX_SPACING_MS)
  }

  const arm = (runId: string, resumeAt: number): void => {
    const previous = lastResumedAt.get(runId)
    if (previous !== undefined && resumeAt <= previous) {
      deps.logger?.warn('dynamic-workflow: quota auto-resume of %s skipped: the reset time did not move', runId)
      timers.get(runId)?.()
      timers.delete(runId)
      return
    }
    timers.get(runId)?.()
    const startAt = Math.max(resumeAt, earliestNextStart(runId))
    const delayMs = Math.min(Math.max(0, startAt - clock.now()), MAX_TIMER_DELAY_MS)
    timers.set(runId, clock.schedule(() => fire(runId, resumeAt, QUOTA_RESUME_RETRY_LIMIT), delayMs))
    deps.logger?.info('dynamic-workflow: run %s will auto-resume after its quota resets (%s)', runId, new Date(startAt).toISOString())
  }

  const retryLater = (runId: string, resumeAt: number, retriesLeft: number): void => {
    if (disposed || timers.has(runId)) return
    if (retriesLeft <= 0) {
      deps.logger?.warn('dynamic-workflow: quota auto-resume of %s gave up after retries', runId)
      return
    }
    timers.set(runId, clock.schedule(() => fire(runId, resumeAt, retriesLeft - 1), QUOTA_RESUME_MARGIN_MS))
  }

  const fire = (runId: string, expectedAt: number, retriesLeft: number): void => {
    timers.delete(runId)
    if (disposed) return
    const resumeAt = quotaResumeAt(readRow(runId))
    if (resumeAt === undefined) return
    if (resumeAt !== expectedAt || resumeAt > clock.now()) {
      arm(runId, resumeAt)
      return
    }
    lastResumedAt.set(runId, resumeAt)
    resumeStarts.set(runId, { at: clock.now(), count: (resumeStarts.get(runId)?.count ?? 0) + 1 })
    deps.logger?.info('dynamic-workflow: run %s auto-resuming after its quota reset', runId)
    void Promise.resolve()
      .then(() => deps.resume(runId))
      .then(
        (result) => {
          if (result.ok) return
          deps.logger?.warn('dynamic-workflow: quota auto-resume of %s was refused: %s', runId, result.reason ?? result.message ?? 'unknown')
          if (result.reason !== undefined && TRANSIENT_REFUSALS.has(result.reason)) retryLater(runId, resumeAt, retriesLeft)
        },
        (error: unknown) => {
          deps.logger?.warn('dynamic-workflow: quota auto-resume of %s failed: %s', runId, clipped(error))
          retryLater(runId, resumeAt, retriesLeft)
        },
      )
  }

  const consider = (runId: string, row: RunRecord | undefined): void => {
    const resumeAt = quotaResumeAt(row)
    if (resumeAt !== undefined) arm(runId, resumeAt)
  }

  const unsubscribe = deps.subscribeRunSettled(({ runId }) => {
    if (!disposed) consider(runId, readRow(runId))
  })

  try {
    for (const row of deps.journal.listRunRows(undefined, COLD_START_SCAN_LIMIT)) consider(row.runId, readRow(row.runId))
  } catch (error) {
    deps.logger?.warn('dynamic-workflow: quota auto-resume scan failed: %s', clipped(error))
  }

  return {
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      for (const cancel of timers.values()) cancel()
      timers.clear()
    },
    armed: () => [...timers.keys()],
  }
}

function clipped(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > LOG_ERROR_MESSAGE_MAX_CHARS ? `${message.slice(0, LOG_ERROR_MESSAGE_MAX_CHARS)}…` : message
}
