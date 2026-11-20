/**
 * The live & completed run as an independent Chat node (ZCode visual parity + DSH turn placement).
 *
 *   - Clean single-row header: `[WorkflowGraphIcon] 工作流已完成 <title>` on the left,
 *     `<N> 个阶段 · <M> 个子代理` + `[💾 保存]` popover + `[⤢]` open-details icon on the right.
 *   - Horizontal timeline with `AgentFace` tiles and corner completion checkmarks.
 *   - NO raw JSON `Result` or raw JSON `report()` dump on completed runs (the main agent delivers
 *     the natural Markdown report right below in the conversation!).
 *   - Sleek artifact chips with proper type glyphs (`M↓`, table grid, metrics, chart) + a 4-column
 *     receipt bar (`总耗时 · 消耗 Tokens · 子代理 · 阶段`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, IconRefreshOutlineRegular, IconStopFillRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CreateWorkflowCausalityGraph } from '../display/types.ts'
import { ArtifactKindIcon, ExpandDiagonalIcon, WorkflowGraphIcon } from './AgentFace.tsx'
import type { ConversationNodeDefinition, SessionEventLike, Translate, UseProjection } from './host-types.ts'
import { buildWorkflowTimeline, type TimelinePill } from './model/timeline/timeline-model.ts'
import { apiGet, apiPost, findRun, formatDuration, formatExactTokens, formatTokens, namerOf, reconcileRun, RUNS_PROJECTION, runKindText } from './run-view.ts'
import { SaveWorkflowControls, type SavedRunRef } from './SavePopover.tsx'
import { Timeline } from './Timeline.tsx'
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
  durationMs?: number | null
  savedAs?: SavedRunRef | null
  canSave?: boolean
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
  openRun: (runId: string, focusArtifactId?: string) => void
}

export function RunNode({ node, t, useProjection, sessionId, openChild, openRun }: { node: { data: RunNodeData }; t: Translate; useProjection: UseProjection } & RunNodeInjected) {
  const { runId } = node.data
  const projected = useProjection(RUNS_PROJECTION, state => findRun(state, { runId }))
  const names = useMemo(() => namerOf(t), [t])
  const [detail, setDetail] = useState<RunDetail | null | undefined>(undefined)
  const [savedOverride, setSavedOverride] = useState<SavedRunRef | null | undefined>(undefined)
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
      setRefresh(value => value + 1)
    }
  }
  const changes = useChanges(runId, `${projectedStatus ?? ''}:${filled}:${refresh}`)
  const changedFiles = (changes ?? []).reduce((sum, entry) => sum + entry.files.length, 0)
  const title = detail?.snapshot.name ?? runId
  const settled = run !== undefined && run.status !== 'running' && run.status !== 'pending'
  const stationsCount = model?.stations.length ?? 0
  const agentsCount = run?.actors.length ?? (graph?.lanes.filter(lane => lane.id !== 'workspace' && lane.id !== 'unknown').length ?? 0)
  const totalTokens = Math.max(run?.usage.spentTokens ?? 0, detail?.snapshot.spentTokens ?? 0)
  const isZh = t('card.title') === '工作流'
  const durationLabel = formatDuration(detail?.durationMs, isZh)
  const savedAs = savedOverride !== undefined ? savedOverride : detail?.savedAs
  const canSave = detail?.canSave === true && (run?.status === 'completed' || (savedAs !== null && savedAs !== undefined))
  const questions = run?.pendingQuestions?.length ?? 0
  const waitingHole = run?.holes?.find(hole => hole.state === 'waiting')
  const kindWord = runKindText(run, t)

  const headerParts: string[] = []
  if (stationsCount > 0) headerParts.push(t('card.phases', { count: stationsCount }))
  if (agentsCount > 0) headerParts.push(t('card.agents', { count: agentsCount }))

  return (
    <section className="dwf-card dwf-run-node" data-dwf-run={runId} data-run-status={run?.status ?? 'unknown'}>
      <header className="dwf-card-head">
        <span className="dwf-card-glyph" aria-hidden><WorkflowGraphIcon size={15} /></span>
        <span className="dwf-card-kind-strong">
          {run?.status === 'running' ? <TextShimmer active>{kindWord}</TextShimmer> : kindWord}
        </span>
        <span className="dwf-card-run-name" title={title}>{title}</span>

        <span className="dwf-card-actions">
          {headerParts.length > 0 ? <span className="dwf-card-head-summary">{headerParts.join(' · ')}</span> : null}
          {run?.status === 'running' && totalTokens > 0 ? (
            <span className="dwf-card-live-tokens" title={`${formatExactTokens(totalTokens)} tokens`}>
              {t('card.tokens', { tokens: formatTokens(totalTokens) })}
            </span>
          ) : null}
          {run?.status === 'running' ? (
            <Button size="sm" variant="ghost" icon={<IconStopFillRegular size={12} />} disabled={busy} onClick={() => { void control('stop') }}>{t('card.stop')}</Button>
          ) : null}
          {run?.status === 'stopped' && run.resumable === true ? (
            <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular size={12} />} disabled={busy} onClick={() => { void control('resume') }}>{t('card.resume')}</Button>
          ) : null}
          {canSave ? (
            <SaveWorkflowControls
              runId={runId}
              runName={detail?.snapshot.name}
              sessionId={sessionId}
              savedAs={savedAs}
              t={t}
              onSaved={saved => setSavedOverride(saved)}
              onOpenRun={targetId => openRun(targetId === '' ? runId : targetId)}
            />
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
        <Timeline model={model} names={names} t={t} settled={settled} onOpenPill={onOpenPill} />
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
              onClick={() => openRun(runId, artifact.id)}
              title={artifact.title ?? artifact.id}
            >
              <span className="dwf-artifact-pill-icon"><ArtifactKindIcon kind={artifact.kind} contentType={artifact.contentType} /></span>
              <span className="dwf-artifact-pill-label">{artifact.title ?? artifact.id}</span>
            </button>
          ))}
          {changedFiles > 0 ? (
            <button type="button" className="dwf-artifact-pill dwf-artifact-pill-subtle" onClick={() => openRun(runId)}>
              <span className="dwf-artifact-pill-label">{t('changes.count', { count: changedFiles })}</span>
            </button>
          ) : null}
        </div>
      ) : changedFiles > 0 && settled ? (
        <div className="dwf-artifact-strip">
          <button type="button" className="dwf-artifact-pill dwf-artifact-pill-subtle" onClick={() => openRun(runId)}>
            <span className="dwf-artifact-pill-label">{t('changes.count', { count: changedFiles })}</span>
          </button>
        </div>
      ) : null}

      {run?.status === 'completed' && (totalTokens > 0 || durationLabel !== undefined) ? (
        <div className="dwf-receipt-figures" data-dwf-figures="">
          <div className="dwf-figure">
            <span className="dwf-figure-val">{durationLabel ?? '—'}</span>
            <span className="dwf-figure-lbl">{t('figure.time')}</span>
          </div>
          <div className="dwf-figure" title={totalTokens > 0 ? `${formatExactTokens(totalTokens)} tokens` : undefined}>
            <span className="dwf-figure-val">{totalTokens > 0 ? formatTokens(totalTokens) : '—'}</span>
            <span className="dwf-figure-lbl">{t('figure.tokens')}</span>
          </div>
          <div className="dwf-figure">
            <span className="dwf-figure-val">{agentsCount > 0 ? String(agentsCount) : '—'}</span>
            <span className="dwf-figure-lbl">{t('figure.subagents')}</span>
          </div>
          <div className="dwf-figure">
            <span className="dwf-figure-val">{stationsCount > 0 ? String(stationsCount) : '—'}</span>
            <span className="dwf-figure-lbl">{t('figure.phases')}</span>
          </div>
        </div>
      ) : null}

      {notice !== undefined ? <p className="dwf-attention">{notice}</p> : null}
    </section>
  )
}
