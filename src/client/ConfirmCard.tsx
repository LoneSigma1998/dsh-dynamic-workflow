/**
 * The launch confirmation (ZCode's confirmation window), rendered in the composer seat for the
 * `dynamic-workflow-confirm` question: the script's phase graph as a static timeline, the run
 * settings, the script itself, and Run / Always allow in this session / Deny / Request changes.
 *
 * The question carries markdown only; the graph comes from the Host half
 * (`GET dynamic-workflow/api/sessions/:id/pending-launch`). If that read fails the card still
 * works from the question text alone.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, IconLayersOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingLaunch } from '../tools/confirm.ts'
import type { ComposerChainProps, PendingQuestionLike, Translate } from './host-types.ts'
import { buildWorkflowTimeline } from './model/timeline/timeline-model.ts'
import { apiGet, namerOf } from './run-view.ts'
import { Timeline } from './Timeline.tsx'
import { changedSettings, SettingsFields, type RunSettingsValue } from './Settings.tsx'

export const CONFIRM_QUESTION_ID = 'dynamic-workflow-confirm'
const LABELS = { allow: 'Allow', always: 'Always allow in this session', deny: 'Deny', refine: 'Refine' } as const
/** Mirrors the Host's `SETTINGS_ANSWER_PREFIX`: an Allow answer carrying the settings the user changed. */
const SETTINGS_ANSWER_PREFIX = 'dwf-settings:'

export interface ConfirmMatch {
  pending: PendingQuestionLike
  item: PendingQuestionLike['questions'][number]
}

export function selectConfirm(owner: ComposerChainProps): ConfirmMatch | null {
  const pending = owner.pendingInteraction as PendingQuestionLike | undefined
  if (pending?.kind !== 'question' || pending.questions?.length !== 1) return null
  const item = pending.questions[0]!
  return item.id === CONFIRM_QUESTION_ID ? { pending, item } : null
}

