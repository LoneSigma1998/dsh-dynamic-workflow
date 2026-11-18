/**
 * Process-wide adaptive concurrency governor (ZCode `workflow-concurrency-governor.ts`,
 * rebuilt on DSH's `llm/stream` waterfall). DSH has no global model-request
 * limiter; a 30-way fan-out against one provider otherwise hits 429s in a
 * burst and every child backs off on its own.
 *
 * One AIMD `ConcurrencyController` (vendored from ZCode) per `provider/model`
 * bucket. Requests of workflow subagents (session ids `dwf-…`) take a ticket per
 * model-request attempt and queue FIFO when the bucket is full; every other
 * request (the main agent, ordinary subagents) is an observer: never queued,
 * but counted in flight and feeding the controller with its outcome. A 429 /
 * overloaded failure cuts the cap (once per epoch); four clean successes in a
 * row with demand waiting raise it by one; Retry-After freezes new admissions.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ConcurrencyController, type ConcurrencyChange } from '@zcode/dynamic-workflow'
import { isChineseQuotaText } from '../driver/model-failure.ts'

interface Waiter {
  /** Resolved with the admission epoch: the governor admits on the waiter's behalf, synchronously. */
  resolve: (epoch: number) => void
  reject: (error: unknown) => void
}

/** Remove a waiter's abort listener once it leaves the queue any other way (no listener piles up on a long-lived signal). */
type Settle = () => void

interface Bucket {
  controller: ConcurrencyController
  queue: Waiter[]
  timer?: ReturnType<typeof setTimeout>
}

export interface GovernorOptions {
  /** Default per-bucket concurrency D (start and idle-reset point). */
  initial: number
  /** Growth ceiling, default 2·D. */
  growthLimit?: number
  /** Which requests are governed (default: workflow subagent sessions). */
  governs?: (options: GenerateOptions) => boolean
  onChange?: (change: ConcurrencyChange) => void
  /** A governed request must wait for a slot (the bucket is full). */
  onQueued?: (options: GenerateOptions) => void
  /** A governed request was admitted and is about to be sent. */
  onAdmitted?: (options: GenerateOptions) => void
}

