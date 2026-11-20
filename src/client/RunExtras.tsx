/**
 * Clean, modular ZCode-parity views for Artifacts & Script Logbook:
 *
 *   1. `CompactArtifactsSection`: collapsible `产物  2  ▾` footer on the Run Overview with sleek
 *      clickable index rows (never dumps huge Markdown walls into the Spine overview).
 *   2. `ArtifactReaderView`: dedicated full-pane reader opened when clicking an artifact pill on
 *      the chat card or an artifact row in the Run Overview (`[← 返回运行概览] <标题> [下载]`).
 *   3. `ScriptLogbookView`: dedicated full-pane logbook opened when clicking any `>_ Script` pill
 *      (`world.run` / `files.*` / `git.*` steps + optional `查看脚本` source).
 */

import { useEffect, useMemo, useState } from 'react'
import { MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ArtifactKindIcon, TerminalGlyphIcon } from './AgentFace.tsx'
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

const PREVIEW_MAX_BYTES = 512 * 1024

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

function artifactMetaLabel(artifact: ArtifactInfo, t: Translate): string {
  const isPreset = isPresetArtifactKind(artifact.kind)
  const showItems = isPreset && artifact.kind !== 'metrics' && artifact.itemCount !== undefined && artifact.itemCount > 0
  const parts = isPreset
    ? [artifact.kind, showItems ? t('artifact.items', { count: artifact.itemCount! }) : '', artifact.version > 1 ? `v${artifact.version}` : '']
    : [artifact.kind === 'markdown' ? 'Markdown' : (artifact.contentType ?? artifact.kind), formatBytes(artifact.bytes), artifact.version > 1 ? `v${artifact.version}` : '']
  return parts.filter(Boolean).join(' · ')
}

