/**
 * Tool card for `create_workflow` / `amend_workflow` (and the compact `fill_workflow_hole` row).
 *
 *   preparing — the pen: stations land as the model writes `phase("…")` (draft scan of the
 *               streaming `script` argument), with the agent count in the header;
 *   start     — the same draft while the harness typechecks and asks for confirmation;
 *   result    — the analyzer's causality graph as the timeline, lit live by the
 *               `dynamicWorkflowRuns` session projection (one clock for every surface), with
 *               run controls, the outcome, and a door into the run pane.
 */

import { useCallback, useMemo, useState } from 'react'
import { Button, DisclosureRow, IconChevronRightOutlineRegular, IconLayersOutlineRegular, IconRefreshOutlineRegular, IconStopFillRegular, StateDot, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkflowLaunchDisplay } from '../display/types.ts'
import type { WorkflowRunState } from '../shared/runs/workflow-runs.ts'
import type { ToolCallViewProps, Translate } from './host-types.ts'
import { draftTimeline, scanWorkflowDraft } from './model/timeline/draft-scan.ts'
import { buildWorkflowTimeline, type TimelinePill } from './model/timeline/timeline-model.ts'
import { apiPost, findRun, formatTokens, launchDisplayOf, namerOf, RUNS_PROJECTION, runDot, runStatusText, shortModel, taskCounts } from './run-view.ts'
import { Timeline } from './Timeline.tsx'

export interface WorkflowCardInjected {
  openChild: (childSessionId: string) => void
  openRun: (runId: string) => void
}

type Props = ToolCallViewProps & WorkflowCardInjected

function argsOf(props: ToolCallViewProps): { name?: string; script?: string; path?: string } {
  if (props.phase === 'result') {
    const raw = props.block.call?.argsRaw
    if (raw === undefined) return {}
    try {
      const parsed = JSON.parse(raw) as { name?: unknown; script?: unknown; path?: unknown }
      return {
        ...typeof parsed.name === 'string' ? { name: parsed.name } : {},
        ...typeof parsed.script === 'string' ? { script: parsed.script } : {},
        ...typeof parsed.path === 'string' ? { path: parsed.path } : {},
      }
    } catch {
      return {}
    }
  }
  const args = props.block.args
  const name = args.text('name')
  const script = args.text('script')
  const path = args.text('path')
  return { ...name === undefined ? {} : { name }, ...script === undefined ? {} : { script }, ...path === undefined ? {} : { path } }
}

function resultText(props: ToolCallViewProps): string {
  if (props.phase !== 'result') return ''
  return props.block.content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n')
}

