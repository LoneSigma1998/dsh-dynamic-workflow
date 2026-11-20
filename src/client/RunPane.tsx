/**
 * Right-sidebar run pane (page tab `dynamic-workflow-run`): 100% ZCode `WorkflowRunSidePane`
 * parity in layout, hierarchy, and focus:
 *
 *   - **Run Overview (default)**:
 *     1. Two-row status header (`[‹] <Title>   [⚙ 配置] [💾 保存 / ▷ 再次运行] [■ 停止运行]`,
 *        Row 2 `● 已完成  [✓ 已保存]`, Row 3 `☰ <model · > 3 个子代理 · 9/9 步 · 33,364,853 tokens · 2 个产物`).
 *     2. Clean Result hint (`结果` / `本实例已完成，结果以后台结果消息的形式投递到会话里。`).
 *     3. Collapsible vertical Phase Spine (`RunSpine`): single-line stadium pills, click subagent
 *        to inspect its transcript, click `>_ Script` to open the Script Logbook sub-view.
 *     4. Compact collapsible Artifacts footer (`产物  2  ▾`): sleek single-line rows that open the
 *        dedicated full-pane Artifact Reader sub-view on click.
 *   - **Artifact Reader sub-view**: full-pane clean view of one Markdown / Metrics / Table / Chart.
 *   - **Script Logbook sub-view**: full-pane view of `world.run` / `files.*` steps + workflow code.
 */

import { useEffect, useMemo, useState } from 'react'
import { Button, IconRefreshOutlineRegular, IconStopFillRegular, StateDot, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CreateWorkflowCausalityGraph } from '../display/types.ts'
import type { WorkflowRunState } from '../shared/runs/workflow-runs.ts'
import type { Translate, UseProjection } from './host-types.ts'
import { buildWorkflowTimeline } from './model/timeline/timeline-model.ts'
import { apiGet, apiPost, findRun, formatExactTokens, formatTokens, namerOf, reconcileRun, RUNS_PROJECTION, runDot, runStatusText, shortModel, taskCounts } from './run-view.ts'
import { RunSpine } from './RunSpine.tsx'
import { SavedStatusBadge, SaveWorkflowControls, type SavedRunRef } from './SavePopover.tsx'
import { changedSettings, SettingsFields, type RunSettingsValue } from './Settings.tsx'
import { ArtifactReaderView, CompactArtifactsSection, ScriptLogbookView, type ArtifactInfo } from './RunExtras.tsx'
import { WorkflowsHome } from './SavedWorkflows.tsx'

export const RUN_TAB_KIND = 'dynamic-workflow-run'
export const RUN_TAB_ID = 'dsh-dynamic-workflow:run'

export interface OpenRunOptions {
  artifactId?: string
  scriptLog?: boolean
}

export interface RunTabParams {
  sessionId: string
  runId: string
  focusArtifactId?: string
  scriptLog?: boolean
}

type PaneSubView =
  | { kind: 'overview' }
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'script' }

interface RunDetail {
  snapshot: {
    name: string
    status: string
    stopReason?: string
    resumable?: boolean
    live?: boolean
    scriptPath?: string
    spentTokens?: number
    maxConcurrency?: number
    nodes?: { queued: number; running: number; completed: number; failed: number }
    actors?: { siteId: string; ordinal: number; name?: string; sessionId?: string }[]
    reports?: { count: number; preview: string[] }
    result?: unknown
    failure?: { code: string; message: string }
    pendingQuestions?: { qid: string; question: string; actorName?: string }[]
    openHoles?: { siteId: string; ordinal: number; name: string }[]
    logTail: string[]
    artifacts: ArtifactInfo[]
  }
  script: string | null
  graph: CreateWorkflowCausalityGraph | null
  parentSessionId?: string | null
  durationMs?: number | null
  savedAs?: SavedRunRef | null
  canSave?: boolean
}

