/**
 * Right-sidebar run pane (page tab `dynamic-workflow-run`): the whole run on one surface —
 * header with status and controls, the full timeline (every pill, no roster cap), the per-phase
 * subagent roll with each transcript one click away, open questions and holes, reports,
 * artifacts, the outcome, and the script. Live state is the same `dynamicWorkflowRuns`
 * projection the card reads; the static parts (graph, script, name) come from the Host route.
 * Opened without params (a restored layout) it lists this session's runs.
 */

import { useEffect, useMemo, useState } from 'react'
import { Button, IconRefreshOutlineRegular, IconStopFillRegular, StateDot, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CreateWorkflowCausalityGraph } from '../display/types.ts'
import type { WorkflowRunState } from '../shared/runs/workflow-runs.ts'
import type { Translate, UseProjection } from './host-types.ts'
import { laneDisplayName } from './model/graph/lane-name.ts'
import { phaseDisplayName } from './model/graph/phase-name.ts'
import { buildWorkflowTimeline, type TimelinePill } from './model/timeline/timeline-model.ts'
import { apiGet, apiPost, findRun, formatTokens, namerOf, reconcileRun, RUNS_PROJECTION, runDot, runStatusText, shortModel, stepDot, taskCounts } from './run-view.ts'
import { Timeline } from './Timeline.tsx'
import { changedSettings, SettingsFields, type RunSettingsValue } from './Settings.tsx'
import { ArtifactList, ChangesSection, ScriptSteps, useChanges, type ArtifactInfo } from './RunExtras.tsx'
import { WorkflowsHome } from './SavedWorkflows.tsx'
import { readableResult } from './WorkflowToolCard.tsx'

export const RUN_TAB_KIND = 'dynamic-workflow-run'
export const RUN_TAB_ID = 'dsh-dynamic-workflow:run'

export interface RunTabParams { sessionId: string; runId: string }

