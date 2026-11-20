/**
 * Two halves of ZCode's run detail that read the Host's static routes:
 *
 * - **Artifacts**: Markdown reports render cleanly without nested-scrollbar line clipping (with a
 *   clean full-height toggle for long reports), preset dashboards (`chart`, `table`, `metrics`,
 *   `board`) render inline without redundant item-count clutter on `metrics`, and clicking an
 *   artifact chip on the chat card scrolls straight to & opens that artifact.
 * - **Script steps** & **Subagent changes**: framed cards with `AgentFace` avatars and inline diffs.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { AgentFace, ArtifactKindIcon } from './AgentFace.tsx'
import type { Translate } from './host-types.ts'
import { isPresetArtifactKind, PresetArtifactLoader } from './ArtifactPresets.tsx'
import { API_ROUTE, apiGet } from './run-view.ts'

export interface ArtifactInfo {
  id: string
  kind: string
  title?: string
  description?: string
  primary: boolean
  version: number
  contentType?: string
  bytes?: number
  spec?: unknown
  itemCount?: number
}

const PREVIEW_MAX_BYTES = 256 * 1024

function artifactUrl(runId: string, artifact: ArtifactInfo, inline: boolean): string {
  return `${API_ROUTE}/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(artifact.id)}/v${artifact.version}${inline ? '?inline=1' : ''}`
}

function previewKind(artifact: ArtifactInfo): 'markdown' | 'text' | 'image' | undefined {
  if (artifact.bytes !== undefined && artifact.bytes > PREVIEW_MAX_BYTES) return undefined
  const type = artifact.contentType ?? (artifact.kind === 'markdown' ? 'text/markdown' : '')
  if (type === 'text/markdown' || artifact.kind === 'markdown') return 'markdown'
  if (/^image\/(png|jpeg|gif|webp)$/u.test(type)) return 'image'
  if (type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml') return 'text'
  return undefined
}

async function fetchArtifact(runId: string, artifact: ArtifactInfo, inline: boolean, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(artifactUrl(runId, artifact, inline), { headers: { 'x-dynamic-workflow-request': '1' }, ...signal === undefined ? {} : { signal } })
  if (!response.ok) throw new Error(String(response.status))
  return await response.blob()
}

async function downloadArtifact(runId: string, artifact: ArtifactInfo): Promise<void> {
  const blob = await fetchArtifact(runId, artifact, false)
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = artifact.kind === 'markdown' && !/\.md$/iu.test(artifact.id) ? `${artifact.id}.md` : artifact.id
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function ArtifactTile({
  runId,
  artifact,
  t,
  initiallyOpen,
  focused,
}: {
  runId: string
  artifact: ArtifactInfo
  t: Translate
  initiallyOpen: boolean
  focused: boolean
}) {
  const presetKind = isPresetArtifactKind(artifact.kind) ? artifact.kind : undefined
  const isPreset = presetKind !== undefined
  const kind = isPreset ? undefined : previewKind(artifact)
  const expandable = isPreset || kind !== undefined
  const [open, setOpen] = useState(isPreset ? true : (initiallyOpen && kind !== undefined))
  const [fullHeight, setFullHeight] = useState(false)
  const [body, setBody] = useState<string | undefined>(undefined)
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focused) return
    if (expandable) setOpen(true)
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [focused, expandable])

  useEffect(() => {
    if (!open || isPreset || kind === undefined || body !== undefined || imageUrl !== undefined) return
    const controller = new AbortController()
    fetchArtifact(runId, artifact, true, controller.signal)
      .then(async (blob) => {
        if (kind === 'image') setImageUrl(URL.createObjectURL(blob))
        else setBody(await blob.text())
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [open, isPreset, kind, runId, artifact, body, imageUrl])

  useEffect(() => () => { if (imageUrl !== undefined) URL.revokeObjectURL(imageUrl) }, [imageUrl])
  const [saving, setSaving] = useState(false)
  const download = (): void => {
    setSaving(true)
    downloadArtifact(runId, artifact).catch(() => setFailed(true)).finally(() => setSaving(false))
  }
  const labels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') } },
    footnotes: t('markdown.footnotes'),
  }), [t])

  const typeBadge = isPreset ? artifact.kind : (artifact.kind === 'markdown' ? 'Markdown' : artifact.contentType ?? artifact.kind)
  // Omit redundant `1 item(s)` on single-snapshot `metrics` presets
  const showItemCount = isPreset && presetKind !== 'metrics' && artifact.itemCount !== undefined && artifact.itemCount > 0
  const metaParts = isPreset
    ? [showItemCount ? t('artifact.items', { count: artifact.itemCount! }) : '', artifact.version > 1 ? `v${artifact.version}` : '']
    : [formatBytes(artifact.bytes), artifact.version > 1 ? `v${artifact.version}` : '']
  const metaText = metaParts.filter(Boolean).join(' · ')
  const longMarkdown = kind === 'markdown' && body !== undefined && (body.split('\n').length > 26 || body.length > 1600)

  return (
    <div
      ref={rootRef}
      className="dwf-artifact"
      data-dwf-artifact={artifact.id}
      data-kind={artifact.kind}
      data-open={open ? '' : undefined}
      data-focused={focused ? '' : undefined}
    >
      <div className="dwf-artifact-head">
        {expandable ? (
          <button type="button" className="dwf-artifact-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
            <span className="dwf-spine-chevron" data-open={open ? '' : undefined} aria-hidden>▸</span>
            <span className="dwf-artifact-head-icon"><ArtifactKindIcon kind={artifact.kind} contentType={artifact.contentType} /></span>
            <span className="dwf-artifact-title">{artifact.title ?? artifact.id}</span>
          </button>
        ) : (
          <span className="dwf-artifact-toggle">
            <span className="dwf-artifact-head-icon"><ArtifactKindIcon kind={artifact.kind} contentType={artifact.contentType} /></span>
            <span className="dwf-artifact-title">{artifact.title ?? artifact.id}</span>
          </span>
        )}
        <span className="dwf-artifact-badge">{typeBadge}</span>
        {artifact.primary ? <span className="dwf-artifact-badge dwf-artifact-badge-primary">{t('artifact.primary')}</span> : null}
        {metaText !== '' ? <span className="dwf-artifact-meta dwf-muted">{metaText}</span> : null}
        <span className="dwf-artifact-actions">
          {open && longMarkdown ? (
            <button type="button" className="dwf-link dwf-artifact-action-link" onClick={() => setFullHeight(v => !v)}>
              {fullHeight ? t('artifact.collapseFull') : t('artifact.expandFull')}
            </button>
          ) : null}
          {isPreset ? null : (
            <button type="button" className="dwf-link dwf-artifact-action-link" disabled={saving} onClick={download} data-dwf-download="">
              {t('artifact.download')}
            </button>
          )}
        </span>
      </div>
      {open && artifact.description !== undefined && artifact.description !== '' ? <p className="dwf-muted dwf-artifact-desc">{artifact.description}</p> : null}
      {open && presetKind !== undefined ? <PresetArtifactLoader runId={runId} artifactId={artifact.id} kind={presetKind} spec={artifact.spec} {...artifact.itemCount === undefined ? {} : { itemCount: artifact.itemCount }} t={t} /> : null}
      {open && kind === 'image' && imageUrl !== undefined ? <img className="dwf-artifact-image" alt={artifact.title ?? artifact.id} src={imageUrl} /> : null}
      {open && kind === 'markdown' && body !== undefined ? (
        <div className={longMarkdown && !fullHeight ? 'dwf-artifact-markdown dwf-artifact-markdown-clamped' : 'dwf-artifact-markdown'}>
          <MarkdownText text={body} labels={labels} variant="compact" />
          {longMarkdown && !fullHeight ? (
            <div className="dwf-artifact-fade">
              <button type="button" className="dwf-action-pill" onClick={() => setFullHeight(true)}>
                {t('artifact.expandFull')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {open && kind === 'text' && body !== undefined ? <pre className="dwf-code dwf-artifact-text">{body}</pre> : null}
      {open && failed ? <p className="dwf-attention">{t('artifact.failed')}</p> : null}
    </div>
  )
}

export function ArtifactList({
  runId,
  artifacts,
  focusArtifactId,
  t,
}: {
  runId: string
  artifacts: readonly ArtifactInfo[]
  focusArtifactId?: string | undefined
  t: Translate
}) {
  if (artifacts.length === 0) return null
  const sorted = [...artifacts].sort((a, b) => Number(b.primary) - Number(a.primary))
  return (
    <section className="dwf-pane-section" data-dwf-artifacts="">
      <h4>{t('pane.artifacts')}</h4>
      {sorted.map((artifact, index) => (
        <ArtifactTile
          key={`${artifact.id}@${artifact.version}`}
          runId={runId}
          artifact={artifact}
          t={t}
          focused={focusArtifactId === artifact.id}
          initiallyOpen={focusArtifactId === artifact.id || artifact.primary || (index === 0 && sorted.length === 1)}
        />
      ))}
    </section>
  )
}

// ————————————————————————————— script steps —————————————————————————————

export interface WorkspaceNode { siteId: string; ordinal: number; kind: string; status: string; input?: { op: string; args: unknown[] }; artifactId?: string }

type StepKind = 'read' | 'search' | 'git' | 'terminal' | 'artifact' | 'step'

function stepKindOf(node: WorkspaceNode): StepKind {
  if (node.kind === 'artifact') return 'artifact'
  const op = node.input?.op
  if (op === undefined) return node.kind === 'world-run' ? 'terminal' : 'step'
  if (op === 'read') return 'read'
  if (op === 'glob' || op === 'grep') return 'search'
  if (op.startsWith('git-')) return 'git'
  if (op === 'run') return 'terminal'
  return 'step'
}

export function formatCommandLine(cmd: string, args: readonly string[]): string {
  const quote = (part: string): string => (/[\s"']/u.test(part) ? JSON.stringify(part) : part)
  return [cmd, ...args].map(quote).join(' ')
}

function stepText(node: WorkspaceNode): string {
  const args = node.input?.args ?? []
  const str = (index: number): string | undefined => (typeof args[index] === 'string' ? args[index] as string : undefined)
  const op = node.input?.op
  if (node.kind === 'artifact') return node.artifactId ?? node.siteId
  if (op === 'run') {
    const list = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : []
    return formatCommandLine(str(0) ?? '?', list)
  }
  if (op === 'grep') return [str(0), str(1)].filter(Boolean).join('  ·  ')
  if (op?.startsWith('git-') === true) return [`git ${op.slice(4)}`, ...args.filter(arg => typeof arg === 'string' || typeof arg === 'number').map(String)].join(' ')
  return str(0) ?? op ?? node.siteId
}

function stepDotOf(status: string): 'done' | 'error' | 'ongoing' | 'idle' {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  if (status === 'running') return 'ongoing'
  return 'idle'
}

const COLLAPSED_ROWS = 8

export function ScriptSteps({ nodes, t }: { nodes: readonly WorkspaceNode[] | undefined; t: Translate }) {
  const [expanded, setExpanded] = useState(false)
  if (nodes === undefined || nodes.length === 0) return null
  const rounds = new Map<string, number>()
  const rows = nodes.map((node) => {
    const round = (rounds.get(node.siteId) ?? 0) + 1
    rounds.set(node.siteId, round)
    return { node, round }
  })
  const visible = expanded ? rows : rows.slice(0, COLLAPSED_ROWS)
  return (
    <section className="dwf-pane-section" data-dwf-steps="">
      <h4>{t('pane.steps', { count: nodes.length })}</h4>
      <div className="dwf-surface-card">
        <ul className="dwf-steps">
          {visible.map(({ node, round }) => {
            const kind = stepKindOf(node)
            const text = stepText(node)
            return (
              <li key={`${node.siteId}@${node.ordinal}`} className="dwf-step-row" data-kind={kind}>
                <StateDot state={stepDotOf(node.status)} size={9} />
                <span className="dwf-step-kind">{t(`step.${kind}`)}</span>
                <code className="dwf-step-text" title={text}>{text}</code>
                {round > 1 ? <span className="dwf-step-round">⟳{round}</span> : null}
              </li>
            )
          })}
        </ul>
        {rows.length > COLLAPSED_ROWS ? (
          <div className="dwf-card-footer-action">
            <button type="button" className="dwf-link" onClick={() => setExpanded(value => !value)}>{expanded ? t('card.less') : t('pane.stepsMore', { count: rows.length - COLLAPSED_ROWS })}</button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

// ————————————————————————————— per-subagent changes —————————————————————————————

export interface SubagentChanges { sessionId: string; actor?: string; files: { path: string; added: number; removed: number; created: boolean; deleted: boolean; tooLarge: boolean; edits: number }[] }

export function useChanges(runId: string, revision: string): SubagentChanges[] | undefined {
  const [changes, setChanges] = useState<SubagentChanges[] | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    apiGet<{ changes: SubagentChanges[] }>(`runs/${encodeURIComponent(runId)}/changes`, controller.signal).then(value => setChanges(value.changes), () => undefined)
    return () => controller.abort()
  }, [runId, revision])
  return changes
}

function DiffView({ runId, sessionId, path, t }: { runId: string; sessionId: string; path: string; t: Translate }) {
  const [diff, setDiff] = useState<{ diff?: string; tooLarge?: true } | null | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    apiGet<{ diff?: string; tooLarge?: true }>(`runs/${encodeURIComponent(runId)}/changes/diff?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`, controller.signal)
      .then(setDiff, () => { if (!controller.signal.aborted) setDiff(null) })
    return () => controller.abort()
  }, [runId, sessionId, path])
  if (diff === undefined) return <p className="dwf-muted">{t('confirm.loading')}</p>
  if (diff === null) return <p className="dwf-attention">{t('changes.failed')}</p>
  if (diff.tooLarge === true) return <p className="dwf-muted">{t('changes.tooLarge')}</p>
  return (
    <pre className="dwf-code dwf-diff" data-dwf-diff="">
      {(diff.diff ?? '').split('\n').map((line, index) => (
        <span key={index} className={line.startsWith('@@') ? 'dwf-diff-hunk' : line.startsWith('+++') || line.startsWith('---') ? 'dwf-diff-file' : line.startsWith('+') ? 'dwf-diff-add' : line.startsWith('-') ? 'dwf-diff-del' : undefined}>{line}{'\n'}</span>
      ))}
    </pre>
  )
}

export function ChangesSection({ runId, changes, t, openChild }: { runId: string; changes: SubagentChanges[] | undefined; t: Translate; openChild: (sessionId: string) => void }) {
  const [open, setOpen] = useState<string | undefined>(undefined)
  if (changes === undefined || changes.length === 0) return null
  const files = changes.reduce((sum, entry) => sum + entry.files.length, 0)
  return (
    <section className="dwf-pane-section" data-dwf-changes="">
      <h4>{t('changes.title', { count: files })}</h4>
      {changes.map((entry, idx) => {
        const actorName = entry.actor ?? entry.sessionId
        return (
          <div key={entry.sessionId} className="dwf-changes-agent dwf-surface-card">
            <div className="dwf-changes-head">
              <button type="button" className="dwf-changes-actor" onClick={() => openChild(entry.sessionId)}>
                <AgentFace avatarIndex={idx} name={actorName} status="done" size={16} idle />
                <span>{actorName}</span>
                <span className="dwf-pill-open-arrow" aria-hidden>↗</span>
              </button>
              <span className="dwf-changes-file-count">{entry.files.length}</span>
            </div>
            <ul className="dwf-change-list">
              {entry.files.map((file) => {
                const key = `${entry.sessionId}\u0000${file.path}`
                const isOpen = open === key
                return (
                  <li key={key} className="dwf-change-file" data-open={isOpen ? '' : undefined}>
                    <button type="button" className="dwf-change-row" aria-expanded={isOpen} onClick={() => setOpen(value => (value === key ? undefined : key))}>
                      <span className="dwf-spine-chevron" data-open={isOpen ? '' : undefined} aria-hidden>▸</span>
                      <code className="dwf-step-text dwf-change-path" title={file.path}>{file.path}</code>
                      {file.created ? <span className="dwf-change-badge dwf-change-badge-new">{t('changes.created')}</span> : null}
                      {file.deleted ? <span className="dwf-change-badge dwf-change-badge-del">{t('changes.deleted')}</span> : null}
                      <span className="dwf-change-stats">
                        {file.tooLarge ? <span className="dwf-muted">{t('changes.large')}</span> : <><span className="dwf-diff-add">+{file.added}</span><span className="dwf-diff-del">−{file.removed}</span></>}
                      </span>
                    </button>
                    {isOpen ? <DiffView runId={runId} sessionId={entry.sessionId} path={file.path} t={t} /> : null}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
      <p className="dwf-footnote">{t('changes.hint')}</p>
    </section>
  )
}
