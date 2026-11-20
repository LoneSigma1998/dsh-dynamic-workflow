/** Pure helpers shared by the card, the confirm card and the run pane. */

import type { WorkflowLaunchDisplay } from '../display/types.ts'
import type { WorkflowRunState, WorkflowRunsState } from '../shared/runs/workflow-runs.ts'
import { workflowRunStepCounts } from '../shared/runs/workflow-runs-caps.ts'
import type { LaneNameFormatter } from './model/graph/lane-name.ts'
import type { StepRunStatus } from './model/graph/types.ts'
import type { Translate } from './host-types.ts'

export const RUNS_PROJECTION = 'dynamicWorkflowRuns' as const

/** ZCode's graph message ids → this plugin's locale keys. */
const MESSAGE_KEYS: Record<string, string> = {
  'chat.toolCall.workflow.graph.lane.script': 'lane.script',
  'chat.toolCall.workflow.graph.lane.unresolved': 'lane.unresolved',
  'chat.toolCall.workflow.graph.lane.anonymous': 'lane.anonymous',
  'chat.toolCall.workflow.graph.lane.anonymousIndexed': 'lane.anonymousIndexed',
  'chat.toolCall.workflow.graph.phase.unphased': 'phase.unphased',
  'chat.toolCall.workflow.graph.phase.workflow': 'phase.workflow',
}

export function namerOf(t: Translate): LaneNameFormatter {
  return (descriptor, values) => {
    const key = MESSAGE_KEYS[descriptor.id]
    return key === undefined ? descriptor.id : t(key, values)
  }
}

/** Validate a tool result's `meta` as the launch display (it is `unknown` on the wire). */
export function launchDisplayOf(meta: unknown): WorkflowLaunchDisplay | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const value = meta as Partial<WorkflowLaunchDisplay>
  return value.kind === 'dynamic-workflow-launch' && typeof value.ok === 'boolean' ? value as WorkflowLaunchDisplay : undefined
}

export function findRun(state: WorkflowRunsState | undefined, by: { runId?: string | undefined; toolCallId?: string | undefined }): WorkflowRunState | undefined {
  if (state === undefined) return undefined
  if (by.runId !== undefined) {
    const hit = state.runs.find(run => run.runId === by.runId)
    if (hit !== undefined) return hit
  }
  if (by.toolCallId !== undefined) {
    // newest run launched by this call (amend chains reuse ids only across calls)
    for (let i = state.runs.length - 1; i >= 0; i -= 1) {
      if (state.runs[i]!.toolCallId === by.toolCallId) return state.runs[i]
    }
  }
  return undefined
}

export type DotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

export function runDot(run: Pick<WorkflowRunState, 'status' | 'stopReason'> | undefined): DotState {
  switch (run?.status) {
    case 'running': return 'ongoing'
    case 'pending': return 'idle'
    case 'completed': return 'done'
    case 'errored': return 'error'
    case 'stopped': return run.stopReason === 'superseded' ? 'idle' : 'warning'
    default: return 'idle'
  }
}

export function stepDot(status: StepRunStatus | undefined): DotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'done': return 'done'
    case 'failed': return 'error'
    default: return 'idle'
  }
}

/** The journal's view of a run (HTTP detail), used to correct a stale projection. */
export interface JournalRunStatus { status: string; stopReason?: string; resumable?: boolean; live?: boolean }

/**
 * A run the projection still shows as running can be dead: its Host exited before the run settled,
 * and the owner session has not been loaded since (so no settle record reached its log). The
 * journal is the truth then — show what it says, with the resume affordance it allows.
 */
export function reconcileRun(run: WorkflowRunState | undefined, journal: JournalRunStatus | undefined): WorkflowRunState | undefined {
  if (run === undefined || journal === undefined) return run
  if (run.status !== 'running' && run.status !== 'pending') return run
  // Only a run the Host is not executing can be stale; a live run's projection is the truth.
  if (journal.live !== false) return run
  if (journal.status !== 'stopped' && journal.status !== 'errored' && journal.status !== 'completed') return run
  return {
    ...run,
    status: journal.status,
    ...journal.stopReason === undefined ? {} : { stopReason: journal.stopReason as NonNullable<WorkflowRunState['stopReason']> },
    ...journal.resumable === true ? { resumable: true as const } : {},
  }
}

/** `provider/vendor/model` → `vendor/model` (the route id is noise on a card; the title keeps it). */
export function shortModel(label: string): string {
  const parts = label.split('/')
  return parts.length >= 3 ? parts.slice(1).join('/') : label
}

export function formatTokens(value: number): string {
  if (value < 1000) return value.toLocaleString('en-US')
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

export function formatExactTokens(value: number): string {
  return value.toLocaleString('en-US')
}

export function formatDuration(ms: number | null | undefined, zh: boolean): string | undefined {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined
  const totalSec = Math.max(1, Math.round(ms / 1000))
  const hours = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  if (hours > 0) return zh ? `${hours}h ${mins}m` : `${hours}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

export function runKindText(run: WorkflowRunState | undefined, t: Translate): string {
  if (run === undefined) return t('card.title')
  if (run.status === 'stopped' && run.stopReason === 'superseded') return t('card.kind.superseded')
  return t(`card.kind.${run.status}` as Parameters<Translate>[0])
}

/** Steps done / total, through the projection's one sanctioned reading (it counts unlisted nodes too). */
export function taskCounts(run: WorkflowRunState): { done: number; total: number } {
  const { total, settled } = workflowRunStepCounts(run)
  return { done: Math.min(settled, total), total }
}

export function runStatusText(run: WorkflowRunState, t: Translate): string {
  const base = t(`status.${run.status}`)
  return run.status === 'stopped' && run.stopReason !== undefined ? `${base} · ${t(`stop.${run.stopReason}`)}` : base
}

/** Document-relative route of the Host half (`ctx.webServer` prefix `/dynamic-workflow`). */
export const API_ROUTE = 'dynamic-workflow/api'

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_ROUTE}/${path}`, { headers: { 'x-dynamic-workflow-request': '1' }, ...signal === undefined ? {} : { signal } })
  if (!response.ok) throw new Error(`${response.status} ${await response.text().catch(() => '')}`)
  return await response.json() as T
}

export async function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${API_ROUTE}/${path}`, {
    method: 'POST',
    headers: { 'x-dynamic-workflow-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${response.status} ${await response.text().catch(() => '')}`)
  return await response.json() as T
}
