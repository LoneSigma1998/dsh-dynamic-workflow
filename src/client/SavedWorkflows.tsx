/**
 * The workflows half of the run pane's list view (ZCode's automations hub and its mode row):
 *
 * - **Routing** for this session — only on request / suggest / auto — the switch that decides
 *   whether the model may propose or start workflows on its own.
 * - **Saved workflows**, global first, then this workspace's: name, description, the latest runs
 *   (click to open), and 「运行」, which starts the saved workflow directly — no model turn and no
 *   confirmation; the click is the consent (ZCode's hub). Declared arguments without defaults are
 *   asked for inline first.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './host-types.ts'
import { apiGet, apiPost, formatTokens } from './run-view.ts'

type Routing = 'explicit' | 'suggest' | 'auto'

interface SavedArg { type?: 'string' | 'number' | 'boolean' | 'json'; description?: string; default?: unknown; required?: boolean }
interface SavedRun { runId: string; status: string; stopReason?: string; updated: number; spentTokens: number; mine: boolean }
interface SavedItem { name: string; description: string; whenToUse?: string; scope: 'project' | 'global'; args?: Record<string, SavedArg>; runs: SavedRun[] }

function statusDot(status: string): 'done' | 'error' | 'ongoing' | 'warning' | 'idle' {
  switch (status) {
    case 'completed': return 'done'
    case 'failed': case 'errored': return 'error'
    case 'running': return 'ongoing'
    case 'cancelled': case 'stopped': return 'warning'
    default: return 'idle'
  }
}

function parseArg(spec: SavedArg, raw: string): unknown {
  if (spec.type === 'number') return Number(raw)
  if (spec.type === 'boolean') return raw === 'true'
  if (spec.type === 'json') { try { return JSON.parse(raw) as unknown } catch { return raw } }
  return raw
}

function SavedRow({ item, sessionId, t, onOpenRun, canRun }: { item: SavedItem; sessionId: string; t: Translate; onOpenRun: (runId: string) => void; canRun: boolean }) {
  const declared = Object.entries(item.args ?? {})
  // required-without-default first (they must be filled), then the optional ones (default shown)
  const needed = declared.filter(([, spec]) => spec.required === true && spec.default === undefined)
  const fields = [...needed, ...declared.filter(([, spec]) => !(spec.required === true && spec.default === undefined))]
  const [asking, setAsking] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const run = async (): Promise<void> => {
    if (needed.length > 0 && !asking) { setAsking(true); return }
    setBusy(true)
    try {
      const args = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '').map(([key, value]) => [key, parseArg(item.args?.[key] ?? {}, value)]))
      const answer = await apiPost<{ ok: boolean; runId?: string; message?: string }>(`sessions/${encodeURIComponent(sessionId)}/saved/run`, { name: item.name, scope: item.scope, args })
      if (answer.ok && answer.runId !== undefined) {
        setAsking(false)
        setNotice(undefined)
        onOpenRun(answer.runId)
      } else setNotice(answer.message ?? 'run')
    } catch (error) {
      setNotice(String(error))
    } finally { setBusy(false) }
  }
  return (
    <li className="dwf-saved-item" data-dwf-saved={item.name}>
      <div className="dwf-saved-head">
        <span className="dwf-saved-name">{item.name}</span>
        <span className="dwf-muted">{t(`saved.scope.${item.scope}`)}</span>
        {canRun && fields.length > needed.length && !asking ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(true)}>{t('saved.args')}</Button> : null}
        {canRun ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run() }}>{t('saved.run')}</Button> : null}
      </div>
      {item.description !== '' ? <p className="dwf-saved-desc">{item.description}</p> : null}
      {asking ? (
        <div className="dwf-saved-args">
          {fields.map(([key, spec]) => (
            <label key={key} className="dwf-setting" title={spec.description}>
              <span className="dwf-setting-label">{key}{spec.required === true && spec.default === undefined ? ' *' : ''}</span>
              <input
                className="dwf-chip dwf-input"
                value={values[key] ?? ''}
                placeholder={spec.default !== undefined ? t('saved.default', { value: typeof spec.default === 'string' ? spec.default : JSON.stringify(spec.default) }) : spec.description ?? spec.type ?? ''}
                onChange={event => setValues(prev => ({ ...prev, [key]: event.target.value }))}
              />
            </label>
          ))}
          <div className="dwf-confirm-actions">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>{t('pane.cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy || needed.some(([key]) => (values[key] ?? '') === '')} onClick={() => { void run() }}>{t('saved.run')}</Button>
          </div>
        </div>
      ) : null}
      {item.runs.length > 0 ? (
        <ul className="dwf-saved-runs">
          {item.runs.map(entry => (
            <li key={entry.runId}>
              <button type="button" className="dwf-run-list-item" disabled={!entry.mine} title={entry.mine ? undefined : t('saved.otherSession')} onClick={() => onOpenRun(entry.runId)}>
                <StateDot state={statusDot(entry.status)} size={10} />
                <span className="dwf-run-list-id">{new Date(entry.updated).toLocaleString()}</span>
                <span className="dwf-muted">{formatTokens(entry.spentTokens)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {notice !== undefined ? <p className="dwf-attention">{notice}</p> : null}
    </li>
  )
}

export function WorkflowsHome({ sessionId, t, onOpenRun }: { sessionId: string; t: Translate; onOpenRun: (runId: string) => void }) {
  const [routing, setRouting] = useState<Routing | undefined>(undefined)
  const [mode, setMode] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState<{ items: SavedItem[]; canRun: boolean } | undefined>(undefined)
  const load = useCallback(() => {
    const controller = new AbortController()
    apiGet<{ mode: string; routing: Routing }>(`sessions/${encodeURIComponent(sessionId)}/settings`, controller.signal)
      .then((value) => { setRouting(value.routing); setMode(value.mode) }, () => undefined)
    apiGet<{ saved: SavedItem[]; canRun?: boolean }>(`sessions/${encodeURIComponent(sessionId)}/saved`, controller.signal)
      .then(value => setSaved({ items: value.saved, canRun: value.canRun !== false }), () => setSaved({ items: [], canRun: false }))
    return () => controller.abort()
  }, [sessionId])
  useEffect(() => load(), [load])
  const changeRouting = async (next: Routing): Promise<void> => {
    setRouting(next)
    try { await apiPost(`sessions/${encodeURIComponent(sessionId)}/routing`, { routing: next }) } catch { load() }
  }
  const groups = (['global', 'project'] as const).map(scope => ({ scope, items: saved?.items.filter(item => item.scope === scope) ?? [] }))
  return (
    <>
      {routing !== undefined && mode !== 'disabled' ? (
        <section className="dwf-pane-section" data-dwf-routing="">
          <h4>{t('routing.title')}</h4>
          <div className="dwf-segmented" role="radiogroup" aria-label={t('routing.title')}>
            {(['explicit', 'suggest', 'auto'] as const).map(option => (
              <button key={option} type="button" role="radio" aria-checked={routing === option} className="dwf-segment" data-active={routing === option ? '' : undefined} onClick={() => { void changeRouting(option) }}>{t(`routing.${option}`)}</button>
            ))}
          </div>
          <p className="dwf-muted dwf-configure-hint">{t(`routing.${routing}.hint`)}</p>
        </section>
      ) : null}
      <section className="dwf-pane-section" data-dwf-saved-list="">
        <h4>{t('saved.title')}</h4>
        {saved === undefined ? <p className="dwf-muted">{t('confirm.loading')}</p> : null}
        {saved !== undefined && saved.items.length === 0 ? <p className="dwf-muted">{t('saved.empty')}</p> : null}
        {groups.filter(group => group.items.length > 0).map(group => (
          <div key={group.scope}>
            <ul className="dwf-saved-list">
              {group.items.map(item => <SavedRow key={`${item.scope}:${item.name}`} item={item} sessionId={sessionId} t={t} onOpenRun={onOpenRun} canRun={saved?.canRun === true} />)}
            </ul>
          </div>
        ))}
      </section>
    </>
  )
}