/** ZCode-style compact collapsible Artifacts footer section on the Run Overview (`产物  2  ▾`). */
export function CompactArtifactsSection({
  artifacts,
  t,
  onOpenArtifact,
}: {
  artifacts: readonly ArtifactInfo[]
  t: Translate
  onOpenArtifact: (artifactId: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  if (artifacts.length === 0) return null
  const sorted = [...artifacts].sort((a, b) => Number(b.primary) - Number(a.primary))
  const primary = sorted[0]
  return (
    <section className="dwf-artifacts-footer" data-dwf-artifacts="">
      <button
        type="button"
        className="dwf-artifacts-sec-head"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
      >
        <span className="dwf-artifacts-sec-title">{t('pane.artifacts')}</span>
        <span className="dwf-artifacts-sec-count">{artifacts.length}</span>
        {!expanded && primary !== undefined ? (
          <span className="dwf-artifacts-sec-sub">· {primary.title ?? primary.id}</span>
        ) : null}
        <span className="dwf-spine-chevron dwf-artifacts-sec-chevron" data-open={expanded ? '' : undefined} aria-hidden>▸</span>
      </button>
      {expanded ? (
        <div className="dwf-artifacts-index">
          {sorted.map(artifact => (
            <button
              key={`${artifact.id}@${artifact.version}`}
              type="button"
              className="dwf-artifact-index-row"
              data-dwf-artifact={artifact.id}
              data-primary={artifact.primary ? '' : undefined}
              onClick={() => onOpenArtifact(artifact.id)}
            >
              <span className="dwf-artifact-pill-icon">
                <ArtifactKindIcon kind={artifact.kind} contentType={artifact.contentType} />
              </span>
              <span className="dwf-artifact-index-title">{artifact.title ?? artifact.id}</span>
              <span className="dwf-artifact-index-meta">{artifactMetaLabel(artifact, t)}</span>
              <span className="dwf-artifact-index-arrow" aria-hidden>↗</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}

/** Dedicated full-pane Artifact Reader view (`[←] <标题> [下载]`). */
export function ArtifactReaderView({
  runId,
  artifact,
  t,
  onBack,
}: {
  runId: string
  artifact: ArtifactInfo
  t: Translate
  onBack: () => void
}) {
  const presetKind = isPresetArtifactKind(artifact.kind) ? artifact.kind : undefined
  const isPreset = presetKind !== undefined
  const kind = isPreset ? undefined : previewKind(artifact)
  const [body, setBody] = useState<string | undefined>(undefined)
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setBody(undefined)
    setImageUrl(undefined)
    setFailed(false)
    if (isPreset || kind === undefined) return undefined
    const controller = new AbortController()
    fetchArtifact(runId, artifact, true, controller.signal)
      .then(async (blob) => {
        if (kind === 'image') setImageUrl(URL.createObjectURL(blob))
        else setBody(await blob.text())
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [runId, artifact, isPreset, kind])

  useEffect(() => () => { if (imageUrl !== undefined) URL.revokeObjectURL(imageUrl) }, [imageUrl])

  const download = (): void => {
    setSaving(true)
    downloadArtifact(runId, artifact).catch(() => setFailed(true)).finally(() => setSaving(false))
  }

  const labels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') } },
    footnotes: t('markdown.footnotes'),
  }), [t])

  return (
    <div className="dwf-pane dwf-subview" data-dwf-artifact-reader={artifact.id}>
      <div className="dwf-pane-head">
        <button type="button" className="dwf-icon-btn" aria-label={t('pane.backToRun')} title={t('pane.backToRun')} onClick={onBack}>←</button>
        <span className="dwf-artifact-pill-icon">
          <ArtifactKindIcon kind={artifact.kind} contentType={artifact.contentType} />
        </span>
        <h3 className="dwf-pane-title" title={artifact.title ?? artifact.id}>{artifact.title ?? artifact.id}</h3>
        <span className="dwf-card-actions">
          <span className="dwf-artifact-meta dwf-muted">{artifactMetaLabel(artifact, t)}</span>
          {!isPreset ? (
            <button type="button" className="dwf-action-pill" disabled={saving} onClick={download} data-dwf-download="">
              {t('artifact.download')}
            </button>
          ) : null}
        </span>
      </div>

      {artifact.description !== undefined && artifact.description !== '' ? (
        <p className="dwf-muted dwf-artifact-desc">{artifact.description}</p>
      ) : null}

      <div className="dwf-reader-body">
        {presetKind !== undefined ? (
          <PresetArtifactLoader runId={runId} artifactId={artifact.id} kind={presetKind} spec={artifact.spec} {...artifact.itemCount === undefined ? {} : { itemCount: artifact.itemCount }} t={t} />
        ) : null}
        {kind === 'image' && imageUrl !== undefined ? (
          <img className="dwf-artifact-image" alt={artifact.title ?? artifact.id} src={imageUrl} />
        ) : null}
        {kind === 'markdown' && body !== undefined ? (
          <div className="dwf-artifact-markdown">
            <MarkdownText text={body} labels={labels} variant="compact" />
          </div>
        ) : null}
        {kind === 'text' && body !== undefined ? (
          <pre className="dwf-code dwf-reader-code">{body}</pre>
        ) : null}
        {!isPreset && kind !== undefined && body === undefined && imageUrl === undefined && !failed ? (
          <p className="dwf-muted">{t('confirm.loading')}</p>
        ) : null}
        {failed ? <p className="dwf-attention">{t('artifact.failed')}</p> : null}
      </div>
    </div>
  )
}

// ————————————————————————————— script logbook sub-view —————————————————————————————

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

/** Dedicated full-pane Script Logbook view opened when clicking a `>_ Script` pill. */
export function ScriptLogbookView({
  runId,
  script,
  t,
  onBack,
}: {
  runId: string
  script?: string | null | undefined
  t: Translate
  onBack: () => void
}) {
  const [nodes, setNodes] = useState<WorkspaceNode[] | undefined>(undefined)
  const [scriptOpen, setScriptOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    apiGet<{ nodes: WorkspaceNode[] }>(`runs/${encodeURIComponent(runId)}/nodes`, controller.signal)
      .then(v => setNodes(v.nodes.filter(n => n.kind !== 'ask')), () => setNodes([]))
    return () => controller.abort()
  }, [runId])

  const rounds = new Map<string, number>()
  const rows = (nodes ?? []).map((node) => {
    const round = (rounds.get(node.siteId) ?? 0) + 1
    rounds.set(node.siteId, round)
    return { node, round }
  })

  return (
    <div className="dwf-pane dwf-subview" data-dwf-script-logbook="">
      <div className="dwf-pane-head">
        <button type="button" className="dwf-icon-btn" aria-label={t('pane.backToRun')} title={t('pane.backToRun')} onClick={onBack}>←</button>
        <TerminalGlyphIcon size={15} />
        <h3 className="dwf-pane-title">{t('pane.scriptLogbook')}</h3>
      </div>

      {nodes === undefined ? (
        <p className="dwf-muted">{t('confirm.loading')}</p>
      ) : rows.length === 0 ? (
        <div className="dwf-empty-card">{t('pane.steps', { count: 0 })}</div>
      ) : (
        <div className="dwf-surface-card">
          <ul className="dwf-steps">
            {rows.map(({ node, round }) => {
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
        </div>
      )}

      {script !== undefined && script !== null ? (
        <section className="dwf-pane-section">
          <button type="button" className="dwf-disclosure-btn" aria-expanded={scriptOpen} onClick={() => setScriptOpen(open => !open)}>
            <span className="dwf-disclosure-icon" aria-hidden>&lt;/&gt;</span>
            <span>{scriptOpen ? t('confirm.hideScript') : t('confirm.showScript')}</span>
            <span className="dwf-spine-chevron dwf-disclosure-chevron" data-open={scriptOpen ? '' : undefined} aria-hidden>▸</span>
          </button>
          {scriptOpen ? <pre className="dwf-code">{script}</pre> : null}
        </section>
      ) : null}
    </div>
  )
}
