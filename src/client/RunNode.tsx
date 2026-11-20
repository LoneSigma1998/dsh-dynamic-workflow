/**
 * The live & completed run as an independent Chat node (100% ZCode `WorkflowRunDigest` parity):
 *
 *   - Minimal single-row header: `[WorkflowGraphIcon] 工作流已完成 <title>` on the left,
 *     `<N> 个阶段 · <M> 个子代理 · <tokens>` + `[⤢]` open-details button on the right.
 *     (Save & Distill lives exclusively on the Run Detail page, keeping the chat card serene.)
 *   - Horizontal timeline with full-saturation `AgentFace` stadium pills & bare `>_` terminal icon.
 *   - Hairline divider + sleek artifact pills (`M↓`, table, chart, metrics, board) that jump
 *     straight into the full-pane Artifact Reader on click.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, IconRefreshOutlineRegular, IconStopFillRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CreateWorkflowCausalityGraph } from '../display/types.ts'
import { ArtifactKindIcon, ExpandDiagonalIcon, WorkflowGraphIcon } from './AgentFace.tsx'
import type { ConversationNodeDefinition, SessionEventLike, Translate, UseProjection } from './host-types.ts'
import { buildWorkflowTimeline, type TimelinePill } from './model/timeline/timeline-model.ts'
import type { OpenRunOptions } from './RunPane.tsx'
import { apiGet, apiPost, findRun, formatExactTokens, formatTokens, namerOf, reconcileRun, RUNS_PROJECTION, runKindText } from './run-view.ts'
import { Timeline } from './Timeline.tsx'

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

interface RunCardArtifact {
  id: string
  kind: string
  title?: string
  contentType?: string
  primary: boolean
  version: number
}

interface RunDetail {
  snapshot: {
    name: string
    status: string
    stopReason?: string
    resumable?: boolean
    live?: boolean
    spentTokens?: number
    artifacts?: RunCardArtifact[]
  }
  graph: CreateWorkflowCausalityGraph | null
}

const details = new Map<string, Promise<RunDetail | null>>()
function detailOf(runId: string, revision: string): Promise<RunDetail | null> {
  const key = `${runId}#${revision}`
  let pending = details.get(key)
  if (pending === undefined) {
    pending = apiGet<RunDetail>(`runs/${encodeURIComponent(runId)}`).catch(() => {
      details.delete(key)
      return null
    })
    details.set(key, pending)
    if (details.size > 64) details.delete(details.keys().next().value!)
  }
  return pending
}

export interface RunNodeInjected {
  sessionId?: string
  openChild: (childSessionId: string) => void
  openRun: (runId: string, opts?: OpenRunOptions) => void
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
  const onOpenWorkspace = useCallback(() => {
    openRun(runId, { scriptLog: true })
  }, [openRun, runId])
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
      setRefresh(value => value + 1)
    }
  }
  const title = detail?.snapshot.name ?? runId
  const stationsCount = model?.stations.length ?? 0
  const agentsCount = run?.actors.length ?? (graph?.lanes.filter(lane => lane.id !== 'workspace' && lane.id !== 'unknown').length ?? 0)
  const totalTokens = Math.max(run?.usage.spentTokens ?? 0, detail?.snapshot.spentTokens ?? 0)
  const questions = run?.pendingQuestions?.length ?? 0
  const waitingHole = run?.holes?.find(hole => hole.state === 'waiting')
  const kindWord = runKindText(run, t)

  const headerParts: string[] = []
  if (stationsCount > 0) headerParts.push(t('card.phases', { count: stationsCount }))
  if (agentsCount > 0) headerParts.push(t('card.agents', { count: agentsCount }))
  if (totalTokens > 0) headerParts.push(t('card.tokens', { tokens: formatTokens(totalTokens) }))

  return (
    <section className="dwf-card dwf-run-node" data-dwf-run={runId} data-run-status={run?.status ?? 'unknown'}>
      <header className="dwf-card-head">
        <span className="dwf-card-glyph" aria-hidden><WorkflowGraphIcon size={15} /></span>
        <span className="dwf-card-kind-strong">
          {run?.status === 'running' ? <TextShimmer active>{kindWord}</TextShimmer> : kindWord}
        </span>
        <span className="dwf-card-run-name" title={title}>{title}</span>

        <span className="dwf-card-actions">
          {headerParts.length > 0 ? (
            <span className="dwf-card-head-summary" title={totalTokens > 0 ? `${formatExactTokens(totalTokens)} tokens` : undefined}>
              {headerParts.join(' · ')}
            </span>
          ) : null}
          {run?.status === 'running' ? (
            <Button size="sm" variant="ghost" icon={<IconStopFillRegular size={12} />} disabled={busy} onClick={() => { void control('stop') }}>{t('card.stop')}</Button>
          ) : null}
          {run?.status === 'stopped' && run.resumable === true ? (
            <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular size={12} />} disabled={busy} onClick={() => { void control('resume') }}>{t('card.resume')}</Button>
          ) : null}
          <button
            type="button"
            className="dwf-expand-btn"
            aria-label={t('card.open')}
            title={t('card.open')}
            onClick={() => openRun(runId)}
          >
            <ExpandDiagonalIcon size={13} />
          </button>
        </span>
      </header>

      {model !== undefined && model.stations.length > 0 ? (
        <Timeline model={model} names={names} t={t} onOpenPill={onOpenPill} onOpenWorkspace={onOpenWorkspace} />
      ) : null}

      {questions > 0 ? <p className="dwf-attention">{t('card.questions', { count: questions })}</p> : null}
      {waitingHole !== undefined ? <p className="dwf-attention">{t('card.hole', { name: waitingHole.name })}</p> : null}
      {(run?.status === 'errored' || (run?.status === 'stopped' && run.stopReason !== 'superseded')) && run.error !== undefined ? (
        <div className="dwf-outcome dwf-outcome-error">
          <span className="dwf-outcome-label">{t('card.error')}</span>
          <pre>{run.error}</pre>
        </div>
      ) : null}

      {(detail?.snapshot.artifacts?.length ?? 0) > 0 ? (
        <div className="dwf-artifact-strip" data-dwf-artifact-strip="">
          {[...detail!.snapshot.artifacts!].sort((a, b) => Number(b.primary) - Number(a.primary)).slice(0, 8).map(artifact => (
            <button
              type="button"
              key={`${artifact.id}@${artifact.version}`}
              className="dwf-artifact-pill"
              data-primary={artifact.primary ? '' : undefined}
              onClick={() => openRun(runId, { artifactId: artifact.id })}
              title={artifact.title ?? artifact.id}
            >
              <span className="dwf-artifact-pill-icon"><ArtifactKindIcon kind={artifact.kind} contentType={artifact.contentType} /></span>
              <span className="dwf-artifact-pill-label">{artifact.title ?? artifact.id}</span>
            </button>
          ))}
        </div>
      ) : null}

      {notice !== undefined ? <p className="dwf-attention">{notice}</p> : null}
    </section>
  )
}