function snapshotToRunState(runId: string, snapshot: RunDetail['snapshot']): WorkflowRunState {
  const status = (snapshot.status === 'pending' || snapshot.status === 'running' || snapshot.status === 'completed' || snapshot.status === 'errored' || snapshot.status === 'stopped')
    ? snapshot.status
    : 'stopped'
  const actorStatus = status === 'running' ? 'running' : 'completed'
  return {
    runId,
    status,
    ...snapshot.stopReason === undefined ? {} : { stopReason: snapshot.stopReason as NonNullable<WorkflowRunState['stopReason']> },
    ...snapshot.resumable === true ? { resumable: true as const } : {},
    actors: (snapshot.actors ?? []).map(actor => ({
      siteId: actor.siteId,
      ordinal: actor.ordinal,
      status: actorStatus,
      ...actor.name === undefined ? {} : { name: actor.name },
      ...actor.sessionId === undefined ? {} : { sessionId: actor.sessionId },
    })),
    nodes: [],
    usage: {
      spentTokens: snapshot.spentTokens ?? 0,
      nodesUsed: (snapshot.nodes?.completed ?? 0) + (snapshot.nodes?.failed ?? 0) + (snapshot.nodes?.running ?? 0),
    },
    ...snapshot.maxConcurrency !== undefined && snapshot.maxConcurrency > 0
      ? { concurrency: { cap: snapshot.maxConcurrency, ceiling: snapshot.maxConcurrency, limit: snapshot.maxConcurrency } }
      : {},
    ...snapshot.result !== undefined ? { resultPreview: typeof snapshot.result === 'string' ? snapshot.result : JSON.stringify(snapshot.result) } : {},
    ...snapshot.failure !== undefined ? { error: snapshot.failure.message } : {},
    ...(snapshot.reports?.preview.length ?? 0) > 0
      ? { reports: snapshot.reports!.preview.map((preview, idx) => ({ siteId: 'journal', ordinal: idx, preview })) }
      : {},
    ...snapshot.artifacts.length > 0
      ? {
        artifacts: snapshot.artifacts.map(a => ({
          id: a.id,
          kind: a.kind as NonNullable<WorkflowRunState['artifacts']>[number]['kind'],
          version: a.version,
          itemCount: a.itemCount ?? 0,
          ...a.title === undefined ? {} : { title: a.title },
          ...a.description === undefined ? {} : { description: a.description },
          ...a.primary ? { primary: true as const } : {},
        })),
      }
      : {},
    ...(snapshot.pendingQuestions?.length ?? 0) > 0
      ? { pendingQuestions: snapshot.pendingQuestions!.map(q => ({ qid: q.qid, question: q.question, ...q.actorName === undefined ? {} : { actorName: q.actorName } })) }
      : {},
    ...(snapshot.openHoles?.length ?? 0) > 0
      ? { holes: snapshot.openHoles!.map(h => ({ siteId: h.siteId, ordinal: h.ordinal, name: h.name, state: 'waiting' as const })) }
      : {},
    lastEventSequence: 0,
  }
}

export interface RunPaneInjected {
  openChild: (childSessionId: string) => void
}

export interface RunPaneProps extends RunPaneInjected {
  t: Translate
  sessionId: string
  useProjection: UseProjection
  useTabInfo: () => { tab: { navigation: { params: unknown; revision: number } } }
}

function initialSubView(params: Partial<RunTabParams> | undefined): PaneSubView {
  if (params?.focusArtifactId !== undefined) return { kind: 'artifact', artifactId: params.focusArtifactId }
  if (params?.scriptLog === true) return { kind: 'script' }
  return { kind: 'overview' }
}

export function RunPane({ t, sessionId, useProjection, useTabInfo, openChild }: RunPaneProps) {
  const tab = useTabInfo()
  const params = tab.tab.navigation.params as Partial<RunTabParams> | undefined
  const [selected, setSelected] = useState<string | undefined>(params?.runId)
  const [subView, setSubView] = useState<PaneSubView>(() => initialSubView(params))
  useEffect(() => {
    if (params?.runId !== undefined) setSelected(params.runId)
    setSubView(initialSubView(params))
  }, [params?.runId, params?.focusArtifactId, params?.scriptLog, tab.tab.navigation.revision])
  const runs = useProjection(RUNS_PROJECTION, state => state?.runs)
  const run = useProjection(RUNS_PROJECTION, state => findRun(state, { runId: selected }))
  if (selected === undefined) {
    return <RunList runs={runs ?? []} t={t} onSelect={(id) => { setSelected(id); setSubView({ kind: 'overview' }) }} missing={false} sessionId={sessionId} />
  }
  return (
    <RunDetailView
      runId={selected}
      run={run}
      subView={subView}
      onChangeSubView={setSubView}
      t={t}
      sessionId={sessionId}
      openChild={openChild}
      onBack={() => setSelected(undefined)}
      onSelectRun={(nextId) => {
        setSelected(nextId === '' ? undefined : nextId)
        setSubView({ kind: 'overview' })
      }}
    />
  )
}

