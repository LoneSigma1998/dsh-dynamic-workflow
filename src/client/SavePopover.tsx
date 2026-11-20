/**
 * ZCode-parity "Save & Distill Workflow" popover and header controls (`WorkflowSavePopover.tsx`
 * + `workflowRunSave.ts`, Apache-2.0):
 *
 *   1. Primary CTA: "✦ 让 DSH 帮我提炼保存" — sends ZCode's 5-point distillation prompt into the
 *      parent session so the main model lifts changing values into `args`, writes `description`
 *      and `whenToUse`, and calls `save_workflow(..., from_run_id)` for confirmation.
 *   2. Secondary form below divider: "或按原样直接保存" — validates `[A-Za-z0-9_.-]` (<=64 chars),
 *      debounces 320ms collision/shadowing check, previews `.dsh/workflows/<name>.dwf.ts`, and
 *      writes directly to disk with zero token cost.
 *   3. Provenance loop: once saved, renders the `已保存` badge + `再次运行` button.
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './host-types.ts'
import { SaveFloppyIcon, SparkleIcon } from './AgentFace.tsx'
import { apiGet, apiPost } from './run-view.ts'

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u
const MAX_NAME_CHARS = 64
const PROBE_DEBOUNCE_MS = 320

export interface SavedRunRef {
  name: string
  scope: 'project' | 'global'
  hasRequiredArgs?: boolean
}

export function isValidWorkflowFileName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return false
  if (!NAME_PATTERN.test(name)) return false
  return name.replaceAll('.', '').length > 0
}

export function savedPathPreview(scope: 'project' | 'global', name: string): string {
  const file = `${name.length > 0 ? name : '…'}.dwf.ts`
  return scope === 'global' ? `~/.dsh/workflows/${file}` : `.dsh/workflows/${file}`
}

export function SaveWorkflowControls({
  runId,
  runName,
  sessionId,
  savedAs,
  t,
  onSaved,
  onOpenRun,
}: {
  runId: string
  runName?: string | undefined
  sessionId?: string | undefined
  savedAs?: SavedRunRef | null | undefined
  t: Translate
  onSaved: (saved: SavedRunRef) => void
  onOpenRun?: ((runId: string) => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const [runningAgain, setRunningAgain] = useState(false)
  const [toast, setToast] = useState<string | undefined>(undefined)
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target !== null && wrapRef.current !== null && !wrapRef.current.contains(target)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (toast === undefined) return undefined
    const timer = setTimeout(() => setToast(undefined), 3600)
    return () => clearTimeout(timer)
  }, [toast])

  if (savedAs !== undefined && savedAs !== null) {
    const handleRunAgain = async () => {
      if (sessionId === undefined || runningAgain) return
      // If required arguments without defaults exist, open the Workflows home panel to fill them.
      if (savedAs.hasRequiredArgs === true) {
        onOpenRun?.('')
        return
      }
      setRunningAgain(true)
      try {
        const res = await apiPost<{ ok: boolean; runId?: string; message?: string }>(
          `sessions/${encodeURIComponent(sessionId)}/saved/run`,
          { name: savedAs.name, scope: savedAs.scope, args: {} },
        )
        if (res.ok && res.runId !== undefined) onOpenRun?.(res.runId)
        else if (res.message !== undefined) setToast(res.message)
      } catch (error) {
        setToast(String(error))
      } finally {
        setRunningAgain(false)
      }
    }
    return (
      <span className="dwf-save-controls">
        <span className="dwf-saved-chip" title={`${savedPathPreview(savedAs.scope, savedAs.name)}`}>✓ {t('save.saved')}</span>
        {sessionId !== undefined ? (
          <Button size="sm" variant="outline" disabled={runningAgain} onClick={(e) => { e.stopPropagation(); void handleRunAgain() }}>
            {t('save.runAgain')}
          </Button>
        ) : null}
        {toast !== undefined ? <span className="dwf-save-toast">{toast}</span> : null}
      </span>
    )
  }

  return (
    <span className="dwf-save-anchor" ref={wrapRef} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className="dwf-action-pill"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-dwf-save-btn=""
        onClick={() => setOpen(v => !v)}
      >
        <SaveFloppyIcon size={13} />
        <span>{t('save.button')}</span>
      </button>
      {toast !== undefined ? <span className="dwf-save-toast">{toast}</span> : null}
      {open ? (
        <SavePopoverBody
          runId={runId}
          runName={runName}
          t={t}
          onClose={() => setOpen(false)}
          onDistillSent={() => {
            setOpen(false)
            setToast(t('save.leadSent'))
          }}
          onSaved={(saved) => {
            onSaved(saved)
            setOpen(false)
          }}
        />
      ) : null}
    </span>
  )
}

function SavePopoverBody({
  runId,
  runName,
  t,
  onClose,
  onDistillSent,
  onSaved,
}: {
  runId: string
  runName?: string | undefined
  t: Translate
  onClose: () => void
  onDistillSent: () => void
  onSaved: (saved: SavedRunRef) => void
}) {
  const trimmedRun = (runName ?? '').trim()
  const [name, setName] = useState(() => (isValidWorkflowFileName(trimmedRun) ? trimmedRun : ''))
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [description, setDescription] = useState(trimmedRun)
  const [probe, setProbe] = useState({ taken: false, shadowing: false })
  const [saving, setSaving] = useState(false)
  const [distilling, setDistilling] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

  const cleanName = name.trim()
  const nameInvalid = cleanName.length > 0 && !isValidWorkflowFileName(cleanName)
  const canDirectSave = cleanName.length > 0 && !nameInvalid && !saving && !distilling

  useEffect(() => {
    setProbe({ taken: false, shadowing: false })
    if (cleanName.length === 0 || !isValidWorkflowFileName(cleanName)) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      apiGet<{ taken: boolean; shadowing: boolean }>(
        `runs/${encodeURIComponent(runId)}/save-probe?name=${encodeURIComponent(cleanName)}&scope=${scope}`,
        controller.signal,
      ).then(res => setProbe(res), () => undefined)
    }, PROBE_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [runId, cleanName, scope])

  const locale: 'zh' | 'en' = t('card.title') === '工作流' ? 'zh' : 'en'

  const handleDistill = async () => {
    if (distilling || saving) return
    setDistilling(true)
    setError(undefined)
    try {
      const res = await apiPost<{ ok: boolean; message?: string }>(`runs/${encodeURIComponent(runId)}/distill`, {
        name: cleanName,
        scope,
        description: description.trim(),
        locale,
      })
      if (res.ok) onDistillSent()
      else setError(res.message ?? 'distill failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDistilling(false)
    }
  }

  const handleDirectSave = async () => {
    if (!canDirectSave) return
    setSaving(true)
    setError(undefined)
    try {
      const res = await apiPost<{ ok: boolean; name?: string; scope?: 'project' | 'global'; reason?: string; message?: string }>(
        `runs/${encodeURIComponent(runId)}/save`,
        {
          name: cleanName,
          scope,
          description: description.trim() || cleanName,
          ...(probe.taken ? { overwrite: true } : {}),
        },
      )
      if (res.ok) {
        onSaved({ name: res.name ?? cleanName, scope: res.scope ?? scope })
        return
      }
      if (res.reason === 'target_exists') {
        setProbe(prev => ({ ...prev, taken: true }))
        return
      }
      setError(res.message ?? res.reason ?? 'save failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="dwf-save-popover"
      role="dialog"
      aria-label={t('save.title')}
      data-dwf-save-popover=""
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          void handleDistill()
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="dwf-save-pop-title">{t('save.title')}</div>

      <button
        type="button"
        className="dwf-save-lead-btn"
        disabled={distilling || saving}
        onClick={() => { void handleDistill() }}
        data-dwf-save-lead=""
      >
        <SparkleIcon size={14} />
        <span>{distilling ? t('save.leadSending') : t('save.lead')}</span>
      </button>
      <p className="dwf-save-hint">{t('save.leadHint')}</p>

      <div className="dwf-save-divider"><span>{t('save.divider')}</span></div>

      <label className="dwf-save-field">
        <span className="dwf-save-label">{t('save.name')}</span>
        <div className="dwf-save-name-box" data-invalid={nameInvalid ? '' : undefined}>
          <input
            ref={nameInputRef}
            className="dwf-save-name-input"
            value={name}
            placeholder="pr-layered-review"
            maxLength={MAX_NAME_CHARS}
            onChange={(e) => { setName(e.target.value); setError(undefined) }}
          />
          <span className="dwf-save-ext">.dwf.ts</span>
        </div>
        <span className={nameInvalid ? 'dwf-save-warn' : 'dwf-save-subhint'}>
          {nameInvalid ? t('save.nameInvalid') : t('save.nameHint')}
        </span>
      </label>

      <label className="dwf-save-field">
        <span className="dwf-save-label">{t('save.scope')}</span>
        <select
          className="dwf-save-select"
          value={scope}
          onChange={e => setScope(e.target.value === 'global' ? 'global' : 'project')}
        >
          <option value="project">{t('save.scopeProject')}</option>
          <option value="global">{t('save.scopeGlobal')}</option>
        </select>
      </label>

      <label className="dwf-save-field">
        <span className="dwf-save-label">{t('save.desc')}</span>
        <textarea
          className="dwf-save-textarea"
          rows={2}
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
        <span className="dwf-save-subhint">{t('save.descHint')}</span>
      </label>

      {probe.taken ? <p className="dwf-save-warn">{t('save.takenWarn')}</p> : null}
      {!probe.taken && probe.shadowing ? <p className="dwf-save-subhint">{t('save.shadowWarn')}</p> : null}
      {error !== undefined ? <p className="dwf-save-warn">{error}</p> : null}

      <p className="dwf-save-path">{t('save.pathHint', { path: savedPathPreview(scope, cleanName) })}</p>

      <div className="dwf-save-footer">
        <button
          type="button"
          className="dwf-save-direct-btn"
          disabled={!canDirectSave}
          onClick={() => { void handleDirectSave() }}
          data-dwf-save-direct=""
        >
          {saving ? t('save.saving') : probe.taken ? t('save.submitOverwrite') : t('save.submit')}
        </button>
      </div>
    </div>
  )
}