export function WorkflowToolCard(props: Props) {
  const { t, useProjection, callId, openChild, openRun } = props
  const names = useMemo(() => namerOf(t), [t])
  const args = argsOf(props)
  const display: WorkflowLaunchDisplay | undefined = props.phase === 'result' ? launchDisplayOf(props.block.meta) : undefined
  const runId = display?.runId
  const run = useProjection(RUNS_PROJECTION, state => findRun(state, { ...runId === undefined ? {} : { runId }, toolCallId: callId }))
  const { expanded: scriptOpen, toggle: toggleScript } = props.useDisclosure()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const draftModel = useMemo(() => (args.script === undefined ? undefined : draftTimeline(scanWorkflowDraft(args.script))), [args.script])
  const graph = display?.causalityGraph
  const liveModel = useMemo(() => (graph === undefined ? undefined : buildWorkflowTimeline(graph, run)), [graph, run])
  const model = liveModel ?? draftModel

  const onOpenPill = useCallback((pill: TimelinePill) => {
    const child = pill.instance?.sessionId
    if (child !== undefined) openChild(child)
  }, [openChild])

  const title = display?.name ?? args.name ?? t('card.untitled')
  const isAmend = props.toolName === 'amend_workflow'
  const control = async (action: 'stop' | 'resume'): Promise<void> => {
    if (run === undefined) return
    setBusy(true)
    try {
      const answer = await apiPost<{ ok?: boolean; message?: string }>(`runs/${encodeURIComponent(run.runId)}/${action}`)
      setNotice(answer.ok === false ? answer.message ?? action : undefined)
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }

  // header status line
  let status: { dot: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'; text: string; shimmer?: boolean }
  if (props.phase === 'preparing') status = { dot: 'ongoing', text: t('card.writing'), shimmer: true }
  else if (props.phase === 'start') status = { dot: 'ongoing', text: t('card.awaiting'), shimmer: true }
  else if (display === undefined) status = { dot: props.block.isError ? 'error' : 'idle', text: props.block.isError ? t('card.error') : t('card.launched') }
  else if (!display.ok && display.denied !== undefined) status = { dot: 'warning', text: display.denied.reason === 'refined' ? t('card.refined') : t('card.denied') }
  else if (!display.ok) status = { dot: 'error', text: t('card.diagnostics', { count: display.errorCount }) }
  else if (run !== undefined) status = { dot: runDot(run), text: runStatusText(run, t), shimmer: run.status === 'running' }
  else status = { dot: 'idle', text: display.retuned !== undefined ? t('card.amend.retuned', { previous: display.retuned.previous ?? '?', applied: display.retuned.applied }) : t('card.launched') }

  const stations = model?.stations.length ?? 0
  const agents = model?.draft?.agents ?? (graph?.lanes.filter(lane => lane.id !== 'workspace' && lane.id !== 'unknown').length ?? 0)

  return (
    <section className="dwf-card" data-dwf-card={props.toolName} data-phase={props.phase} data-run-status={run?.status ?? 'none'}>
      <header className="dwf-card-head">
        <span className="dwf-card-icon" aria-hidden><IconLayersOutlineRegular size={14} /></span>
        <span className="dwf-card-kind">{isAmend ? t('card.amend.title') : t('card.title')}</span>
        <span className="dwf-card-title" title={title}>{title}</span>
        <span className="dwf-card-status">
          <StateDot state={status.dot} size={12} />
          {status.shimmer === true ? <TextShimmer active>{status.text}</TextShimmer> : <span>{status.text}</span>}
        </span>
        <span className="dwf-card-actions">
          {run?.status === 'running' ? (
            <Button size="sm" variant="ghost" icon={<IconStopFillRegular size={12} />} disabled={busy} onClick={() => { void control('stop') }}>{t('card.stop')}</Button>
          ) : null}
          {run?.status === 'stopped' && run.resumable === true ? (
            <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular size={12} />} disabled={busy} onClick={() => { void control('resume') }}>{t('card.resume')}</Button>
          ) : null}
          {run !== undefined ? (
            <Button size="sm" variant="ghost" icon={<IconChevronRightOutlineRegular size={12} />} onClick={() => openRun(run.runId)}>{t('card.open')}</Button>
          ) : null}
        </span>
      </header>

      <div className="dwf-card-meta">
        {stations > 0 ? <span>{t('card.phases', { count: stations })}</span> : null}
        {agents > 0 ? <span>{t('card.agents', { count: agents })}</span> : null}
        {run !== undefined ? <RunMeta run={run} t={t} /> : null}
        {run === undefined && display?.maxConcurrency !== undefined ? <span>{t('card.concurrency', { value: display.maxConcurrency })}</span> : null}
      </div>

      {/* Once a run exists, its live timeline is the turn-level run node (RunNode.tsx): it stays
          visible after DSH folds the turn's tool calls. The card keeps the draft / confirmation /
          diagnostics view. */}
      {model !== undefined && stations > 0 && runId === undefined ? (
        <Timeline model={model} names={names} t={t} onOpenPill={run === undefined ? undefined : onOpenPill} />
      ) : null}

      {display !== undefined && !display.ok && display.diagnostics.length > 0 ? (
        <ul className="dwf-diagnostics">
          {display.diagnostics.slice(0, 12).map((d, i) => (
            <li key={i}><code>L{d.line}:{d.column}</code> {d.message}</li>
          ))}
        </ul>
      ) : null}

      {display?.denied?.feedback !== undefined && display.denied.feedback !== '' ? <p className="dwf-feedback">{display.denied.feedback}</p> : null}
      {notice !== undefined ? <p className="dwf-attention">{notice}</p> : null}
      {display === undefined && props.phase === 'result' && props.block.isError ? <pre className="dwf-error">{resultText(props)}</pre> : null}

      {args.script !== undefined && props.phase !== 'preparing' ? (
        <DisclosureRow
          className="dwf-script-row"
          icon={<IconChevronRightOutlineRegular size={12} />}
          title={t('card.script')}
          open={scriptOpen}
          expandable
          expandOnRowClick
          onToggle={toggleScript}
          collapsedContent={<span className="dwf-muted">{display?.scriptPath ?? t('card.lines', { count: args.script.split('\n').length })}</span>}
        >
          <pre className="dwf-code">{args.script}</pre>
        </DisclosureRow>
      ) : null}
    </section>
  )
}

export function RunMeta({ run, t }: { run: WorkflowRunState; t: Translate }) {
  const counts = taskCounts(run)
  return (
    <>
      {counts.total > 0 ? <span>{t('card.tasks', counts)}</span> : null}
      {run.usage.spentTokens > 0 ? <span>{t('card.tokens', { tokens: formatTokens(run.usage.spentTokens) })}</span> : null}
      {run.concurrency !== undefined ? <span>{t('card.concurrency', { value: Math.min(run.concurrency.cap, run.concurrency.limit ?? run.concurrency.cap) })}</span> : null}
      {run.subagentModel !== undefined ? <span title={run.subagentModel}>{t('card.model', { model: shortModel(run.subagentModel) })}</span> : null}
    </>
  )
}

export function RunOutcome({ run, t }: { run: WorkflowRunState; t: Translate }) {
  const questions = run.pendingQuestions?.length ?? 0
  const waitingHole = run.holes?.find(hole => hole.state === 'waiting')
  const [resultOpen, setResultOpen] = useState(false)
  const result = run.resultPreview === undefined ? undefined : readableResult(run.resultPreview)
  const long = result !== undefined && (result.split('\n').length > 8 || result.length > 600)
  return (
    <>
      {questions > 0 ? <p className="dwf-attention">{t('card.questions', { count: questions })}</p> : null}
      {waitingHole !== undefined ? <p className="dwf-attention">{t('card.hole', { name: waitingHole.name })}</p> : null}
      {run.status === 'completed' && result !== undefined ? (
        <div className="dwf-outcome">
          <span className="dwf-outcome-label">{t('card.result')}</span>
          <pre className={long && !resultOpen ? 'dwf-clamped' : undefined}>{result}</pre>
          {long ? <button type="button" className="dwf-link dwf-more" onClick={() => setResultOpen(open => !open)}>{resultOpen ? t('card.less') : t('card.more')}</button> : null}
        </div>
      ) : null}
      {(run.status === 'errored' || (run.status === 'stopped' && run.stopReason !== 'superseded')) && run.error !== undefined ? (
        <div className="dwf-outcome dwf-outcome-error"><span className="dwf-outcome-label">{t('card.error')}</span><pre>{run.error}</pre></div>
      ) : null}
      {run.stopReason === 'superseded' ? <p className="dwf-muted">{t('card.superseded')}</p> : null}
      {(run.reports?.length ?? 0) > 0 ? (
        <ul className="dwf-reports" aria-label={t('card.reports', { count: run.reports!.length })}>
          {run.reports!.slice(-3).map((report, i) => <li key={`${report.siteId}@${report.ordinal}:${i}`}>{report.preview}</li>)}
        </ul>
      ) : null}
    </>
  )
}

/**
 * A run's return value for people: a JSON string is unwrapped, and an object whose only long
 * field is prose (a report, a summary) shows that prose; everything else stays pretty JSON.
 */
export function readableResult(preview: string): string {
  try {
    const value = JSON.parse(preview) as unknown
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const prose = Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v.length > 120)
      if (prose.length === 1) {
        const rest = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => k !== prose[0]![0]))
        const head = Object.keys(rest).length === 0 ? '' : `${JSON.stringify(rest, null, 2)}\n\n`
        return `${head}${String(prose[0]![1])}`
      }
    }
    return JSON.stringify(value, null, 2)
  } catch {
    return preview // truncated preview: show as is
  }
}