export function ConfirmCard({ matched, t }: { matched: ConfirmMatch; t: Translate }) {
  const { pending, item } = matched
  const snapshot = useSyncExternalStore(pending.subscribe, pending.getSnapshot, pending.getSnapshot)
  const canAnswer = snapshot.channel !== 'none' && !snapshot.closed
  const [launch, setLaunch] = useState<PendingLaunch | null | undefined>(undefined)
  const [showScript, setShowScript] = useState<boolean | undefined>(undefined)
  const [refining, setRefining] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const names = useMemo(() => namerOf(t), [t])
  const isSnippet = launch?.tool === 'eval_workflow_snippet'
  const isSave = launch?.tool === 'save_workflow'
  const isWorkflow = launch !== undefined && launch !== null && !isSnippet && !isSave
  const original = useMemo<RunSettingsValue | undefined>(() => (!isWorkflow
    ? undefined
    : { maxConcurrency: launch.settings.maxConcurrency, subagentModel: launch.settings.subagentModel ?? null }), [isWorkflow, launch])
  const [settings, setSettings] = useState<RunSettingsValue | undefined>(undefined)
  useEffect(() => { setSettings(original) }, [original])

  useEffect(() => {
    const controller = new AbortController()
    let tries = 0
    const read = (): void => {
      apiGet<{ pending: PendingLaunch | null }>(`sessions/${encodeURIComponent(pending.sessionId)}/pending-launch`, controller.signal)
        .then((value) => {
          if (value.pending === null && tries < 3) {
            tries += 1
            setTimeout(read, 250)
            return
          }
          setLaunch(value.pending)
        })
        .catch(() => { if (!controller.signal.aborted) setLaunch(null) })
    }
    read()
    return () => controller.abort()
  }, [pending.sessionId, pending.key])

  const model = useMemo(() => (launch?.display.causalityGraph === undefined ? undefined : buildWorkflowTimeline(launch.display.causalityGraph, undefined)), [launch])
  const name = launch?.name ?? item.question
  const isAmend = launch?.tool === 'amend_workflow'
  const scriptVisible = showScript ?? (isSnippet || isSave)
  const optionLabels = item.options?.map(o => o.label)
  const allowAlways = launch !== undefined && launch !== null
    ? launch.allowAlways !== false
    : (optionLabels === undefined || optionLabels.includes(LABELS.always))
  const allowRefine = launch !== undefined && launch !== null
    ? !isSave
    : (optionLabels === undefined || optionLabels.includes(LABELS.refine))
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') } },
    footnotes: t('markdown.footnotes'),
  }), [t])

  const answer = async (selected: string, custom?: string): Promise<void> => {
    if (!canAnswer || sending) return
    if (isWorkflow && (selected === LABELS.allow || selected === LABELS.always) && custom === undefined && settings !== undefined && original !== undefined) {
      const changed = changedSettings(settings, original)
      if (Object.keys(changed).length > 0) custom = `${SETTINGS_ANSWER_PREFIX}${JSON.stringify(changed)}`
    }
    setSending(true)
    setFailure(undefined)
    try {
      await pending.answer({ answers: [{ id: item.id, selected: [selected], ...custom === undefined ? {} : { custom } }] })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  const agents = launch?.display.causalityGraph?.lanes.filter(lane => lane.id !== 'workspace' && lane.id !== 'unknown').length ?? 0
  const holes = model?.stations.filter(station => station.hole !== undefined) ?? []
  const heading = launch === undefined || launch === null
    ? item.question
    : isSave
      ? t('confirm.save', { name })
      : isSnippet
        ? t('confirm.snippet')
        : t(isAmend ? 'confirm.amend' : 'confirm.run', { name })
  return (
    <section className="dwf-confirm" aria-label={item.header ?? t('card.title')} data-dwf-confirm={launch?.tool ?? ''}>
      <header className="dwf-confirm-head">
        <span className="dwf-card-icon" aria-hidden><IconLayersOutlineRegular size={16} /></span>
        <h3 className="dwf-confirm-title">{heading}</h3>
      </header>
      {launch === undefined ? <p className="dwf-muted">{t('confirm.loading')}</p> : null}
      {launch !== undefined && launch !== null ? (
        <>
          {isSnippet && (launch.commands?.length ?? 0) > 0 ? (
            <div className="dwf-confirm-commands" data-dwf-confirm-commands="">
              <span className="dwf-setting-label">{t('confirm.snippetCommands')}</span>
              {launch.commands!.map((cmd, idx) => <code key={`${cmd}:${idx}`} className="dwf-chip">{cmd}</code>)}
            </div>
          ) : null}
          {isSave && launch.saveTarget !== undefined ? (
            <div className="dwf-confirm-save" data-dwf-confirm-save="">
              <div className="dwf-card-meta">
                <span>{t(`saved.scope.${launch.saveTarget.scope}`)}</span>
                <code>{launch.saveTarget.path}</code>
              </div>
              {launch.saveTarget.overwrites ? <p className="dwf-attention">{t('confirm.saveOverwrite')}</p> : null}
              {launch.saveTarget.description !== '' ? <p className="dwf-saved-desc">{launch.saveTarget.description}</p> : null}
            </div>
          ) : null}
          {isWorkflow ? (
            <>
              <div className="dwf-card-meta">
                {model !== undefined ? <span>{t('card.phases', { count: model.stations.length })}</span> : null}
                {agents > 0 ? <span>{t('card.agents', { count: agents })}</span> : null}
              </div>
              {settings !== undefined && original !== undefined ? <SettingsFields value={settings} original={original} onChange={setSettings} t={t} disabled={!canAnswer || sending} /> : null}
              {model !== undefined ? <Timeline model={model} names={names} t={t} /> : null}
              {holes.length > 0 ? <p className="dwf-muted dwf-confirm-holes">{t('confirm.holes', { count: holes.length })}</p> : null}
            </>
          ) : null}
          <button type="button" className="dwf-link" onClick={() => setShowScript(!scriptVisible)}>{scriptVisible ? t('confirm.hideScript') : t('confirm.showScript')}</button>
          {scriptVisible ? <pre className="dwf-code dwf-confirm-script">{launch.scriptText}</pre> : null}
        </>
      ) : null}
      {launch === null && item.detail !== undefined ? <div className="dwf-confirm-detail"><MarkdownText text={item.detail} labels={markdownLabels} variant="compact" /></div> : null}
      {failure !== undefined ? <p className="dwf-attention">{failure}</p> : null}
      {refining && allowRefine ? (
        <div className="dwf-refine">
          <textarea
            className="dwf-refine-input"
            autoFocus
            rows={3}
            placeholder={t('confirm.refinePlaceholder')}
            value={feedback}
            onChange={event => setFeedback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && feedback.trim() !== '') void answer(LABELS.refine, feedback.trim())
            }}
          />
          <div className="dwf-confirm-actions">
            <Button size="sm" variant="ghost" onClick={() => setRefining(false)}>{t('confirm.back')}</Button>
            <Button size="sm" variant="primary" disabled={!canAnswer || sending || feedback.trim() === ''} onClick={() => { void answer(LABELS.refine, feedback.trim()) }}>{t('confirm.send')}</Button>
          </div>
        </div>
      ) : (
        <div className="dwf-confirm-actions">
          {allowRefine ? <Button size="sm" variant="ghost" disabled={!canAnswer || sending} onClick={() => setRefining(true)}>{t('confirm.refine')}</Button> : null}
          <Button size="sm" variant="outline" disabled={!canAnswer || sending} onClick={() => { void answer(LABELS.deny) }}>{t('confirm.deny')}</Button>
          {allowAlways ? <Button size="sm" variant="outline" disabled={!canAnswer || sending} onClick={() => { void answer(LABELS.always) }}>{t('confirm.always')}</Button> : null}
          <Button size="sm" variant="primary" disabled={!canAnswer || sending} onClick={() => { void answer(LABELS.allow) }}>{isSave ? t('confirm.saveAllow') : t('confirm.allow')}</Button>
        </div>
      )}
    </section>
  )
}