export class ConcurrencyGovernor {
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly options: GovernorOptions) {}

  snapshot(): { key: string; cap: number; inFlight: number; waiters: number }[] {
    return [...this.buckets.values()].map(bucket => {
      const snap = bucket.controller.snapshot()
      return { key: snap.key, cap: snap.cap, inFlight: snap.inFlight, waiters: bucket.queue.length }
    })
  }

  /** Current cap of one `provider/model` bucket, when it exists. */
  capOf(key: string): number | undefined {
    return this.buckets.get(key)?.controller.snapshot().cap
  }

  private bucket(key: string): Bucket {
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      bucket = { controller: new ConcurrencyController(key, this.options.initial, this.options.growthLimit ?? this.options.initial * 2), queue: [] }
      this.buckets.set(key, bucket)
    }
    return bucket
  }

  private emit(changes: ConcurrencyChange[]): void {
    for (const change of changes) this.options.onChange?.(change)
  }

  private pump(bucket: Bucket): void {
    const now = Date.now()
    while (bucket.queue.length > 0 && bucket.controller.canAdmit(now)) {
      bucket.queue.shift()!.resolve(bucket.controller.admitted(now))
    }
    this.emit(bucket.controller.waiters(now, bucket.queue.length))
    const cooldown = bucket.controller.snapshot().cooldownUntil
    if (bucket.queue.length > 0 && cooldown !== undefined && cooldown > now && bucket.timer === undefined) {
      bucket.timer = setTimeout(() => {
        bucket.timer = undefined
        this.pump(bucket)
      }, cooldown - now)
      bucket.timer.unref?.()
    }
  }

  /**
   * Admit one governed request: synchronously when the bucket has room and nobody is
   * queued (so concurrent callers in the same tick see each other's admission), else
   * FIFO behind the queue. Resolves with the admission epoch.
   */
  private admit(bucket: Bucket, signal: AbortSignal | undefined): Promise<number> {
    const now = Date.now()
    this.emit(bucket.controller.observe(now))
    if (bucket.queue.length === 0 && bucket.controller.canAdmit(now)) return Promise.resolve(bucket.controller.admitted(now))
    return new Promise<number>((resolve, reject) => {
      let detach: Settle = () => undefined
      const waiter: Waiter = {
        resolve: (epoch) => { detach(); resolve(epoch) },
        reject: (error) => { detach(); reject(error) },
      }
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = bucket.queue.indexOf(waiter)
          if (index < 0) return
          bucket.queue.splice(index, 1)
          // keep the controller's view of demand in step with the queue
          this.emit(bucket.controller.waiters(Date.now(), bucket.queue.length))
          waiter.reject(signal.reason ?? new Error('aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => signal.removeEventListener('abort', onAbort)
      }
      bucket.queue.push(waiter)
      this.emit(bucket.controller.waiters(Date.now(), bucket.queue.length))
      this.pump(bucket)
    })
  }

  /** Wrap one model request attempt. */
  async * govern(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const key = `${options.provider}/${options.model}`
    const bucket = this.bucket(key)
    const governed = (this.options.governs ?? defaultGoverns)(options)
    let epoch: number
    if (governed) {
      if (bucket.queue.length > 0 || !bucket.controller.canAdmit(Date.now())) this.options.onQueued?.(options)
      epoch = await this.admit(bucket, options.signal)
      this.options.onAdmitted?.(options)
    } else {
      this.emit(bucket.controller.observe(Date.now()))
      epoch = bucket.controller.admitted(Date.now())
    }
    let outcome: 'success' | 'throttled' | 'transient' | 'ended' = 'ended'
    let retryAfterMs: number | undefined
    try {
      for await (const chunk of next()) {
        if ((chunk as { type: string }).type === 'finish') {
          const reason = (chunk as { reason?: { kind?: string; failure?: { code?: string; providerRetryAfterMs?: number } } }).reason
          if (reason?.kind === 'error') {
            const code = reason.failure?.code ?? ''
            retryAfterMs = reason.failure?.providerRetryAfterMs
            const message = (reason.failure as { message?: string } | undefined)?.message ?? ''
            // an exhausted quota (even worded as a 429) is not congestion: it must not cut the cap
            outcome = isThrottle(code) && !isChineseQuotaText(message) ? 'throttled' : 'transient'
          } else if (reason?.kind === 'aborted') {
            outcome = 'ended'
          } else {
            outcome = 'success'
          }
        }
        yield chunk
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? ''
      retryAfterMs = (error as { providerRetryAfterMs?: number }).providerRetryAfterMs
      const message = (error as { message?: string }).message ?? ''
      outcome = isThrottle(code) && !isChineseQuotaText(message) ? 'throttled' : code === 'ABORTED' ? 'ended' : 'transient'
      throw error
    } finally {
      const now = Date.now()
      if (outcome === 'success') this.emit(bucket.controller.succeeded(now, epoch))
      else if (outcome === 'throttled') this.emit(bucket.controller.throttled(now, epoch, 'rate_limited', retryAfterMs))
      else if (outcome === 'transient') this.emit(bucket.controller.failedTransient(now))
      else this.emit(bucket.controller.ended(now))
      this.pump(bucket)
    }
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.timer !== undefined) clearTimeout(bucket.timer)
      for (const waiter of bucket.queue.splice(0)) waiter.reject(new Error('governor disposed'))
    }
    this.buckets.clear()
  }
}

function isThrottle(code: string): boolean {
  return code === 'RATE_LIMIT' || code === 'HTTP_429' || code === 'HTTP_529'
}

/** Workflow subagents run under deterministic session ids `dwf-<runId>-<actor>`. */
export function defaultGoverns(options: GenerateOptions): boolean {
  const sessionId = (options as { sessionId?: string }).sessionId
  return typeof sessionId === 'string' && sessionId.startsWith('dwf-')
}

export function installGovernor(ctx: Context, governor: ConcurrencyGovernor): void {
  ctx.on('llm/stream' as never, ((options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => governor.govern(options, next)) as never)
  ctx.effect(() => () => governor.dispose())
}
