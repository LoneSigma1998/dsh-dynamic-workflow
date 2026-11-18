/**
 * `dynamicWorkflowRuns`: a session projection that folds the session's
 * `dynamic-workflow/progress` events into the live state of its recent runs
 * with ZCode's own reducer (the "single clock" every surface reads). The Web
 * client reads it with `useProjection('dynamicWorkflowRuns')`; DSH checkpoints
 * it, so a reopened session shows the same run cards without replaying runs.
 */

import type { Context } from '@deepseek-ai/cordis'
import { reduceWorkflowRunsState } from '../shared/runs/workflow-runs-reducer.ts'
import { WORKFLOW_RUNS_LIMITS, workflowRunsStateSchema, type WorkflowRunsState } from '../shared/runs/workflow-runs.ts'

export const RUNS_PROJECTION_KEY = 'dynamicWorkflowRuns'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    dynamicWorkflowRuns: WorkflowRunsState
  }
}

const EMPTY: WorkflowRunsState = { revision: 0, runs: [] }

/** Ignorable plugin record type of run progress (see `PROGRESS_EVENT` in ../index.ts). */
export const PROGRESS_RECORD = 'plugin:dynamic-workflow/progress'

export function applyProgressEvent(state: WorkflowRunsState, event: { type: string; data?: unknown }): WorkflowRunsState {
  if (event.type !== PROGRESS_RECORD) return state
  const data = event.data as { runId?: string; toolCallId?: string; sequence?: number; eventType?: string; payload?: Record<string, unknown>; actorSessionId?: string } | undefined
  if (data === undefined) return state
  if (data.eventType === 'run-result') {
    // Host-side record (RunService.onSettled): the result preview the engine's run-settled lacks.
    const preview = data.payload?.resultPreview
    const index = state.runs.findIndex(run => run.runId === data.runId)
    if (typeof preview !== 'string' || index < 0) return state
    const runs = state.runs.slice()
    runs[index] = { ...runs[index]!, resultPreview: preview.slice(0, WORKFLOW_RUNS_LIMITS.maxResultPreviewLength) }
    return { ...state, revision: state.revision + 1, runs }
  }
  const next = reduceWorkflowRunsState(state, {
    ...data.runId === undefined ? {} : { runId: data.runId },
    ...data.toolCallId === undefined ? {} : { toolCallId: data.toolCallId },
    ...data.sequence === undefined ? {} : { sequence: data.sequence },
    ...data.eventType === undefined ? {} : { eventType: data.eventType },
    ...data.payload === undefined ? {} : { payload: data.payload },
    ...data.actorSessionId === undefined ? {} : { actorSessionId: data.actorSessionId },
  })
  return next ?? state
}

export function registerRunProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], async (scope) => {
    const projections = scope.get('sessionProjections') as { register(definition: unknown): Promise<unknown> }
    await projections.register({
      key: RUNS_PROJECTION_KEY,
      stateSchema: workflowRunsStateSchema,
      stateVersion: 1,
      init: () => EMPTY,
      apply: applyProgressEvent,
      wire: { viewSchema: workflowRunsStateSchema, view: (state: WorkflowRunsState) => state, summary: false },
    })
  })
}
