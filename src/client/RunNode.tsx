/**
 * The live run as an independent Chat node (DSH-native placement).
 *
 * DSH folds a finished turn's tool calls into its process disclosure ("已完成，用时 44 秒"), and a
 * workflow run outlives the turn that launched it — so the run cannot live only inside the
 * create_workflow tool card the way it does in ZCode. This Definition starts one node per run at
 * its `run-started` progress record and places it at `groupTree: 'turn'`: it stays in the turn,
 * outside the folded process, for as long as the conversation shows that turn. The node draws the
 * full timeline lit by the `dynamicWorkflowRuns` projection, with the run controls and outcome;
 * the tool card keeps the draft / confirmation / diagnostics view.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, IconChevronRightOutlineRegular, IconLayersOutlineRegular, IconRefreshOutlineRegular, IconStopFillRegular, StateDot, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CreateWorkflowCausalityGraph } from '../display/types.ts'
import type { ConversationNodeDefinition, SessionEventLike, Translate, UseProjection } from './host-types.ts'
import { buildWorkflowTimeline, type TimelinePill } from './model/timeline/timeline-model.ts'
import { apiGet, apiPost, findRun, namerOf, reconcileRun, RUNS_PROJECTION, runDot, runStatusText } from './run-view.ts'
import { Timeline } from './Timeline.tsx'
import { RunMeta, RunOutcome } from './WorkflowToolCard.tsx'
import { useChanges } from './RunExtras.tsx'

export const RUN_NODE_KIND = 'dynamic-workflow-run'
const PROGRESS_RECORD = 'plugin:dynamic-workflow/progress'

export interface RunNodeData { runId: string; toolCallId?: string }
interface RunNodeState extends RunNodeData { seq: number }

function progressOf(event: SessionEventLike): { runId: string; eventType: string; toolCallId?: string } | undefined {
  if (event.type !== PROGRESS_RECORD) return undefined
  const data = event.data as { runId?: unknown; eventType?: unknown; toolCallId?: unknown } | undefined
  if (typeof data?.runId !== 'string' || typeof data.eventType !== 'string') return undefined
  return { runId: data.runId, eventType: data.eventType, ...typeof data.toolCallId === 'string' ? { toolCallId: data.toolCallId } : {} }
}

export const runNodeDefinition: ConversationNodeDefinition<RunNodeState> = {
  kind: RUN_NODE_KIND,
  target: 'chat',
  // Only the start is matched: the node's live state comes from the projection, so update
  // records need no fold here (and a run resumed in a later session keeps its own start).
  match: (event) => {
    const progress = progressOf(event)
    return progress?.eventType === 'run-started' ? { id: progress.runId, role: 'start' } : null
  },
  start: (_context, match) => {
    const progress = progressOf(match.event)!
    return { seq: match.event.seq, runId: progress.runId, ...progress.toolCallId === undefined ? {} : { toolCallId: progress.toolCallId } }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const { seq, ...data } = context.state
    return {
      key: context.key,
      kind: RUN_NODE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: seq,
      location: (context.start?.location ?? { kind: 'unresolved' }) as unknown,
      groupTree: 'turn',
      visibility: 'visible',
      data,
    }
  },
}

interface RunDetail { snapshot: { name: string; status: string; stopReason?: string; resumable?: boolean; live?: boolean; artifacts?: { id: string; title?: string; primary: boolean; version: number }[] }; graph: CreateWorkflowCausalityGraph | null }

/** Static half of a run (name, analyzed graph) by run id; refreshed when the script changes (holes). */
const details = new Map<string, Promise<RunDetail | null>>()
function detailOf(runId: string, revision: string): Promise<RunDetail | null> {
  const key = `${runId}#${revision}`
  let pending = details.get(key)
  if (pending === undefined) {
    pending = apiGet<RunDetail>(`runs/${encodeURIComponent(runId)}`).catch(() => {
      details.delete(key) // a transient failure is retried on the next render that needs it
      return null
    })
    details.set(key, pending)
    if (details.size > 64) details.delete(details.keys().next().value!)
  }
  return pending
}

export interface RunNodeInjected {
  openChild: (childSessionId: string) => void
  openRun: (runId: string) => void
}

