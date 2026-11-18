/**
 * Delivery of run notifications to the main agent that owns a run.
 *
 * ZCode enqueues a runtime command that starts a turn when the agent is idle
 * and steers into the running turn otherwise. The DSH equivalent is
 * `agent.followup` (idle: wakes a new turn) / `agent.steer` (running: lands at
 * the next step). Two DSH-native additions:
 *
 *   - **Hold mode** (headless/SDK): DSH's headless runner exits once the main
 *     agent is idle and its subagent tree is quiet — it knows nothing about a
 *     plugin-owned background run. With `holdTurnWhileRunning`, an
 *     `agent/turn-stopping` listener keeps the owning agent's turn open while it
 *     has live runs and steers each notification into it the moment it is
 *     queued, so escalations, holes and the terminal notice all reach the model.
 *   - **Turn-boundary gate** (all modes): when the agent tries to close a turn
 *     while one of its runs still waits on it (open question or hole), it is
 *     steered once with a `<workflow-blocked>` reminder instead of a timer.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { userMessage } from '../dsh/messages.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface QueuedNotice {
  text: string
  summary: string
}

export interface NotificationDeliveryOptions {
  /** Keep the owning agent's turn open while it has live runs (headless / SDK). */
  holdTurnWhileRunning: boolean
  /** Whether the owner has live runs (for hold mode). */
  hasLiveRuns(parentSessionId: string): boolean
  /** Open decisions the owner owes (for the turn-boundary gate). */
  blockedReminder?(parentSessionId: string): string | undefined
  logger?: { warn(message: string, ...args: unknown[]): void }
}

interface Waiter {
  wake: () => void
}

export class NotificationDelivery {
  private readonly queues = new Map<string, QueuedNotice[]>()
  private readonly waiters = new Map<string, Waiter>()
  /** Turns already reminded by the gate, keyed `${session}:${turn}`. */
  private readonly reminded = new Set<string>()

  constructor(private readonly ctx: Context, private readonly options: NotificationDeliveryOptions) {
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }: { agent: Agent; turn: number; signal: AbortSignal }) => {
      await this.onTurnStopping(agent, turn, signal)
    })
  }

  /** Queue one notice for the owner and deliver it as soon as the owner can take it. */
  async deliver(parentSessionId: string, notice: QueuedNotice): Promise<void> {
    const waiter = this.waiters.get(parentSessionId)
    if (waiter !== undefined) {
      this.enqueue(parentSessionId, notice)
      waiter.wake()
      return
    }
    const agent = await this.resolveAgent(parentSessionId)
    if (agent === undefined) {
      // Owner not loaded: keep it queued; the next turn-stopping or explicit flush delivers it.
      this.enqueue(parentSessionId, notice)
      return
    }
    const message = this.toMessage(notice)
    try {
      if (agent.status === 'idle') agent.followup(message)
      else agent.steer(message)
    } catch (error) {
      this.options.logger?.warn('dynamic-workflow: notification delivery to %s failed: %s', parentSessionId, String(error))
      this.enqueue(parentSessionId, notice)
    }
  }

  private enqueue(parentSessionId: string, notice: QueuedNotice): void {
    const queue = this.queues.get(parentSessionId) ?? []
    queue.push(notice)
    this.queues.set(parentSessionId, queue)
  }

  private toMessage(notice: QueuedNotice): UserMessage {
    return userMessage(notice.text, { kind: 'dynamic-workflow', form: 'notice', summary: notice.summary.slice(0, 200) }, `dwf-notice:${randomUUID()}`)
  }

  private async resolveAgent(sessionId: string): Promise<Agent | undefined> {
    const live = this.ctx.agents.get(sessionId as SessionId)
    if (live !== undefined) return live
    const controller = this.ctx.get('sessionController') as { resolveAgent?: (id: SessionId) => Promise<{ agent: Agent } | { error: unknown }> } | undefined
    if (controller?.resolveAgent === undefined) return undefined
    try {
      const resolved = await controller.resolveAgent(sessionId as SessionId)
      return 'agent' in resolved ? resolved.agent : undefined
    } catch {
      return undefined
    }
  }

  private async onTurnStopping(agent: Agent, turn: number, signal: AbortSignal): Promise<void> {
    const id = agent.id as string
    // 1. Anything queued while the agent could not take it goes in now.
    if (this.flushInto(agent)) return
    // 2. Turn-boundary gate: the agent owes a run a decision.
    const gateKey = `${id}:${turn}`
    if (!this.reminded.has(gateKey)) {
      const reminder = this.options.blockedReminder?.(id)
      if (reminder !== undefined) {
        this.reminded.add(gateKey)
        if (this.reminded.size > 1024) this.reminded.delete(this.reminded.values().next().value!)
        agent.steer(this.toMessage({ text: reminder, summary: 'Workflow waiting on you' }))
        return
      }
    }
    // 3. Hold mode: wait for the next notice of a live run, then steer it in.
    if (!this.options.holdTurnWhileRunning) return
    while (this.options.hasLiveRuns(id) && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          signal.removeEventListener('abort', done)
          this.waiters.delete(id)
          resolve()
        }
        this.waiters.set(id, { wake: done })
        signal.addEventListener('abort', done, { once: true })
        // A notice may have been queued between the check and the registration.
        if ((this.queues.get(id)?.length ?? 0) > 0) done()
      })
      if (this.flushInto(agent)) return
    }
    this.flushInto(agent)
  }

  /** Steer every queued notice into the agent; returns whether anything was delivered. */
  private flushInto(agent: Agent): boolean {
    const queue = this.queues.get(agent.id as string)
    if (queue === undefined || queue.length === 0) return false
    this.queues.delete(agent.id as string)
    for (const notice of queue) agent.steer(this.toMessage(notice))
    return true
  }

  /** Release every hold (plugin unload). */
  dispose(): void {
    for (const waiter of [...this.waiters.values()]) waiter.wake()
    this.waiters.clear()
  }
}