/** `fill_workflow_hole`: a compact row; the run itself keeps drawing on its launch card. */
export function FillHoleRow(props: Props) {
  const { t } = props
  const display = props.phase === 'result' ? launchDisplayOf(props.block.meta) : undefined
  const { expanded, toggle } = props.useDisclosure()
  const hole = display?.fill?.name ?? (props.phase === 'result' ? '' : props.block.args.text('hole_id') ?? '')
  const body = props.phase === 'result'
    ? (() => {
      try {
        const parsed = JSON.parse(props.block.call?.argsRaw ?? '{}') as { script?: unknown; path?: unknown; body?: unknown }
        return String(parsed.script ?? parsed.path ?? parsed.body ?? '')
      } catch {
        return ''
      }
    })()
    : props.block.args.text('script') ?? props.block.args.text('path') ?? props.block.args.text('body') ?? ''
  const running = props.phase !== 'result'
  const failed = display !== undefined && !display.ok
  return (
    <div className="dwf-fill" data-dwf-card="fill_workflow_hole">
      <DisclosureRow
        icon={<IconLayersOutlineRegular size={14} />}
        title={t('card.fill.title')}
        open={expanded}
        expandable={body !== ''}
        expandOnRowClick
        onToggle={toggle}
        running={running}
        collapsedContent={<span className="dwf-muted">{failed ? t('card.diagnostics', { count: display!.errorCount }) : t('card.fill.done', { hole })}</span>}
      >
        <pre className="dwf-code">{body}</pre>
      </DisclosureRow>
    </div>
  )
}