interface RunDetail {
  snapshot: { name: string; status: string; stopReason?: string; resumable?: boolean; live?: boolean; scriptPath?: string; logTail: string[]; artifacts: ArtifactInfo[] }
  script: string | null
  graph: CreateWorkflowCausalityGraph | null
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

export function RunPane({ t, sessionId, useProjection, useTabInfo, openChild }: RunPaneProps) {
  const tab = useTabInfo()
  const params = tab.tab.navigation.params as Partial<RunTabParams> | undefined
  const [selected, setSelected] = useState<string | undefined>(params?.runId)
  useEffect(() => { if (params?.runId !== undefined) setSelected(params.runId) }, [params?.runId, tab.tab.navigation.revision])
  const runs = useProjection(RUNS_PROJECTION, state => state?.runs)
  const run = useProjection(RUNS_PROJECTION, state => findRun(state, { runId: selected }))
  if (selected === undefined || (run === undefined && runs !== undefined && !runs.some(r => r.runId === selected))) {
    return <RunList runs={runs ?? []} t={t} onSelect={setSelected} missing={selected !== undefined} sessionId={sessionId} />
  }
  return <RunDetailView runId={selected} run={run} t={t} sessionId={sessionId} openChild={openChild} onBack={() => setSelected(undefined)} />
}

function RunList({ runs, t, onSelect, missing, sessionId }: { runs: readonly WorkflowRunState[]; t: Translate; onSelect: (runId: string) => void; missing: boolean; sessionId: string }) {
  return (
    <div className="dwf-pane">
      {missing ? <p className="dwf-muted">{t('pane.missing')}</p> : null}
      <h3 className="dwf-pane-heading">{t('pane.runs')}</h3>
      {runs.length === 0 ? <p className="dwf-muted">{t('pane.empty')}</p> : (
        <ul className="dwf-run-list">
          {[...runs].reverse().map(run => (
            <li key={run.runId}>
              <button type="button" className="dwf-run-list-item" onClick={() => onSelect(run.runId)}>
                <StateDot state={runDot(run)} size={12} />
                <span className="dwf-run-list-id">{run.runId.replace(/^dwfrun-/u, '').slice(0, 8)}</span>
                <span className="dwf-muted">{runStatusText(run, t)}</span>
                <span className="dwf-muted">{formatTokens(run.usage.spentTokens)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <WorkflowsHome sessionId={sessionId} t={t} onOpenRun={onSelect} />
    </div>
  )
}

function RunDetailView({ runId, run: projected, t, openChild, onBack }: { runId: string; run: WorkflowRunState | undefined; t: Translate; sessionId: string; openChild: (id: string) => void; onBack: () => void }) {
  const [detail, setDetail] = useState<RunDetail | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [scriptOpen, setScriptOpen] = useState(false)
  const names = useMemo(() => namerOf(t), [t])
  const status = projected?.status
  const [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  // a different run: drop the previous run's static half before the new one loads
  useEffect(() => { setDetail(undefined); setNotice(undefined) }, [runId])
  useEffect(() => {
    const controller = new AbortController()
    apiGet<RunDetail>(`runs/${encodeURIComponent(runId)}`, controller.signal).then(setDetail, () => { if (!controller.signal.aborted) setDetail(null) })
    return () => controller.abort()
    // refresh the static half when the run settles (artifacts, log tail)
  }, [runId, status, refresh])
  const run = useMemo(() => reconcileRun(projected, detail?.snapshot ?? undefined), [projected, detail])
  const model = useMemo(() => (detail?.graph === undefined || detail.graph === null ? undefined : buildWorkflowTimeline(detail.graph, run)), [detail, run])
  const control = async (action: 'stop' | 'resume'): Promise<void> => {
    setBusy(true)
    try {
      const answer = await apiPost<{ ok?: boolean; message?: string }>(`runs/${encodeURIComponent(runId)}/${action}`)
      setNotice(answer.ok === false ? answer.message ?? action : undefined)
    } catch (error) {
      setNotice(String(error))
    } finally { setBusy(false); setRefresh(value => value + 1) }
  }
  /** In-place retune of this run's own bound (ZCode's run settings): the shared governor still caps it. */
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
  const onOpenPill = (pill: TimelinePill): void => { if (pill.instance?.sessionId !== undefined) openChild(pill.instance.sessionId) }
  const counts = run === undefined ? undefined : taskCounts(run)
  const changes = useChanges(runId, `${run?.status ?? ''}:${run?.usage.nodesUsed ?? 0}:${refresh}`)
  const changedBySession = new Map((changes ?? []).map(entry => [entry.sessionId, entry.files.length]))
  // Configure (ZCode's popover): a GUI revision of the settings, no model turn and no confirmation
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
  return (
    <div className="dwf-pane" data-run-status={run?.status ?? 'unknown'}>
      <div className="dwf-pane-head">
        <button type="button" className="dwf-link" onClick={onBack}>←</button>
        <h3 className="dwf-pane-title" title={runId}>{detail?.snapshot.name ?? runId}</h3>
        {run !== undefined ? (
          <span className="dwf-card-status">
            <StateDot state={runDot(run)} size={12} />
            {run.status === 'running' ? <TextShimmer active>{runStatusText(run, t)}</TextShimmer> : <span>{runStatusText(run, t)}</span>}
          </span>
        ) : null}
        <span className="dwf-card-actions">
          {run?.status === 'running' ? <Button size="sm" variant="ghost" icon={<IconStopFillRegular size={12} />} disabled={busy} onClick={() => { void control('stop') }}>{t('card.stop')}</Button> : null}
          {run?.status === 'stopped' && run.resumable === true ? <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular size={12} />} disabled={busy} onClick={() => { void control('resume') }}>{t('card.resume')}</Button> : null}
          {configurable && configuring === undefined ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfiguring(currentSettings)}>{t('pane.configure')}</Button> : null}
        </span>
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
      {run !== undefined ? (
        <div className="dwf-card-meta">
          {counts !== undefined && counts.total > 0 ? <span>{t('card.tasks', counts)}</span> : null}
          <span>{t('card.tokens', { tokens: formatTokens(run.usage.spentTokens) })}</span>
          {run.concurrency !== undefined ? (
            <span className="dwf-retune">
              {t('card.concurrency', { value: Math.min(run.concurrency.cap, run.concurrency.limit ?? run.concurrency.cap) })}
              {run.status === 'running' ? (
                <>
                  <button type="button" className="dwf-step" aria-label={t('pane.concurrency.down')} disabled={busy} onClick={() => { void retune(-2) }}>−</button>
                  <button type="button" className="dwf-step" aria-label={t('pane.concurrency.up')} disabled={busy} onClick={() => { void retune(2) }}>+</button>
                </>
              ) : null}
            </span>
          ) : null}
          {run.subagentModel !== undefined ? <span title={run.subagentModel}>{t('card.model', { model: shortModel(run.subagentModel) })}</span> : null}
        </div>
      ) : null}
      {notice !== undefined ? <p className="dwf-attention">{notice}</p> : null}
      {model !== undefined ? <Timeline model={model} names={names} t={t} onOpenPill={onOpenPill} pins={50} maxPillRows={50} /> : null}

      {run !== undefined && (run.pendingQuestions?.length ?? 0) > 0 ? (
        <section className="dwf-pane-section">
          <h4>{t('pane.questions')}</h4>
          <ul className="dwf-plain-list">{run.pendingQuestions!.map(q => <li key={q.qid}><strong>{q.actorName ?? q.actorSiteId ?? '?'}</strong> — {q.question}</li>)}</ul>
        </section>
      ) : null}
      {run !== undefined && (run.holes?.length ?? 0) > 0 ? (
        <section className="dwf-pane-section">
          <h4>{t('pane.holes')}</h4>
          <ul className="dwf-plain-list">{run.holes!.map(h => <li key={`${h.siteId}@${h.ordinal}`}><StateDot state={h.state === 'filled' ? 'done' : 'warning'} size={10} /> {h.name}{h.type === undefined ? '' : ` · ${h.type}`}</li>)}</ul>
        </section>
      ) : null}

      {model !== undefined ? (
        <section className="dwf-pane-section">
          <h4>{t('pane.agents')}</h4>
          {model.stations.filter(station => station.pills.length > 0).map(station => (
            <div key={station.id} className="dwf-roll">
              <div className="dwf-roll-phase"><StateDot state={stepDot(station.status)} size={10} /> {phaseDisplayName(station.naming, names)}</div>
              <ul className="dwf-plain-list">
                {station.pills.map(pill => {
                  const name = pill.runtimeName ?? laneDisplayName(pill.lane, names)
                  const node = run?.nodes.find(n => pill.instance !== undefined && n.actorSiteId === pill.instance.siteId && n.actorOrdinal === pill.instance.ordinal && n.phase !== 'settled')
                    ?? run?.nodes.filter(n => pill.instance !== undefined && n.actorSiteId === pill.instance.siteId && n.actorOrdinal === pill.instance.ordinal).at(-1)
                  const session = pill.instance?.sessionId
                  return (
                    <li key={pill.key} className="dwf-roll-row">
                      <StateDot state={stepDot(pill.status)} size={10} />
                      {session !== undefined
                        ? <button type="button" className="dwf-link" onClick={() => openChild(session)}>{name}</button>
                        : <span>{name}</span>}
                      {node?.toolCalls !== undefined && node.toolCalls > 0 ? <span className="dwf-muted">{t('pane.toolCalls', { count: node.toolCalls })}</span> : null}
                      {node?.lastTool !== undefined ? <span className="dwf-muted">{t('pane.lastTool', { tool: node.lastTool.name })}</span> : null}
                      {node?.cached === true ? <span className="dwf-muted">{t('pane.cached')}</span> : null}
                      {session !== undefined && (changedBySession.get(session) ?? 0) > 0 ? <span className="dwf-change-badge">{t('changes.count', { count: changedBySession.get(session)! })}</span> : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {run?.status === 'completed' && run.resultPreview !== undefined ? (
        <section className="dwf-pane-section"><h4>{t('card.result')}</h4><pre className="dwf-code dwf-pane-result">{readableResult(run.resultPreview)}</pre></section>
      ) : null}
      {run !== undefined && run.error !== undefined && run.status !== 'completed' ? (
        <section className="dwf-pane-section"><h4>{t('card.error')}</h4><pre className="dwf-code dwf-outcome-error">{run.error}</pre></section>
      ) : null}
      {(run?.reports?.length ?? 0) > 0 ? (
        <section className="dwf-pane-section"><h4>{t('pane.reports')}</h4><ul className="dwf-reports">{run!.reports!.map((r, i) => <li key={`${r.siteId}@${r.ordinal}:${i}`}>{r.preview}</li>)}</ul></section>
      ) : null}
      {detail !== undefined && detail !== null ? <ArtifactList runId={runId} artifacts={detail.snapshot.artifacts} t={t} /> : null}
      <ChangesSection runId={runId} changes={changes} t={t} openChild={openChild} />
      <ScriptSteps runId={runId} revision={`${run?.status ?? ''}:${run?.usage.nodesUsed ?? 0}:${refresh}`} t={t} />
      {detail?.script !== undefined && detail.script !== null ? (
        <section className="dwf-pane-section">
          <button type="button" className="dwf-link" onClick={() => setScriptOpen(open => !open)}>{scriptOpen ? t('confirm.hideScript') : t('confirm.showScript')}</button>
          {scriptOpen ? <pre className="dwf-code">{detail.script}</pre> : null}
        </section>
      ) : null}
    </div>
  )
}
