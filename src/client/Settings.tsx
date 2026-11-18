/**
 * The two run settings as editable sentences (ZCode's confirmation-window ask settings and its
 * Configure popover): max concurrency and the subagent model. A changed value shows
 * "· 原为 X ↺" — the original and a one-click reset. The model list comes from the Host half
 * (`GET models`), fetched once per page.
 */

import { useEffect, useState } from 'react'
import type { Translate } from './host-types.ts'
import { apiGet, shortModel } from './run-view.ts'

export interface RunSettingsValue {
  maxConcurrency: number
  /** `null`: the session model. */
  subagentModel: string | null
}

let models: Promise<{ id: string; name: string }[]> | undefined
function modelList(): Promise<{ id: string; name: string }[]> {
  models ??= apiGet<{ models: { id: string; name: string }[] }>('models').then(value => value.models, () => {
    models = undefined // a transient failure is retried by the next card
    return []
  })
  return models
}

/** The fields that differ from `original` (what an answer or a Configure call should carry). */
export function changedSettings(value: RunSettingsValue, original: RunSettingsValue): Partial<RunSettingsValue> {
  return {
    ...value.maxConcurrency === original.maxConcurrency ? {} : { maxConcurrency: value.maxConcurrency },
    ...value.subagentModel === original.subagentModel ? {} : { subagentModel: value.subagentModel },
  }
}

export function SettingsFields({ value, original, onChange, t, disabled }: {
  value: RunSettingsValue
  original: RunSettingsValue
  onChange: (next: RunSettingsValue) => void
  t: Translate
  disabled?: boolean
}) {
  const [list, setList] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    let live = true
    void modelList().then((value) => { if (live) setList(value) })
    return () => { live = false }
  }, [])
  const known = new Set(list.map(model => model.id))
  const options = [...list]
  for (const id of [value.subagentModel, original.subagentModel]) {
    if (id !== null && !known.has(id)) options.unshift({ id, name: shortModel(id) })
  }
  const label = (id: string | null): string => (id === null ? t('settings.sessionModel') : shortModel(id))
  const step = (delta: number): void => onChange({ ...value, maxConcurrency: Math.max(1, Math.min(64, value.maxConcurrency + delta)) })
  return (
    <div className="dwf-settings" data-dwf-settings="">
      <div className="dwf-setting">
        <span className="dwf-setting-label">{t('settings.concurrency')}</span>
        <button type="button" className="dwf-step" aria-label={t('pane.concurrency.down')} disabled={disabled === true || value.maxConcurrency <= 1} onClick={() => step(-1)}>−</button>
        <span className="dwf-chip" data-dwf-setting="concurrency">{value.maxConcurrency}</span>
        <button type="button" className="dwf-step" aria-label={t('pane.concurrency.up')} disabled={disabled === true || value.maxConcurrency >= 64} onClick={() => step(1)}>+</button>
        {value.maxConcurrency !== original.maxConcurrency ? (
          <button type="button" className="dwf-setting-was" disabled={disabled} onClick={() => onChange({ ...value, maxConcurrency: original.maxConcurrency })}>{t('settings.was', { value: String(original.maxConcurrency) })}</button>
        ) : null}
      </div>
      <div className="dwf-setting">
        <span className="dwf-setting-label">{t('settings.model')}</span>
        <select
          className="dwf-chip dwf-select"
          data-dwf-setting="model"
          disabled={disabled}
          value={value.subagentModel ?? ''}
          onChange={event => onChange({ ...value, subagentModel: event.target.value === '' ? null : event.target.value })}
        >
          <option value="">{t('settings.sessionModel')}</option>
          {options.map(model => <option key={model.id} value={model.id}>{shortModel(model.id)}</option>)}
        </select>
        {value.subagentModel !== original.subagentModel ? (
          <button type="button" className="dwf-setting-was" disabled={disabled} onClick={() => onChange({ ...value, subagentModel: original.subagentModel })}>{t('settings.was', { value: label(original.subagentModel) })}</button>
        ) : null}
      </div>
    </div>
  )
}