export function RunNode({ node, t, useProjection, openChild, openRun }: { node: { data: RunNodeData }; t: Translate; useProjection: UseProjection } & RunNodeInjected) {
  const { runId } = node.data
  const projected = useProjection(RUNS_PROJECTION, state => findRun(state, { runId }))
  const names = useMemo(() => namerOf(t), [t])
  const [detail, setDetail] = useState<RunDetail | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const filled = projected?.holes?.filter(hole => hole.state === 'filled').length ?? 0
  const projectedStatus = projected?.status
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let live = true
    void detailOf(runId, `${filled}:${projectedStatus ?? ''}:${refresh}`).then((value) => { if (live) setDetail(value) })
    return () => { live = false }
  }, [runId, filled, projectedStatus, refresh])
  const run = useMemo(() => reconcileRun(projected, detail?.snapshot), [projected, detail])
  const graph = detail?.graph ?? undefined
  const model = useMemo(() => (graph === undefined ? undefined : buildWorkflowTimeline(graph, run)), [graph, run])
  const onOpenPill = useCallback((pill: TimelinePill) => {
    if (pill.instance?.sessionId !== undefined) openChild(pill.instance.sessionId)
  }, [openChild])
  const control = async (action: 'stop' | 'resume'): Promise<void> => {
    setBusy(true)
    try {
      const answer = await apiPost<{ ok?: boolean; message?: string }>(`runs/${encodeURIComponent(runId)}/${action}`)
      if (answer.ok === false && answer.message !== undefined) setNotice(answer.message)
      else setNotice(undefined)
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
      setRefresh(value => value + 1) // the journal changed (resumed / stopping): re-read it
    }
  }
  const changes = useChanges(runId, `${projectedStatus ?? ''}:${filled}:${refresh}`)
  const changedFiles = (changes ?? []).reduce((sum, entry) => sum + entry.files.length, 0)
  const title = detail?.snapshot.name ?? runId
  return (
    <section className="dwf-card dwf-run-node" data-dwf-run={runId} data-run-status={run?.status ?? 'unknown'}>
      <header className="dwf-card-head">
        <span className="dwf-card-icon" aria-hidden><IconLayersOutlineRegular size={14} /></span>
        <span className="dwf-card-kind">{t('card.title')}</span>
        <span className="dwf-card-title" title={title}>{title}</span>
        {run !== undefined ? (
          <span className="dwf-card-status">
            <StateDot state={runDot(run)} size={12} />
            {run.status === 'running' ? <TextShimmer active>{runStatusText(run, t)}</TextShimmer> : <span>{runStatusText(run, t)}</span>}
          </span>
        ) : null}
        <span className="dwf-card-actions">
          {run?.status === 'running' ? <Button size="sm" variant="ghost" icon={<IconStopFillRegular size={12} />} disabled={busy} onClick={() => { void control('stop') }}>{t('card.stop')}</Button> : null}
          {run?.status === 'stopped' && run.resumable === true ? <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular size={12} />} disabled={busy} onClick={() => { void control('resume') }}>{t('card.resume')}</Button> : null}
          <Button size="sm" variant="ghost" icon={<IconChevronRightOutlineRegular size={12} />} onClick={() => openRun(runId)}>{t('card.open')}</Button>
        </span>
      </header>
      {run !== undefined ? (
        <div className="dwf-card-meta">
          {model !== undefined ? <span>{t('card.phases', { count: model.stations.length })}</span> : null}
          <RunMeta run={run} t={t} />
          {changedFiles > 0 ? <button type="button" className="dwf-link dwf-meta-link" onClick={() => openRun(runId)}>{t('changes.count', { count: changedFiles })}</button> : null}
        </div>
      ) : null}
      {model !== undefined && model.stations.length > 0 ? <Timeline model={model} names={names} t={t} onOpenPill={onOpenPill} /> : null}
      {run !== undefined ? <RunOutcome run={run} t={t} /> : null}
      {(detail?.snapshot.artifacts?.length ?? 0) > 0 ? (
        // ZCode's completion artifacts: each one a chip that opens the run pane where it previews
        <div className="dwf-artifact-strip" data-dwf-artifact-strip="">
          {[...detail!.snapshot.artifacts!].sort((a, b) => Number(b.primary) - Number(a.primary)).slice(0, 6).map(artifact => (
            <button type="button" key={`${artifact.id}@${artifact.version}`} className="dwf-chip dwf-artifact-chip" onClick={() => openRun(runId)} title={artifact.title ?? artifact.id}>
              {artifact.primary ? '★ ' : ''}{artifact.title ?? artifact.id}
            </button>
          ))}
        </div>
      ) : null}
      {notice !== undefined ? <p className="dwf-attention">{notice}</p> : null}
    </section>
  )
}