interface SessionRunRow {
  runId: string
  name: string
  status: string
  stopReason?: string
  spentTokens: number
  updated: number
}

function RunList({ runs, t, onSelect, missing, sessionId }: { runs: readonly WorkflowRunState[]; t: Translate; onSelect: (runId: string) => void; missing: boolean; sessionId: string }) {
  const [rows, setRows] = useState<SessionRunRow[] | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    apiGet<{ runs: SessionRunRow[] }>(`sessions/${encodeURIComponent(sessionId)}/runs`, controller.signal)
      .then(value => setRows(value.runs), () => undefined)
    return () => controller.abort()
  }, [sessionId, runs.length])
  const liveById = new Map(runs.map(r => [r.runId, r]))
  const items: { runId: string; name?: string; dot: 'done' | 'error' | 'ongoing' | 'warning' | 'idle'; statusText: string; tokens: number }[] = []
  const seen = new Set<string>()
  for (const run of [...runs].reverse()) {
    const meta = rows?.find(r => r.runId === run.runId)
    seen.add(run.runId)
    items.push({
      runId: run.runId,
      ...meta?.name === undefined ? {} : { name: meta.name },
      dot: runDot(run),
      statusText: runStatusText(run, t),
      tokens: Math.max(run.usage.spentTokens, meta?.spentTokens ?? 0),
    })
  }
  for (const meta of rows ?? []) {
    if (seen.has(meta.runId) || liveById.has(meta.runId)) continue
    seen.add(meta.runId)
    const dot = meta.status === 'completed' ? 'done' : meta.status === 'errored' || meta.status === 'failed' ? 'error' : meta.status === 'running' ? 'ongoing' : meta.status === 'stopped' ? 'warning' : 'idle'
    const statusText = t(`status.${meta.status === 'failed' ? 'errored' : meta.status}` as Parameters<Translate>[0])
    items.push({ runId: meta.runId, name: meta.name, dot, statusText, tokens: meta.spentTokens })
  }
  return (
    <div className="dwf-pane">
      {missing ? <p className="dwf-muted">{t('pane.missing')}</p> : null}
      <section className="dwf-pane-section">
        <h4>{t('pane.runs')}</h4>
        {items.length === 0 ? <div className="dwf-empty-card">{t('pane.empty')}</div> : (
          <ul className="dwf-run-list">
            {items.map(item => (
              <li key={item.runId}>
                <button type="button" className="dwf-run-list-item" onClick={() => onSelect(item.runId)}>
                  <StateDot state={item.dot} size={10} />
                  <span className="dwf-run-list-body">
                    <span className="dwf-run-list-title">{item.name ?? item.runId.replace(/^dwfrun-/u, '').slice(0, 8)}</span>
                    <span className="dwf-run-list-sub">
                      <code className="dwf-run-list-id">{item.runId.replace(/^dwfrun-/u, '').slice(0, 8)}</code>
                      <span>{item.statusText}</span>
                      {item.tokens > 0 ? <span title={`${formatExactTokens(item.tokens)} tokens`}>{formatTokens(item.tokens)} tokens</span> : null}
                    </span>
                  </span>
                  <span className="dwf-run-list-arrow" aria-hidden>›</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <WorkflowsHome sessionId={sessionId} t={t} onOpenRun={onSelect} />
    </div>
  )
}

function RunDetailView({
  runId,
  run: projected,
  subView,
  onChangeSubView,
  t,
  sessionId,
  openChild,
  onBack,
  onSelectRun,
}: {
  runId: string
  run: WorkflowRunState | undefined
  subView: PaneSubView
  onChangeSubView: (next: PaneSubView) => void
  t: Translate
  sessionId: string
  openChild: (id: string) => void
  onBack: () => void
  onSelectRun: (runId: string) => void
}) {
  const [detail, setDetail] = useState<RunDetail | null | undefined>(undefined)
  const [savedOverride, setSavedOverride] = useState<SavedRunRef | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const names = useMemo(() => namerOf(t), [t])
  const status = projected?.status
  const filled = projected?.holes?.filter(hole => hole.state === 'filled').length ?? 0
  const artifactKey = (projected?.artifacts ?? []).map(a => `${a.id}@${a.version}`).join(',')
  const [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  useEffect(() => {
    setDetail(undefined)
    setSavedOverride(undefined)
    setNotice(undefined)
  }, [runId])

  useEffect(() => {
    const controller = new AbortController()
    apiGet<RunDetail>(`runs/${encodeURIComponent(runId)}`, controller.signal).then(setDetail, () => { if (!controller.signal.aborted) setDetail(null) })
    return () => controller.abort()
  }, [runId, status, filled, artifactKey, refresh])

  const run = useMemo(() => {
    if (projected !== undefined) return reconcileRun(projected, detail?.snapshot ?? undefined)
    if (detail !== undefined && detail !== null) return snapshotToRunState(runId, detail.snapshot)
    return undefined
  }, [runId, projected, detail])
  const model = useMemo(() => (detail?.graph === undefined || detail.graph === null ? undefined : buildWorkflowTimeline(detail.graph, run)), [detail, run])
  const artifacts = useMemo(() => {
    if (detail === undefined || detail === null) return []
    const liveById = new Map((projected?.artifacts ?? []).map(a => [a.id, a]))
    return detail.snapshot.artifacts.map((artifact) => {
      const live = liveById.get(artifact.id)
      return live === undefined ? artifact : { ...artifact, itemCount: live.itemCount }
    })
  }, [detail, projected?.artifacts])

  const control = async (action: 'stop' | 'resume'): Promise<void> => {
    setBusy(true)
    try {
      const answer = await apiPost<{ ok?: boolean; message?: string }>(`runs/${encodeURIComponent(runId)}/${action}`)
      setNotice(answer.ok === false ? answer.message ?? action : undefined)
    } catch (error) {
      setNotice(String(error))
    } finally { setBusy(false); setRefresh(value => value + 1) }
  }
  const retune = async (delta: number): Promise<void> => {
    const current = run?.concurrency?.limit ?? run?.concurrency?.ceiling ?? run?.concurrency?.cap ?? 4
    setBusy(true)
    try {
      const answer = await apiPost<{ ok?: boolean; message?: string }>(`runs/${encodeURIComponent(runId)}/retune`, { maxConcurrency: Math.max(1, current + delta) })
      setNotice(answer.ok === false ? answer.message : undefined)
    } catch (error) {
      setNotice(String(error))
    } finally { setBusy(false) }
  }
  const counts = run === undefined ? undefined : taskCounts(run)

  const configurable = run !== undefined && (run.status === 'running' || run.status === 'errored' || (run.status === 'stopped' && run.stopReason !== 'superseded'))
  const currentSettings: RunSettingsValue | undefined = run === undefined ? undefined : {
    maxConcurrency: run.concurrency?.limit ?? run.concurrency?.ceiling ?? run.concurrency?.cap ?? 4,
    subagentModel: run.subagentModel ?? null,
  }
  const [configuring, setConfiguring] = useState<RunSettingsValue | undefined>(undefined)
  useEffect(() => { setConfiguring(undefined) }, [runId])
  const applyConfigure = async (): Promise<void> => {
    if (configuring === undefined || currentSettings === undefined) return
    const changed = changedSettings(configuring, currentSettings)
    if (Object.keys(changed).length === 0) { setConfiguring(undefined); return }
    setBusy(true)
    try {
      const answer = await apiPost<{ ok?: boolean; message?: string; runId?: string }>(`runs/${encodeURIComponent(runId)}/configure`, changed)
      if (answer.ok === false) setNotice(answer.message ?? 'configure')
      else {
        setNotice(answer.runId !== undefined && answer.runId !== runId ? t('pane.configuredNew') : t('pane.configured'))
        setConfiguring(undefined)
      }
    } catch (error) {
      setNotice(String(error))
    } finally { setBusy(false); setRefresh(value => value + 1) }
  }

  if (detail === null && projected === undefined) {
    return (
      <div className="dwf-pane">
        <div className="dwf-pane-head">
          <button type="button" className="dwf-icon-btn" aria-label={t('confirm.back')} onClick={onBack}>←</button>
          <h3 className="dwf-pane-title">{runId}</h3>
        </div>
        <div className="dwf-empty-card">{t('pane.missing')}</div>
      </div>
    )
  }

  // Dedicated sub-views (keep the main Run Overview completely uncluttered!)
  if (subView.kind === 'artifact') {
    const target = artifacts.find(a => a.id === subView.artifactId)
    if (target !== undefined) {
      return <ArtifactReaderView runId={runId} artifact={target} t={t} onBack={() => onChangeSubView({ kind: 'overview' })} />
    }
  }
  if (subView.kind === 'script') {
    return <ScriptLogbookView runId={runId} script={detail?.script} t={t} onBack={() => onChangeSubView({ kind: 'overview' })} />
  }

  const savedAs = savedOverride !== undefined ? savedOverride : detail?.savedAs
  const canSave = detail?.canSave === true && (run?.status === 'completed' || (savedAs !== null && savedAs !== undefined))
  const cancellable = run?.status === 'running'
  const agentsCount = run?.actors.length ?? 0
  const spentTokens = Math.max(run?.usage.spentTokens ?? 0, detail?.snapshot.spentTokens ?? 0)
  const unattributedQuestions = (run?.pendingQuestions ?? []).filter(q => model === undefined || q.actorSiteId === undefined || q.actorOrdinal === undefined)

  // ZCode summary line (`WorkflowRunSidePaneSections.tsx` L306-332):
  // `☰ <model · > 7 个子代理 · 16/16 步 · 23,695,436 tokens · 2 个产物`
  const summaryParts: string[] = []
  if (run?.subagentModel !== undefined) summaryParts.push(shortModel(run.subagentModel))
  if (agentsCount > 0) summaryParts.push(t('card.agents', { count: agentsCount }))
  if (counts !== undefined && counts.total > 0) summaryParts.push(t('pane.summary.steps', counts))
  summaryParts.push(t('card.tokens', { tokens: formatExactTokens(spentTokens) }))
  if (artifacts.length > 0) summaryParts.push(t('pane.summary.artifacts', { count: artifacts.length }))

  return (
    <div className="dwf-pane dwf-pane-overview" data-run-status={run?.status ?? 'unknown'}>
      {/* ZCode 2-row header */}
      <div className="dwf-pane-header-block">
        <div className="dwf-pane-top-row">
          <button type="button" className="dwf-back-subtle" aria-label={t('confirm.back')} title={t('pane.runs')} onClick={onBack}>‹</button>
          <h3 className="dwf-pane-title" title={runId}>{detail?.snapshot.name ?? runId}</h3>
          <span className="dwf-card-actions">
            {configurable && configuring === undefined ? (
              <button type="button" className="dwf-action-pill" disabled={busy} onClick={() => setConfiguring(currentSettings)}>
                {t('pane.configure')}
              </button>
            ) : null}
            {run?.status === 'stopped' && run.resumable === true ? (
              <Button size="sm" variant="outline" icon={<IconRefreshOutlineRegular size={12} />} disabled={busy} onClick={() => { void control('resume') }}>
                {t('card.resume')}
              </Button>
            ) : null}
            {canSave ? (
              <SaveWorkflowControls
                runId={runId}
                runName={detail?.snapshot.name}
                sessionId={detail?.parentSessionId ?? sessionId}
                savedAs={savedAs}
                t={t}
                onSaved={saved => setSavedOverride(saved)}
                onOpenRun={onSelectRun}
              />
            ) : null}
            <button
              type="button"
              className="dwf-action-pill"
              disabled={!cancellable || busy}
              onClick={() => { void control('stop') }}
              data-dwf-stop-btn=""
            >
              <IconStopFillRegular size={11} />
              <span>{t('pane.stopRun')}</span>
            </button>
          </span>
        </div>

        {run !== undefined ? (
          <div className="dwf-pane-status-row">
            <span className="dwf-pane-status-word" data-status={run.status}>
              <StateDot state={runDot(run)} size={10} />
              {run.status === 'running' ? <TextShimmer active>{runStatusText(run, t)}</TextShimmer> : <span>{runStatusText(run, t)}</span>}
            </span>
            <SavedStatusBadge savedAs={savedAs} t={t} />
            {run.concurrency !== undefined && run.status === 'running' ? (
              <span className="dwf-retune">
                <span>{t('card.concurrency', { value: Math.min(run.concurrency.cap, run.concurrency.limit ?? run.concurrency.cap) })}</span>
                <button type="button" className="dwf-step" aria-label={t('pane.concurrency.down')} disabled={busy} onClick={() => { void retune(-2) }}>−</button>
                <button type="button" className="dwf-step" aria-label={t('pane.concurrency.up')} disabled={busy} onClick={() => { void retune(2) }}>+</button>
              </span>
            ) : null}
          </div>
        ) : null}

        {run !== undefined ? (
          <div className="dwf-pane-summary" data-dwf-usage="">
            <span className="dwf-pane-summary-icon" aria-hidden>☰</span>
            {summaryParts.map((part, idx) => (
              <span key={idx} className="dwf-pane-summary-item">
                {idx > 0 ? <span className="dwf-pane-dot" aria-hidden>·</span> : null}
                <span>{part}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {configuring !== undefined && currentSettings !== undefined ? (
        <div className="dwf-configure" data-dwf-configure="">
          <SettingsFields value={configuring} original={currentSettings} onChange={setConfiguring} t={t} disabled={busy} />
          <p className="dwf-muted dwf-configure-hint">{configuring.subagentModel !== currentSettings.subagentModel || run?.status !== 'running' ? t('pane.configureRevision') : t('pane.configureRetune')}</p>
          <div className="dwf-confirm-actions">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfiguring(undefined)}>{t('pane.cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy || Object.keys(changedSettings(configuring, currentSettings)).length === 0} onClick={() => { void applyConfigure() }}>{t('pane.apply')}</Button>
          </div>
        </div>
      ) : null}

      {notice !== undefined ? <p className="dwf-attention">{notice}</p> : null}

      {/* Clean ZCode Result / Error section */}
      {run?.status === 'completed' ? (
        <section className="dwf-pane-result-bar">
          <span className="dwf-pane-result-label">{t('card.result')}</span>
          <p className="dwf-pane-result-hint">{t('pane.result.completedHint')}</p>
        </section>
      ) : null}
      {run !== undefined && run.error !== undefined && run.status !== 'completed' ? (
        <section className="dwf-pane-result-bar dwf-pane-error-bar">
          <span className="dwf-pane-result-label">{t('card.error')}</span>
          <p className="dwf-pane-error-msg">{run.error}</p>
        </section>
      ) : null}

      <div className="dwf-pane-spine-scroll">
        {model !== undefined ? (
          <RunSpine
            model={model}
            graph={detail?.graph}
            run={run}
            names={names}
            t={t}
            openChild={openChild}
            onOpenWorkspace={() => onChangeSubView({ kind: 'script' })}
          />
        ) : null}

        {unattributedQuestions.length > 0 ? (
          <section className="dwf-pane-section">
            <h4>{t('pane.questions')}</h4>
            <ul className="dwf-plain-list">{unattributedQuestions.map(q => <li key={q.qid}><strong>{q.actorName ?? q.actorSiteId ?? '?'}</strong> — {q.question}</li>)}</ul>
          </section>
        ) : null}
        {model === undefined && run !== undefined && (run.holes?.length ?? 0) > 0 ? (
          <section className="dwf-pane-section">
            <h4>{t('pane.holes')}</h4>
            <ul className="dwf-plain-list">{run.holes!.map(h => <li key={`${h.siteId}@${h.ordinal}`}><StateDot state={h.state === 'filled' ? 'done' : 'warning'} size={10} /> {h.name}{h.type === undefined ? '' : ` · ${h.type}`}</li>)}</ul>
          </section>
        ) : null}
      </div>

      {artifacts.length > 0 ? (
        <CompactArtifactsSection
          artifacts={artifacts}
          t={t}
          onOpenArtifact={artifactId => onChangeSubView({ kind: 'artifact', artifactId })}
        />
      ) : null}
    </div>
  )
}
